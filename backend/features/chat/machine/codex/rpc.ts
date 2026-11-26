// JSON-RPC to a Codex app-server on its standard input and output: one
// message per line, without the jsonrpc member, the client's requests
// numbered from 1. The app-server numbers its own requests from 0, so a
// line with a method is its request (or notification), never an answer.
//
// The framing is the few lines it takes rather than a library's: Codex's
// dialect has no jsonrpc member, which the general libraries require or
// add (json-rpc-2.0 refuses its messages, vscode-jsonrpc writes the member
// and frames with headers), a line longer than chatproto's MAX_LINE is
// passed over to its end and the connection goes on, and every message is
// handed on synchronously in the order of the app-server's output: a
// notification and a request reach the Handler before any line after them
// is read on, and a call's answer settles it only after everything the
// app-server wrote before the answer was handed on.
import type { Logger } from '#shared/lib/log.ts';
import { MAX_LINE } from '#shared/proto/chatproto/index.ts';
import type { ClientNotificationMethod, ClientRequests } from './appserver.gen.ts';

/** The JSON-RPC code of an unknown method, which the adapter answers the
 * requests it does not serve with. */
export const METHOD_NOT_FOUND = -32601;

/** An error the app-server answered a request with. Codex answers every
 * error with -32600 and a message (unknown methods, bad parameters, unknown
 * threads alike). */
export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'RpcError';
  }
}

/** A call whose answer cannot come: the connection ended. */
export class ClosedError extends Error {
  constructor() {
    super('codex: the app-server is gone');
    this.name = 'ClosedError';
  }
}

/** A call given up because its signal ended. */
export class AbortedError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super('codex: the call was given up');
    this.reason = reason;
    this.name = 'AbortedError';
  }
}

/** A request of the app-server, answered once. */
export class ServerRequest {
  /** The id as the app-server sent it, and as text (serverRequest/resolved
   * names a request by it). */
  readonly id: unknown;
  readonly key: string;
  readonly method: string;
  readonly params: unknown;
  private readonly conn: Conn;
  private answered = false;

  constructor(conn: Conn, id: unknown, method: string, params: unknown) {
    this.conn = conn;
    this.id = id;
    this.key = requestKey(id);
    this.method = method;
    this.params = params;
  }

  reply(result: unknown): void {
    if (this.answered) return;
    this.answered = true;
    this.conn.write({ id: this.id, result });
  }

  fail(code: number, message: string): void {
    if (this.answered) return;
    this.answered = true;
    this.conn.write({ id: this.id, error: { code, message } });
  }
}

/** The text of a request id, as serverRequest/resolved names it (a number
 * or a string). */
export const requestKey = (id: unknown): string => JSON.stringify(id) ?? '';

/** What the app-server sends on its own. Both are called in the order of
 * its output, before the next line is read, and must not wait: a request is
 * answered later through its ServerRequest. */
export interface Handler {
  /** at is the app-server's emittedAtMs, else when the line was read. */
  notification(method: string, params: unknown, at: number): void;
  request(r: ServerRequest): void;
}

/** The pipes of the app-server's process. */
export interface Pipes {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** A connection to an app-server process. It does not own the process:
 * whoever started it ends it. */
export class Conn {
  /** Settles once the reader ended: the app-server's output closed or
   * broke, or close(). */
  readonly closed: Promise<void>;
  /** Lines that are no JSON-RPC message, longer than MAX_LINE, answers to
   * requests not made, and notifications without a mapping (passedOver), by
   * method. */
  malformed = 0;
  oversized = 0;
  strayReplies = 0;
  private readonly unknown = new Map<string, number>();
  private readonly pending = new Map<number, Pending>();
  private next = 0;
  private done = false;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
  private readonly h: Handler;
  private readonly logger: Logger;
  private readonly maxLine: number;

  constructor(pipes: Pipes, h: Handler, logger: Logger, maxLine = MAX_LINE) {
    this.h = h;
    this.logger = logger;
    this.maxLine = maxLine;
    this.writer = pipes.stdin.getWriter();
    this.writer.closed.catch(() => {});
    this.reader = pipes.stdout.getReader();
    this.closed = this.read();
  }

  /** Whether the connection ended. */
  get ended(): boolean {
    return this.done;
  }

  private logf(line: string): void {
    this.logger(`codex: ${line}`);
  }

  /** Reads the app-server's lines until its output ends. */
  private async read(): Promise<void> {
    let parts: Buffer[] = [];
    let size = 0;
    let skipping = false;
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done || !value) break;
        let chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        for (;;) {
          const nl = chunk.indexOf(0x0a);
          const piece = nl < 0 ? chunk : chunk.subarray(0, nl);
          if (!skipping) {
            if (size + piece.length > this.maxLine) {
              this.oversized++;
              this.logf(`passed over a line longer than ${this.maxLine} bytes`);
              parts = [];
              size = 0;
              skipping = true;
            } else if (piece.length > 0) {
              parts.push(Buffer.from(piece));
              size += piece.length;
            }
          }
          if (nl < 0) break;
          if (!skipping) {
            const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
            parts = [];
            size = 0;
            this.dispatch(line);
          }
          skipping = false;
          chunk = chunk.subarray(nl + 1);
        }
      }
    } catch {
      // The output broke: the connection ends as if it closed.
    } finally {
      this.end();
    }
  }

  /** Ends the connection: the calls that wait fail with ClosedError. */
  private end(): void {
    if (this.done) return;
    this.done = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(new ClosedError());
    this.reader.cancel().catch(() => {});
  }

  /** Stops reading and fails the calls that wait; the app-server's input
   * stays open (its process's end closes it). */
  close(): void {
    this.end();
  }

  private dispatch(line: Buffer): void {
    const text = line.toString('utf8');
    if (text.trim() === '') return;
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch (e) {
      if (++this.malformed === 1) this.logf(`passed over a line that is no JSON-RPC message: ${(e as Error).message}`);
      return;
    }
    if (typeof m !== 'object' || m === null || Array.isArray(m)) {
      if (++this.malformed === 1) this.logf('passed over a line that is no JSON-RPC message');
      return;
    }
    const w = m as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown; emittedAtMs?: unknown };
    const hasID = w.id !== undefined && w.id !== null;
    if (typeof w.method === 'string' && w.method !== '') {
      try {
        if (hasID) this.h.request(new ServerRequest(this, w.id, w.method, w.params));
        else this.h.notification(w.method, w.params, typeof w.emittedAtMs === 'number' && w.emittedAtMs > 0 ? w.emittedAtMs : Date.now());
      } catch (e) {
        // A message the session could not read is passed over.
        this.passedOver(`${w.method} (${(e as Error).message})`);
      }
      return;
    }
    if (!hasID) {
      if (++this.malformed === 1) this.logf('passed over a line that is no JSON-RPC message');
      return;
    }
    const p = typeof w.id === 'number' ? this.pending.get(w.id) : undefined;
    if (!p) {
      this.strayReplies++;
      return;
    }
    this.pending.delete(w.id as number);
    if (w.error !== undefined && w.error !== null) {
      const e = w.error as { code?: unknown; message?: unknown };
      p.reject(new RpcError(typeof e.code === 'number' ? e.code : 0, typeof e.message === 'string' ? e.message : ''));
    } else {
      p.resolve(w.result);
    }
  }

  /** Counts a notification the session has no mapping for, and logs its
   * method the first time. */
  passedOver(method: string): void {
    const k = this.unknown.size >= 256 && !this.unknown.has(method) ? '(others)' : method;
    const n = (this.unknown.get(k) ?? 0) + 1;
    this.unknown.set(k, n);
    if (n === 1) this.logf(`passing over the notification ${k}`);
  }

  /** How many notifications were passed over. */
  unknownCount(): number {
    let n = 0;
    for (const v of this.unknown.values()) n += v;
    return n;
  }

  /** Writes one message; its failure is the end of the app-server's input,
   * which the reader's end tells. */
  write(v: unknown): void {
    if (this.done) return;
    this.writer.write(Buffer.from(JSON.stringify(v) + '\n')).catch(() => {});
  }

  /** Sends a request and resolves with the app-server's result, as it sent
   * it. Rejects with RpcError for its error, ClosedError when the
   * connection ends first, AbortedError when signal ends. The request is
   * written before call returns. */
  call<M extends keyof ClientRequests>(
    method: M,
    params: ClientRequests[M]['params'],
    signal?: AbortSignal,
  ): Promise<ClientRequests[M]['result']> {
    if (this.done) return Promise.reject(new ClosedError());
    if (signal?.aborted) return Promise.reject(new AbortedError(signal.reason));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const aborted = () => {
        this.pending.delete(id);
        reject(new AbortedError(signal!.reason));
      };
      signal?.addEventListener('abort', aborted, { once: true });
      this.pending.set(id, {
        method,
        resolve: (v) => {
          signal?.removeEventListener('abort', aborted);
          resolve(v as ClientRequests[M]['result']);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', aborted);
          reject(e);
        },
      });
      this.write({ id, method, params });
    });
  }

  /** Sends a notification. */
  notify(method: ClientNotificationMethod): void {
    this.write({ method });
  }
}
