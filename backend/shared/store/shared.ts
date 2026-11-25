// Shared databases. The hub's database (hub.db, beside its settings
// file) and a machine's (machine-<host>.db, hostFile, in the agent's data
// directory) hold the state of several features of one owner. Such a
// database is opened with openShared: its user_version is the store's own
// layout (LAYOUT: the features' schema versions), and each feature brings
// its own tables, named with the feature's name as their prefix, to its
// version with DB.migrate, independently of the other features. A feature
// whose tables a newer program migrated further reads them and does not
// write (migrate's NewerError); so does every feature of a database whose
// layout is newer (openShared's db.newer).
//
// A process opens a shared database once: openShared hands out a handle
// of the connection it already has open on that file, and the connection
// closes with its last handle. An owner that keeps a handle while it runs
// (the hub's server) makes every feature's use of the database take the
// open connection.
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { MODE_BITS, owned, sameFile } from './owner.ts';
import { closeConn, DB, NewerError, open, type Conn } from './store.ts';

/** The name of a machine's shared database in its agent's data directory,
 * which is kept per host (hostFile: ~/.<slug>[-<instance>]/machine-<host>.db).
 * The hub's is hub.db beside its settings file. */
export const MACHINE_DB = 'machine.db';

/** The store's own tables of a shared database, versioned by its
 * user_version: what each feature migrated to. (store_imports recorded
 * one-time imports of files features kept before; the second step drops
 * it.) */
export const LAYOUT: readonly string[] = [
  `CREATE TABLE store_features (
		feature TEXT PRIMARY KEY,
		version INTEGER NOT NULL
	);
	CREATE TABLE store_imports (
		feature TEXT NOT NULL,
		name TEXT NOT NULL,
		at INTEGER NOT NULL,
		PRIMARY KEY (feature, name)
	);`,
  `DROP TABLE IF EXISTS store_imports;`,
];

/** A shared database's connection and its handles. */
export interface Pool {
  path: string;
  conn: Conn;
  /** The database's file when the pool opened it: a file removed or
   * replaced since is opened again. */
  file: fs.BigIntStats;
  refs: number;
}

/** The pools this process has open, by path. */
export const pools = new Map<string, Pool>();

const lstat = (p: string): fs.BigIntStats | undefined => {
  try {
    return fs.lstatSync(p, { bigint: true });
  } catch {
    return undefined;
  }
};

/** Opens the shared database at path, an absolute path, as open does
 * (creating it and its directory, private to the user), with the store's
 * layout; or hands out another handle of the connection this process has
 * open on it. DB.close releases the handle. A database whose layout is
 * newer is returned read-only with its newer set, as open's. A directory
 * that is a link of the user's to a directory of the user's is taken as
 * its target (resolveDir). */
export function openShared(path: string): DB {
  if (!isAbsolute(path)) throw new Error(`store: ${JSON.stringify(path)} is not an absolute path`);
  path = resolveDir(resolve(path));
  const st = lstat(path);
  const p = pools.get(path);
  if (p) {
    if (st && sameFile(st, p.file)) return handle(p);
    // The file went or was replaced: its holders keep the old pool until
    // they close it.
    pools.delete(path);
  }
  if (st) {
    // The same file by another path (a link above it).
    for (const q of pools.values()) if (sameFile(st, q.file)) return handle(q);
  }
  const db = open(path, { migrations: LAYOUT });
  const file = lstat(path);
  if (!file) {
    db.close();
    throw new Error(`store: ${basename(path)}: removed while it was opened`);
  }
  const pool: Pool = { path, conn: db.conn, file, refs: 0 };
  pools.set(path, pool);
  return handle(pool);
}

/** A new handle of p; read-only with newer when p's layout is newer. */
function handle(p: Pool): DB {
  p.refs++;
  const newer = p.conn.readOnly ? new NewerError(`layout ${p.conn.version}, the code knows ${LAYOUT.length}`, p.conn.version) : undefined;
  return new DB(p.conn, p, newer);
}

/** Releases a handle of p, and closes p with its last handle. */
export function releaseHandle(p: Pool): void {
  if (--p.refs > 0) return;
  if (pools.get(p.path) === p) pools.delete(p.path);
  closeConn(p.conn);
}

/** path in the directory its directory links to, when that directory is a
 * symbolic link of this user's to a directory of this user's: the
 * configuration or data directory a dotfile manager linked, which open
 * would refuse. Any other path is path (and open decides). */
function resolveDir(path: string): string {
  const dir = dirname(path);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return path;
  }
  if (!st.isSymbolicLink() || !MODE_BITS) return path;
  try {
    const real = fs.realpathSync(dir);
    const rst = fs.lstatSync(real);
    if (!rst.isDirectory() || !owned(rst) || !owned(st)) return path;
    return join(real, basename(path));
  } catch {
    return path;
  }
}

const VALID_FEATURE = /^[a-z][a-z0-9_]{0,31}$/;

/** DB.migrate of a shared database's handle. */
export function migrateFeature(db: DB, feature: string, steps: readonly string[]): number {
  if (!VALID_FEATURE.test(feature)) throw new Error(`store: bad feature name ${JSON.stringify(feature)}`);
  const n = steps.length;
  const newer = (v: number) => new NewerError(`${feature} ${v}, the code knows ${n}`, v);
  let version = featureVersion(db, feature);
  if (version > n) throw newer(version);
  if (db.readOnly) throw new NewerError('the database is read-only', version);
  if (version === n) return version;
  return db.update(() => {
    // Another connection may have migrated since the first look.
    version = featureVersion(db, feature);
    if (version > n) throw newer(version);
    if (version === n) return version;
    for (let i = version; i < n; i++) {
      try {
        db.exec(steps[i]);
      } catch (e) {
        throw new Error(`store: ${feature} migration ${i + 1}: ${(e as Error).message}`, { cause: e });
      }
    }
    db.run(
      `INSERT INTO store_features (feature, version) VALUES (?, ?)
		ON CONFLICT (feature) DO UPDATE SET version = excluded.version`,
      feature,
      n,
    );
    return n;
  });
}

function featureVersion(db: DB, feature: string): number {
  const row = db.get<{ version: number }>('SELECT version FROM store_features WHERE feature = ?', feature);
  return row ? Number(row.version) : 0;
}
