// The monitor's access to the system, bounded: a file of /proc or /sys, a
// file system's statfs or a helper program (nvidia-smi, sysctl, ioreg…)
// that does not answer in time is given up on, and while one read of a
// path is still stuck no other starts, so a dead mount or a process stuck
// in the kernel holds one thread of the pool, not one per sample. Reads are
// asynchronous: the agent's other sessions go on meanwhile.
import { access, constants, readdir, readFile, stat, statfs } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { execa } from 'execa';

/** The statfs of a file system, as numbers. */
export interface StatFS {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}

/** What runs a sample's reads; one per agent. */
export class Bounded {
  private readonly pending = new Map<string, Promise<unknown>>();

  /** Shares a read of key and its deadline. A timed-out read still blocks
   * a new one until its underlying operation completes. */
  run<T>(key: string, ms: number, f: () => Promise<T>): Promise<T | null> {
    const pending = this.pending.get(key);
    if (pending) return pending as Promise<T | null>;
    const p = Promise.resolve()
      .then(f)
      .catch(() => null)
      .finally(() => this.pending.delete(key));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = Promise.race([p, new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(timer));
    this.pending.set(key, result);
    return result;
  }

  /** Whether a run of key is pending (a read that did not answer). */
  busy(key: string): boolean {
    return this.pending.has(key);
  }

  /** A file's text, null when it cannot be read within ms. */
  text(path: string, ms: number): Promise<string | null> {
    return this.run(`text:${path}`, ms, () => readFile(path, 'utf8'));
  }

  /** A file's bytes, null when it cannot be read within ms. */
  bytes(path: string, ms: number): Promise<Buffer | null> {
    return this.run(`bytes:${path}`, ms, () => readFile(path));
  }

  /** A directory's names, null when it cannot be read within ms. */
  names(path: string, ms: number): Promise<string[] | null> {
    return this.run(`readdir:${path}`, ms, () => readdir(path));
  }

  /** The owner of a path, null when it cannot be read within ms. */
  uid(path: string, ms: number): Promise<number | null> {
    return this.run(`stat:${path}`, ms, async () => (await stat(path)).uid);
  }

  /** A file system's statfs, null when it does not answer within ms. */
  statfs(path: string, ms: number): Promise<StatFS | null> {
    return this.run(`statfs:${path}`, ms, async () => {
      const s = await statfs(path, { bigint: true });
      return { bsize: Number(s.bsize), blocks: Number(s.blocks), bfree: Number(s.bfree), bavail: Number(s.bavail) };
    });
  }
}

/** Runs f on each item, at most n at a time; the results in order. */
export async function mapLimit<T, R>(items: readonly T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Runs a helper program with LC_ALL=C; its standard output, null when it
 * is missing, fails or takes longer than ms. */
export async function runCmd(
  file: string,
  args: string[],
  o: { env: Record<string, string>; ms: number; signal?: AbortSignal },
): Promise<string | null> {
  try {
    const r = await execa(file, args, {
      env: { ...o.env, LC_ALL: 'C' },
      extendEnv: false,
      timeout: o.ms,
      cancelSignal: o.signal,
      reject: false,
      stdin: 'ignore',
      stderr: 'ignore',
      stripFinalNewline: false,
      forceKillAfterDelay: 1000,
      maxBuffer: 64 << 20,
    });
    return r.exitCode === 0 && !r.failed ? r.stdout : null;
  } catch {
    return null;
  }
}

/** Whether name is an executable in a directory of path (PATH). */
export async function onPath(name: string, path: string | undefined): Promise<boolean> {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      await access(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // not there
    }
  }
  return false;
}
