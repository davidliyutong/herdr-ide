// Shows one program window in this browser window: frames from the core are
// drawn on canvases (the window and its menus/tooltips as layers), scaled to
// fit; pointer and keyboard input goes back with window coordinates.
//
// Messages from the core: JSON events {ev: window | gone | layer |
// layer_gone | cursor | child | stats | video} and binary frames
// [window u32][layer u32][x i16][y i16][w u16][h u16][enc u8][seq u32][data]
// (enc 1 JPEG, 2 PNG, 3 video, 4 video key frame). Each frame is
// acknowledged once drawn. The WebSocket's ?video= says which video streams
// this browser decodes (./video.ts).

import { xKeycode } from './keycodes';
import type { GuiWindow } from './state';
import { FrameStats, type StatsView } from './stats';
import { videoCodecs, VideoStream, type VideoConfig } from './video';

interface Layer {
  id: number;
  window: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SessionStatus = 'connecting' | 'open' | 'reconnecting' | 'gone';

export interface SessionEvents {
  status(s: SessionStatus): void;
  window(w: GuiWindow): void;
  /** A dialog of this window appeared. */
  child(w: GuiWindow): void;
  /** Frame statistics, once a second. */
  stats?(s: StatsView): void;
}

const FRAME_HEADER = 21;
const ENC_JPEG = 1;
const ENC_VIDEO = 3;
const ENC_VIDEO_KEY = 4;
// Wheel distance (pixels) per scroll step sent to the program.
const WHEEL_STEP = 50;
// Browser buttons (0 main, 1 middle, 2 secondary, 3 back, 4 forward) to X.
const BUTTONS = [1, 2, 3, 8, 9];

export class GuiSession {
  private ws?: WebSocket;
  private disposed = false;
  private gone = false;
  private backoff = 500;
  private stage: HTMLDivElement;
  private base: HTMLCanvasElement;
  private layers = new Map<number, { layer: Layer; el: HTMLCanvasElement }>();
  private drawing: Promise<void> = Promise.resolve();
  private size = { w: 0, h: 0 };
  private scale = 1;
  private wheel = { x: 0, y: 0 };
  private pending?: { x: number; y: number };
  private cleanup: (() => void)[] = [];
  private stats = new FrameStats(performance.now());
  private video?: VideoStream;
  private ctx = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D | null>();

  constructor(
    private m: string,
    private id: number,
    private host: HTMLElement,
    private on: SessionEvents,
    input: boolean,
  ) {
    this.stage = document.createElement('div');
    this.stage.className = 'gui-stage';
    this.base = document.createElement('canvas');
    this.stage.appendChild(this.base);
    host.appendChild(this.stage);
    this.listen(window, 'resize', () => this.fit());
    // Closing this browser window closes the program window (the core waits
    // briefly, so a reload keeps it). A keepalive request survives the page
    // going away and, unlike a body-less beacon, carries the page's Origin.
    this.listen(window, 'pagehide', () => {
      if (input) void fetch(`/m/${encodeURIComponent(m)}/gui/${id}/close`, { method: 'POST', keepalive: true }).catch(() => {});
    });
    if (input) this.bindInput();
    if (on.stats) {
      const timer = setInterval(() => on.stats!(this.stats.take(performance.now())), 1000);
      this.cleanup.push(() => clearInterval(timer));
    }
    void this.connect();
  }

  dispose() {
    this.disposed = true;
    for (const f of this.cleanup) f();
    this.ws?.close();
    this.video?.close();
    this.stage.remove();
  }

  private listen<K extends keyof WindowEventMap>(
    target: Window | HTMLElement,
    type: K,
    fn: (e: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, fn as EventListener, opts);
    this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts));
  }

  private async connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const codecs = await videoCodecs();
    if (this.disposed) return;
    const query = codecs.length ? `?video=${codecs.join(',')}` : '';
    const ws = new WebSocket(`${proto}//${location.host}/m/${encodeURIComponent(this.m)}/gui/${this.id}/ws${query}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.stats.reconnected();
    };
    ws.onmessage = (e) => this.message(e);
    ws.onclose = () => {
      if (this.disposed || this.gone) return;
      this.on.status('reconnecting');
      setTimeout(() => !this.disposed && void this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
  }

  send(cmd: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
  }

  private message(e: MessageEvent) {
    if (typeof e.data !== 'string') {
      this.frame(e.data as ArrayBuffer);
      return;
    }
    const ev = JSON.parse(e.data);
    switch (ev.ev) {
      case 'window':
        if (ev.window.id !== this.id) break;
        this.resize(ev.window.w, ev.window.h);
        this.on.window(ev.window);
        this.on.status('open');
        break;
      case 'gone':
        if (ev.id !== this.id) break;
        this.gone = true;
        this.on.status('gone');
        break;
      case 'layer':
        this.layer(ev.layer);
        break;
      case 'layer_gone': {
        const l = this.layers.get(ev.id);
        l?.el.remove();
        this.layers.delete(ev.id);
        break;
      }
      case 'cursor': {
        const c = ev.cursor;
        this.stage.style.cursor = `url(data:image/png;base64,${c.png}) ${c.xhot} ${c.yhot}, default`;
        break;
      }
      case 'child':
        this.on.child(ev.window);
        break;
      case 'stats':
        if (ev.stats?.window === this.id) this.stats.reported(ev.stats, performance.now());
        break;
      case 'video':
        if (ev.video?.window === this.id) this.startVideo(ev.video);
        break;
    }
  }

  private layer(l: Layer) {
    let entry = this.layers.get(l.id);
    if (!entry) {
      const el = document.createElement('canvas');
      el.className = 'gui-layer';
      this.stage.appendChild(el);
      entry = { layer: l, el };
      this.layers.set(l.id, entry);
    }
    if (entry.el.width !== l.w || entry.el.height !== l.h) {
      entry.el.width = l.w;
      entry.el.height = l.h;
    }
    entry.el.style.left = `${l.x}px`;
    entry.el.style.top = `${l.y}px`;
    entry.layer = l;
  }

  private frame(buf: ArrayBuffer) {
    if (buf.byteLength < FRAME_HEADER) return;
    const dv = new DataView(buf);
    const layer = dv.getUint32(4);
    const x = dv.getInt16(8);
    const y = dv.getInt16(10);
    const enc = dv.getUint8(16);
    const seq = dv.getUint32(17);
    this.stats.received(seq, buf.byteLength);
    if (enc === ENC_VIDEO || enc === ENC_VIDEO_KEY) {
      this.videoFrame(new Uint8Array(buf, FRAME_HEADER), enc === ENC_VIDEO_KEY, seq);
      return;
    }
    const blob = new Blob([new Uint8Array(buf, FRAME_HEADER)], { type: enc === ENC_JPEG ? 'image/jpeg' : 'image/png' });
    // Pictures decode at the same time, as they arrive; they are drawn in
    // order.
    const t0 = performance.now();
    const decoded = createImageBitmap(blob).then((bmp) => ({ bmp, at: performance.now() }));
    decoded.catch(() => undefined); // handled below, in order
    this.drawing = this.drawing.then(async () => {
      try {
        const { bmp, at } = await decoded;
        const t1 = performance.now();
        const canvas = layer === this.id ? this.base : this.layers.get(layer)?.el;
        if (canvas) this.context(canvas)?.drawImage(bmp, x, y);
        bmp.close();
        this.stats.drawn(at - t0, performance.now() - t1);
      } catch {
        // A corrupt image only costs that rectangle.
      }
      this.send({ cmd: 'ack', seq });
    });
  }

  /** A new video stream of this window: frames after it belong to it. */
  private startVideo(c: VideoConfig) {
    const old = this.video;
    // Frames of the old stream still queued are decoded with it.
    this.drawing = this.drawing.then(() => old?.close());
    this.video = new VideoStream(c, () => this.send({ cmd: 'keyframe' }));
  }

  private videoFrame(data: Uint8Array, key: boolean, seq: number) {
    const v = this.video;
    // In the order of arrival, like pictures, so a later picture is not
    // drawn under an earlier video frame.
    this.drawing = this.drawing.then(async () => {
      const t0 = performance.now();
      const f = await v?.decode(data, key, seq);
      const t1 = performance.now();
      if (f) {
        const { w, h } = this.size;
        // The coded size is padded; the window is its top left part.
        this.context(this.base)?.drawImage(f, 0, 0, w, h, 0, 0, w, h);
        f.close();
        this.stats.drawn(t1 - t0, performance.now() - t1);
      } else if (v?.needKey) {
        // Joined or fell behind mid-stream: the core sends a key frame.
        this.send({ cmd: 'keyframe' });
      }
      this.send({ cmd: 'ack', seq });
    });
  }

  private context(canvas: HTMLCanvasElement) {
    let c = this.ctx.get(canvas);
    if (c === undefined) {
      c = canvas.getContext('2d');
      this.ctx.set(canvas, c);
    }
    return c;
  }

  private resize(w: number, h: number) {
    if (w === this.size.w && h === this.size.h) return;
    const first = this.size.w === 0;
    this.size = { w, h };
    this.base.width = w;
    this.base.height = h;
    this.stage.style.width = `${w}px`;
    this.stage.style.height = `${h}px`;
    // Follow the program's window size (browsers allow it for windows they
    // opened by script); the content scales when the user resizes.
    if (!first || Math.abs(innerWidth - w) > 2 || Math.abs(innerHeight - h) > 2) {
      try {
        window.resizeTo(w + (outerWidth - innerWidth), h + (outerHeight - innerHeight));
      } catch {
        // Not a script-opened window.
      }
    }
    this.fit();
  }

  /** Scales the window to fit this browser window, keeping its aspect. */
  private fit() {
    const { w, h } = this.size;
    if (!w || !h) return;
    const vw = this.host.clientWidth;
    const vh = this.host.clientHeight;
    this.scale = Math.min(vw / w, vh / h);
    const left = Math.max(0, (vw - w * this.scale) / 2);
    const top = Math.max(0, (vh - h * this.scale) / 2);
    this.stage.style.transform = `translate(${left}px, ${top}px) scale(${this.scale})`;
  }

  /** Window coordinates of a pointer event. */
  private point(e: MouseEvent): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) / this.scale), y: Math.round((e.clientY - r.top) / this.scale) };
  }

  private bindInput() {
    const el = this.host;
    this.listen(el, 'pointermove', (e) => {
      // At most one motion per animation frame.
      const first = !this.pending;
      this.pending = this.point(e);
      if (first)
        requestAnimationFrame(() => {
          if (this.pending) this.send({ cmd: 'pointer', ...this.pending });
          this.pending = undefined;
        });
    });
    this.listen(el, 'pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.send({ cmd: 'button', ...this.point(e), button: BUTTONS[e.button] ?? 1, down: true });
      e.preventDefault();
    });
    this.listen(el, 'pointerup', (e) => {
      this.send({ cmd: 'button', ...this.point(e), button: BUTTONS[e.button] ?? 1, down: false });
    });
    this.listen(el, 'contextmenu', (e) => e.preventDefault());
    this.listen(
      el,
      'wheel',
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? WHEEL_STEP : e.deltaMode === 2 ? WHEEL_STEP * 10 : 1;
        this.wheel.x += e.deltaX * unit;
        this.wheel.y += e.deltaY * unit;
        const dx = Math.trunc(this.wheel.x / WHEEL_STEP);
        const dy = Math.trunc(this.wheel.y / WHEEL_STEP);
        if (!dx && !dy) return;
        this.wheel.x -= dx * WHEEL_STEP;
        this.wheel.y -= dy * WHEEL_STEP;
        this.send({ cmd: 'wheel', ...this.point(e), dx, dy });
      },
      { passive: false },
    );
    const key = (down: boolean) => (e: KeyboardEvent) => {
      // Command-key shortcuts stay with the browser (close, copy, reload).
      if (e.metaKey) return;
      const keycode = xKeycode(e.code);
      if (keycode === undefined) return;
      e.preventDefault();
      this.send({ cmd: 'key', keycode, down });
    };
    this.listen(window, 'keydown', key(true));
    this.listen(window, 'keyup', key(false));
    this.listen(window, 'focus', () => this.send({ cmd: 'focus' }));
    // Keys held when focus leaves would stay pressed in the program.
    this.listen(window, 'blur', () => this.send({ cmd: 'release' }));
  }
}
