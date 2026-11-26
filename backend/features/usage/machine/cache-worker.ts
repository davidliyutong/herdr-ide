import { machineWorker } from '#machine/state-worker.ts';
import { StateWorker } from '#shared/lib/state-worker.ts';
import type { cacheOperations } from './cache.ts';
import type { Entry } from './parsers.ts';

/** The node owns the cache worker, even when one scan is cancelled. */
export class CacheWorker {
  private readonly worker: StateWorker<ReturnType<typeof cacheOperations>>;
  private readonly life: AbortSignal;
  private nextLoad = 0;

  constructor(base: string, life: AbortSignal) {
    this.worker = new StateWorker(() => machineWorker({ kind: 'usage', base }));
    this.life = life;
  }

  state(signal: AbortSignal) {
    return this.worker.request('state', signal);
  }

  async load(signal: AbortSignal): Promise<{ files: Map<string, Entry>; gen: number }> {
    const id = ++this.nextLoad;
    const files = new Map<string, Entry>();
    let done = false;
    try {
      for (let first = true; ; first = false) {
        const batch = await this.worker.request('load', signal, id, first);
        done = batch.done === true;
        if (batch.value.reset) files.clear();
        for (const [path, entry] of batch.value.files) files.set(path, entry);
        if (done) return { files, gen: batch.value.gen };
      }
    } finally {
      if (!done) void this.worker.request('finishLoad', this.life, id).catch(() => {});
    }
  }

  async save(files: Map<string, Entry>, changed: ReadonlySet<string>, removed: ReadonlySet<string>, at: number): Promise<number | false> {
    const signal = AbortSignal.any([this.life, AbortSignal.timeout(30_000)]);
    const delta = new Map<string, Entry>();
    for (const p of changed) {
      const entry = files.get(p);
      if (entry) delta.set(p, entry);
    }
    const gone = [...removed];
    const g = await this.worker.request('save', signal, delta, gone, at, delta.size !== files.size);
    if (g !== 'replace') return g;
    const replaced = await this.worker.request('save', signal, files, gone, at, false, [...changed]);
    return replaced === 'replace' ? false : replaced;
  }

  sweep(cutoff: number): Promise<void> {
    return this.worker.request('sweep', this.life, cutoff);
  }

  close(): Promise<void> {
    return this.worker.close();
  }
}
