// Remote machines: ssh probes the platform, uploads the matching machine
// build when it is missing and reaches the machine's node of that build over
// stdio (`node dial`, which starts the node when none answers). ssh is the
// system's own, with a ControlMaster per instance (controldir.ts).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Duplex, PassThrough, Readable } from 'node:stream';
import { execa } from 'execa';
import { AGENT_DIR, HUB_BIN, NAME } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { UNSET_FOREIGN_RUNTIME_VARS } from '#shared/lib/bunenv.ts';
import { pairDuplex } from '#shared/proto/yamux.ts';
import {
  archiveMember,
  tsVersion,
  type BuildSource,
  type MachineBuild,
  type MachineTarget,
  type TSBuild,
  type TSPayload,
} from './builds.ts';
import { MAX_ARCHIVE, MAX_EXECUTABLE } from './release.ts';
import type { OpenStream } from './tunnel.ts';
import { DeployCode, deployCode } from './errors.ts';
import { CLIENT_ID, Session } from './session.ts';
import type { Deploy } from '../spec.ts';

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
  /** false: the machine does not download its build from the release
   * itself (the setting machines.download); the hub uploads it. */
  machineDownload?: boolean;
  /** The machines whose own download failed lately (shared by a hub's
   * connections): the hub uploads to them at once. */
  downloadFailures?: DownloadFailures;
  /** What the dial is doing (State.deploy). */
  progress?: (d: Deploy) => void;
}

/** The machines (by target) whose own download of a build failed (no curl
 * or wget, no route to the release, a timeout, not the build), for a while:
 * their next deployments go straight to the hub's upload rather than
 * waiting for the download to fail again; after ttlMs, or once one
 * succeeds, they download again. Kept in the hub's memory, not in the
 * machines file. */
export class DownloadFailures {
  private readonly failed = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(ttlMs = 24 * 60 * 60_000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }
  /** Whether target's download failed within ttlMs. */
  recent(target: string): boolean {
    const t = this.failed.get(target);
    if (t === undefined) return false;
    if (this.now() - t < this.ttlMs) return true;
    this.failed.delete(target);
    return false;
  }
  failure(target: string): void {
    this.failed.set(target, this.now());
  }
  success(target: string): void {
    this.failed.delete(target);
  }
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
 * app's hub has none, and Windows would give each ssh one). */
const SSH_OPTIONS = { windowsHide: true, reject: false, stripFinalNewline: false } as const;

/** Runs a script on the target; its standard output. */
export async function run(
  o: SSHOptions,
  script: string,
  opts: { stdin?: Buffer; onSent?: (sent: number) => void; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  const r = await execa('ssh', runArgs(o, script), {
    ...SSH_OPTIONS,
    input: opts.stdin && opts.onSent ? counted(opts.stdin, opts.onSent) : (opts.stdin ?? ''),
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

/** bytes as a stream of chunks, reporting how many ssh has read (the
 * pipe's backpressure paces it): after each chunk is taken, and all of
 * them once the last one was. */
export function counted(bytes: Buffer, onSent: (sent: number) => void, chunk = 64 << 10): Readable {
  return Readable.from(
    (function* () {
      for (let i = 0; i < bytes.length; i += chunk) {
        yield bytes.subarray(i, i + chunk);
        onSent(Math.min(i + chunk, bytes.length));
      }
    })(),
    { objectMode: false },
  );
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

/** How long a machine's own download may take in all, in seconds, and how
 * many bytes of the archive it writes at most. */
export let machineDownloadLimitS = 300;
let machineDownloadCap = MAX_ARCHIVE;
/** Tests: other limits. */
export function setMachineDownloadLimit(s: number, cap = MAX_ARCHIVE): void {
  machineDownloadLimitS = s;
  machineDownloadCap = cap;
}

/** Removes files when the script ends, also when the connection went away
 * (ssh's hangup, a write to a closed pipe; sshd sends no hangup to a
 * session without a terminal, whose script then ends on its own bounds
 * and an end of input or a closed pipe). */
const cleanup = (files: string, extra = '') => `trap 'rm -f ${files}${extra}' EXIT; trap 'exit 1' HUP INT TERM PIPE`;

/** The shell function sum FILE: its SHA-256 by whichever tool the machine
 * has. */
const SUM = `sum() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1" 2>/dev/null || openssl dgst -sha256 -r "$1"; } | cut -d' ' -f1; }`;

/** The lines that run a pipeline in the background ending in "| head …
 * > file" and wait for it, ending it after limitS seconds (the watchdog
 * ends head, after which the pipeline's next write fails). They run with w
 * set (prelude). */
const bounded = (pipeline: string, limitS: number, what: string): string[] => [
  `${pipeline} & p=$!`,
  `( i=0; while [ $i -lt ${limitS} ]; do sleep 1; kill -0 $p 2>/dev/null || exit 0; i=$((i+1)); done; echo "${what} took more than ${limitS} s" >&2; kill $p 2>/dev/null ) & w=$!`,
  `wait $p; kill $w 2>/dev/null; w=`,
];

/** The lines that download url into "$t.in": at most cap bytes (head), with
 * curl, else wget (status 4 with neither), each without its user's
 * configuration (curl -q first, so no .curlrc applies; an empty WGETRC, GNU
 * wget's --no-config where its untranslated help says it has it), one try,
 * few redirects, 10 s to connect; curl keeps to the URL's scheme, redirects
 * included (--proto, --proto-redir); wget may follow a redirect to another
 * scheme, which only the archive's digest then answers for. A watchdog ends
 * it after limitS seconds in all, whatever the tool (wget's -T bounds one
 * read only). */
function fetchInto(url: string, cap: number, limitS: number): string[] {
  const scheme = new URL(url).protocol.replace(/:$/, '');
  if (scheme !== 'https' && scheme !== 'http') throw new Error(`not a download URL: ${url}`);
  return [
    `if command -v curl >/dev/null 2>&1; then set -- curl -q -fsSL --proto =${scheme} --proto-redir =${scheme} --max-filesize ${cap} --max-redirs 5 --connect-timeout 10 --max-time ${limitS}`,
    `elif command -v wget >/dev/null 2>&1; then set -- wget -q -T 10 -O -; if wget --version 2>/dev/null | grep -q 'GNU Wget'; then set -- "$@" -t 1 --max-redirect=5; LC_ALL=C wget --help 2>&1 | grep -q -- --no-config && set -- "$@" --no-config; fi`,
    `else echo "no curl or wget" >&2; exit 4; fi`,
    `: > "$t.rc"`,
    ...bounded(`WGETRC="$t.rc" "$@" ${shQuote(url)} | head -c ${cap + 1} > "$t.in"`, limitS, 'the download'),
    `n=$(wc -c < "$t.in" | tr -d ' '); [ "$n" -le ${cap} ] || { echo "the download is larger than ${cap} bytes" >&2; exit 3; }`,
  ];
}

/** The script's first line: its temporary files in dir, removed when it
 * ends, and sum. */
const prelude = (dir: string) =>
  `umask 077; d="${dir}"; t="$d/.upload.$$"; w=; ${cleanup('"$t" "$t.in" "$t.rc"', '; [ -z "$w" ] || kill $w 2>/dev/null')}; ${SUM}; mkdir -p "$d" || exit 3`;

/** How long unpacking may take. */
const UNPACK_LIMIT_S = 120;

/** The script that installs a TypeScript build as dir/name from the
 * release's archive (archive: its SHA-256 and the executable's path in it)
 * or the executable gzip-compressed, read from standard input (the hub's
 * upload) or downloaded from url by the machine itself (fetchInto). An
 * archive is unpacked only when its SHA-256 is the manifest's, within
 * UNPACK_LIMIT_S; the executable is put in place only when its SHA-256,
 * computed on the machine, is exe (else it is removed and the script fails
 * with status 3; status 4: no tool to download with); the script prints
 * it, which the hub checks again. Its files are removed when it ends (an
 * upload ends with its input); what a killed shell leaves, the nodes'
 * housekeeping removes after an hour. */
export function installScript(o: {
  dir: string;
  name: string;
  exe: string;
  archive?: { digest: string; member: string };
  url?: string;
  limitS?: number;
}): string {
  const lines = [prelude(o.dir)];
  if (o.url) lines.push(...fetchInto(o.url, machineDownloadCap, o.limitS ?? machineDownloadLimitS));
  else
    lines.push(
      `head -c ${MAX_ARCHIVE + 1} > "$t.in"; n=$(wc -c < "$t.in" | tr -d ' '); [ "$n" -le ${MAX_ARCHIVE} ] || { echo "more than ${MAX_ARCHIVE} bytes" >&2; exit 3; }`,
    );
  if (o.archive)
    lines.push(
      `s=$(sum "$t.in"); [ "$s" = "${o.archive.digest}" ] || { echo "the archive's sha256 $s is not the release's ${o.archive.digest}" >&2; exit 3; }`,
      ...bounded(
        `gunzip -c "$t.in" | tar -xf - -O ${shQuote(o.archive.member)} | head -c ${MAX_EXECUTABLE + 1} > "$t"`,
        UNPACK_LIMIT_S,
        'unpacking',
      ),
    );
  else lines.push(...bounded(`gunzip -c "$t.in" | head -c ${MAX_EXECUTABLE + 1} > "$t"`, UNPACK_LIMIT_S, 'unpacking'));
  lines.push(
    `s=$(sum "$t") && echo "@sha256=$s" && [ "$s" = "${o.exe}" ] && chmod 700 "$t" && mv -f "$t" "$d/${o.name}" || { echo "sha256 \${s:-unknown}, expected ${o.exe}" >&2; exit 3; }`,
  );
  return lines.join('\n');
}

/** A stream to host:port through the target (`ssh -W`, over the control
 * master when there is one; a hub without one, on Windows, opens a
 * connection of its own, non-interactively): for the hub's HTTPS through
 * the machine (tunnel.ts). It fails with ssh's words when the machine's
 * sshd forbids forwarding (AllowTcpForwarding no). */
export function sshTunnel(o: Pick<SSHOptions, 'controlDir' | 'target'>): OpenStream {
  return async (host, port) => {
    const p = spawn('ssh', [...sshArgs(o.controlDir, true), '-W', `${host}:${port}`, '--', o.target], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let err = '';
    p.stderr!.setEncoding('utf8').on('data', (c: string) => (err = (err + c).slice(-2000)));
    // The stream ends once ssh did, with ssh's words when it failed (its
    // output may end before its status is known).
    const out = new PassThrough();
    p.stdout!.pipe(out, { end: false });
    // Node's Duplex.from takes a pair of streams (its types name web streams only).
    const d = Duplex.from({ readable: out, writable: p.stdin! } as unknown as Parameters<typeof Duplex.from>[0]);
    p.once('error', (e) => d.destroy(e));
    p.once('close', (code) => {
      if (code) d.destroy(new Error(`ssh -W ${host}:${port}: ${err.trim() || `exit status ${code}`}`));
      else out.end();
    });
    d.once('close', () => p.kill());
    return d;
  };
}

/** Builds used by other hubs are kept until unused for 14 days (running
 * nodes touch their directories). */
const PRUNE = `find "$HOME/${AGENT_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null; true`;

/** What a TypeScript build's install does when the machine lacks it: the
 * digests from the release's manifest, which the hub verified itself
 * (release.ts; through the machine with its own TLS when the release is
 * unreachable from the hub); the machine downloads the release's archive
 * itself when it may (machineDownload) and the build has a release; else,
 * or when that fails, the hub uploads the archive or its own executable
 * (release.ts). A machine whose download failed within the last day gets
 * the upload first, and is asked to download again only when the hub has
 * nothing to upload. Each is checked on the machine before it is put in
 * place (installScript). */
async function installTS(o: SSHOptions, b: TSBuild, platform: Platform, signal?: AbortSignal): Promise<string> {
  const allowed = o.machineDownload !== false;
  const d = await b.digests({ ...(signal ? { signal } : {}), ...(allowed ? { tunnel: sshTunnel(o) } : {}) });
  const version = tsVersion(d.exe);
  const dir = `$HOME/${AGENT_DIR}/${version}`;
  const there = await run(o, `[ -x "${dir}/${HUB_BIN}" ] && echo @build; true`, { timeoutMs: 30_000, signal });
  if (/^@build$/m.test(there)) return `${dir}/${HUB_BIN}`;
  const confirmed = (out: string) => out.split('\n').includes(`@sha256=${d.exe}`);
  const archive = d.archive ? { digest: d.archive, member: archiveMember(b.key) } : undefined;
  const canDownload = !!(b.url && archive && allowed);
  /** The machine's own download; whether it put the build in place. */
  const download = async (): Promise<boolean> => {
    o.progress?.({ step: 'download' });
    o.logger(`ssh ${o.target}: the machine downloads its build ${version} (${platform.os}/${platform.arch}) from ${b.url}`);
    let out: string;
    try {
      out = await run(o, `${installScript({ dir, name: HUB_BIN, exe: d.exe, archive: archive!, url: b.url! })}\n${PRUNE}`, {
        timeoutMs: (machineDownloadLimitS + UNPACK_LIMIT_S + 60) * 1000,
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      // Only the download's own failures (the script's status 3 and 4) are
      // remembered, not the connection's.
      if (/exit status [34]\b/.test((e as Error).message)) o.downloadFailures?.failure(o.target);
      o.logger(`ssh ${o.target}: the machine could not download its build (${(e as Error).message.trim()})`);
      return false;
    }
    // The hub checks what the machine computed, too.
    if (confirmed(out)) {
      o.downloadFailures?.success(o.target);
      return true;
    }
    o.downloadFailures?.failure(o.target);
    o.logger(`ssh ${o.target}: the machine did not confirm its build's sha256`);
    return false;
  };
  const remembered = canDownload && !!o.downloadFailures?.recent(o.target);
  if (canDownload && !remembered && (await download())) return `${dir}/${HUB_BIN}`;
  if (remembered) o.logger(`ssh ${o.target}: the machine's own download failed within the last day; the hub uploads its build`);
  let p: TSPayload;
  try {
    p = await b.load(d, signal);
  } catch (e) {
    // Nothing to upload: the machine is asked again after all.
    if (remembered && deployCode(e) === DeployCode.BuildUnavailable && (await download())) return `${dir}/${HUB_BIN}`;
    throw e;
  }
  o.logger(
    `ssh ${o.target}: uploading the machine build ${version} (${platform.os}/${platform.arch}, ${p.kind === 'archive' ? 'the release archive' : 'the executable'}, ${p.bytes.length} bytes)`,
  );
  const total = p.bytes.length;
  o.progress?.({ step: 'upload', sent: 0, total });
  let out: string;
  try {
    out = await run(
      o,
      `${installScript({ dir, name: HUB_BIN, exe: d.exe, ...(p.kind === 'archive' && archive ? { archive } : {}) })}\n${PRUNE}`,
      {
        stdin: p.bytes,
        // Once ssh took all of it, the machine checks and unpacks it.
        onSent: (sent) => o.progress?.(sent < total ? { step: 'upload', sent, total } : { step: 'install' }),
        timeoutMs: 10 * 60_000,
        signal,
      },
    );
  } catch (e) {
    throw new Error(`upload the machine build ${version}: ${(e as Error).message}`);
  }
  if (!confirmed(out)) throw new Error(`upload the machine build ${version}: the machine did not confirm its sha256`);
  return `${dir}/${HUB_BIN}`;
}

/** Probes the remote platform, uploads the matching machine build if
 * missing and reaches the machine's node of that build over ssh stdio. */
export async function dialSSH(o: SSHOptions, signal?: AbortSignal): Promise<{ session: Session; platform: Platform }> {
  o.progress?.({ step: 'probe' });
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
    checkRuntimeRuns(probe);
  } catch (e) {
    // The failure's code stays with it (State.failure).
    const code = deployCode(e);
    throw Object.assign(new Error(`no agent for ${platform.os}/${platform.arch}: ${(e as Error).message}`), {
      platform,
      ...(code ? { code } : {}),
    });
  }
  const remotePath = await installTS(o, build, platform, signal);
  o.progress?.({ step: 'start' });

  const p = execa(
    'ssh',
    runArgs(o, `${UNSET_FOREIGN_RUNTIME_VARS}; exec "${remotePath}" node dial --instance '${o.instance}' --client ${CLIENT_ID}`),
    {
      ...SSH_OPTIONS,
      buffer: false,
      encoding: 'buffer',
      // Closing asks ssh to end (SIGINT); a stuck one is killed 3 s later.
      killSignal: 'SIGINT',
      forceKillAfterDelay: 3000,
    },
  );
  const stderr = new LineLogger(o.logger, `ssh ${o.target}: `);
  p.stderr.setEncoding('utf8').on('data', (c: string) => stderr.write(c));
  const exited = p.then((r) => r.exitCode ?? null);
  // Wait for the pipe's write callback before releasing borrowed frame bytes.
  const conn = pairDuplex(p.stdout, p.stdin);
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
