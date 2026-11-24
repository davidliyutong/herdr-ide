// The windows of one machine's display and the browser windows showing
// them: events and frames from the agent go to the viewers of their
// window, commands from viewers go to the agent, built here (a viewer only
// chooses which, and with which input fields). The fastest viewer paces
// the agent; one that falls behind skips frames and gets the whole window
// again (a key frame for video); a frame no viewer got is acknowledged
// here so that the agent does not wait for it.
import { GUIEnc, parseFrameHeader, type GUICommand, type GUILayer, type GUIWindow } from '#shared/proto/agentproto/index.ts';
import type { Limits, Timing } from './timing.ts';
import type { Viewer } from './viewer.ts';
import { parseAgentEvent, roleEvent, sharedCodecs, windowEvent, windowOf } from './wire.ts';

export interface RouterDeps {
  /** Queues a command for the agent; nothing while not attached. */
  send(c: GUICommand): void;
  /** Whether windows of the machine are sent as video (gui.video). */
  video(): boolean;
  now(): number;
  timing: Timing;
  limits: Limits;
}

/** The commands of viewers passed on to the agent as input, only from the
 * core in control and never in read-only mode. */
const INPUT = new Set(['focus', 'close', 'pointer', 'button', 'wheel', 'key', 'release']);

export class Router {
  /** The windows, in the order they appeared. */
  readonly windows = new Map<number, GUIWindow>();
  readonly layers = new Map<number, GUILayer>();
  /** The pointer image (the agent's cursor event). */
  cursor: string | null = null;
  /** Each window's current video stream (its video event), for viewers
   * that join; codecs: what its viewers were last said to decode. */
  readonly video = new Map<number, string>();
  readonly codecs = new Map<number, string>();
  readonly viewers = new Map<number, Set<Viewer>>();
  /** The highest frame of each window some viewer showed (or none got). */
  readonly acked = new Map<number, number>();
  /** Windows whose browser window was closed, closed after a grace. */
  private readonly closing = new Map<number, ReturnType<typeof setTimeout>>();
  /** Another core controls the windows (the agent's role event): input is
   * not passed on. */
  viewOnly = false;

  private readonly d: RouterDeps;

  constructor(d: RouterDeps) {
    this.d = d;
  }

  /** A new attachment: its window manager announces the windows anew,
   * numbers frames from the start and has no video streams yet. */
  attached(): void {
    this.viewOnly = false;
    this.windows.clear();
    this.layers.clear();
    this.acked.clear();
    this.video.clear();
    this.codecs.clear();
    for (const vs of this.viewers.values()) for (const v of vs) v.restart();
  }

  /** The attachment ended: no windows are shown until the next. */
  detached(): void {
    this.windows.clear();
  }

  /** Ends what runs (the close timers). */
  dispose(): void {
    for (const t of this.closing.values()) clearTimeout(t);
    this.closing.clear();
  }

  private viewersOf(id: number): Viewer[] {
    return [...(this.viewers.get(id) ?? [])];
  }

  private allViewers(): Viewer[] {
    return [...this.viewers.values()].flatMap((vs) => [...vs]);
  }

  /** Handles an event of the agent; true when the state pages see changed. */
  event(payload: Uint8Array): boolean {
    const ev = parseAgentEvent(payload);
    if (!ev) return false;
    let text: string | undefined;
    let changed = false;
    let targets: Viewer[] = [];
    switch (ev.ev) {
      case 'window': {
        if (!ev.window) break;
        const w = windowOf(ev.window);
        const isNew = !this.windows.has(w.id);
        // Viewers from before a reconnect.
        if (isNew && this.viewers.get(w.id)?.size) this.d.send({ cmd: 'watch', id: w.id, codecs: this.updateCodecs(w.id) });
        this.windows.set(w.id, w);
        text = windowEvent('window', w);
        if (isNew && w.transient) {
          // A dialog: the browser window showing its parent opens it, still
          // allowed to by the click that caused it.
          const child = windowEvent('child', w);
          for (const v of this.viewersOf(w.transient)) v.send(child);
        }
        changed = true;
        targets = this.viewersOf(w.id);
        break;
      }
      case 'gone':
        this.windows.delete(ev.id);
        this.video.delete(ev.id);
        this.codecs.delete(ev.id);
        for (const [id, l] of this.layers) if (l.window === ev.id) this.layers.delete(id);
        this.stopClosing(ev.id);
        changed = true;
        targets = this.viewersOf(ev.id);
        break;
      case 'layer':
        if (ev.layer) {
          this.layers.set(ev.layer.id, ev.layer);
          targets = this.viewersOf(ev.layer.window);
        }
        break;
      case 'layer_gone': {
        const l = this.layers.get(ev.id);
        if (l) {
          this.layers.delete(ev.id);
          targets = this.viewersOf(l.window);
        }
        break;
      }
      case 'cursor':
        this.cursor = Buffer.from(payload).toString('utf8');
        targets = this.allViewers();
        break;
      case 'stats':
        if (ev.stats) targets = this.viewersOf(ev.stats.window);
        break;
      case 'role':
        // This core controls the windows, or views them while another
        // does: every viewer is told.
        this.viewOnly = !ev.control;
        changed = true;
        targets = this.allViewers();
        break;
      case 'video':
        // A new stream, which starts with a key frame, or (no codec) the
        // end of the window's stream.
        if (ev.video && this.windows.has(ev.video.window)) {
          if (!ev.video.codec) this.video.delete(ev.video.window);
          else this.video.set(ev.video.window, Buffer.from(payload).toString('utf8'));
          targets = this.viewersOf(ev.video.window);
        }
        break;
    }
    if (targets.length) {
      text ??= Buffer.from(payload).toString('utf8');
      for (const v of targets) v.send(text);
    }
    return changed;
  }

  /** Passes a frame to the viewers of its window; a viewer that is behind
   * skips it and gets the whole window once it caught up. */
  frame(payload: Uint8Array): void {
    let h;
    try {
      h = parseFrameHeader(payload);
    } catch {
      return;
    }
    const video = h.enc === GUIEnc.Video || h.enc === GUIEnc.VideoKey;
    const now = this.d.now();
    const acked = this.acked.get(h.window) ?? 0;
    let delivered = false;
    for (const v of this.viewersOf(h.window)) {
      if (video && v.needKey && h.enc !== GUIEnc.VideoKey) {
        // Undecodable without the frames it missed.
        this.askKey(h.window, v, now);
        continue;
      }
      if (v.behind(acked, now, { ...this.d.timing, ...this.d.limits }) || !v.send(payload)) {
        if (video) v.needKey = true;
        else v.stale = true;
        continue;
      }
      if (h.enc === GUIEnc.VideoKey) v.needKey = false;
      v.sending(h.seq, payload.length, now);
      delivered = true;
    }
    if (!delivered && h.seq > acked) {
      this.acked.set(h.window, h.seq);
      this.d.send({ cmd: 'ack', id: h.window, seq: h.seq });
    }
  }

  /** Asks the agent for a key frame for a viewer that cannot decode the
   * window's video, once it has nothing in flight and at most every
   * refreshEveryMs. */
  private askKey(id: number, v: Viewer, now: number): void {
    if (v.sent.length > 0 || now - v.keyAsked < this.d.timing.refreshEveryMs) return;
    v.keyAsked = now;
    this.d.send({ cmd: 'keyframe', id });
  }

  /** The video streams every viewer of window id decodes; none while the
   * machine's windows are sent as pictures. */
  private codecsOf(id: number): string[] {
    if (!this.d.video()) return [];
    return sharedCodecs(this.viewersOf(id).map((v) => v.codecs));
  }

  /** Records what the viewers of window id decode, and returns it. */
  private updateCodecs(id: number): string[] {
    const c = this.codecsOf(id);
    this.codecs.set(id, c.join(','));
    return c;
  }

  /** Tells the agent what the viewers of each window decode where that
   * changed (the setting gui.video changed). */
  videoChanged(): void {
    for (const [id, vs] of this.viewers) {
      if (!vs.size) continue;
      const old = this.codecs.get(id) ?? '';
      const c = this.updateCodecs(id);
      if (this.codecs.get(id) !== old) this.d.send({ cmd: 'codecs', id, codecs: c });
    }
  }

  private stopClosing(id: number): void {
    const t = this.closing.get(id);
    if (t === undefined) return;
    clearTimeout(t);
    this.closing.delete(id);
  }

  /** Adds a viewer to window id and sends it what it needs to draw it;
   * false when the window does not exist. */
  attach(id: number, v: Viewer): boolean {
    const w = this.windows.get(id);
    if (!w) return false;
    this.stopClosing(id);
    v.send(windowEvent('window', w));
    if (this.cursor) v.send(this.cursor);
    v.send(roleEvent(!this.viewOnly));
    const stream = this.video.get(id);
    if (stream) {
      v.send(stream);
      v.needKey = true;
    }
    let vs = this.viewers.get(id);
    const first = !vs?.size;
    if (!vs) this.viewers.set(id, (vs = new Set()));
    vs.add(v);
    // The whole window, and a key frame to start decoding with.
    this.d.send({ cmd: first ? 'watch' : 'refresh', id, codecs: this.updateCodecs(id) });
    return true;
  }

  /** Removes a viewer. */
  detach(id: number, v: Viewer): void {
    const vs = this.viewers.get(id);
    if (!vs?.delete(v)) return;
    if (vs.size > 0) {
      // Those left may decode more.
      const old = this.codecs.get(id) ?? '';
      const c = this.updateCodecs(id);
      if (c.join(',') !== old) this.d.send({ cmd: 'codecs', id, codecs: c });
      return;
    }
    this.viewers.delete(id);
    this.codecs.delete(id);
    this.d.send({ cmd: 'release', id });
    this.d.send({ cmd: 'unwatch', id });
  }

  /** Closes a window whose browser window was closed: after closeGraceMs,
   * unless a viewer is still (or again, after a reload) showing it. */
  close(id: number): void {
    if (!this.windows.has(id) || this.closing.has(id)) return;
    this.closing.set(
      id,
      setTimeout(() => {
        this.closing.delete(id);
        if (!this.viewers.get(id)?.size && this.windows.has(id)) this.d.send({ cmd: 'close', id });
      }, this.d.timing.closeGraceMs),
    );
  }

  /** Handles a command of viewer v of window id. Input is passed on only
   * when allowed (input: not in read-only mode) and while this core
   * controls the windows. */
  command(id: number, v: Viewer, c: GUICommand, input: boolean): void {
    if (!this.viewers.get(id)?.has(v)) return;
    const now = this.d.now();
    switch (c.cmd) {
      case 'ack': {
        // Only frames this viewer was sent count; anything else would let
        // a viewer stall or speed up the window for everyone.
        const seq = c.seq ?? 0;
        if (!v.acked(seq)) return;
        if (seq > (this.acked.get(id) ?? 0)) {
          this.acked.set(id, seq);
          this.d.send({ cmd: 'ack', id, seq });
        }
        if (v.stale && v.sent.length === 0) {
          v.stale = false;
          this.d.send({ cmd: 'refresh', id, codecs: this.updateCodecs(id) });
        }
        if (v.needKey && this.video.has(id)) this.askKey(id, v, now);
        return;
      }
      case 'keyframe':
        // The browser could not decode the stream.
        if (this.video.has(id)) {
          v.needKey = true;
          this.askKey(id, v, now);
        }
        return;
      case 'refresh':
        if (now - v.refreshed >= this.d.timing.refreshEveryMs) {
          v.refreshed = now;
          this.d.send({ cmd: 'refresh', id, codecs: this.updateCodecs(id) });
        }
        return;
      case 'control':
        // Taken at once from the core in control, which then views.
        if (input && this.viewOnly) this.d.send({ cmd: 'control', id: 0 });
        return;
    }
    if (INPUT.has(c.cmd) && input && !this.viewOnly) {
      const { codecs: _, ...rest } = c;
      this.d.send({ ...rest, id });
    }
  }
}
