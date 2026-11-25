// Opens the SQLite databases that hold the program's state, one database
// per owner (the chat host's, a machine's agent's, the hub's): no two
// processes of different roles write one database. It uses node:sqlite
// (DatabaseSync), which both Bun and the desktop app's Node have; every
// call runs synchronously, so a statement that waits for another
// process's lock (the busy timeout) blocks the thread meanwhile.
//
// A database is a file of this user only: its directory is created 0700
// (an existing one must be a directory of this user, not a link, and is
// made 0700), the file is created 0600 (an existing one must be a regular
// file of this user, not a link, and is made 0600), and SQLite's journal
// files, which it creates with the database's mode, must not be links
// either. On Windows the user's profile's access control list keeps them
// the user's; there the mode bits and owners are not looked at.
//
// A database uses write-ahead logging; its connection waits for another's
// lock (busy timeout), enforces foreign keys, syncs as write-ahead logging
// allows (synchronous NORMAL: a power loss may lose the last
// transactions, never the database) and begins its transactions IMMEDIATE
// (a writer takes the lock when it begins, so two writers never deadlock
// upgrading); one it creates vacuums incrementally (DB.reclaim). A
// database's schema is versioned by PRAGMA user_version:
// Options.migrations, applied in order in one transaction, each version
// once. A database of a version above the code's (written by a newer
// program) is opened read-only, with db.newer set. A database that several
// features share (openShared) versions each feature's tables apart
// instead (DB.migrate).
//
// Where Go's database/sql keeps a pool of connections, a DB here has one
// connection: node:sqlite's calls are synchronous, so no two statements of
// a process ever run on it at once.
import * as fs from 'node:fs';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementResultingChanges, type StatementSync } from 'node:sqlite';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { markUsed } from './host.ts';
import { MODE_BITS, NO_FOLLOW, owned } from './owner.ts';
import { migrateFeature, releaseHandle, type Pool } from './shared.ts';

/** How a database is opened. */
export interface Options {
  /** The schema's versions as SQL, in order: migrations[i] takes a
   * database of user_version i to i+1. A released migration is never
   * changed; a change of the schema is a new one at the end. */
  migrations?: readonly string[];
  /** How long a statement waits for another connection's lock before it
   * fails, in milliseconds (0: DEFAULT_BUSY_TIMEOUT). */
  busyTimeout?: number;
}

/** Options.busyTimeout's default, in milliseconds. */
export const DEFAULT_BUSY_TIMEOUT = 5000;

/** A database of a schema version above the code's (Go's ErrNewer): open
 * and openShared return such a database read-only with this in its
 * newer; DB.migrate throws it for a feature whose tables are newer, or of
 * a read-only database. version is the database's (or the feature's). */
export class NewerError extends Error {
  readonly version: number;

  constructor(detail: string, version: number) {
    super(`store: the database is of a newer version (${detail})`);
    this.version = version;
    this.name = 'NewerError';
  }
}

/** A database whose directory or file is not this user's own: a link,
 * another user's, or not a directory or a regular file (Go's ErrUnsafe). */
export class UnsafeError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`store: not a private file of this user: ${path}`);
    this.path = path;
    this.name = 'UnsafeError';
  }
}

/** DB.migrate on a database that was not opened with openShared (Go's
 * ErrNotShared). */
export class NotSharedError extends Error {
  constructor() {
    super('store: not a shared database');
    this.name = 'NotSharedError';
  }
}

/** A row as node:sqlite returns it. */
export type Row = Record<string, SQLOutputValue>;

/** A connection and what the handles of it share. */
export interface Conn {
  sqlite: DatabaseSync;
  readOnly: boolean;
  version: number;
  /** Transactions open on the connection: the outermost is BEGIN
   * IMMEDIATE, the ones inside it savepoints. */
  depth: number;
  statements: Map<string, StatementSync>;
}

/** Prepared statements kept per connection at most. */
const MAX_STATEMENTS = 128;

/** An open database: open's own connection, or a handle of a shared
 * database's (openShared). */
export class DB {
  #closed = false;

  /** @internal Use open or openShared. */
  readonly conn: Conn;
  /** The shared database's pool this is a handle of (openShared), released
   * on close. */
  readonly pool?: Pool;
  /** Set when the database is of a version above the code's: it was
   * opened read-only, and every statement that would write fails. */
  readonly newer?: NewerError;

  constructor(conn: Conn, pool?: Pool, newer?: NewerError) {
    this.conn = conn;
    this.pool = pool;
    this.newer = newer;
  }

  /** Whether the database was opened read-only (newer). */
  get readOnly(): boolean {
    return this.conn.readOnly;
  }

  /** The database's schema version (its user_version) when it was opened. */
  get version(): number {
    return this.conn.version;
  }

  /** Whether this handle was closed. */
  get closed(): boolean {
    return this.#closed;
  }

  /** The connection; it fails once this handle is closed. */
  get sqlite(): DatabaseSync {
    if (this.#closed) throw new Error('store: the database is closed');
    return this.conn.sqlite;
  }

  /** Runs sql, which may hold several statements, without parameters. */
  exec(sql: string): void {
    this.sqlite.exec(sql);
  }

  /** A new prepared statement of sql, the caller's (to iterate, or to set
   * its options). */
  prepare(sql: string): StatementSync {
    return this.sqlite.prepare(sql);
  }

  /** The prepared statement of sql that run, get and all share, kept for
   * the next call with the same text. */
  private cached(sql: string): StatementSync {
    const db = this.sqlite;
    let st = this.conn.statements.get(sql);
    if (!st) {
      st = db.prepare(sql);
      if (this.conn.statements.size >= MAX_STATEMENTS) this.conn.statements.clear();
      this.conn.statements.set(sql, st);
    }
    return st;
  }

  /** Runs one statement with params. */
  run(sql: string, ...params: SQLInputValue[]): StatementResultingChanges {
    return this.cached(sql).run(...params);
  }

  /** The first row of one statement with params; undefined for none. */
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.cached(sql).get(...params) as T | undefined;
  }

  /** Every row of one statement with params. */
  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.cached(sql).all(...params) as T[];
  }

  /** Runs fn in a transaction, which takes the database's write lock when
   * it begins (IMMEDIATE), and commits it unless fn throws; fn's result is
   * update's. fn runs synchronously: an async one would leave the
   * transaction before its work is done, and is refused. Inside another
   * transaction fn runs in a savepoint of it: what it did is rolled back
   * when it throws, and committed with the outer one. */
  update<T>(fn: (db: DB) => T): T {
    const c = this.conn;
    const db = this.sqlite;
    const sp = `store_${c.depth}`;
    db.exec(c.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    const outer = c.depth === 0;
    c.depth++;
    try {
      const r = fn(this);
      if (r && typeof (r as { then?: unknown }).then === 'function') {
        throw new TypeError('store: a transaction’s function must be synchronous');
      }
      db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
      return r;
    } catch (e) {
      try {
        db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      } catch {
        // SQLite rolled the transaction back itself
      }
      throw e;
    } finally {
      c.depth--;
    }
  }

  /** update for what must survive the computer's loss of power once
   * durable returned: the commit is synced to disk (synchronous FULL; the
   * other transactions, NORMAL, may lose their last ones then). SQLite
   * changes how a connection syncs between transactions only: durable
   * inside another transaction fails. */
  durable<T>(fn: (db: DB) => T): T {
    const db = this.sqlite;
    if (this.conn.depth > 0) throw new Error('store: a durable transaction inside another transaction');
    db.exec('PRAGMA synchronous = FULL');
    try {
      return this.update(fn);
    } finally {
      try {
        db.exec('PRAGMA synchronous = NORMAL');
      } catch {
        // closed by fn
      }
    }
  }

  /** Brings feature's tables in a shared database to the version of steps
   * (SQL, in order: steps[i] takes the feature from version i to i+1; a
   * released step is never changed, a change is a new one at the end), in
   * one transaction, each step once, and returns the feature's version.
   * NewerError, with the feature's version, when the feature's tables are
   * of a version above the code's or the database is read-only: the
   * feature then reads its tables (when its version is the code's or
   * above) and does not write. NotSharedError for a database open opened. */
  migrate(feature: string, steps: readonly string[]): number {
    if (!this.pool) throw new NotSharedError();
    return migrateFeature(this, feature, steps);
  }

  /** Gives the database's free pages back to the file system when they are
   * many (at least RECLAIM_MIN bytes and a quarter of the file), so that a
   * database whose rows went (expired, cleared, evicted) does not keep its
   * largest size; fewer are left for the next rows. A database created
   * before incremental vacuuming keeps them. */
  reclaim(): void {
    if (this.readOnly) return;
    const n = (pragma: string) => Number(Object.values(this.get(`PRAGMA ${pragma}`) ?? {})[0] ?? 0);
    const free = n('freelist_count');
    const pages = n('page_count');
    const size = n('page_size');
    if (free * size < RECLAIM_MIN || free * 4 < pages) return;
    this.exec('PRAGMA incremental_vacuum');
  }

  /** Closes the database; a handle of a shared database (openShared) is
   * released, and the connection closes with its last handle. A second
   * close does nothing. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.pool) releaseHandle(this.pool);
    else closeConn(this.conn);
  }
}

/** The least free space reclaim gives back. */
const RECLAIM_MIN = 8 << 20;

/** Opens the database at path, an absolute path, creating it and its
 * directory when missing, and brings its schema to the version of
 * o.migrations. A database of a newer version is returned read-only with
 * its newer set. */
export function open(path: string, o: Options = {}): DB {
  if (!isAbsolute(path)) throw new Error(`store: ${JSON.stringify(path)} is not an absolute path`);
  path = resolve(path);
  privateDir(dirname(path));
  privateFile(path);
  markUsed(path);
  for (const suffix of ['-wal', '-shm', '-journal']) notLink(path + suffix);
  const timeout = o.busyTimeout && o.busyTimeout > 0 ? o.busyTimeout : DEFAULT_BUSY_TIMEOUT;
  const migrations = o.migrations ?? [];
  const db = connect(path, timeout, false);
  let version: number;
  try {
    version = migrate(db, migrations);
  } catch (e) {
    db.close();
    if (!(e instanceof NewerError)) throw e;
    const ro = connect(path, timeout, true);
    const conn: Conn = { sqlite: ro, readOnly: true, version: e.version, depth: 0, statements: new Map() };
    return new DB(conn, undefined, new NewerError(`${e.version}, the code knows ${migrations.length}`, e.version));
  }
  return new DB({ sqlite: db, readOnly: false, version, depth: 0, statements: new Map() });
}

/** Closes c's connection. */
export function closeConn(c: Conn): void {
  c.statements.clear();
  c.sqlite.close();
}

/** Opens a connection to the database at path with the settings above
 * and, for writing, puts the database in write-ahead logging (which lasts
 * in the file). Switching the journal mode can fail busy without waiting
 * while another program opens the same database: connect tries again
 * until timeout. A read-only connection is query_only, as Go's: it takes
 * SQLite's locks as a writer's does, which a connection opened read-only
 * of a database in write-ahead logging could not. */
function connect(path: string, timeout: number, readOnly: boolean): DatabaseSync {
  const deadline = Date.now() + timeout;
  for (;;) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { timeout, enableForeignKeyConstraints: true });
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA synchronous = NORMAL');
      // A database created here gives the pages its rows freed back when
      // asked (DB.reclaim); one created before keeps them for later rows.
      db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      if (readOnly) db.exec('PRAGMA query_only = 1');
      else db.exec('PRAGMA journal_mode = WAL');
      return db;
    } catch (e) {
      try {
        db?.close();
      } catch {
        // not open
      }
      if (!busy(e) || Date.now() > deadline) throw new Error(`store: ${basename(path)}: ${(e as Error).message}`, { cause: e });
      sleep(20);
    }
  }
}

/** Whether e is SQLite's SQLITE_BUSY or SQLITE_LOCKED, with any of their
 * extended codes. */
export function busy(e: unknown): boolean {
  const code = (e as { errcode?: unknown })?.errcode;
  return typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

/** Blocks the thread for ms (connect's retries are synchronous, as every
 * SQLite call here is). */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The database's user_version. */
export function userVersion(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

/** Brings the database to the version of migrations in one transaction
 * and returns its version; NewerError, with the database's version, for
 * one above it. */
function migrate(db: DatabaseSync, migrations: readonly string[]): number {
  const n = migrations.length;
  let version = userVersion(db);
  if (version > n) throw new NewerError(`${version}, the code knows ${n}`, version);
  if (version === n) return version;
  db.exec('BEGIN IMMEDIATE'); // one migrating writer at a time
  try {
    // Another connection may have migrated since the first look.
    version = userVersion(db);
    if (version > n) throw new NewerError(`${version}, the code knows ${n}`, version);
    if (version === n) {
      db.exec('ROLLBACK');
      return version;
    }
    for (let i = version; i < n; i++) {
      try {
        db.exec(migrations[i]);
      } catch (e) {
        throw new Error(`store: migration ${i + 1}: ${(e as Error).message}`, { cause: e });
      }
    }
    db.exec(`PRAGMA user_version = ${n}`);
    db.exec('COMMIT');
    return n;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // rolled back already
    }
    throw e;
  }
}

/** Makes dir, 0700 when missing; an existing one must be a directory of
 * this user and not a link, and is made 0700. */
function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || !owned(st)) throw new UnsafeError(dir);
  if (MODE_BITS && (st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/** Creates the database's file 0600 when missing; an existing one must be
 * a regular file of this user and not a link, and is made 0600. */
function privateFile(path: string): void {
  try {
    const { O_RDWR, O_CREAT, O_EXCL } = fs.constants;
    fs.closeSync(fs.openSync(path, O_RDWR | O_CREAT | O_EXCL | NO_FOLLOW, 0o600));
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const st = fs.lstatSync(path);
  if (!st.isFile() || !owned(st)) throw new UnsafeError(path);
  if (MODE_BITS && (st.mode & 0o777) !== 0o600) fs.chmodSync(path, 0o600);
}

/** Fails for a path that is there and is not a regular file of this user
 * (a journal file SQLite would open). */
function notLink(path: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (!st.isFile() || !owned(st)) throw new UnsafeError(path);
}

/** Whether there is a file at path (a database that a read would not
 * create). */
export function exists(path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
