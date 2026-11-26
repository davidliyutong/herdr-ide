// What a window may have on its way to its viewers (the Go agent's
// guiframes.go flow): frames until their bytes reach the window's budget,
// at most MAX_INFLIGHT. The budget is what the connection delivers (the
// highest rate acknowledgements showed lately) in the shortest round trip
// seen (frame captured to drawn in the fastest viewer, which acknowledges
// it) plus a queue of the shorter of that round trip and QUEUE_DELAY or a
// quarter of it, whichever is longer: up to twice the round trip's worth on
// fast links, whose round trips vary a lot relative to the shortest, and
// about a quarter more on slow ones, where the queue would add most of the
// delay. The budget keeps a queue, so round trips measured while sending
// are longer than the shortest: when none came within RTT_PROBE, one frame
// at a time is sent until one is drawn, which measures it again (as BBR's
// ProbeRTT does). Times are milliseconds.

/** Frames sent but not acknowledged per window, at most. */
export const MAX_INFLIGHT = 32;
/** Budgets: the queue they may build, at least (also before anything was
 * measured), at most. */
export const QUEUE_DELAY = 30;
export const MIN_BUDGET = 64 << 10;
export const MAX_BUDGET = 8 << 20;
/** The delivery rate is the highest of this long. */
export const RATE_WINDOW = 2000;
/** The shortest round trip is measured again when no round trip this short
 * came for this long. */
export const RTT_PROBE = 10_000;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const NO_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

export const isEmpty = (r: Rect) => r.w <= 0 || r.h <= 0;

export function union(r: Rect, o: Rect): Rect {
  if (isEmpty(r)) return o;
  if (isEmpty(o)) return r;
  const x0 = Math.min(r.x, o.x);
  const y0 = Math.min(r.y, o.y);
  const x1 = Math.max(r.x + r.w, o.x + o.w);
  const y1 = Math.max(r.y + r.h, o.y + o.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** r limited to a w×h drawable. */
export function clip(r: Rect, w: number, h: number): Rect {
  const x0 = Math.max(r.x, 0);
  const y0 = Math.max(r.y, 0);
  const x1 = Math.min(r.x + r.w, w);
  const y1 = Math.min(r.y + r.h, h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A captured rectangle is at most this a side: even a huge window costs
 * bounded memory per frame. */
export const TILE = 1024;

/** r in rectangles of at most TILE×TILE, row by row. */
export function tiles(r: Rect): Rect[] {
  const out: Rect[] = [];
  for (let y = r.y; y < r.y + r.h; y += TILE)
    for (let x = r.x; x < r.x + r.w; x += TILE) out.push({ x, y, w: Math.min(TILE, r.x + r.w - x), h: Math.min(TILE, r.y + r.h - y) });
  return out;
}

export interface SentFrame {
  seq: number;
  /** Captured. */
  at: number;
  bytes: number;
  /** When captured: Flow.delivered, the time it was reached and the
   * capture of the frame acknowledged then. The delivery rate is measured
   * from there, over the longer of the time the bytes took to be sent and
   * to be acknowledged, so acknowledgements arriving together (the
   * browser draws in order) do not make it look faster. */
  delivered: number;
  deliveredAt: number;
  firstSent: number;
}

/** Whether sequence number a comes after b (32 bits, wrapping). */
export const after = (a: number, b: number) => ((a - b) | 0) > 0;

export class Flow {
  inflight: SentFrame[] = [];
  /** Of inflight (estimates until encoded). */
  bytes = 0;
  /** Bytes acknowledged since watched. */
  delivered = 0;
  /** Of the last acknowledgement (0: none). */
  ackedAt = 0;
  /** Capture of the frame it acknowledged. */
  sentAt = 0;
  minRTT = 0;
  /** When a round trip this short came last. */
  minRTTAt = 0;
  /** Bytes per second. */
  maxRate = 0;
  rateAt = 0;
  /** Measuring the round trip again: one frame at a time until probeSeq
   * (the first frame sent alone, 0 before) is acknowledged. */
  probing = false;
  probeSeq = 0;
  /** Estimates for frames not encoded yet: bytes per pixel of pictures,
   * bytes of the last video frame. */
  bpp = 0;
  videoBytes = 0;

  /** How many bytes may be on their way. */
  budget(): number {
    if (this.minRTT === 0 || this.maxRate === 0) return MIN_BUDGET;
    const rtt = this.minRTT;
    const queue = Math.min(rtt, Math.max(rtt / 4, QUEUE_DELAY));
    return Math.max(MIN_BUDGET, Math.min(Math.trunc((this.maxRate * (rtt + queue)) / 1000), MAX_BUDGET));
  }

  /** The bytes and frames a window may send now. */
  room(now: number): [number, number] {
    if (!this.probing && this.minRTT !== 0 && now - this.minRTTAt > RTT_PROBE) {
      this.probing = true;
      this.probeSeq = 0;
    }
    if (this.probing) {
      if (this.inflight.length > 0) return [0, 0];
      return [Math.max(this.budget(), 1), 1];
    }
    return [this.budget() - this.bytes, MAX_INFLIGHT - this.inflight.length];
  }

  /** The expected size of a picture of r. */
  estimate(r: Rect): number {
    const bpp = this.bpp || 0.1; // JPEG of a rendered scene
    return Math.trunc(r.w * r.h * bpp) + 1;
  }

  /** Keeps the shortest round trip since the window was watched (a queue
   * the budget itself builds must not raise it) and the highest delivery
   * rate of the last RATE_WINDOW. */
  sample(rtt: number, rate: number, now: number): void {
    if (this.minRTT === 0 || rtt <= this.minRTT) {
      this.minRTT = rtt;
      this.minRTTAt = now;
    }
    if (rate >= this.maxRate || now - this.rateAt > RATE_WINDOW) {
      this.maxRate = rate;
      this.rateAt = now;
    }
  }
}
