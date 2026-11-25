// Remote machines: ssh probes the platform, uploads the matching machine
// build when it is missing and reaches the machine's node of that build over
// stdio (`node dial`, which starts the node when none answers). ssh is the
// system's own, with a ControlMaster per instance (controldir.ts).
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execa } from 'execa';
import { AGENT_DIR, CORE_BIN, NAME, RUNTIME_DIR } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { BUNDLE_FILE, launcher, runtimeDirName, type BuildSource, type MachineBuild, type MachineTarget, type TSBuild } from './builds.ts';
import { CLIENT_ID, Session } from './session.ts';

/** ssh could not authenticate without the user. */
export class AuthRequiredError extends Error {
  constructor(detail: string) {
    super(`ssh authentication required: ${detail}`);
  }
}

export interface SSHOptions {
  target: string;
  controlDir: string;
  builds: BuildSource;
  logger: Logger;
  /** Selects the agent's state directory (brand.dataDir). */
  instance: string;
}

/** The remote OS/arch reported by uname, and $HOME. */
export interface Platform {
  os: string;
  arch: string;
  home: string;
}

/** What the probe found on a machine besides its platform: Linux's C
 * library, whether musl's has the C++ runtime the Bun runtime needs, and
 * whether an x86-64 processor has SSE4.2, which the Bun runtime needs. */
export interface Probe extends Platform {
  libc?: 'glibc' | 'musl';
  libs?: boolean;
  sse42?: boolean;
}

/** The probe: tagged lines (a login shell may print before them). */
export const PROBE_SCRIPT = [
  'echo "@os=$(uname -s)"; echo "@arch=$(uname -m)"; echo "@home=$HOME"',
  'if [ "$(uname -s)" = Linux ]; then',
  '  echo "@gnulibc=$(getconf GNU_LIBC_VERSION 2>/dev/null)"; echo "@ldd=$(ldd --version 2>&1 | head -n 1)"',
  '  if ls /lib/ld-musl-* >/dev/null 2>&1; then echo @muslloader=yes; else echo @muslloader=no; fi',
  '  libs=yes; for f in libstdc++.so.6 libgcc_s.so.1; do found=; for d in /lib /usr/lib /lib64 /usr/lib64 /usr/local/lib; do [ -e "$d/$f" ] && found=1; done; [ -n "$found" ] || libs=no; done; echo "@libs=$libs"',
  '  if grep -qw sse4_2 /proc/cpuinfo 2>/dev/null; then echo @sse42=yes; else echo @sse42=no; fi',
  'fi',
].join('\n');

/** Linux's C library from the probe's facts: glibc's getconf
 * GNU_LIBC_VERSION and ldd --version say glibc whatever else is there (a
 * glibc system with musl's package has musl's loader in /lib too); musl's
 * ldd says musl; musl's loader alone, musl. */
export function libcOf(gnulibc: string, ldd: string, muslLoader: boolean): 'glibc' | 'musl' {
  if (/glibc/i.test(gnulibc) || /gnu libc|glibc/i.test(ldd)) return 'glibc';
  if (/musl/i.test(ldd) || muslLoader) return 'musl';
  return 'glibc';
}

/** The probe's answer. */
export function parseProbe(out: string): Probe {
  const v = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^@([a-z0-9]+)=(.*)$/.exec(line.trim());
    if (m) v.set(m[1], m[2].trim());
  }
  if (!v.has('os') || !v.has('arch') || !v.has('home')) throw new Error(`unexpected probe output ${JSON.stringify(out)}`);
  const p: Probe = { os: v.get('os')!.toLowerCase(), arch: normArch(v.get('arch')!), home: v.get('home')! };
  if (v.has('gnulibc') || v.has('ldd') || v.has('muslloader'))
    p.libc = libcOf(v.get('gnulibc') ?? '', v.get('ldd') ?? '', v.get('muslloader') === 'yes');
  if (v.has('libs')) p.libs = v.get('libs') === 'yes';
  if (v.has('sse42')) p.sse42 = v.get('sse42') === 'yes';
  return p;
}

/** A machine this build cannot run on, and why (the code is the
 * message's start). */
export class Unsupported extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** Refuses a machine the TypeScript build's runtime does not run on. */
export function checkRuntimeRuns(p: Probe): void {
  if (p.os !== 'linux') return;
  if (p.arch === 'amd64' && p.sse42 === false)
    throw new Unsupported('cpu_unsupported', 'the processor lacks SSE4.2, which the Bun runtime of the machine build needs');
  if (p.libc === 'musl' && p.libs === false)
    throw new Unsupported('libs_missing', "musl's machine build needs libstdc++ and libgcc (Alpine: apk add libstdc++ libgcc)");
}

/** The options of every ssh invocation for a target. The ControlMaster lets
 * an interactive authentication (authCommand) be reused by the BatchMode
 * connections that follow; without a controlDir (Windows) every connection
 * authenticates on its own. */
export function sshArgs(controlDir: string, batch: boolean): string[] {
  const args: string[] = [];
  if (controlDir) args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${join(controlDir, '%C')}`, '-o', 'ControlPersist=600');
  args.push('-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-o', 'ConnectTimeout=10');
  if (batch) args.push('-o', 'BatchMode=yes', '-o', 'NumberOfPasswordPrompts=0');
  else args.push('-o', 'BatchMode=no');
  return args;
}

/** Run in an interactive terminal to authenticate a target. */
export function authCommand(controlDir: string, target: string): string[] {
  return ['ssh', ...sshArgs(controlDir, false), '-t', '--', target, `echo ${NAME}: authenticated; sleep 1`];
}

/** ssh's arguments: options, then "--", so that ssh reads no option after
 * it, then the target and the remote command. ssh would otherwise also
 * parse options given after the target. */
function sshCommand(opts: string[], target: string, ...command: string[]): string[] {
  return [...opts, '--', target, ...command];
}

export const shQuote = (s: string): string => `'${s.replaceAll("'", `'"'"'`)}'`;

/** Wraps a POSIX script so it runs under /bin/sh whatever the login shell is. */
export const remoteSh = (script: string): string => `exec /bin/sh -c ${shQuote(script)}`;

/** ssh's arguments for running a script on the target. */
export const runArgs = (o: Pick<SSHOptions, 'controlDir' | 'target'>, script: string): string[] =>
  sshCommand(['-T', ...sshArgs(o.controlDir, true)], o.target, remoteSh(script));

/** ssh's arguments for stopping the target's control master. */
export const stopArgs = (o: Pick<SSHOptions, 'controlDir' | 'target'>): string[] =>
  sshCommand(['-o', `ControlPath=${join(o.controlDir, '%C')}`, '-O', 'stop'], o.target);

const lastLines = (s: string, n: number) => s.trim().split('\n').slice(-n).join('\n');

export function classifySSHError(stderr: string, err?: Error): Error {
  const s = stderr.toLowerCase();
  for (const m of [
    'permission denied',
    'host key verification failed',
    'authenticity of host',
    'remote host identification has changed',
    'too many authentication failures',
    'keyboard-interactive',
    'password:',
    'passphrase',
  ])
    if (s.includes(m)) return new AuthRequiredError(lastLines(stderr, 3).trim());
  const msg = lastLines(stderr, 3).trim();
  return new Error(msg === '' && err ? err.message : msg);
}

export function normArch(m: string): string {
  switch (m.trim()) {
    case 'x86_64':
    case 'amd64':
      return 'amd64';
    case 'aarch64':
    case 'arm64':
    case 'armv8l':
      return 'arm64';
  }
  return m.trim();
}

/** ssh, without a console window of its own on Windows (the desktop
 * app's core has none, and Windows would give each ssh one). */
const SSH_OPTIONS = { windowsHide: true, reject: false, stripFinalNewline: false } as const;

/** Runs a script on the target; its standard output. */
export async function run(
  o: SSHOptions,
  script: string,
  opts: { stdin?: Buffer; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  const r = await execa('ssh', runArgs(o, script), {
    ...SSH_OPTIONS,
    input: opts.stdin ?? '',
    timeout: opts.timeoutMs,
    cancelSignal: opts.signal,
  });
  if (r.isCanceled) throw opts.signal?.reason ?? new Error('ssh: cancelled');
  if (r.timedOut) throw Object.assign(new Error('ssh: timed out'), { timedOut: true });
  if (r.exitCode === 0) return r.stdout;
  if (r.exitCode === 255) return Promise.reject(classifySSHError(r.stderr, new Error(`exit status ${r.exitCode}`)));
  if (r.exitCode === undefined) throw new Error(`ssh: ${r.shortMessage}`);
  throw new Error(`remote command failed: exit status ${r.exitCode}: ${r.stderr.trim()}`);
}

/** Tells the target's control master to take no new sessions (`ssh -O
 * stop`): it removes its socket, so the next connection starts a new master
 * instead of hanging on one whose connection died silently (the network
 * changed, the computer slept) until its ServerAlive checks give up.
 * Sessions already open through it keep running. */
export async function stopMaster(o: SSHOptions): Promise<void> {
  if (!o.controlDir) return;
  const r = await execa('ssh', stopArgs(o), { ...SSH_OPTIONS, all: true, timeout: 5000 });
  if (r.exitCode !== 0)
    o.logger(
      `ssh ${o.target}: stopping the control master: ${r.exitCode === undefined ? r.shortMessage : `exit status ${r.exitCode}`}: ${(r.all ?? '').trim()}`,
    );
}

/** How long ssh may take to exit after the session it carried ended on its
 * own before its control master is considered stuck. */
export let lostGraceMs = 2000;

/** The hook for a session that ended on its own. When the agent or the
 * connection ended, ssh exits too (exited resolves); when it keeps running
 * for grace, yamux's keepalive got no answer through it, so the control
 * master's connection is likely dead and stop runs. */
export function stopMasterIfStuck(exited: Promise<void>, graceMs: number, stop: () => void): () => Promise<void> {
  return async () => {
    const stuck = await Promise.race([exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), graceMs))]);
    if (stuck) stop();
  };
}

/** Forwards ssh's and the agent's standard error to the log and keeps its tail. */
class LineLogger {
  private buf = '';
  private last: string[] = [];
  private readonly logger: Logger;
  private readonly prefix: string;

  constructor(logger: Logger, prefix: string) {
    this.logger = logger;
    this.prefix = prefix;
  }
  write(chunk: string): void {
    this.buf += chunk;
    for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, i).replace(/\r+$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line === '') continue;
      this.logger(this.prefix + line);
      this.last.push(line);
      if (this.last.length > 20) this.last = this.last.slice(-20);
    }
  }
  tail(): string {
    return [...this.last, this.buf].join('\n');
  }
}

/** The script that writes a file of a build from standard input
 * (gzip-compressed) into dir under name, after the machine computed its
 * SHA-256 and found the one expected; it prints what it computed. */
function uploadScript(dir: string, name: string, digest: string): string {
  const sum = `s=$({ sha256sum "$t" 2>/dev/null || shasum -a 256 "$t" 2>/dev/null || openssl dgst -sha256 -r "$t"; } | cut -d' ' -f1)`;
  return (
    `umask 077; d="${dir}"; t="$d/.upload.$$"; mkdir -p "$d" && gunzip -c > "$t" && ${sum} && echo "@sha256=$s" && ` +
    `[ "$s" = "${digest}" ] && chmod 700 "$t" && mv -f "$t" "$d/${name}" || { echo "sha256 \${s:-unknown}, expected ${digest}" >&2; rm -f "$t"; exit 3; }`
  );
}

/** Builds and runtimes used by other cores are kept until unused for 14
 * days (running nodes touch their directories). */
const PRUNE = `find "$HOME/${AGENT_DIR}" "$HOME/${RUNTIME_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null; true`;

/** Uploads what of a TypeScript build the machine lacks: the runtime once
 * per digest, the bundle and its launcher once per build; each checked by
 * its SHA-256 on the machine before it is put in place. */
async function installTS(o: SSHOptions, b: TSBuild, platform: Platform, signal?: AbortSignal): Promise<string> {
  const rt = `$HOME/${RUNTIME_DIR}/${runtimeDirName(b.runtime.digest)}`;
  const dir = `$HOME/${AGENT_DIR}/${b.version}`;
  const there = await run(o, `[ -x "${rt}/bun" ] && echo @runtime; [ -x "${dir}/${CORE_BIN}" ] && echo @build; true`, {
    timeoutMs: 30_000,
    signal,
  });
  const upload = async (what: string, script: string, gz: Buffer, digest: string) => {
    o.logger(`ssh ${o.target}: uploading ${what} (${platform.os}/${platform.arch}, ${gz.length} bytes)`);
    let out: string;
    try {
      out = await run(o, script, { stdin: gz, timeoutMs: 10 * 60_000, signal });
    } catch (e) {
      throw new Error(`upload ${what}: ${(e as Error).message}`);
    }
    // The core checks what the machine computed, too.
    if (!out.split('\n').includes(`@sha256=${digest}`)) throw new Error(`upload ${what}: the machine did not confirm its sha256`);
  };
  if (!/^@runtime$/m.test(there))
    await upload(
      `the Bun runtime ${runtimeDirName(b.runtime.digest)}`,
      uploadScript(rt, 'bun', b.runtime.digest),
      b.runtime.gz,
      b.runtime.digest,
    );
  if (!/^@build$/m.test(there)) {
    const script =
      uploadScript(dir, BUNDLE_FILE, b.bundleDigest) +
      ` && printf '%s' ${shQuote(launcher(b))} > "$d/.launcher.$$" && chmod 700 "$d/.launcher.$$" && mv -f "$d/.launcher.$$" "$d/${CORE_BIN}"; ${PRUNE}`;
    await upload(`the machine build ${b.version}`, script, gzipSync(b.bundle), b.bundleDigest);
  }
  return `${dir}/${CORE_BIN}`;
}

/** Uploads a Go build when the machine lacks it. */
async function installGo(
  o: SSHOptions,
  b: Extract<MachineBuild, { kind: 'go' }>,
  platform: Platform,
  signal?: AbortSignal,
): Promise<string> {
  const dir = `$HOME/${AGENT_DIR}/${b.version}`;
  const remotePath = `${dir}/${CORE_BIN}`;
  const out = await run(o, `if [ -x "${remotePath}" ]; then echo present; else echo absent; fi`, { timeoutMs: 30_000, signal });
  if (out.trim() !== 'present') {
    o.logger(`ssh ${o.target}: uploading agent ${b.version} (${platform.os}/${platform.arch}, ${b.bin.length} bytes)`);
    const script =
      `umask 077; mkdir -p "${dir}" && cat > "${dir}/.upload.$$" && chmod 700 "${dir}/.upload.$$" && mv -f "${dir}/.upload.$$" "${remotePath}"` +
      `; ${PRUNE}`;
    try {
      await run(o, script, { stdin: b.bin, timeoutMs: 5 * 60_000, signal });
    } catch (e) {
      throw new Error(`upload agent: ${(e as Error).message}`);
    }
  }
  return remotePath;
}

/** Probes the remote platform, uploads the matching machine build if
 * missing and reaches the machine's node of that build over ssh stdio. */
export async function dialSSH(o: SSHOptions, signal?: AbortSignal): Promise<{ session: Session; platform: Platform }> {
  let out: string;
  try {
    out = await run(o, PROBE_SCRIPT, { timeoutMs: 30_000, signal });
  } catch (e) {
    // The control master may hold a connection that died without a word;
    // the next attempt should not wait for it again.
    if ((e as { timedOut?: boolean }).timedOut && !signal?.aborted) await stopMaster(o);
    throw e;
  }
  const probe = parseProbe(out);
  const platform: Platform = { os: probe.os, arch: probe.arch, home: probe.home };
  const target: MachineTarget = { os: probe.os, arch: probe.arch, ...(probe.libc ? { libc: probe.libc } : {}) };
  let build: MachineBuild;
  try {
    build = await o.builds(target, signal);
    if (build.kind === 'ts') checkRuntimeRuns(probe);
  } catch (e) {
    throw Object.assign(new Error(`no agent for ${platform.os}/${platform.arch}: ${(e as Error).message}`), { platform });
  }
  const remotePath = build.kind === 'go' ? await installGo(o, build, platform, signal) : await installTS(o, build, platform, signal);

  const p = execa('ssh', runArgs(o, `exec "${remotePath}" node dial --instance '${o.instance}' --client ${CLIENT_ID}`), {
    ...SSH_OPTIONS,
    buffer: false,
    encoding: 'buffer',
    // Closing asks ssh to end (SIGINT); a stuck one is killed 3 s later.
    killSignal: 'SIGINT',
    forceKillAfterDelay: 3000,
  });
  const stderr = new LineLogger(o.logger, `ssh ${o.target}: `);
  p.stderr.setEncoding('utf8').on('data', (c: string) => stderr.write(c));
  const exited = p.then((r) => r.exitCode ?? null);
  const conn = p.duplex();
  const closer = () => {
    p.stdin.end();
    p.kill();
  };
  const lost = stopMasterIfStuck(
    exited.then(() => {}),
    lostGraceMs,
    () => {
      o.logger(`ssh ${o.target}: no answer from the agent; the control master takes no new sessions`);
      void stopMaster(o);
    },
  );
  const session = new Session(conn, closer, lost);
  void exited.then((code) => session.finish(classifySSHError(stderr.tail(), new Error(`exit status ${code}`))));
  return { session, platform };
}
