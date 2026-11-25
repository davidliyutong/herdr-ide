// The stat of the directories the explorer shows, which it polls while it
// is visible. A stat of a dead mount holds a thread until the mount
// answers, and the explorer polls again every few seconds: at most max
// stats run at once, a path is not asked again while a stat of it runs,
// and an answer comes in time with the state of what did not answer
// unknown (busy, timeout), not gone.
import type { Stats } from 'node:fs';
import { Fail } from '#shared/lib/fail.ts';
import type { Entry } from '../protocol.ts';
import { entryOf, errCode } from './guard.ts';

export interface StatOptions {
  /** How long one stat action waits for its paths (the hub waits 20 s). */
  waitMs: number;
  /** The stats running at once. */
  max: number;
  stat: (p: string) => Promise<Stats>;
}

const busy = () => new Fail('busy', 429, 'too many stats running');

export class Stater {
  private readonly flights = new Map<string, Promise<Stats>>();
  private readonly o: StatOptions;

  constructor(o: StatOptions) {
    this.o = o;
  }

  /** The stats running (a stat outlives a caller that stopped waiting). */
  get running(): number {
    return this.flights.size;
  }

  /** p's stat, or the one of p already running, until signal ends. */
  private shared(p: string, signal: AbortSignal): Promise<Stats> {
    if (signal.aborted) return Promise.reject(signal.reason);
    let f = this.flights.get(p);
    if (!f) {
      if (this.flights.size >= this.o.max) return Promise.reject(busy());
      f = this.o.stat(p).finally(() => this.flights.delete(p));
      f.catch(() => {});
      this.flights.set(p, f);
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      f.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /** The entries of paths, in their order, each as given; expand makes a
   * path absolute (a path it refuses is not there). */
  async stat(paths: string[], expand: (p: string) => string, signal: AbortSignal): Promise<Entry[]> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.o.waitMs)]);
    const out: Entry[] = [];
    for (const p of paths) {
      let abs: string;
      try {
        abs = expand(p);
      } catch {
        out.push({ path: p, exists: false, size: 0, mtime: 0 });
        continue;
      }
      try {
        out.push(entryOf(p, await this.shared(abs, bounded)));
      } catch (e) {
        const code = errCode(e);
        if (code === 'ENOENT' || code === 'ENOTDIR') out.push({ path: p, exists: false, size: 0, mtime: 0 });
        else out.push({ path: p, exists: false, size: 0, mtime: 0, error: statCode(e, bounded) });
      }
    }
    return out;
  }
}

function statCode(e: unknown, signal: AbortSignal): string {
  if (e instanceof Fail && e.code === 'busy') return 'busy';
  if (signal.aborted) return 'timeout';
  const code = errCode(e);
  if (code === 'EACCES' || code === 'EPERM') return 'denied';
  return 'failed';
}
