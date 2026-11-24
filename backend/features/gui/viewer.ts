// One browser window showing one program window, as the router sees it:
// what it was sent and has not acknowledged, and whether it fell behind.
import type { Limits, Timing } from './timing.ts';

/** Hands a message to the browser window (text: an event; binary: a
 * frame) without blocking; false when its queue is full. */
export type ViewerSend = (msg: string | Uint8Array) => boolean;

interface SentFrame {
  seq: number;
  /** When it was sent (ms). */
  at: number;
  bytes: number;
}

export class Viewer {
  readonly send: ViewerSend;
  /** The video streams the browser decodes ("avc1", "vp8"); none means
   * pictures only. */
  readonly codecs: readonly string[];

  /** Frames sent and not acknowledged, and their size. */
  sent: SentFrame[] = [];
  sentBytes = 0;
  /** Frames were dropped: it needs the whole window again. */
  stale = false;
  /** The last refresh it asked for (ms). */
  refreshed = -Infinity;
  /** Video frames were dropped (or none came yet): it cannot decode until
   * the next key frame. */
  needKey = false;
  /** When a key frame was last asked for it (ms). */
  keyAsked = -Infinity;

  constructor(send: ViewerSend, codecs: readonly string[] = []) {
    this.send = send;
    this.codecs = codecs;
  }

  /** Whether it should skip frames of a window whose frames up to acked
   * were shown by some viewer: it has too many frames or bytes not shown,
   * or the oldest of them was shown elsewhere and sent viewerLagMs ago. */
  behind(acked: number, now: number, o: Pick<Timing, 'viewerLagMs'> & Pick<Limits, 'viewerMaxFrames' | 'viewerMaxBytes'>): boolean {
    if (this.sent.length >= o.viewerMaxFrames || this.sentBytes >= o.viewerMaxBytes) return true;
    return this.sent.length > 0 && this.sent[0].seq <= acked && now - this.sent[0].at > o.viewerLagMs;
  }

  /** Records a frame sent. */
  sending(seq: number, bytes: number, now: number): void {
    this.sent.push({ seq, at: now, bytes });
    this.sentBytes += bytes;
  }

  /** Takes the acknowledgement of frame seq: true when it was a frame sent
   * to this viewer, which, with those before it, no longer counts. */
  acked(seq: number): boolean {
    let i = 0;
    while (i < this.sent.length && this.sent[i].seq <= seq) i++;
    if (i === 0 || this.sent[i - 1].seq !== seq) return false;
    for (const f of this.sent.splice(0, i)) this.sentBytes -= f.bytes;
    return true;
  }

  /** A new attachment numbers frames from the start. */
  restart(): void {
    this.sent = [];
    this.sentBytes = 0;
    this.stale = false;
    this.needKey = false;
  }
}
