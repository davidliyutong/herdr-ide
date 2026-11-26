// Runs synchronous state reads and writes on a dedicated thread. A caller
// can stop waiting while SQLite is blocked. Cancelled work occupies its
// slot until the worker returns, bounding the queue during a stall.
import type { Worker } from 'node:worker_threads';
import { parentPort } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { Fail } from './fail.ts';
import type { Logger } from './log.ts';

type Operations = Record<string, (signal: AbortSignal, ...args: never[]) => unknown>;
type Args<F> = F extends (signal: AbortSignal, ...args: infer A) => unknown ? A : never;

type WorkerLog = { log: string };

export const stateLog: Logger = (log) => parentPort!.postMessage({ log } satisfies WorkerLog);

type Request = { id: number; op: string; args: unknown[] } | { id: number; cancel: true };
type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; code: string; status: number; message: string };

export class StateWorker<M extends Operations> {
  private thread: Worker | null = null;
  private next = 0;
  private readonly pending = new Map<number, (r: Reply | Error) => void>();
  private closed = false;
  private readonly openWorker: () => Worker;
  private readonly onLog?: Logger;

  constructor(openWorker: () => Worker, onLog?: Logger) {
    this.openWorker = openWorker;
    this.onLog = onLog;
  }

  async request<K extends keyof M & string>(op: K, signal: AbortSignal, ...args: Args<M[K]>): Promise<Awaited<ReturnType<M[K]>>> {
    signal.throwIfAborted();
    if (this.closed) throw new Fail('io', 500, 'the state worker has closed');
    if (this.pending.size >= 16) throw new Fail('busy', 409, 'the state worker is busy');
    const worker = (this.thread ??= this.start());
    const id = ++this.next;
    return new Promise<Awaited<ReturnType<M[K]>>>((resolve, reject) => {
      const abort = () => {
        this.pending.set(id, () => {});
        reject(signal.reason);
        try {
          worker.postMessage({ id, cancel: true } satisfies Request);
        } catch {
          // The worker has already stopped.
        }
      };
      const done = (r: Reply | Error) => {
        signal.removeEventListener('abort', abort);
        if (r instanceof Error) reject(r);
        else if (r.ok) resolve(r.value as Awaited<ReturnType<M[K]>>);
        else reject(new Fail(r.code, r.status, r.message));
      };
      this.pending.set(id, done);
      signal.addEventListener('abort', abort, { once: true });
      try {
        worker.postMessage({ id, op, args } satisfies Request);
      } catch (e) {
        this.pending.delete(id);
        done(e as Error);
      }
    });
  }

  private start(): Worker {
    const worker = this.openWorker();
    worker.on('message', (r: Reply | WorkerLog) => {
      if ('log' in r) {
        this.onLog?.(r.log);
        return;
      }
      const done = this.pending.get(r.id);
      this.pending.delete(r.id);
      done?.(r);
    });
    const failed = () => {
      if (this.thread === worker) void this.end(new Fail('io', 500, 'the state worker stopped'))?.catch(() => {});
    };
    worker.on('error', failed).on('exit', failed);
    worker.unref();
    return worker;
  }

  private end(error: Error): Promise<number> | undefined {
    const worker = this.thread;
    this.thread = null;
    for (const done of this.pending.values()) done(error);
    this.pending.clear();
    return worker?.terminate();
  }

  async close(): Promise<void> {
    this.closed = true;
    const ended = this.end(new Fail('io', 500, 'the state worker has closed'));
    // Termination can wait on a thread in a filesystem syscall.
    if (ended) await Promise.race([ended, delay(250, undefined, { ref: false })]);
  }
}

/** Runs the typed operations sent by the node. Async jobs can yield to a
 * cancellation or another job, as they do when run directly. */
export function serveStateWorker(ops: Operations): void {
  const port = parentPort!;
  const active = new Map<number, AbortController>();
  port.on('message', async (m: Request) => {
    if ('cancel' in m) {
      active.get(m.id)?.abort();
      return;
    }
    const ac = new AbortController();
    active.set(m.id, ac);
    try {
      const run = ops[m.op] as (signal: AbortSignal, ...args: unknown[]) => unknown;
      const value = await run(ac.signal, ...m.args);
      port.postMessage({ id: m.id, ok: true, value } satisfies Reply);
    } catch (e) {
      const err = e instanceof Fail ? e : new Fail('io', 500, 'the state worker could not complete the operation');
      port.postMessage({ id: m.id, ok: false, code: err.code, status: err.status, message: err.message } satisfies Reply);
    } finally {
      active.delete(m.id);
    }
  });
}
