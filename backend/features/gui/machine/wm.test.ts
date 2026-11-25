// The window manager's decisions on the node (the Go agent's guiframes and
// guiwm_video tests): tiles and budgets, the flow on a simulated slow link,
// the stats of a watched window, when a window becomes video and goes back
// to pictures.
import { describe, expect, test } from 'bun:test';
import { Enc } from './helper.ts';
import { MIN_BUDGET, RTT_PROBE, TILE, Flow, tiles } from './flow.ts';
import {
  Client,
  TICK,
  VIDEO_IDLE,
  VIDEO_MOTION_TICKS,
  VIDEO_RETRY,
  Win,
  WindowManager,
  type Capture,
  type FrameCost,
  type Msg,
  type Vid,
} from './wm.ts';

function wmWith(w: number, h: number, o: { tools?: () => { bin: string; kinds: string[] } } = {}) {
  const sent: Buffer[] = [];
  const wm = new WindowManager({ send: (b) => sent.push(b), logger: () => {}, tools: o.tools, now: () => 0 });
  const m = new Win(1, w, h);
  m.watched = true;
  wm.wins.set(1, m);
  return { wm, m, sent };
}

describe('capture', () => {
  // A huge window is captured in bounded tiles, no more per tick than its
  // budget allows; the rest follows once frames are acknowledged.
  test('tiles within the budget', () => {
    const { wm, m } = wmWith(20000, 20000);
    m.dirty = m.all();
    const now = 1000;
    const jobs = wm.collect(now);
    const tile = m.flow.estimate({ x: 0, y: 0, w: TILE, h: TILE });
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.length).toBeLessThanOrEqual(Math.floor(MIN_BUDGET / tile) + 1);
    expect(m.flow.bytes).toBeGreaterThanOrEqual(MIN_BUDGET);
    for (const j of jobs) {
      expect(j.r.w).toBeLessThanOrEqual(TILE);
      expect(j.r.h).toBeLessThanOrEqual(TILE);
      expect(j.r.w > 0 && j.r.h > 0).toBe(true);
    }
    expect(m.dirty.w > 0).toBe(true); // the rest is kept
    expect(wm.collect(now)).toHaveLength(0);
    wm.ackedAt(m, m.seq, now + 20);
    expect(m.flow.bytes).toBe(0);
    expect(m.flow.inflight).toHaveLength(0);
    expect(wm.collect(now).length).toBeGreaterThan(0);
    const t = tiles({ x: 0, y: 0, w: 2500, h: 1000 });
    expect(t).toHaveLength(3);
    expect(t[2]).toEqual({ x: 2048, y: 0, w: 452, h: 1000 });
  });

  // The budget follows what acknowledgements measure: the bytes delivered
  // in the shortest round trip plus a bounded queue, so small frames are
  // not held back by a frame count and large ones do not queue for long.
  test('the flow on a slow link', () => {
    const { wm, m } = wmWith(640, 480);
    let now = 1_000_000;
    const send = (size: number) => {
      m.dirty = { x: 0, y: 0, w: 200, h: 200 };
      for (const j of wm.collect(now)) wm.encoded(j, size, Enc.JPEG);
    };
    // A link of 1.25 MB/s (10 Mbit/s) with 50 ms round trips, offered 40 kB
    // every tick (2.5 MB/s): frames queue for the link, and each is
    // acknowledged a round trip after it went through.
    const rate = 1.25e6;
    const rtt = 50;
    let acks: Array<{ seq: number; at: number }> = [];
    let free = 0;
    const run = (ticks: number, burst = false, from = 0, track?: (i: number) => void) => {
      for (let i = 0; i < ticks; i++) {
        while (acks.length > 0 && acks[0].at <= now) {
          wm.ackedAt(m, acks[0].seq, acks[0].at);
          acks.shift();
        }
        const n = m.flow.inflight.length;
        send(40000);
        for (const f of m.flow.inflight.slice(n)) {
          const start = Math.max(f.at, free);
          free = start + (f.bytes / rate) * 1000;
          let at = free + rtt;
          if (burst && f.seq % 2 !== 0) at += 32;
          acks.push({ seq: f.seq, at });
        }
        if (burst) acks.sort((a, b) => a.at - b.at);
        track?.(i + from);
        now += TICK;
      }
    };
    let queued = 0;
    run(500, false, 0, (i) => {
      if (i > 250) queued = Math.max(queued, m.flow.bytes);
    });
    // The shortest round trip includes sending one frame (32 ms).
    expect(m.flow.minRTT).toBeGreaterThanOrEqual(rtt);
    expect(m.flow.minRTT).toBeLessThanOrEqual(rtt + 40);
    const bdp = (rate * m.flow.minRTT) / 1000;
    // 82 ms: a queue of 30 ms more.
    expect(m.flow.budget()).toBeGreaterThanOrEqual(1.2 * bdp);
    expect(m.flow.budget()).toBeLessThanOrEqual(1.5 * bdp);
    expect(queued).toBeLessThanOrEqual(1.5 * bdp + 40000);

    // A round trip measured while a queue built up is measured again:
    // frames go one at a time until one is drawn.
    m.flow = Object.assign(new Flow(), { minRTT: 400, minRTTAt: now - RTT_PROBE - 1000, maxRate: rate, rateAt: now });
    acks = [];
    free = 0;
    run(60);
    expect(m.flow.probing).toBe(false);
    expect(m.flow.minRTT).toBeLessThanOrEqual(rtt + 40);

    // The browser acknowledges in bursts: the rate measured must not exceed
    // what the link takes, nor fall far below it.
    m.flow = new Flow();
    acks = [];
    free = 0;
    run(500, true);
    expect(m.flow.maxRate).toBeLessThanOrEqual(1.3 * rate);
    expect(m.flow.maxRate).toBeGreaterThanOrEqual(0.7 * rate);
    // Small frames on an idle link: the budget's floor allows many.
    expect(MIN_BUDGET / 4000).toBeGreaterThanOrEqual(10);
    // A frame that was not sent leaves the flow.
    m.flow = new Flow();
    m.dirty = { x: 0, y: 0, w: 200, h: 200 };
    const jobs = wm.collect(now);
    wm.encoded(jobs[0], null, Enc.None);
    expect(m.flow.inflight).toHaveLength(0);
    expect(m.flow.bytes).toBe(0);
  });
});

/** A client that keeps what it is sent. */
function testClient(session = 1, name = 'a') {
  const got: Msg[] = [];
  const c = new Client(session, name, { write: async (m) => void got.push(m), close: () => {} });
  return { c, got, events: () => got.filter((m) => m.kind === 1).map((m) => JSON.parse(Buffer.from(m.parts[0]).toString())) };
}

// A watched window reports what its frames cost once a second: counts,
// sizes, times, ticks held back and the latency of acknowledged frames.
test('frame stats', async () => {
  const { wm, m } = wmWith(20000, 20000);
  const out = testClient();
  wm.clients.push(out.c);
  m.dirty = m.all();
  const t0 = 1_000_000;
  m.since = t0;
  // A budget of 300 kB: three tiles' worth.
  m.flow = Object.assign(new Flow(), { minRTT: 100, minRTTAt: t0, maxRate: 2.3e6, rateAt: t0 });
  const jobs = wm.collect(t0);
  wm.collect(t0); // held back: nothing acknowledged yet
  const costs: FrameCost[] = jobs.map((j) => ({
    window: j.window,
    captureUs: 1000,
    convertUs: 2000,
    encodeUs: 3000,
    pixels: j.r.w * j.r.h,
    bytes: 1000,
    enc: Enc.JPEG,
  }));
  wm.account(costs, t0 + 10);
  await Promise.resolve();
  expect(out.got).toHaveLength(0);
  wm.ackedAt(m, 2, t0 + 40); // acknowledges frames 1 and 2
  m.acked = 2;
  expect(m.flow.inflight.map((f) => f.seq)).toEqual([3]);
  wm.account([], t0 + 1000);
  await Promise.resolve();
  const ev = out.events()[0];
  expect(ev.ev).toBe('stats');
  expect(ev.stats).toMatchObject({
    window: 1,
    updates: 1,
    frames: 3,
    jpeg: 3,
    bytes: 3000,
    capture_us: 3000,
    convert_us: 6000,
    encode_us: 9000,
    waits: 1,
    acked: 1,
    latency_us: 40000,
    interval_us: 1000000,
    pixels: 3 * TILE * TILE,
  });
  expect(m.stats.frames).toBe(0); // reset after the report
});

// When a window becomes video, stays video and goes back to pictures.
test('video decision', () => {
  let bin = '/enc';
  let kinds = ['vp8'];
  const { wm, m } = wmWith(640, 480, { tools: () => ({ bin, kinds }) });
  wm.clients.push(testClient().c);
  m.codecs = ['avc1'];
  let now = 1_000_000;
  const tick = (): Capture[] => {
    now += TICK;
    const jobs = wm.collect(now);
    for (const j of jobs) {
      m.acked = j.seq;
      wm.ackedAt(m, j.seq, now);
    }
    return jobs;
  };
  const moving = () => (m.dirty = m.all());
  const vid = (o: Partial<Vid>): Vid => ({ id: 1, w: 640, h: 480, kinds: ['vp8'], name: 'libvpx', ...o });
  const started = (v: Vid): FrameCost => ({
    window: 1,
    captureUs: 0,
    convertUs: 0,
    encodeUs: 0,
    pixels: 0,
    bytes: 0,
    enc: Enc.VideoKey,
    started: v,
  });

  moving();
  let j = tick();
  expect(j.length > 0 && !j[0].video && m.fallback === 'no_codec').toBe(true);
  m.codecs = ['avc1', 'vp8'];
  m.motion = 0;
  for (let i = 0; i < VIDEO_MOTION_TICKS - 1; i++) {
    moving();
    j = tick();
    expect(j.length > 0 && !j[0].video).toBe(true);
  }
  moving();
  j = tick();
  expect(j).toHaveLength(1);
  expect(j[0].video && j[0].key && !j[0].vid).toBe(true);
  expect(j[0].kinds).toEqual(['vp8']);
  // The helper started an encoder for it.
  const enc = vid({ id: 7 });
  wm.account([started(enc)], now);
  expect(m.vid).toBe(enc);
  moving();
  j = tick();
  expect(j.length === 1 && j[0].video && !j[0].key && j[0].vid === enc).toBe(true);
  // A small change is still a video frame; a viewer asking starts anew.
  m.dirty = { x: 0, y: 0, w: 5, h: 5 };
  m.keyWanted = true;
  j = tick();
  expect(j.length === 1 && j[0].video && j[0].key).toBe(true);
  // Resized: a new stream.
  m.w = 800;
  m.h = 600;
  moving();
  j = tick();
  expect(j.length === 1 && !j[0].vid && wm.retired.includes(enc)).toBe(true);
  // The encoder failed: pictures for a while.
  wm.account([{ ...started(vid({})), started: undefined, enc: Enc.None, vidErr: 'gone' }], now);
  moving();
  j = tick();
  expect(j.length > 0 && !j[0].video && m.fallback === 'failed').toBe(true);
  now += VIDEO_RETRY;
  moving();
  j = tick();
  expect(j.length === 1 && j[0].video).toBe(true);
  // Still for VIDEO_IDLE: the stream ends.
  const enc2 = vid({ id: 8, w: 800, h: 600 });
  wm.account([started(enc2)], now);
  now += VIDEO_IDLE + 1000;
  tick();
  expect(m.vid).toBeNull();
  expect(wm.retired.includes(enc2)).toBe(true);
  // The viewers now all decode a preferred stream: it replaces this one.
  kinds = ['avc1', 'vp8'];
  const enc3 = vid({ id: 9, w: 800, h: 600 });
  m.vid = enc3;
  moving();
  j = tick();
  expect(j.length === 1 && !j[0].vid && j[0].kinds![0] === 'avc1' && wm.retired.includes(enc3)).toBe(true);
  // H.264 would not open and the encoder made VP8: the stream is kept, not
  // restarted for H.264 on every frame.
  const enc4 = vid({ id: 10, w: 800, h: 600, kinds: ['avc1', 'vp8'] });
  wm.account([started(enc4)], now);
  moving();
  j = tick();
  expect(j.length === 1 && j[0].vid === enc4 && !wm.retired.includes(enc4)).toBe(true);
  // Larger than encoders take: pictures.
  m.vid = null;
  m.w = 5000;
  m.h = 600;
  moving();
  j = tick();
  expect(j.length > 0 && !j[0].video && m.fallback === 'too_large').toBe(true);
  m.w = 800;
  m.h = 600;
  // A viewer stopped acknowledging: the stream still ends when idle.
  const enc5 = vid({ id: 11, w: 800, h: 600, kinds });
  m.vid = enc5;
  m.lastVideo = now;
  m.flow.bytes = m.flow.budget(); // nothing more may be sent
  now += VIDEO_IDLE + 1000;
  moving();
  wm.collect(now);
  expect(m.vid).toBeNull();
  expect(wm.retired.includes(enc5)).toBe(true);
  m.flow = new Flow();
  // No encoder on the machine.
  bin = '';
  moving();
  tick();
  expect(m.fallback).toBe('unavailable');
});
