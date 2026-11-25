// The agents' environment. Their programs live in directories that only
// the user's shell startup files add to PATH (a version manager's,
// ~/.local/bin, a package manager's), and the host is started without
// those files being read. So the host asks an interactive login shell for
// its environment, and gives that to the agents. The shell runs the user's
// startup files, which may start programs of their own: it is asked again
// only when one of the startup files changed (startupFiles), or ENV_KEEP
// after it was asked last.
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { ENV_PREFIX } from '#shared/lib/brand.ts';
import { AGENT_SESSION_VARS } from '#machine/env.ts';
import type { Logger } from '#shared/lib/log.ts';
import type { AgentProcesses } from '../agentproc.ts';

/** The times and bounds of the login shell. */
export const ENV_TIMING = {
  /** How long the shell has to print its environment. */
  shellMs: 10_000,
  /** The most the shell may print. */
  shellOutput: 1 << 20,
  /** How long an environment is used before the shell is asked again,
   * unless a startup file changes. */
  keepMs: 6 * 3600_000,
  /** How long the host's own environment stands in for one the shell did
   * not tell. */
  failKeepMs: 5 * 60_000,
  /** How long the shell's output is waited for once the shell exited: a
   * program its startup files left running may hold the pipe open. */
  pipesMs: 500,
};

/** An environment as programs get it. */
export type Env = Record<string, string>;

/** The startup files of the system's shells (bash, zsh, sh, fish) and the
 * files macOS's path_helper reads. */
const SYSTEM_STARTUP = [
  '/etc/profile',
  '/etc/profile.d',
  '/etc/environment',
  '/etc/paths',
  '/etc/paths.d',
  '/etc/bashrc',
  '/etc/bash.bashrc',
  '/etc/zshenv',
  '/etc/zprofile',
  '/etc/zshrc',
  '/etc/zlogin',
  '/etc/zsh/zshenv',
  '/etc/zsh/zprofile',
  '/etc/zsh/zshrc',
  '/etc/zsh/zlogin',
  '/etc/fish/config.fish',
];

/** The startup files of the shells in the user's home (and zsh's in
 * ZDOTDIR). */
const HOME_STARTUP = [
  '.profile',
  '.bash_profile',
  '.bash_login',
  '.bashrc',
  '.zshenv',
  '.zprofile',
  '.zshrc',
  '.zlogin',
  '.config/fish/config.fish',
  '.config/fish/conf.d',
];

/** The files whose change has the login shell asked again: the system's,
 * the home's, and zsh's in ZDOTDIR (the host's, or the one the shell told
 * in env). */
export function startupFiles(home: string, hostEnv: Env, env: Env | null): string[] {
  const files = [...SYSTEM_STARTUP];
  const dirs: string[] = [];
  if (posix.isAbsolute(home)) dirs.push(home);
  for (const z of [hostEnv.ZDOTDIR ?? '', env?.ZDOTDIR ?? '']) if (posix.isAbsolute(z) && !dirs.includes(z)) dirs.push(z);
  for (const d of dirs) for (const f of HOME_STARTUP) files.push(posix.join(d, f));
  return files;
}

/** The files as they are: each one's modification time and size, or that
 * it is not there. */
export async function fileStamps(files: string[]): Promise<string> {
  const parts = await Promise.all(
    files.map(async (f) => {
      try {
        const st = await stat(f, { bigint: true });
        return `${f}\0${st.mtimeNs}\0${st.size}\n`;
      } catch {
        return `${f}\0-\n`;
      }
    }),
  );
  return parts.join('');
}

/** Whether line starts with a variable's name and "=". */
function isVariable(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '=') return i > 0;
    if (c === '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9' && i > 0)) continue;
    return false;
  }
  return false;
}

/** Reads the output of env: a line that starts with a variable's name and
 * "=" is a variable, any other line the next line of the value before it.
 * What the startup files printed ahead of the first variable is dropped,
 * and so are the functions bash exports (BASH_FUNC_name%%=…), whose bodies
 * take several lines. A variable set twice keeps its last value. */
export function parseEnv(out: string): Env {
  const env: Env = {};
  let last: string | null = null;
  const text = out.endsWith('\n') ? out.slice(0, -1) : out;
  for (const line of text.split('\n')) {
    if (isVariable(line)) {
      const i = line.indexOf('=');
      last = line.slice(0, i);
      // A later assignment is the one a program started with env sees.
      delete env[last];
      env[last] = line.slice(i + 1);
    } else if (line.startsWith('BASH_FUNC_') && line.includes('%%=')) {
      last = null;
    } else if (last !== null) {
      env[last] += '\n' + line;
    }
  }
  return env;
}

/** Runs shell as an interactive login shell that prints its environment
 * (shell -l -i -c env), and /bin/sh as a login shell when shell is no
 * absolute path. The shell gets no input and a session of its own: without
 * a terminal it cannot stop to ask for one. What its startup files leave
 * running goes with it. Throws why it told no environment. */
export async function loginEnv(
  shell: string,
  o: { procs: AgentProcesses; env: Env; home: string; signal: AbortSignal; timing?: Partial<typeof ENV_TIMING> },
): Promise<Env> {
  const t = { ...ENV_TIMING, ...o.timing };
  let argv = [shell, '-l', '-i', '-c', 'env'];
  if (!posix.isAbsolute(shell)) argv = ['/bin/sh', '-l', '-c', 'env'];
  let cwd = '/';
  try {
    if ((await stat(o.home)).isDirectory()) cwd = o.home;
  } catch {
    // the root, then
  }
  const p = await o.procs.spawn(argv, { cwd, env: o.env });
  p.closeInput();
  const chunks: Buffer[] = [];
  let n = 0;
  let over = false;
  const reader = p.stdout.getReader();
  const read = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      n += value.length;
      if (n > t.shellOutput) {
        over = true;
        return;
      }
      chunks.push(Buffer.from(value));
    }
  })().catch(() => {});
  let timedOut = false;
  const kill = () => p.signal('SIGKILL');
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, t.shellMs);
  o.signal.addEventListener('abort', kill, { once: true });
  try {
    await Promise.race([p.exited, read.then(() => (over ? kill() : undefined))]);
    await p.exited;
    // What the startup files left running goes now.
    kill();
    await Promise.race([read, new Promise((r) => setTimeout(r, t.pipesMs))]);
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener('abort', kill);
    void reader.cancel().catch(() => {});
    void p.stop({ grace: 0, term: 0, drain: 0 });
  }
  if (over) throw new Error(`${argv[0]} printed more than ${t.shellOutput} bytes`);
  if (timedOut) throw new Error(`${argv[0]} did not answer within ${t.shellMs / 1000} s`);
  if (o.signal.aborted) throw new Error('the request ended');
  const status = p.status();
  if (status !== 'exit status 0') throw new Error(`${argv[0]}: ${status}`);
  const env = parseEnv(Buffer.concat(chunks).toString('utf8'));
  if (env.PATH === undefined) throw new Error(`${argv[0]} printed no PATH`);
  return env;
}

/** Tells the user's environment, asked for when needed and kept while the
 * startup files stay as they were, for ENV_TIMING.keepMs at most. */
export class Environment {
  private env: Env | null = null;
  private at = 0;
  private keep = 0;
  private stamps = '';
  private asking: Promise<Env> | null = null;
  private readonly o: {
    logger: Logger;
    procs: AgentProcesses;
    /** The host's own environment. */
    hostEnv: Env;
    home: string;
    /** Replaces the login shell (tests). */
    lookup?: (signal: AbortSignal) => Promise<Env>;
    timing?: Partial<typeof ENV_TIMING>;
    now?: () => number;
  };

  constructor(o: Environment['o']) {
    this.o = o;
  }

  /** The user's environment: the login shell's, or the host's own when the
   * shell did not tell. One shell runs at a time; the callers that come
   * meanwhile get its answer. */
  async get(signal: AbortSignal): Promise<Env> {
    const now = (this.o.now ?? Date.now)();
    const stamps = await fileStamps(startupFiles(this.o.home, this.o.hostEnv, this.env));
    if (this.env && now - this.at < this.keep && stamps === this.stamps) return this.env;
    this.asking ??= this.ask(stamps).finally(() => (this.asking = null));
    return Promise.race([
      this.asking,
      new Promise<Env>((resolve) => signal.addEventListener('abort', () => resolve(this.o.hostEnv), { once: true })),
    ]);
  }

  private async ask(stamps: string): Promise<Env> {
    const t = { ...ENV_TIMING, ...this.o.timing };
    let env: Env;
    let keep = t.keepMs;
    // The shell is the host's to end: a caller that gives up does not.
    const signal = AbortSignal.timeout(t.shellMs + t.pipesMs + 1000);
    try {
      env = this.o.lookup
        ? await this.o.lookup(signal)
        : await loginEnv(this.o.hostEnv.SHELL ?? '', { ...this.o, env: this.o.hostEnv, signal });
    } catch (e) {
      this.o.logger(`the login shell's environment: ${(e as Error).message}; using the host's own`);
      env = this.o.hostEnv;
      keep = t.failKeepMs;
    }
    const before = startupFiles(this.o.home, this.o.hostEnv, this.env).join('\0');
    if (startupFiles(this.o.home, this.o.hostEnv, env).join('\0') !== before)
      // The shell told a ZDOTDIR of its own.
      stamps = await fileStamps(startupFiles(this.o.home, this.o.hostEnv, env));
    this.env = env;
    this.at = (this.o.now ?? Date.now)();
    this.keep = keep;
    this.stamps = stamps;
    return env;
  }
}

/** The variables by which Claude Code and Codex mark the programs of one of
 * their sessions (the agent's list, #machine/env.ts): an agent started with
 * them would take itself for a tool of that session. */
export { AGENT_SESSION_VARS };

/** Whether a variable of the user's environment is passed on to an agent.
 * The host runs in a hidden terminal of the terminal core, started by the
 * machine's agent that ssh may have started, and the user's login shell may
 * have been started in another terminal or multiplexer still; an agent that
 * saw their variables would take itself for a program of a terminal it does
 * not run in. Left out:
 *
 *   - the terminal core's variables of the host's own terminal
 *     (HC_TERMINAL_*), which would name the hidden terminal to what the
 *     agent runs; the core's others stay: HC_SCOPE, by which the core's
 *     sweep finds the agents should the host's terminal be lost, and
 *     HC_SESSION and HC_SOCKET, which name the core itself;
 *   - herdr's and this product's (HERDR_*, ENV_PREFIX);
 *   - tmux's (TMUX, TMUX_PANE), GNU screen's (STY), zellij's (ZELLIJ,
 *     ZELLIJ_*);
 *   - ssh's (SSH_*), and the terminal's identity (TERM_PROGRAM*,
 *     COLORTERM): no terminal is there;
 *   - PWD and OLDPWD, the shell's (agentEnv sets PWD);
 *   - the coding agents' session markers (AGENT_SESSION_VARS). */
export function agentVar(k: string): boolean {
  switch (k) {
    case 'TMUX':
    case 'TMUX_PANE':
    case 'STY':
    case 'ZELLIJ':
    case 'COLORTERM':
    case 'PWD':
    case 'OLDPWD':
      return false;
  }
  if (AGENT_SESSION_VARS.has(k)) return false;
  for (const prefix of ['HC_TERMINAL_', 'HERDR_', ENV_PREFIX, 'ZELLIJ_', 'SSH_', 'TERM_PROGRAM']) if (k.startsWith(prefix)) return false;
  return true;
}

/** The environment of an agent started in dir: the user's without what
 * agentVar leaves out, with PWD set to dir and the chat spec's variables
 * added. */
export function agentEnv(user: Env, extra: Record<string, string> | undefined, dir: string): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(user)) if (agentVar(k)) env[k] = v;
  if (dir !== '') env.PWD = dir;
  for (const k of Object.keys(extra ?? {}).sort()) if (k !== '' && !/[=\0]/.test(k)) env[k] = extra![k]!;
  return env;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Whether p is a directory. */
export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Resolves a program as a shell would with env's PATH: a name without a
 * slash in PATH's absolute directories, an absolute path as it is;
 * anything else is not found. The absolute path of an executable file, or
 * null. */
export async function lookPath(file: string, env: Env): Promise<string | null> {
  if (file === '') return null;
  if (file.includes('/')) return posix.isAbsolute(file) && (await isExecutable(file)) ? file : null;
  for (const d of (env.PATH ?? '').split(':')) {
    if (!posix.isAbsolute(d)) continue;
    const p = posix.join(d, file);
    if (await isExecutable(p)) return p;
  }
  return null;
}

/** The user's home directory; "" when unknown. */
export function userHome(env: Env = process.env as Env): string {
  const h = env.HOME || homedir();
  return posix.isAbsolute(h) ? h : '';
}
