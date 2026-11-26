// The task manager's signals: one of an allowlist, to a process the
// agent's user may signal (the kernel refuses the others: EPERM), never to
// init, to a pid at or below 1 (a process group, every process) or to the
// agent itself.
import { constants } from 'node:os';
import { Fail } from '#shared/lib/fail.ts';
import { MAX_PID } from '../protocol.ts';

/** The signals the task manager may send. */
export const ALLOWED_SIGNALS = ['TERM', 'KILL', 'INT', 'HUP', 'STOP', 'CONT'] as const;

/** Sends the signal named name (TERM when none) to pid; what it sent. */
export function sendSignal(pid: number, name: string, self = process.pid): { ok: true; pid: number; signal: string } {
  if (pid <= 1 || pid > MAX_PID) throw new Fail('invalid_pid', 400, `refusing to signal pid ${pid}`);
  if (pid === self) throw new Fail('invalid_pid', 400, 'refusing to signal the agent process');
  const sig = name.trim().toUpperCase() || 'TERM';
  if (!(ALLOWED_SIGNALS as readonly string[]).includes(sig))
    throw new Fail('invalid_signal', 400, `signal ${JSON.stringify(name)} is not allowed`);
  try {
    process.kill(pid, constants.signals[`SIG${sig}` as keyof typeof constants.signals]);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') throw new Fail('not_found', 404, `process ${pid} not found`);
    if (code === 'EPERM') throw new Fail('permission_denied', 403, `permission denied signaling pid ${pid}`);
    throw new Fail('signal_failed', 500, `signal ${sig} to ${pid}: ${(e as Error).message}`);
  }
  return { ok: true, pid, signal: sig };
}
