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
// These operations run on the machine's state worker. The scanner sends
// only changed entries, unless the worker needs to replace the cache.
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
const CACHE_BATCH_BYTES = 1 << 20;

interface CacheBatch {
  gen: number;
  files: [string, Entry][];
  reset?: boolean;
}

const emptyBatch = (): CacheBatch => ({ gen: 0, files: [], reset: true });

/** The cache saved below base and its generation: empty when there is
 * none, it is of another version or larger than MAX_CACHE_BYTES. Entries
 * that do not parse are left out. */
export async function loadCache(base: string): Promise<{ files: Map<string, Entry>; gen: number }> {
  const files = new Map<string, Entry>();
  const batches = cacheBatches(base);
  for (;;) {
    const { value, done } = await batches.next();
    if (value.reset) files.clear();
    for (const [path, entry] of value.files) files.set(path, entry);
    if (done) return { files, gen: value.gen };
    await yieldNow();
  }
}

/** Reads entries in batches. The receiver pulls one batch at a time so
 * a large cache does not require one structured clone of the whole map. */
async function* cacheBatches(base: string): AsyncGenerator<CacheBatch, CacheBatch> {
  if (!exists(cacheDB(base))) return emptyBatch();
  let db: DB;
  try {
    ({ db } = openDB(base));
  } catch {
    return emptyBatch();
  }
  try {
    const s = stateOf(db);
    if (!s) return emptyBatch();
    const total = Number(db.get<{ n: number | bigint }>('SELECT coalesce(sum(length(entry)), 0) AS n FROM usage_cost_files')?.n ?? 0);
    if (s.version !== CACHE_VERSION || total > MAX_CACHE_BYTES) return { files: [], gen: s.gen };
    const it = db.prepare('SELECT path, entry FROM usage_cost_files').iterate() as IterableIterator<{
      path: string;
      entry: Uint8Array | string;
    }>;
    let files: CacheBatch['files'] = [];
    let bytes = 0;
    let rows = 0;
    for (const r of it) {
      try {
        const e = entryOf(JSON.parse(typeof r.entry === 'string' ? r.entry : Buffer.from(r.entry).toString('utf8')));
        if (e) files.push([r.path, e]);
      } catch {
        // left out
      }
      bytes += r.path.length + (typeof r.entry === 'string' ? Buffer.byteLength(r.entry) : r.entry.byteLength);
      if (++rows >= 512 || bytes >= CACHE_BATCH_BYTES) {
        yield { files, gen: s.gen };
        files = [];
        rows = bytes = 0;
      }
    }
    return { files, gen: s.gen };
  } catch {
    return emptyBatch();
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
  return writeCache(base, files, changed, removed, savedMs, false) as number | false;
}

function writeCache(
  base: string,
  files: Map<string, Entry>,
  changed: Iterable<string>,
  removed: Iterable<string>,
  savedMs: number,
  partial: boolean,
): number | false | 'replace' {
  const { db, writable } = openDB(base);
  try {
    if (!writable) return false;
    const gen = db.update(() => {
      const s = stateOf(db);
      const whole = !s || s.version !== CACHE_VERSION;
      if (whole && partial) return 'replace';
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
    if (gen !== 'replace') db.reclaim();
    return gen;
  } finally {
    db.close();
  }
}

export function cacheOperations(base: string) {
  let loading: { id: number; batches: ReturnType<typeof cacheBatches> } | undefined;
  const finishLoad = async (id: number) => {
    if (loading?.id !== id) return;
    const { batches } = loading;
    loading = undefined;
    await batches.return(emptyBatch());
  };
  return {
    state(signal: AbortSignal) {
      signal.throwIfAborted();
      return cacheState(base);
    },
    async load(signal: AbortSignal, id: number, first: boolean) {
      signal.throwIfAborted();
      if (first) {
        if (loading) await finishLoad(loading.id);
        loading = { id, batches: cacheBatches(base) };
      }
      if (loading?.id !== id) throw new Error('usage: the cache read has ended');
      const batch = await loading.batches.next();
      if (batch.done && loading?.id === id) loading = undefined;
      return batch;
    },
    async finishLoad(_signal: AbortSignal, id: number) {
      await finishLoad(id);
    },
    save(signal: AbortSignal, files: Map<string, Entry>, removed: string[], savedMs: number, partial: boolean, changed?: string[]) {
      signal.throwIfAborted();
      return writeCache(base, files, changed ?? files.keys(), removed, savedMs, partial);
    },
    sweep(signal: AbortSignal, cutoffMs: number) {
      signal.throwIfAborted();
      dropStale(base, cutoffMs);
    },
  };
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
