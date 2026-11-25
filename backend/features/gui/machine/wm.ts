// The window manager's side on the node (the Go agent's guiwm.go,
// guiframes.go, guiclients.go and guiwm_video.go): the GUI helper is the X
// client (it manages the windows, reports their damage, captures and
// encodes what this asks for and replays input); this decides what is
// sent, when and to whom.
//
// Several cores attach, one stream each: one controls the windows, the
// others view them. Every client gets every window's events and the frames
// of the windows it watches. Input, focus and closing come from the
// controller only; a viewer asks for control (command control) and gets it
// at once, the controller then viewing. When the controller leaves, the
// client attached longest takes over. Each client learns its role from a
// role event.
//
// Every TICK the pump collects what changed in watched windows, as far as
// their flow allows (flow.ts), and has the helper capture and encode it;
// the frames go to their clients in order. Frames go through a queue per
// client. A window's flow is paced by one client, its pacer: the
// controller while it watches the window, else the client attached longest
// that does. The pacer's acknowledgements make the window's flow and its
// frames wait for room in the pacer's queue; another client's frames that
// do not fit its queue are dropped, and the window is sent to it again in
// full (a key frame for video) once its queue has room. A client whose
// events do not fit its queue is closed: it attaches again.
//
// Video: while a watched window's viewers all decode video, the machine
// has an encoder, and most recent ticks changed a large part of the
// window, its changes are sent as frames of a video stream of the whole
// window instead of pictures of the changed area. Once it stops changing,
// settling sends it again as PNG (video blurs colored text). Layers stay
// pictures. The stream ends after VIDEO_IDLE without changes, when viewers
// change, the window is resized (a new one starts) or the encoder fails
// (pictures until the retry delay has passed).
import type { GUICommand } from '#shared/proto/agentproto/index.ts';
import { GUIEnc, GUIMessage, marshalFrameHeader } from '#shared/proto/agentproto/index.ts';
import type { Logger } from '#shared/lib/log.ts';
import { Flow, NO_RECT, after, clip, isEmpty, tiles, union, type Rect } from './flow.ts';
import { Enc, In, Out, encodeJobs, input, message, type HFrame, type HelperMessage, type Job } from './helper.ts';

/** The shortest interval between frames (60 per second). */
export const TICK = 16;
/** How long a window must stay unchanged before areas sent as JPEG are
 * sent again losslessly. */
export const SETTLE = 400;
/** Smaller updates are sent as PNG. */
export const PNG_AREA = 128 * 128;
/** How often a watched window's costs are reported. */
export const STATS_EVERY = 1000;
/** A window is sent as video once VIDEO_MOTION_TICKS of the last 12 ticks
 * changed at least 1/VIDEO_MOTION_SHARE of it, until it was unchanged for
 * VIDEO_IDLE. Smaller windows stay pictures. */
export const VIDEO_MOTION_TICKS = 8;
export const VIDEO_MOTION_SHARE = 4;
export const VIDEO_IDLE = 5000;
export const VIDEO_MIN_SIDE = 64;
/** Larger windows stay pictures: encoders take at most 4096 (NVENC's
 * H.264). */
export const VIDEO_MAX_SIDE = 4096;
/** After the encoder failed, pictures for VIDEO_RETRY, doubling up to
 * VIDEO_RETRY_MAX. */
export const VIDEO_RETRY = 5000;
export const VIDEO_RETRY_MAX = 5 * 60_000;
/** A client's queued messages, at most. */
export const QUEUE = 256;

/** A window whose contents are captured. */
class XWin {
  /** Changed, not sent yet. */
  dirty: Rect = NO_RECT;
  /** Sent as JPEG since the last lossless update. */
  lossy: Rect = NO_RECT;
  /** When it last changed (0: never). */
  changed = 0;

  readonly id: number;
  w: number;
  h: number;

  constructor(id: number, w: number, h: number) {
    this.id = id;
    this.w = w;
    this.h = h;
  }

  all(): Rect {
    return { x: 0, y: 0, w: this.w, h: this.h };
  }
}

/** A running video stream: the helper's encoder of one window size. */
export interface Vid {
  id: number;
  w: number;
  h: number;
  /** What it was started for, in order. */
  kinds: string[];
  /** h264_nvenc, h264_vaapi, libvpx. */
  name: string;
}

export interface Stats {
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
  budget?: number;
  rtt_us?: number;
  latency_us: number;
  acked: number;
  video?: number;
  encoder?: string;
  fallback?: string;
}

const noStats = (): Stats => ({
  window: 0,
  interval_us: 0,
  updates: 0,
  frames: 0,
  jpeg: 0,
  png: 0,
  pixels: 0,
  bytes: 0,
  capture_us: 0,
  convert_us: 0,
  encode_us: 0,
  waits: 0,
  latency_us: 0,
  acked: 0,
});

export class Win extends XWin {
  title = '';
  terminal = '';
  pid = 0;
  transient = 0;
  layers: number[] = [];
  watched = false;
  seq = 0;
  acked = 0;
  stats: Stats = noStats();
  /** Start of the stats interval. */
  since = 0;
  flow = new Flow();
  /** The stream kinds all viewers decode. */
  codecs: string[] = [];
  /** Whose acknowledgements pace the window. */
  pacer: Client | null = null;
  vid: Vid | null = null;
  /** Which recent ticks changed much of the window, a bit each. */
  motion = 0;
  lastVideo = 0;
  keyWanted = false;
  vidRetry = 0;
  vidFails = 0;
  fallback = '';
}

export class Layer extends XWin {
  owner: number;
  x: number;
  y: number;

  constructor(id: number, owner: number, x: number, y: number, w: number, h: number) {
    super(id, w, h);
    this.owner = owner;
    this.x = x;
    this.y = y;
  }
}

/** One message of a client's stream. */
export interface Msg {
  kind: number;
  parts: Uint8Array[];
}

/** Writes a client's messages (its attach stream). */
export interface ClientConn {
  write(m: Msg): Promise<void>;
  close(): void;
}

/** One core's attach stream. */
export class Client {
  readonly q: Msg[] = [];
  closed = false;
  private writing = false;
  private room: Array<() => void> = [];
  private ended: Array<() => void> = [];
  /** The windows it watches with the video codecs it decodes, the windows
   * whose frames were dropped (sent in full again once its queue has
   * room), and per window the first frame that is for it. */
  readonly watched = new Map<number, string[]>();
  readonly stale = new Set<number>();
  readonly from = new Map<number, number>();
  control = false;

  /** The agent session it came through, and its core ("" unknown). */
  readonly session: number;
  readonly name: string;
  private readonly conn: ClientConn;

  constructor(session: number, name: string, conn: ClientConn) {
    this.session = session;
    this.name = name;
    this.conn = conn;
  }

  /** Queues m without waiting; false when the queue is full or the client
   * closed. */
  offer(m: Msg): boolean {
    if (this.closed || this.q.length >= QUEUE) return false;
    this.q.push(m);
    void this.writeLoop();
    return true;
  }

  /** Queues m, waiting for room; false when the client closed. */
  async put(m: Msg, wmEnded: () => boolean): Promise<boolean> {
    while (!this.closed && this.q.length >= QUEUE && !wmEnded()) await new Promise<void>((r) => this.room.push(r));
    if (this.closed || wmEnded()) return false;
    this.q.push(m);
    void this.writeLoop();
    return true;
  }

  /** Queues an event; a client that cannot take it is closed. */
  event(ev: object): void {
    if (!this.offer({ kind: GUIMessage.JSON, parts: [Buffer.from(JSON.stringify(ev))] })) this.close();
  }

  private wakeRoom(): void {
    const w = this.room;
    this.room = [];
    for (const f of w) f();
  }

  private async writeLoop(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (!this.closed && this.q.length > 0) {
        const m = this.q.shift()!;
        this.wakeRoom();
        await this.conn.write(m);
      }
    } catch {
      this.close();
    } finally {
      this.writing = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.q.length = 0;
    this.wakeRoom();
    this.conn.close();
    for (const f of this.ended.splice(0)) f();
  }

  /** Resolves once the client closed. */
  done(): Promise<void> {
    return this.closed ? Promise.resolve() : new Promise((r) => this.ended.push(r));
  }
}

/** A capture taken this tick. */
export interface Capture {
  window: number;
  layer: number;
  r: Rect;
  lossless: boolean;
  seq: number;
  /** A video frame of the whole window: of the window's stream, or a new
   * stream of one of kinds when vid is null; key asks for a key frame. */
  video?: boolean;
  vid?: Vid | null;
  kinds?: string[];
  key?: boolean;
  /** The stream the helper encodes it with. */
  stream?: number;
}

/** What capturing and encoding one frame took (the helper's frame). */
export interface FrameCost {
  window: number;
  captureUs: number;
  convertUs: number;
  encodeUs: number;
  pixels: number;
  bytes: number;
  enc: number;
  /** Video: the stream used, one that was started for the frame, or the
   * error that ended the window's video. */
  vid?: Vid | null;
  started?: Vid;
  vidErr?: string;
}

export interface WMOptions {
  /** Sends a message to the helper. */
  send(b: Buffer): void;
  /** The encoder and the stream kinds it makes (none: pictures only). */
  tools?: () => { bin: string; kinds: string[] };
  logger: Logger;
  /** Milliseconds, monotonic. */
  now?: () => number;
}

/** GUIWindow as the Go agent wrote it. */
function windowEvent(m: Win): object {
  const w: Record<string, unknown> = { id: m.id, title: m.title, w: m.w, h: m.h };
  if (m.pid) w.pid = m.pid;
  if (m.terminal) w.terminal = m.terminal;
  if (m.transient) w.transient = m.transient;
  return { ev: 'window', window: w };
}

function videoEvent(window: number, codec = '', encoder = '', w = 0, h = 0): object {
  return { ev: 'video', video: { window, codec, encoder, w, h } };
}

const popcount12 = (v: number) => {
  let n = 0;
  for (let b = v & 0xfff; b; b &= b - 1) n++;
  return n;
};

export class WindowManager {
  readonly wins = new Map<number, Win>();
  readonly layers = new Map<number, Layer>();
  clients: Client[] = [];
  cursor: { png: string; xhot: number; yhot: number } | null = null;
  /** Streams to end after the current frames. */
  retired: Vid[] = [];
  /** The helper captures through shared memory. */
  shm = false;
  private streamSeq = 0;
  /** The encoder the helper was told to start streams with. */
  private encoder = '';
  private ended_ = false;
  private readonly endWaiters: Array<() => void> = [];
  private readonly now: () => number;
  /** The jobs of the batch the helper works on, and its frames' costs. */
  private batch: { jobs: Capture[]; next: number; costs: FrameCost[]; done: () => void } | null = null;
  private frames: Promise<void> = Promise.resolve();

  private readonly o: WMOptions;

  constructor(o: WMOptions) {
    this.o = o;
    this.now = o.now ?? (() => performance.now());
  }

  get ended(): boolean {
    return this.ended_;
  }

  /** Ends the window manager: its clients are closed. */
  end(): void {
    if (this.ended_) return;
    this.ended_ = true;
    for (const c of [...this.clients]) c.close();
    this.batch?.done();
    for (const f of this.endWaiters.splice(0)) f();
  }

  private send(b: Buffer): void {
    if (!this.ended_) this.o.send(b);
  }

  // What the helper says.

  /** Applies a message of the helper. Frames are applied in order, each
   * after the previous one reached its clients. */
  onHelper(m: HelperMessage): void {
    switch (m.t) {
      case Out.Ready:
        this.shm = m.shm;
        return;
      case Out.Window: {
        let w = this.wins.get(m.id);
        if (!w) {
          w = new Win(m.id, m.w, m.h);
          w.dirty = w.all();
          this.wins.set(m.id, w);
        } else if (m.w !== w.w || m.h !== w.h) {
          w.w = m.w;
          w.h = m.h;
          w.dirty = w.all();
        }
        w.title = m.title;
        w.terminal = m.terminal;
        w.pid = m.pid;
        w.transient = m.transient;
        this.emit(windowEvent(w));
        return;
      }
      case Out.Gone: {
        const w = this.wins.get(m.id);
        if (!w) return;
        this.wins.delete(m.id);
        if (w.vid) {
          this.retired.push(w.vid);
          w.vid = null;
        }
        for (const id of w.layers) {
          const l = this.layers.get(id);
          if (l) l.owner = 0;
        }
        this.emit({ ev: 'gone', id: m.id });
        return;
      }
      case Out.Layer: {
        let l = this.layers.get(m.id);
        if (!l) {
          l = new Layer(m.id, m.owner, m.x, m.y, m.w, m.h);
          l.dirty = l.all();
          this.layers.set(m.id, l);
          const owner = this.wins.get(m.owner);
          if (owner && !owner.layers.includes(m.id)) owner.layers.push(m.id);
        } else {
          const resized = m.w !== l.w || m.h !== l.h;
          Object.assign(l, { x: m.x, y: m.y, w: m.w, h: m.h });
          if (resized) l.dirty = l.all();
        }
        this.emitLayer(l);
        return;
      }
      case Out.LayerGone: {
        const l = this.layers.get(m.id);
        if (!l) return;
        this.layers.delete(m.id);
        const owner = this.wins.get(l.owner);
        if (owner) {
          owner.layers = owner.layers.filter((x) => x !== m.id);
          this.emit({ ev: 'layer_gone', layer: { id: m.id, window: l.owner, x: 0, y: 0, w: 0, h: 0 }, id: m.id });
        }
        return;
      }
      case Out.Damage: {
        const now = this.now();
        for (const d of m.rects) {
          const w = this.wins.get(d.drawable) ?? this.layers.get(d.drawable);
          if (!w) continue;
          w.dirty = union(w.dirty, { x: d.x, y: d.y, w: d.w, h: d.h });
          w.changed = now;
        }
        return;
      }
      case Out.Cursor:
        this.cursor = { png: m.png.toString('base64'), xhot: m.xhot, yhot: m.yhot };
        this.emit(this.cursorEvent()!);
        return;
      case Out.Frame:
        this.frames = this.frames.then(() => this.onFrame(m));
        return;
      case Out.BatchDone:
        this.frames = this.frames.then(() => this.batch?.done());
        return;
    }
  }

  private cursorEvent(): object | null {
    return this.cursor && { ev: 'cursor', cursor: this.cursor };
  }

  private layerEvent(l: Layer): object | null {
    if (!this.wins.has(l.owner)) return null;
    return { ev: 'layer', layer: { id: l.id, window: l.owner, x: l.x, y: l.y, w: l.w, h: l.h } };
  }

  private emitLayer(l: Layer): void {
    const ev = this.layerEvent(l);
    if (ev) this.emit(ev);
  }

  /** Sends ev to every client. */
  private emit(ev: object): void {
    for (const c of this.clients) c.event(ev);
  }

  // Clients.

  /** Adds client c, announces what exists and runs until it leaves: a
   * newer client of the same core replaces an older one (after a
   * reconnect), with its role. */
  attach(c: Client): Promise<void> {
    if (this.ended_) {
      c.close();
      return Promise.resolve();
    }
    for (const o of [...this.clients]) {
      if (o.session === c.session || (c.name !== '' && o.name === c.name)) {
        c.control ||= o.control;
        o.close();
        this.drop(o);
      }
    }
    this.clients.push(c);
    if (!this.controller()) c.control = true;
    this.announce(c);
    return c.done().then(() => this.drop(c));
  }

  /** Tells a new client its role, the windows, their layers and the
   * pointer. */
  private announce(c: Client): void {
    c.event(c.control ? { ev: 'role', control: true } : { ev: 'role' });
    for (const m of this.wins.values()) c.event(windowEvent(m));
    for (const l of this.layers.values()) {
      const ev = this.layerEvent(l);
      if (ev) c.event(ev);
    }
    const cur = this.cursorEvent();
    if (cur) c.event(cur);
  }

  /** The client in control; null without clients. */
  controller(): Client | null {
    return this.clients.find((c) => c.control) ?? null;
  }

  /** Gives c control, the others viewing; held keys and buttons are let
   * go. */
  private setControl(c: Client): void {
    if (c.control) return;
    this.send(input.release());
    for (const o of this.clients) {
      const was = o.control;
      o.control = o === c;
      if (was !== o.control) o.event(o.control ? { ev: 'role', control: true } : { ev: 'role' });
    }
  }

  /** Removes client c: its windows are watched by the others only, and the
   * client attached longest takes control from a controller that left. */
  drop(c: Client): void {
    const i = this.clients.indexOf(c);
    if (i < 0) return;
    this.clients.splice(i, 1);
    for (const id of c.watched.keys()) {
      const m = this.wins.get(id);
      if (m) this.watchersChanged(m);
    }
    if (c.control && this.clients.length > 0) {
      c.control = false;
      this.setControl(this.clients[0]);
    }
  }

  /** Whether the window manager has no client left. */
  get idle(): boolean {
    return this.clients.length === 0;
  }

  /** Updates whether window m is watched and the video codecs all its
   * watchers decode. */
  private watchersChanged(m: Win): void {
    let codecs: string[] = [];
    let watched = false;
    for (const c of this.clients) {
      const cs = c.watched.get(m.id);
      if (!cs) continue;
      codecs = watched ? codecs.filter((k) => cs.includes(k)) : [...cs];
      watched = true;
    }
    m.watched = watched;
    m.codecs = codecs;
  }

  /** The client whose acknowledgements pace window m: the controller while
   * it watches m, else the client attached longest that does. */
  private pacer(m: Win): Client | null {
    const c = this.controller();
    if (c?.watched.has(m.id)) return c;
    return this.clients.find((x) => x.watched.has(m.id)) ?? null;
  }

  /** Starts window m's flow anew when its pacer changed: what was on its
   * way and what was measured were about another client. */
  private repace(m: Win): void {
    const p = this.pacer(m);
    if (p === m.pacer) return;
    m.pacer = p;
    m.acked = m.seq;
    m.flow = new Flow();
  }

  /** Sends window m in full to the clients whose frames were dropped, once
   * their queues have room. */
  private resend(m: Win): void {
    let full = false;
    for (const c of this.clients) {
      if (!c.stale.has(m.id) || c.q.length > QUEUE / 2) continue;
      if (!full) {
        full = true;
        m.keyWanted = true;
        this.refresh(m);
      }
      c.stale.delete(m.id);
      c.from.set(m.id, (m.seq + 1) >>> 0);
    }
  }

  /** The clients a frame of window w with sequence seq goes to, and
   * whether each paces the window. */
  private targets(w: number, seq: number): Array<{ c: Client; pace: boolean }> {
    const m = this.wins.get(w);
    if (!m) return [];
    const out = [];
    for (const c of this.clients) {
      if (!c.watched.has(w) || c.stale.has(w) || after(c.from.get(w) ?? 0, seq)) continue;
      out.push({ c, pace: c === m.pacer });
    }
    return out;
  }

  /** Queues a frame for its targets: the pacer waits for room, another
   * client that has none misses it and is sent the window again later. */
  private async deliver(w: number, ts: Array<{ c: Client; pace: boolean }>, msgs: Msg[]): Promise<void> {
    for (const t of ts) {
      for (const msg of msgs) {
        if (t.pace) {
          if (!(await t.c.put(msg, () => this.ended_))) break;
          continue;
        }
        if (!t.c.offer(msg)) {
          t.c.stale.add(w);
          break;
        }
      }
    }
  }

  // Commands of the cores.

  /** Applies a command of client cl. */
  command(cl: Client, c: GUICommand): void {
    switch (c.cmd) {
      case 'control':
        this.setControl(cl);
        return;
      case 'release':
        if (cl.control) this.send(input.release());
        return;
    }
    const m = this.wins.get(c.id);
    if (!m) return;
    switch (c.cmd) {
      case 'watch':
        if (!m.watched) {
          // A first viewer: nothing is on its way to anyone.
          m.acked = m.seq;
          m.flow = new Flow();
          m.pacer = null;
          m.stats = noStats();
          m.since = this.now();
        } else {
          // Another client: a stream it saw no start of ends, so the next
          // starts for every watcher.
          this.stopVideo(m);
        }
        cl.watched.set(m.id, c.codecs ?? []);
        cl.stale.delete(m.id);
        cl.from.set(m.id, (m.seq + 1) >>> 0);
        this.watchersChanged(m);
        m.keyWanted = true;
        this.refresh(m);
        return;
      case 'unwatch':
        cl.watched.delete(m.id);
        cl.stale.delete(m.id);
        this.watchersChanged(m);
        return;
      case 'codecs':
        if (cl.watched.has(m.id)) {
          cl.watched.set(m.id, c.codecs ?? []);
          this.watchersChanged(m);
        }
        return;
      case 'keyframe':
        m.keyWanted = true;
        return;
      case 'ack': {
        const seq = (c.seq ?? 0) >>> 0;
        if (cl === m.pacer && after(seq, m.acked) && !after(seq, m.seq)) {
          m.acked = seq;
          this.ackedAt(m, seq, this.now());
        }
        return;
      }
      case 'refresh':
        if (cl.watched.has(m.id)) {
          cl.watched.set(m.id, c.codecs ?? []);
          this.watchersChanged(m);
        }
        m.keyWanted = true;
        this.refresh(m);
        return;
    }
    if (!cl.control) return; // input is the controller's
    const x = c.x ?? 0;
    const y = c.y ?? 0;
    switch (c.cmd) {
      case 'focus':
        this.send(input.focus(m.id));
        return;
      case 'close':
        this.send(input.close(m.id));
        return;
      case 'pointer':
        this.send(input.pointer(m.id, x, y));
        return;
      case 'button':
        this.send(input.button(m.id, x, y, c.button ?? 0, !!c.down));
        return;
      case 'wheel':
        this.send(input.wheel(m.id, x, y, c.dx ?? 0, c.dy ?? 0));
        return;
      case 'key': {
        const k = c.keycode ?? 0;
        if (k >= 8 && k <= 255) this.send(input.key(m.id, k, !!c.down));
        return;
      }
    }
  }

  /** Marks a window and its layers for sending in full. */
  private refresh(m: Win): void {
    m.dirty = m.all();
    for (const id of m.layers) {
      const l = this.layers.get(id);
      if (l) {
        l.dirty = l.all();
        this.emitLayer(l);
      }
    }
  }

  /** Takes the frames up to seq off the inflight list, measuring the round
   * trip of seq and what was delivered meanwhile. */
  ackedAt(m: Win, seq: number, now: number): void {
    const f = m.flow;
    let n = 0;
    for (const s of f.inflight) {
      if (after(s.seq, seq)) break;
      f.bytes -= s.bytes;
      f.delivered += s.bytes;
      if (s.seq === seq) {
        const rtt = now - s.at;
        m.stats.latency_us += Math.round(rtt * 1000);
        m.stats.acked++;
        const d = Math.max(now - s.deliveredAt, s.at - s.firstSent);
        if (rtt > 0 && d > 0) f.sample(rtt, ((f.delivered - s.delivered) * 1000) / d, now);
        f.sentAt = s.at;
      }
      if (f.probing && s.seq === f.probeSeq) {
        // Sent with nothing else on its way: the round trip without a
        // queue, shorter or longer than before.
        f.minRTT = now - s.at;
        f.minRTTAt = now;
        f.probing = false;
        f.probeSeq = 0;
      }
      n++;
    }
    f.inflight.splice(0, n);
    f.ackedAt = now;
  }

  // The pump.

  /** Sends changed areas of watched windows at most every TICK until the
   * window manager ends. */
  async pump(): Promise<void> {
    while (!this.ended_) {
      const start = this.now();
      const jobs = this.collect(start);
      if (jobs.length > 0) await this.sendBatch(jobs);
      this.closeRetired();
      const wait = TICK - (this.now() - start);
      if (wait > 0 && !this.ended_)
        await new Promise<void>((r) => {
          const t = setTimeout(r, wait);
          this.endWaiters.push(() => {
            clearTimeout(t);
            r();
          });
        });
    }
    for (const m of this.wins.values())
      if (m.vid) {
        this.retired.push(m.vid);
        m.vid = null;
      }
    this.closeRetired();
  }

  /** Has the helper capture and encode jobs, and waits until their frames
   * went to their clients. */
  private async sendBatch(jobs: Capture[]): Promise<void> {
    const toHelper: Job[] = jobs.map((j) => {
      if (j.video) {
        if (!j.vid) j.stream = ++this.streamSeq;
        else j.stream = j.vid.id;
        return {
          window: j.window,
          drawable: j.layer,
          x: 0,
          y: 0,
          w: j.r.w,
          h: j.r.h,
          seq: j.seq,
          enc: Enc.Video,
          stream: j.stream,
          key: !!j.key,
          kinds: j.vid ? [] : (j.kinds ?? []),
        };
      }
      const enc = j.lossless || j.r.w * j.r.h < PNG_AREA ? Enc.PNG : Enc.JPEG;
      return { window: j.window, drawable: j.layer, x: j.r.x, y: j.r.y, w: j.r.w, h: j.r.h, seq: j.seq, enc };
    });
    const done = new Promise<void>((resolve) => (this.batch = { jobs, next: 0, costs: [], done: resolve }));
    // A stream starts with the encoder the machine has now.
    const bin = this.o.tools?.().bin ?? '';
    if (bin && bin !== this.encoder && toHelper.some((j) => j.kinds?.length)) {
      this.encoder = bin;
      this.send(message(In.Encoder, Buffer.from(bin)));
    }
    this.send(message(In.Capture, encodeJobs(toHelper)));
    await done;
    const costs = this.batch?.costs ?? [];
    this.batch = null;
    this.account(costs, this.now());
  }

  private async onFrame(f: HFrame): Promise<void> {
    const b = this.batch;
    if (!b) return;
    const j = b.jobs[b.next++];
    if (!j || j.seq !== f.seq || j.window !== f.window) {
      this.o.logger(`gui: the helper sent frame ${f.seq} of window ${f.window} out of order`);
      return;
    }
    const cost: FrameCost = {
      window: j.window,
      captureUs: f.captureUs,
      convertUs: 0,
      encodeUs: f.encodeUs,
      pixels: j.r.w * j.r.h,
      bytes: f.enc === Enc.None ? 0 : f.data.length,
      enc: f.enc,
      vid: j.vid,
    };
    if (j.video) {
      if (f.started) cost.started = { id: f.stream, w: j.r.w, h: j.r.h, kinds: j.kinds ?? [], name: f.started.name };
      if (f.error) cost.vidErr = f.error;
    } else if (f.error) this.o.logger(`gui: window ${f.window}: ${f.error}`);
    this.encoded(j, f.enc === Enc.None ? null : f.data.length, f.enc);
    if (f.enc !== Enc.None) {
      const ts = this.targets(j.window, j.seq);
      if (ts.length > 0) await this.deliver(j.window, ts, this.frameMsgs(j, f));
    }
    if (cost.enc !== Enc.None || cost.vidErr || cost.started) b.costs.push(cost);
  }

  /** The messages of a frame: the announcement of a video stream it
   * starts, then the frame. */
  private frameMsgs(j: Capture, f: HFrame): Msg[] {
    const msgs: Msg[] = [];
    if (f.started)
      msgs.push({
        kind: GUIMessage.JSON,
        parts: [Buffer.from(JSON.stringify(videoEvent(j.window, f.started.codec, f.started.name, f.started.w, f.started.h)))],
      });
    const enc = f.enc === Enc.VideoKey ? GUIEnc.VideoKey : f.enc;
    const h = marshalFrameHeader({ window: j.window, layer: j.layer, x: j.r.x, y: j.r.y, w: j.r.w, h: j.r.h, enc, seq: j.seq });
    msgs.push({ kind: GUIMessage.Frame, parts: [h, f.data] });
    return msgs;
  }

  /** Puts the size of an encoded frame in its window's flow, or takes a
   * frame that will not be sent off it (size null). */
  encoded(j: Capture, size: number | null, enc: number): void {
    const m = this.wins.get(j.window);
    if (!m) return;
    const f = m.flow;
    const i = f.inflight.findIndex((s) => s.seq === j.seq);
    if (i < 0) return;
    if (size === null) {
      f.bytes -= f.inflight[i].bytes;
      f.inflight.splice(i, 1);
      if (f.probeSeq === j.seq) f.probeSeq = 0; // the next frame probes
      return;
    }
    f.bytes += size - f.inflight[i].bytes;
    f.inflight[i].bytes = size;
    if (enc === Enc.Video || enc === Enc.VideoKey) {
      f.videoBytes = size;
    } else {
      const bpp = size / (j.r.w * j.r.h);
      f.bpp = f.bpp === 0 ? bpp : 0.8 * f.bpp + 0.2 * bpp;
    }
  }

  /** Adds frame costs to their windows' stats and reports the stats of
   * watched windows every STATS_EVERY. */
  account(costs: readonly FrameCost[], now: number): void {
    for (const c of costs) {
      const m = this.wins.get(c.window) ?? null;
      this.videoResult(m, c, now);
      if (!m || c.enc === Enc.None) continue;
      const st = m.stats;
      st.frames++;
      if (c.enc === Enc.JPEG) st.jpeg++;
      else if (c.enc === Enc.PNG) st.png++;
      else st.video = (st.video ?? 0) + 1;
      st.pixels += c.pixels;
      st.bytes += c.bytes;
      st.capture_us += c.captureUs;
      st.convert_us += c.convertUs;
      st.encode_us += c.encodeUs;
    }
    for (const m of this.wins.values()) {
      if (!m.watched || now - m.since < STATS_EVERY) continue;
      const s = m.stats;
      const ev = {
        window: m.id,
        interval_us: Math.round((now - m.since) * 1000),
        updates: s.updates,
        frames: s.frames,
        jpeg: s.jpeg,
        png: s.png,
        pixels: s.pixels,
        bytes: s.bytes,
        capture_us: s.capture_us,
        convert_us: s.convert_us,
        encode_us: s.encode_us,
        waits: s.waits,
      } as Stats;
      const budget = m.flow.budget();
      if (budget) ev.budget = budget;
      const rtt = Math.round(m.flow.minRTT * 1000);
      if (rtt) ev.rtt_us = rtt;
      ev.latency_us = s.latency_us;
      ev.acked = s.acked;
      if (s.video) ev.video = s.video;
      if (m.vid) ev.encoder = m.vid.name;
      if (m.fallback) ev.fallback = m.fallback;
      this.emit({ ev: 'stats', stats: ev });
      m.stats = noStats();
      m.since = now;
    }
  }

  /** Decides what each watched window sends this tick. */
  collect(now: number): Capture[] {
    const jobs: Capture[] = [];
    for (const m of this.wins.values()) {
      if (!m.watched) {
        this.stopVideo(m);
        continue;
      }
      this.repace(m);
      this.resend(m);
      this.trackMotion(m);
      let [room, slots] = m.flow.room(now);
      if (room <= 0 || slots <= 0) {
        if (this.changed(m)) m.stats.waits++;
        this.idleVideo(m, now);
        continue;
      }
      const f = m.flow;
      const take = (j: Capture, est: number) => {
        m.seq = (m.seq + 1) >>> 0;
        j.seq = m.seq;
        // After a pause the rate is measured from now, not from the last
        // acknowledgement.
        let from = f.ackedAt;
        let first = f.sentAt;
        if (f.inflight.length === 0 || from === 0) {
          from = now;
          first = now;
        }
        f.inflight.push({ seq: m.seq, at: now, bytes: est, delivered: f.delivered, deliveredAt: from, firstSent: first });
        if (f.probing && f.probeSeq === 0) f.probeSeq = m.seq;
        f.bytes += est;
        room -= est;
        slots--;
        jobs.push(j);
      };
      let sent = false;
      let ws: XWin[] = [m];
      const v = this.videoJob(m, now);
      if (v) {
        take(v, Math.max(f.videoBytes, 1));
        sent = true;
        m.stats.updates++;
        ws = []; // only its layers, as pictures
      }
      for (const id of m.layers) {
        const l = this.layers.get(id);
        if (l) ws.push(l);
      }
      for (const w of ws) {
        if (room <= 0 || slots <= 0) break;
        let r = clip(w.dirty, w.w, w.h);
        let lossless = false;
        if (isEmpty(r)) {
          // Settled: replace what was sent as JPEG.
          if (isEmpty(w.lossy) || now - w.changed < SETTLE) continue;
          r = clip(w.lossy, w.w, w.h);
          lossless = true;
          if (isEmpty(r)) {
            w.lossy = NO_RECT;
            continue;
          }
        }
        if (!sent) {
          sent = true;
          m.stats.updates++;
        }
        // What does not fit is sent at a later tick.
        let rest = NO_RECT;
        for (const t of tiles(r)) {
          if (room <= 0 || slots <= 0) {
            rest = union(rest, t);
            continue;
          }
          take({ window: m.id, layer: w.id, r: t, lossless, seq: 0 }, f.estimate(t));
          if (!lossless && t.w * t.h >= PNG_AREA) w.lossy = union(w.lossy, t);
        }
        if (lossless) w.lossy = rest;
        else w.dirty = rest;
      }
    }
    return jobs;
  }

  /** Whether a window or one of its layers has changes not sent yet. */
  private changed(m: Win): boolean {
    if (!isEmpty(m.dirty)) return true;
    return m.layers.some((id) => {
      const l = this.layers.get(id);
      return !!l && !isEmpty(l.dirty);
    });
  }

  // Video.

  /** Records whether the window's pending changes cover a large part of it;
   * called once per tick. */
  private trackMotion(m: Win): void {
    const d = clip(m.dirty, m.w, m.h);
    const big = !isEmpty(d) && d.w * d.h * VIDEO_MOTION_SHARE >= m.w * m.h;
    m.motion = ((m.motion << 1) | (big ? 1 : 0)) & 0xffff;
  }

  /** The stream kinds both the viewers and the encoder handle, in the
   * viewers' order; notes why there are none. */
  private videoKindsFor(m: Win): string[] {
    m.fallback = '';
    if (m.codecs.length === 0) return [];
    const { bin, kinds } = this.o.tools?.() ?? { bin: '', kinds: [] };
    if (!bin) {
      m.fallback = 'unavailable';
      return [];
    }
    const out = m.codecs.filter((c) => kinds.includes(c));
    if (out.length === 0) m.fallback = 'no_codec';
    return out;
  }

  /** The window's next video frame, if it is (or now becomes) sent as video
   * and has changed. */
  private videoJob(m: Win, now: number): Capture | null {
    let kinds = this.videoKindsFor(m);
    if (kinds.length > 0 && (m.w > VIDEO_MAX_SIDE || m.h > VIDEO_MAX_SIDE)) {
      kinds = [];
      m.fallback = 'too_large';
    }
    if (m.vid && (m.vid.w !== m.w || m.vid.h !== m.h || !sameList(kinds, m.vid.kinds))) {
      // Resized, or the kinds changed: the viewers now decode a preferred
      // stream, or a viewer does not decode this one. A stream of a later
      // kind because the first would not open (all NVENC sessions in use)
      // is kept until it ends.
      this.stopVideo(m);
    }
    if (kinds.length === 0) {
      this.stopVideo(m);
      return null;
    }
    if (!m.vid) {
      if (now < m.vidRetry) {
        m.fallback = 'failed';
        return null;
      }
      if (popcount12(m.motion) < VIDEO_MOTION_TICKS || m.w < VIDEO_MIN_SIDE || m.h < VIDEO_MIN_SIDE) return null;
    }
    if (isEmpty(clip(m.dirty, m.w, m.h))) {
      if (m.vid && now - m.lastVideo > VIDEO_IDLE) this.stopVideo(m);
      return null;
    }
    const j: Capture = {
      window: m.id,
      layer: m.id,
      r: m.all(),
      lossless: false,
      seq: 0,
      video: true,
      vid: m.vid,
      kinds,
      key: m.keyWanted || !m.vid,
    };
    m.keyWanted = false;
    m.lastVideo = now;
    // Sent again as PNG once the window settles.
    m.dirty = NO_RECT;
    m.lossy = m.all();
    return j;
  }

  /** Ends the window's stream after VIDEO_IDLE without frames, also while
   * its flow holds frames back (a viewer that stopped acknowledging must
   * not keep an encoder and its GPU session). */
  private idleVideo(m: Win, now: number): void {
    if (m.vid && now - m.lastVideo > VIDEO_IDLE) this.stopVideo(m);
  }

  /** Ends the window's stream: the helper closes the encoder, browsers drop
   * their decoder. */
  private stopVideo(m: Win): void {
    if (!m.vid) return;
    this.retired.push(m.vid);
    m.vid = null;
    this.emit(videoEvent(m.id));
  }

  /** Applies what sending a video frame did to window m (null when it is
   * gone): a started encoder becomes its stream, a failure sends it as
   * pictures until the retry delay. */
  private videoResult(m: Win | null, c: FrameCost, now: number): void {
    if (c.vidErr) {
      this.o.logger(`gui: video of window ${c.window}: ${c.vidErr}`);
      if (c.started) this.retired.push(c.started);
      if (!m) return;
      if (m.vid && c.vid && m.vid.id === c.vid.id) this.stopVideo(m);
      m.vidRetry = now + Math.min(VIDEO_RETRY * 2 ** Math.min(m.vidFails, 10), VIDEO_RETRY_MAX);
      m.vidFails++;
      m.fallback = 'failed';
      m.dirty = m.all();
      return;
    }
    if (!c.started) return;
    if (!m || !m.watched || m.vid) {
      this.retired.push(c.started);
      if (m && !m.vid) this.emit(videoEvent(m.id));
      return;
    }
    m.vid = c.started;
    m.vidFails = 0;
  }

  private closeRetired(): void {
    for (const v of this.retired.splice(0)) {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(v.id >>> 0);
      this.send(message(In.VideoClose, b));
    }
  }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
