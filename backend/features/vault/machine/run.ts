// run_with_env's commands (the vault's MCP server, mcp.ts): `sh -c` with the
// values in the command's environment, its output captured within a
// bound and every value in it replaced with ***, as the Go build's vault MCP server ran
// them.
//
// A command runs in a process group (a session) of its own, which is killed
// whenever the command returns, times out or is cancelled, so programs it
// left in the background do not keep the values. It must also end with the
// server however the server ends, SIGKILL included, which the server cannot
// see: the shell first starts a watcher in the group that waits on fd 3,
// the server's end of a pipe only the server holds, and kills the group
// (kill -9 0) once it reads the pipe's end, which comes when the server is
// gone or done with the command. (The Go build also has Linux kill the
// shell when the server dies, Pdeathsig, which Node's spawn cannot ask for:
// the watcher alone ends the group here.) A program that leaves the group
// (setsid, a daemon) escapes it.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { formatDuration } from '#shared/lib/gotime.ts';
import type { VaultRun } from '#shared/proto/agentproto/index.ts';

/** run_with_env's default and longest timeout and the output it returns,
 * when the hub gives none. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MAX_OUTPUT = 64 << 10;
/** The longest value the vault keeps: output is captured that much beyond
 * the limit so that a value cut by the limit is still masked. */
const MAX_VALUE = 64 << 10;
/** How long a command's output may stay open after its shell exited, held
 * by programs it left in the background. */
export const WAIT_DELAY_MS = 2000;

/** The bounds of a command; what is left out takes the defaults. */
export interface RunLimits {
  maxOutput?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
}

/** limits bounded as the hub says (the vault's settings, in seconds and
 * bytes); what the hub leaves out (an older hub, or none) keeps them. */
export function withHub(limits: RunLimits, run: VaultRun | undefined): RunLimits {
  if (!run) return limits;
  const out = { ...limits };
  if (run.timeout > 0) out.defaultTimeoutMs = run.timeout * 1000;
  if (run.max_timeout > 0) out.maxTimeoutMs = run.max_timeout * 1000;
  if (run.max_output > 0) out.maxOutput = run.max_output;
  return out;
}

/** The shell's script before the command: the watcher in the command's
 * group waits on fd 3 and kills the group (kill 0) when it reads the end;
 * the shell then closes fd 3 and becomes the command's shell ($0, an
 * absolute path: the command's environment may name another PATH), its
 * standard error going where its output goes, the command's $0 being $2.
 * The watcher's output goes nowhere, so it does not hold the command's. */
export const WATCHER_SCRIPT = `(read x <&3; kill -9 0) >/dev/null 2>&1 &
exec 3<&-
exec "$0" -c "$1" "$2" 2>&1`;

/** Replaces every occurrence of the values in s with ***, longest values
 * first. It hides values as they are, not encoded or split. */
export function mask(s: string, values: Record<string, string>): string {
  return maskOutput(Buffer.from(s, 'utf8'), values, false).toString('utf8');
}

/** mask for output whose capture was cut (cut): its last bytes may be the
 * beginning of a value, which no occurrence matches and which masking the
 * rest would bring within the returned part (*** is shorter than most
 * values). The bytes that could be one (fewer than the longest value's
 * length from the end) are dropped, but for an occurrence that began before
 * them, which is masked whole. Bytes, as the Go build counts them. */
export function maskOutput(s: Buffer, values: Record<string, string>, cut: boolean): Buffer {
  const vs = Object.values(values)
    .filter((v) => v !== '')
    .map((v) => Buffer.from(v, 'utf8'))
    .sort((a, b) => b.length - a.length);
  if (vs.length === 0) return s;
  const end = cut ? Math.max(0, s.length - (vs[0].length - 1)) : s.length;
  // Occurrences, longest values first, none overlapping another: spans
  // stays sorted, so the first one ending after a candidate's start is the
  // one it could overlap.
  let spans: Array<{ from: number; to: number }> = [];
  for (const v of vs) {
    const found: Array<{ from: number; to: number }> = [];
    let k = 0;
    for (let at = 0; at < s.length;) {
      const i = s.indexOf(v, at);
      if (i < 0) break;
      while (k < spans.length && spans[k].to <= i) k++;
      if (k < spans.length && spans[k].from < i + v.length) {
        at = spans[k].to; // every start before it overlaps it too
        continue;
      }
      found.push({ from: i, to: i + v.length });
      at = i + v.length;
    }
    spans = [...spans, ...found].sort((a, b) => a.from - b.from);
  }
  const parts: Buffer[] = [];
  let at = 0;
  for (const sp of spans) {
    if (sp.from >= end) break;
    parts.push(s.subarray(at, sp.from), Buffer.from('***'));
    at = sp.to;
  }
  if (at < end) parts.push(s.subarray(at, end));
  return Buffer.concat(parts);
}

/** What a command gave: its exit status, notes and masked output, and
 * whether it failed (a status other than 0, a timeout, a cancel, a command
 * that could not start). */
export interface Ran {
  out: string;
  failed: boolean;
}

export interface RunOptions {
  limits?: RunLimits;
  /** Cancels the command (the client cancelled the call, the server ends). */
  signal?: AbortSignal;
  waitDelayMs?: number;
  /** The shell (tests); else `sh` of the PATH. */
  shell?: string;
}

/** Runs command with `sh -c` in dir (the server's own when "") with env
 * added to this process's environment, for timeoutMs (0: the default; at
 * most the longest). */
export async function runWithEnv(
  command: string,
  env: Record<string, string>,
  dir: string,
  timeoutMs: number,
  o: RunOptions = {},
): Promise<Ran> {
  const limit = o.limits?.maxOutput && o.limits.maxOutput > 0 ? o.limits.maxOutput : MAX_OUTPUT;
  const def = o.limits?.defaultTimeoutMs && o.limits.defaultTimeoutMs > 0 ? o.limits.defaultTimeoutMs : DEFAULT_TIMEOUT_MS;
  const longest = o.limits?.maxTimeoutMs && o.limits.maxTimeoutMs > 0 ? o.limits.maxTimeoutMs : MAX_TIMEOUT_MS;
  const timeout = Math.min(timeoutMs > 0 ? timeoutMs : def, longest);
  const cannot = (why: string): Ran => ({ out: mask(`cannot start: ${why}`, env), failed: true });
  if (dir !== '') {
    try {
      if (!(await stat(dir)).isDirectory()) return cannot(`chdir ${dir}: not a directory`);
    } catch (e) {
      return cannot(`chdir ${dir}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file or directory' : (e as Error).message}`);
    }
  }
  const shell = o.shell ?? Bun.which('sh') ?? '/bin/sh';
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(shell, ['-c', WATCHER_SCRIPT, shell, command, 'sh'], {
      cwd: dir || undefined,
      env: { ...process.env, ...env },
      // fd 3 is the watcher's: this process's end of it closes when it is
      // done with the command or gone.
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (e) {
    return cannot((e as Error).message);
  }
  return new Promise<Ran>((resolve) => {
    const max = limit + MAX_VALUE;
    const parts: Buffer[] = [];
    let kept = 0;
    let total = 0;
    const take = (d: Buffer) => {
      total += d.length;
      if (kept < max) {
        const p = d.subarray(0, max - kept);
        parts.push(p);
        kept += p.length;
      }
    };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    let status: number | null = null;
    let exited = false;
    let open = 2; // stdout and stderr
    let note = '';
    let held = false;
    let finished = false;
    let late: ReturnType<typeof setTimeout> | undefined;
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(late);
      o.signal?.removeEventListener('abort', cancel);
      killGroup();
      child.stdio[3]?.destroy();
      child.stdout!.destroy();
      child.stderr!.destroy();
      const captured = Buffer.concat(parts, kept);
      let output = maskOutput(captured, env, total > captured.length);
      let truncated = total > limit;
      if (output.length > limit) {
        output = output.subarray(0, limit);
        truncated = true;
      }
      const text = output.toString('utf8');
      let out = `exit status: ${status ?? -1}\n${note}`;
      // Programs left in the background held the output after a shell
      // that succeeded (Go's exec.ErrWaitDelay).
      if (held && note === '' && status === 0) out += '[programs left in the background were killed]\n';
      out += text;
      if (truncated) out += `${text.endsWith('\n') ? '' : '\n'}[output truncated: ${limit} of ${total} bytes]\n`;
      resolve({ out, failed: status !== 0 || note !== '' });
    };
    const settle = () => {
      if (exited && open === 0) finish();
    };
    for (const s of [child.stdout!, child.stderr!])
      s.on('close', () => {
        open--;
        settle();
      });
    child.on('exit', (code) => {
      exited = true;
      status = code;
      if (open > 0)
        late = setTimeout(() => {
          held = true;
          finish();
        }, o.waitDelayMs ?? WAIT_DELAY_MS);
      settle();
    });
    child.on('error', (e) => {
      if (exited || finished) return;
      finished = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', cancel);
      child.stdio[3]?.destroy();
      resolve(cannot(e.message));
    });
    // Killed: the group goes, and with it what holds the output; the
    // command's end is waited for as it is otherwise.
    const end = (why: string) => {
      if (finished || note !== '') return;
      note = why;
      killGroup();
    };
    const timer = setTimeout(() => end(`[timed out after ${formatDuration(timeout * 1e6)}; the command was killed]\n`), timeout);
    const cancel = () => end('[cancelled; the command was killed]\n');
    if (o.signal?.aborted) cancel();
    else o.signal?.addEventListener('abort', cancel, { once: true });
  });
}
