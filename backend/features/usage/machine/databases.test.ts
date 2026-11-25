// OpenCode's and Antigravity's SQLite databases, made here with SQLite:
// their steps and generations priced as the spend prices them, read again
// when they or their write-ahead log change (a writer's commits that are
// only in its log included), read without making a file when they have no
// log, a damaged one, one at a FIFO's or a link's name (also its log's,
// index's or journal's), one of another user and one past a bound failing
// the read (or skipped) without holding the scan or the node, a FIFO
// swapped in holding the worker only; the protobuf blobs of Antigravity
// decoded without trusting their lengths.
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { removeHomes, tempHome, testEnv, testNowSec, write } from '../testdata/machine.ts';
import { DB_LIMITS, parseGen, parseStepTime, parseTrajectory, protoFields, readAntigravity, readOpenCode } from './databases.ts';
import { NO_ANSWER, SQLiteWorker } from './sqlworker.ts';
import { modelPricing, tierCost, tierOf } from './pricing.ts';
import { CostScanner, type CostOptions, type CostReport } from './scan.ts';

afterAll(removeHomes);

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const since = testNowSec - 30 * 86400;

type Row = NonNullable<CostReport['rows']>[number] & { cost: number; requests: number; output: number };
function rowsBy(rep: CostReport): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const r of rep.rows ?? []) {
    const k = `${r.provider}|${r.model}|${r.project ?? ''}`;
    const p = out[k];
    out[k] = p ? { ...p, cost: p.cost + r.cost!, requests: p.requests + r.requests!, output: p.output + r.output! } : (r as Row);
  }
  return out;
}

// --- OpenCode ------------------------------------------------------------

const OPENCODE_SCHEMA = `
CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, directory text NOT NULL, title text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE credential (id text PRIMARY KEY, value text NOT NULL);
INSERT INTO credential VALUES ('c1', 'fixture-credential');`;

/** An answer: input 100, output (20) without the reasoning 5, cache reads
 * 1000 and writes 10. */
function answer(db: DatabaseSync, id: string, sec: number, provider: string, model: string, cost: number, cwd: string, output = 20) {
  const data = {
    role: 'assistant',
    time: { created: sec * 1000, completed: sec * 1000 + 500 },
    modelID: model,
    providerID: provider,
    path: { cwd, root: cwd },
    cost,
    tokens: { total: 0, input: 100, output, reasoning: 5, cache: { read: 1000, write: 10 } },
    finish: 'stop',
  };
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    id,
    'ses_1',
    sec * 1000,
    sec * 1000,
    JSON.stringify(data),
  );
}

const T1 = Date.UTC(2026, 10, 14, 10) / 1000;

/** OpenCode's database at p: 12 answers an hour apart (Claude through
 * Anthropic's API, recorded free; DeepSeek, a recorded cost; a coding
 * plan, free), prompts (one naming an assistant, one larger than a record
 * is read), an answer without tokens, one with an error, a column added
 * later. */
function openCodeDB(p: string): DatabaseSync {
  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(OPENCODE_SCHEMA);
  db.exec('BEGIN');
  for (let i = 1; i <= 12; i++) {
    const dir = i % 2 ? '/home/u/proj-b' : '/home/u/proj-a';
    if (i % 3 === 0) answer(db, `msg_a${i}`, T1 + i * 3600, 'anthropic', 'claude-opus-4-5-20251101', 0, dir);
    else if (i % 3 === 1) answer(db, `msg_a${i}`, T1 + i * 3600, 'deepseek', 'deepseek-v4-flash', 0.001, dir);
    else answer(db, `msg_a${i}`, T1 + i * 3600, 'bailian-coding-plan', 'glm-5', 0, dir);
  }
  const ins = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  ins.run('msg_u1', 'ses_1', T1 * 1000, T1 * 1000, JSON.stringify({ role: 'user', time: { created: T1 * 1000 }, text: 'ab'.repeat(900) }));
  ins.run(
    'msg_u99',
    'ses_1',
    T1 * 1000,
    T1 * 1000,
    JSON.stringify({ role: 'user', time: { created: T1 * 1000 }, text: 'you are an "assistant"', tokens: { input: 9999 } }),
  );
  // A prompt larger than a record is read: skipped unread, even though it
  // would decode as an answer.
  ins.run(
    'msg_big',
    'ses_1',
    T1 * 1000,
    T1 * 1000,
    JSON.stringify({
      role: 'assistant',
      time: { created: T1 * 1000 },
      modelID: 'glm-5',
      tokens: { input: 77777 },
      text: 'x'.repeat(70_000),
    }),
  );
  ins.run(
    'msg_z',
    'ses_1',
    T1 * 1000,
    T1 * 1000,
    JSON.stringify({
      role: 'assistant',
      time: { created: T1 * 1000 },
      modelID: 'glm-5',
      providerID: 'x',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  );
  ins.run(
    'msg_e',
    'ses_1',
    T1 * 1000,
    T1 * 1000,
    JSON.stringify({
      role: 'assistant',
      time: { created: (T1 + 7200) * 1000 },
      modelID: 'deepseek-v4-flash',
      providerID: 'deepseek',
      cost: 0.5,
      path: { cwd: '/home/u/proj-a' },
      tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
      error: { name: 'APIError', message: 'e!'.repeat(1500) },
    }),
  );
  db.exec('ALTER TABLE message ADD extra text');
  answer(db, 'msg_a13', T1 + 13 * 3600, 'deepseek', 'deepseek-v4-flash', 0.001, '/home/u/proj-a');
  db.exec('COMMIT');
  return db;
}

function openCodeHome() {
  const home = tempHome();
  const p = join(home, '.local/share/opencode/opencode.db');
  write(p, '');
  openCodeDB(p).close();
  const e = testEnv(home);
  const s = new CostScanner(e.base);
  return { home, p, e, s, cost: (o: Partial<CostOptions> = {}) => s.scan(e, { since, providers: ['opencode'], ...o }) };
}

describe('OpenCode', () => {
  test('its steps: Anthropic’s at the table’s price, others at the cost recorded, the rest unpriced; prompts and empty answers left out', async () => {
    const { e, s, cost } = openCodeHome();
    const rep = await cost();
    const rows = rowsBy(rep);
    const { key, price } = modelPricing('claude', 'claude-opus-4-5-20251101');
    const step = tierCost(tierOf(price!, 1110), 100, 1000, 10, 0, 25);
    for (const proj of ['proj-a', 'proj-b']) {
      const c = rows[`opencode|${key}|${proj}`]!;
      expect([c.requests, c.output, c.priced]).toEqual([2, 50, true]);
      expect(near(c.cost, 2 * step)).toBe(true);
    }
    let [steps, input, out, reasoning] = [0, 0, 0, 0];
    for (const r of rep.rows!)
      [steps, input, out, reasoning] = [steps + r.requests!, input + r.input!, out + r.output!, reasoning + (r.reasoning ?? 0)];
    expect([steps, input, out, reasoning]).toEqual([14, 13 * 100 + 7, 13 * 25 + 3, 13 * 5]);
    const d = rows['opencode|deepseek-v4-flash|proj-a']!;
    const db = rows['opencode|deepseek-v4-flash|proj-b']!;
    expect(d.requests + db.requests).toBe(6);
    expect(near(d.cost + db.cost, 5 * 0.001 + 0.5)).toBe(true);
    expect(rows['opencode|glm-5|proj-a']).toMatchObject({ priced: false, cost: 0 });
    expect(rep.unpriced).toEqual(['opencode/glm-5']);
    expect(rep.files).toBe(1);
    const own = await cost({ prices: { 'glm-5': { inputMax: null, input: 1, cached: 0.1, output: 2 } } });
    const g = rowsBy(own)['opencode|glm-5|proj-a']!;
    expect(g.priced).toBe(true);
    expect(near(g.cost, g.requests * ((100 * 1 + 1000 * 0.1 + 10 * 1 + 25 * 2) / 1e6))).toBe(true);
    expect(own.unpriced).toBeUndefined();
    // Asked for another provider: its records stay.
    expect((await s.scan(e, { since, providers: ['claude'] })).rows).toEqual([]);
  });

  test('not read again while unchanged; a commit only in the writer’s log is read', async () => {
    const { p, cost } = openCodeHome();
    const first = await cost();
    const st = statSync(p);
    writeFileSync(p, Buffer.alloc(st.size));
    utimesSync(p, st.atime, st.mtime);
    expect((await cost()).rows).toEqual(first.rows);
    // A writer in WAL mode whose last commits are only in its log.
    writeFileSync(p, '');
    const w = openCodeDB(p);
    try {
      w.exec('PRAGMA wal_autocheckpoint = 0');
      w.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      answer(w, 'msg_w1', T1 + 20 * 3600, 'moonshotai', 'kimi-k2.5', 0.002, '/home/u/proj-c');
      w.exec(`UPDATE message SET data = json_set(data, '$.tokens.output', 500) WHERE id = 'msg_a13'`);
      expect(statSync(`${p}-wal`).size).toBeGreaterThan(0);
      const rows = rowsBy(await cost());
      expect(rows['opencode|kimi-k2.5|proj-c']!.cost).toBe(0.002);
      expect(rows['opencode|deepseek-v4-flash|proj-a']!.output).toBe(2 * 25 + 3 + 505);
    } finally {
      w.close();
    }
  });

  test('without a log, read immutable: no lock, no file made', async () => {
    const home = tempHome();
    const p = join(home, 'opencode.db');
    openCodeDB(p).close();
    for (const f of [`${p}-wal`, `${p}-shm`]) expect(() => statSync(f)).toThrow();
    const recs = await readOpenCode(p, since, { signal: new AbortController().signal });
    expect(recs).toHaveLength(14);
    expect(readdirSync(home)).toEqual(['opencode.db']);
  });

  test('past a bound the read fails (too_large) and the last records stay; damaged; a FIFO is skipped without waiting', async () => {
    const { home, p, e } = openCodeHome();
    const s = new CostScanner(e.base, { ...DB_LIMITS, openCodeRecords: 100, antigravityRecords: 100 });
    expect((await s.scan(e, { since, providers: ['opencode'] })).rows!.length).toBeGreaterThan(0);
    const small = new CostScanner(e.base, { ...DB_LIMITS, openCodeRecords: 2, antigravityRecords: 100 });
    utimesSync(p, new Date(), new Date(Date.now() + 5000));
    const rep = await small.scan(e, { since, providers: ['opencode'] });
    expect(rep.failed).toEqual(['opencode:too_large']);
    expect(rep.rows!.length).toBeGreaterThan(0);
    writeFileSync(p, 'not-sqlite'.repeat(200));
    expect((await small.scan(e, { since, providers: ['opencode'] })).failed).toEqual(['opencode:damaged']);
    // A FIFO at the database's name: not a database, and nothing waits for
    // a writer.
    const fifo = join(home, 'fifo.db');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    const start = Date.now();
    const r = await s.scan({ ...e, env: { OPENCODE_DB: fifo } }, { since, providers: ['opencode'] });
    expect(r.rows).toEqual([]);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  /** Runs read while the node's other work goes on: what it gave, the
   * ticks a timer made meanwhile, and how long it took. */
  async function meanwhile<T>(read: () => Promise<T>): Promise<{ out: T | Error; ticks: number; ms: number }> {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const start = Date.now();
    let out: T | Error;
    try {
      out = await read();
    } catch (e) {
      out = e as Error;
    } finally {
      clearInterval(timer);
    }
    return { out, ticks, ms: Date.now() - start };
  }

  for (const side of ['-wal', '-shm', '-journal']) {
    test(`a FIFO at the database’s ${side}: the read fails at once, the scan skips it, the node goes on`, async () => {
      const { home, p, e } = openCodeHome();
      execFileSync('/usr/bin/mkfifo', [`${p}${side}`]);
      const signal = new AbortController().signal;
      const r = await meanwhile(() => readOpenCode(p, since, { signal }));
      expect(r.out).toMatchObject({ code: 'unreadable' });
      expect(r.ms).toBeLessThan(5000);
      // Another request is answered meanwhile.
      const other = await meanwhile(() => stat(home));
      expect(other.out).toBeTruthy();
      const ag = join(home, '.gemini/antigravity/conversations/c.db');
      write(ag, '');
      conversation(ag);
      execFileSync('/usr/bin/mkfifo', [`${ag}${side}`]);
      expect((await meanwhile(() => readAntigravity(ag, since, 0, { signal }))).out).toMatchObject({ code: 'unreadable' });
      const rep = await new CostScanner(e.base).scan(e, { since, providers: ['opencode', 'antigravity'] });
      expect([rep.files, rep.rows, rep.failed]).toEqual([0, [], undefined]);
    });
  }

  test('a link at the database’s or its log’s name, a file of another user: not read', async () => {
    const { home, p } = openCodeHome();
    const signal = new AbortController().signal;
    const uid = process.getuid!();
    expect(await readOpenCode(p, since, { signal, uid })).toHaveLength(14);
    await expect(readOpenCode(p, since, { signal, uid: uid + 1 })).rejects.toMatchObject({ code: 'unreadable' });
    const link = join(home, 'link.db');
    symlinkSync(p, link);
    await expect(readOpenCode(link, since, { signal, uid })).rejects.toMatchObject({ code: 'unreadable' });
    writeFileSync(join(home, 'elsewhere'), '');
    symlinkSync(join(home, 'elsewhere'), `${p}-wal`);
    await expect(readOpenCode(p, since, { signal, uid })).rejects.toMatchObject({ code: 'unreadable' });
  });

  test('a FIFO swapped in after the check holds the worker, never the node: no answer in time, the worker ended', async () => {
    const home = tempHome();
    const p = join(home, 'a.db');
    const db = new DatabaseSync(p);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE message (id text, time_created integer, data text)');
    db.close();
    // As if swapped in after it was looked at: SQLite opens it by name.
    rmSync(`${p}-wal`, { force: true });
    rmSync(`${p}-shm`, { force: true });
    const fifo = `${p}-wal`;
    execFileSync('/usr/bin/mkfifo', [fifo]);
    const worker = new SQLiteWorker(500);
    const signal = new AbortController().signal;
    try {
      const r = await meanwhile(async () => {
        const opened = await worker.request({ op: 'open', path: p }, signal);
        if (!opened.ok) return opened;
        return worker.request({ op: 'all', sql: 'SELECT count(*) AS n FROM message', params: [] }, signal);
      });
      expect(r.out).toEqual({ ok: false, errcode: NO_ANSWER });
      expect(r.ticks).toBeGreaterThan(10);
      expect(worker.running).toBe(false);
    } finally {
      worker.close();
      // The thread waiting in open() for a writer gets one, and ends.
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        // no reader left
      }
    }
  });

  test('its databases: every channel’s, or $OPENCODE_DB; none in memory', async () => {
    const home = tempHome();
    const data = join(home, 'data');
    for (const n of ['opencode.db', 'opencode-dev.db', 'opencode.db-wal', 'other.db']) {
      const p = join(data, 'opencode', n);
      write(p, '');
      if (n.endsWith('.db') && n !== 'other.db') openCodeDB(p).close();
    }
    const e = testEnv(home, { env: { XDG_DATA_HOME: data } });
    const s = new CostScanner(e.base);
    expect((await s.scan(e, { since, providers: ['opencode'] })).files).toBe(2);
    expect(
      (await s.scan({ ...e, env: { XDG_DATA_HOME: data, OPENCODE_DB: 'opencode-dev.db' } }, { since, providers: ['opencode'] })).files,
    ).toBe(1);
    expect((await s.scan({ ...e, env: { XDG_DATA_HOME: data, OPENCODE_DB: ':memory:' } }, { since, providers: ['opencode'] })).files).toBe(
      0,
    );
  });
});

// --- Antigravity ---------------------------------------------------------

function varint(v: number): number[] {
  const out: number[] = [];
  for (;;) {
    const b = v % 128;
    v = Math.floor(v / 128);
    if (v) out.push(b | 0x80);
    else {
      out.push(b);
      return out;
    }
  }
}
function field(num: number, wt: 0 | 2, val: number | Uint8Array | string): Uint8Array {
  const tag = varint(num * 8 + wt);
  if (wt === 0) return Uint8Array.from([...tag, ...varint(val as number)]);
  const b = typeof val === 'string' ? Buffer.from(val) : (val as Uint8Array);
  return Uint8Array.from([...tag, ...varint(b.length), ...b]);
}
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const mapEntry = (k: string, v: string) => cat(field(1, 2, k), field(2, 2, v));
const tsMsg = (sec: number) => cat(field(1, 0, sec), field(2, 0, 123000000));

function genBlob(o: {
  steps?: number[];
  prompt?: number;
  cached?: number;
  output?: number;
  thinking?: number;
  content?: number;
  model?: string;
  req?: string;
  cascade?: string;
  last?: number;
  pad?: number;
}) {
  const f4 = cat(
    ...[
      o.prompt ? field(2, 0, o.prompt) : null,
      o.output ? field(3, 0, o.output) : null,
      o.cached ? field(5, 0, o.cached) : null,
      o.thinking ? field(9, 0, o.thinking) : null,
      o.content ? field(10, 0, o.content) : null,
    ].filter((x): x is Uint8Array => !!x),
  );
  const f1 = cat(
    ...[
      o.pad ? cat(field(1, 2, 'S'.repeat(o.pad)), field(2, 2, 'M'.repeat(o.pad))) : null,
      field(4, 2, f4),
      o.model ? field(19, 2, o.model) : null,
      o.req ? field(20, 2, mapEntry('request_id', o.req)) : null,
      o.cascade ? field(20, 2, mapEntry('cascade_id', o.cascade)) : null,
      o.last !== undefined ? field(20, 2, mapEntry('last_step_index', String(o.last))) : null,
    ].filter((x): x is Uint8Array => !!x),
  );
  const packed = Uint8Array.from((o.steps ?? []).flatMap(varint));
  return cat(packed.length ? field(2, 2, packed) : new Uint8Array(), field(1, 2, f1));
}

const DAY1 = Date.UTC(2026, 10, 14, 10) / 1000;
const DAY2 = Date.UTC(2026, 10, 15, 10) / 1000;

const AG_SCHEMA = `
CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id));
CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, metadata blob, step_payload blob, PRIMARY KEY (idx));
CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));`;

/** A conversation in project "my app": generations across two days, a
 * long prompt, Claude, a reconciled output, an unpriced model, an empty
 * one, a large last turn. */
function conversation(p: string) {
  const db = new DatabaseSync(p);
  db.exec('PRAGMA page_size = 512');
  db.exec(AG_SCHEMA);
  const traj = cat(field(1, 2, field(1, 2, 'file:///Users/u/my%20app')), field(2, 2, tsMsg(DAY1)), field(7, 2, 'file:///Users/u/my%20app'));
  db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(traj);
  for (const [idx, t] of [
    [1, DAY1 + 60],
    [2, DAY1 + 120],
    [3, DAY2 + 60],
    [4, DAY2 + 120],
    [5, DAY2 + 180],
    [6, DAY2 + 240],
  ])
    db.prepare("INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, 15, ?, X'01')").run(idx!, field(1, 2, tsMsg(t!)));
  const cid = 'conv-uuid-1';
  const gens = [
    genBlob({
      steps: [1],
      prompt: 10000,
      cached: 50000,
      output: 1000,
      thinking: 400,
      content: 600,
      model: 'gemini-4-neon',
      req: 'req-0',
      cascade: cid,
      last: 0,
    }),
    genBlob({
      steps: [2],
      prompt: 50000,
      cached: 200000,
      output: 500,
      thinking: 100,
      content: 400,
      model: 'gemini-3.1-pro-preview',
      req: 'req-1',
      cascade: cid,
      last: 1,
    }),
    genBlob({
      steps: [3],
      prompt: 2000,
      cached: 10000,
      output: 300,
      thinking: 50,
      content: 250,
      model: 'claude-opus-4-6-thinking',
      req: 'req-2',
      cascade: cid,
      last: 2,
    }),
    genBlob({
      steps: [4],
      prompt: 4000,
      cached: 8000,
      thinking: 120,
      content: 180,
      model: 'gemini-3.8-flash-n',
      req: 'req-3',
      cascade: cid,
      last: 3,
    }),
    genBlob({
      steps: [5],
      prompt: 1000,
      cached: 2000,
      output: 100,
      content: 100,
      model: 'gpt-oss-120b',
      req: 'req-4',
      cascade: cid,
      last: 4,
    }),
    genBlob({ steps: [6], model: '', req: 'req-empty', cascade: cid, last: 5 }),
    genBlob({
      steps: [6],
      prompt: 3000,
      cached: 20000,
      output: 200,
      thinking: 80,
      content: 120,
      model: 'gemini-4-hydrogen',
      req: 'req-5',
      cascade: cid,
      last: 6,
      pad: 1200,
    }),
  ];
  gens.forEach((g, i) => db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(i, g, g.length));
  db.close();
}

describe('Antigravity', () => {
  test('protobuf: usage, model, request, steps; trajectory and step times; malformed input never fails', () => {
    const steps = Uint8Array.from([...varint(7), ...varint(8)]);
    const f1 = cat(
      field(1, 2, 'P'.repeat(2048)),
      field(4, 2, cat(field(2, 0, 1000), field(3, 0, 300), field(5, 0, 5000), field(9, 0, 100), field(10, 0, 200))),
      field(19, 2, 'gemini-3.8-flash'),
      field(20, 2, mapEntry('request_id', 'req-abc')),
      field(20, 2, mapEntry('cascade_id', 'cas-1')),
      field(20, 2, mapEntry('last_step_index', '42')),
    );
    expect(parseGen(cat(field(2, 2, steps), field(1, 2, f1)))).toEqual({
      model: 'gemini-3.8-flash',
      requestId: 'req-abc',
      cascadeId: 'cas-1',
      steps: [7, 8],
      lastStep: 42,
      input: 1000,
      cached: 5000,
      output: 300,
      thinking: 100,
    });
    const g2 = parseGen(cat(field(2, 0, 3), field(1, 2, field(4, 2, cat(field(2, 0, 50), field(9, 0, 20), field(10, 0, 80))))));
    expect(g2).toMatchObject({ output: 100, thinking: 20, steps: [3] });
    expect(parseTrajectory(cat(field(2, 2, field(1, 0, 1794650400)), field(7, 2, 'file:///Users/u/my%20proj')))).toEqual({
      project: 'my proj',
      ts: 1794650400,
    });
    expect(parseTrajectory(field(1, 2, field(1, 2, 'file:///work/alpha/'))).project).toBe('alpha');
    expect(parseStepTime(cat(field(6, 2, field(1, 0, 1794650500)), field(1, 2, field(1, 0, 1794650400))))).toBe(1794650400);
    expect(parseStepTime(field(6, 2, field(1, 0, 1794650500)))).toBe(1794650500);
    for (const bad of [
      [],
      [0x00],
      new Array(11).fill(0xff),
      [0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x78],
      [0x0b],
      [0x09, 1, 2],
      [0x0d, 1, 2],
    ]) {
      const b = Uint8Array.from(bad);
      parseGen(b);
      parseTrajectory(b);
      parseStepTime(b);
      expect([...protoFields(b)].every((f) => f.b.length <= b.length)).toBe(true);
    }
  });

  test('a conversation’s generations by day, model and project; the same conversation in two directories counted once; a commit only in the log', async () => {
    const home = tempHome();
    const a = join(home, '.gemini/antigravity/conversations/conv-uuid-1.db');
    write(a, '');
    conversation(a);
    const ide = join(home, '.gemini/antigravity-ide/conversations/conv-uuid-1.db');
    write(ide, readFileSync(a));
    // A conversation whose last generation is only in its writer's log.
    const wal = join(home, '.gemini/antigravity-cli/conversations/wal-uuid.db');
    write(wal, '');
    const w = new DatabaseSync(wal);
    w.exec('PRAGMA journal_mode = WAL');
    w.exec('PRAGMA wal_autocheckpoint = 0');
    w.exec(AG_SCHEMA);
    w.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(
      cat(field(2, 2, field(1, 0, DAY2)), field(7, 2, 'file:///work/wal-proj')),
    );
    const walGen = (prompt: number, cached: number, output: number, req: string) =>
      field(
        1,
        2,
        cat(
          field(4, 2, cat(field(2, 0, prompt), field(3, 0, output), field(5, 0, cached))),
          field(19, 2, 'gemini-4-neon'),
          field(20, 2, mapEntry('request_id', req)),
        ),
      );
    w.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, 0)').run(walGen(1000, 0, 100, 'wal-req-0'));
    w.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    w.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, 0)').run(walGen(2000, 5000, 400, 'wal-req-1'));
    try {
      const e = testEnv(home);
      const s = new CostScanner(e.base);
      const rep = await s.scan(e, { since, providers: ['antigravity'] });
      expect(rep.failed).toBeUndefined();
      const rows = rowsBy(rep);
      const neon = rows['antigravity|gemini-4-neon|my app']!;
      expect(neon).toMatchObject({
        day: '2026-11-14',
        requests: 1,
        input: 10000,
        cached: 50000,
        output: 1000,
        reasoning: 400,
        priced: true,
      });
      expect(near(neon.cost, (10000 * 3 + 50000 * 0.15 + 1000 * 15) / 1e6)).toBe(true);
      const pro = rows['antigravity|gemini-3.1-pro|my app']!;
      expect(near(pro.cost, (50000 * 4 + 200000 * 0.4 + 500 * 18) / 1e6)).toBe(true);
      const cl = rows['antigravity|claude-opus-4-6|my app']!;
      expect(cl).toMatchObject({ day: '2026-11-15', requests: 1, reasoning: 50 });
      expect(near(cl.cost, (2000 * 5 + 10000 * 0.5 + 300 * 25) / 1e6)).toBe(true);
      const fl = rows['antigravity|gemini-3.8-flash|my app']!;
      expect(fl).toMatchObject({ output: 300, reasoning: 120 });
      expect(near(fl.cost, (4000 * 0.75 + 8000 * 0.075 + 300 * 3.75) / 1e6)).toBe(true);
      const hyd = rows['antigravity|gemini-4-hydrogen|my app']!;
      expect(near(hyd.cost, (3000 * 1.5 + 20000 * 0.075 + 200 * 7.5) / 1e6)).toBe(true);
      expect(rows['antigravity|gpt-oss-120b|my app']).toMatchObject({
        requests: 1,
        input: 1000,
        cached: 2000,
        output: 100,
        priced: false,
        cost: 0,
      });
      expect(rep.unpriced).toEqual(['antigravity/gpt-oss-120b']);
      const wr = rows['antigravity|gemini-4-neon|wal-proj']!;
      expect(wr).toMatchObject({ requests: 2, input: 3000, cached: 5000, output: 500 });
      const own = await s.scan(e, {
        since,
        providers: ['antigravity'],
        prices: { 'gpt-oss-120b': { inputMax: null, input: 0.5, cached: 0.125, output: 1.5 } },
      });
      expect(near(rowsBy(own)['antigravity|gpt-oss-120b|my app']!.cost, (1000 * 0.5 + 2000 * 0.125 + 100 * 1.5) / 1e6)).toBe(true);
      expect(own.unpriced).toBeUndefined();
    } finally {
      w.close();
    }
  });

  test('a damaged database fails as damaged; one without generations has none', async () => {
    const home = tempHome();
    const e = testEnv(home);
    const s = new CostScanner(e.base);
    write(join(home, '.gemini/antigravity/conversations/bad.db'), 'not-sqlite'.repeat(20));
    expect((await s.scan(e, { since, providers: ['antigravity'] })).failed).toEqual(['antigravity:damaged']);
    const empty = join(home, '.gemini/antigravity/conversations/empty.db');
    new DatabaseSync(empty).exec('CREATE TABLE other (x)');
    rmSync(join(home, '.gemini/antigravity/conversations/bad.db'));
    const rep = await s.scan(e, { since, providers: ['antigravity'] });
    expect(rep.failed).toBeUndefined();
    expect(rep.rows).toEqual([]);
  });
});
