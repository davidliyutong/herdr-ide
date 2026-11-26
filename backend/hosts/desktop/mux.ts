// Multiplexes the desktop bridge's control messages (ToHub, FromHub) and
// virtual Ports over a pair of byte streams (the spawned Stage 1 Bun hub
// executable's stdin and stdout), without any TCP listener.
//
// Wire frame: [u32be length][u32be id][u8 kind][payload (length bytes)]
//   id = 0: parent control channel (JSON)
//   id > 0: virtual Port id
//     kind = 0 (JSON):  control object (ResponseHead, credit, end, error, abort, open, close, ack, oversize)
//     kind = 1 (TEXT):  UTF-8 string channel message
//     kind = 2 (BYTES): raw Uint8Array channel message
//     kind = 3 (CHUNK): raw Uint8Array HTTP body chunk ({ t: 'chunk', data })
//     kind = 4 (CLOSE): virtual Port closed (empty payload)
import { MAX_MESSAGE, TOO_BIG, bytes, type ChannelControl, type Frame, type FromHub, type Port, type ToHub } from './bridge';

const HEADER = 9;
/** Hard cap on a single wire frame over stdio. Channel messages above
 * maxMessage (default MAX_MESSAGE = 64 MiB) are rejected on their own
 * channel before writing a frame onto the shared stream, so an oversized
 * message never tears down sibling channels or requests. */
export const MAX_MUX_FRAME = 128 << 20;

const KIND_JSON = 0;
const KIND_TEXT = 1;
const KIND_BYTES = 2;
const KIND_CHUNK = 3;
const KIND_CLOSE = 4;

const EMPTY = new Uint8Array(0);
const OVERSIZE_JSON = Buffer.from(JSON.stringify({ t: 'oversize' } satisfies ChannelControl), 'utf8');

export interface MuxOptions {
  onDisconnect?: () => void;
  maxMessage?: number;
  maxFrame?: number;
}

class VirtualPort implements Port {
  readonly id: number;
  private readonly role: 'parent' | 'child';
  private readonly maxMessage: number;
  private readonly maxFrame: number;
  private readonly writeFrame: (id: number, kind: number, payload: Uint8Array) => boolean;
  private readonly release: (id: number) => void;
  private onMessage?: (data: unknown) => void;
  private onClose?: () => void;
  private readonly pending: unknown[] = [];
  private localClosed = false;
  private remoteClosed = false;
  private closeDelivered = false;

  constructor(
    id: number,
    role: 'parent' | 'child',
    maxMessage: number,
    maxFrame: number,
    writeFrame: (id: number, kind: number, payload: Uint8Array) => boolean,
    release: (id: number) => void,
  ) {
    this.id = id;
    this.role = role;
    this.maxMessage = maxMessage;
    this.maxFrame = maxFrame;
    this.writeFrame = writeFrame;
    this.release = release;
  }

  post(msg: unknown): void {
    if (this.localClosed || this.remoteClosed) return;
    if (typeof msg === 'string') {
      if (msg.length > this.maxMessage) {
        this.rejectOversize();
        return;
      }
      const buf = Buffer.from(msg, 'utf8');
      if (buf.byteLength > this.maxMessage || buf.byteLength > this.maxFrame) {
        this.rejectOversize();
        return;
      }
      this.writeFrame(this.id, KIND_TEXT, buf);
      return;
    }
    if (msg instanceof Uint8Array || msg instanceof ArrayBuffer || ArrayBuffer.isView(msg)) {
      const b = bytes(msg);
      if (b.byteLength > this.maxMessage || b.byteLength > this.maxFrame) {
        this.rejectOversize();
        return;
      }
      this.writeFrame(this.id, KIND_BYTES, b);
      return;
    }
    if (typeof msg === 'object' && msg !== null && (msg as { t?: unknown }).t === 'chunk') {
      const b = bytes((msg as Frame & { t: 'chunk' }).data);
      if (b.byteLength > this.maxFrame) {
        this.close();
        return;
      }
      this.writeFrame(this.id, KIND_CHUNK, b);
      return;
    }
    const json = Buffer.from(JSON.stringify(msg), 'utf8');
    if (json.byteLength > this.maxFrame) {
      this.close();
      return;
    }
    this.writeFrame(this.id, KIND_JSON, json);
  }

  private rejectOversize(): void {
    if (this.role === 'parent') {
      this.writeFrame(this.id, KIND_JSON, OVERSIZE_JSON);
      return;
    }
    const closeCtrl = Buffer.from(
      JSON.stringify({ t: 'close', code: TOO_BIG, reason: 'message too big' } satisfies ChannelControl),
      'utf8',
    );
    this.writeFrame(this.id, KIND_JSON, closeCtrl);
    this.close();
  }

  listen(message: (data: unknown) => void, closed: () => void): void {
    this.onMessage = message;
    this.onClose = closed;
    while (this.pending.length > 0 && !this.localClosed) {
      const item = this.pending.shift();
      message(item);
    }
    if ((this.remoteClosed || this.localClosed) && !this.closeDelivered) {
      this.closeDelivered = true;
      queueMicrotask(closed);
    }
  }

  deliver(kind: number, payload: Buffer): void {
    if (this.localClosed || this.remoteClosed) return;
    if (kind === KIND_CLOSE) {
      this.remoteClosed = true;
      this.release(this.id);
      if (this.onClose && !this.closeDelivered) {
        this.closeDelivered = true;
        this.onClose();
      }
      return;
    }
    let msg: unknown;
    switch (kind) {
      case KIND_TEXT:
        msg = payload.toString('utf8');
        break;
      case KIND_BYTES:
        msg = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength).slice();
        break;
      case KIND_CHUNK:
        msg = { t: 'chunk', data: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength).slice() } satisfies Frame;
        break;
      case KIND_JSON:
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch {
          return;
        }
        break;
      default:
        return;
    }
    if (this.onMessage) this.onMessage(msg);
    else this.pending.push(msg);
  }

  /** Transport went away: deliver close without writing back. */
  abort(): void {
    this.remoteClosed = true;
    this.pending.length = 0;
    if (this.onClose && !this.closeDelivered) {
      this.closeDelivered = true;
      this.onClose();
    }
  }

  close(): void {
    if (this.localClosed) return;
    this.localClosed = true;
    this.pending.length = 0;
    this.release(this.id);
    if (!this.remoteClosed) this.writeFrame(this.id, KIND_CLOSE, EMPTY);
    if (this.onClose && !this.closeDelivered) {
      this.closeDelivered = true;
      queueMicrotask(this.onClose);
    }
  }
}

/** Accumulates incoming stream chunks and yields complete frames without
 * concatenating the queue on every small read. */
class FrameReader {
  private readonly maxFrame: number;
  private readonly chunks: Buffer[] = [];
  private buffered = 0;

  constructor(maxFrame: number) {
    this.maxFrame = maxFrame;
  }

  push(chunk: Buffer, onFrame: (id: number, kind: number, payload: Buffer) => void): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.buffered >= HEADER) {
      const head = this.peekHeader();
      const len = head.readUInt32BE(0);
      if (len > this.maxFrame) throw new Error(`mux frame too large: ${len}`);
      if (this.buffered < HEADER + len) return;
      const id = head.readUInt32BE(4);
      const kind = head[8]!;
      this.consume(HEADER);
      const payload = this.consume(len);
      onFrame(id, kind, payload);
    }
  }

  private peekHeader(): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= HEADER) return first;
    const out = Buffer.allocUnsafe(HEADER);
    let copied = 0;
    for (const c of this.chunks) {
      const take = Math.min(c.length, HEADER - copied);
      c.copy(out, copied, 0, take);
      copied += take;
      if (copied === HEADER) break;
    }
    return out;
  }

  private consume(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0]!;
    if (first.length === n) {
      this.chunks.shift();
      this.buffered -= n;
      return first;
    }
    if (first.length > n) {
      const slice = first.subarray(0, n);
      this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return slice;
    }
    const out = Buffer.allocUnsafe(n);
    let copied = 0;
    while (copied < n) {
      const c = this.chunks[0]!;
      const take = Math.min(c.length, n - copied);
      c.copy(out, copied, 0, take);
      copied += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    this.buffered -= n;
    return out;
  }
}

// Each end is judged by its own direction only: a child's stdin is a Socket
// whose (unused) readable side has already ended (Node 24, Electron 45), and
// a child's stdout likewise for its writable side.
function readableClosed(s: NodeJS.ReadableStream): boolean {
  const st = s as { destroyed?: boolean; readableEnded?: boolean };
  return Boolean(st.destroyed || st.readableEnded);
}

function writableClosed(s: NodeJS.WritableStream): boolean {
  const st = s as { destroyed?: boolean; writableEnded?: boolean };
  return Boolean(st.destroyed || st.writableEnded);
}

function makeEndpoint(
  role: 'parent' | 'child',
  readable: NodeJS.ReadableStream,
  writable: NodeJS.WritableStream,
  onControl: (payload: Buffer, openRemote: (id: number) => Port) => void,
  opts: MuxOptions = {},
) {
  const maxMessage = opts.maxMessage ?? MAX_MESSAGE;
  const maxFrame = opts.maxFrame ?? MAX_MUX_FRAME;
  const ports = new Map<number, VirtualPort>();
  let ended = false;
  let nextId = 1;

  const finish = () => {
    if (ended) return;
    ended = true;
    const active = [...ports.values()];
    ports.clear();
    for (const p of active) p.abort();
    opts.onDisconnect?.();
  };

  const writeFrame = (id: number, kind: number, payload: Uint8Array): boolean => {
    if (ended) return false;
    if (payload.byteLength > maxFrame) {
      if (id > 0) ports.get(id)?.close();
      return false;
    }
    const hdr = Buffer.allocUnsafe(HEADER);
    hdr.writeUInt32BE(payload.byteLength, 0);
    hdr.writeUInt32BE(id, 4);
    hdr[8] = kind;
    try {
      writable.write(hdr);
      if (payload.byteLength > 0) writable.write(payload);
      return !ended;
    } catch {
      finish();
      return false;
    }
  };

  const openPort = (id: number): VirtualPort => {
    if (ended) {
      const dead = new VirtualPort(id, role, maxMessage, maxFrame, writeFrame, () => {});
      dead.abort();
      return dead;
    }
    let p = ports.get(id);
    if (!p) {
      p = new VirtualPort(id, role, maxMessage, maxFrame, writeFrame, (k) => ports.delete(k));
      ports.set(id, p);
    }
    return p;
  };

  const reader = new FrameReader(maxFrame);
  readable.on('data', (chunk: Buffer | Uint8Array | string) => {
    if (ended) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    try {
      reader.push(buf, (id, kind, payload) => {
        if (id === 0) {
          if (kind === KIND_JSON) onControl(payload, openPort);
          return;
        }
        ports.get(id)?.deliver(kind, payload);
      });
    } catch {
      finish();
    }
  });
  readable.on('end', finish);
  readable.on('close', finish);
  readable.on('error', finish);
  writable.on('close', finish);
  writable.on('error', finish);
  if (readableClosed(readable) || writableClosed(writable)) {
    ended = true;
    if (opts.onDisconnect) queueMicrotask(opts.onDisconnect);
  }

  return {
    isEnded: () => ended,
    allocatePort: () => openPort(nextId++),
    sendControl(obj: unknown): void {
      if (ended) throw new Error('stdio mux closed');
      const body = Buffer.from(JSON.stringify(obj), 'utf8');
      if (body.byteLength > maxFrame) throw new Error(`control frame too large: ${body.byteLength}`);
      if (!writeFrame(0, KIND_JSON, body)) throw new Error('stdio mux closed');
    },
    close: finish,
  };
}

interface ControlEnvelope {
  m: ToHub;
  portId?: number;
}

/** Main process side of the stdio multiplex to the spawned hub binary. */
export function muxParent(readable: NodeJS.ReadableStream, writable: NodeJS.WritableStream, opts: MuxOptions = {}) {
  const listeners: Array<(m: FromHub) => void> = [];
  const ep = makeEndpoint(
    'parent',
    readable,
    writable,
    (payload) => {
      try {
        const m = JSON.parse(payload.toString('utf8')) as FromHub;
        if (m && typeof m === 'object' && typeof m.t === 'string') for (const fn of listeners) fn(m);
      } catch {
        // ignore malformed control frame
      }
    },
    opts,
  );
  return {
    get closed(): boolean {
      return ep.isEnded();
    },
    send(m: ToHub, withPort = false): Port | undefined {
      if (ep.isEnded()) throw new Error('stdio mux closed');
      if (!withPort) {
        ep.sendControl({ m } satisfies ControlEnvelope);
        return undefined;
      }
      const p = ep.allocatePort();
      try {
        ep.sendControl({ m, portId: p.id } satisfies ControlEnvelope);
      } catch (e) {
        p.abort();
        throw e;
      }
      return p;
    },
    onMessage(fn: (m: FromHub) => void): void {
      listeners.push(fn);
    },
    close(): void {
      ep.close();
    },
  };
}

/** Hub child process side of the stdio multiplex (`<slug> desktop`),
 * implementing serve.ts's Parent<Port>. */
export function muxChild(
  readable: NodeJS.ReadableStream,
  writable: NodeJS.WritableStream,
  onDisconnect?: () => void,
  opts: Omit<MuxOptions, 'onDisconnect'> = {},
) {
  const listeners: Array<(e: { data: unknown; ports: readonly Port[] }) => void> = [];
  const ep = makeEndpoint(
    'child',
    readable,
    writable,
    (payload, openRemote) => {
      let env: ControlEnvelope;
      try {
        env = JSON.parse(payload.toString('utf8')) as ControlEnvelope;
      } catch {
        return;
      }
      if (!env || typeof env !== 'object' || !env.m) return;
      const ports = typeof env.portId === 'number' && env.portId > 0 ? [openRemote(env.portId)] : [];
      for (const fn of listeners) fn({ data: env.m, ports });
    },
    { ...opts, onDisconnect },
  );
  return {
    on(_event: 'message', fn: (e: { data: unknown; ports: readonly Port[] }) => void): unknown {
      listeners.push(fn);
      return undefined;
    },
    postMessage(m: FromHub): void {
      try {
        ep.sendControl(m);
      } catch {
        // parent pipe gone
      }
    },
  };
}
