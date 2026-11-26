// The processes VS Code's machine side runs and ends: code-server itself,
// and the short programs around it (curl or wget for a download, the
// release's own Node checked once, code-server's extension installer),
// which run as #machine/programs.ts runs them: in a session of their own
// (no terminal, a process group to end), without a shell, bounded in time
// and in the output kept; the node's thread only waits for events.
import { pgidOf } from '#machine/sys/proc.ts';

export { isExecutable, lastN, lookPath, run, runError, type RunResult } from '#machine/programs.ts';

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
