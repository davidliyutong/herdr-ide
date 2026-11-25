// The host's journal: chat-<host>.db in the instance's data directory
// (hostFile: the data directory may be on a home several hosts share, and a
// database in write-ahead logging is one host's), its own SQLite database
// with the Go host's tables, so either build's host reads what the other
// wrote. It holds the chats, their stored events, the trusted folders and
// the core's last settings.
//
// SQLite runs in a worker thread: node:sqlite's calls are synchronous, and
// a write that waits (a data directory on a network mount that stopped
// answering, a checkpoint's sync on a slow disk) would otherwise stop the
// host's one thread: every chat, every agent's output and every
// connection. The database is opened and migrated on the host's thread
// once, before the host serves (#shared/store's open: a private directory
// and file of the user's, not links, a newer host's database refused);
// from then on the worker has the only connection. It runs one request at a
// time in the order they were made, each change a transaction of its own,
// and answers each; the host goes on meanwhile. What a write that waits
// holds is the journal: the chats' stored events wait for it in order
// (chat.ts sends an event to its clients only once it is stored), never the
// host's thread.
//
// The worker is a script of its own, without imports but node:sqlite,
// started from a Blob: it needs no entrypoint of its own in the compiled
// executable. It knows no table: the host sends it the statements.
import { formatRFC3339, parseRFC3339 } from '#shared/lib/gotime.ts';
import { NewerError, hostFile, open, pruneHostFiles } from '#shared/store/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import type { FileID } from './trust.ts';

/** The name of the host's database in the instance's data directory, which
 * the file of each host has with the host's name (chat-<host>.db). */
export const DB_NAME = 'chat.db';

/** The most directories the trusted list keeps: one more drops the one
 * trusted the longest ago. */
export const MAX_TRUSTED = 1000;

/** How many events one transaction deletes: a large log goes in steps, and
 * the chats that write meanwhile wait for one step at most. */
const DELETE_BATCH = 2000;

/** The schema of the database: the Go host's migrations, as they are.
 *
 * chats holds every member of a Chat but its status (computed), with the
 * JSON of its configuration options, slash commands, usage and
 * capabilities, and what the host keeps beside: the sequence number of the
 * last turn's end, the options the agent is started with again, the item a
 * later history of the session starts after, and the bytes of its events.
 * events holds the stored events, each as the line a client gets (json),
 * with its type, item and time. Times are milliseconds since the epoch, 0
 * for none. A chat is fresh while its agent's session never had a turn;
 * renamed when the user named it; untrusted_told when its log tells that
 * its agent started without the project's own settings. trusted lists the
 * directories the user trusted, with when, and the device and inode the
 * directory had then. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE settings (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	CREATE TABLE chats (
		id            TEXT PRIMARY KEY,
		kind          TEXT NOT NULL,
		title         TEXT NOT NULL DEFAULT '',
		cwd           TEXT NOT NULL,
		session_id    TEXT NOT NULL DEFAULT '',
		state         TEXT NOT NULL,
		error         TEXT NOT NULL DEFAULT '',
		created       INTEGER NOT NULL,
		updated       INTEGER NOT NULL,
		seq           INTEGER NOT NULL DEFAULT 0,
		seen          INTEGER NOT NULL DEFAULT 0,
		closed        INTEGER NOT NULL DEFAULT 0,
		handed_off    INTEGER NOT NULL DEFAULT 0,
		agent_version TEXT NOT NULL DEFAULT '',
		config        TEXT NOT NULL DEFAULT '',
		commands      TEXT NOT NULL DEFAULT '',
		usage         TEXT NOT NULL DEFAULT '',
		capabilities  TEXT NOT NULL DEFAULT '',
		turn_end      INTEGER NOT NULL DEFAULT 0,
		options       TEXT NOT NULL DEFAULT '',
		history_after TEXT NOT NULL DEFAULT '',
		bytes         INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE events (
		id   INTEGER PRIMARY KEY,
		chat TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
		seq  INTEGER NOT NULL,
		t    TEXT NOT NULL,
		item TEXT NOT NULL DEFAULT '',
		at   INTEGER NOT NULL,
		json BLOB NOT NULL
	);
	CREATE UNIQUE INDEX events_chat_seq ON events (chat, seq);`,
  `ALTER TABLE chats ADD COLUMN fresh INTEGER NOT NULL DEFAULT 0;
	CREATE TABLE trusted (
		path TEXT PRIMARY KEY,
		at   INTEGER NOT NULL
	);`,
  // The directories trusted before their device and inode were kept are
  // trusted no longer.
  `ALTER TABLE chats ADD COLUMN renamed INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE chats ADD COLUMN untrusted_told INTEGER NOT NULL DEFAULT 0;
	DELETE FROM trusted;
	ALTER TABLE trusted ADD COLUMN dev INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE trusted ADD COLUMN ino INTEGER NOT NULL DEFAULT 0;`,
  // archived: when the chat was archived (Op.Archive), 0 while it is not.
  `ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`,
];

/** What the journal keeps of a chat. */
export interface Row {
  chat: chat.Chat;
  turnEnd: number;
  options: chat.Options;
  historyAfter: string;
  bytes: number;
  /** The session was made for the chat and never had a turn. */
  fresh: boolean;
  /** The user named the chat; its agent's title does not replace the name. */
  renamed: boolean;
  /** The log tells that the agent started without the project's own
   * settings, since its last start in a trusted folder. */
  untrustedTold: boolean;
}

/** An event as the journal keeps it. */
export interface Stored {
  seq: number;
  t: string;
  item: string;
  /** ms since the epoch. */
  at: number;
  /** The line a client gets, without its newline. */
  line: string;
}

/** What an append changes of the chat's row with the event: the row's
 * members as of this event. */
export interface AppendRow {
  updated: number;
  turnEnd: number;
  historyAfter: string;
  fresh: boolean;
}

/** A directory of the trusted list, with the device and inode it had when
 * it was trusted. */
export interface TrustedDir {
  path: string;
  /** ms since the epoch. */
  at: number;
  id: FileID;
}

/** A refused write. gap: the append was refused because the chat's log
 * would have a hole (an earlier append of it did not go through). */
export class JournalError extends Error {
  readonly gap: boolean;

  constructor(message: string, gap = false) {
    super(message);
    this.gap = gap;
    this.name = 'JournalError';
  }
}

type Param = null | number | bigint | string | Uint8Array;
type SQLRow = Record<string, Param>;
interface Step {
  sql: string;
  params: Param[];
  /** The changes the statement must make; another number rolls the
   * transaction back (a gap). */
  expect?: number;
}
type Request =
  | { op: 'open'; path: string; pragmas: string[] }
  | { op: 'tx'; steps: Step[] }
  | { op: 'all'; sql: string; params: Param[] }
  | { op: 'close' };
type Reply = { id: number; ok: true; changes?: number[]; rows?: SQLRow[] } | { id: number; ok: false; gap?: boolean; message: string };

/** The worker's script. */
const SOURCE = `
const { DatabaseSync } = require('node:sqlite');
let db = null;
const stmts = new Map();
const prep = (sql) => {
  let s = stmts.get(sql);
  if (!s) {
    if (stmts.size >= 128) stmts.clear();
    s = db.prepare(sql);
    stmts.set(sql, s);
  }
  return s;
};
self.onmessage = (ev) => {
  const m = ev.data;
  let out;
  try {
    if (m.op === 'open') {
      db = new DatabaseSync(m.path);
      for (const p of m.pragmas) db.exec(p);
      out = { ok: true };
    } else if (m.op === 'tx') {
      db.exec('BEGIN IMMEDIATE');
      try {
        const changes = [];
        for (const s of m.steps) {
          const r = prep(s.sql).run(...s.params);
          if (s.expect !== undefined && Number(r.changes) !== s.expect) {
            const e = new Error('the chat\\'s log would have a gap');
            e.gap = true;
            throw e;
          }
          changes.push(Number(r.changes));
        }
        db.exec('COMMIT');
        out = { ok: true, changes };
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }
    } else if (m.op === 'all') out = { ok: true, rows: prep(m.sql).all(...m.params) };
    else if (m.op === 'close') {
      stmts.clear();
      if (db) db.close();
      db = null;
      out = { ok: true };
    } else out = { ok: false, message: 'unknown op' };
  } catch (e) {
    out = { ok: false, gap: !!(e && e.gap), message: String((e && e.message) || e) };
  }
  postMessage({ id: m.id, ...out });
};
`;

let source: string | undefined;
/** The worker's script as a URL (one per process). */
const sourceURL = () => (source ??= URL.createObjectURL(new Blob([SOURCE], { type: 'application/javascript' })));

/** A time as the wire has it (RFC 3339, as Go writes it); Go's zero time for
 * 0. */
export const timeOf = (t: number): string => (t ? formatRFC3339(new Date(t)) : '0001-01-01T00:00:00Z');
/** The ms since the epoch of a time of the wire; 0 for none or Go's zero
 * time. */
export function msOf(s: string | undefined): number {
  if (!s) return 0;
  const t = parseRFC3339(s)?.getTime() ?? 0;
  return t > 0 ? t : 0;
}
const ms = msOf;
const rfc = (v: Param): string | undefined => (Number(v) ? timeOf(Number(v)) : undefined);
const text = (v: Param): string =>
  v === null ? '' : typeof v === 'string' ? v : v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v);
const num = (v: Param): number => Number(v ?? 0);

/** v's JSON, "" for nothing. */
function jsonText(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = JSON.stringify(v);
  return s === undefined || s === 'null' ? '' : s;
}

function parse<T>(s: string, def: T): T {
  if (!s) return def;
  try {
    return JSON.parse(s) as T;
  } catch {
    return def;
  }
}

/** Where a journal is and how it is opened. */
export interface JournalOptions {
  /** The instance's data directory. */
  base: string;
  /** How long a statement waits for another connection's lock. */
  busyTimeout?: number;
}

/** The host's database, its SQL run by a worker thread. Every method sends
 * one request; they run in the order they were made. */
export class Journal {
  readonly path: string;
  private readonly w: Worker;
  private next = 1;
  private readonly waiting = new Map<number, (r: Reply) => void>();
  private failed: string | null = null;
  /** The bytes of the events whose appends wait. */
  private queued = 0;
  /** The next appends the worker refuses as a write that failed (tests). */
  failAppends = 0;

  private constructor(path: string) {
    this.path = path;
    this.w = new Worker(sourceURL());
    this.w.onmessage = (ev: MessageEvent<Reply>) => {
      const f = this.waiting.get(ev.data.id);
      this.waiting.delete(ev.data.id);
      f?.(ev.data);
    };
    this.w.onerror = (ev) => this.fail(`the journal's worker failed: ${(ev as ErrorEvent).message ?? 'unknown'}`);
    // The host ends by itself; a worker does not hold its process.
    (this.w as unknown as { unref?: () => void }).unref?.();
  }

  /** Opens this host's database in base: checked and migrated on this
   * thread, then served by the worker. A database a newer host wrote is not
   * used: NewerError. The other hosts' databases of a shared home nobody
   * used for 30 days go (logged by the caller from pruned). */
  static async open(o: JournalOptions): Promise<{ journal: Journal; pruned: string[]; pruneError?: Error }> {
    const path = hostFile(o.base, DB_NAME);
    const db = open(path, { migrations: MIGRATIONS, busyTimeout: o.busyTimeout });
    const newer = db.newer;
    db.close();
    if (newer) throw newer;
    let pruned: string[] = [];
    let pruneError: Error | undefined;
    try {
      pruned = pruneHostFiles(o.base, DB_NAME);
    } catch (e) {
      pruneError = e as Error;
    }
    const j = new Journal(path);
    const busy = o.busyTimeout && o.busyTimeout > 0 ? o.busyTimeout : 5000;
    await j.request({
      op: 'open',
      path,
      pragmas: [`PRAGMA busy_timeout = ${busy}`, 'PRAGMA journal_mode = WAL', 'PRAGMA foreign_keys = ON', 'PRAGMA synchronous = NORMAL'],
    });
    return { journal: j, pruned, ...(pruneError ? { pruneError } : {}) };
  }

  private fail(why: string): void {
    this.failed ??= why;
    for (const [, f] of this.waiting) f({ id: 0, ok: false, message: why });
    this.waiting.clear();
  }

  private request(m: Request): Promise<Reply & { ok: true }> {
    if (this.failed) return Promise.reject(new JournalError(this.failed));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (r) => (r.ok ? resolve(r) : reject(new JournalError(r.message, r.gap === true))));
      this.w.postMessage({ ...m, id });
    });
  }

  private async all(sql: string, ...params: Param[]): Promise<SQLRow[]> {
    return (await this.request({ op: 'all', sql, params })).rows ?? [];
  }

  private async tx(...steps: Step[]): Promise<number[]> {
    return (await this.request({ op: 'tx', steps })).changes ?? [];
  }

  /** The bytes of the events whose appends wait for the worker. */
  get backlog(): number {
    return this.queued;
  }

  /** Stores a new chat. */
  async insertChat(r: Row): Promise<void> {
    await this.tx(
      {
        sql: 'INSERT INTO chats (id, kind, cwd, state, created, updated) VALUES (?, ?, ?, ?, ?, ?)',
        params: [r.chat.id, r.chat.kind, r.chat.cwd, r.chat.state, ms(r.chat.created), ms(r.chat.updated)],
      },
      this.saveStep(r),
    );
  }

  /** The statement that stores every member of a chat but those its
   * appends keep (seq, updated, turn_end, history_after, bytes). */
  private saveStep(r: Row): Step {
    const c = r.chat;
    // The agent's standard error is never stored.
    const err = c.error ? jsonText(chat.withoutStderr(c.error)) : '';
    return {
      sql: `UPDATE chats SET kind = ?, title = ?, cwd = ?, session_id = ?, state = ?, error = ?, created = ?, seen = ?,
		closed = ?, handed_off = ?, agent_version = ?, config = ?, commands = ?, usage = ?, capabilities = ?, options = ?,
		fresh = ?, renamed = ?, untrusted_told = ?, archived = ? WHERE id = ?`,
      params: [
        c.kind,
        c.title,
        c.cwd,
        c.sessionId,
        c.state,
        err,
        ms(c.created),
        c.seen,
        ms(c.closed),
        c.handedOff ? 1 : 0,
        c.agentVersion ?? '',
        jsonText(c.config),
        jsonText(c.commands),
        jsonText(c.usage),
        jsonText(c.capabilities),
        jsonText(r.options),
        r.fresh ? 1 : 0,
        r.renamed ? 1 : 0,
        r.untrustedTold ? 1 : 0,
        ms(c.archived),
        c.id,
      ],
    };
  }

  /** Stores the members of a chat that are not its appends'. */
  saveChat(r: Row): Promise<void> {
    return this.tx(this.saveStep(r)).then(() => {});
  }

  /** Stores an event of a chat with what it changes of the chat's row:
   * only after the chat's event before it (prev, the row's seq), so that a
   * log never has a hole (JournalError with gap otherwise). */
  async appendEvent(chatId: string, prev: number, e: Stored, row: AppendRow): Promise<void> {
    const b = Buffer.from(e.line, 'utf8');
    this.queued += b.length;
    if (this.failAppends > 0) {
      this.failAppends--;
      // A statement the worker refuses: the transaction fails there.
      prev = -1;
    }
    try {
      await this.tx(
        {
          sql: 'UPDATE chats SET seq = ?, updated = ?, turn_end = ?, history_after = ?, bytes = bytes + ?, fresh = ? WHERE id = ? AND seq = ?',
          params: [e.seq, row.updated, row.turnEnd, row.historyAfter, b.length, row.fresh ? 1 : 0, chatId, prev],
          expect: 1,
        },
        {
          sql: 'INSERT INTO events (chat, seq, t, item, at, json) VALUES (?, ?, ?, ?, ?, ?)',
          params: [chatId, e.seq, e.t, e.item, e.at, b],
        },
      );
    } finally {
      this.queued -= b.length;
    }
  }

  /** Reads every chat. */
  async loadChats(): Promise<Row[]> {
    const rows = await this.all(`SELECT id, kind, title, cwd, session_id, state, error, created, updated, seq, seen,
		closed, handed_off, agent_version, config, commands, usage, capabilities, turn_end, options, history_after, bytes,
		fresh, renamed, untrusted_told, archived FROM chats`);
    return rows.map((r) => {
      const c: chat.Chat = {
        id: text(r.id!),
        kind: text(r.kind!),
        title: text(r.title!),
        cwd: text(r.cwd!),
        sessionId: text(r.session_id!),
        state: text(r.state!),
        status: chat.Status.Idle,
        created: rfc(r.created!) ?? timeOf(0),
        updated: rfc(r.updated!) ?? timeOf(0),
        seq: num(r.seq!),
        seen: num(r.seen!),
        capabilities: parse(text(r.capabilities!), emptyCapabilities()),
      };
      const closed = rfc(r.closed!);
      if (closed) c.closed = closed;
      const archived = rfc(r.archived!);
      if (archived) c.archived = archived;
      if (num(r.handed_off!)) c.handedOff = true;
      if (text(r.agent_version!)) c.agentVersion = text(r.agent_version!);
      const err = parse<chat.ChatError | null>(text(r.error!), null);
      if (err) c.error = { code: String(err.code ?? ''), message: String(err.message ?? '') };
      const config = parse<chat.ConfigOption[] | null>(text(r.config!), null);
      if (config) c.config = config;
      const commands = parse<chat.SlashCommand[] | null>(text(r.commands!), null);
      if (commands) c.commands = commands;
      const usage = parse<chat.Usage | null>(text(r.usage!), null);
      if (usage) c.usage = usage;
      return {
        chat: c,
        turnEnd: num(r.turn_end!),
        options: parse<chat.Options>(text(r.options!), {}),
        historyAfter: text(r.history_after!),
        bytes: num(r.bytes!),
        fresh: num(r.fresh!) !== 0,
        renamed: num(r.renamed!) !== 0,
        untrustedTold: num(r.untrusted_told!) !== 0,
      };
    });
  }

  /** The lowest sequence number of a chat's stored events; 0 when it has
   * none. */
  async first(chatId: string): Promise<number> {
    const [r] = await this.all('SELECT MIN(seq) AS first FROM events WHERE chat = ?', chatId);
    return num(r?.first ?? 0);
  }

  /** The lines of a chat's stored events with a sequence number in (after,
   * upTo], each with its newline, the oldest first: as many as fit max bytes,
   * one at least. last is the sequence number of the last one read. */
  async events(chatId: string, after: number, upTo: number, max: number): Promise<{ lines: string[]; last: number }> {
    if (after >= upTo) return { lines: [], last: after };
    const rows = await this.all(
      'SELECT seq, json FROM events WHERE chat = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT 512',
      chatId,
      after,
      upTo,
    );
    const lines: string[] = [];
    let size = 0;
    let last = after;
    for (const r of rows) {
      const l = text(r.json!) + '\n';
      const n = Buffer.byteLength(l);
      if (lines.length > 0 && size + n > max) break;
      lines.push(l);
      size += n;
      last = num(r.seq!);
    }
    return { lines, last };
  }

  /** The stored events of a chat of the given types, the oldest first. */
  async eventsOf(chatId: string, ...types: string[]): Promise<chat.Event[]> {
    const out: chat.Event[] = [];
    for (const t of types) {
      for (const r of await this.all('SELECT json FROM events WHERE chat = ? AND t = ? ORDER BY seq', chatId, t)) {
        const ev = parse<chat.Event | null>(text(r.json!), null);
        if (ev) out.push(ev);
      }
    }
    return out;
  }

  /** The page's ids (Event.clientId) of the last n prompts of a chat its
   * log keeps (user and queued events), the oldest first. */
  async clientIDs(chatId: string, n: number): Promise<string[]> {
    const rows = await this.all(
      'SELECT json FROM events WHERE chat = ? AND t IN (?, ?) ORDER BY seq DESC LIMIT ?',
      chatId,
      chat.EventType.User,
      chat.EventType.Queued,
      2 * n,
    );
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (ids.length >= n) break;
      const id = parse<{ clientId?: unknown }>(text(r.json!), {}).clientId;
      if (typeof id === 'string' && id !== '' && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids.reverse();
  }

  /** Deletes at most DELETE_BATCH of a chat's oldest events, as many as
   * needed for over bytes: the bytes deleted, and done when nothing was left
   * to delete. */
  async trimStep(chatId: string, over: number): Promise<{ deleted: number; done: boolean }> {
    const rows = await this.all('SELECT seq, length(json) AS n FROM events WHERE chat = ? ORDER BY seq LIMIT ?', chatId, DELETE_BATCH);
    let upTo = 0;
    let n = 0;
    for (const r of rows) {
      if (n >= over) break;
      upTo = num(r.seq!);
      n += num(r.n!);
    }
    if (rows.length === 0 || upTo === 0) return { deleted: 0, done: true };
    await this.tx(
      { sql: 'DELETE FROM events WHERE chat = ? AND seq <= ?', params: [chatId, upTo] },
      { sql: 'UPDATE chats SET bytes = MAX(bytes - ?, 0) WHERE id = ?', params: [n, chatId] },
    );
    return { deleted: n, done: false };
  }

  /** Forgets a chat and its events, the events a batch at a time. */
  async deleteChat(chatId: string): Promise<void> {
    for (;;) {
      const [n] = await this.tx({
        sql: 'DELETE FROM events WHERE id IN (SELECT id FROM events WHERE chat = ? ORDER BY seq LIMIT ?)',
        params: [chatId, DELETE_BATCH],
      });
      if ((n ?? 0) < DELETE_BATCH) break;
    }
    await this.tx({ sql: 'DELETE FROM chats WHERE id = ?', params: [chatId] });
  }

  /** The settings the core gave last; undefined when none. */
  async settings(): Promise<chat.HostSettings | undefined> {
    const [r] = await this.all('SELECT value FROM settings WHERE key = ?', 'host');
    return r ? parse<chat.HostSettings | undefined>(text(r.value!), undefined) : undefined;
  }

  /** Keeps the settings the core gave. */
  async putSettings(s: chat.HostSettings): Promise<void> {
    await this.tx({
      sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      params: ['host', jsonText(s)],
    });
  }

  /** Adds a directory to the trusted list, with the device and inode it
   * has; beyond MAX_TRUSTED the one trusted the longest ago goes. */
  async trust(path: string, at: number, id: FileID): Promise<void> {
    await this.tx(
      {
        sql: `INSERT INTO trusted (path, at, dev, ino) VALUES (?, ?, ?, ?)
		ON CONFLICT (path) DO UPDATE SET at = excluded.at, dev = excluded.dev, ino = excluded.ino`,
        params: [path, at, BigInt.asIntN(64, id.dev), BigInt.asIntN(64, id.ino)],
      },
      { sql: 'DELETE FROM trusted WHERE path NOT IN (SELECT path FROM trusted ORDER BY at DESC, path LIMIT ?)', params: [MAX_TRUSTED] },
    );
  }

  private static trusted(r: SQLRow): TrustedDir {
    const big = (v: Param) => BigInt.asUintN(64, typeof v === 'bigint' ? v : BigInt(Number(v ?? 0)));
    return { path: text(r.path!), at: num(r.at ?? 0), id: { dev: big(r.dev!), ino: big(r.ino!) } };
  }

  /** Every trusted directory, the most recently trusted first. */
  async listTrusted(): Promise<TrustedDir[]> {
    return (await this.all('SELECT path, at, dev, ino FROM trusted ORDER BY at DESC, path')).map(Journal.trusted);
  }

  /** The directories of the trusted list among dir, an absolute clean path,
   * and the directories above it, dir first. */
  async trustedAbove(dir: string): Promise<TrustedDir[]> {
    const paths: string[] = [];
    for (let p = dir; ; p = p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/'))) {
      paths.push(p);
      if (p === '/') break;
    }
    const rows = await this.all(
      `SELECT path, at, dev, ino FROM trusted WHERE path IN (${paths.map(() => '?').join(', ')}) ORDER BY length(path) DESC`,
      ...paths,
    );
    return rows.map(Journal.trusted);
  }

  /** Removes directories from the trusted list. */
  async untrust(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.tx({ sql: `DELETE FROM trusted WHERE path IN (${paths.map(() => '?').join(', ')})`, params: paths });
  }

  /** Holds the worker for as long as a statement of n rows takes, as a
   * write that waits would (tests). */
  async holdForTests(n: number): Promise<void> {
    await this.all('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c', n);
  }

  /** Waits for every request made so far; then closes the database and
   * ends the worker. */
  async close(): Promise<void> {
    try {
      await this.request({ op: 'close' });
    } catch {
      // ended all the same
    }
    this.w.terminate();
    this.fail('the journal is closed');
  }

  /** Ends the worker at once (a host that did not stop in time). */
  terminate(): void {
    this.w.terminate();
    this.fail('the journal is closed');
  }
}

/** The capabilities of a chat that has no agent's yet. */
export const emptyCapabilities = (): chat.Capabilities => ({
  images: false,
  compact: false,
  queue: false,
  plan: false,
  questions: false,
  effort: false,
  model: false,
  cancelQueued: false,
});

export { NewerError };
