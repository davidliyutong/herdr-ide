// yamux: the stream multiplexer between the core and an agent, speaking the
// wire protocol of hashicorp/yamux v0.1.x (its spec.md) with the same
// semantics: a stream's Close is a half-close (FIN; the closer still reads),
// the first window update rides on SYN/ACK and grows the window to
// maxStreamWindow, pings carry SYN and are answered with ACK, a stream not
// ACKed within the open timeout or a keepalive not answered closes the
// session. Node APIs only: it runs under Bun and in Electron.
import { Duplex } from 'node:stream';

const VERSION = 0;
const T_DATA = 0;
const T_WINDOW = 1;
const T_PING = 2;
const T_GOAWAY = 3;
const SYN = 1;
const ACK = 2;
const FIN = 4;
const RST = 8;
const HEADER = 12;
export const INITIAL_WINDOW = 256 * 1024;

const GOAWAY_NORMAL = 0;
const GOAWAY_PROTO = 1;

export interface Config {
  /** Window a stream grows to (hashicorp MaxStreamWindowSize). */
  maxStreamWindow: number;
  /** Streams waiting to be accepted, and SYNs in flight. */
  acceptBacklog: number;
  /** 0 disables keepalive pings. */
  keepAliveMs: number;
  /** A ping unanswered or a write blocked this long closes the session. */
  writeTimeoutMs: number;
  /** A stream not ACKed this long closes the session; 0 disables. */
  streamOpenTimeoutMs: number;
  /** A half-closed stream is forgotten after this long; 0 disables. */
  streamCloseTimeoutMs: number;
}

/** The configuration both ends use (agentproto.YamuxConfig). */
export const defaultConfig: Config = {
  maxStreamWindow: 1 << 20,
  acceptBacklog: 512,
  keepAliveMs: 15_000,
  writeTimeoutMs: 30_000,
  streamOpenTimeoutMs: 75_000,
  streamCloseTimeoutMs: 5 * 60_000,
};

export class YamuxError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
export const errSessionShutdown = () => new YamuxError('session shutdown', 'ESESSIONSHUTDOWN');
const errStreamClosed = () => new YamuxError('stream closed', 'ESTREAMCLOSED');
const errReset = () => new YamuxError('stream reset', 'ECONNRESET');
const errRemoteGoAway = () => new YamuxError('remote end is not accepting connections', 'EREMOTEGOAWAY');

type State = 'init' | 'synSent' | 'synReceived' | 'established' | 'localClose' | 'remoteClose' | 'closed' | 'reset';

function header(type: number, flags: number, id: number, length: number): Buffer {
  const b = Buffer.allocUnsafe(HEADER);
  b.writeUInt8(VERSION, 0);
  b.writeUInt8(type, 1);
  b.writeUInt16BE(flags, 2);
  b.writeUInt32BE(id, 4);
  b.writeUInt32BE(length >>> 0, 8);
  return b;
}

export class Stream extends Duplex {
  state: State;
  private recvWindow = INITIAL_WINDOW;
  private sendWindow = INITIAL_WINDOW;
  private queue: Buffer[] = [];
  private queued = 0;
  private reading = false;
  private sendWaiters: Array<() => void> = [];
  private closeTimer?: NodeJS.Timeout;
  established?: () => void;

  readonly session: Session;
  readonly id: number;

  constructor(session: Session, id: number, state: State) {
    super({ allowHalfOpen: true, readableHighWaterMark: 64 * 1024 });
    this.session = session;
    this.id = id;
    this.state = state;
  }

  // Flags for the next frame: SYN on the first of an opened stream, ACK on
  // the first of an accepted one (hashicorp sendFlags).
  private sendFlags(): number {
    if (this.state === 'init') {
      this.state = 'synSent';
      return SYN;
    }
    if (this.state === 'synReceived') {
      this.state = 'established';
      return ACK;
    }
    return 0;
  }

  /** Bytes received and not yet taken by the reader. */
  private unconsumed(): number {
    return this.queued + this.readableLength;
  }

  sendWindowUpdate(): void {
    const max = this.session.config.maxStreamWindow;
    const delta = max - this.unconsumed() - this.recvWindow;
    const flags = this.sendFlags();
    if (delta < max / 2 && flags === 0) return;
    this.recvWindow += delta;
    this.session.sendControl(header(T_WINDOW, flags, this.id, delta));
  }

  private flush(): void {
    while (this.reading && this.queue.length) {
      const b = this.queue.shift()!;
      this.queued -= b.length;
      this.reading = this.push(b);
    }
    if (!this.queue.length && this.reading && (this.state === 'remoteClose' || this.state === 'closed')) {
      this.reading = false;
      this.push(null);
    }
  }

  override _read(): void {
    this.reading = true;
    this.flush();
    if (this.state !== 'reset' && this.state !== 'closed' && this.state !== 'remoteClose') this.sendWindowUpdate();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.writeAll(chunk).then(() => cb(), cb);
  }

  private async writeAll(b: Buffer): Promise<void> {
    let off = 0;
    while (off < b.length) {
      switch (this.state) {
        case 'localClose':
        case 'closed':
          throw this.session.closed ? errSessionShutdown() : errStreamClosed();
        case 'reset':
          throw errReset();
      }
      if (this.session.closed) throw errSessionShutdown();
      if (this.sendWindow === 0) {
        await new Promise<void>((r) => this.sendWaiters.push(r));
        continue;
      }
      const n = Math.min(this.sendWindow, b.length - off);
      const flags = this.sendFlags();
      this.sendWindow -= n;
      await this.session.sendData(header(T_DATA, flags, this.id, n), b.subarray(off, off + n));
      off += n;
    }
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.closeWrite();
    cb();
  }

  /** hashicorp Close: FIN; the stream is done once both sides sent one. */
  closeWrite(): void {
    let done = false;
    switch (this.state) {
      case 'init':
      case 'synSent':
      case 'synReceived':
      case 'established':
        this.state = 'localClose';
        break;
      case 'remoteClose':
        this.state = 'closed';
        done = true;
        break;
      default:
        return;
    }
    if (!done && this.session.config.streamCloseTimeoutMs > 0)
      this.closeTimer = setTimeout(() => this.forceClose(), this.session.config.streamCloseTimeoutMs);
    // sendClose runs after the state changed, so it carries FIN alone (the
    // SYN/ACK went out with open/accept's window update).
    this.session.sendControl(header(T_WINDOW, FIN, this.id, 0));
    this.wake();
    if (done) this.session.forget(this.id);
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    clearTimeout(this.closeTimer);
    if (this.state !== 'closed' && this.state !== 'reset' && this.state !== 'localClose' && !this.session.closed) {
      // Abandoned while open: reset it so the other end stops.
      this.session.sendControl(header(T_WINDOW, RST, this.id, 0));
      this.state = 'reset';
    }
    this.session.forget(this.id);
    this.wake();
    cb(err);
  }

  private wake(): void {
    const w = this.sendWaiters;
    this.sendWaiters = [];
    for (const f of w) f();
  }

  // Frames from the other end.

  processFlags(flags: number): void {
    if (flags & ACK) {
      if (this.state === 'synSent') this.state = 'established';
      this.established?.();
      this.established = undefined;
      this.session.establish(this.id);
    }
    if (flags & FIN) {
      switch (this.state) {
        case 'synSent':
        case 'synReceived':
        case 'established':
          this.state = 'remoteClose';
          break;
        case 'localClose':
          this.state = 'closed';
          clearTimeout(this.closeTimer);
          this.session.forget(this.id);
          break;
        default:
          throw new YamuxError(`unexpected FIN in state ${this.state}`, 'EPROTO');
      }
      this.flush();
      this.wake();
    }
    if (flags & RST) {
      this.state = 'reset';
      clearTimeout(this.closeTimer);
      this.session.forget(this.id);
      this.wake();
      this.destroy(errReset());
    }
  }

  incrSendWindow(flags: number, delta: number): void {
    this.processFlags(flags);
    this.sendWindow += delta;
    this.wake();
  }

  readData(flags: number, data: Buffer): void {
    this.processFlags(flags);
    if (data.length === 0) return;
    if (data.length > this.recvWindow) throw new YamuxError(`receive window exceeded (stream ${this.id})`, 'EPROTO');
    this.recvWindow -= data.length;
    this.queue.push(data);
    this.queued += data.length;
    this.flush();
  }

  /** The session went away: reads end after what was received. */
  forceClose(): void {
    if (this.state === 'reset') return;
    this.state = 'closed';
    clearTimeout(this.closeTimer);
    this.session.forget(this.id);
    this.wake();
    this.reading = true;
    this.flush();
  }
}

export class Session {
  readonly config: Config;
  closed = false;
  private streams = new Map<number, Stream>();
  private inflight = new Set<number>();
  private synWaiters: Array<() => void> = [];
  private nextId: number;
  private acceptQueue: Stream[] = [];
  private acceptWaiters: Array<{ res: (s: Stream) => void; rej: (e: Error) => void }> = [];
  private localGoAway = false;
  private remoteGoAway = false;
  private buf: Buffer = Buffer.alloc(0);
  private drainWaiters: Array<() => void> = [];
  private blocked = false;
  private pings = new Map<number, () => void>();
  private pingId = 0;
  private keepAliveTimer?: NodeJS.Timeout;
  private closeErr?: Error;
  private closeListeners: Array<(err?: Error) => void> = [];

  readonly conn: Duplex;
  readonly client: boolean;

  constructor(conn: Duplex, client: boolean, config: Partial<Config> = {}) {
    this.conn = conn;
    this.client = client;
    this.config = { ...defaultConfig, ...config };
    if (this.config.maxStreamWindow < INITIAL_WINDOW) throw new Error('maxStreamWindow below 256 KiB');
    this.nextId = client ? 1 : 2;
    conn.on('data', (chunk: Buffer) => this.onData(chunk));
    conn.on('drain', () => {
      this.blocked = false;
      const w = this.drainWaiters;
      this.drainWaiters = [];
      for (const f of w) f();
    });
    conn.on('end', () => this.shutdown());
    conn.on('close', () => this.shutdown());
    conn.on('error', (e) => this.shutdown(e));
    if (this.config.keepAliveMs > 0) this.scheduleKeepAlive();
  }

  onClose(f: (err?: Error) => void): void {
    if (this.closed) f(this.closeErr);
    else this.closeListeners.push(f);
  }

  get numStreams(): number {
    return this.streams.size;
  }

  // Sending. Writes go to the connection in call order; data waits while
  // the connection is backed up, control frames do not.

  sendControl(h: Buffer): void {
    if (this.closed) return;
    if (!this.conn.write(h)) this.blocked = true;
  }

  async sendData(h: Buffer, body: Buffer): Promise<void> {
    while (this.blocked && !this.closed) await this.waitDrain();
    if (this.closed) throw errSessionShutdown();
    const ok = this.conn.write(Buffer.concat([h, body]));
    if (!ok) this.blocked = true;
  }

  private waitDrain(): Promise<void> {
    return new Promise((res) => {
      const t = setTimeout(() => this.shutdown(new YamuxError('connection write timeout', 'ETIMEDOUT')), this.config.writeTimeoutMs);
      this.drainWaiters.push(() => {
        clearTimeout(t);
        res();
      });
    });
  }

  // Streams.

  async open(): Promise<Stream> {
    if (this.closed) throw errSessionShutdown();
    if (this.remoteGoAway) throw errRemoteGoAway();
    while (this.inflight.size >= this.config.acceptBacklog) {
      await new Promise<void>((r) => this.synWaiters.push(r));
      if (this.closed) throw errSessionShutdown();
    }
    const id = this.nextId;
    if (id >= 0xffffffff - 1) throw new YamuxError('streams exhausted', 'EEXHAUSTED');
    this.nextId += 2;
    const s = new Stream(this, id, 'init');
    this.streams.set(id, s);
    this.inflight.add(id);
    if (this.config.streamOpenTimeoutMs > 0) {
      const t = setTimeout(() => this.shutdown(new YamuxError('stream open timeout', 'ETIMEDOUT')), this.config.streamOpenTimeoutMs);
      s.established = () => clearTimeout(t);
      this.onClose(() => clearTimeout(t));
    }
    s.sendWindowUpdate();
    return s;
  }

  accept(): Promise<Stream> {
    const s = this.acceptQueue.shift();
    if (s) {
      s.sendWindowUpdate();
      return Promise.resolve(s);
    }
    if (this.closed) return Promise.reject(this.closeErr ?? errSessionShutdown());
    return new Promise((res, rej) =>
      this.acceptWaiters.push({
        res: (s) => {
          s.sendWindowUpdate();
          res(s);
        },
        rej,
      }),
    );
  }

  establish(id: number): void {
    if (this.inflight.delete(id)) this.synWaiters.shift()?.();
  }

  forget(id: number): void {
    this.streams.delete(id);
    this.establish(id);
  }

  /** Refuse new streams from the other end (hashicorp GoAway). */
  goAway(): void {
    this.localGoAway = true;
    this.sendControl(header(T_GOAWAY, 0, 0, GOAWAY_NORMAL));
  }

  async ping(): Promise<number> {
    if (this.closed) throw errSessionShutdown();
    const id = this.pingId++ >>> 0;
    const start = performance.now();
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pings.delete(id);
        rej(new YamuxError('ping timeout', 'ETIMEDOUT'));
      }, this.config.writeTimeoutMs);
      this.pings.set(id, () => {
        clearTimeout(t);
        res(performance.now() - start);
      });
      this.sendControl(header(T_PING, SYN, 0, id));
    });
  }

  private scheduleKeepAlive(): void {
    this.keepAliveTimer = setTimeout(() => {
      this.ping().then(
        () => !this.closed && this.scheduleKeepAlive(),
        () => this.shutdown(new YamuxError('keepalive timeout', 'ETIMEDOUT')),
      );
    }, this.config.keepAliveMs);
  }

  close(): void {
    this.shutdown();
  }

  private shutdown(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeErr = err;
    clearTimeout(this.keepAliveTimer);
    this.conn.destroy();
    for (const s of [...this.streams.values()]) s.forceClose();
    for (const s of this.acceptQueue) s.forceClose();
    this.acceptQueue = [];
    for (const w of this.acceptWaiters) w.rej(err ?? errSessionShutdown());
    this.acceptWaiters = [];
    for (const f of this.synWaiters) f();
    for (const f of this.drainWaiters) f();
    for (const f of this.closeListeners) f(err);
    this.closeListeners = [];
  }

  // Receiving.

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      while (this.buf.length >= HEADER && !this.closed) {
        const version = this.buf.readUInt8(0);
        const type = this.buf.readUInt8(1);
        const flags = this.buf.readUInt16BE(2);
        const id = this.buf.readUInt32BE(4);
        const length = this.buf.readUInt32BE(8);
        if (version !== VERSION) throw new YamuxError(`invalid protocol version ${version}`, 'EPROTO');
        let body: Buffer | undefined;
        if (type === T_DATA) {
          if (this.buf.length < HEADER + length) break;
          body = Buffer.from(this.buf.subarray(HEADER, HEADER + length));
          this.buf = this.buf.subarray(HEADER + length);
        } else {
          this.buf = this.buf.subarray(HEADER);
        }
        switch (type) {
          case T_DATA:
          case T_WINDOW:
            this.handleStream(type, flags, id, length, body);
            break;
          case T_PING:
            if (flags & SYN) this.sendControl(header(T_PING, ACK, 0, length));
            else {
              const f = this.pings.get(length);
              this.pings.delete(length);
              f?.();
            }
            break;
          case T_GOAWAY:
            if (length === GOAWAY_NORMAL) this.remoteGoAway = true;
            else throw new YamuxError(length === GOAWAY_PROTO ? 'yamux protocol error' : 'remote yamux error', 'EPROTO');
            break;
          default:
            throw new YamuxError(`invalid message type ${type}`, 'EPROTO');
        }
      }
    } catch (e) {
      if ((e as YamuxError).code === 'EPROTO') this.sendControl(header(T_GOAWAY, 0, 0, GOAWAY_PROTO));
      this.shutdown(e as Error);
    }
  }

  private handleStream(type: number, flags: number, id: number, length: number, body?: Buffer): void {
    if (flags & SYN) this.incoming(id);
    const s = this.streams.get(id);
    if (!s) return; // likely one we reset; its data is dropped
    if (type === T_WINDOW) s.incrSendWindow(flags, length);
    else s.readData(flags, body!);
  }

  private incoming(id: number): void {
    if (this.localGoAway) {
      this.sendControl(header(T_WINDOW, RST, id, 0));
      return;
    }
    if (this.streams.has(id)) throw new YamuxError('duplicate stream declared', 'EPROTO');
    const s = new Stream(this, id, 'synReceived');
    this.streams.set(id, s);
    const w = this.acceptWaiters.shift();
    if (w) {
      w.res(s);
      return;
    }
    if (this.acceptQueue.length >= this.config.acceptBacklog) {
      this.streams.delete(id);
      this.sendControl(header(T_WINDOW, RST, id, 0));
      return;
    }
    this.acceptQueue.push(s);
  }
}

/** A duplex over a readable and a writable, e.g. a child's stdout/stdin. */
export function pairDuplex(readable: NodeJS.ReadableStream, writable: NodeJS.WritableStream): Duplex {
  const d = new Duplex({
    read() {
      readable.resume();
    },
    write(chunk, _enc, cb) {
      if (writable.write(chunk)) cb();
      else writable.once('drain', () => cb());
    },
    final(cb) {
      writable.end();
      cb();
    },
    destroy(err, cb) {
      (writable as any).destroy?.();
      (readable as any).destroy?.();
      cb(err);
    },
  });
  readable.on('data', (c) => {
    if (!d.push(c)) readable.pause();
  });
  readable.on('end', () => d.push(null));
  readable.on('error', (e) => d.destroy(e));
  writable.on('error', (e) => d.destroy(e as Error));
  return d;
}
