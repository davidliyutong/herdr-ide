// The processes VS Code's machine side runs and ends: code-server itself,
// and the short programs around it (curl or wget for a download, the
// release's own Node checked once, code-server's extension installer). A
// program runs in a session of its own (no terminal, a process group to
// end), without a shell, bounded in time and in the output kept; the node's
// thread only waits for events.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { pgidOf } from '#machine/sys/proc.ts';

/** Whether a process pid exists that this user may signal. */
export function alive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const signal = (target: number, sig: NodeJS.Signals) => {
  try {
    process.kill(target, sig);
  } catch {
    // gone
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ends the process group pid leads or belongs to (code-server and its
 * helpers), or pid alone when that group is this process's own: SIGTERM,
 * then SIGKILL after termMs. */
export async function stopGroup(pid: number, termMs = 5000): Promise<void> {
  if (pid <= 1 || pid === process.pid || !alive(pid)) return;
  let target = pid;
  const pg = pgidOf(pid);
  if (pg !== null && pg > 1 && pg !== pgidOf(process.pid)) target = -pg;
  signal(target, 'SIGTERM');
  const deadline = Date.now() + termMs;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  if (alive(pid)) signal(target, 'SIGKILL');
}

/** Whether p is a regular file with an execute bit, following links. */
export async function isExecutable(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    if (!st.isFile() || (st.mode & 0o111) === 0) return false;
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The executable name in the directories of PATH, null when none. */
export async function lookPath(name: string, path = process.env.PATH ?? ''): Promise<string | null> {
  for (const dir of path.split(':')) {
    if (!dir.startsWith('/')) continue;
    const p = posix.join(dir, name);
    if (await isExecutable(p)) return p;
  }
  return null;
}

/** The end of s, trimmed: at most n characters, marked when cut. */
export function lastN(s: string, n: number): string {
  s = s.trim();
  return s.length > n ? `…${s.slice(s.length - n)}` : s;
}

/** Bounds what a run keeps of its output: the end. */
const MAX_OUTPUT = 64 << 10;

export interface RunResult {
  /** The exit status; null when the run did not end by itself. */
  code: number | null;
  /** What ended it otherwise: a signal, "timed out", "aborted", the
   * error of a program that could not start. */
  failure: string;
  /** Its standard output and error, the last MAX_OUTPUT bytes. */
  out: string;
}

/** Runs file with args (no shell) in a session of its own, with env as its
 * whole environment and no input; its process group is killed after
 * timeoutMs or when signal ends. */
export function run(
  file: string,
  args: string[],
  o: { env: Record<string, string>; timeoutMs: number; signal?: AbortSignal; cwd?: string },
): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    let failure = '';
    const child = spawn(file, args, { env: o.env, cwd: o.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (b: Buffer) => {
      out = Buffer.concat([out, b]);
      if (out.length > MAX_OUTPUT) out = out.subarray(out.length - MAX_OUTPUT);
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const kill = (why: string) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      failure ||= why;
      signal(-child.pid, 'SIGKILL');
    };
    const timer = setTimeout(() => kill('timed out'), o.timeoutMs);
    const onAbort = () => kill('aborted');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    if (o.signal?.aborted) onAbort();
    const done = (code: number | null, sig: NodeJS.Signals | null) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (!failure && sig) failure = `killed by ${sig}`;
      resolve({ code, failure, out: out.toString('utf8') });
    };
    child.once('error', (e) => {
      failure ||= e.message;
      done(null, null);
    });
    child.once('close', done);
  });
}

/** What went wrong with a run, "" when it exited with 0. */
export function runError(r: RunResult): string {
  if (r.failure) return r.failure;
  return r.code === 0 ? '' : `exit status ${r.code}`;
}
