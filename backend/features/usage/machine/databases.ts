// OpenCode's and Antigravity's SQLite databases, read with the runtime's
// own SQLite (node:sqlite), read-only, in slices that let the node's other
// work in between:
//
//   - a database without a write-ahead log beside it (its writer is not
//     running, or it is not in WAL mode) is opened immutable: no lock is
//     taken and no file made; a read during which its or its log's size or
//     time changed is read again (at most 3 times, then busy);
//   - one with a log is read as any reader reads it: a snapshot of the
//     last commit, the log's index (-shm) shared with the writer, which a
//     reader never holds up (SQLite makes that index when it is missing);
//   - no busy wait: a database another connection holds locked is busy;
//   - only regular files are opened (a FIFO or device at the name is
//     unreadable), and only the tables needed are read, of each row only
//     what the spend keeps (model, provider, tokens, recorded cost, request
//     id, time, the workspace directory's name). Records over a bound are
//     skipped unread (SQLite's length() of a blob reads no content), and a
//     database with more steps than kept fails the read (too_large)
//     rather than leaving some out. SQLite checks a damaged file and fails
//     it (damaged).
//
// The project of an Antigravity generation and its time come from
// protobuf blobs, decoded by a reader of the wire format that checks every
// length against what is left (protoNext).
import { stat } from 'node:fs/promises';
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { firstNonEmpty, isObj, obj, str } from './env.ts';
import { projectName, rec, type Rec } from './parsers.ts';

/** Bounds of a read; variables of a scan so that tests can make them
 * small. */
export interface DBLimits {
  /** OpenCode's steps kept (within the retention): a database with more
   * fails the read. */
  openCodeRecords: number;
  /** Antigravity's generations kept per conversation. */
  antigravityRecords: number;
}

export const DB_LIMITS: DBLimits = { openCodeRecords: 300_000, antigravityRecords: 100_000 };

/** A message's record bound: a prompt with what it attached can be
 * megabytes and is skipped unread; an answer's is a few hundred bytes. */
const OPENCODE_MAX_RECORD = 64 << 10;
/** gen_metadata rows: the last turn of a conversation embeds the prompt
 * history before its usage and can reach tens of megabytes. */
const AG_MAX_GEN = 64 << 20;
const AG_MAX_STEP = 256 << 10;
const AG_MAX_META = 64 << 10;
/** Rows read between two yields to the node's other work. */
const SLICE_ROWS = 256;

/** Why a database could not be read: too_large (a bound), busy (it changed
 * at each read, or is locked), damaged, unreadable. */
export class DBError extends Error {
  readonly code: 'too_large' | 'busy' | 'damaged' | 'unreadable';

  constructor(code: DBError['code']) {
    super(code);
    this.name = 'DBError';
    this.code = code;
  }
}

/** A database's and its log's size and time (ns). */
async function stampOf(p: string): Promise<string> {
  const parts: string[] = [];
  for (const f of [p, `${p}-wal`]) {
    try {
      const st = await stat(f, { bigint: true });
      parts.push(`${st.size}:${st.mtimeNs}:${st.ino}`);
    } catch {
      parts.push('-');
    }
  }
  return parts.join('|');
}

/** The code of a failure of SQLite's. */
function codeOf(err: unknown): DBError {
  if (err instanceof DBError) return err;
  const c = (err as { errcode?: number })?.errcode ?? -1;
  switch (c & 0xff) {
    case 5: // SQLITE_BUSY
    case 6: // SQLITE_LOCKED
      return new DBError('busy');
    case 11: // SQLITE_CORRUPT
    case 26: // SQLITE_NOTADB
      return new DBError('damaged');
  }
  return new DBError('unreadable');
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/** A database opened for one read: rows() iterates a statement's rows,
 * yielding between slices and checking signal. */
class Reader {
  private readonly db: DatabaseSync;
  private readonly signal: AbortSignal;
  /** Opened immutable: nothing tells a change while it is read. */
  readonly immutable: boolean;

  private constructor(db: DatabaseSync, signal: AbortSignal, immutable: boolean) {
    this.db = db;
    this.signal = signal;
    this.immutable = immutable;
  }

  /** Opens p read-only: immutable without a log beside it. */
  static async open(p: string, signal: AbortSignal): Promise<Reader> {
    const st = await stat(p).catch(() => null);
    if (!st?.isFile()) throw new DBError('unreadable');
    const wal = await stat(`${p}-wal`).catch(() => null);
    let db: DatabaseSync;
    try {
      if (wal) db = new DatabaseSync(p, { readOnly: true });
      else {
        const u = pathToFileURL(p);
        u.searchParams.set('immutable', '1');
        db = new DatabaseSync(u, { readOnly: true });
      }
      db.exec('PRAGMA query_only = 1');
    } catch (err) {
      throw codeOf(err);
    }
    return new Reader(db, signal, !wal);
  }

  /** The columns of table, [] when it does not exist. */
  columns(table: string): string[] {
    try {
      return (this.db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((r) => r.name);
    } catch (err) {
      throw codeOf(err);
    }
  }

  /** Hands fn each row of sql, a slice of rows at a time. */
  async rows(sql: string, params: (string | number)[], fn: (r: Record<string, SQLOutputValue>) => void): Promise<void> {
    let st: StatementSync;
    try {
      st = this.db.prepare(sql);
    } catch (err) {
      throw codeOf(err);
    }
    const it = st.iterate(...params) as IterableIterator<Record<string, SQLOutputValue>>;
    try {
      for (let n = 1; ; n++) {
        let next: IteratorResult<Record<string, SQLOutputValue>>;
        try {
          next = it.next();
        } catch (err) {
          throw codeOf(err);
        }
        if (next.done) return;
        fn(next.value);
        if (n % SLICE_ROWS === 0) {
          await yieldNow();
          this.signal.throwIfAborted();
        }
      }
    } finally {
      it.return?.();
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // closed
    }
  }
}

/** Reads p with read (whole each time): again when the database changed
 * while it was read without a log (a read with one is of a snapshot), or
 * was busy, at most 3 times. */
async function readDB<T>(p: string, signal: AbortSignal, read: (r: Reader) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const before = await stampOf(p);
    const r = await Reader.open(p, signal);
    let out: T | undefined;
    let err: unknown;
    try {
      out = await read(r);
    } catch (e) {
      err = e;
    } finally {
      r.close();
    }
    signal.throwIfAborted();
    const changed = r.immutable && before !== (await stampOf(p));
    if (changed || (err instanceof DBError && err.code === 'busy')) {
      if (attempt < 2) continue;
      throw new DBError('busy');
    }
    if (err !== undefined) throw codeOf(err);
    return out as T;
  }
}

const int = (v: SQLOutputValue | undefined): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? Math.trunc(v) : 0);

// --- OpenCode ------------------------------------------------------------

/** The steps of OpenCode's database at p from since on: each assistant
 * message of its table message is one step of a turn with its model,
 * provider, directory, tokens (input without the cache's, output without
 * the reasoning) and the cost OpenCode computed. */
export function readOpenCode(p: string, since: number, signal: AbortSignal, limits: DBLimits = DB_LIMITS): Promise<Rec[]> {
  return readDB(p, signal, async (r) => {
    const cols = r.columns('message');
    if (!cols.includes('data')) throw new DBError('unreadable');
    const id = cols.includes('id') ? 'id' : 'NULL';
    const time = cols.includes('time_created') ? 'time_created' : 'NULL';
    const recs: Rec[] = [];
    await r.rows(
      `SELECT ${id} AS id, ${time} AS t, CASE WHEN length(data) <= ? THEN data END AS data FROM message`,
      [OPENCODE_MAX_RECORD],
      (row) => {
        const data = typeof row.data === 'string' ? row.data : '';
        if (!data.includes('"assistant"')) return;
        let m: Record<string, unknown>;
        try {
          const v: unknown = JSON.parse(data);
          if (!isObj(v)) return;
          m = v;
        } catch {
          return;
        }
        if (m.role !== 'assistant') return;
        let ms = typeof obj(m.time).created === 'number' ? (obj(m.time).created as number) : 0;
        if (!(ms > 0)) ms = int(row.t);
        const tok = (x: unknown) => (typeof x === 'number' && x > 0 && x <= 1e15 ? Math.round(x) : 0);
        const t = obj(m.tokens);
        const cache = obj(t.cache);
        const [i, o, reason, c, w] = [tok(t.input), tok(t.output), tok(t.reasoning), tok(cache.read), tok(cache.write)];
        if (!(ms > 0) || ms > 1e15 || Math.trunc(ms / 1000) < since || i + o + reason + c + w === 0) return;
        if (recs.length >= limits.openCodeRecords) throw new DBError('too_large');
        const cost = typeof m.cost === 'number' && m.cost > 0 && m.cost < 1e6 ? m.cost : 0;
        recs.push(
          rec({
            k: typeof row.id === 'string' && row.id ? `oc:${row.id}` : '',
            t: Math.trunc(ms / 1000),
            m: str(m.modelID) || 'unknown',
            v: str(m.providerID),
            j: projectName(str(obj(m.path).cwd)),
            i,
            c,
            w,
            o: o + reason,
            r: reason,
            n: 1,
            p: cost,
          }),
        );
      },
    );
    return recs;
  });
}

// --- Antigravity ---------------------------------------------------------

/** One decoded protobuf field. */
interface ProtoField {
  num: number;
  wt: number;
  /** A varint's value (exact up to 2^53, larger ones are above every
   * bound used). */
  u: number;
  b: Uint8Array;
}

/** A varint at b[i]: its value and the index after it; null when it is
 * cut or longer than 10 bytes. */
function varint(b: Uint8Array, i: number): [number, number] | null {
  let v = 0;
  let mul = 1;
  for (let n = 0; n < 10; n++) {
    if (i >= b.length) return null;
    const x = b[i++]!;
    v += (x & 0x7f) * mul;
    mul *= 128;
    if (x < 0x80) return [v, i];
  }
  return null;
}

/** The fields of a protobuf message, until its end or the first malformed
 * one; every length is checked against what is left. */
export function* protoFields(b: Uint8Array): Generator<ProtoField> {
  let i = 0;
  while (i < b.length) {
    const tag = varint(b, i);
    if (!tag) return;
    i = tag[1];
    const num = Math.floor(tag[0] / 8);
    const wt = tag[0] % 8;
    if (num === 0) return;
    switch (wt) {
      case 0: {
        const v = varint(b, i);
        if (!v) return;
        i = v[1];
        yield { num, wt, u: v[0], b: new Uint8Array() };
        break;
      }
      case 1:
        if (b.length - i < 8) return;
        i += 8;
        yield { num, wt, u: 0, b: new Uint8Array() };
        break;
      case 2: {
        const l = varint(b, i);
        if (!l || l[0] > b.length - l[1]) return;
        const end = l[1] + l[0];
        yield { num, wt, u: 0, b: b.subarray(l[1], end) };
        i = end;
        break;
      }
      case 5:
        if (b.length - i < 4) return;
        i += 4;
        yield { num, wt, u: 0, b: new Uint8Array() };
        break;
      default:
        return;
    }
  }
}

const MAX_TOK = 1e15;
const MIN_TS = 1_000_000_000;
const MAX_TS = 10_000_000_000;
const tokOf = (v: number) => (v === 0 || v > MAX_TOK ? 0 : v);

function protoString(b: Uint8Array, max: number): string {
  return b.length === 0 || b.length > max ? '' : Buffer.from(b).toString('utf8').trim();
}

/** A google.protobuf.Timestamp's seconds, 0 when not a plausible time. */
function protoTimestamp(b: Uint8Array): number {
  for (const f of protoFields(b)) if (f.num === 1 && f.wt === 0 && f.u > MIN_TS && f.u < MAX_TS) return f.u;
  return 0;
}

/** What one gen_metadata blob says of a generation. */
export interface Gen {
  model: string;
  requestId: string;
  cascadeId: string;
  steps: number[];
  lastStep?: number;
  input: number;
  cached: number;
  output: number;
  thinking: number;
}

/** A gen_metadata blob's usage:
 *
 *	field 2: step indices (packed varints or repeated varint)
 *	field 1 (payload):
 *	  field 4 (usage): 2 prompt tokens (not cached), 3 output, 5 cached
 *	    input, 9 thinking (part of the output), 10 content
 *	  field 19: model ID
 *	  field 20 (map<string,string>): request_id, cascade_id, last_step_index
 *
 * null without a usage block. */
export function parseGen(b: Uint8Array): Gen | null {
  const g: Gen = { model: '', requestId: '', cascadeId: '', steps: [], input: 0, cached: 0, output: 0, thinking: 0 };
  let usage = false;
  for (const f of protoFields(b)) {
    if (f.num === 2 && f.wt === 0) {
      if (f.u <= MAX_TOK) g.steps.push(f.u);
    } else if (f.num === 2 && f.wt === 2) {
      let i = 0;
      while (i < f.b.length && g.steps.length < 64) {
        const v = varint(f.b, i);
        if (!v) break;
        i = v[1];
        if (v[0] <= MAX_TOK) g.steps.push(v[0]);
      }
    } else if (f.num === 1 && f.wt === 2) {
      for (const p of protoFields(f.b)) {
        if (p.wt !== 2) continue;
        if (p.num === 4) {
          usage = true;
          let content = 0;
          for (const u of protoFields(p.b)) {
            if (u.wt !== 0) continue;
            if (u.num === 2) g.input = tokOf(u.u);
            else if (u.num === 3) g.output = tokOf(u.u);
            else if (u.num === 5) g.cached = tokOf(u.u);
            else if (u.num === 9) g.thinking = tokOf(u.u);
            else if (u.num === 10) content = tokOf(u.u);
          }
          if (g.output === 0 && (g.thinking > 0 || content > 0)) g.output = g.thinking + content;
        } else if (p.num === 19) {
          const m = protoString(p.b, 200);
          if (m) g.model = m;
        } else if (p.num === 20) {
          let k = '';
          let v = '';
          for (const e of protoFields(p.b)) {
            if (e.wt !== 2) continue;
            if (e.num === 1) k = protoString(e.b, 128);
            else if (e.num === 2) v = protoString(e.b, 256);
          }
          if (k === 'request_id') g.requestId = v;
          else if (k === 'cascade_id') g.cascadeId = v;
          else if (k === 'last_step_index' && /^\d+$/.test(v)) g.lastStep = Number(v);
        }
      }
    }
  }
  return usage ? g : null;
}

/** The workspace directory's name of a file:// URI or a path. */
function uriProject(s: string): string {
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      const p = decodeURIComponent(new URL(s).pathname);
      if (p) return projectName(p);
    } catch {
      // as a path
    }
  }
  return projectName(s);
}

/** trajectory_metadata_blob's workspace (field 7, else 1.1) and the
 * conversation's start (field 2.1). */
export function parseTrajectory(b: Uint8Array): { project: string; ts: number } {
  let project = '';
  let ts = 0;
  let uri = '';
  for (const f of protoFields(b)) {
    if (f.wt !== 2) continue;
    if (f.num === 1 && !uri) {
      for (const s of protoFields(f.b)) {
        if (s.num === 1 && s.wt === 2) {
          uri = protoString(s.b, 4096);
          break;
        }
      }
    } else if (f.num === 2 && !ts) ts = protoTimestamp(f.b);
    else if (f.num === 7 && !project) project = uriProject(protoString(f.b, 4096));
  }
  return { project: project || uriProject(uri), ts };
}

/** A step's time from steps.metadata: created_at (field 1), else its
 * completion's (fields 6, 7, 8). */
export function parseStepTime(b: Uint8Array): number {
  let fallback = 0;
  for (const f of protoFields(b)) {
    if (f.wt !== 2 || f.b.length > 32) continue;
    if (f.num === 1) {
      const t = protoTimestamp(f.b);
      if (t > 0) return t;
    } else if ((f.num === 6 || f.num === 7 || f.num === 8) && !fallback) fallback = protoTimestamp(f.b);
  }
  return fallback;
}

const bytesOf = (v: SQLOutputValue | undefined): Uint8Array =>
  v instanceof Uint8Array ? v : typeof v === 'string' ? Buffer.from(v) : new Uint8Array();

/** The generations of an Antigravity conversation database at p from since
 * on: gen_metadata first, then trajectory_metadata_blob and only the steps
 * rows the generations name. fallbackTs (the file's time) dates a
 * generation nothing else dates. */
export function readAntigravity(
  p: string,
  since: number,
  fallbackTs: number,
  signal: AbortSignal,
  limits: DBLimits = DB_LIMITS,
): Promise<Rec[]> {
  const conv = p.replace(/^.*\//, '').replace(/\.db$/, '');
  return readDB(p, signal, async (r) => {
    const genCols = r.columns('gen_metadata');
    if (genCols.length === 0) return [];
    if (!genCols.includes('data')) throw new DBError('unreadable');
    const gens: { idx: number; g: Gen }[] = [];
    const need = new Set<number>();
    await r.rows(
      `SELECT rowid AS rid, ${genCols.includes('idx') ? 'idx' : 'NULL'} AS idx, CASE WHEN length(data) <= ? THEN data END AS data FROM gen_metadata`,
      [AG_MAX_GEN],
      (row) => {
        const b = bytesOf(row.data);
        if (!b.length) return;
        const g = parseGen(b);
        if (!g || g.input + g.cached + g.output === 0) return;
        if (gens.length >= limits.antigravityRecords) throw new DBError('too_large');
        for (const s of g.steps) need.add(s);
        if (g.lastStep !== undefined) need.add(g.lastStep);
        gens.push({ idx: row.idx === null ? int(row.rid) : int(row.idx), g });
      },
    );
    if (!gens.length) return [];
    let project = '';
    let convTs = 0;
    const metaCols = r.columns('trajectory_metadata_blob');
    if (metaCols.includes('data')) {
      await r.rows(`SELECT CASE WHEN length(data) <= ? THEN data END AS data FROM trajectory_metadata_blob`, [AG_MAX_META], (row) => {
        if (project && convTs) return;
        const b = bytesOf(row.data);
        if (!b.length) return;
        const t = parseTrajectory(b);
        project ||= t.project;
        convTs ||= t.ts;
      });
    }
    const stepTs = new Map<number, number>();
    const stepCols = r.columns('steps');
    if (need.size && stepCols.includes('metadata')) {
      const idx = stepCols.includes('idx') ? 'idx' : 'NULL';
      const ids = [...need];
      // The rows the generations name, by their rowid, in batches.
      for (let i = 0; i < ids.length; i += 500) {
        const batch = ids.slice(i, i + 500);
        await r.rows(
          `SELECT rowid AS rid, ${idx} AS idx, CASE WHEN length(metadata) <= ? THEN metadata END AS metadata FROM steps WHERE rowid IN (${batch.map(() => '?').join(',')})`,
          [AG_MAX_STEP, ...batch],
          (row) => {
            const b = bytesOf(row.metadata);
            const t = b.length ? parseStepTime(b) : 0;
            if (t > 0) stepTs.set(row.idx === null ? int(row.rid) : int(row.idx), t);
          },
        );
      }
    }
    const recs: Rec[] = [];
    for (const { idx, g } of gens) {
      let ts = 0;
      for (const s of g.steps) {
        ts = stepTs.get(s) ?? 0;
        if (ts > 0) break;
      }
      if (!ts && g.lastStep !== undefined) ts = stepTs.get(g.lastStep) ?? 0;
      ts ||= convTs || fallbackTs;
      if (ts <= 0 || ts < since) continue;
      const key = g.requestId ? `ag:${g.requestId}` : g.cascadeId ? `ag:${g.cascadeId}:${idx}` : conv ? `ag:${conv}:${idx}` : '';
      recs.push(
        rec({
          k: key,
          t: ts,
          m: firstNonEmpty(g.model, 'unknown'),
          j: project,
          i: g.input,
          c: g.cached,
          o: g.output,
          r: Math.min(g.thinking, g.output),
          n: 1,
        }),
      );
    }
    return recs;
  });
}
