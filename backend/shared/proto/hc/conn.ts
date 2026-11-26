// A framed connection to a herdr-core. Calls run side by side; streams and
// event subscriptions share the connection and end with it.
import type { Duplex } from 'node:stream';
import { EOFError, Reader } from '#shared/lib/streamio.ts';
import {
  HCError,
  type Attached,
  type AttachParams,
  type Display,
  type Exit,
  type Hello,
  type Notification,
  type SubscribeParams,
  type Subscribed,
} from './types.ts';
import { GENERATION, Kind, MAX_HELLO, MAX_PAYLOAD, MAX_QUEUED, encodeFrame, readFrame, u32le } from './wire.ts';

const MAX_PENDING_CALLS = 1024;

/** The error of calls and streams of a connection that was closed here. */
export const ERR_CLOSED = new Error('hc: connection closed');

interface RPCMessage {
  id?: number | null;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: { kind?: string; hint?: string } };
}

const rpcError = (e: NonNullable<RPCMessage['error']>) => new HCError(e.code, e.message, e.data?.kind ?? '', e.data?.hint ?? '');

interface Call {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  /** For calls whose result names a channel: registers that channel. The
   * read loop runs it before it reads the next frame, as the core sends the
   * channel's frames right behind the reply. */
  open?: (result: unknown) => number;
  /** The caller gave up; a channel the reply opens is closed. */
  abandoned?: boolean;
}

function aborted(signal?: AbortSignal): Error {
  return (signal?.reason as Error) ?? new DOMException('This operation was aborted', 'AbortError');
}

/** Says hello on rw. framed: the core switches to framed mode. */
async function handshake(rw: Duplex, framed: boolean): Promise<{ hello: Hello; reader: Reader }> {
  rw.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'hello', params: { framed, generation: GENERATION } }) + '\n');
  const reader = new Reader(rw);
  let line: string;
  try {
    line = await reader.line(MAX_HELLO);
  } catch (e) {
    if ((e as Error).message === 'line too long') throw new Error(`hc: hello: reply exceeds ${MAX_HELLO} bytes`);
    if (e instanceof EOFError) throw new Error('hc: hello: unexpected EOF');
    throw new Error(`hc: hello: ${(e as Error).message}`);
  }
  let m: RPCMessage;
  try {
    m = JSON.parse(line);
  } catch (e) {
    throw new Error(`hc: hello: ${(e as Error).message}`);
  }
  if (m.error) throw rpcError(m.error);
  const h = m.result as Hello | undefined;
  if (!h || typeof h !== 'object') throw new Error('hc: hello: no result');
  if (h.generation !== GENERATION) throw new Error(`hc: core speaks protocol generation ${h.generation}, not ${GENERATION}`);
  if (framed && !h.framed) throw new Error('hc: core did not switch to framed mode');
  return { hello: h, reader };
}

/** Runs f, destroying rw when signal aborts first. */
async function withSignal<T>(rw: Duplex, signal: AbortSignal | undefined, f: () => Promise<T>): Promise<T> {
  if (signal?.aborted) {
    rw.destroy();
    throw aborted(signal);
  }
  const stop = () => rw.destroy();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    return await f();
  } catch (e) {
    if (signal?.aborted) throw aborted(signal);
    throw e;
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

/** Asks the core on rw who it is and closes rw: whether a core answers on a
 * socket, and which version. */
export async function probe(rw: Duplex, signal?: AbortSignal): Promise<Hello> {
  try {
    return (await withSignal(rw, signal, () => handshake(rw, false))).hello;
  } finally {
    rw.destroy();
  }
}

export class Conn {
  private nextID = 1;
  private calls: Map<number, Call> | null = new Map();
  private chans: Map<number, Queue> | null = new Map();
  private failure: Error | null = null;
  private doneWaiters: Array<(err: Error) => void> = [];
  private readonly rw: Duplex;
  private readonly reader: Reader;

  private constructor(rw: Duplex, reader: Reader) {
    this.rw = rw;
    this.reader = reader;
    rw.on('error', (e) => this.fail(e));
    void this.readLoop();
  }

  /** Says hello on rw, switches it to framed mode and takes rw over: close
   * closes it. The core must speak this package's generation. */
  static async dial(rw: Duplex, signal?: AbortSignal): Promise<{ conn: Conn; hello: Hello }> {
    let hs: { hello: Hello; reader: Reader };
    try {
      hs = await withSignal(rw, signal, () => handshake(rw, true));
    } catch (e) {
      rw.destroy();
      throw e;
    }
    return { conn: new Conn(rw, hs.reader), hello: hs.hello };
  }

  /** Why the connection ended; null while it is open. */
  get err(): Error | null {
    return this.failure;
  }

  /** Resolves with the reason once the connection has ended. */
  done(): Promise<Error> {
    if (this.failure) return Promise.resolve(this.failure);
    return new Promise((r) => this.doneWaiters.push(r));
  }

  /** Ends the connection and everything on it. */
  close(): void {
    this.fail(ERR_CLOSED);
  }

  /** @internal */
  fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    const calls = this.calls!;
    const chans = this.chans!;
    this.calls = this.chans = null;
    this.rw.destroy();
    for (const k of calls.values()) k.reject(err);
    for (const q of chans.values()) q.end(null, err);
    for (const w of this.doneWaiters) w(err);
    this.doneWaiters = [];
  }

  /** Writes one frame; throws once the connection has ended. */
  send(channel: number, kind: number, payload?: Uint8Array): void {
    if (payload && payload.length > MAX_PAYLOAD) throw new Error(`hc: frame of ${payload.length} bytes exceeds ${MAX_PAYLOAD}`);
    if (this.failure) throw this.failure;
    this.rw.write(encodeFrame(channel, kind, payload));
  }

  private async readLoop(): Promise<void> {
    try {
      for (;;) {
        const f = await readFrame(this.reader);
        if (f === null) throw new EOFError();
        if (this.failure) return;
        if (f.channel === 0) {
          if (f.kind === Kind.Data) this.reply(f.payload);
          continue;
        }
        const q = this.chans!.get(f.channel);
        if (!q) continue; // a stream closed here; the core had more on the way
        if (f.kind === Kind.Close) this.chans!.delete(f.channel);
        switch (f.kind) {
          case Kind.Data:
          case Kind.Resize:
            if (!q.push({ kind: f.kind, payload: f.payload })) {
              this.fail(new Error(`hc: channel ${f.channel}: the core sent more than its credit`));
              return;
            }
            break;
          case Kind.Close: {
            let exit: Exit | null = null;
            try {
              if (f.payload.length) exit = JSON.parse(f.payload.toString('utf8'));
            } catch {
              // empty when it answers our close
            }
            q.end(exit, null);
            break;
          }
        }
      }
    } catch (e) {
      this.fail(e as Error);
    }
  }

  /** Completes the call a message on channel 0 answers. Requests and
   * notifications from the core (it sends none to a client that did not
   * offer methods in its hello) are ignored. */
  private reply(payload: Buffer): void {
    let m: RPCMessage;
    try {
      m = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    if (m.id === undefined || m.id === null || m.method) return;
    const k = this.calls!.get(m.id);
    if (!k) return;
    this.calls!.delete(m.id);
    if (m.error) return k.reject(rpcError(m.error));
    if (k.open) {
      const channel = k.open(m.result);
      if (k.abandoned && channel !== 0) {
        this.chans!.delete(channel);
        try {
          this.send(channel, Kind.Close);
        } catch {
          // the connection ended
        }
      }
    }
    k.resolve(m.result);
  }

  /** Runs method; errors from the core are HCError. */
  call<T = unknown>(method: string, params?: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
    return this.callWith(method, params, opts.signal) as Promise<T>;
  }

  private callWith(method: string, params: unknown, signal: AbortSignal | undefined, open?: (result: unknown) => number): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(aborted(signal));
    if (this.calls!.size >= MAX_PENDING_CALLS) return Promise.reject(new Error('hc: too many pending calls'));
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const k = this.calls?.get(id);
        if (!k) return; // answered at the same moment
        done();
        if (open)
          k.abandoned = true; // its reply still has to close the channel
        else this.calls!.delete(id);
        try {
          this.send(0, Kind.Data, Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })));
        } catch {
          // the connection ended
        }
        reject(aborted(signal));
      };
      const done = () => signal?.removeEventListener('abort', onAbort);
      this.calls!.set(id, {
        open,
        resolve: (r) => {
          done();
          resolve(r);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.send(0, Kind.Data, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })));
      } catch (e) {
        this.calls?.delete(id);
        done();
        reject(e as Error);
      }
    });
  }

  /** Adds the queue of a channel the core opened. */
  private register(channel: number, q: Queue): void {
    this.chans?.set(channel, q);
  }

  /** Tells the core a channel is over and drops what still arrives on it. */
  closeChannel(channel: number, q: Queue): void {
    const open = this.chans?.has(channel) ?? false;
    this.chans?.delete(channel);
    q.end(null, ERR_CLOSED);
    if (open)
      try {
        this.send(channel, Kind.Close);
      } catch {
        // the connection ended
      }
  }

  private channelOf(q: Queue): (raw: unknown) => number {
    return (raw) => {
      const channel = (raw as { channel?: number } | null)?.channel;
      if (typeof channel !== 'number' || channel === 0) return 0;
      this.register(channel, q);
      return channel;
    };
  }

  /** Opens a stream to a live terminal. */
  async attach(p: AttachParams, opts: { signal?: AbortSignal } = {}): Promise<{ stream: Stream; attached: Attached }> {
    const q = new Queue();
    const res = (await this.callWith('terminal.attach', p, opts.signal, this.channelOf(q))) as Attached;
    if (!res?.channel) throw new Error('hc: terminal.attach: reply without a channel');
    return { stream: new Stream(this, res.channel, q, !!res.automatic_input), attached: res };
  }

  /** The matching terminals and the events after them. Documents are not in
   * the snapshot: read them after subscribing, after a "missed" and after
   * reconnecting. Terminal records keep the fields this package does not know. */
  async subscribe(p: SubscribeParams, opts: { signal?: AbortSignal } = {}): Promise<{ events: Events; subscribed: Subscribed }> {
    const q = new Queue();
    const res = (await this.callWith('events.subscribe', p, opts.signal, this.channelOf(q))) as Subscribed;
    if (!res?.channel) throw new Error('hc: events.subscribe: reply without a channel');
    return { events: new Events(this, res.channel, q), subscribed: res };
  }
}

interface Item {
  kind: number;
  payload: Buffer;
}

/** The frames of one channel until they are received. */
export class Queue {
  private items: Item[] = [];
  private bytes = 0;
  private discarding = false;
  exit: Exit | null = null;
  /** Set once the channel is over: null for the core's close (EOF). */
  ended: { err: Error | null } | null = null;
  private waiters: Array<() => void> = [];

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Queues a frame; false when the channel holds more than a core that
   * honors credit can have sent. */
  push(it: Item): boolean {
    if (this.ended) return true;
    if (this.bytes + it.payload.length > MAX_QUEUED) return false;
    this.bytes += it.payload.length;
    if (this.discarding) return true;
    this.items.push(it);
    this.wake();
    return true;
  }

  /** Keep accounting for received credit without storing frames. */
  discard(): void {
    this.discarding = true;
    this.items = [];
  }

  /** Marks the channel over. What is queued is still received first when
   * the core ended it (err null). */
  end(exit: Exit | null, err: Error | null): void {
    if (this.ended) return;
    this.exit = exit;
    this.ended = { err };
    if (err) {
      this.items = [];
      this.bytes = 0;
    }
    this.wake();
  }

  /** The next frame; null once the core ended the channel; throws the
   * error it ended with otherwise. */
  async pop(signal?: AbortSignal): Promise<Item | null> {
    for (;;) {
      const it = this.items.shift();
      if (it) {
        this.bytes -= it.payload.length;
        return it;
      }
      if (this.ended) {
        if (this.ended.err) throw this.ended.err;
        return null;
      }
      if (signal?.aborted) throw aborted(signal);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== wake);
          reject(aborted(signal));
        };
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        this.waiters.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
}

/** One message of a stream: output bytes, or the terminal's new grid
 * (cols and rows, for an attach with resize notifications), which applies
 * before the output that follows it. */
export type Output = { data: Buffer } | { cols: number; rows: number };

/** An attached terminal: the first paint and then the program's raw output
 * one way, input the other. */
export class Stream {
  private readonly c: Conn;
  readonly channel: number;
  private readonly q: Queue;
  /** The whole path takes automatic input as its own frame kind. */
  readonly automatic: boolean;

  constructor(c: Conn, channel: number, q: Queue, automatic: boolean) {
    this.c = c;
    this.channel = channel;
    this.q = q;
    this.automatic = automatic;
  }

  /** The next output; null once the core has closed the stream (exit says
   * why) and everything before was received. The bytes count against the
   * stream's credit until ack returns them. */
  async recv(signal?: AbortSignal): Promise<Output | null> {
    for (;;) {
      const it = await this.q.pop(signal);
      if (!it) return null;
      if (it.kind === Kind.Data) return { data: it.payload };
      if (it.payload.length === 4) return { cols: it.payload.readUInt16LE(0), rows: it.payload.readUInt16LE(2) };
    }
  }

  /** Returns the credit of n output bytes that were passed on, so the core
   * sends as fast as the slowest hop takes them. */
  ack(n: number): void {
    if (n > 0) this.c.send(this.channel, Kind.Credit, u32le(n));
  }

  /** Keeps a size-holding viewer attached without buffering or crediting its output. */
  discardOutput(): void {
    this.q.discard();
  }

  /** How the program ended, once recv returned null; null before, and when
   * the stream ended for another reason. */
  exit(): Exit | null {
    return this.q.exit?.reason ? this.q.exit : null;
  }

  /** What the person typed, pasted or did with the mouse, encoded for the
   * program's modes by the viewer: the core never encodes keys. */
  write(p: Uint8Array): void {
    this.writeKind(Kind.Data, p);
  }

  /** Bytes the viewer's terminal produced by itself (answers to the
   * program's queries), which do not count as the person's activity; sent
   * as typed bytes on a path that does not know them. */
  writeAutomatic(p: Uint8Array): void {
    this.writeKind(this.automatic ? Kind.AutomaticInput : Kind.Data, p);
  }

  private writeKind(kind: number, p: Uint8Array): void {
    const chunk = 1 << 20; // the program reads a stream: any split is valid
    for (let off = 0; off < p.length; off += chunk) this.c.send(this.channel, kind, p.subarray(off, off + chunk));
  }

  /** Sets the terminal's grid as this viewer shows it. */
  resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1 || cols > 0xffff || rows > 0xffff) throw new Error(`hc: resize to ${cols}x${rows}`);
    const p = Buffer.allocUnsafe(4);
    p.writeUInt16LE(cols, 0);
    p.writeUInt16LE(rows, 2);
    this.c.send(this.channel, Kind.Resize, p);
  }

  /** Whether the viewer has the focus. */
  focus(focused: boolean): void {
    this.c.send(this.channel, Kind.Focus, Buffer.from([focused ? 1 : 0]));
  }

  /** Updates the viewer's display facts. */
  facts(d: Display): void {
    this.c.send(this.channel, Kind.Facts, Buffer.from(JSON.stringify(d)));
  }

  /** Detaches the viewer; the terminal keeps running. */
  close(): void {
    this.c.closeChannel(this.channel, this.q);
  }
}

/** An event subscription. */
export class Events {
  private buf: Buffer = Buffer.alloc(0);

  private readonly c: Conn;
  readonly channel: number;
  private readonly q: Queue;

  constructor(c: Conn, channel: number, q: Queue) {
    this.c = c;
    this.channel = channel;
    this.q = q;
  }

  /** The next notification. A heartbeat arrives every 15 s while there are
   * no events; the caller decides how long silence may last. */
  async recv(signal?: AbortSignal): Promise<Notification> {
    const line = await this.line(signal);
    let m: { method?: string; params?: Partial<Notification> };
    try {
      m = JSON.parse(line.toString('utf8'));
    } catch (e) {
      throw new Error(`hc: event: ${(e as Error).message}`);
    }
    const p = m.params ?? {};
    return {
      method: m.method ?? '',
      seq: p.seq ?? 0,
      type: p.type ?? '',
      terminal: p.terminal ?? '',
      machine: p.machine ?? '',
      data: p.data,
      terminals: p.terminals ?? null,
    };
  }

  /** The next line of the channel. Lines arrive split anywhere across
   * frames; the credit of a frame goes back when it is taken. */
  private async line(signal?: AbortSignal): Promise<Buffer> {
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        const line = this.buf.subarray(0, i);
        this.buf = this.buf.subarray(i + 1);
        if (line.toString('utf8').trim() === '') continue;
        return line;
      }
      if (this.buf.length > MAX_PAYLOAD) {
        const err = new Error(`hc: event exceeds ${MAX_PAYLOAD} bytes`);
        this.c.fail(err);
        throw err;
      }
      const it = await this.q.pop(signal);
      if (!it) throw new EOFError(true); // the core does not end a subscription
      if (it.kind !== Kind.Data) continue;
      this.buf = this.buf.length ? Buffer.concat([this.buf, it.payload]) : it.payload;
      this.c.send(this.channel, Kind.Credit, u32le(it.payload.length));
    }
  }

  /** Ends the subscription. */
  close(): void {
    this.c.closeChannel(this.channel, this.q);
  }
}
