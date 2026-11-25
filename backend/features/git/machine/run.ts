// Runs of git for the Git feature's machine side: the git executable with
// an argument vector built by the machine side (no shell, no option from
// the request), in a session of its own (no controlling terminal, nothing
// can prompt, a process group to kill), with an environment that never
// points git at another repository, configuration or program and never
// asks for credentials or an editor. Each run has a timeout after which its
// process group is killed, and its output is bounded; at most MAX_RUNS run
// at once on a machine. Reads run no file system monitor and start no
// maintenance.
//
// The process is spawned with node:child_process rather than execa: a run
// must outlive neither its timeout nor a program a hook left in the
// background holding its output, and execa's result waits for the output
// to close; here git's exit ends the run once the output closed or, at the
// latest, WAIT_DELAY after it.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { posix } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';

/** How long a run may take, and how long it waits for a free slot. */
export interface GitTiming {
  /** A read. */
  readMs: number;
  /** A fetch, pull, push, a commit (hooks run) and the other changes. */
  changeMs: number;
  /** A run that finds no free slot within this long fails with busy. */
  slotWaitMs: number;
  /** How long a run waits, after git exited, for its output to close: a
   * program a hook left in the background may hold it. */
  waitDelayMs: number;
}

export const GIT_TIMING: GitTiming = { readMs: 15_000, changeMs: 120_000, slotWaitMs: 3000, waitDelayMs: 2000 };

/** Bounds what a run of git may print. */
export const MAX_OUTPUT = 32 << 20;
/** Bounds what of git's errors a run keeps. */
const MAX_ERRORS = 64 << 10;
/** The runs of git at once on a machine. */
export const MAX_RUNS = 8;

/** One run of git. */
export interface Run {
  args: string[];
  stdin?: string;
  /** The run's timeout; the read or change timeout by default. */
  timeoutMs?: number;
  /** Bounds the output; over it the run fails with too_large, or with
   * keep git is killed and what it printed so far is the result (cut). */
  limit?: number;
  keep?: boolean;
  /** Exit codes that are not failures (diff's 1). */
  ok?: number[];
}

/** What a run printed; cut: the output stopped at the run's limit. */
export interface Result {
  out: Buffer;
  err: Buffer;
  code: number;
  cut: boolean;
}

/** The options of every run: no colors, pager or signatures; no
 * maintenance detached into the background (an automatic gc a change
 * starts runs in the run's process group, under its timeout). */
const BASE_CONFIG = [
  '-c',
  'core.quotePath=false',
  '-c',
  'color.ui=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'gc.autoDetach=false',
  '-c',
  'maintenance.autoDetach=false',
];

/** The options of reads: no file system monitor (a hook or daemon of the
 * repository's configuration), no untracked cache, no maintenance. */
const READ_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

/** The variables of git's own (GIT_*) a run keeps: how ssh is run and who
 * authors and commits. Every other GIT_* variable is dropped (GIT_DIR,
 * GIT_CONFIG_*, GIT_ATTR_SOURCE, GIT_EXEC_PATH, GIT_TRACE*, the pathspec
 * modes…: they would point git at another repository, configuration or
 * program, write files elsewhere, or change how hooks read pathspecs), and
 * so are the askpass programs and the locale; the run sets its own. */
const KEPT = new Set(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT']);
const KEPT_PREFIXES = ['GIT_AUTHOR_', 'GIT_COMMITTER_'];
const DROPPED = new Set(['SSH_ASKPASS', 'LC_ALL', 'LANG', 'LANGUAGE']);

/** Whether the variable k of the agent's environment is passed to git. */
export function keepVar(k: string): boolean {
  if (DROPPED.has(k)) return false;
  if (!k.startsWith('GIT_') || KEPT.has(k)) return true;
  return KEPT_PREFIXES.some((p) => k.startsWith(p));
}

/** The environment of a run of git, from the agent's. */
export function gitEnv(base: Record<string, string>, read: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (keepVar(k)) env[k] = v;
  Object.assign(env, {
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    // ssh has no terminal to ask on (a session of its own) and no askpass.
    SSH_ASKPASS_REQUIRE: 'never',
  });
  if (read) env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

/** The git executable in PATH; null when there is none. */
export function findGit(path = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const p = posix.join(dir, 'git');
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

/** A semaphore of slots, each taken for one run. */
export class Slots {
  private free: number;
  private readonly waiters: Array<() => void> = [];
  readonly size: number;

  constructor(n: number) {
    this.size = n;
    this.free = n;
  }

  /** The slots taken. */
  get taken(): number {
    return this.size - this.free;
  }

  /** Takes a slot within waitMs (busy otherwise), until signal ends
   * (cancelled); the slot's release. */
  take(waitMs: number, signal: AbortSignal, what: string): Promise<() => void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    };
    if (signal.aborted) return Promise.reject(cancelled(what, signal));
    if (this.free > 0) {
      this.free--;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const grant = () => {
        done();
        resolve(release);
      };
      const drop = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        done();
      };
      const timer = setTimeout(() => {
        drop();
        reject(new Fail('busy', 503, `${this.size} runs of git are in progress`));
      }, waitMs);
      const onAbort = () => {
        drop();
        reject(cancelled(what, signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
    });
  }
}

/** Why a run stopped early: its own timeout, or the request's end. */
const TIMED_OUT = Symbol('timeout');

function cancelled(what: string, signal: AbortSignal): Fail {
  return signal.reason === TIMED_OUT ? new Fail('timeout', 504, `${what} took too long`) : new Fail('cancelled', 400, `${what}: cancelled`);
}

/** git's refusal to pull into a branch that diverged from its upstream when
 * no pull.rebase or pull.ff says how. */
const DIVERGED = /reconcile divergent branches/i;
const AUTH_FAILURE =
  /terminal prompts disabled|could not read (username|password)|authentication failed|permission denied \(publickey|host key verification failed|askpass|invalid username or password|access denied|HTTP Basic: Access denied/i;

/** The failure of a run of git that exited otherwise than its run allows:
 * not_a_repo, auth_required, conflicts, diverged, or git_failed with what
 * git said. */
export function classify(sub: string, res: Pick<Result, 'out' | 'err'>): Fail {
  let msg = res.err.toString('utf8').trim();
  if (msg === '') msg = res.out.toString('utf8').trim();
  if (msg.length > 4000) msg = msg.slice(0, 4000) + '…';
  const out = res.out.toString('utf8');
  if (msg.includes('not a git repository')) return new Fail('not_a_repo', 400, msg);
  if (AUTH_FAILURE.test(msg)) return new Fail('auth_required', 400, msg);
  if (out.includes('CONFLICT') || msg.includes('CONFLICT') || msg.includes('could not apply'))
    return new Fail('conflicts', 409, `${out}\n${msg}`.trim());
  if (DIVERGED.test(msg)) return new Fail('diverged', 409, msg);
  return new Fail('git_failed', 400, `git ${sub}: ${msg}`);
}

export interface RunnerOptions {
  timing: GitTiming;
  /** The git executable; null when there is none. */
  git: () => string | null;
  slots: Slots;
}

/** Runs git in dir (read: a read's options and environment) with the
 * agent's environment env, until the run's timeout or signal. */
export async function execGit(
  o: RunnerOptions,
  env: Record<string, string>,
  dir: string,
  read: boolean,
  rn: Run,
  signal: AbortSignal,
): Promise<Result> {
  const sub = rn.args[0] ?? '';
  const what = `git ${sub}`;
  const bin = o.git();
  if (!bin) throw new Fail('git_missing', 503, 'git is not installed');
  const timeoutMs = rn.timeoutMs ?? o.timing.readMs;
  const limit = rn.limit ?? MAX_OUTPUT;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(TIMED_OUT), timeoutMs);
  const onAbort = () => ac.abort(signal.reason);
  if (signal.aborted) onAbort();
  signal.addEventListener('abort', onAbort, { once: true });
  let release: (() => void) | undefined;
  try {
    release = await o.slots.take(o.timing.slotWaitMs, ac.signal, what);
    return await spawnGit(bin, dir, read, rn, limit, gitEnv(env, read), ac.signal, o.timing.waitDelayMs, what);
  } finally {
    release?.();
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** The failure of a run that did not start: git_missing when the
 * executable is gone, not_found when the directory is, failed otherwise
 * (an argument list over the system's limit, no memory). */
function startError(bin: string, dir: string, e: unknown): Fail {
  if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
    try {
      statSync(bin);
    } catch {
      return new Fail('git_missing', 503, (e as Error).message);
    }
    try {
      statSync(dir);
    } catch (se) {
      return new Fail('not_found', 404, `${dir}: ${(se as Error).message}`);
    }
  }
  return new Fail('failed', 500, `git did not start: ${(e as Error)?.message ?? e}`);
}

function spawnGit(
  bin: string,
  dir: string,
  read: boolean,
  rn: Run,
  limit: number,
  env: Record<string, string>,
  signal: AbortSignal,
  waitDelayMs: number,
  what: string,
): Promise<Result> {
  const args = ['-C', dir, ...BASE_CONFIG, ...(read ? READ_CONFIG : []), '--no-pager', ...rn.args];
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: dir, env, detached: true, stdio: [rn.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(startError(bin, dir, e));
    }
    const out: Buffer[] = [];
    let outLen = 0;
    const err: Buffer[] = [];
    let errLen = 0;
    let over = false;
    let exit: { code: number } | null = null;
    let closed = false;
    let settled = false;
    let delay: ReturnType<typeof setTimeout> | undefined;
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    };
    const onAbort = () => killGroup();
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = () => {
      if (settled || !exit) return;
      settled = true;
      clearTimeout(delay);
      signal.removeEventListener('abort', onAbort);
      // What still holds the pipes (a hook's background job) is the
      // user's and keeps running; the run no longer reads them.
      child.stdout?.destroy();
      child.stderr?.destroy();
      const res: Result = { out: Buffer.concat(out), err: Buffer.concat(err), code: exit.code, cut: false };
      if (over) {
        if (rn.keep) resolve({ out: res.out, err: Buffer.alloc(0), code: 0, cut: true });
        else reject(new Fail('too_large', 400, `${what} printed more than ${limit} bytes`));
        return;
      }
      if (signal.aborted) return reject(cancelled(what, signal));
      if (res.code === 0 || rn.ok?.includes(res.code)) return resolve(res);
      reject(classify(rn.args[0] ?? '', res));
    };
    child.stdout!.on('data', (b: Buffer) => {
      if (over) return;
      if (outLen + b.length > limit) {
        // What fits is kept: a run with keep returns the first limit bytes.
        out.push(b.subarray(0, limit - outLen));
        outLen = limit;
        over = true;
        killGroup();
        return;
      }
      out.push(b);
      outLen += b.length;
    });
    child.stderr!.on('data', (b: Buffer) => {
      if (errLen >= MAX_ERRORS) return;
      const part = b.subarray(0, MAX_ERRORS - errLen);
      err.push(part);
      errLen += part.length;
    });
    child.stdout!.on('error', () => {});
    child.stderr!.on('error', () => {});
    child.once('error', (e) => {
      if (exit) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(startError(bin, dir, e));
    });
    child.once('exit', (code) => {
      exit = { code: code ?? -1 };
      if (closed) settle();
      else delay = setTimeout(settle, waitDelayMs);
    });
    child.once('close', () => {
      closed = true;
      settle();
    });
    if (rn.stdin !== undefined) {
      child.stdin!.on('error', () => {}); // git may exit without reading it
      child.stdin!.end(rn.stdin);
    }
    if (signal.aborted) killGroup();
  });
}
