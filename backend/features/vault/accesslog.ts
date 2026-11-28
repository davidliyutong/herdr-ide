// The access log records every request of a machine's MCP server and every
// value a page took (a reveal, an export): names only, never values. It is
// kept in the hub's database (hub-<host>[-<id>].db beside the settings
// file, named for this host), table vault_access, and read back at
// the first use, so the panel shows what happened before a restart too. A
// record that lets values out is committed to disk before they leave; one
// that cannot be written refuses the release (log_failed). Lists and
// refusals, which a program repeats at will, merge into one record with a
// count, and are bounded apart from the releases, so they never push one
// out.
import type { VaultProcess } from '#shared/proto/agentproto/index.ts';
import { hubDBBeside as hubDBOf, NewerError, openShared, type DB } from '#shared/store/index.ts';

export const MAX_RELEASES = 1000;
export const MAX_OTHERS = 500;
/** How often a record that took in repeated calls is written again. */
const FLUSH_EVERY = 5000;

export const Result = {
  Allowed: 'allowed',
  Approved: 'approved',
  ApprovedAlways: 'approved_always',
  Listed: 'listed',
  /** The user denied the request. */
  Denied: 'denied',
  /** Nobody answered in time (the requester is told denied). */
  Expired: 'expired',
  /** The requester went away before an answer. */
  Cancelled: 'cancelled',
  Revealed: 'revealed',
  Exported: 'exported',
  /** Values given without asking to an exempt app. */
  Exempted: 'exempted',
  /** Values injected into a new panel from workspace-linked presets. */
  Injected: 'injected',
  /** Not released: the record could not be written. */
  LogFailed: 'log_failed',
} as const;

const RELEASES: readonly string[] = [
  Result.Allowed,
  Result.Approved,
  Result.ApprovedAlways,
  Result.Exempted,
  Result.Injected,
  Result.Revealed,
  Result.Exported,
];

/** Whether a record of result let values out. */
export const released = (result: string) => RELEASES.includes(result);

/** Lists and refusals: merged, rate-limited in the audit log, no reload of
 * the pages. The user's answer, an expiry and a record that failed are
 * recorded every time. */
export const noisy = (result: string) =>
  result !== Result.Denied && result !== Result.Expired && result !== Result.LogFailed && !released(result);

export interface Access {
  id: number;
  time: string;
  /** The machine whose MCP server asked; "" for a page. */
  m: string;
  tool: string;
  names?: string[];
  /** What the MCP server says of itself: not trusted. */
  client?: string;
  terminal?: string;
  cwd?: string;
  /** The process connected to vault.sock and its parents, as the
   * machine's agent saw them. */
  process?: VaultProcess[];
  /** A page's address and browser. */
  remote?: string;
  userAgent?: string;
  result: string;
  /** Identical list calls or refusals in a row (1 when absent). */
  count?: number;
}

const sameCall = (a: Access, b: Access) =>
  a.m === b.m &&
  a.tool === b.tool &&
  a.client === b.client &&
  a.terminal === b.terminal &&
  a.cwd === b.cwd &&
  a.result === b.result &&
  a.remote === b.remote &&
  a.userAgent === b.userAgent &&
  JSON.stringify(a.names ?? []) === JSON.stringify(b.names ?? []) &&
  JSON.stringify(a.process ?? []) === JSON.stringify(b.process ?? []);

const MIGRATIONS = [
  `CREATE TABLE vault_access (
		id INTEGER PRIMARY KEY,
		released INTEGER NOT NULL,
		record TEXT NOT NULL
	);
	CREATE INDEX vault_access_class ON vault_access (released, id);`,
];

/** The hub's database beside the vault's file: vault.json beside
 * settings.json, whose database is hub-<host>[-<id>].db, named for this
 * host (hostFile; #shared/store/hubdb.ts). "" for "". */
export function hubDBBeside(vaultFile: string): string {
  return hubDBOf(vaultFile, 'vault');
}

class Newer extends Error {
  constructor() {
    super("the hub's database is of a newer version: records are not kept");
  }
}

export interface AccessLogOptions {
  /** The database; "" keeps the log in memory only. */
  db: string;
  logger: (msg: string) => void;
  maxReleases?: number;
  maxOthers?: number;
  flushEveryMs?: number;
}

export class AccessLog {
  readonly #o: Required<AccessLogOptions>;
  /** The records were read (or there is no database): until then each use
   * tries again. */
  #loaded = false;
  #recs: Access[] = [];
  #nextID = 1;
  /** Records without a row: their write failed, or the log was not read. */
  #unsaved = new Set<number>();
  /** The last record took in calls since it was written. */
  #stale = false;
  #flush: ReturnType<typeof setTimeout> | null = null;
  #newerTold = false;

  constructor(o: AccessLogOptions) {
    this.#o = { maxReleases: MAX_RELEASES, maxOthers: MAX_OTHERS, flushEveryMs: FLUSH_EVERY, ...o };
  }

  #log(msg: string): void {
    this.#o.logger(`vault: access log: ${msg}`);
  }

  /** The database with the log's tables; writable false when they are of
   * a newer version. The caller closes it. */
  #open(): { db: DB; writable: boolean } {
    const db = openShared(this.#o.db);
    try {
      db.migrate('vault', MIGRATIONS);
      return { db, writable: true };
    } catch (e) {
      if (e instanceof NewerError && e.version >= MIGRATIONS.length) return { db, writable: false };
      db.close();
      throw e;
    }
  }

  /** Reads the records once a read succeeds. What was added before stays:
   * records without a row follow the rows, numbered after them. */
  #load(): void {
    if (this.#loaded) return;
    if (!this.#o.db) {
      this.#loaded = true;
      return;
    }
    let rows: Access[];
    try {
      const { db } = this.#open();
      try {
        rows = db.all<{ record: string }>('SELECT record FROM vault_access ORDER BY id').flatMap((r) => {
          try {
            const a = JSON.parse(String(r.record)) as Access;
            return a && a.id > 0 ? [a] : [];
          } catch {
            return [];
          }
        });
      } finally {
        db.close();
      }
    } catch (e) {
      this.#log((e as Error).message);
      return;
    }
    this.#loaded = true;
    let next = rows.reduce((n, a) => Math.max(n, a.id + 1), 1);
    const byId = new Map(rows.map((a, i) => [a.id, i]));
    const unsaved = new Set<number>();
    for (const a of this.#recs) {
      if (this.#unsaved.has(a.id)) {
        rows.push({ ...a, id: next });
        unsaved.add(next++);
      } else if (byId.has(a.id)) rows[byId.get(a.id)!] = a;
    }
    this.#recs = rows;
    this.#unsaved = unsaved;
    this.#nextID = next;
    this.#trim();
  }

  /** Records rec, or adds to the last record's count when it repeats its
   * call (coalesce). The record is written; committed to disk when durable
   * (it lets values out), and when that fails it says log_failed and the
   * release must not happen (ok false). */
  add(rec: Omit<Access, 'id'>, coalesce: boolean, durable: boolean): { kept: Access; ok: boolean } {
    this.#load();
    const last = this.#recs.at(-1);
    if (coalesce && last && sameCall(last, { ...rec, id: 0 })) {
      last.time = rec.time;
      last.count = Math.max(last.count ?? 1, 1) + 1;
      this.#stale = true;
      this.#scheduleFlush();
      return { kept: { ...last }, ok: true };
    }
    if (this.#stale) {
      this.#writeLast(false);
      this.#stale = false;
    }
    const a: Access = { id: this.#nextID++, ...rec };
    this.#recs.push(a);
    this.#unsaved.add(a.id);
    let ok = true;
    try {
      this.#writeAt(this.#recs.length - 1, durable);
    } catch (e) {
      if (!(e instanceof Newer) || !this.#newerTold) this.#log((e as Error).message);
      this.#newerTold ||= e instanceof Newer;
      if (durable) {
        a.result = Result.LogFailed;
        ok = false;
      }
    }
    const kept = { ...a };
    this.#trim();
    return { kept, ok };
  }

  #writeLast(durable: boolean): void {
    try {
      this.#writeAt(this.#recs.length - 1, durable);
    } catch (e) {
      if (!(e instanceof Newer) || !this.#newerTold) this.#log((e as Error).message);
    }
  }

  /** Writes recs[i]; a record without a row gets its id in the write's
   * transaction, after every row's. Its class keeps its newest records. */
  #writeAt(i: number, durable: boolean): void {
    const rec = this.#recs[i];
    const fresh = this.#unsaved.has(rec.id);
    if (!this.#o.db) {
      this.#unsaved.delete(rec.id);
      return;
    }
    const { db, writable } = this.#open();
    try {
      if (!writable) throw new Newer();
      const rel = released(rec.result) ? 1 : 0;
      const keep = rel ? this.#o.maxReleases : this.#o.maxOthers;
      const id = (durable ? db.durable.bind(db) : db.update.bind(db))(() => {
        let id = rec.id;
        if (fresh) {
          const top = Number(Object.values(db.get('SELECT coalesce(max(id), 0) FROM vault_access') ?? {})[0] ?? 0);
          id = Math.max(id, top + 1);
        }
        db.run(
          `INSERT INTO vault_access (id, released, record) VALUES (?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET released = excluded.released, record = excluded.record`,
          id,
          rel,
          JSON.stringify({ ...rec, id }),
        );
        db.run(
          `DELETE FROM vault_access WHERE released = ?1 AND id NOT IN
		(SELECT id FROM vault_access WHERE released = ?1 ORDER BY id DESC LIMIT ?2)`,
          rel,
          keep,
        );
        return id;
      });
      if (fresh) {
        this.#unsaved.delete(rec.id);
        rec.id = id;
        this.#nextID = Math.max(this.#nextID, id + 1);
      }
    } finally {
      db.close();
    }
  }

  #scheduleFlush(): void {
    if (this.#flush || !this.#o.db) return;
    this.#flush = setTimeout(() => {
      this.#flush = null;
      if (this.#stale && this.#recs.length) {
        this.#writeLast(false);
        this.#stale = false;
      }
    }, this.#o.flushEveryMs);
  }

  /** Drops the oldest records past the bounds of their class. */
  #trim(): void {
    let releases = this.#recs.filter((a) => released(a.result)).length;
    let others = this.#recs.length - releases;
    if (releases <= this.#o.maxReleases && others <= this.#o.maxOthers) return;
    this.#recs = this.#recs.filter((a) => {
      if (released(a.result)) return releases <= this.#o.maxReleases || (releases--, false);
      return others <= this.#o.maxOthers || (others--, false);
    });
    const kept = new Set(this.#recs.map((a) => a.id));
    for (const id of this.#unsaved) if (!kept.has(id)) this.#unsaved.delete(id);
  }

  /** The records, newest first. */
  list(): Access[] {
    this.#load();
    return this.#recs.map((a) => ({ ...a })).reverse();
  }

  /** Writes a record waiting for its flush and stops the timer. */
  close(): void {
    if (this.#flush) clearTimeout(this.#flush);
    this.#flush = null;
    if (this.#stale && this.#recs.length) this.#writeLast(false);
    this.#stale = false;
  }
}
