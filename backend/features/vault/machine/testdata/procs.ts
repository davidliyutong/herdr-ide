// Processes the runner's tests wait for.
import { execFileSync } from 'node:child_process';

/** Whether process pid is gone: no such process, or a zombie a killed
 * group left for init to reap. */
export function goneOrZombie(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      .trim()
      .startsWith('Z');
  } catch {
    return true;
  }
}

/** Waits up to 10 s for the processes to end; the ones still there are
 * killed and returned. */
export async function survivors(pids: number[]): Promise<number[]> {
  const left: number[] = [];
  for (const pid of pids) {
    const deadline = Date.now() + 10_000;
    while (!goneOrZombie(pid) && Date.now() < deadline) await Bun.sleep(10);
    if (!goneOrZombie(pid)) {
      left.push(pid);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone meanwhile
      }
    }
  }
  return left;
}
