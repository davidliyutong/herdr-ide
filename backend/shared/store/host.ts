// Databases kept per host. A data directory may be on a home that several
// hosts share (NFS): SQLite's write-ahead logging needs every connection
// of a database on one host (its -shm file is shared memory), so a
// database a process of a machine owns (the agent's machine database, the
// chat host's) is named after the host it runs on: hostFile. The databases
// other hosts left go with pruneHostFiles.
import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import * as hostid from '#shared/host/hostid.ts';
import { owned, sameFile } from './owner.ts';
import { pools } from './shared.ts';

/** The database name of this host in dir: name with this host's key
 * before its extension (machine.db → <dir>/machine-<host>.db; a name
 * without an extension gets -<host> at its end). The key is the host's
 * whole name and, when the system has one, a hash of its machine id
 * (hostid.key): two hosts of one name (cloned machines, or node01 of two
 * clusters that share a home) do not share a database. */
export function hostFile(dir: string, name: string): string {
  return join(dir, hostFileName(name, thisHost()));
}

/** This host's key as database names have it (hostid.key). */
export const thisHost = (): string => hostid.key();

/** The key of host name h with machine id id ("" for none). */
export const hostKey = (h: string, id: hostid.MachineID): string => hostid.keyOf(h, id);

/** The extension of name as Go's filepath.Ext has it: from its last dot
 * (".db" of "machine.db", "" of "chat"). */
function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i) : '';
}

/** name with host before its extension. */
export function hostFileName(name: string, host: string): string {
  const e = ext(name);
  return name.slice(0, name.length - e.length) + '-' + host + e;
}

/** Whether key may be a host's key in a database name. */
export const validHostKey = (key: string): boolean => hostid.validKey(key);

/** How long another host's database stays unopened before pruneHostFiles
 * removes it, in milliseconds (30 days). */
export const HOST_FILE_RETENTION = 30 * 24 * 3600 * 1000;

/** Bounds the entries of a data directory pruneHostFiles looks at. */
const MAX_DIR_ENTRIES = 4096;

/** The files SQLite keeps beside a database. */
export const JOURNALS: readonly string[] = ['-wal', '-shm', '-journal'];

/** pruneHostFiles' error when a removal failed: removed has the databases
 * it removed before. */
export class PruneError extends Error {
  readonly removed: string[];

  constructor(removed: string[], cause: unknown) {
    super(`store: pruning: ${(cause as Error)?.message ?? cause}`, { cause });
    this.removed = removed;
    this.name = 'PruneError';
  }
}

/** Removes from dir the databases of name (hostFile) of other hosts that
 * no process opened for retention (ms) and no process holds, with their
 * journal files; this host's stays. It returns the names of the databases
 * it removed.
 *
 * A database is opened when its file's modification time is that of its
 * last use: open sets it, at most once an hour, and a write sets it or its
 * journal files'. It is held while any process (also on another host, as
 * far as the file system's locks reach) has it open: SQLite holds a
 * shared lock on the database file then (write-ahead logging keeps it
 * while the connection is open, between transactions too). A removal
 * takes the exclusive lock SQLite's writers take, without waiting, and
 * removes the files while it holds it, so that no SQLite connection reads
 * the database meanwhile; when the lock cannot be taken (held, or the file
 * system has no locks) the database stays (removeUnheld). A database whose
 * file or journal files are not this user's regular files stays too, and
 * so does one this process has open. Without such locks (Windows) nothing
 * is removed. */
export function pruneHostFiles(dir: string, name: string, retention = HOST_FILE_RETENTION, now: Date = new Date()): string[] {
  let names: string[];
  try {
    names = readNames(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const e = ext(name);
  const stem = name.slice(0, name.length - e.length) + '-';
  const mine = hostFileName(name, thisHost());
  const otherInstances = coreInstances(names, name);
  const removed: string[] = [];
  for (const n of names) {
    if (n === mine || !n.startsWith(stem) || !n.endsWith(e) || n.length < stem.length + e.length) continue;
    const host = n.slice(stem.length, n.length - e.length);
    if (!validHostKey(host) || hasInstancePrefix(host, otherInstances)) continue;
    const p = join(dir, n);
    if (!stale(p, retention, now) || openHere(p)) continue;
    let ok: boolean;
    try {
      ok = removeUnheld(p, (created) => stale(p, retention, now, created));
    } catch (err) {
      throw new PruneError(removed, err);
    }
    if (ok) removed.push(n);
  }
  return removed;
}

/** The names of dir's entries, at most MAX_DIR_ENTRIES. */
function readNames(dir: string): string[] {
  const d = fs.opendirSync(dir);
  const names: string[] = [];
  try {
    while (names.length < MAX_DIR_ENTRIES) {
      const ent = d.readSync();
      if (!ent) break;
      names.push(ent.name);
    }
  } finally {
    d.closeSync();
  }
  return names;
}

/** The instance suffixes (e.g. "dev", "desktop") of dir's configuration
 * files, so that pruning core.db never removes core-<instance>*.db. */
export function coreInstances(names: readonly string[], target: string): string[] {
  if (target !== 'core.db') return [];
  const seen = new Set<string>();
  for (const n of names) {
    for (const prefix of ['settings-', 'vault-', 'machines-', 'keybindings-']) {
      if (!n.startsWith(prefix) || !n.endsWith('.json')) continue;
      const inst = n.slice(prefix.length, n.length - '.json'.length);
      if (inst !== '') seen.add(inst);
    }
  }
  return [...seen];
}

function hasInstancePrefix(host: string, instances: readonly string[]): boolean {
  return instances.some((inst) => host === inst || host.startsWith(inst + '-'));
}

/** Whether the database at p and its journal files are this user's
 * regular files, none of them modified within retention before now. The
 * journal files of skip (removeUnheld's own) are not looked at. */
function stale(p: string, retention: number, now: Date, skip: ReadonlySet<string> = new Set()): boolean {
  for (const s of ['', ...JOURNALS]) {
    if (skip.has(s)) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p + s);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && s !== '') continue;
      return false;
    }
    if (!st.isFile() || !owned(st) || now.getTime() - st.mtimeMs < retention) return false;
  }
  return true;
}

/** Whether this process has the shared database at p open. */
function openHere(p: string): boolean {
  let st: fs.BigIntStats | undefined;
  try {
    st = fs.lstatSync(p, { bigint: true });
  } catch {
    st = undefined;
  }
  for (const pl of pools.values()) if (pl.path === p || (st && sameFile(st, pl.file))) return true;
  return false;
}

/** Removes the database at p, its journal files first (a journal file
 * left without its database would be taken for the journal of the next
 * one of the name). */
function removeFiles(p: string): void {
  for (const s of [...JOURNALS, '']) {
    try {
      fs.unlinkSync(p + s);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

/** Removes the database at p with its journal files when it takes the lock
 * SQLite's writers take on it, without waiting, and still reports it
 * should go once it holds it; false when the lock is held (or cannot be
 * taken) or still says no. still is told the journal files (their
 * suffixes) that were not there before the lock was taken: SQLite's
 * connection that holds it creates the write-ahead log, just modified.
 *
 * Go takes that lock itself: a POSIX write lock (fcntl F_SETLK) on SQLite's
 * lock bytes (512 bytes from 1 GiB), which conflicts with the shared lock
 * every connection holds. Node cannot call fcntl, so SQLite takes it here:
 * a connection of its own that does not wait (timeout 0), in exclusive
 * locking mode, begins an exclusive transaction. Exclusive locking mode
 * matters: for a database in write-ahead logging BEGIN EXCLUSIVE alone
 * takes the log's write lock only, which an idle connection elsewhere does
 * not hold; in exclusive locking mode the first read takes the exclusive
 * lock of the database file itself (instead of using the -shm file), which
 * fails while any connection anywhere holds its shared lock, also an idle
 * one, and in this process too (SQLite counts its own connections' locks).
 * While the connection is open the lock is held; the files are removed
 * then. A file SQLite does not take for a database (SQLITE_NOTADB) stays.
 *
 * The file is opened first, without following a link, to check that it is
 * a regular file, and stays open until SQLite's connection closed (so its
 * inode is not reused meanwhile, and closing it does not drop SQLite's
 * POSIX locks); after the lock the path must still name that file.
 * Nothing is removed on Windows, whose SQLite locks are not looked at
 * here: another host's database stays. */
export function removeUnheld(p: string, still: (created: ReadonlySet<string>) => boolean): boolean {
  if (process.platform === 'win32') return false;
  const { O_RDWR, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  let fd: number;
  try {
    fd = fs.openSync(p, O_RDWR | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0));
  } catch {
    return false;
  }
  let db: DatabaseSync | undefined;
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    const same = () => {
      try {
        return sameFile(st, fs.lstatSync(p, { bigint: true }));
      } catch {
        return false;
      }
    };
    if (!st.isFile() || !same()) return false;
    const there = (s: string) => {
      try {
        fs.lstatSync(p + s);
        return true;
      } catch {
        return false;
      }
    };
    const before = new Set(JOURNALS.filter(there));
    try {
      db = new DatabaseSync(p, { timeout: 0 });
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');
    } catch {
      return false; // held (SQLITE_BUSY), or not a database
    }
    if (!same() || !still(new Set(JOURNALS.filter((s) => !before.has(s) && there(s))))) return false;
    removeFiles(p);
    return true;
  } finally {
    try {
      db?.close();
    } catch {
      // closed
    }
    fs.closeSync(fd);
  }
}

/** How often a database is marked used (its modification time) at most:
 * when open opens it, and while it is open. */
export const USED_EVERY = 3600 * 1000;

/** Sets the modification time of the database file at p to now when it is
 * older than USED_EVERY: pruneHostFiles counts its retention from it. open
 * calls it, and it keeps the database marked while it is open
 * (keepMarked). */
export function markUsed(p: string): void {
  markOld(p, new Date());
  keepMarked(p);
}

/** Sets the modification time of the database file at p to now when it is
 * older than USED_EVERY. */
function markOld(p: string, now: Date): void {
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile()) return;
    if (now.getTime() - st.mtimeMs >= USED_EVERY) fs.utimesSync(p, now, now);
  } catch {
    // not there
  }
}

/** Bounds the databases a process keeps marked: a process opens a few (its
 * own, and in the tests one per test). */
const MAX_MARKED = 256;

/** How long a database keepMarked took stays kept before refreshMarked
 * looks at whether it is open: open takes it before it opens the
 * database. */
export const MARK_GRACE = 60 * 1000;

/** The databases this process opened, with when (ms), which it marks used
 * every USED_EVERY while they are open (refreshMarked); the timer runs
 * from the first one on. */
export const marked = new Map<string, number>();
let markTimer: ReturnType<typeof setInterval> | undefined;

/** Has the database at p marked used every USED_EVERY while it is open: a
 * database a process holds open for longer than the retention without
 * writing would otherwise look unused to another host's pruneHostFiles,
 * which then removes it when the file system's locks do not reach across
 * hosts (a home on NFS without a lock manager). The timer does not keep
 * the process running. */
export function keepMarked(p: string): void {
  if (marked.has(p) || marked.size < MAX_MARKED) marked.set(p, Date.now());
  if (!markTimer) {
    markTimer = setInterval(() => refreshMarked(new Date()), USED_EVERY);
    markTimer.unref?.();
  }
}

/** Marks the databases of keepMarked that are open used, and forgets
 * those that are not, once taken MARK_GRACE before now (a later open has
 * them marked again). A database is open while its write-ahead log is
 * there: every database of the store uses write-ahead logging, which
 * SQLite creates with the first connection and removes when the last one
 * closes; only processes of this host open its databases (hostFile), so
 * the log says that this process or another of this host has it open. A
 * log left by a process that crashed keeps its database marked while this
 * process runs. */
export function refreshMarked(now: Date): void {
  for (const [p, at] of [...marked]) {
    try {
      if (fs.lstatSync(p + '-wal').isFile()) {
        markOld(p, now);
        continue;
      }
    } catch {
      // no log
    }
    if (now.getTime() - at < MARK_GRACE) continue;
    if (marked.get(p) === at) marked.delete(p);
  }
}
