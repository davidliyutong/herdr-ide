// The cost scan's cache in the machine's database (machine-<host>.db in
// the agent's data directory, MACHINE_DB, named after the host): a row per
// log with its entry as JSON and that JSON's SHA-256 (usage_cost_files),
// and the cache's version, when it was last saved and a generation every
// save bumps (usage_cost_state). These are the Go agent's tables and
// entries (version 2), so a node of either build reads the cache the
// other saved. A save writes the entries that changed since the last and
// removes those gone, in one transaction, so another agent of the
// instance sees either save whole; tables of a newer version are read and
// not written (the cache then stays in memory).
//
// node:sqlite is synchronous: a load parses its entries a slice at a time
// between yields, and a save writes only what changed since the last, so
// neither holds the node's thread long.
import { createHash } from 'node:crypto';
import { DB, MACHINE_DB, NewerError, exists, hostFile, openShared } from '#shared/store/index.ts';
import { rec, type Entry, type Rec } from './parsers.ts';

/** The cache's version: a cache of another is not read, and a save
 * replaces it whole. */
export const CACHE_VERSION = 2;
/** A cache whose entries take more than this is not loaded. */
const MAX_CACHE_BYTES = 256 << 20;
const FEATURE = 'usage';

/** The Go agent's migration, as it is. */
const MIGRATIONS = [
  `CREATE TABLE usage_cost_files (
		path TEXT PRIMARY KEY,
		sum BLOB NOT NULL,
		entry BLOB NOT NULL
	);
	CREATE TABLE usage_cost_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		version INTEGER NOT NULL,
		saved INTEGER NOT NULL,
		gen INTEGER NOT NULL
	);`,
];

/** The machine's database below the data directory base: this host's. */
export const cacheDB = (base: string): string => hostFile(base, MACHINE_DB);

/** Opens the database with the cache's tables; writable false when they
 * are of a newer version. The caller closes it. */
function openDB(base: string): { db: DB; writable: boolean } {
  const db = openShared(cacheDB(base));
  try {
    db.migrate(FEATURE, MIGRATIONS);
  } catch (e) {
    if (e instanceof NewerError && e.version >= MIGRATIONS.length) return { db, writable: false };
    db.close();
    throw e;
  }
  return { db, writable: !db.readOnly };
}

interface State {
  version: number;
  /** When it was saved, in ms (the table has ns, past what a number
   * holds exactly). */
  savedMs: number;
  gen: number;
}

function stateOf(db: DB): State | undefined {
  const r = db.get<{ version: number | bigint; savedMs: number | bigint; gen: number | bigint }>(
    'SELECT version, saved / 1000000 AS savedMs, gen FROM usage_cost_state WHERE id = 1',
  );
  return r && { version: Number(r.version), savedMs: Number(r.savedMs), gen: Number(r.gen) };
}

/** The cache's generation and when it was last saved (ms); undefined when
 * never (or there is no database). */
export function cacheState(base: string): { gen: number; savedMs: number } | undefined {
  if (!exists(cacheDB(base))) return undefined;
  try {
    const { db } = openDB(base);
    try {
      const s = stateOf(db);
      return s && { gen: s.gen, savedMs: s.savedMs };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** An entry read back from its JSON: members left out are empty. */
function entryOf(v: unknown): Entry | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const e = v as Record<string, unknown>;
  if (typeof e.kind !== 'string') return undefined;
  const records = Array.isArray(e.records) ? (e.records as Partial<Rec>[]).map(rec) : [];
  const out: Entry = { kind: e.kind, size: Number(e.size) || 0, mtime: Number(e.mtime) || 0, off: Number(e.off) || 0, records };
  if (e.models && typeof e.models === 'object') out.models = e.models as Record<string, string>;
  if (e.codex && typeof e.codex === 'object') out.codex = e.codex as Entry['codex'];
  return out;
}

const REC_KEYS = ['k', 't', 'm', 's', 'j', 'i', 'c', 'w', 'h', 'o', 'r', 'n', 'x', 'e', 'v', 'p'] as const;

/** An entry's JSON as the Go agent writes it: empty members left out. */
export function entryJSON(e: Entry): string {
  const records = e.records.map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of REC_KEYS) if (r[k]) o[k] = r[k];
    if (!('t' in o)) o.t = 0;
    return o;
  });
  const o: Record<string, unknown> = { kind: e.kind, size: e.size, mtime: e.mtime };
  if (e.off) o.off = e.off;
  if (records.length) o.records = records;
  if (e.models && Object.keys(e.models).length) o.models = e.models;
  if (e.codex) o.codex = e.codex;
  return JSON.stringify(o);
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/** The cache saved below base and its generation: empty when there is
 * none, it is of another version or larger than MAX_CACHE_BYTES. Entries
 * that do not parse are left out. */
export async function loadCache(base: string): Promise<{ files: Map<string, Entry>; gen: number }> {
  const files = new Map<string, Entry>();
  if (!exists(cacheDB(base))) return { files, gen: 0 };
  let db: DB;
  try {
    ({ db } = openDB(base));
  } catch {
    return { files, gen: 0 };
  }
  try {
    const s = stateOf(db);
    if (!s) return { files, gen: 0 };
    const total = Number(db.get<{ n: number | bigint }>('SELECT coalesce(sum(length(entry)), 0) AS n FROM usage_cost_files')?.n ?? 0);
    if (s.version !== CACHE_VERSION || total > MAX_CACHE_BYTES) return { files, gen: s.gen };
    const it = db.prepare('SELECT path, entry FROM usage_cost_files').iterate() as IterableIterator<{
      path: string;
      entry: Uint8Array | string;
    }>;
    let n = 0;
    for (const r of it) {
      try {
        const e = entryOf(JSON.parse(typeof r.entry === 'string' ? r.entry : Buffer.from(r.entry).toString('utf8')));
        if (e) files.set(r.path, e);
      } catch {
        // left out
      }
      if (++n % 512 === 0) await yieldNow();
    }
    return { files, gen: s.gen };
  } catch {
    return { files: new Map(), gen: 0 };
  } finally {
    db.close();
  }
}

/** Saves the changes of the cache below base: the entries of changed
 * (their JSON compared with the saved one's SHA-256), without those of
 * removed; every entry of files when the saved cache is of another
 * version. Its new generation; false when the tables are newer (not
 * written). savedMs is the save's time. */
export function saveCache(
  base: string,
  files: Map<string, Entry>,
  changed: Iterable<string>,
  removed: Iterable<string>,
  savedMs: number,
): number | false {
  const { db, writable } = openDB(base);
  try {
    if (!writable) return false;
    const gen = db.update(() => {
      const s = stateOf(db);
      const whole = !s || s.version !== CACHE_VERSION;
      if (whole) db.run('DELETE FROM usage_cost_files');
      const write = (p: string) => {
        const e = files.get(p);
        if (!e) return;
        const json = entryJSON(e);
        const sum = createHash('sha256').update(json).digest();
        const old = db.get<{ sum: Uint8Array }>('SELECT sum FROM usage_cost_files WHERE path = ?', p);
        if (old && Buffer.from(old.sum).equals(sum)) return;
        db.run(
          'INSERT INTO usage_cost_files (path, sum, entry) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET sum = excluded.sum, entry = excluded.entry',
          p,
          sum,
          Buffer.from(json),
        );
      };
      if (whole) for (const p of files.keys()) write(p);
      else for (const p of changed) write(p);
      for (const p of removed) if (!files.has(p)) db.run('DELETE FROM usage_cost_files WHERE path = ?', p);
      const gen = (s?.gen ?? 0) + 1;
      db.run(
        'INSERT INTO usage_cost_state (id, version, saved, gen) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version, saved = excluded.saved, gen = excluded.gen',
        CACHE_VERSION,
        BigInt(Math.round(savedMs)) * 1_000_000n,
        gen,
      );
      return gen;
    });
    db.reclaim();
    return gen;
  } finally {
    db.close();
  }
}

/** Drops the cache below base when it was last saved before cutoffMs: no
 * scan read the logs since (the feature is off), and its records are past
 * the retention. */
export function dropStale(base: string, cutoffMs: number): void {
  if (!exists(cacheDB(base))) return;
  try {
    const { db, writable } = openDB(base);
    try {
      const s = stateOf(db);
      if (!writable || !s || s.savedMs >= cutoffMs) return;
      db.update(() => {
        db.run('DELETE FROM usage_cost_files');
        db.run('DELETE FROM usage_cost_state');
      });
      db.reclaim();
    } finally {
      db.close();
    }
  } catch {
    // next time
  }
}
