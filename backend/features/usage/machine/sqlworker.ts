// The SQLite reads of other programs' databases (OpenCode's, Antigravity's)
// run in a worker thread, so that nothing they wait for holds the node's
// one thread: SQLite opens a database and its write-ahead log and index by
// name and reads them synchronously, so a FIFO or device swapped in at one
// of those names after it was looked at, a mount that stopped answering or
// a long read would otherwise stall every core's terminals. The node waits
// for each answer at most requestMs (and no longer than its request
// lasts); past that it ends the worker and the read fails (unreadable).
// A thread blocked in a system call ends only once the call returns: until
// then it is held, not the node. The node's exit ends it with the process.
//
// The worker is a script of its own, without imports but node:sqlite,
// started from a Blob: it needs no entrypoint of its own in the compiled
// executable. It opens a database read-only (immutable when asked), runs
// the statements it is sent and answers their rows in batches of at most
// 256 rows or about 1 MiB, the next batch when it is asked for. A worker is
// owned by one scan (or one read), which ends it.

/** The worker's script. */
const SOURCE = `
const { DatabaseSync } = require('node:sqlite');
let db = null;
let it = null;
const size = (r) => {
  let n = 0;
  for (const k in r) {
    const v = r[k];
    n += typeof v === 'string' ? v.length : v && typeof v.byteLength === 'number' ? v.byteLength : 8;
  }
  return n;
};
const batch = () => {
  const rows = [];
  let bytes = 0;
  for (;;) {
    const n = it.next();
    if (n.done) {
      it = null;
      return { ok: true, rows, done: true };
    }
    rows.push(n.value);
    bytes += size(n.value);
    if (rows.length >= 256 || bytes >= 1048576) return { ok: true, rows, done: false };
  }
};
const close = () => {
  if (it && it.return) it.return();
  it = null;
  if (db) db.close();
  db = null;
};
self.onmessage = (ev) => {
  const m = ev.data;
  let out;
  try {
    if (m.op === 'open') {
      close();
      db = new DatabaseSync(m.url ? new URL(m.url) : m.path, { readOnly: true });
      db.exec('PRAGMA query_only = 1');
      out = { ok: true };
    } else if (m.op === 'all') out = { ok: true, rows: db.prepare(m.sql).all(...m.params), done: true };
    else if (m.op === 'query') {
      it = db.prepare(m.sql).iterate(...m.params);
      out = batch();
    } else if (m.op === 'more') out = batch();
    else if (m.op === 'close') {
      close();
      out = { ok: true };
    } else out = { ok: false, errcode: -1, message: 'unknown op' };
  } catch (e) {
    out = { ok: false, errcode: e && typeof e.errcode === 'number' ? e.errcode : -1 };
  }
  postMessage(out);
};
`;

export type SQLValue = null | number | bigint | string | Uint8Array;
export type SQLRow = Record<string, SQLValue>;

/** What the node asks the worker. */
export type SQLRequest =
  | { op: 'open'; path?: string; url?: string }
  | { op: 'all' | 'query'; sql: string; params: (string | number)[] }
  | { op: 'more' }
  | { op: 'close' };

/** Its answer: rows (and whether the statement is done), or SQLite's
 * error code (-1: none, or not an error of SQLite's; -2: the worker did not
 * answer in time, or the request ended). */
export type SQLReply = { ok: true; rows?: SQLRow[]; done?: boolean } | { ok: false; errcode: number };

/** No answer in time, or the request ended: the worker was ended. */
export const NO_ANSWER = -2;

let source: string | undefined;
/** The worker's script as a URL (one per process). */
const sourceURL = () => (source ??= URL.createObjectURL(new Blob([SOURCE], { type: 'application/javascript' })));

/** A worker thread that runs SQLite for one owner, started at its first
 * request; close() ends it. */
export class SQLiteWorker {
  private w: Worker | null = null;
  /** Settles the request the worker is answering. */
  private pending: ((r: SQLReply) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly ms: number;

  constructor(ms: number) {
    this.ms = ms;
  }

  /** Sends m after the request before it was answered; the worker's
   * answer, or NO_ANSWER (the worker then ended) after ms or once signal
   * ends. */
  request(m: SQLRequest, signal: AbortSignal): Promise<SQLReply> {
    const p = this.chain.then(() => this.send(m, signal));
    this.chain = p.catch(() => {});
    return p;
  }

  private send(m: SQLRequest, signal: AbortSignal): Promise<SQLReply> {
    // A worker ended has nothing open to close.
    if (m.op === 'close' && !this.w) return Promise.resolve({ ok: true });
    if (signal.aborted) return Promise.resolve({ ok: false, errcode: NO_ANSWER });
    const w = (this.w ??= this.start());
    return new Promise((resolve) => {
      const stop = () => this.fail();
      const timer = setTimeout(stop, this.ms);
      signal.addEventListener('abort', stop, { once: true });
      this.pending = (r) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        this.pending = null;
        resolve(r);
      };
      w.postMessage(m);
    });
  }

  private start(): Worker {
    const w = new Worker(sourceURL());
    w.onmessage = (ev: MessageEvent<SQLReply>) => this.pending?.(ev.data);
    w.onerror = () => this.fail();
    // The node's exit is not held by a worker.
    (w as unknown as { unref?: () => void }).unref?.();
    return w;
  }

  /** Ends the worker (its database closes with it); a request waiting gets
   * NO_ANSWER. */
  private fail(): void {
    this.w?.terminate();
    this.w = null;
    this.pending?.({ ok: false, errcode: NO_ANSWER });
  }

  /** Ends the worker, as its owner is done. */
  close(): void {
    this.fail();
  }

  /** Whether a worker thread runs (tests). */
  get running(): boolean {
    return this.w !== null;
  }
}
