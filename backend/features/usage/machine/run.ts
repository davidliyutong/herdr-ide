// The programs the limits run (security for Claude's keychain item, ps and
// lsof for Antigravity's language server, agy): asynchronously, in a
// process group of their own that is killed when the run times out or its
// request ends and again once the program exited, so nothing it started
// (agy's helpers) outlives it; at most MAX_OUTPUT of their output is kept.
//
// node:child_process rather than execa: the group must be killed after the
// program exited too, and the run must not wait for a helper left in the
// background that holds the output.
import { spawn } from 'node:child_process';

/** Bounds what a program's output is kept of. */
export const MAX_OUTPUT = 4 << 20;
/** How long a run waits, after the program exited, for its output to
 * close (a helper left in the background may hold it). */
const WAIT_DELAY = 2000;

/** What a program printed, and whether it exited with 0. */
export interface Ran {
  out: string;
  ok: boolean;
}

function killGroup(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // gone
  }
}

/** Runs file with args and env (nothing else of the agent's), its
 * standard input empty and its errors dropped, for at most ms. Fails only
 * when the program cannot be started. */
export function run(file: string, args: string[], o: { env: Record<string, string>; ms: number; signal?: AbortSignal }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return resolve({ out: '', ok: false });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { env: o.env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch (e) {
      return reject(e as Error);
    }
    const parts: Buffer[] = [];
    let n = 0;
    let code: number | null = null;
    let exited = false;
    let finished = false;
    let late: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(late);
      o.signal?.removeEventListener('abort', stop);
      killGroup(child.pid);
      child.stdout?.destroy();
      resolve({ out: Buffer.concat(parts).toString('utf8'), ok: exited && code === 0 });
    };
    const stop = () => {
      killGroup(child.pid);
      finish();
    };
    const timer = setTimeout(stop, o.ms);
    o.signal?.addEventListener('abort', stop, { once: true });
    child.stdout?.on('data', (d: Buffer) => {
      if (n < MAX_OUTPUT) parts.push(d.subarray(0, MAX_OUTPUT - n));
      n += d.length;
    });
    child.stdout?.on('close', () => {
      if (exited) finish();
    });
    child.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', stop);
      reject(e);
    });
    child.on('exit', (c) => {
      exited = true;
      code = c;
      // Whatever it left in its group goes now.
      killGroup(child.pid);
      if (child.stdout?.closed ?? true) finish();
      else late = setTimeout(finish, WAIT_DELAY);
    });
  });
}
