// The history feature's machine side, driven through the wire as the hub
// drives it (the kernel's call, the protocol's schemas), against a fake
// terminal core (testdata/fakecore.ts).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import { CHAT_HOST_NAME, HIDDEN_CHAT_HOST, HIDDEN_LABEL, HistoryLimits, validHistoryTerminal } from '#shared/proto/agentproto/index.ts';
import { HOST_FILE_RETENTION, MACHINE_DB, hostFile, openShared } from '#shared/store/index.ts';
import { call } from '#kernel/agent.ts';
import { AgentError } from '#kernel/machines/transport/session.ts';
import { machineOf, rig, type Rig } from '#machine/testing.ts';
import { historyMachine } from './machine.ts';
import { limitsOf, type Timing } from './machine/capture.ts';
import { parseRestoreScreen, restoreScreen, MAX_CONFIG } from './machine/config.ts';
import { Memory } from './machine/memory.ts';
import { endOf, paintText, restoredByCore, stripTitles } from './machine/paint.ts';
import { COLUMNS, FEATURE, HOSTNAME, PROCESS_ID, Store, dbPath, openDB, scanMeta, type Meta, type MetaRow } from './machine/store.ts';
import { historyProtocol } from './protocol.ts';
import { FakeCore, finished, live } from './testdata/fakecore.ts';

const FAST: Partial<Timing> = { firstByteMs: 100, attachMs: 2000, lockWaitMs: 50 };
const params = { lines: 2000, maxTerminals: 32, maxTotalBytes: 64 << 20, days: 7 };
const DAY = 24 * 3600 * 1000;
const GRACE = 2 * 60_000;

// Nothing of the user's herdr-core configuration is read.
let xdg: string | undefined;
beforeAll(() => {
  xdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = '';
});
afterAll(() => {
  if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = xdg;
});

/** A paint as herdr-core starts one. */
const PAINT_HEAD = '\x18\x1b[!p\x1b[?2026l\x1b[?1049l\x1b[H\x1b[2J';
/** It ends so: the end marker and a status report. */
const PAINT_TAIL = '\x1b[?9001l\x1b]7501;state=idle\x1b\\';

/** A paint's screen and history part as herdr-core draws it: what a
 * snapshot keeps, with the title the paint carries (title) or not. */
function body(history: number, width: number, screen: string, title: boolean): Buffer {
  let s = PAINT_HEAD;
  for (let i = 0; i < history; i++) s += `\x1b[32m${String(i).padStart(5, '0')} ${'x'.repeat(width)}\x1b[0m\r\n`;
  if (history > 0) s += '\x1b[0m\r\n\n\n\x1b[H\x1b[2J';
  s += screen;
  if (title) s += '\x1b]2;vim notes.txt\x1b\\';
  return Buffer.from(s, 'utf8');
}

/** Paints a terminal with up to avail history lines of width characters. */
const painter = (avail: number, width: number, screen: string) => (h: number) =>
  Buffer.concat([body(Math.min(h, avail), width, screen, true), Buffer.from(PAINT_TAIL)]);

/** A clock that tests set; null is the real one. Each reading of a set one
 * goes a second further, so that every snapshot has a time of its own. */
class Clock {
  t: number | null = null;
  now = (): number => (this.t === null ? Date.now() : (this.t += 1000));
}

interface Env {
  r: Rig;
  f: FakeCore;
  memory: Memory;
  clock: Clock;
  base: string;
}

const envs: Env[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) {
    e.f.close();
    await e.r.close();
  }
});

/** An agent on a new home with the history feature and a terminal core on
 * its socket. */
async function setup(o: { timing?: Partial<Timing>; start?: number } = {}): Promise<Env> {
  const memory = new Memory();
  const clock = new Clock();
  if (o.start !== undefined) clock.t = o.start;
  const r = await rig({ features: [historyMachine({ timing: { ...FAST, ...o.timing }, now: clock.now, memory })] });
  const f = new FakeCore();
  await f.listen(r.agent.hc.socket);
  const e = { r, f, memory, clock, base: r.dirs.base };
  envs.push(e);
  return e;
}

type CaptureParams = typeof params;
const capture = (e: Env, p: CaptureParams = params) => call(machineOf(e.r.session), historyProtocol, 'capture', p);
const list = (e: Env) => call(machineOf(e.r.session), historyProtocol, 'list', {});
const read = (e: Env, terminal: string, generation: string) =>
  call(machineOf(e.r.session), historyProtocol, 'read', { terminal, generation });
const clear = (e: Env, terminal?: string) =>
  call(machineOf(e.r.session), historyProtocol, 'clear', terminal === undefined ? {} : { terminal });
const adopt = (e: Env, from: string, to: string) => call(machineOf(e.r.session), historyProtocol, 'adopt', { from, to });

/** The refusal p ends with. */
async function refusal(p: Promise<unknown>): Promise<Fail> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Fail) return e;
    throw e;
  }
  throw new Error('not refused');
}

/** A generation as the database holds it, null without it. */
function gen(base: string, addr: string, prev: boolean): { m: Meta; data: Buffer } | null {
  if (!existsSync(dbPath(base))) return null;
  const { db } = openDB(base);
  try {
    const row = db.get<MetaRow>(`SELECT ${COLUMNS}, data FROM history_snapshots WHERE terminal = ? AND prev = ?`, addr, prev ? 1 : 0);
    if (!row) return null;
    return { m: scanMeta(row).m, data: Buffer.from(row.data!) };
  } finally {
    db.close();
  }
}

const metaOf = (e: Env, addr: string, prev = false) => gen(e.base, addr, prev)?.m ?? null;
const dataOf = (e: Env, addr: string, prev = false) => {
  const g = gen(e.base, addr, prev);
  if (!g) throw new Error(`no generation of ${addr}`);
  return g.data;
};

/** A terminal's generations, to compare byte for byte. */
function snapshot(e: Env, addr: string): string {
  const g = [gen(e.base, addr, false), gen(e.base, addr, true)];
  if (!g[0] && !g[1]) throw new Error(`${addr} has no snapshots`);
  return JSON.stringify(g.map((x) => (x ? { m: x.m, data: x.data.toString('base64') } : null)));
}

/** The rows' names as their files were named before the database. */
function rowNames(e: Env): string[] {
  const { db } = openDB(e.base);
  try {
    return db
      .all<{ terminal: string; prev: number }>('SELECT terminal, prev FROM history_snapshots')
      .flatMap((r) => [`${r.terminal}${r.prev ? '.prev' : ''}.json`, `${r.terminal}${r.prev ? '.prev' : ''}.vt`])
      .sort();
  } finally {
    db.close();
  }
}

function rowsOf(e: Env): number {
  const { db } = openDB(e.base);
  try {
    return Number(db.get<{ n: number }>('SELECT count(*) AS n FROM history_snapshots')!.n);
  } finally {
    db.close();
  }
}

/** Makes the database refuse changes of kind (DELETE, UPDATE) of
 * snapshots, as a full disk would, until the returned function is called. */
function failChanges(e: Env, kind: string): () => void {
  const name = 'fail_' + kind.toLowerCase();
  const run = (sql: string) => {
    const { db } = openDB(e.base);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  run(`CREATE TRIGGER ${name} BEFORE ${kind} ON history_snapshots BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
  return () => run(`DROP TRIGGER ${name}`);
}

/** Holds the lease as another writer: owner, host, pid, until. */
function hold(e: Env, owner: string, host: string, pid: number, until: number): void {
  const { db } = openDB(e.base);
  try {
    db.run('INSERT OR REPLACE INTO history_lease (id, owner, host, pid, expires) VALUES (1, ?, ?, ?, ?)', owner, host, pid, until);
  } finally {
    db.close();
  }
}

/** Paints each address as itself with a few lines. */
function plain(f: FakeCore, ...addrs: string[]): void {
  for (const a of addrs) {
    f.setText(a, a);
    f.setPaint(a, painter(10, 10, a));
  }
}

describe('capture', () => {
  test('stores a first paint across frames and beyond the window, up to its end and without its title; an unchanged screen is not attached to again', async () => {
    const e = await setup();
    const { f } = e;
    f.set({ ...live('t1', 100), cols: 120, rows: 40 });
    f.setText('t1', '$ ls');
    f.setPaint('t1', painter(5000, 100, '$ ls'));
    f.after.set('t1', Buffer.from('live output that follows\r\n'));
    let res = await capture(e, { ...params, lines: 4000 });
    expect([res.captured, res.failed, res.skipped]).toEqual([1, 0, 0]);
    const data = dataOf(e, 't1');
    expect(data.equals(body(4000, 100, '$ ls', false))).toBe(true);
    expect(data.length).toBeGreaterThan(256 << 10);
    expect(res.bytes).toBe(data.length);
    const m = metaOf(e, 't1')!;
    expect(m).toMatchObject({ pid: 100, cols: 120, rows: 40, lines: 4000, bytes: data.length, days: 7, restored: false });
    expect(m.at).toBeGreaterThan(0);
    expect(f.attaches).toHaveLength(1);
    expect(f.attaches[0]).toMatchObject({ observe: true, resize_notifications: true, history: 4000, cols: 120, rows: 40 });
    // Unchanged: probed, not attached.
    res = await capture(e);
    expect([res.skipped, res.captured]).toEqual([1, 0]);
    expect(f.attaches).toHaveLength(1);
    // Changed: captured again, the same program's snapshot replaced.
    f.setText('t1', '$ ls -l');
    expect((await capture(e)).captured).toBe(1);
    expect(metaOf(e, 't1', true)).toBeNull();
    // The grid alone changed: captured again, with the new grid.
    f.terms[0].cols = 100;
    expect((await capture(e)).captured).toBe(1);
    expect(metaOf(e, 't1')).toMatchObject({ cols: 100, rows: 40 });
    // The screen is read without a lines member: never scrolling a program.
    expect(f.reads).toHaveLength(4);
    for (const r of f.reads) expect(r).toEqual({ terminal: 't1' });
  });

  test("the paint's end is found when its marker straddles frames; output after it is not stored; a busy terminal does not hold the capture", async () => {
    for (const [b, from, want] of [
      ['abc\x1b[?9001lxyz', 0, 3],
      ['abc\x1b[?9001h', 0, 3],
      ['abc\x1b[?9001', 0, -1],
      ['abc\x1b[?900', 0, -1],
      ['\x1b[?90012h\x1b[?9001l', 0, 9],
      ['abc', 0, -1],
      ['ab\x1b[?9001lc\x1b[?9001h', 3, 11],
    ] as const)
      expect(endOf(Buffer.from(b), from)).toBe(want);
    const e = await setup();
    const { f } = e;
    f.chunk = 5;
    f.set(live('t1', 7));
    f.setText('t1', 'x');
    f.setPaint('t1', painter(30, 10, '$ '));
    f.after.set('t1', Buffer.from('more output\x1b[?9001h after'));
    expect((await capture(e)).captured).toBe(1);
    expect(dataOf(e, 't1').equals(body(30, 10, '$ ', false))).toBe(true);
    f.chunk = 1;
    f.after.set('t1', Buffer.alloc(1 << 20, 'y'));
    f.setText('t1', 'busy');
    const start = Date.now();
    expect((await capture(e)).captured).toBe(1);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  for (const cut of [300, 0])
    test(`a terminal resized while its paint arrives (after ${cut} bytes) is attached again with its new grid; one resized at every attach fails as repainted and keeps what it had`, async () => {
      const e = await setup();
      const { f } = e;
      f.set(live('t1', 7));
      f.setText('t1', 'x');
      f.setPaint('t1', painter(100, 10, '$ '));
      f.regrid.set('t1', { cut, times: 1, grid: [100, 30] });
      expect((await capture(e)).captured).toBe(1);
      expect(dataOf(e, 't1').equals(body(100, 10, '$ ', false))).toBe(true);
      expect(metaOf(e, 't1')).toMatchObject({ cols: 100, rows: 30, lines: 2000 });
      expect(f.attaches).toHaveLength(2);
      expect(f.attaches[1]).toMatchObject({ history: 2000, cols: 100, rows: 30 });
      const before = snapshot(e, 't1');
      const n = f.attaches.length;
      f.setText('t1', 'y');
      f.regrid.set('t1', { cut, times: 100, grid: [90, 20] });
      const res = await capture(e);
      expect(res.failed).toBe(1);
      expect(res.errors?.t1).toBe('repainted');
      expect(f.attaches.length - n).toBe(4);
      expect(snapshot(e, 't1')).toBe(before);
    });

  test('a reader that fell behind gets a repaint without history: attached again; behind at every attach fails as repainted', async () => {
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 7));
    f.setText('t1', 'x');
    f.setPaint('t1', painter(3000, 100, '$ '));
    f.behind.set('t1', { cut: 2 * f.chunk, times: 1 });
    expect((await capture(e)).captured).toBe(1);
    expect(dataOf(e, 't1').equals(body(2000, 100, '$ ', false))).toBe(true);
    expect(f.attaches).toHaveLength(2);
    const before = snapshot(e, 't1');
    f.setText('t1', 'y');
    f.behind.set('t1', { cut: f.chunk, times: 100 });
    const res = await capture(e);
    expect(res.errors?.t1).toBe('repainted');
    expect(snapshot(e, 't1')).toBe(before);
  });

  test('a paint the core dropped while the program writes counts as none at once, without waiting', async () => {
    const e = await setup({ timing: { firstByteMs: 5000 } });
    const { f } = e;
    f.set(live('t1', 1));
    f.setText('t1', 'a');
    f.setPaint('t1', (h) => (h > 600 ? null : painter(5000, 10, 'a')(h)));
    f.after.set('t1', Buffer.from('live output\r\n'));
    const start = Date.now();
    expect((await capture(e)).captured).toBe(1);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(metaOf(e, 't1')?.lines).toBe(500);
    expect(dataOf(e, 't1').equals(body(500, 10, 'a', false))).toBe(true);
  });

  test('a kept terminal that waits for its shell is skipped, its snapshots kept', async () => {
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 7));
    f.setText('t1', 'x');
    f.setPaint('t1', painter(10, 10, 'x'));
    await capture(e);
    const before = snapshot(e, 't1');
    f.setText('t1', 'y');
    f.unavailable.add('t1');
    const res = await capture(e);
    expect([res.skipped, res.failed]).toEqual([1, 0]);
    expect(snapshot(e, 't1')).toBe(before);
  });

  const failures: Record<string, (f: FakeCore) => void> = {
    no_paint: (f) => f.setPaint('t1', () => null),
    too_large: (f) => f.setPaint('t1', () => painter(1000, 3000, 'b')(1000)),
    incomplete: (f) => f.setPaint('t1', () => body(10, 10, 'b', true)),
    repainted: (f) => f.regrid.set('t1', { cut: 100, times: 100, grid: [70, 20] }),
    ended: (f) => f.unavailable.add('t1'),
  };
  for (const [name, fail] of Object.entries(failures))
    test(`a terminal that fails (${name}) keeps its generations byte for byte`, async () => {
      const e = await setup({ timing: { attachMs: 300 } });
      const { f } = e;
      f.set(live('t1', 7));
      f.setText('t1', 'a');
      f.setPaint('t1', painter(50, 10, 'a'));
      await capture(e);
      f.set(live('t1', 8));
      f.setText('t1', 'b');
      f.setPaint('t1', painter(50, 10, 'b'));
      await capture(e); // a previous generation too
      const before = snapshot(e, 't1');
      f.setText('t1', 'c');
      fail(f);
      expect((await capture(e)).captured).toBe(0);
      expect(snapshot(e, 't1')).toBe(before);
    });

  test('a dropped paint is asked again with half the lines, down to the fewest', async () => {
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 1), live('t2', 2));
    f.setText('t1', 'a');
    f.setText('t2', 'b');
    f.setPaint('t1', (h) => (h > 600 ? null : painter(5000, 10, 'a')(h)));
    f.setPaint('t2', () => null);
    const res = await capture(e);
    expect([res.captured, res.failed, res.errors?.t2]).toEqual([1, 1, 'no_paint']);
    const asked = (t: string) => f.attaches.filter((a) => a.terminal === t).map((a) => a.history);
    expect(asked('t1')).toEqual([2000, 1000, 500]);
    expect(asked('t2')).toEqual([2000, 1000, 500, 250, 125, 100]);
    expect(metaOf(e, 't1')?.lines).toBe(500);
    expect(metaOf(e, 't2')).toBeNull();
  });

  test('a paint over the per-generation limit is asked again with half the lines; over it with the fewest it is too_large', async () => {
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 1), live('t2', 2));
    f.setText('t1', 'a');
    f.setText('t2', 'b');
    f.setPaint('t1', (h) => (h >= 1000 ? painter(h, 3000, 'a')(h) : painter(5000, 10, 'a')(h)));
    f.setPaint('t2', () => painter(1000, 3000, 'b')(1000));
    const res = await capture(e);
    expect([res.captured, res.failed, res.errors?.t2]).toEqual([1, 1, 'too_large']);
    const m = metaOf(e, 't1')!;
    expect(m.lines).toBe(500);
    expect(m.bytes).toBeLessThanOrEqual(HistoryLimits.maxBytes);
    expect(metaOf(e, 't2')).toBeNull();
  });

  test('a new program rotates the snapshot to the previous generation once', async () => {
    const e = await setup({ start: Date.now() });
    const { f } = e;
    f.set(live('t1', 100));
    f.setText('t1', 'old program');
    f.setPaint('t1', painter(50, 10, 'old program'));
    await capture(e);
    const old = dataOf(e, 't1');
    const oldAt = metaOf(e, 't1')!.at;
    f.set(live('t1', 200));
    f.setText('t1', 'new shell');
    f.setPaint('t1', () => null);
    expect((await capture(e)).failed).toBe(1);
    expect(metaOf(e, 't1', true)).toMatchObject({ pid: 100, at: oldAt });
    expect(metaOf(e, 't1')).toBeNull();
    f.setPaint('t1', painter(50, 10, 'new shell'));
    for (let i = 0; i < 2; i++) {
      f.setText('t1', `new shell ${i}`);
      expect((await capture(e)).captured).toBe(1);
      expect(metaOf(e, 't1', true)).toMatchObject({ pid: 100, at: oldAt });
      expect(metaOf(e, 't1')?.pid).toBe(200);
      expect(dataOf(e, 't1', true).equals(old)).toBe(true);
    }
    f.set(live('t1', 300));
    f.setText('t1', 'third');
    await capture(e);
    expect(metaOf(e, 't1', true)?.pid).toBe(200);
  });

  test('what the hub asks for is clamped to the hard limits', async () => {
    expect(limitsOf({ lines: -5, maxTerminals: 0, maxTotalBytes: 10, days: 0 })).toEqual({
      lines: 100,
      terminals: 1,
      total: 1 << 20,
      days: 1,
    });
    expect(limitsOf({ lines: 2 ** 30, maxTerminals: 2 ** 30, maxTotalBytes: 2 ** 50, days: 1000 })).toEqual({
      lines: 10000,
      terminals: 128,
      total: 512 << 20,
      days: 30,
    });
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 1));
    f.setPaint('t1', painter(20000, 1, 'a'));
    for (const [ask, want] of [
      [5, 100],
      [99999, 10000],
    ]) {
      f.setText('t1', String(ask));
      await capture(e, { lines: ask, maxTerminals: 8, maxTotalBytes: 64 << 20, days: 7 });
      expect(f.attaches.at(-1)?.history).toBe(want);
    }
  });

  test('over maxTerminals those captured longest ago go first; a terminal without room is not read, and not again until it changes', async () => {
    const e = await setup({ start: Date.now() });
    const { f } = e;
    f.set(live('t1', 1), live('t2', 2), live('t3', 3));
    plain(f, 't1', 't2', 't3');
    const p = { ...params, maxTerminals: 2 };
    let res = await capture(e, p);
    expect([res.captured, res.failed, res.errors?.t3, res.evicted]).toEqual([2, 1, 'limit', 0]);
    expect(f.attaches.some((a) => a.terminal === 't3')).toBe(false);
    res = await capture(e, p);
    expect([res.errors?.t3, res.skipped, f.attaches.length]).toEqual(['limit', 2, 2]);
    f.setText('t3', 't3 again');
    res = await capture(e, p);
    expect([res.captured, res.skipped, res.evicted]).toEqual([1, 2, 1]);
    expect([metaOf(e, 't1'), !!metaOf(e, 't2'), !!metaOf(e, 't3')]).toEqual([null, true, true]);
    // A lower limit evicts at once; a terminal with two generations counts once.
    f.set(live('t2', 2), live('t3', 33));
    f.setText('t3', 't3 new program');
    await capture(e, p);
    expect([!!metaOf(e, 't3', true), !!metaOf(e, 't2')]).toEqual([true, true]);
    res = await capture(e, { ...p, maxTerminals: 1 });
    expect(res.evicted).toBe(1);
    expect([metaOf(e, 't2'), !!metaOf(e, 't3', true)]).toEqual([null, true]);
  });

  test("over maxTotalBytes those captured longest ago go first; a terminal's previous generation goes only when it alone exceeds; one larger than the total is not written", async () => {
    let e = await setup({ start: Date.now() });
    let { f } = e;
    f.set(live('t1', 1), live('t2', 2), live('t3', 3));
    for (const a of ['t1', 't2', 't3']) {
      f.setText(a, a);
      f.setPaint(a, painter(400, 1000, a));
    }
    const p = { ...params, maxTotalBytes: 1 << 20 };
    let res = await capture(e, p);
    expect([res.captured, res.errors?.t3]).toEqual([2, 'limit']);
    expect(res.bytes).toBeLessThanOrEqual(1 << 20);
    f.setText('t3', 't3 again');
    res = await capture(e, p);
    expect([res.captured, res.evicted, metaOf(e, 't1'), !!metaOf(e, 't3')]).toEqual([1, 1, null, true]);
    expect(res.bytes).toBeLessThanOrEqual(1 << 20);

    e = await setup();
    f = e.f;
    f.set(live('t1', 1));
    f.setText('t1', 'a');
    f.setPaint('t1', painter(700, 1000, 'a'));
    await capture(e, p);
    f.set(live('t1', 2));
    f.setText('t1', 'b');
    res = await capture(e, p);
    expect([res.captured, metaOf(e, 't1', true), metaOf(e, 't1')?.pid]).toEqual([1, null, 2]);
    expect(res.bytes).toBeLessThanOrEqual(1 << 20);
    f.setText('t1', 'c');
    f.setPaint('t1', painter(1500, 1000, 'c'));
    res = await capture(e, p);
    expect([res.failed, res.errors?.t1, metaOf(e, 't1')?.pid]).toEqual([1, 'limit', 2]);
  });

  test('snapshots older than their days go at every capture, and by the days they were written under at housekeeping', async () => {
    const start = Date.now();
    let e = await setup({ start });
    let { f } = e;
    f.set(live('t1', 1), live('t2', 2));
    f.setText('t1', 'a');
    f.setText('t2', 'b');
    f.setPaint('t1', painter(10, 10, 'a'));
    f.setPaint('t2', painter(10, 10, 'b'));
    const p = { ...params, days: 3 };
    await capture(e, p);
    e.clock.t = start + 2 * DAY;
    f.setText('t2', 'b2');
    await capture(e, p);
    e.clock.t = start + 3 * DAY + 3600_000;
    f.set();
    let res = await capture(e, p);
    // t1 is too old; t2 is gone from the records, kept for the grace.
    expect(res.removed).toBe(1);
    expect(metaOf(e, 't2')).not.toBeNull();
    e.clock.t! += GRACE;
    res = await capture(e, p);
    expect(res.removed).toBe(1);
    expect(metaOf(e, 't2')).toBeNull();

    // Housekeeping keeps what is younger than the days it was written under.
    e = await setup({ start });
    f = e.f;
    f.setText('t1', 'a');
    f.setText('t2', 'b');
    f.setPaint('t1', painter(10, 10, 'a'));
    f.setPaint('t2', painter(10, 10, 'b'));
    f.set(live('t1', 1));
    await capture(e, { ...params, days: 2 });
    f.set(live('t1', 1), live('t2', 2));
    await capture(e, { ...params, days: 5 });
    await historyMachine().start(e.r.agent.env()).housekeep!(new Date(start + 3 * DAY));
    expect(metaOf(e, 't1')).toBeNull();
    expect(metaOf(e, 't2')).not.toBeNull();
    // Housekeeping of a machine without snapshots creates nothing.
    const empty = await setup();
    await historyMachine().start(empty.r.agent.env()).housekeep!(new Date());
    expect(existsSync(dbPath(empty.base))).toBe(false);
  });

  test('a terminal that finished with its program loses its snapshots; one that finished with its core keeps them; one gone after the grace', async () => {
    const e = await setup({ start: Date.now() });
    const { f } = e;
    const addrs = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
    f.set(...addrs.map((a, i) => live(a, i + 1)));
    plain(f, ...addrs);
    expect((await capture(e)).captured).toBe(addrs.length);
    f.set(
      finished('t1', 'exited'),
      finished('t2', 'killed'),
      finished('t3', 'stopped_by_restart'),
      finished('t4', 'holder_lost'),
      finished('t5', 'server_stop'),
      finished('t6', 'host_shutdown'),
      finished('t7'),
      finished('t8', 'signaled'),
    );
    expect((await capture(e)).removed).toBe(4);
    const kept: Record<string, boolean> = { t1: false, t2: false, t3: true, t4: true, t5: true, t6: true, t7: false, t8: false, t9: true };
    for (const [a, keep] of Object.entries(kept)) expect([a, metaOf(e, a) !== null]).toEqual([a, keep]);
    e.clock.t! += GRACE;
    expect((await capture(e)).removed).toBe(1);
    expect(metaOf(e, 't9')).toBeNull();
  });

  test('snapshots whose removal fails are not counted as removed; they go at a capture whose removal works', async () => {
    const e = await setup({ start: Date.now() });
    const { f } = e;
    plain(f, 't1', 't2');
    f.set(live('t1', 1), live('t2', 2));
    expect((await capture(e)).captured).toBe(2);
    const ok = failChanges(e, 'DELETE');
    f.set(finished('t1', 'exited'));
    let res = await capture(e);
    expect(res.removed).toBe(0);
    expect(metaOf(e, 't1')).not.toBeNull();
    e.clock.t! += GRACE;
    res = await capture(e);
    expect(res.removed).toBe(0);
    expect(metaOf(e, 't2')).not.toBeNull();
    ok();
    res = await capture(e);
    expect(res.removed).toBe(2);
    expect([metaOf(e, 't1'), metaOf(e, 't2')]).toEqual([null, null]);
  });

  test("the product's own helper (its name and its label) is never read, attached to or stored; a terminal with only one of them is captured", async () => {
    const e = await setup();
    const { f } = e;
    f.set(
      live('t1', 100),
      { ...live('t2', 200), name: CHAT_HOST_NAME, labels: { [HIDDEN_LABEL]: HIDDEN_CHAT_HOST } },
      { ...live('t3', 300), labels: { [HIDDEN_LABEL]: HIDDEN_CHAT_HOST } },
      { ...live('t4', 400), name: CHAT_HOST_NAME, labels: { [HIDDEN_LABEL]: 'other' } },
    );
    for (const a of ['t1', 't2', 't3', 't4']) {
      f.setText(a, '$ ' + a);
      f.setPaint(a, painter(50, 40, '$ ' + a));
    }
    const res = await capture(e);
    expect([res.captured, res.failed, res.skipped]).toEqual([3, 0, 0]);
    expect(f.attaches.some((a) => a.terminal === 't2')).toBe(false);
    expect(f.reads.some((r) => r.terminal === 't2')).toBe(false);
    expect(metaOf(e, 't2')).toBeNull();
    for (const a of ['t1', 't3', 't4']) expect(metaOf(e, a)).not.toBeNull();
  });

  test('terminals are taken least recently captured first, also by a new agent; one that failed comes last; those the time did not reach fail as timeout', async () => {
    let e = await setup({ start: Date.now() });
    let { f } = e;
    f.set(live('t1', 1), live('t2', 2), live('t3', 3));
    plain(f, 't1', 't2', 't3');
    await capture(e);
    f.setText('t1', 't1 b');
    await capture(e);
    for (const a of ['t1', 't2', 't3']) f.setText(a, a + ' c');
    e.memory.forgetTerminal(''); // a new agent: only the snapshots tell
    const n = f.attaches.length;
    await capture(e);
    expect(f.attaches.slice(n).map((a) => a.terminal)).toEqual(['t2', 't3', 't1']);

    e = await setup({ timing: { captureMs: 250 } });
    f = e.f;
    f.set(live('t1', 1), live('t2', 2), live('t3', 3));
    plain(f, 't1', 't2', 't3');
    f.setPaint('t1', () => null);
    let res = await capture(e);
    expect([res.failed, res.errors?.t1, res.errors?.t2, res.errors?.t3]).toEqual([3, 'timeout', 'timeout', 'timeout']);
    expect(f.attaches.every((a) => a.terminal === 't1')).toBe(true);
    res = await capture(e);
    expect([res.captured, res.errors?.t1]).toEqual([2, 'timeout']);
  });

  test('quiet terminals are not attached to; changed ones take no wait beyond their frames', async () => {
    const e = await setup({ timing: {} });
    const { f } = e;
    const addrs = Array.from({ length: 20 }, (_, i) => `t${i}`);
    f.set(...addrs.map((a, i) => live(a, 100 + i)));
    for (const a of addrs) {
      f.setText(a, a);
      f.setPaint(a, painter(200, 60, a));
    }
    let start = Date.now();
    expect((await capture(e)).captured).toBe(20);
    expect(Date.now() - start).toBeLessThan(2000);
    const n = f.attaches.length;
    expect((await capture(e)).skipped).toBe(20);
    expect(f.attaches.length).toBe(n);
    for (const a of addrs) f.setText(a, 'changed');
    start = Date.now();
    expect((await capture(e)).captured).toBe(20);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('a terminal too large with the fewest lines is not read again until its screen changes', async () => {
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 1));
    f.setText('t1', 'a');
    f.setPaint('t1', () => painter(1000, 3000, 'a')(1000));
    expect((await capture(e)).errors?.t1).toBe('too_large');
    const n = f.attaches.length;
    expect((await capture(e)).errors?.t1).toBe('too_large');
    expect(f.attaches.length).toBe(n);
    f.setText('t1', 'b');
    f.setPaint('t1', painter(10, 10, 'b'));
    expect((await capture(e)).captured).toBe(1);
  });
});

describe('addresses, privacy and versions', () => {
  test('only addresses that can name a snapshot, from the records and from requests', async () => {
    const valid: Record<string, boolean> = {
      t1: true,
      't-1_x': true,
      '0_a-': true,
      ['a'.repeat(64)]: true,
      '': false,
      '../x': false,
      '..': false,
      '.': false,
      '.x': false,
      'a/b': false,
      'm/t7': false,
      ['a'.repeat(65)]: false,
      't1.prev': false,
      't-1_x.y': false,
      '-x': false,
      _x: false,
      't 1': false,
      't1\n': false,
      ü: false,
    };
    for (const [s, ok] of Object.entries(valid)) expect([s, validHistoryTerminal(s)]).toEqual([s, ok]);
    const e = await setup();
    const { f } = e;
    const bad = ['../x', 'm/t7', 'a'.repeat(65), '.hidden'];
    f.set(...bad.map((a, i) => live(a, i + 1)));
    for (const a of bad) {
      f.setText(a, 'x');
      f.setPaint(a, painter(1, 1, 'x'));
    }
    const res = await capture(e);
    expect(res.captured).toBe(0);
    expect(f.attaches).toHaveLength(0);
    expect(f.reads).toHaveLength(0);
    for (const a of [...bad, '']) {
      expect((await refusal(read(e, a, 'current'))).code).toBe('bad_params');
      if (a !== '') expect((await refusal(clear(e, a))).code).toBe('bad_params');
    }
    for (const g of ['', 'prev', 'Current', '../current']) expect((await refusal(read(e, 't1', g))).code).toBe('bad_params');
    // Actions it does not have.
    for (const action of ['', 'tail', 'Capture']) {
      const err = await e.r.session.request({ op: 'plugin', plugin: 'history', action, params: {} }).catch((x) => x);
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).reply?.code).toBe('bad_params');
    }
  });

  test("the machine's database is the user's alone; a link where it would be is refused without a path", async () => {
    const e = await setup();
    const { f } = e;
    chmodSync(e.base, 0o755);
    f.set(live('t1', 1));
    f.setText('t1', 'a');
    f.setPaint('t1', painter(10, 10, 'a'));
    await capture(e);
    expect(statSync(e.base).mode & 0o777).toBe(0o700);
    expect(lstatSync(dbPath(e.base)).mode & 0o777).toBe(0o600);
    const other = await setup();
    const secret = join(other.r.home, 'elsewhere.db');
    symlinkSync(secret, dbPath(other.base));
    const err = await refusal(capture(other));
    expect(err.code).toBe('io');
    expect(err.message).not.toContain('/');
    expect(existsSync(secret)).toBe(false);
  });

  test('a row that is not a whole generation is neither listed nor read, and the next writer removes it', async () => {
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 1), live('t2', 2));
    plain(f, 't1', 't2');
    await capture(e);
    let { db } = openDB(e.base);
    db.run("UPDATE history_snapshots SET bytes = bytes + 1 WHERE terminal = 't1'");
    db.close();
    f.set();
    expect((await capture(e)).removed).toBe(1);
    expect(rowNames(e)[0]).toBe('t2.json');
    ({ db } = openDB(e.base));
    db.run("UPDATE history_snapshots SET bytes = bytes + 1 WHERE terminal = 't2'");
    db.close();
    hold(e, PROCESS_ID + '.other', HOSTNAME, process.pid, Date.now() + 3600_000);
    expect((await refusal(read(e, 't2', 'current'))).code).toBe('not_found');
    expect((await list(e)).terminals).toEqual([]);
  });

  test('tables of a newer version are listed and read; nothing writes them, and the writers say so', async () => {
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 1));
    f.setText('t1', 'a');
    f.setPaint('t1', painter(10, 10, 'a'));
    await capture(e);
    const { db } = openDB(e.base);
    db.run('UPDATE store_features SET version = version + 1 WHERE feature = ?', FEATURE);
    db.close();
    expect((await list(e)).terminals).toHaveLength(1);
    expect((await read(e, 't1', 'current')).pid).toBe(1);
    f.setText('t1', 'b');
    for (const [name, p] of [
      ['capture', () => capture(e)],
      ['clear', () => clear(e)],
      [
        'adopt',
        () => {
          f.set(live('t1', 1), live('t1x', 2));
          return adopt(e, 't1', 't1x');
        },
      ],
    ] as const) {
      const err = await refusal(p());
      expect([name, err.code]).toEqual([name, 'io']);
      expect(err.message).toContain('newer');
    }
    expect(dataOf(e, 't1').equals(body(10, 10, 'a', false))).toBe(true);
  });

  test('errors reach the hub with a code and a fixed wording, never a path', async () => {
    const e = await setup();
    mkdirSync(dbPath(e.base));
    for (const p of [capture(e), clear(e)]) {
      const err = await refusal(p);
      expect(err.code).toBe('io');
      expect(err.message).not.toContain('/');
    }
  });
});

describe('writers and the lease', () => {
  test('two captures at once: one captures, the other waits or is busy; the limits hold', async () => {
    const e = await setup({ timing: { lockWaitMs: 5000 } });
    const { f } = e;
    const addrs = Array.from({ length: 6 }, (_, i) => `t${i}`);
    f.set(...addrs.map((a, i) => live(a, i + 1)));
    for (const a of addrs) {
      f.setText(a, a);
      f.setPaint(a, painter(200, 100, a));
    }
    const p = { ...params, maxTerminals: 4 };
    const results = await Promise.all([capture(e, p), capture(e, p), capture(e, p), capture(e, p)]);
    expect(results.reduce((n, r) => n + r.captured, 0)).toBeGreaterThanOrEqual(4);
    const { store } = await Store.open(e.base, new Memory(), { wait: false });
    try {
      expect(store.terms.size).toBe(4);
    } finally {
      store.close();
    }
  });

  test("a lease whose process is gone or whose time is over is taken; a live writer's of another host is not; a writer that lost it changes nothing", async () => {
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 1));
    f.setText('t1', 'a');
    f.setPaint('t1', painter(10, 10, 'a'));
    await capture(e);
    const gone = spawnSync('true').pid!;
    const later = Date.now() + 3600_000;
    hold(e, 'other', HOSTNAME, gone, later);
    expect((await capture(e)).busy).toBeFalsy();
    hold(e, 'other', 'elsewhere', process.pid, later);
    expect((await capture(e)).busy).toBe(true);
    hold(e, 'other', 'elsewhere', process.pid, Date.now() - 1000);
    expect((await capture(e)).busy).toBeFalsy();
    const { store } = await Store.open(e.base, new Memory(), { wait: false });
    hold(e, 'other', HOSTNAME, process.pid, later); // taken over meanwhile
    expect(store.remove('t1')).toBe(false);
    expect(metaOf(e, 't1')).not.toBeNull();
    expect(() =>
      store.write(
        { terminal: 't2', pid: 2, at: 1, lines: 0, bytes: 0, cols: 0, rows: 0, hash: '', days: 0, restored: false },
        Buffer.from('x'),
      ),
    ).toThrow(/lease/);
    store.close();
  });

  test("a lease of this pid whose writer is not of this process does not hold; another writer of this process's does", async () => {
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 1));
    f.setText('t1', 'a');
    f.setPaint('t1', painter(10, 10, 'a'));
    await capture(e);
    hold(e, '0123456789abcdef.earlier', HOSTNAME, process.pid, Date.now() + 3600_000);
    expect((await capture(e)).busy).toBeFalsy();
    hold(e, PROCESS_ID + '.another', HOSTNAME, process.pid, Date.now() + 3600_000);
    expect((await capture(e)).busy).toBe(true);
  });

  test('a capture while another writer holds the lease is busy; without a terminal core it fails as not_running without a path', async () => {
    const e = await setup();
    const { store } = await Store.open(e.base, new Memory(), { wait: false });
    const res = await capture(e);
    expect(res.busy).toBe(true);
    expect(e.f.lists).toBe(0);
    store.close();
    e.f.close();
    rmSync(e.r.agent.hc.socket, { force: true });
    const err = await refusal(capture(e));
    expect(err.code).toBe('not_running');
    expect(err.message).not.toContain(e.r.dirs.run);
  });

  test('a writer that holds the lease a moment (a prune) does not make a capture busy: it waits', async () => {
    const e = await setup({ timing: { lockWaitMs: 2000 } });
    const { f } = e;
    f.set(live('t1', 1));
    f.setText('t1', 'a');
    f.setPaint('t1', painter(10, 10, 'a'));
    const { store } = await Store.open(e.base, new Memory(), { wait: false });
    setTimeout(() => store.close(), 100);
    const res = await capture(e);
    expect(res.busy).toBeFalsy();
    expect(res.captured).toBe(1);
  });

  test("another hub's capture stands for this hub's for the share's time; the same hub's does not", async () => {
    const e = await setup({ start: Date.now() });
    const { f } = e;
    f.set(live('t1', 1));
    plain(f, 't1');
    const other = e.r.connect('hub-2');
    await capture(e);
    const second = (await call(machineOf(other), historyProtocol, 'capture', params)) as { busy?: boolean | null; skipped: number };
    expect(second.busy).toBe(true);
    expect((await capture(e)).busy).toBeFalsy();
    e.clock.t! += 10_000;
    const later = await call(machineOf(other), historyProtocol, 'capture', params);
    expect(later.busy).toBeFalsy();
  });
});

describe('list, read, clear and adopt', () => {
  test('through the plugin op, a large generation as a body', async () => {
    const e = await setup();
    const { f } = e;
    let l = await list(e);
    expect(l.terminals).toEqual([]);
    expect(existsSync(dbPath(e.base))).toBe(false);
    expect((await clear(e)).removed).toBe(0);
    f.set(live('t1', 1), live('t2', 2));
    f.setText('t1', 'a');
    f.setText('t2', 'b');
    f.setPaint('t1', painter(2000, 40, 'a'));
    f.setPaint('t2', painter(10, 10, 'b'));
    await capture(e);
    f.set(live('t1', 11), live('t2', 2));
    f.setText('t1', 'a2');
    await capture(e);
    l = await list(e);
    expect(l.terminals).toHaveLength(2);
    const en = l.terminals[0];
    expect(en).toMatchObject({ terminal: 't1', pid: 11, cols: 80 });
    expect(en.previous).toMatchObject({ pid: 1, lines: 2000 });
    expect(l.terminals[1].previous ?? null).toBeNull();
    const d = await read(e, 't1', 'previous');
    expect(d.data.equals(body(2000, 40, 'a', false))).toBe(true);
    expect([d.pid, d.bytes, d.generation, d.terminal]).toEqual([1, d.data.length, 'previous', 't1']);
    expect((await refusal(read(e, 't2', 'previous'))).code).toBe('not_found');
    expect((await clear(e, 't1')).removed).toBe(1);
    expect((await list(e)).terminals.map((t) => t.terminal)).toEqual(['t2']);
    expect((await clear(e)).removed).toBe(1);
    expect((await list(e)).terminals).toEqual([]);
  });

  test('without a capture a snapshot past its days is neither listed nor read, and list removes it; while a writer holds the lease it is not listed either', async () => {
    const start = Date.now();
    const e = await setup({ start });
    const { f } = e;
    f.set(live('t1', 1), live('t2', 2));
    f.setText('t1', 'a');
    f.setText('t2', 'b');
    f.setPaint('t1', painter(10, 10, 'a'));
    f.setPaint('t2', painter(10, 10, 'b'));
    const p = { ...params, days: 1 };
    await capture(e, p);
    e.clock.t = start + 2 * DAY;
    expect((await refusal(read(e, 't1', 'current'))).code).toBe('not_found');
    expect((await list(e)).terminals).toEqual([]);
    expect([metaOf(e, 't1'), metaOf(e, 't2')]).toEqual([null, null]);
    e.clock.t = start;
    f.setText('t1', 'a2');
    await capture(e, p);
    const { store } = await Store.open(e.base, new Memory(), { wait: false });
    try {
      e.clock.t = start + 2 * DAY;
      expect((await list(e)).terminals).toEqual([]);
      expect(metaOf(e, 't1')).not.toBeNull();
    } finally {
      store.close();
    }
  });

  test("a terminal that took another's place gets its newest generation as its previous one, unless it has a later one; the other's go", async () => {
    const e = await setup({ start: Date.now() });
    const { f } = e;
    f.set(live('t1', 100));
    f.setText('t1', 'old program');
    f.setPaint('t1', painter(50, 10, 'old program'));
    await capture(e);
    f.set(live('t1', 200));
    f.setText('t1', 'new shell');
    f.setPaint('t1', painter(50, 10, 'new shell'));
    await capture(e);
    const newest = metaOf(e, 't1')!;
    const data = dataOf(e, 't1');
    f.set(live('t2', 300));
    f.setText('t2', "t2's shell");
    f.setPaint('t2', painter(5, 10, "t2's shell"));
    const before = await capture(e);
    const cur2 = metaOf(e, 't2');
    expect((await adopt(e, 't1', 't2')).adopted).toBe(true);
    expect(metaOf(e, 't2', true)).toEqual({ ...newest, terminal: 't2' });
    expect(dataOf(e, 't2', true).equals(data)).toBe(true);
    expect(metaOf(e, 't2')).toEqual(cur2);
    expect(rowNames(e).join(' ')).toBe('t2.json t2.prev.json t2.prev.vt t2.vt');
    const l = await list(e);
    expect(l.terminals.map((t) => [t.terminal, t.previous?.pid])).toEqual([['t2', 200]]);
    const { store } = await Store.open(e.base, new Memory(), { wait: true });
    const after = store.total();
    store.close();
    expect(after).toBeLessThanOrEqual(before.bytes);

    // t3 has a previous generation of its own captured later: it stays.
    f.set(live('t3', 400));
    f.setText('t3', 't3 old');
    f.setPaint('t3', painter(5, 10, 't3 old'));
    await capture(e);
    f.set(live('t3', 401));
    f.setText('t3', 't3 new');
    await capture(e);
    const own = metaOf(e, 't3', true);
    expect((await adopt(e, 't2', 't3')).adopted).toBe(false);
    expect(metaOf(e, 't3', true)).toEqual(own);
    expect([metaOf(e, 't2'), metaOf(e, 't2', true)]).toEqual([null, null]);
    // One captured before is replaced; a terminal with only a previous
    // generation gives that one.
    f.set(live('t3', 401), live('t4', 500));
    f.setText('t4', 't4');
    f.setPaint('t4', painter(5, 10, 't4'));
    await capture(e);
    f.set(live('t3', 401), live('t4', 501));
    f.setText('t4', 't4 again');
    f.setPaint('t4', () => null);
    await capture(e);
    const t4 = metaOf(e, 't4', true)!;
    expect(metaOf(e, 't4')).toBeNull();
    expect(t4.at).toBeGreaterThan(own!.at);
    expect((await adopt(e, 't4', 't3')).adopted).toBe(true);
    expect(metaOf(e, 't3', true)).toMatchObject({ pid: t4.pid, at: t4.at });
    expect(metaOf(e, 't4', true)).toBeNull();
  });

  test('an adopt names two valid, different addresses, the one that took the place of the records; without a terminal core it is not_running', async () => {
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 1), live('t2', 2));
    f.setText('t1', 'a');
    f.setPaint('t1', painter(5, 10, 'a'));
    await capture(e);
    for (const [from, to] of [
      ['', 't2'],
      ['t1', ''],
      ['../t1', 't2'],
      ['t1', 't2.prev'],
      ['t1', 't1'],
      ['t1', 'a'.repeat(65)],
      ['.lock', 't2'],
    ])
      expect((await refusal(adopt(e, from, to))).code).toBe('bad_params');
    expect((await refusal(adopt(e, 't1', 't9'))).code).toBe('not_found');
    expect(metaOf(e, 't1')).not.toBeNull();
    expect((await adopt(e, 't5', 't2')).adopted).toBe(false);
    expect(metaOf(e, 't2', true)).toBeNull();
    const empty = await setup();
    empty.f.set(live('t2', 2));
    expect((await adopt(empty, 't1', 't2')).adopted).toBe(false);
    expect(existsSync(dbPath(empty.base))).toBe(false);
    f.close();
    rmSync(e.r.agent.hc.socket, { force: true });
    expect((await refusal(adopt(e, 't1', 't2'))).code).toBe('not_running');
  });

  test("the snapshots of a terminal gone from the records stay for the grace, which a record back or an agent's start begins anew; adopted meanwhile", async () => {
    const e = await setup({ start: Date.now() });
    const { f } = e;
    f.set(live('t1', 1), live('t2', 2));
    for (const a of ['t1', 't2']) {
      f.setText(a, a);
      f.setPaint(a, painter(5, 10, a));
    }
    await capture(e);
    const kept = async (want: boolean) => {
      await capture(e);
      expect(metaOf(e, 't1') !== null).toBe(want);
    };
    const gone = () => f.set(live('t2', 2));
    gone();
    await kept(true);
    e.clock.t! += GRACE - 10_000;
    await kept(true);
    f.set(live('t1', 1), live('t2', 2));
    await kept(true);
    gone();
    await kept(true);
    e.clock.t! += GRACE - 10_000;
    await kept(true);
    e.memory.forgetTerminal('');
    await kept(true);
    e.clock.t! += GRACE - 10_000;
    await kept(true);
    e.clock.t! += 20_000;
    await kept(false);

    f.set(live('t3', 3));
    f.setText('t3', 't3');
    f.setPaint('t3', painter(5, 10, 't3'));
    await capture(e);
    expect(metaOf(e, 't2')).not.toBeNull();
    expect((await adopt(e, 't2', 't3')).adopted).toBe(true);
    expect(metaOf(e, 't3', true)).not.toBeNull();
    expect(metaOf(e, 't2')).toBeNull();
    expect(e.memory.vanished.has('t2')).toBe(false);
  });

  test('snapshots that went give their space back', async () => {
    const e = await setup();
    const { f } = e;
    const addrs = Array.from({ length: 24 }, (_, i) => `t${i}`);
    f.set(...addrs.map((a, i) => live(a, i + 1)));
    for (const a of addrs) {
      f.setText(a, a);
      f.setPaint(a, painter(400, 1000, a));
    }
    expect((await capture(e)).captured).toBe(24);
    const full = statSync(dbPath(e.base)).size;
    expect(full).toBeGreaterThanOrEqual(8 << 20);
    await clear(e);
    expect(statSync(dbPath(e.base)).size).toBeLessThanOrEqual(full / 8);
  });

  test('a clear, an eviction and an adopt whose changes fail change nothing', async () => {
    let e = await setup();
    let { f } = e;
    f.set(live('t1', 1), live('t2', 2));
    plain(f, 't1', 't2');
    await capture(e);
    const ok = failChanges(e, 'DELETE');
    expect((await refusal(clear(e))).code).toBe('io');
    expect((await refusal(clear(e, 't1'))).code).toBe('io');
    expect(rowsOf(e)).toBe(2);
    ok();
    expect((await clear(e)).removed).toBe(2);
    expect(rowsOf(e)).toBe(0);

    e = await setup({ start: Date.now() });
    f = e.f;
    f.set(live('t1', 1), live('t2', 2));
    plain(f, 't1', 't2');
    const p = { ...params, maxTerminals: 2 };
    await capture(e, p);
    failChanges(e, 'DELETE');
    f.set(live('t1', 1), live('t2', 2), live('t3', 3));
    plain(f, 't3');
    const res = await capture(e, p);
    expect([res.captured, res.evicted, res.errors?.t3]).toEqual([0, 0, 'limit']);
    expect(rowsOf(e)).toBe(2);
    expect((await capture(e, { ...p, maxTerminals: 1 })).evicted).toBe(0);
    expect(rowsOf(e)).toBe(2);

    e = await setup();
    f = e.f;
    f.set(live('t1', 1), live('t2', 2));
    plain(f, 't1');
    await capture(e);
    failChanges(e, 'UPDATE');
    expect((await refusal(adopt(e, 't1', 't2'))).code).toBe('io');
    expect(metaOf(e, 't1')).not.toBeNull();
  });

  test("the machine's database is this host's; housekeeping removes other hosts' that nobody opened for the retention", async () => {
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 1));
    plain(f, 't1');
    await capture(e);
    expect(dbPath(e.base)).toBe(hostFile(e.base, MACHINE_DB));
    expect(dbPath(e.base).split('/').at(-1)!.startsWith('machine-')).toBe(true);
    expect(existsSync(join(e.base, MACHINE_DB))).toBe(false);
    const old = new Date(Date.now() - HOST_FILE_RETENTION - 3600_000);
    for (const n of ['machine-gone.db', 'machine-recent.db']) openShared(join(e.base, n)).close();
    utimesSync(join(e.base, 'machine-gone.db'), old, old);
    utimesSync(dbPath(e.base), old, old);
    await historyMachine().start(e.r.agent.env()).housekeep!(new Date());
    expect(existsSync(join(e.base, 'machine-gone.db'))).toBe(false);
    expect(existsSync(join(e.base, 'machine-recent.db'))).toBe(true);
    expect(existsSync(dbPath(e.base))).toBe(true);
    expect(metaOf(e, 't1')).not.toBeNull();
  });
});

describe('paints', () => {
  test('window titles go; other sequences stay', () => {
    const cases: Record<string, string> = {
      'a\x1b]2;title\x1b\\b': 'ab',
      'a\x1b]0;both\x07b': 'ab',
      'a\x1b]1;icon\x1b\\b\x1b]2;t\x07': 'ab',
      'a\x1b]7;file:///tmp\x1b\\b': 'a\x1b]7;file:///tmp\x1b\\b',
      'a\x1b]8;;http://x\x1b\\l\x1b]8;;\x1b\\': 'a\x1b]8;;http://x\x1b\\l\x1b]8;;\x1b\\',
      'a\x1b]22;x\x07b': 'a\x1b]22;x\x07b',
      'a\x1b]2;cut': 'a',
      'a\x1b]2;t\x1b[31mred': 'a\x1b[31mred',
      'a\x1b]2;t\x18b': 'a\x18b',
      '\x1b]': '\x1b]',
      plain: 'plain',
    };
    for (const [i, want] of Object.entries(cases)) expect([i, stripTitles(Buffer.from(i, 'latin1')).toString('latin1')]).toEqual([i, want]);
  });

  test("the core's line below a screen it restored is found in the paint's text, also split by styles or a wrapped row", () => {
    const restored = '\x1b[0m\r\n\x1b[2m-- the program above ended; this is a new shell --\x1b[0m\r\n';
    const cases: Record<string, boolean> = {
      [restored]: true,
      '\x1b[2m-- the program above \x1b[1;38;2;1;2;3mended; this was a new\r\n shell --': false,
      '\x1b[2m-- the program above \x1b[1;38;2;1;2;3mended; this is a ne\r\nw shell --': true,
      'the program above ended;\x1b]8;;http://x\x1b\\ this is a new shell': true,
      'the program above ended; this is a new': false,
      '\x1b[?1049h\x1b(Bthe program above ended; this is a new shell\x1b': true,
      '': false,
      '\x1b': false,
    };
    for (const [i, want] of Object.entries(cases)) expect([i, restoredByCore(Buffer.from(i))]).toEqual([i, want]);
    expect(paintText(Buffer.from('a\x1b[31mb\x1b]2;t\x07c\x1b(Bd\x1bPq\x1b\\e\r\nf\x7f')).toString()).toBe('abcdef');
  });

  test("a snapshot of a new shell below a screen the core restored says so, and later ones of the same program; another program's do not", async () => {
    const restored = '\x1b[0m\r\n\x1b[2m-- the program above ended; this is a new shell --\x1b[0m\r\n';
    const e = await setup();
    const { f } = e;
    f.set(live('t1', 100));
    f.setText('t1', 'old');
    f.setPaint('t1', painter(10, 10, 'old'));
    await capture(e);
    f.set(live('t1', 200));
    f.setText('t1', 'old\nnew shell');
    f.setPaint('t1', painter(10, 10, 'old' + restored + '$ '));
    expect((await capture(e)).captured).toBe(1);
    expect(metaOf(e, 't1')).toMatchObject({ restored: true, pid: 200 });
    expect(metaOf(e, 't1', true)?.restored).toBe(false);
    expect((await list(e)).terminals.map((t) => t.restored)).toEqual([true]);
    f.setText('t1', 'much later');
    f.setPaint('t1', painter(10, 10, 'much later'));
    await capture(e);
    expect(metaOf(e, 't1')?.restored).toBe(true);
    f.set(live('t1', 300));
    f.setText('t1', 'third');
    f.setPaint('t1', painter(10, 10, 'third'));
    await capture(e);
    expect(metaOf(e, 't1')).toMatchObject({ restored: false, pid: 300 });
    expect((await list(e)).terminals[0].restored).toBe(false);
  });
});

describe('restore_screen', () => {
  test('as herdr-core reads it from the configuration', () => {
    const cases: Record<string, boolean> = {
      'restore_screen = true\n': true,
      'restore_screen=true': true,
      '  restore_screen = true # mine\r\n': true,
      '"restore_screen" = true\n': true,
      '\xef\xbb\xbfrestore_screen = true\n': true,
      '\xef\xbb\xbf# x\nrestore_screen = true\n': true,
      'history_mb = 10\nshell = [\n  "zsh",\n  "-l",\n]\nrestore_screen = true\n': true,
      'restore_screen = false\n': false,
      '': false,
      'history_mb = 10\n': false,
      '# restore_screen = true\n': false,
      '[server]\nrestore_screen = true\n': false,
      'restore_screen = yes\n': false,
      'restore_screen = "true"\n': false,
      'restore_screen = true\nrestore_screen = true\n': false,
      'restore_screen_x = true\n': false,
      '\xff\xfe restore_screen = true\n': false,
      '\x00\x01\x02garbage': false,
    };
    for (const [text, want] of Object.entries(cases)) expect([text, parseRestoreScreen(Buffer.from(text, 'latin1'))]).toEqual([text, want]);
  });

  test("the user's file: ~/.config or XDG_CONFIG_HOME, a regular file within its bound, a FIFO refused without waiting; list reports it", async () => {
    const e = await setup();
    const home = join(e.r.home, 'u');
    mkdirSync(home);
    const write = (dir: string, text: string) => {
      mkdirSync(join(dir, 'herdr-core'), { recursive: true });
      writeFileSync(join(dir, 'herdr-core', 'config.toml'), text);
    };
    expect(restoreScreen(home, {})).toBe(false);
    write(join(home, '.config'), 'restore_screen = true\n');
    expect(restoreScreen(home, {})).toBe(true);
    expect(restoreScreen(home, { XDG_CONFIG_HOME: 'relative' })).toBe(true);
    const xdgDir = join(e.r.home, 'x');
    mkdirSync(xdgDir);
    expect(restoreScreen(home, { XDG_CONFIG_HOME: xdgDir })).toBe(false);
    write(xdgDir, 'restore_screen = true\n');
    expect(restoreScreen(home, { XDG_CONFIG_HOME: xdgDir })).toBe(true);
    write(xdgDir, 'restore_screen = true\n' + '#\n'.repeat(MAX_CONFIG));
    expect(restoreScreen(home, { XDG_CONFIG_HOME: xdgDir })).toBe(false);
    const fifo = join(xdgDir, 'herdr-core', 'config.toml');
    rmSync(fifo);
    expect(spawnSync('mkfifo', ['-m', '600', fifo]).status).toBe(0);
    const start = Date.now();
    expect(restoreScreen(home, { XDG_CONFIG_HOME: xdgDir })).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
    write(join(e.r.home, '.config'), 'restore_screen = true\n');
    expect((await list(e)).restoreScreen).toBe(true);
  });
});
