import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoStream } from '../gui/video';

// A decoder that outputs each chunk at once, and fails on chunks starting
// with 0xff.
class FakeDecoder {
  static made: FakeDecoder[] = [];
  config?: VideoDecoderConfig;
  closed = false;
  constructor(private init: VideoDecoderInit) {
    FakeDecoder.made.push(this);
  }
  configure(c: VideoDecoderConfig) {
    this.config = c;
  }
  decode(chunk: { type: string; timestamp: number; data: Uint8Array }) {
    if (chunk.data[0] === 0xff) {
      this.init.error(new DOMException('bad stream'));
      return;
    }
    queueMicrotask(() => this.init.output({ timestamp: chunk.timestamp, close() {} } as unknown as VideoFrame));
  }
  close() {
    this.closed = true;
  }
}

class FakeChunk {
  constructor(o: object) {
    Object.assign(this, o);
  }
}

describe('video codecs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('asks for video only with WebCodecs in a secure context', async () => {
    vi.stubGlobal('VideoDecoder', { isConfigSupported: async (c: { codec: string }) => ({ supported: c.codec === 'vp8' }) });
    vi.stubGlobal('isSecureContext', false);
    expect(await (await import('../gui/video')).videoCodecs()).toEqual([]);
    vi.resetModules();
    vi.stubGlobal('isSecureContext', true);
    expect(await (await import('../gui/video')).videoCodecs()).toEqual(['vp8']);
  });
});

describe('video streams', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeDecoder.made = [];
  });

  const stream = (onError = () => {}) => {
    vi.stubGlobal('VideoDecoder', FakeDecoder);
    vi.stubGlobal('EncodedVideoChunk', FakeChunk);
    return new VideoStream({ window: 7, codec: 'avc1.64001f', encoder: 'h264_nvenc', w: 640, h: 480 }, onError);
  };
  const data = (b = 1) => new Uint8Array([b]);

  it('decodes from a key frame on, for low latency', async () => {
    const s = stream();
    expect(FakeDecoder.made[0].config).toMatchObject({ codec: 'avc1.64001f', codedWidth: 640, optimizeForLatency: true });
    expect(await s.decode(data(), false, 1)).toBeUndefined();
    expect((await s.decode(data(), true, 2))?.timestamp).toBe(2);
    expect((await s.decode(data(), false, 3))?.timestamp).toBe(3);
  });

  it('starts over at the next key frame after an error', async () => {
    const onError = vi.fn();
    const s = stream(onError);
    await s.decode(data(), true, 1);
    expect(await s.decode(data(0xff), false, 2)).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(FakeDecoder.made[0].closed).toBe(true);
    expect(s.needKey).toBe(true);
    expect(await s.decode(data(), false, 3)).toBeUndefined();
    expect((await s.decode(data(), true, 4))?.timestamp).toBe(4);
    expect(FakeDecoder.made).toHaveLength(2);
  });
});
