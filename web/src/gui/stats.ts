// Frame statistics of a browser window showing a program window, shown with
// #stats in its address: what this browser received and drew, next to what
// the machine reported about capturing and encoding (agentproto.GUIStats).

/** A machine's report about one window, about once a second. Durations are
 * totals in microseconds. */
export interface MachineStats {
  window: number;
  interval_us: number;
  updates: number;
  frames: number;
  jpeg: number;
  png: number;
  pixels: number;
  bytes: number;
  capture_us: number;
  convert_us: number;
  encode_us: number;
  waits: number;
  latency_us: number;
  acked: number;
  video?: number;
  encoder?: string;
  fallback?: string;
}

export interface StatsView {
  /** Frames drawn per second. */
  fps: number;
  kbPerFrame: number;
  mbps: number;
  /** Mean milliseconds per frame. */
  decodeMs: number;
  drawMs: number;
  /** Frames per second the core did not send here (this window was behind). */
  skipped: number;
  machine?: {
    /** Changes of the picture sent per second, and the frames (tiles) they took. */
    ups: number;
    fps: number;
    /** Megapixels captured per second. */
    mpx: number;
    /** Mean milliseconds per update. */
    captureMs: number;
    convertMs: number;
    encodeMs: number;
    /** Mean time from capture to acknowledgement. */
    latencyMs: number;
    /** Ticks per second held back by unacknowledged frames. */
    waits: number;
    jpeg: number;
    png: number;
    /** Video frames per second and their encoder. */
    video: number;
    encoder?: string;
    /** Why the window is sent as pictures although video was asked for. */
    fallback?: Fallback;
  };
}

const STALE_MS = 3000;

/** Why a window is sent as pictures although video was asked for. */
const FALLBACKS = ['unavailable', 'no_codec', 'failed'] as const;
export type Fallback = (typeof FALLBACKS)[number];

export class FrameStats {
  private frames = 0;
  private bytes = 0;
  private decode = 0;
  private draw = 0;
  private skipped = 0;
  private lastSeq?: number;
  private machine?: { s: MachineStats; at: number };

  constructor(private since: number) {}

  /** A frame arrived. Sequence numbers count every frame of the window, so
   * a gap is frames the core skipped for this browser window. */
  received(seq: number, bytes: number) {
    if (this.lastSeq !== undefined) {
      const gap = (seq - this.lastSeq - 1) >>> 0;
      if (gap < 1 << 20) this.skipped += gap;
    }
    this.lastSeq = seq;
    this.bytes += bytes;
  }

  drawn(decodeMs: number, drawMs: number) {
    this.frames++;
    this.decode += decodeMs;
    this.draw += drawMs;
  }

  /** The connection was replaced: sequence numbers start over. */
  reconnected() {
    this.lastSeq = undefined;
  }

  reported(s: MachineStats, now: number) {
    this.machine = { s, at: now };
  }

  /** The view of the time since the last call; starts the next period. */
  take(now: number): StatsView {
    const secs = Math.max(now - this.since, 1) / 1000;
    const per = (v: number) => (this.frames ? v / this.frames : 0);
    const view: StatsView = {
      fps: this.frames / secs,
      kbPerFrame: per(this.bytes) / 1000,
      mbps: (this.bytes * 8) / secs / 1e6,
      decodeMs: per(this.decode),
      drawMs: per(this.draw),
      skipped: this.skipped / secs,
    };
    // A report is due every second; older ones describe a connection that
    // is gone.
    const m = this.machine && now - this.machine.at < STALE_MS ? this.machine.s : undefined;
    if (m) {
      const mSecs = Math.max(m.interval_us, 1) / 1e6;
      const each = (us: number) => (m.updates ? us / m.updates / 1000 : 0);
      view.machine = {
        ups: m.updates / mSecs,
        fps: m.frames / mSecs,
        mpx: m.pixels / mSecs / 1e6,
        captureMs: each(m.capture_us),
        convertMs: each(m.convert_us),
        encodeMs: each(m.encode_us),
        latencyMs: m.acked ? m.latency_us / m.acked / 1000 : 0,
        waits: m.waits / mSecs,
        jpeg: m.jpeg,
        png: m.png,
        video: (m.video ?? 0) / mSecs,
        encoder: m.encoder || undefined,
        fallback: FALLBACKS.find((f) => f === m.fallback),
      };
    }
    this.frames = this.bytes = this.decode = this.draw = this.skipped = 0;
    this.since = now;
    return view;
  }
}
