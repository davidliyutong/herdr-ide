// Off-main-thread read-only SQLite worker for external agent databases (such as
// Antigravity's conversation_summaries.db and conversations/<id>.db).
//
// External SQLite databases open their main file and WAL/SHM side files
// synchronously by path; running those reads in a dedicated worker thread keeps
// slow mounts, large scans, or a TOCTOU-swapped FIFO from stalling the single-
// threaded machine node event loop. Each request is bounded by a timeout and
// caller AbortSignal; exceeding either terminates the worker immediately.
//
// The worker is started from an inline Blob URL (zero extra compiled bundle
// entrypoints) and auto-terminates after a short idle period so tests and
// long-lived resolvers never leak threads.

const SOURCE = `
const { DatabaseSync } = require('node:sqlite');
let db = null;
const close = () => {
  if (db) {
    try { db.close(); } catch {}
    db = null;
  }
};
self.onmessage = (ev) => {
  const m = ev.data;
  let out;
  try {
    if (m.op === 'open') {
      close();
      db = new DatabaseSync(m.url ? new URL(m.url) : m.path, { readOnly: true });
      db.exec('PRAGMA query_only = 1; PRAGMA busy_timeout = 0;');
      out = { ok: true };
    } else if (m.op === 'all') {
      if (!db) out = { ok: false, errcode: -1 };
      else out = { ok: true, rows: db.prepare(m.sql).all(...m.params) };
    } else if (m.op === 'close') {
      close();
      out = { ok: true };
    } else {
      out = { ok: false, errcode: -1 };
    }
  } catch (e) {
    out = { ok: false, errcode: e && typeof e.errcode === 'number' ? e.errcode : -1 };
  }
  postMessage(out);
};
`;

export type SQLValue = null | number | bigint | string | Uint8Array;
export type SQLRow = Record<string, SQLValue>;

export type SQLRequest =
  { op: 'open'; path?: string; url?: string } | { op: 'all'; sql: string; params: (string | number)[] } | { op: 'close' };

export type SQLReply = { ok: true; rows?: SQLRow[] } | { ok: false; errcode: number };

export const NO_ANSWER = -2;

let sourceUrl: string | undefined;
const workerSourceUrl = (): string => (sourceUrl ??= URL.createObjectURL(new Blob([SOURCE], { type: 'application/javascript' })));

/** Serialized, bounded, auto-idling read-only SQLite worker thread. */
export class ReadOnlySQLiteWorker {
  private w: Worker | null = null;
  private pending: ((r: SQLReply) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly timeoutMs: number;
  private readonly idleCloseMs: number;

  constructor(timeoutMs = 2000, idleCloseMs = 10_000) {
    this.timeoutMs = timeoutMs;
    this.idleCloseMs = idleCloseMs;
  }

  /** Runs an exclusive sequence of operations (open -> queries -> close) on
   * this worker so concurrent callers never interleave open databases. */
  async withDb<T>(
    open: { path?: string; url?: string },
    fn: (all: (sql: string, params?: (string | number)[]) => Promise<SQLRow[] | null>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    if (this.closed || signal?.aborted) return null;
    const run = this.chain.then(async (): Promise<T | null> => {
      if (this.closed || signal?.aborted) return null;
      this.clearIdle();
      const opened = await this.send({ op: 'open', ...open }, signal);
      if (!opened.ok) {
        this.armIdle();
        return null;
      }
      try {
        return await fn(async (sql, params = []) => {
          if (this.closed) return null;
          const r = await this.send({ op: 'all', sql, params }, signal);
          return r.ok ? (r.rows ?? []) : null;
        });
      } finally {
        if (!this.closed && this.w) await this.send({ op: 'close' }, undefined).catch(() => {});
        this.armIdle();
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private send(m: SQLRequest, signal?: AbortSignal): Promise<SQLReply> {
    if (this.closed) return Promise.resolve({ ok: false, errcode: NO_ANSWER });
    if (m.op === 'close' && !this.w) return Promise.resolve({ ok: true });
    if (signal?.aborted) return Promise.resolve({ ok: false, errcode: NO_ANSWER });
    const w = (this.w ??= this.start());
    return new Promise((resolve) => {
      const stop = () => this.fail();
      const timer = setTimeout(stop, this.timeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      this.pending = (r) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        this.pending = null;
        resolve(r);
      };
      w.postMessage(m);
    });
  }

  private start(): Worker {
    const w = new Worker(workerSourceUrl());
    w.onmessage = (ev: MessageEvent<SQLReply>) => this.pending?.(ev.data);
    w.onerror = () => this.fail();
    (w as unknown as { unref?: () => void }).unref?.();
    return w;
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.closed || !this.w || this.idleCloseMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.pending) this.fail();
    }, this.idleCloseMs);
    this.idleTimer.unref?.();
  }

  private fail(): void {
    this.clearIdle();
    this.w?.terminate();
    this.w = null;
    this.pending?.({ ok: false, errcode: NO_ANSWER });
  }

  close(): void {
    this.closed = true;
    this.fail();
  }

  get running(): boolean {
    return this.w !== null;
  }
}
