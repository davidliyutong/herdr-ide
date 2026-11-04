// Video frames of a program window (--gui-video): a window that keeps
// changing is sent by its machine as a video stream instead of pictures and
// decoded here with WebCodecs. Only browsers that have it, in a secure
// context (localhost, HTTPS, the desktop app), ask for video; the others
// keep getting pictures.

/** The stream kinds the machine may send, with a codec string to probe. */
const PROBES: [kind: string, codec: string][] = [
  ['avc1', 'avc1.640033'],
  ['vp8', 'vp8'],
];

let probed: Promise<string[]> | undefined;

/** The kinds of video streams this browser decodes ('avc1', 'vp8'), checked once. */
export function videoCodecs(): Promise<string[]> {
  probed ??= (async () => {
    if (!globalThis.isSecureContext || typeof VideoDecoder === 'undefined') return [];
    const out: string[] = [];
    for (const [kind, codec] of PROBES) {
      try {
        const r = await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 });
        if (r.supported) out.push(kind);
      } catch {
        // Unknown codec string: not supported.
      }
    }
    return out;
  })();
  return probed;
}

/** The start of a window's video stream (agentproto.GUIVideo). */
export interface VideoConfig {
  window: number;
  codec: string;
  encoder: string;
  w: number;
  h: number;
}

// A frame that does not come out of the decoder in this time is given up.
const DECODE_TIMEOUT = 1000;

/** Decodes one stream of a window, a frame at a time. */
export class VideoStream {
  private decoder?: VideoDecoder;
  private waiting = new Map<number, (f: VideoFrame | undefined) => void>();
  /** Delta frames cannot be decoded until the next key frame. */
  needKey = true;

  constructor(
    readonly config: VideoConfig,
    private onError: () => void,
  ) {
    this.open();
  }

  private open() {
    this.needKey = true;
    try {
      this.decoder = new VideoDecoder({
        output: (f) => {
          const done = this.waiting.get(f.timestamp);
          this.waiting.delete(f.timestamp);
          if (done) done(f);
          else f.close();
        },
        error: () => this.fail(),
      });
      this.decoder.configure({
        codec: this.config.codec,
        codedWidth: this.config.w,
        codedHeight: this.config.h,
        optimizeForLatency: true,
      });
    } catch {
      this.decoder = undefined;
    }
  }

  /** Drops what is being decoded and starts over at the next key frame. */
  private fail() {
    for (const done of this.waiting.values()) done(undefined);
    this.waiting.clear();
    try {
      this.decoder?.close();
    } catch {
      // Already closed by the error.
    }
    this.open();
    this.onError();
  }

  /** The decoded frame seq, or undefined when it cannot be decoded. */
  decode(data: Uint8Array, key: boolean, seq: number): Promise<VideoFrame | undefined> {
    const d = this.decoder;
    if (!d || (this.needKey && !key)) return Promise.resolve(undefined);
    this.needKey = false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiting.delete(seq)) {
          resolve(undefined);
          this.fail();
        }
      }, DECODE_TIMEOUT);
      this.waiting.set(seq, (f) => {
        clearTimeout(timer);
        resolve(f);
      });
      try {
        d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: seq, data }));
      } catch {
        this.waiting.delete(seq);
        clearTimeout(timer);
        resolve(undefined);
        this.fail();
      }
    });
  }

  close() {
    for (const done of this.waiting.values()) done(undefined);
    this.waiting.clear();
    try {
      this.decoder?.close();
    } catch {
      // Already closed.
    }
    this.decoder = undefined;
  }
}
