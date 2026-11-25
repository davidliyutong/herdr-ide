// The home directory of one isolated instance of the core, whichever host
// runs it (the command line's core: instance.ts; the desktop app:
// desktop.ts): a short path below /tmp (macOS limits unix socket paths to
// 104 bytes) with our marker, an instance name of its own and so its own
// terminal core session, the instance's settings, shell startup files that
// put the fake coding agents first, and an environment built from scratch,
// so nothing of the user's (their instances, terminal cores, settings,
// agents and shell startup files) is read or touched.
//
// The local machine's node and terminal core outlive the core: remove()
// stops them as the instance's own (its name and home), waits until no
// process with the home as its HOME is left (everything the instance
// started has it: the environment is the home's), then removes the
// directory; a process still there after LINGER fails the test, as
// something the instance started that does not end with it (rule 6 of
// AGENTS.md). The next run's global setup removes the homes of a runner
// that was killed (sweepLeftovers).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths';

/** The marker that makes a directory below /tmp one of ours, and its owner. */
export const MARKER = 'e2e-instance.json';
export const HOME_PREFIX = '/tmp/hie-';
/** Removes a directory whose last writers may still be ending (the
 * processes of a node just stopped, such as code-server's). */
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;
/** How long the processes of a stopped instance may take to end. */
const LINGER = 15_000;
/** A proxy nothing listens on (the discard port). */
const DEAD_PROXY = 'http://127.0.0.1:9';
/** Settings every instance starts with: nothing of the user's outside the
 * home directory is read (Claude's credentials in the macOS keychain). */
export const BASE_SETTINGS: Readonly<Record<string, unknown>> = { 'usage.claudeKeychain': false };

export class TestHome {
  /** The instance's name (e2e-<random>). */
  readonly name = 'e2e-' + randomBytes(4).toString('hex');
  /** The real path: the terminal core reports directories resolved
   * (/private/tmp on macOS). */
  readonly dir = realpathSync(mkdtempSync(HOME_PREFIX));
  /** A directory for the test's files (the workspace the tests open). */
  readonly work = join(this.dir, 'work');
  /** First in the core's PATH: the ssh of SSH machines (harness/sshd.ts). */
  readonly bin = join(this.dir, 'bin');
  /** The settings the instance started with. */
  readonly settings: Readonly<Record<string, unknown>>;
  private removing?: Promise<void>;

  /** A new home with the instance's settings: BASE_SETTINGS and these. */
  constructor(settings: Record<string, unknown> = {}) {
    this.settings = { ...BASE_SETTINGS, ...settings };
    writeFileSync(join(this.dir, MARKER), JSON.stringify({ name: this.name, pid: process.pid }));
    for (const d of [this.work, this.bin, join(this.dir, 'tmp')]) mkdirSync(d, { recursive: true });
    // Login and interactive shells: the chat host reads the login shell's
    // PATH ($SHELL -l -i -c env), which puts the fake agent first.
    const rc = [`export PATH="${paths.fakeBin}:$PATH"`, `PS1='$ '`, ''].join('\n');
    writeFileSync(join(this.dir, '.bash_profile'), rc);
    writeFileSync(join(this.dir, '.bashrc'), rc);
    const config = process.platform === 'darwin' ? join(this.dir, 'Library', 'Application Support') : join(this.dir, '.config');
    mkdirSync(join(config, paths.slug), { recursive: true });
    writeFileSync(join(config, paths.slug, `settings-${this.name}.json`), JSON.stringify(this.settings, null, 2));
  }

  /** The environment of the instance's processes: nothing inherited but
   * the user's name, offline, and these. */
  env(extra: Record<string, string | undefined> = {}): Record<string, string> {
    const user = process.env.USER || process.env.LOGNAME || 'e2e';
    const env: Record<string, string | undefined> = {
      HOME: this.dir,
      USER: user,
      LOGNAME: user,
      SHELL: '/bin/bash',
      PATH: `${this.bin}:${paths.fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      TMPDIR: join(this.dir, 'tmp'),
      BASH_SILENCE_DEPRECATION_WARNING: '1',
      // Offline: HTTP clients that honor the proxy variables (the usage
      // feature's polls, downloads) fail at once instead of going out.
      HTTP_PROXY: DEAD_PROXY,
      HTTPS_PROXY: DEAD_PROXY,
      http_proxy: DEAD_PROXY,
      https_proxy: DEAD_PROXY,
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
      ...extra,
    };
    return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
  }

  /** Stops the instance's nodes and terminal core, waits for the rest of
   * its processes to end and removes the home and the instance's ssh
   * control directory; once. Throws when processes of the instance
   * outlive it (they are killed, then). */
  remove(): Promise<void> {
    this.removing ??= this.removeOnce();
    return this.removing;
  }

  private async removeOnce(): Promise<void> {
    stopNodes(this.dir, this.name);
    stopTerminalCore(this.dir, this.name);
    // A process started while the instance stopped (code-server's
    // extension host starts some) ends a moment later.
    const deadline = Date.now() + LINGER;
    let left = processesOf(this.dir);
    while (left.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      left = processesOf(this.dir);
    }
    for (const p of left) {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        // gone meanwhile
      }
    }
    rmSync(this.dir, RM);
    rmSync(controlDir(this.name), RM);
    if (left.length)
      throw new Error(
        `processes of instance ${this.name} outlived it by ${LINGER / 1000} s:\n${left.map((p) => `${p.pid} ${p.command}`).join('\n')}`,
      );
  }
}

/** The processes whose environment has HOME=home: an instance's, which
 * all run in its home's environment (TestHome.env), whoever their parent.
 * The commands are cut short. */
export function processesOf(home: string): Array<{ pid: number; command: string }> {
  const out: Array<{ pid: number; command: string }> = [];
  if (process.platform === 'linux') {
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
      try {
        if (!readFileSync(`/proc/${d}/environ`, 'latin1').split('\0').includes(`HOME=${home}`)) continue;
        out.push({ pid: Number(d), command: readFileSync(`/proc/${d}/cmdline`, 'latin1').replaceAll('\0', ' ').slice(0, 200) });
      } catch {
        // gone, or another user's
      }
    }
    return out;
  }
  // macOS: ps appends the environment of the user's own programs to their
  // command (-E); not of the system's (/bin, /usr/bin: a shell, ssh),
  // whose environment it may not read, so those are not seen here.
  const ps = (args: string[]) =>
    spawnSync('ps', [...args, '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 })
      .stdout.split('\n')
      .map((l) => /^\s*(\d+) (.*)$/.exec(l))
      .filter((m) => !!m && Number(m[1]) !== process.pid) as RegExpExecArray[];
  const mark = ` HOME=${home}`;
  const pids = new Set(
    ps(['-axwwE'])
      .filter((m) => {
        const i = m[2].indexOf(mark);
        return i >= 0 && (m[2][i + mark.length] ?? ' ') === ' ';
      })
      .map((m) => Number(m[1])),
  );
  if (!pids.size) return out;
  for (const m of ps(['-axww'])) if (pids.has(Number(m[1]))) out.push({ pid: Number(m[1]), command: m[2].slice(0, 200) });
  return out;
}

/** Stops the nodes of an instance of ours, with its own name and home. */
export function stopNodes(home: string, name: string) {
  if (!existsSync(paths.core)) return;
  spawnSync(paths.core, ['node', 'stop', '--instance', name], {
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    timeout: 15_000,
    stdio: 'ignore',
  });
}

/** Stops the terminal core of an instance of ours, if it still runs: with
 * the instance's own name and home (the core's command finds its
 * executable, session and socket), nothing else. */
export function stopTerminalCore(home: string, name: string) {
  if (!existsSync(paths.core)) return;
  spawnSync(paths.core, ['node', 'stop', '--instance', name, '--terminal-core'], {
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    timeout: 30_000,
    stdio: 'ignore',
  });
}

/** Removes what earlier runs that were killed left: directories with our
 * marker whose runner is gone, their terminal cores stopped first. */
export function sweepLeftovers() {
  for (const d of readdirSync('/tmp')) {
    const home = join('/tmp', d);
    if (!home.startsWith(HOME_PREFIX)) continue;
    let owner: { name: string; pid: number };
    try {
      owner = JSON.parse(readFileSync(join(home, MARKER), 'utf8'));
    } catch {
      continue;
    }
    if (alive(owner.pid)) continue;
    stopNodes(home, owner.name);
    stopTerminalCore(home, owner.name);
    rmSync(home, RM);
    rmSync(controlDir(owner.name), RM);
  }
}

/** The instance's ssh control directory (the core's controlDir; e2e
 * instance names are short enough to be used as they are). */
export function controlDir(name: string): string {
  return join('/tmp', `${paths.slug}-${process.getuid?.() ?? 0}`, `s-${name}`);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
