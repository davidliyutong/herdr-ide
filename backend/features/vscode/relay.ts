// A WebSocket of VS Code's, relayed message by message: the browser's side
// is a channel of the host (Bun's WebSocket, the desktop app's
// MessagePort), code-server's a WebSocket client over a stream of the agent
// to its socket. code-server is asked first, so that a refusal reaches the
// browser as a failed upgrade; then each side's messages, text or binary,
// go to the other, and a close or a failure of either ends both.
//
// Backpressure: while the browser's channel holds more than HIGH_WATER
// unsent bytes, code-server's stream is not read, which holds code-server
// back through the agent's window. The browser cannot be held back (a
// channel does not pause); a code-server that does not read MAX_PENDING
// bytes ends the relay.
import type { Duplex } from 'node:stream';
import WebSocket, { type RawData } from 'ws';
import { CloseCode, type Channel, type ChannelHandlers, type Message } from '#kernel/channel.ts';
import type { Peer } from '#kernel/http/env.ts';

/** Bytes the browser's channel may hold before code-server is not read. */
export const HIGH_WATER = 4 << 20;
/** Bytes code-server may leave unread before the relay ends. */
export const MAX_PENDING = 64 << 20;
/** The largest message either way (Bun.serve's maxPayloadLength). */
const MAX_MESSAGE = 64 << 20;

/** code-server answered the upgrade with another status. */
export class Refused extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`code-server refused the WebSocket: ${status}`);
    this.status = status;
  }
}

export interface RelayOptions {
  /** A stream to code-server's socket. */
  sock: Duplex;
  /** The path and query below /m/<machine>/code. */
  path: string;
  /** The request's headers as passed on (proxy.ts requestHeaders). */
  headers: Record<string, string>;
  /** The subprotocols the browser asked for. */
  protocols: string[];
  /** Compress code-server's messages (over a remote machine's ssh). */
  compress: boolean;
  /** Bounds the handshake with code-server, and the browser's upgrade. */
  handshakeMs: number;
  upgrade: NonNullable<Peer['upgrade']>;
  /** Ends the relay (VS Code turned off for the client). */
  signal: AbortSignal;
  /** Runs once when the relay ends, however it does. */
  ended: () => void;
}

const isValidCode = (c: number) => (c >= 1000 && c <= 1014 && ![1004, 1005, 1006].includes(c)) || (c >= 3000 && c <= 4999);

/** A close reason of at most 123 bytes. */
function reasonOf(r: string | Buffer): string {
  const b = Buffer.from(r);
  return b.length <= 123
    ? b.toString()
    : b
        .subarray(0, 120)
        .toString()
        .replace(/\uFFFD$/, '');
}

const bytes = (d: RawData): Buffer => (Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d));

/** Opens the WebSocket to code-server, then upgrades the browser's request
 * and relays; answers what the host expects of an upgrade. Fails with
 * Refused, or with what broke the handshake. */
export async function relay(o: RelayOptions): Promise<Response> {
  const ws = new WebSocket(`ws://code-server${o.path}`, o.protocols, {
    createConnection: () => o.sock as unknown as import('node:net').Socket,
    headers: o.headers,
    perMessageDeflate: o.compress,
    handshakeTimeout: o.handshakeMs,
    followRedirects: false,
    maxPayload: MAX_MESSAGE,
  });
  let ch: Channel | null = null;
  let over = false;
  const queue: Message[] = [];
  const end = () => {
    if (over) return;
    over = true;
    clearTimeout(adoptTimer);
    o.signal.removeEventListener('abort', onAbort);
    ws.terminate();
    o.sock.destroy();
    o.ended();
  };
  const closeChannel = (code: number, reason: string) => {
    const c = ch;
    ch = null;
    c?.close(code, reason);
  };
  const onAbort = () => {
    closeChannel(CloseCode.GoingAway, 'VS Code turned off');
    end();
  };
  let adoptTimer: NodeJS.Timeout | undefined;
  let opened = false;

  // Listened to from the start: a message may follow the handshake's
  // answer at once. Those that arrive before the browser's channel opens
  // wait for it.
  ws.on('message', (data: RawData, binary: boolean) => {
    const m: Message = binary ? bytes(data) : bytes(data).toString('utf8');
    if (!ch) {
      if (!over) queue.push(m);
      return;
    }
    ch.send(m);
    if (ch.buffered > HIGH_WATER) o.sock.pause();
  });
  ws.on('close', (code: number, reason: Buffer) => {
    if (!opened) return; // the handshake's failure
    closeChannel(isValidCode(code) ? code : CloseCode.Internal, reasonOf(reason));
    end();
  });

  // The handshake.
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (e: Error) => {
        o.signal.removeEventListener('abort', aborted);
        reject(e);
      };
      const aborted = () => fail(new Error('VS Code turned off'));
      if (o.signal.aborted) return aborted();
      o.signal.addEventListener('abort', aborted, { once: true });
      ws.once('open', () => {
        opened = true;
        o.sock.pause();
        o.signal.removeEventListener('abort', aborted);
        resolve();
      });
      ws.once('error', fail);
      ws.once('unexpected-response', (req, res) => {
        res.resume();
        req.destroy();
        fail(new Refused(res.statusCode ?? 502));
      });
    });
  } catch (e) {
    ws.removeAllListeners();
    ws.on('error', () => {});
    ws.terminate();
    o.sock.destroy();
    throw e;
  }
  ws.removeAllListeners('error');
  ws.on('error', () => {}); // 'close' follows

  o.signal.addEventListener('abort', onAbort, { once: true });
  // A browser whose upgrade does not complete leaves nothing behind.
  adoptTimer = setTimeout(() => !ch && end(), o.handshakeMs);

  const res = o.upgrade(
    (c): ChannelHandlers => {
      if (over) {
        c.close(CloseCode.GoingAway, '');
        return { message() {} };
      }
      ch = c;
      clearTimeout(adoptTimer);
      for (const m of queue.splice(0)) c.send(m);
      if (c.buffered <= HIGH_WATER) o.sock.resume();
      return {
        message(d) {
          if (over || ws.readyState !== WebSocket.OPEN) return;
          ws.send(d, { binary: typeof d !== 'string' });
          if (ws.bufferedAmount > MAX_PENDING) {
            closeChannel(CloseCode.Overflow, 'code-server is not reading');
            end();
          }
        },
        close(code, reason) {
          ch = null;
          if (over) return;
          if (ws.readyState === WebSocket.OPEN) {
            // The closing handshake with code-server; its close ends the
            // relay (or ws's own timeout does).
            ws.close(isValidCode(code) ? code : CloseCode.Normal, reasonOf(reason));
          } else end();
        },
        drain() {
          if (ch && ch.buffered <= HIGH_WATER) o.sock.resume();
        },
      };
    },
    { compress: true },
  );
  if (res.status >= 300) end();
  return res;
}
