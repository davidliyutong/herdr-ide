// herdr-core's framing (protocol generation 1): after the hello, frames of
// [channel u32 LE][kind u8][length u32 LE][payload]. Channel 0 carries the
// JSON-RPC calls; every attached terminal or event subscription has a
// channel of its own. The core sends stream bytes only against credit: a
// channel starts with WINDOW bytes and the receiver returns what it has
// passed on.
import { EOFError, type Reader } from '#shared/lib/streamio.ts';

/** The protocol generation spoken here. */
export const GENERATION = 1;
export const HEADER_LEN = 9;
/** The largest payload of one frame. */
export const MAX_PAYLOAD = 16 << 20;
/** The credit a stream starts with. */
export const WINDOW = 256 << 10;
/** Bounds the reply to the hello, the one line read in plain mode. */
export const MAX_HELLO = 1 << 20;
/** Bounds the bytes of one channel waiting in memory: a core that honors
 * credit never has more than WINDOW outstanding; the rest is room for the
 * frames that carry no credit (resizes, the close). */
export const MAX_QUEUED = 2 * WINDOW;

export const Kind = {
  Data: 0,
  Credit: 1,
  Close: 2,
  Resize: 3,
  Focus: 4,
  Facts: 5,
  AutomaticInput: 6,
} as const;

export interface Frame {
  channel: number;
  kind: number;
  payload: Buffer;
}

export function encodeFrame(channel: number, kind: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const b = Buffer.allocUnsafe(HEADER_LEN + payload.length);
  b.writeUInt32LE(channel >>> 0, 0);
  b[4] = kind;
  b.writeUInt32LE(payload.length, 5);
  b.set(payload, HEADER_LEN);
  return b;
}

/** Reads one frame; null only when the stream ends between two frames. */
export async function readFrame(r: Reader): Promise<Frame | null> {
  const first = await r.chunk(1);
  if (first === null) return null;
  let rest: Buffer;
  try {
    rest = await r.exactly(HEADER_LEN - 1);
  } catch (e) {
    throw e instanceof EOFError ? new EOFError(true) : e;
  }
  const h = Buffer.concat([first, rest]);
  const n = h.readUInt32LE(5);
  if (n > MAX_PAYLOAD) throw new Error(`hc: frame of ${n} bytes exceeds ${MAX_PAYLOAD}`);
  const payload = n ? await r.exactly(n) : Buffer.alloc(0);
  return { channel: h.readUInt32LE(0), kind: h[4], payload };
}

export const u32le = (n: number): Buffer => {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
