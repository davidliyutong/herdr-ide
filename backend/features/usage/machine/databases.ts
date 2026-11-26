// OpenCode's and Antigravity's SQLite databases, read with the runtime's
// own SQLite (node:sqlite), read-only, in a worker thread (sqlworker.ts):
// nothing SQLite waits for (a FIFO swapped in at one of the names it opens,
// a mount that stopped answering, a long read) holds the node's one
// thread, which gets each batch of rows as a message.
//
//   - Before it is opened, the database and the files SQLite opens beside
//     it (-wal, -shm, -journal) must be regular files of the user, not
//     links: a FIFO, device or link at any of those names, or a file of
//     another user, fails the read (unreadable) without SQLite opening
//     anything; the scan skips such a database as it skips a FIFO at a
//     log's name.
//   - A database without a write-ahead log beside it (its writer is not
//     running, or it is not in WAL mode) is opened immutable: no lock is
//     taken and no file made; a read during which its or its log's size or
//     time changed is read again (at most 3 times, then busy).
//   - One with a log is read as any reader reads it: a snapshot of the
//     last commit, the log's index (-shm) shared with the writer, which a
//     reader never holds up (SQLite makes that index when it is missing).
//   - No busy wait: a database another connection holds locked is busy.
//   - Only the tables needed are read, of each row only what the spend
//     keeps (model, provider, tokens, recorded cost, request id, time, the
//     workspace directory's name). Records over a bound are skipped unread
//     (octet_length reads no content; SQLite before 3.43, which lacks it,
//     measures OpenCode's text by reading it), and a database with more
//     steps than kept fails the read (too_large) rather than leaving some
//     out. SQLite checks a damaged file and fails it (damaged).
//
// The project of an Antigravity generation and its time come from
// protobuf blobs, decoded by a reader of the wire format that checks every
// length against what is left (protoFields).
import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { firstNonEmpty, isObj, obj, str } from './env.ts';
import { projectName, rec, type Rec } from './parsers.ts';
import { NO_ANSWER, SQLiteWorker, type SQLReply, type SQLRow, type SQLValue } from './sqlworker.ts';

/** Bounds of a read; variables of a scan so that tests can make them
 * small. */
export interface DBLimits {
  /** OpenCode's steps kept (within the retention): a database with more
   * fails the read. */
  openCodeRecords: number;
  /** Antigravity's generations kept per conversation. */
  antigravityRecords: number;
  /** How long the worker gets to answer one request (a batch of rows). */
  requestMs: number;
}

export const DB_LIMITS: DBLimits = { openCodeRecords: 300_000, antigravityRecords: 100_000, requestMs: 30_000 };

/** How a database is read. */
export interface DBRead {
  /** Ends the read. */
  signal: AbortSignal;
  limits?: DBLimits;
  /** The user whose files the database's must be (-1: not looked at). */
  uid?: number;
  /** The worker the read runs in; without one, a worker of the read's
   * own, ended after it. */
  worker?: SQLiteWorker;
}

/** A message's record bound: a prompt with what it attached can be
 * megabytes and is skipped unread; an answer's is a few hundred bytes. */
const OPENCODE_MAX_RECORD = 64 << 10;
/** gen_metadata rows: the last turn of a conversation embeds the prompt
 * history before its usage and can reach tens of megabytes. */
const AG_MAX_GEN = 64 << 20;
const AG_MAX_STEP = 256 << 10;
const AG_MAX_META = 64 << 10;
/** The steps of a generation, and of a conversation, looked up for their
 * times; a generation past them is dated by the conversation. */
const AG_MAX_GEN_STEPS = 64;
const AG_MAX_STEPS = 100_000;
/** Steps looked up per statement. */
const AG_STEP_BATCH = 500;

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

/** The names SQLite opens besides a database's own. */
const SIDE_FILES = ['-wal', '-shm', '-journal'];

/** Looks at the database p and the files beside it that SQLite opens:
 * each one there must be a regular file of uid (no link, FIFO or device),
 * else DBError unreadable. Whether it has a write-ahead log; the stamp,
 * size and time (ns) of the database and its log together. */
export async function dbFiles(p: string, uid = -1): Promise<{ wal: boolean; stamp: string; size: number; mtime: number }> {
  const parts: string[] = [];
  let wal = false;
  let size = 0;
  let mtime = 0;
  for (const suffix of ['', ...SIDE_FILES]) {
    let st;
    try {
      st = await lstat(p + suffix, { bigint: true });
    } catch (err) {
      if (suffix !== '' && (err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        if (suffix === '-wal') parts.push('-');
        continue;
      }
      throw new DBError('unreadable');
    }
    if (!st.isFile() || (uid >= 0 && Number(st.uid) !== uid)) throw new DBError('unreadable');
    if (suffix === '' || suffix === '-wal') {
      parts.push(`${st.size}:${st.mtimeNs}:${st.ino}`);
      size += Number(st.size);
      mtime = Math.max(mtime, Number(st.mtimeNs));
      if (suffix === '-wal') wal = true;
    }
  }
  return { wal, stamp: parts.join('|'), size, mtime };
}

/** The error of SQLite's code. */
function codeOf(errcode: number): DBError {
  switch (errcode & 0xff) {
    case 5: // SQLITE_BUSY
    case 6: // SQLITE_LOCKED
      return new DBError('busy');
    case 11: // SQLITE_CORRUPT
    case 26: // SQLITE_NOTADB
      return new DBError('damaged');
  }
  return new DBError('unreadable');
}

/** The rows of a reply; DBError for a failure (unreadable when the worker
 * did not answer). */
function rowsOf(r: SQLReply): { rows: SQLRow[]; done: boolean } {
  if (!r.ok) throw r.errcode === NO_ANSWER ? new DBError('unreadable') : codeOf(r.errcode);
  return { rows: r.rows ?? [], done: r.done ?? true };
}

/** A database opened in the worker for one read. */
class Reader {
  private readonly w: SQLiteWorker;
  private readonly signal: AbortSignal;
  /** Opened immutable: nothing tells a change while it is read. */
  readonly immutable: boolean;
  /** The function that measures a record without reading it. */
  readonly len: string;

  private constructor(w: SQLiteWorker, signal: AbortSignal, immutable: boolean, len: string) {
    this.w = w;
    this.signal = signal;
    this.immutable = immutable;
    this.len = len;
  }

  /** Opens p read-only: immutable without a log beside it. */
  static async open(w: SQLiteWorker, p: string, signal: AbortSignal, wal: boolean): Promise<Reader> {
    let url: string | undefined;
    if (!wal) {
      const u = pathToFileURL(p);
      u.searchParams.set('immutable', '1');
      url = u.href;
    }
    rowsOf(await w.request(wal ? { op: 'open', path: p } : { op: 'open', url }, signal));
    const v = rowsOf(await w.request({ op: 'all', sql: 'SELECT sqlite_version() AS v', params: [] }, signal)).rows[0]?.v;
    const [major = 0, minor = 0] = String(v ?? '')
      .split('.')
      .map(Number);
    return new Reader(w, signal, !wal, major > 3 || (major === 3 && minor >= 43) ? 'octet_length' : 'length');
  }

  /** The columns of table, [] when it does not exist. */
  async columns(table: string): Promise<string[]> {
    const { rows } = rowsOf(
      await this.w.request({ op: 'all', sql: 'SELECT name FROM pragma_table_info(?)', params: [table] }, this.signal),
    );
    return rows.map((r) => String(r.name));
  }

  /** Hands fn each row of sql, a batch at a time: the node's other work
   * goes on between batches. */
  async rows(sql: string, params: (string | number)[], fn: (r: SQLRow) => void): Promise<void> {
    let batch = rowsOf(await this.w.request({ op: 'query', sql, params }, this.signal));
    for (;;) {
      for (const r of batch.rows) fn(r);
      this.signal.throwIfAborted();
      if (batch.done) return;
      batch = rowsOf(await this.w.request({ op: 'more' }, this.signal));
    }
  }

  async close(): Promise<void> {
    await this.w.request({ op: 'close' }, this.signal);
  }
}

/** Reads p with read (whole each time): again when the database changed
 * while it was read without a log (a read with one is of a snapshot), or
 * was busy, at most 3 times. */
async function readDB<T>(p: string, o: DBRead, read: (r: Reader) => Promise<T>): Promise<T> {
  const w = o.worker ?? new SQLiteWorker((o.limits ?? DB_LIMITS).requestMs);
  try {
    for (let attempt = 0; ; attempt++) {
      const before = await dbFiles(p, o.uid);
      let r: Reader | undefined;
      let out: T | undefined;
      let err: unknown;
      try {
        r = await Reader.open(w, p, o.signal, before.wal);
        out = await read(r);
      } catch (e) {
        err = e;
      } finally {
        await r?.close();
      }
      o.signal.throwIfAborted();
      const changed =
        !!r?.immutable &&
        before.stamp !==
          (await dbFiles(p, o.uid).then(
            (a) => a.stamp,
            () => '',
          ));
      if (changed || (err instanceof DBError && err.code === 'busy')) {
        if (attempt < 2) continue;
        throw new DBError('busy');
      }
      if (err !== undefined) throw err instanceof DBError ? err : new DBError('unreadable');
      return out as T;
    }
  } finally {
    if (!o.worker) w.close();
  }
}

const int = (v: SQLValue | undefined): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? Math.trunc(v) : 0);

// --- OpenCode ------------------------------------------------------------

/** Decodes one assistant message row of OpenCode's message table into a
 * record (and its context tokens); null when the row is not an assistant
 * message with usage since the cutoff. */
function decodeOpenCodeRow(row: SQLRow, since: number): { r: Rec; contextUsed: number; model: string; tsMs: number } | null {
  const data = typeof row.data === 'string' ? row.data : '';
  if (!data.includes('"assistant"')) return null;
  let m: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(data);
    if (!isObj(v)) return null;
    m = v;
  } catch {
    return null;
  }
  if (m.role !== 'assistant') return null;
  let ms = typeof obj(m.time).created === 'number' ? (obj(m.time).created as number) : 0;
  if (!(ms > 0)) ms = int(row.t);
  const tok = (x: unknown) => (typeof x === 'number' && x > 0 && x <= 1e15 ? Math.round(x) : 0);
  const t = obj(m.tokens);
  const cache = obj(t.cache);
  const [i, o, reason, c, w] = [tok(t.input), tok(t.output), tok(t.reasoning), tok(cache.read), tok(cache.write)];
  if (!(ms > 0) || ms > 1e15 || Math.trunc(ms / 1000) < since || i + o + reason + c + w === 0) return null;
  const cost = typeof m.cost === 'number' && m.cost > 0 && m.cost < 1e6 ? m.cost : 0;
  const model = str(m.modelID) || 'unknown';
  return {
    r: rec({
      k: typeof row.id === 'string' && row.id ? `oc:${row.id}` : '',
      t: Math.trunc(ms / 1000),
      m: model,
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
    contextUsed: i + c + w,
    model: str(m.modelID),
    tsMs: ms,
  };
}

/** The steps of OpenCode's database at p from since on: each assistant
 * message of its table message is one step of a turn with its model,
 * provider, directory, tokens (input without the cache's, output without
 * the reasoning) and the cost OpenCode computed. */
export function readOpenCode(p: string, since: number, o: DBRead): Promise<Rec[]> {
  const limits = o.limits ?? DB_LIMITS;
  return readDB(p, o, async (r) => {
    const cols = await r.columns('message');
    if (!cols.includes('data')) throw new DBError('unreadable');
    const id = cols.includes('id') ? 'id' : 'NULL';
    const time = cols.includes('time_created') ? 'time_created' : 'NULL';
    const recs: Rec[] = [];
    await r.rows(
      `SELECT ${id} AS id, ${time} AS t, CASE WHEN ${r.len}(data) <= ? THEN data END AS data FROM message`,
      [OPENCODE_MAX_RECORD],
      (row) => {
        const decoded = decodeOpenCodeRow(row, since);
        if (!decoded) return;
        if (recs.length >= limits.openCodeRecords) throw new DBError('too_large');
        recs.push(decoded.r);
      },
    );
    return recs;
  });
}

/** One session's usage from OpenCode's database at p, matched by session
 * id or by the most recently updated root session of cwd (sinceMs when a
 * process start time is known), including child subagent sessions. */
export function readOpenCodeSession(
  p: string,
  opts: { session?: string; cwds?: readonly string[]; sinceMs?: number; sinceSec: number },
  o: DBRead,
): Promise<{ sessionId: string; updatedAt: number; records: Rec[]; mainModel: string; mainProvider: string; contextUsed: number } | null> {
  const limits = o.limits ?? DB_LIMITS;
  const cleanDir = (s: string) => s.replace(/\/+$/, '') || '/';
  const wants = new Set((opts.cwds ?? []).filter(Boolean).map(cleanDir));
  const normMs = (v: number) => (v > 0 && v < 1e12 ? v * 1000 : v);
  return readDB(p, o, async (r) => {
    const msgCols = await r.columns('message');
    if (!msgCols.includes('data') || !msgCols.includes('session_id')) return null;
    const sessCols = await r.columns('session');
    let rootId = opts.session ?? '';
    let updatedAt = 0;
    const hasSession = sessCols.includes('id');
    const hasParent = sessCols.includes('parent_id');
    if (!rootId) {
      if (!hasSession || !sessCols.includes('directory')) return null;
      const timeCol = sessCols.includes('time_updated') ? 'time_updated' : sessCols.includes('time_created') ? 'time_created' : '0';
      const whereParent = hasParent ? `WHERE parent_id IS NULL OR parent_id = ''` : '';
      let fallbackId = '';
      let fallbackAt = 0;
      await r.rows(`SELECT id, directory, ${timeCol} AS t FROM session ${whereParent} ORDER BY ${timeCol} DESC LIMIT 64`, [], (row) => {
        if (rootId) return;
        const sid = typeof row.id === 'string' ? row.id : '';
        const dir = typeof row.directory === 'string' ? row.directory : '';
        if (!sid || !dir || !wants.has(cleanDir(dir))) return;
        const tsMs = normMs(int(row.t));
        if (!fallbackId) {
          fallbackId = sid;
          fallbackAt = tsMs;
        }
        if (opts.sinceMs && tsMs > 0 && tsMs < opts.sinceMs) return;
        rootId = sid;
        updatedAt = tsMs;
      });
      if (!rootId && fallbackId) {
        rootId = fallbackId;
        updatedAt = fallbackAt;
      }
      if (!rootId) return null;
    } else if (hasSession) {
      let exists = false;
      const timeCol = sessCols.includes('time_updated') ? 'time_updated' : sessCols.includes('time_created') ? 'time_created' : '0';
      await r.rows(`SELECT id, ${timeCol} AS t FROM session WHERE id = ? LIMIT 1`, [rootId], (row) => {
        if (typeof row.id === 'string' && row.id === rootId) {
          exists = true;
          updatedAt = normMs(int(row.t));
        }
      });
      if (!exists) {
        // Minimal databases may have messages without a session row; check below.
      }
    }
    const ids = [rootId];
    if (hasSession && hasParent) {
      await r.rows(`SELECT id FROM session WHERE parent_id = ? LIMIT 256`, [rootId], (row) => {
        if (typeof row.id === 'string' && row.id && !ids.includes(row.id)) ids.push(row.id);
      });
    }
    const idCol = msgCols.includes('id') ? 'id' : 'NULL';
    const timeCol = msgCols.includes('time_created') ? 'time_created' : 'NULL';
    const recs: Rec[] = [];
    let mainModel = '';
    let mainProvider = '';
    let contextUsed = 0;
    let latestMs = -1;
    let anyRow = false;
    await r.rows(
      `SELECT ${idCol} AS id, session_id AS sid, ${timeCol} AS t, CASE WHEN ${r.len}(data) <= ? THEN data END AS data FROM message WHERE session_id IN (${ids.map(() => '?').join(',')})`,
      [OPENCODE_MAX_RECORD, ...ids],
      (row) => {
        anyRow = true;
        const decoded = decodeOpenCodeRow(row, opts.sinceSec);
        if (!decoded) return;
        if (recs.length >= limits.openCodeRecords) throw new DBError('too_large');
        recs.push(decoded.r);
        if (row.sid === rootId && decoded.tsMs >= latestMs) {
          latestMs = decoded.tsMs;
          if (decoded.model) mainModel = decoded.model;
          if (decoded.r.v) mainProvider = decoded.r.v;
          if (decoded.contextUsed > 0) contextUsed = decoded.contextUsed;
        }
      },
    );
    if (!anyRow && updatedAt === 0) return null;
    return {
      sessionId: rootId,
      updatedAt: Math.max(updatedAt, latestMs > 0 ? latestMs : 0),
      records: recs,
      mainModel,
      mainProvider,
      contextUsed,
    };
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
 *	field 2: step indices (packed varints or repeated varint), at most 64
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
      if (f.u <= MAX_TOK && g.steps.length < AG_MAX_GEN_STEPS) g.steps.push(f.u);
    } else if (f.num === 2 && f.wt === 2) {
      let i = 0;
      while (i < f.b.length && g.steps.length < AG_MAX_GEN_STEPS) {
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

/** The workspace path of a file:// URI or a path. */
function uriPath(s: string): string {
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      const p = decodeURIComponent(new URL(s).pathname);
      if (p) return p.replace(/\/+$/, '') || '/';
    } catch {
      // as a path
    }
  }
  return s.replace(/\/+$/, '') || '/';
}

/** trajectory_metadata_blob's workspace path (field 7, else 1.1), its
 * project name, and the conversation's start (field 2.1). */
export function parseTrajectoryWorkspace(b: Uint8Array): { workspace: string; project: string; ts: number } {
  let workspace = '';
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
    else if (f.num === 7 && !workspace) workspace = uriPath(protoString(f.b, 4096));
  }
  const resolved = workspace || (uri ? uriPath(uri) : '');
  return { workspace: resolved, project: projectName(resolved), ts };
}

/** trajectory_metadata_blob's workspace (field 7, else 1.1) and the
 * conversation's start (field 2.1). */
export function parseTrajectory(b: Uint8Array): { project: string; ts: number } {
  const { project, ts } = parseTrajectoryWorkspace(b);
  return { project, ts };
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

const bytesOf = (v: SQLValue | undefined): Uint8Array =>
  v instanceof Uint8Array ? v : typeof v === 'string' ? Buffer.from(v) : new Uint8Array();

/** One root conversation entry from Antigravity's conversation_summaries.db. */
export interface AntigravitySummary {
  id: string;
  workspaces: string[];
  modifiedMs: number;
  active: boolean;
}

const AG_MAX_SUMMARIES = 512;

function parseSummaryTime(v: SQLValue | undefined): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? Math.trunc(v * 1000) : Math.trunc(v);
  if (typeof v === 'bigint') {
    const n = Number(v);
    if (n > 0) return n < 1e12 ? Math.trunc(n * 1000) : Math.trunc(n);
  }
  if (typeof v !== 'string') return 0;
  const s = v.trim();
  if (!s) return 0;
  let iso = s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s;
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** Reads root conversations from Antigravity's conversation_summaries.db
 * (read-only via SQLiteWorker), most recently modified first. */
export function readAntigravitySummaries(p: string, o: DBRead): Promise<AntigravitySummary[]> {
  return readDB(p, o, async (r) => {
    const cols = await r.columns('conversation_summaries');
    if (!cols.includes('conversation_id') || !cols.includes('workspace_uris')) return [];
    const sel = [
      'conversation_id',
      'workspace_uris',
      cols.includes('parent_conversation_id') ? 'parent_conversation_id' : "'' AS parent_conversation_id",
      cols.includes('nesting_depth') ? 'nesting_depth' : '0 AS nesting_depth',
      cols.includes('status') ? 'status' : "'' AS status",
      cols.includes('not_fully_idle') ? 'not_fully_idle' : '0 AS not_fully_idle',
      cols.includes('killed') ? 'killed' : '0 AS killed',
      cols.includes('last_modified_time') ? 'last_modified_time' : 'NULL AS last_modified_time',
    ].join(', ');
    const order = cols.includes('last_modified_time') ? ' ORDER BY last_modified_time DESC' : '';
    const out: AntigravitySummary[] = [];
    await r.rows(`SELECT ${sel} FROM conversation_summaries${order} LIMIT ?`, [AG_MAX_SUMMARIES], (row) => {
      const id = typeof row.conversation_id === 'string' ? row.conversation_id : '';
      if (!id) return;
      const parent = typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id : '';
      const depth = int(row.nesting_depth);
      const killed = row.killed === 1 || row.killed === 1n || row.killed === '1' || row.killed === 'true';
      if (parent || depth > 0 || killed) return;
      const rawWs = typeof row.workspace_uris === 'string' ? row.workspace_uris : '';
      let workspaces: string[] = [];
      if (rawWs) {
        try {
          const parsed: unknown = JSON.parse(rawWs);
          if (Array.isArray(parsed)) {
            workspaces = parsed
              .filter((x): x is string => typeof x === 'string')
              .map((u) => uriPath(u))
              .filter(Boolean);
          }
        } catch {
          // malformed JSON
        }
      }
      if (!workspaces.length) return;
      const status = typeof row.status === 'string' ? row.status : '';
      const notIdle = row.not_fully_idle === 1 || row.not_fully_idle === 1n || row.not_fully_idle === '1' || row.not_fully_idle === 'true';
      out.push({
        id,
        workspaces,
        modifiedMs: parseSummaryTime(row.last_modified_time),
        active: status === 'CASCADE_RUN_STATUS_RUNNING' || notIdle,
      });
    });
    return out;
  });
}

/** Reads only trajectory_metadata_blob from an Antigravity conversation
 * database to match a conversation to a workspace directory. */
export function readAntigravityTrajectory(p: string, o: DBRead): Promise<{ workspace: string; project: string; ts: number } | null> {
  return readDB(p, o, async (r) => {
    const metaCols = await r.columns('trajectory_metadata_blob');
    if (!metaCols.includes('data')) return null;
    let out: { workspace: string; project: string; ts: number } | null = null;
    await r.rows(`SELECT CASE WHEN ${r.len}(data) <= ? THEN data END AS data FROM trajectory_metadata_blob`, [AG_MAX_META], (row) => {
      if (out?.workspace && out.ts) return;
      const b = bytesOf(row.data);
      if (!b.length) return;
      const t = parseTrajectoryWorkspace(b);
      if (!out) out = t;
      else {
        out.workspace ||= t.workspace;
        out.project ||= t.project;
        out.ts ||= t.ts;
      }
    });
    return out;
  });
}

/** The generations of an Antigravity conversation database at p from since
 * on, plus the latest generation's model and context tokens. */
export function readAntigravitySession(
  p: string,
  since: number,
  fallbackTs: number,
  o: DBRead,
): Promise<{ records: Rec[]; model: string; contextUsed: number }> {
  const limits = o.limits ?? DB_LIMITS;
  const conv = p.replace(/^.*\//, '').replace(/\.db$/, '');
  return readDB(p, o, async (r) => {
    const genCols = await r.columns('gen_metadata');
    if (genCols.length === 0) return { records: [], model: '', contextUsed: 0 };
    if (!genCols.includes('data')) throw new DBError('unreadable');
    const gens: { idx: number; g: Gen }[] = [];
    const need = new Set<number>();
    const want = (s: number) => {
      if (need.size < AG_MAX_STEPS) need.add(s);
    };
    await r.rows(
      `SELECT rowid AS rid, ${genCols.includes('idx') ? 'idx' : 'NULL'} AS idx, CASE WHEN ${r.len}(data) <= ? THEN data END AS data FROM gen_metadata`,
      [AG_MAX_GEN],
      (row) => {
        const b = bytesOf(row.data);
        if (!b.length) return;
        const g = parseGen(b);
        if (!g || g.input + g.cached + g.output === 0) return;
        if (gens.length >= limits.antigravityRecords) throw new DBError('too_large');
        for (const s of g.steps) want(s);
        if (g.lastStep !== undefined) want(g.lastStep);
        gens.push({ idx: row.idx === null ? int(row.rid) : int(row.idx), g });
      },
    );
    if (!gens.length) return { records: [], model: '', contextUsed: 0 };
    let project = '';
    let convTs = 0;
    const metaCols = await r.columns('trajectory_metadata_blob');
    if (metaCols.includes('data')) {
      await r.rows(`SELECT CASE WHEN ${r.len}(data) <= ? THEN data END AS data FROM trajectory_metadata_blob`, [AG_MAX_META], (row) => {
        if (project && convTs) return;
        const b = bytesOf(row.data);
        if (!b.length) return;
        const t = parseTrajectory(b);
        project ||= t.project;
        convTs ||= t.ts;
      });
    }
    const stepTs = new Map<number, number>();
    const stepCols = await r.columns('steps');
    if (need.size && stepCols.includes('metadata')) {
      const idx = stepCols.includes('idx') ? 'idx' : 'NULL';
      const ids = [...need];
      // The rows the generations name, by their rowid, in batches: each is
      // a request to the worker, between which the node goes on.
      for (let i = 0; i < ids.length; i += AG_STEP_BATCH) {
        const batch = ids.slice(i, i + AG_STEP_BATCH);
        await r.rows(
          `SELECT rowid AS rid, ${idx} AS idx, CASE WHEN ${r.len}(metadata) <= ? THEN metadata END AS metadata FROM steps WHERE rowid IN (${batch.map(() => '?').join(',')})`,
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
    let latestModel = '';
    let contextUsed = 0;
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
      const model = firstNonEmpty(g.model, 'unknown');
      if (g.model) latestModel = g.model;
      if (g.input + g.cached > 0) contextUsed = g.input + g.cached;
      recs.push(
        rec({
          k: key,
          t: ts,
          m: model,
          j: project,
          i: g.input,
          c: g.cached,
          o: g.output,
          r: Math.min(g.thinking, g.output),
          n: 1,
        }),
      );
    }
    return { records: recs, model: latestModel, contextUsed };
  });
}

/** The generations of an Antigravity conversation database at p from since
 * on: gen_metadata first, then trajectory_metadata_blob and only the steps
 * rows the generations name (at most AG_MAX_STEPS). fallbackTs (the
 * file's time) dates a generation nothing else dates. */
export async function readAntigravity(p: string, since: number, fallbackTs: number, o: DBRead): Promise<Rec[]> {
  return (await readAntigravitySession(p, since, fallbackTs, o)).records;
}
