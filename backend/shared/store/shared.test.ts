import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DB, NewerError, NotSharedError, UnsafeError, open, openShared } from './index.ts';
import { LAYOUT, pools } from './shared.ts';

const dirs: string[] = [];
const temp = () => {
  const d = fs.mkdtempSync(join(tmpdir(), 'store-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const opened: DB[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function shared(path: string): DB {
  const db = openShared(path);
  opened.push(db);
  return db;
}

const count = (db: DB, table: string) => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;
const pragma = (db: DB, name: string) => Object.values(db.get(`PRAGMA ${name}`) ?? {})[0];

function newer(fn: () => unknown): NewerError {
  try {
    fn();
  } catch (e) {
    if (e instanceof NewerError) return e;
    throw e;
  }
  throw new Error('no NewerError');
}

// A process has one connection per shared database: the handles share it,
// each closes once, and the connection closes with the last one.
test('TestSharedOnePool', () => {
  const path = join(temp(), 'hub.db');
  const a = shared(path);
  const b = shared(path);
  expect(a.sqlite).toBe(b.sqlite);
  a.close();
  a.close(); // a second close of a handle releases nothing more
  expect(() => a.get('SELECT 1')).toThrow('closed');
  expect(b.get('SELECT 1 AS one')).toEqual({ one: 1 }); // not closed with a handle left
  const conn = b.sqlite;
  b.close();
  expect(() => conn.prepare('SELECT 1')).toThrow(); // closed without handles
  expect(pools.size).toBe(0);
  // Opened again: a new connection of the same file.
  const c = shared(path);
  expect(c.get('SELECT 1 AS one')).toEqual({ one: 1 });
  expect(c.version).toBe(LAYOUT.length);
  expect(c.readOnly).toBe(false);
  expect(() => openShared('relative.db')).toThrow('not an absolute path');
});

// A database file removed or replaced while a pool is open on it is
// opened anew; the old pool's holders keep it until they close it.
test.skipIf(process.platform === 'win32')('TestSharedFileReplaced', () => {
  const path = join(temp(), 'machine.db');
  const a = shared(path);
  expect(a.migrate('x', ['CREATE TABLE x_t (n INTEGER)'])).toBe(1);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(path + s, { force: true });
  const b = shared(path);
  expect(a.sqlite).not.toBe(b.sqlite);
  expect(b.migrate('x', ['CREATE TABLE x_t (n INTEGER)'])).toBe(1);
  expect(a.get('SELECT 1 AS one')).toEqual({ one: 1 }); // the old pool is still its holder's
});

// Features migrate independently: each step of each feature runs once, a
// new step of one runs alone, and the layout's version stays.
test('TestFeaturesMigrateIndependently', () => {
  const db = shared(join(temp(), 'hub.db'));
  const a1 = 'CREATE TABLE a_runs (n INTEGER); INSERT INTO a_runs VALUES (1)';
  const a2 = 'INSERT INTO a_runs VALUES (2)';
  const b1 = 'CREATE TABLE b_runs (n INTEGER); INSERT INTO b_runs VALUES (1)';
  expect(db.migrate('a', [a1])).toBe(1);
  expect(db.migrate('b', [b1])).toBe(1);
  expect(db.migrate('a', [a1])).toBe(1);
  expect(db.migrate('a', [a1, a2])).toBe(2);
  expect(db.migrate('b', [b1])).toBe(1);
  expect(count(db, 'a_runs')).toBe(2);
  expect(count(db, 'b_runs')).toBe(1);
  expect(pragma(db, 'user_version')).toBe(LAYOUT.length);
  // A failed step changes nothing.
  expect(() => db.migrate('b', [b1, 'INSERT INTO b_runs VALUES (2); CREATE TABLE broken ('])).toThrow('store: b migration 2');
  expect(count(db, 'b_runs')).toBe(1);
  expect(db.migrate('b', [b1])).toBe(1);
  for (const bad of ['', 'A', '1x', 'a-b', 'a b', 'store features', 'x'.repeat(33)]) {
    expect(() => db.migrate(bad, [])).toThrow('bad feature name');
  }
});

// Tables a newer program migrated further make their feature read-only:
// it reads, migrate throws NewerError, and the other features still write.
test('TestFeatureNewer', () => {
  const db = shared(join(temp(), 'hub.db'));
  db.migrate('a', ['CREATE TABLE a_t (n INTEGER)', 'ALTER TABLE a_t ADD COLUMN m INTEGER']);
  db.exec('INSERT INTO a_t VALUES (1, 2)');
  const e = newer(() => db.migrate('a', ['CREATE TABLE a_t (n INTEGER)']));
  expect(e.version).toBe(2);
  expect(e.message).toContain('a 2, the code knows 1');
  expect(db.get<{ n: number }>('SELECT n FROM a_t')!.n).toBe(1);
  expect(db.migrate('b', ['CREATE TABLE b_t (n INTEGER)'])).toBe(1);
  db.exec('INSERT INTO b_t VALUES (1)');
});

// A database whose layout is newer opens read-only: every feature reads
// and none writes or migrates.
test('TestLayoutNewer', () => {
  const path = join(temp(), 'hub.db');
  const db = openShared(path);
  db.migrate('a', ['CREATE TABLE a_t (n INTEGER)']);
  db.exec('INSERT INTO a_t VALUES (7)');
  db.exec('PRAGMA user_version = 99');
  db.close();

  const ro = shared(path);
  expect(ro.newer).toBeInstanceOf(NewerError);
  expect(ro.newer!.message).toContain('layout 99');
  expect(ro.readOnly).toBe(true);
  expect(newer(() => ro.migrate('a', ['CREATE TABLE a_t (n INTEGER)'])).version).toBe(1);
  expect(newer(() => ro.migrate('b', ['CREATE TABLE b_t (n INTEGER)'])).version).toBe(0);
  expect(ro.get<{ n: number }>('SELECT n FROM a_t')!.n).toBe(7);
  expect(() => ro.exec('INSERT INTO a_t VALUES (8)')).toThrow();
  // Another handle of the same pool is read-only too.
  const ro2 = openShared(path);
  expect(ro2.newer).toBeInstanceOf(NewerError);
  expect(ro2.readOnly).toBe(true);
  ro2.close();
  ro.reclaim(); // nothing to do read-only
});

// durable commits and leaves its connection as the others are; update
// rolls back what a failing function did.
test('TestDurableAndUpdate', () => {
  const db = shared(join(temp(), 'hub.db'));
  db.migrate('a', ['CREATE TABLE a_t (n INTEGER)']);
  db.durable((tx) => {
    expect(pragma(tx, 'synchronous')).toBe(2);
    tx.exec('INSERT INTO a_t VALUES (1)');
  });
  expect(pragma(db, 'synchronous')).toBe(1);
  const fail = new Error('no');
  expect(() =>
    db.update((tx) => {
      tx.exec('INSERT INTO a_t VALUES (2)');
      throw fail;
    }),
  ).toThrow(fail);
  expect(() =>
    db.durable((tx) => {
      tx.exec('INSERT INTO a_t VALUES (3)');
      throw fail;
    }),
  ).toThrow(fail);
  expect(pragma(db, 'synchronous')).toBe(1);
  expect(count(db, 'a_t')).toBe(1);
});

// A database of one feature (open) has no features' tables.
test('TestNotShared', () => {
  const db = open(join(temp(), 'chat.db'), { migrations: ['CREATE TABLE t (n)'] });
  opened.push(db);
  expect(() => db.migrate('a', [])).toThrow(NotSharedError);
});

describe.skipIf(process.platform === 'win32')('unix', () => {
  // A shared database is private to the user as any other.
  test('TestSharedPermissions', () => {
    const dir = join(temp(), 'd');
    const path = join(dir, 'hub.db');
    const db = shared(path);
    db.migrate('a', ['CREATE TABLE a_t (n INTEGER)']);
    db.exec('INSERT INTO a_t VALUES (1)');
    for (const [p, want] of [
      [dir, 0o700],
      [path, 0o600],
      [path + '-wal', 0o600],
    ] as const)
      expect([p, fs.statSync(p).mode & 0o777]).toEqual([p, want]);
    const link = join(temp(), 'link.db');
    fs.symlinkSync(path, link);
    expect(() => openShared(link)).toThrow(UnsafeError);
  });

  // A directory that is a link of the user's to a directory of the user's
  // (a dotfile manager's) holds a shared database in its target; the
  // database's file itself is never a link.
  test('TestSharedLinkedDirectory', () => {
    const real = join(temp(), 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    const link = join(temp(), 'config');
    fs.symlinkSync(real, link);
    const db = shared(join(link, 'hub.db'));
    db.migrate('a', ['CREATE TABLE a_t (n INTEGER)']);
    expect(fs.lstatSync(join(real, 'hub.db')).isFile()).toBe(true);
    expect(shared(join(real, 'hub.db')).sqlite).toBe(db.sqlite); // one pool for one file
    // open itself still refuses the linked directory.
    expect(() => open(join(link, 'x.db'))).toThrow(UnsafeError);
  });
});

// A database whose rows went gives their pages back once they are many; a
// few stay for the next rows.
test('TestReclaim', () => {
  const db = shared(join(temp(), 'machine.db'));
  expect(pragma(db, 'auto_vacuum')).toBe(2);
  db.migrate('a', ['CREATE TABLE a_t (b BLOB)']);
  const blob = new Uint8Array(1 << 20);
  for (let i = 0; i < 24; i++) db.run('INSERT INTO a_t VALUES (?)', blob);
  const pages = () => [Number(pragma(db, 'page_count')), Number(pragma(db, 'freelist_count'))] as const;
  const [full] = pages();
  db.exec('DELETE FROM a_t WHERE rowid > 22');
  db.reclaim();
  let [n, free] = pages();
  expect([n, free > 0]).toEqual([full, true]); // 2 MiB: kept
  db.exec('DELETE FROM a_t');
  db.reclaim();
  [n, free] = pages();
  expect(n * 4).toBeLessThanOrEqual(full);
  expect(free).toBe(0);
});
