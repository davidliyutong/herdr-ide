// Short runs of the machine's programs for the display (apt-get, dpkg-deb,
// an X server's -help, VirtualGL's eglinfo, the loader's check of the GPU
// selection library): no shell, the agent's clean environment, a session
// of their own whose group is killed at the timeout, output bounded.
import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  /** Standard output and error, as they came, at most MAX_OUTPUT. */
  out: string;
}

const MAX_OUTPUT = 1 << 20;

export function run(
  argv: string[],
  o: { env: Record<string, string>; cwd?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn(argv[0], argv.slice(1), { env: o.env, cwd: o.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    };
    const t = setTimeout(kill, o.timeoutMs);
    o.signal?.addEventListener('abort', kill, { once: true });
    const take = (b: Buffer) => {
      if (out.length < MAX_OUTPUT) out += b.toString('utf8');
    };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    const finish = (code: number | null, err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      o.signal?.removeEventListener('abort', kill);
      resolve({ code, out: err ? err.message : out });
    };
    child.once('error', (e) => finish(-1, e));
    child.once('close', (code) => finish(code));
  });
}

/** The last n characters of s. */
export function lastN(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}
