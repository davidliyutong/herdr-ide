import { describe, expect, test } from 'bun:test';
import { GUIEnc, marshalFrameHeader, parseFrameHeader, type GUICommand, type GUIEvent } from '#shared/proto/agentproto/index.ts';
import { sleep } from '#kernel/testing.ts';
import { Router } from './router.ts';
import { DEFAULT_LIMITS, DEFAULT_TIMING, type Timing } from './timing.ts';
import { Viewer } from './viewer.ts';

/** A router with one window (7), whose commands to the agent are kept. */
function attached(o: { video?: boolean; timing?: Partial<Timing> } = {}) {
  const cmds: GUICommand[] = [];
  let video = o.video ?? true;
  let now = 1_000_000;
  const r = new Router({
    send: (c) => void cmds.push(c),
    video: () => video,
    now: () => now,
    timing: { ...DEFAULT_TIMING, ...o.timing },
    limits: DEFAULT_LIMITS,
  });
  const ev = (e: GUIEvent | Record<string, unknown>) => r.event(Buffer.from(JSON.stringify(e)));
  ev({ ev: 'window', window: { id: 7, title: 'plot', w: 640, h: 480 } });
  return {
    r,
    cmds,
    ev,
    /** The next command, which must be there. */
    next(): GUICommand {
      const c = cmds.shift();
      if (!c) throw new Error('no command');
      return c;
    },
    setVideo: (on: boolean) => (video = on),
    advance: (ms: number) => (now += ms),
  };
}

/** A viewer that records what it gets; full refuses everything. */
function recorder(codecs: string[] = []) {
  const rec = { frames: [] as number[], events: [] as string[], full: false, last: undefined as unknown };
  const v = new Viewer((m) => {
    if (rec.full) return false;
    if (typeof m === 'string') {
      rec.last = JSON.parse(m);
      rec.events.push((rec.last as GUIEvent).ev);
    } else rec.frames.push(parseFrameHeader(m).seq);
    return true;
  }, codecs);
  return { rec, v };
}

const frame = (seq: number, enc: number = GUIEnc.PNG) => marshalFrameHeader({ window: 7, layer: 7, x: 0, y: 0, w: 1, h: 1, enc, seq });

describe('routing', () => {
  test('a reused window id starts its acknowledgements again', () => {
    const t = attached();
    const { v } = recorder();
    t.r.attach(7, v);
    t.next();
    t.r.frame(frame(100));
    t.r.command(7, v, { cmd: 'ack', id: 7, seq: 100 }, true);
    t.next();
    t.r.frame(frame(101));
    t.ev({ ev: 'gone', id: 7 });
    t.ev({ ev: 'window', window: { id: 7, title: 'new', w: 640, h: 480 } });
    expect(t.next().cmd).toBe('watch');
    t.r.frame(frame(1));
    t.r.command(7, v, { cmd: 'ack', id: 7, seq: 1 }, true);
    expect(t.next()).toEqual({ cmd: 'ack', id: 7, seq: 1 });
  });

  // The fastest viewer paces the agent; a viewer that falls behind skips
  // frames and gets the whole window once it caught up.
  test('frames', () => {
    const t = attached();
    const fast = recorder();
    const slow = recorder();
    expect(t.r.attach(7, fast.v)).toBe(true);
    expect(fast.rec.events).toEqual(['window', 'role']);
    expect(t.next()).toEqual({ cmd: 'watch', id: 7, codecs: [] });
    t.r.attach(7, slow.v);
    expect(t.next().cmd).toBe('refresh');
    expect(t.r.attach(8, new Viewer(() => true))).toBe(false);

    for (let seq = 1; seq <= 6; seq++) {
      t.r.frame(frame(seq));
      t.r.command(7, fast.v, { cmd: 'ack', id: 0, seq }, true);
      expect(t.next()).toEqual({ cmd: 'ack', id: 7, seq });
    }
    // A viewer a few frames behind gets them all.
    expect([fast.rec.frames.length, slow.rec.frames.length, slow.v.stale]).toEqual([6, 6, false]);
    // Once what it has not shown was shown elsewhere viewerLag ago, it
    // skips frames.
    t.advance(2 * DEFAULT_TIMING.viewerLagMs);
    t.r.frame(frame(7));
    t.r.command(7, fast.v, { cmd: 'ack', id: 0, seq: 7 }, true);
    t.next();
    expect([fast.rec.frames.length, slow.rec.frames.length, slow.v.stale]).toEqual([7, 6, true]);
    // Acks behind the fastest viewer are not forwarded; catching up asks
    // for the whole window.
    t.r.command(7, slow.v, { cmd: 'ack', id: 0, seq: 6 }, true);
    expect(t.next()).toMatchObject({ cmd: 'refresh', id: 7 });
    // Input is passed on only when allowed.
    t.r.command(7, fast.v, { cmd: 'key', id: 0, keycode: 38, down: true }, false);
    t.r.command(7, fast.v, { cmd: 'key', id: 99, keycode: 39, down: true }, true);
    expect(t.next()).toEqual({ cmd: 'key', id: 7, keycode: 39, down: true });
    expect(t.cmds).toEqual([]);
  });

  // While another hub controls the windows (role), viewers are told,
  // input is not passed on, and a viewer may take control.
  test('view only', () => {
    const t = attached();
    const { rec, v } = recorder();
    t.r.attach(7, v);
    t.next(); // watch
    expect(t.ev({ ev: 'role' })).toBe(true);
    expect([rec.events.at(-1), rec.last, t.r.viewOnly]).toEqual(['role', { ev: 'role' }, true]);
    t.r.command(7, v, { cmd: 'key', id: 0, keycode: 38, down: true }, true);
    t.r.command(7, v, { cmd: 'control', id: 0 }, false); // read-only
    t.r.command(7, v, { cmd: 'control', id: 7 }, true);
    expect(t.next()).toEqual({ cmd: 'control', id: 0 });
    t.ev({ ev: 'role', control: true });
    t.r.command(7, v, { cmd: 'key', id: 0, keycode: 39, down: true }, true);
    expect(t.next()).toMatchObject({ cmd: 'key', keycode: 39 });
    // A viewer joining is told the role.
    const late = recorder();
    t.ev({ ev: 'role' });
    t.r.attach(7, late.v);
    expect(late.rec.last).toEqual({ ev: 'role' });
  });

  // A window's stats go to the browser windows showing it, not to others.
  test('stats', () => {
    const t = attached();
    const { rec, v } = recorder();
    t.r.attach(7, v);
    t.ev({ ev: 'stats', stats: { window: 8, frames: 3 } });
    t.ev({ ev: 'stats', stats: { window: 7, frames: 3 } });
    expect(rec.events).toEqual(['window', 'role', 'stats']);
    expect(rec.last).toEqual({ ev: 'stats', stats: { window: 7, frames: 3 } });
  });

  // Video goes to windows whose viewers all decode it; a viewer that
  // missed a frame of the stream gets nothing until a key frame, which is
  // asked for once it caught up.
  test('video', () => {
    const t = attached();
    const a = recorder(['vp8', 'avc1']);
    const b = recorder(['vp8']);
    t.r.attach(7, a.v);
    expect(t.next()).toEqual({ cmd: 'watch', id: 7, codecs: ['avc1', 'vp8'] });
    t.r.attach(7, b.v);
    expect(t.next()).toEqual({ cmd: 'refresh', id: 7, codecs: ['vp8'] });
    t.ev({ ev: 'video', video: { window: 7, codec: 'vp8', w: 640, h: 480 } });
    expect([a.rec.events.at(-1), b.rec.events.at(-1)]).toEqual(['video', 'video']);
    const ack = (v: Viewer, seq: number) => t.r.command(7, v, { cmd: 'ack', id: 0, seq }, true);
    t.r.frame(frame(1, GUIEnc.VideoKey));
    ack(a.v, 1);
    t.next(); // ack 1
    b.rec.full = true;
    t.r.frame(frame(2, GUIEnc.Video)); // b misses it
    b.rec.full = false;
    ack(a.v, 2);
    t.next(); // ack 2
    t.r.frame(frame(3, GUIEnc.Video));
    ack(a.v, 3);
    t.next(); // ack 3
    expect(b.rec.frames).toEqual([1]);
    ack(b.v, 1); // caught up: a key frame is asked for
    expect(t.next()).toEqual({ cmd: 'keyframe', id: 7 });
    t.r.frame(frame(4, GUIEnc.VideoKey));
    t.r.frame(frame(5, GUIEnc.Video));
    expect([a.rec.frames, b.rec.frames]).toEqual([
      [1, 2, 3, 4, 5],
      [1, 4, 5],
    ]);

    // The viewer left decodes more.
    t.r.detach(7, b.v);
    expect(t.next()).toEqual({ cmd: 'codecs', id: 7, codecs: ['avc1', 'vp8'] });
    // A viewer joining a running stream starts with it.
    const late = recorder(['vp8']);
    t.r.attach(7, late.v);
    expect([late.rec.events.at(-1), late.v.needKey]).toEqual(['video', true]);
    // The stream ends: viewers joining later get pictures.
    t.ev({ ev: 'video', video: { window: 7 } });
    expect(t.r.video.has(7)).toBe(false);
  });

  // Without video for the machine agents are told no viewer decodes it;
  // turning it off or on tells the agent at once which streams the
  // viewers of each window share.
  test('video off and setting changes', () => {
    const off = attached({ video: false });
    off.r.attach(7, recorder(['avc1']).v);
    expect(off.next()).toEqual({ cmd: 'watch', id: 7, codecs: [] });

    const t = attached();
    t.r.attach(7, recorder(['avc1']).v);
    expect(t.next()).toEqual({ cmd: 'watch', id: 7, codecs: ['avc1'] });
    t.setVideo(false);
    t.r.videoChanged();
    expect(t.next()).toEqual({ cmd: 'codecs', id: 7, codecs: [] });
    t.r.videoChanged();
    expect(t.cmds).toEqual([]);
    t.setVideo(true);
    t.r.videoChanged();
    expect(t.next()).toEqual({ cmd: 'codecs', id: 7, codecs: ['avc1'] });
  });

  // Commands reaching the agent are the hub's: a viewer's refresh carries
  // the streams all viewers decode, not its own list, an acknowledgement
  // only its number, and the refresh after catching up the streams too.
  test('viewer commands', () => {
    const t = attached();
    const a = recorder(['avc1', 'vp8']);
    const b = recorder(['vp8']);
    t.r.attach(7, a.v);
    t.next(); // watch
    t.r.attach(7, b.v);
    t.next(); // refresh
    t.r.command(7, a.v, { cmd: 'refresh', id: 0, codecs: ['avc1'] }, true);
    expect(t.next()).toEqual({ cmd: 'refresh', id: 7, codecs: ['vp8'] });
    t.r.frame(frame(1));
    t.r.command(7, a.v, { cmd: 'ack', id: 0, seq: 1, codecs: ['avc1'], x: 5 }, true);
    expect(t.next()).toEqual({ cmd: 'ack', id: 7, seq: 1 });
    // b fell behind: it skips frames, then catches up.
    t.advance(2 * DEFAULT_TIMING.viewerLagMs);
    t.r.frame(frame(2));
    expect(b.v.stale).toBe(true);
    t.r.command(7, a.v, { cmd: 'ack', id: 0, seq: 2 }, true);
    t.next(); // ack 2
    t.r.command(7, b.v, { cmd: 'ack', id: 0, seq: 1 }, true);
    expect(t.next()).toEqual({ cmd: 'refresh', id: 7, codecs: ['vp8'] });
    // A viewer holding viewerMaxBytes unshown skips frames.
    b.v.sentBytes = DEFAULT_LIMITS.viewerMaxBytes;
    expect(b.v.behind(0, 0, { ...DEFAULT_TIMING, ...DEFAULT_LIMITS })).toBe(true);
  });

  // A viewer can acknowledge only frames it was sent, and cannot have the
  // window sent in full more often than refreshEvery.
  test('abuse', () => {
    const t = attached();
    const { v } = recorder();
    t.r.attach(7, v);
    t.next(); // watch
    t.r.frame(frame(1));
    t.r.command(7, v, { cmd: 'ack', id: 0, seq: 4294967295 }, false);
    t.r.command(7, v, { cmd: 'ack', id: 0, seq: 2 }, false);
    for (let i = 0; i < 5; i++) t.r.command(7, v, { cmd: 'refresh', id: 0 }, false);
    t.r.command(7, v, { cmd: 'ack', id: 0, seq: 1 }, false);
    expect(t.cmds).toEqual([
      { cmd: 'refresh', id: 7, codecs: [] },
      { cmd: 'ack', id: 7, seq: 1 },
    ]);
    t.cmds.length = 0;
    expect(t.r.acked.get(7)).toBe(1);
    // A viewer that is not one of the window's is ignored.
    t.r.command(7, new Viewer(() => true), { cmd: 'refresh', id: 0 }, true);
    expect(t.cmds).toEqual([]);
    // A frame no viewer got is acknowledged by the hub.
    t.r.detach(7, v);
    expect(t.cmds.splice(0)).toEqual([
      { cmd: 'release', id: 7 },
      { cmd: 'unwatch', id: 7 },
    ]);
    t.r.frame(frame(2));
    expect(t.next()).toEqual({ cmd: 'ack', id: 7, seq: 2 });
  });

  // Closing a browser window closes the program window after a grace
  // period, unless the browser window comes back (a reload).
  test('close grace', async () => {
    const t = attached({ timing: { closeGraceMs: 30 } });
    const { v } = recorder();
    t.r.attach(7, v);
    t.next(); // watch
    t.r.close(7); // the request may arrive before the WebSocket closes
    t.r.detach(7, v);
    expect(t.cmds.splice(0).map((c) => c.cmd)).toEqual(['release', 'unwatch']);
    const v2 = recorder().v;
    t.r.attach(7, v2); // reloaded within the grace period
    expect(t.next().cmd).toBe('watch');
    await sleep(100);
    expect(t.cmds).toEqual([]);

    t.r.close(7);
    t.r.detach(7, v2);
    t.cmds.splice(0);
    await sleep(100);
    expect(t.cmds).toEqual([{ cmd: 'close', id: 7 }]);
  });

  // Windows, layers, dialogs and the pointer: what each viewer gets, and
  // what the state shows.
  test('windows and layers', () => {
    const t = attached();
    const { rec, v } = recorder();
    t.r.attach(7, v);
    t.next();
    // An update keeps the window's place; a dialog opens from its parent.
    expect(t.ev({ ev: 'window', window: { id: 9, title: 'other', w: 1, h: 1, pid: 0, terminal: '' } })).toBe(true);
    expect(t.ev({ ev: 'window', window: { id: 7, title: 'plot 2', w: 640, h: 480, pid: 42 } })).toBe(true);
    expect([...t.r.windows.values()]).toEqual([
      { id: 7, title: 'plot 2', w: 640, h: 480, pid: 42 },
      { id: 9, title: 'other', w: 1, h: 1 },
    ]);
    expect(rec.last).toEqual({ ev: 'window', window: { id: 7, title: 'plot 2', w: 640, h: 480, pid: 42 } });
    t.ev({ ev: 'window', window: { id: 10, title: 'Save', w: 2, h: 2, transient: 7 } });
    expect(rec.last).toEqual({ ev: 'child', window: { id: 10, title: 'Save', w: 2, h: 2, transient: 7 } });
    expect(t.ev({ ev: 'layer', layer: { id: 20, window: 7, x: 1, y: 2, w: 3, h: 4 } })).toBe(false);
    expect(rec.events.at(-1)).toBe('layer');
    t.ev({ ev: 'cursor', cursor: { png: 'AA==', xhot: 1, yhot: 1 } });
    expect(rec.last).toEqual({ ev: 'cursor', cursor: { png: 'AA==', xhot: 1, yhot: 1 } });
    t.ev({ ev: 'layer_gone', id: 20 });
    expect(rec.last).toEqual({ ev: 'layer_gone', id: 20 });
    // An event that does not parse is ignored.
    expect(t.r.event(Buffer.from('{"ev":"window","window":{"id":"x"}}'))).toBe(false);
    expect(t.r.event(Buffer.from('nope'))).toBe(false);
    // Gone: the viewers are told, the window leaves the list.
    t.ev({ ev: 'layer', layer: { id: 21, window: 7, x: 0, y: 0, w: 1, h: 1 } });
    expect(t.ev({ ev: 'gone', id: 7 })).toBe(true);
    expect([rec.last, [...t.r.windows.keys()], t.r.layers.size]).toEqual([{ ev: 'gone', id: 7 }, [9, 10], 0]);
    // A later viewer gets the pointer first thing after the window.
    const late = recorder();
    t.r.attach(9, late.v);
    expect(late.rec.events).toEqual(['window', 'cursor', 'role']);
  });
});
