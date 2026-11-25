// The snapshots live in the machine's database (MACHINE_DB in the agent's
// data directory, named after the host: hostFile), table
// history_snapshots: a row per generation of a terminal (prev 0 for the
// current one, 1 for the previous one) with what describes it and its
// bytes, as the Go agent keeps them: a Go
// node and a TypeScript node of the same instance read and write the same
// rows. Every change is a transaction of its own, so readers (list, read)
// take no lock and see each generation whole; a written generation is on
// disk before the write returns (DB.durable).
//
// Writers (capture, clear, adopt, the agent's housekeeping) hold the
// snapshots' lease, history_lease, which two agents of the same instance
// share (a Go one and a TypeScript one too): its row names the writer (its
// process's random id and its own), its process and host and until when it
// holds it, taken in a transaction and renewed by each of the writer's
// changes, which fail once another writer took it. It ends when the writer
// closes the store, when its process is gone (same host: no process of its
// pid, or this process while the writer's process id is another's, an
// agent of a container started again with the same pid), or LEASE_TTL_MS
// after its last renewal. Memory follows the database: a change that fails
// leaves what describes the snapshots as it was.
import { randomBytes } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import { isAbsolute } from 'node:path';
import { HistoryLimits, validHistoryTerminal, type HistorySnapshot } from '#shared/proto/agentproto/index.ts';
import { DB, MACHINE_DB, NewerError, exists, hostFile, openShared } from '#shared/store/index.ts';
import type { Memory } from './memory.ts';

/** The snapshots' tables in the machine's database. */
export const FEATURE = 'history';
/** How long a writer holds the lease after its last change: longer than a
 * capture's or a clear's time, each of whose changes renews it. */
export const LEASE_TTL_MS = 60_000;
/** How often a writer that waits for the lease asks again. */
export const LEASE_RETRY_MS = 50;

/** The Go agent's migrations of the snapshots' tables, as they are. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE history_snapshots (
		terminal TEXT NOT NULL,
		prev INTEGER NOT NULL CHECK (prev IN (0, 1)),
		pid INTEGER NOT NULL,
		at INTEGER NOT NULL,
		lines INTEGER NOT NULL,
		cols INTEGER NOT NULL,
		grid_rows INTEGER NOT NULL,
		bytes INTEGER NOT NULL,
		hash TEXT NOT NULL,
		days INTEGER NOT NULL,
		restored INTEGER NOT NULL,
		data BLOB NOT NULL,
		PRIMARY KEY (terminal, prev)
	);
	CREATE TABLE history_lease (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		owner TEXT NOT NULL,
		host TEXT NOT NULL,
		pid INTEGER NOT NULL,
		expires INTEGER NOT NULL
	);`,
];

/** A generation's description (its row's columns). */
export interface Meta extends HistorySnapshot {
  terminal: string;
  /** The SHA-256 of the terminal's grid and screen text when the snapshot
   * was taken: a capture that reads the same and the same pid writes
   * nothing. */
  hash: string;
  /** The retention the snapshot was written under, which the agent applies
   * when it starts and whenever the snapshots are listed or read. */
  days: number;
  /** The terminal core restored the screen of the program before into this
   * program's terminal; it stays set for the later snapshots of the same
   * program. */
  restored: boolean;
}

/** Whether m can be a generation. */
const valid = (m: Meta): boolean => validHistoryTerminal(m.terminal) && m.bytes >= 0 && m.bytes <= HistoryLimits.maxBytes && m.at > 0;

/** A terminal's generations; either may be null. */
export class Stored {
  cur: Meta | null = null;
  prev: Meta | null = null;

  gen(prev: boolean): Meta | null {
    return prev ? this.prev : this.cur;
  }

  /** When the terminal was captured last, in ms. */
  newest(): number {
    return Math.max(0, this.cur?.at ?? 0, this.prev?.at ?? 0);
  }

  bytes(): number {
    return (this.cur?.bytes ?? 0) + (this.prev?.bytes ?? 0);
  }
}

/** Another writer holds the lease. */
export class BusyError extends Error {
  constructor() {
    super('history: another capture is running');
  }
}
/** The lease expired and another writer took it. */
export class LeaseLostError extends Error {
  constructor() {
    super("history: the snapshots' lease was taken over");
  }
}
/** The machine's database, or the snapshots' tables in it, are of a newer
 * version, which this agent reads and does not write. */
export class NewerTablesError extends Error {
  constructor() {
    super("history: the snapshots' database is of a newer version");
  }
}
/** No data directory. */
export class NoDataError extends Error {
  constructor() {
    super('history: no data directory');
  }
}

/** The machine's database below the data directory base: this host's. */
export const dbPath = (base: string): string => hostFile(base, MACHINE_DB);

/** Whether base has snapshots to look at: the machine's database (a read
 * creates nothing). */
export const hasSnapshots = (base: string): boolean => base !== '' && isAbsolute(base) && exists(dbPath(base));

/** Opens the machine's database below base with the snapshots' tables;
 * newer: they are of a newer version, to read only. The caller closes it. */
export function openDB(base: string): { db: DB; newer: boolean } {
  if (base === '' || !isAbsolute(base)) throw new NoDataError();
  const db = openShared(dbPath(base));
  try {
    db.migrate(FEATURE, MIGRATIONS);
  } catch (e) {
    if (e instanceof NewerError && e.version >= MIGRATIONS.length) return { db, newer: true };
    db.close();
    throw e;
  }
  return { db, newer: false };
}

/** The columns of a generation but its bytes, with the size of its bytes
 * last. */
export const COLUMNS = 'terminal, prev, pid, at, lines, cols, grid_rows, bytes, hash, days, restored, length(data) AS size';

type Int = number | bigint;

/** A row of COLUMNS (and data, when it was asked for). */
export interface MetaRow {
  terminal: string;
  prev: Int;
  pid: Int;
  at: Int;
  lines: Int;
  cols: Int;
  grid_rows: Int;
  bytes: Int;
  hash: string;
  days: Int;
  restored: Int;
  size: Int;
  data?: Uint8Array;
}

/** A row of COLUMNS: its generation, whether it is the previous one, and
 * whether its bytes have the size it gives. */
export function scanMeta(r: MetaRow): { m: Meta; prev: boolean; whole: boolean } {
  const m: Meta = {
    terminal: r.terminal,
    pid: Number(r.pid),
    at: Number(r.at),
    lines: Number(r.lines),
    bytes: Number(r.bytes),
    cols: Number(r.cols),
    rows: Number(r.grid_rows),
    hash: r.hash,
    days: Number(r.days),
    restored: Number(r.restored) !== 0,
  };
  return { m, prev: Number(r.prev) !== 0, whole: Number(r.size) === m.bytes && valid(m) };
}

/** This process's random id, which its writers' owner names begin with
 * (before a dot): a lease of this pid whose owner does not is a process's
 * before this one with the same pid. */
export const PROCESS_ID = randomBytes(8).toString('hex');

/** Tells this computer's writers from those of another sharing the data
 * directory, whose processes cannot be looked at. */
export const HOSTNAME = osHostname();

/** Whether the process of writer owner, pid of this host, is there: this
 * process when owner is one of its writers, not when owner is of an
 * earlier process of the same pid. */
export function alive(pid: number, owner: string): boolean {
  if (pid === process.pid) return owner.startsWith(PROCESS_ID + '.');
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

/** Whether generation m was taken before now minus its retention: days, or
 * with days 0 the one it was written under. */
export function expired(m: Meta, now: number, days: number): boolean {
  const keep = days !== 0 ? days : clamp(m.days || HistoryLimits.maxDays, HistoryLimits.minDays, HistoryLimits.maxDays);
  return now - m.at > keep * 24 * 3600 * 1000;
}

/** A terminal's program and screen, as the memory of evictions and
 * refusals keys them. */
export const screenKey = (pid: number, hash: string): string => `${pid}:${hash}`;

/** A writer's view of the snapshots: the database, the lease it holds and
 * what describes each terminal's generations. */
export class Store {
  private db: DB | null;
  readonly owner: string;
  readonly terms = new Map<string, Stored>();
  private readonly memory: Memory;

  private constructor(db: DB, memory: Memory) {
    this.db = db;
    this.memory = memory;
    this.owner = PROCESS_ID + '.' + randomBytes(12).toString('hex');
  }

  /** Opens the snapshots below base for a writer: it takes the lease (at
   * once or BusyError without wait, else asking again until signal ends)
   * and reads what describes every generation. Rows that cannot be a
   * generation go; removed counts the terminals that lost one so. */
  static async open(
    base: string,
    memory: Memory,
    o: { wait: boolean; signal?: AbortSignal; retryMs?: number },
  ): Promise<{ store: Store; removed: number }> {
    const { db, newer } = openDB(base);
    if (newer) {
      db.close();
      throw new NewerTablesError();
    }
    const s = new Store(db, memory);
    try {
      await s.lock(o.wait, o.signal, o.retryMs ?? LEASE_RETRY_MS);
    } catch (e) {
      db.close();
      throw e;
    }
    let removed: number;
    try {
      removed = s.load();
    } catch (e) {
      s.close();
      throw e;
    }
    return { store: s, removed };
  }

  private get conn(): DB {
    if (!this.db) throw new Error('history: the store is closed');
    return this.db;
  }

  /** Releases the lease and the database, giving the pages of the
   * generations that went back to the file system when they are many. */
  close(): void {
    const db = this.db;
    if (!db) return;
    this.db = null;
    try {
      db.run('DELETE FROM history_lease WHERE id = 1 AND owner = ?', this.owner);
      db.reclaim();
    } catch {
      // the lease ends with its time
    } finally {
      db.close();
    }
  }

  private async lock(wait: boolean, signal: AbortSignal | undefined, retryMs: number): Promise<void> {
    for (;;) {
      if (this.tryLease()) return;
      if (!wait) throw new BusyError();
      if (signal?.aborted) throw signal.reason ?? new BusyError();
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, retryMs);
        function done() {
          clearTimeout(t);
          signal?.removeEventListener('abort', done);
          resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
      });
      if (signal?.aborted) throw signal.reason ?? new BusyError();
    }
  }

  /** Takes the lease unless another writer holds it: one whose time is not
   * over and whose process is there (on this host) or may be (on
   * another). */
  tryLease(): boolean {
    return this.conn.update((db) => {
      const now = Date.now();
      const row = db.get<{ owner: string; host: string; pid: Int; expires: Int }>(
        'SELECT owner, host, pid, expires FROM history_lease WHERE id = 1',
      );
      if (row && row.owner !== this.owner && Number(row.expires) > now && (row.host !== HOSTNAME || alive(Number(row.pid), row.owner)))
        return false;
      db.run(
        `INSERT INTO history_lease (id, owner, host, pid, expires) VALUES (1, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, host = excluded.host, pid = excluded.pid, expires = excluded.expires`,
        this.owner,
        HOSTNAME,
        process.pid,
        now + LEASE_TTL_MS,
      );
      return true;
    });
  }

  /** Runs fn in a transaction that renews the writer's lease, its commit
   * on disk when durable. */
  private change(durable: boolean, fn: (db: DB) => void): void {
    const db = this.conn;
    const body = (tx: DB) => {
      const r = tx.run('UPDATE history_lease SET expires = ? WHERE id = 1 AND owner = ?', Date.now() + LEASE_TTL_MS, this.owner);
      if (Number(r.changes) !== 1) throw new LeaseLostError();
      fn(tx);
    };
    if (durable) db.durable(body);
    else db.update(body);
  }

  /** Reads what describes every generation into terms; rows that are not
   * whole go. */
  private load(): number {
    const rows = this.conn.all<MetaRow>(`SELECT ${COLUMNS} FROM history_snapshots ORDER BY terminal, prev`);
    const broken: Array<{ addr: string; prev: boolean }> = [];
    for (const r of rows) {
      const { m, prev, whole } = scanMeta(r);
      if (!whole) {
        broken.push({ addr: m.terminal, prev });
        continue;
      }
      let st = this.terms.get(m.terminal);
      if (!st) this.terms.set(m.terminal, (st = new Stored()));
      if (prev) st.prev = m;
      else st.cur = m;
    }
    if (broken.length === 0) return 0;
    const lost = new Set<string>();
    this.change(false, (tx) => {
      for (const k of broken) {
        tx.run('DELETE FROM history_snapshots WHERE terminal = ? AND prev = ?', k.addr, k.prev ? 1 : 0);
        lost.add(k.addr);
      }
    });
    return lost.size;
  }

  /** Removes rows of addr: one generation, or both (prev undefined). */
  private removeRows(addr: string, prev?: boolean): void {
    this.change(false, (tx) => {
      if (prev === undefined) tx.run('DELETE FROM history_snapshots WHERE terminal = ?', addr);
      else tx.run('DELETE FROM history_snapshots WHERE terminal = ? AND prev = ?', addr, prev ? 1 : 0);
    });
  }

  /** Removes one generation; memory changes once the removal committed. */
  removeGen(addr: string, prev: boolean): void {
    const st = this.terms.get(addr);
    if (!st) return;
    this.removeRows(addr, prev);
    if (prev) st.prev = null;
    else st.cur = null;
    if (!st.cur && !st.prev) this.terms.delete(addr);
  }

  /** Removes a terminal's snapshots; false when it had none or the removal
   * failed (they stay, also in memory). */
  remove(addr: string): boolean {
    try {
      return this.removeTerminal(addr);
    } catch {
      return false;
    }
  }

  /** Removes a terminal's snapshots: false when it had none; memory
   * changes once the removal committed. */
  removeTerminal(addr: string): boolean {
    if (!this.terms.has(addr)) return false;
    this.removeRows(addr);
    this.terms.delete(addr);
    return true;
  }

  /** Removes the generations that expired (expired with days); the number
   * of terminals that lost one (a removal that failed loses nothing). */
  pruneAge(now: number, days: number): number {
    let removed = 0;
    for (const [addr, st] of [...this.terms]) {
      let lost = false;
      for (const prev of [false, true]) {
        const m = st.gen(prev);
        if (!m || !expired(m, now, days)) continue;
        try {
          this.removeGen(addr, prev);
          lost = true;
        } catch {
          // stays
        }
      }
      if (lost) removed++;
    }
    return removed;
  }

  /** The bytes of every generation. */
  total(): number {
    let n = 0;
    for (const st of this.terms.values()) n += st.bytes();
    return n;
  }

  /** The terminal captured longest ago among those not in keep, "" when
   * there is none. */
  oldest(keep: ReadonlySet<string>): string {
    let best = '';
    let at = 0;
    for (const [addr, st] of this.terms) {
      if (keep.has(addr)) continue;
      const n = st.newest();
      if (best === '' || n < at || (n === at && addr < best)) {
        best = addr;
        at = n;
      }
    }
    return best;
  }

  /** Evicts the terminals captured longest ago until there are at most
   * maxTerminals of them and maxTotal bytes, not those in keep; how many
   * went. A removal that fails ends it: what stays is counted. */
  fit(maxTerminals: number, maxTotal: number, keep: ReadonlySet<string> = new Set()): number {
    let evicted = 0;
    while (this.terms.size > maxTerminals || this.total() > maxTotal) {
      const victim = this.oldest(keep);
      if (victim === '' || !this.evict(victim)) break;
      evicted++;
    }
    return evicted;
  }

  /** Removes a terminal's snapshots for the limits, remembering the screen
   * its current one was of; false when the removal failed. */
  private evict(addr: string): boolean {
    const cur = this.terms.get(addr)?.cur ?? null;
    if (!this.remove(addr)) return false;
    if (cur) this.memory.evictions.set(addr, screenKey(cur.pid, cur.hash));
    return true;
  }

  /** Whether, before a terminal's paint is read, a new current generation
   * of addr could fit at all: among maxTerminals once every terminal that
   * may go is gone (all but addr and those in keep), with bytes left
   * besides those that stay. Its size is known only once read, when
   * makeRoom decides. */
  room(addr: string, maxTerminals: number, maxTotal: number, keep: ReadonlySet<string>): boolean {
    let count = 1;
    let stay = 0;
    for (const [a, st] of this.terms)
      if (a !== addr && keep.has(a)) {
        count++;
        stay += st.bytes();
      }
    return count <= maxTerminals && stay < maxTotal;
  }

  /** Evicts for a new current generation of n bytes of addr: the terminals
   * captured longest ago go first, never addr nor those in keep; addr's
   * previous generation goes only when addr alone would exceed maxTotal.
   * ok is false when the generation does not fit, or a removal failed. */
  makeRoom(addr: string, n: number, maxTerminals: number, maxTotal: number, keep: ReadonlySet<string>): { evicted: number; ok: boolean } {
    let evicted = 0;
    if (n > maxTotal) return { evicted, ok: false };
    const protect = new Set([addr, ...keep]);
    for (;;) {
      const mine = this.terms.get(addr) ?? null;
      const count = this.terms.size + (mine ? 0 : 1);
      let total = this.total() + n;
      if (mine?.cur) total -= mine.cur.bytes;
      if (count <= maxTerminals && total <= maxTotal) return { evicted, ok: true };
      const victim = this.oldest(protect);
      if (victim !== '') {
        if (!this.evict(victim)) return { evicted, ok: false };
        evicted++;
        continue;
      }
      if (total > maxTotal && mine?.prev && n + mine.prev.bytes > maxTotal) {
        try {
          this.removeGen(addr, true);
        } catch {
          return { evicted, ok: false };
        }
        continue;
      }
      return { evicted, ok: false };
    }
  }

  /** Makes addr's current generation its previous one, replacing the
   * previous one. */
  rotate(addr: string): void {
    const st = this.terms.get(addr);
    if (!st?.cur) return;
    this.change(true, (tx) => {
      tx.run('DELETE FROM history_snapshots WHERE terminal = ? AND prev = 1', addr);
      tx.run('UPDATE history_snapshots SET prev = 1 WHERE terminal = ? AND prev = 0', addr);
    });
    st.prev = st.cur;
    st.cur = null;
  }

  /** Makes the newest generation of from (its current, else its previous)
   * the previous generation of to, unless to has a previous one captured
   * later, and removes from's snapshots either way; false when nothing
   * moved. One transaction: readers see the generation at from or at to.
   * One that fails changes nothing. */
  adopt(from: string, to: string): boolean {
    const src = this.terms.get(from);
    if (!src) return false;
    const prev = src.cur === null;
    const m = src.gen(prev)!;
    const later = this.terms.get(to)?.prev;
    if (later && later.at > m.at) {
      this.removeTerminal(from);
      return false;
    }
    this.change(true, (tx) => {
      tx.run('DELETE FROM history_snapshots WHERE terminal = ? AND prev = 1', to);
      tx.run('UPDATE history_snapshots SET terminal = ?, prev = 1 WHERE terminal = ? AND prev = ?', to, from, prev ? 1 : 0);
      tx.run('DELETE FROM history_snapshots WHERE terminal = ?', from);
    });
    let dst = this.terms.get(to);
    if (!dst) this.terms.set(to, (dst = new Stored()));
    dst.prev = { ...m, terminal: to };
    this.terms.delete(from);
    return true;
  }

  /** Writes addr's current generation. */
  write(meta: Meta, data: Uint8Array): void {
    const m: Meta = { ...meta, bytes: data.length };
    let st = this.terms.get(m.terminal);
    if (!st) this.terms.set(m.terminal, (st = new Stored()));
    try {
      this.change(true, (tx) => {
        tx.run(
          `INSERT INTO history_snapshots (terminal, prev, pid, at, lines, cols, grid_rows, bytes, hash, days, restored, data)
			VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (terminal, prev) DO UPDATE SET pid = excluded.pid, at = excluded.at, lines = excluded.lines,
				cols = excluded.cols, grid_rows = excluded.grid_rows, bytes = excluded.bytes, hash = excluded.hash,
				days = excluded.days, restored = excluded.restored, data = excluded.data`,
          m.terminal,
          m.pid,
          m.at,
          m.lines,
          m.cols,
          m.rows,
          m.bytes,
          m.hash,
          m.days,
          m.restored ? 1 : 0,
          data,
        );
      });
    } catch (e) {
      // Nothing changed: the generation before stays.
      if (!st.cur && !st.prev) this.terms.delete(m.terminal);
      throw e;
    }
    st.cur = m;
  }

  /** Removes every terminal's snapshots; how many terminals had some. One
   * that fails removes nothing. */
  clearAll(): number {
    const n = this.terms.size;
    this.change(false, (tx) => {
      tx.run('DELETE FROM history_snapshots');
    });
    this.terms.clear();
    return n;
  }
}
