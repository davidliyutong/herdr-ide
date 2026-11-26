import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DB, DEFAULT_BUSY_TIMEOUT, NewerError, UnsafeError, open } from './index.ts';

// v1 and v2 are a schema's two versions; each records that it ran.
const v1 = `CREATE TABLE runs (n INTEGER NOT NULL);
      INSERT INTO runs VALUES (1);
      CREATE TABLE chats (id TEXT PRIMARY KEY);
      CREATE TABLE events (chat TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, seq INTEGER NOT NULL);`;
const v2 = `INSERT INTO runs VALUES (2); ALTER TABLE chats ADD COLUMN title TEXT NOT NULL DEFAULT '';`;

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

function openT(path: string, ...migrations: string[]): DB {
  const db = open(path, { migrations });
  opened.push(db);
  return db;
}

const runs = (db: DB) => db.all<{ n: number }>('SELECT n FROM runs ORDER BY rowid').map((r) => r.n);
const pragma = (db: DB, name: string) => Object.values(db.get(`PRAGMA ${name}`) ?? {})[0];
const mode = (p: string) => fs.statSync(p).mode & 0o777;

// Each migration runs once, in order, and a later version runs only the
// migrations it adds.
test('TestMigrationsOnce', () => {
  const path = join(temp(), 'state', 'chat.db');
  let db = openT(path, v1);
  expect(db.version).toBe(1);
  expect(db.readOnly).toBe(false);
  expect(db.newer).toBeUndefined();
  db.close();
  db = openT(path, v1);
  expect(runs(db)).toEqual([1]);
  db.close();
  db = openT(path, v1, v2);
  expect(runs(db)).toEqual([1, 2]);
  expect(db.version).toBe(2);
  // A failed migration changes nothing.
  db.close();
  expect(() => open(path, { migrations: [v1, v2, 'INSERT INTO runs VALUES (3); CREATE TABLE broken ('] })).toThrow('store: migration 3');
  db = openT(path, v1, v2);
  expect(runs(db)).toEqual([1, 2]);
  expect(db.version).toBe(2);
});

// The connections' settings: write-ahead logging, foreign keys enforced.
test('TestPragmas', () => {
  const db = openT(join(temp(), 'x.db'), v1);
  expect(pragma(db, 'journal_mode')).toBe('wal');
  expect(pragma(db, 'foreign_keys')).toBe(1);
  expect(pragma(db, 'busy_timeout')).toBe(DEFAULT_BUSY_TIMEOUT);
  expect(pragma(db, 'synchronous')).toBe(1);
  expect(pragma(db, 'auto_vacuum')).toBe(2);
  expect(() => db.exec("INSERT INTO events VALUES ('nope', 1)")).toThrow();
  db.exec("INSERT INTO chats (id) VALUES ('c1'); INSERT INTO events VALUES ('c1', 1); DELETE FROM chats");
  expect(db.get<{ n: number }>('SELECT count(*) AS n FROM events')!.n).toBe(0); // a chat's events went with it
  // A busy timeout of the caller's.
  const quick = open(join(temp(), 'y.db'), { busyTimeout: 250 });
  opened.push(quick);
  expect(pragma(quick, 'busy_timeout')).toBe(250);
});

// A database a newer program migrated further opens read-only: it reads,
// and nothing writes.
test('TestNewerOpensReadOnly', () => {
  const path = join(temp(), 'chat.db');
  let db = openT(path, v1, v2);
  db.exec("INSERT INTO chats (id, title) VALUES ('c1', 'kept')");
  db.close();

  const old = openT(path, v1);
  expect(old.newer).toBeInstanceOf(NewerError);
  expect(old.newer!.version).toBe(2);
  expect(old.newer!.message).toContain('(2, the code knows 1)');
  expect(old.readOnly).toBe(true);
  expect(old.version).toBe(2);
  expect(old.get<{ title: string }>("SELECT title FROM chats WHERE id = 'c1'")!.title).toBe('kept');
  expect(() => old.exec("INSERT INTO chats (id) VALUES ('c2')")).toThrow();
  expect(() => old.exec('PRAGMA user_version = 1')).toThrow();
  old.close();
  // The newer program still has its database as it left it.
  db = openT(path, v1, v2);
  expect(runs(db)).toEqual([1, 2]);
  expect(db.version).toBe(2);
});

// Two programs opening one database at once (an old host and the new one
// at a handover) migrate it once, and all write. The programs are
// processes: a process's calls to SQLite are synchronous.
test('TestConcurrentOpen', async () => {
  const path = join(temp(), 'chat.db');
  const n = 4;
  const index = join(import.meta.dir, 'index.ts');
  const script = (i: number) => `
    import { open } from ${JSON.stringify(index)};
    const db = open(${JSON.stringify(path)}, { migrations: ${JSON.stringify([v1, v2])} });
    for (let j = 0; j < 20; j++) db.run('INSERT INTO chats (id) VALUES (?)', '${i}-' + j);
    db.close();`;
  const codes = await Promise.all(
    Array.from(
      { length: n },
      (_, i) =>
        new Promise<number | null>((resolve) => {
          const c = spawn(process.execPath, ['-e', script(i)], { stdio: ['ignore', 'ignore', 'inherit'] });
          c.on('exit', resolve);
        }),
    ),
  );
  expect(codes).toEqual(Array(n).fill(0));
  const db = openT(path, v1, v2);
  expect(runs(db)).toEqual([1, 2]);
  expect(db.get<{ n: number }>('SELECT count(*) AS n FROM chats')!.n).toBe(n * 20);
});

// Connections of one process to one database take turns.
test('connections of one process', () => {
  const path = join(temp(), 'chat.db');
  const dbs = Array.from({ length: 4 }, () => openT(path, v1, v2));
  expect(runs(dbs[0])).toEqual([1, 2]);
  for (let j = 0; j < 20; j++) for (const [i, db] of dbs.entries()) db.run('INSERT INTO chats (id) VALUES (?)', `${i}-${j}`);
  expect(dbs[1].get<{ n: number }>('SELECT count(*) AS n FROM chats')!.n).toBe(80);
});

// update commits, rolls back what a failing function did, refuses an async
// function, and runs one inside another in a savepoint.
test('update', () => {
  const db = openT(join(temp(), 'u.db'), v1);
  const count = () => db.get<{ n: number }>('SELECT count(*) AS n FROM chats')!.n;
  expect(db.update((tx) => tx.run("INSERT INTO chats (id) VALUES ('a')").changes)).toBe(1);
  expect(() =>
    db.update((tx) => {
      tx.exec("INSERT INTO chats (id) VALUES ('b')");
      throw new Error('no');
    }),
  ).toThrow('no');
  expect(count()).toBe(1);
  expect(() => db.update(async () => db.exec("INSERT INTO chats (id) VALUES ('c')"))).toThrow('synchronous');
  expect(count()).toBe(1);
  db.update((tx) => {
    tx.exec("INSERT INTO chats (id) VALUES ('d')");
    expect(() =>
      tx.update((inner) => {
        inner.exec("INSERT INTO chats (id) VALUES ('e')");
        throw new Error('inner');
      }),
    ).toThrow('inner');
    tx.update((inner) => inner.exec("INSERT INTO chats (id) VALUES ('f')"));
    expect(() => tx.durable(() => 0)).toThrow('inside another');
  });
  expect(db.all<{ id: string }>('SELECT id FROM chats ORDER BY id').map((r) => r.id)).toEqual(['a', 'd', 'f']);
  // A statement's failure that ended the transaction leaves it ended.
  expect(() => db.update((tx) => tx.exec("INSERT INTO chats (id) VALUES ('a')"))).toThrow();
  db.update((tx) => tx.exec("INSERT INTO chats (id) VALUES ('g')"));
  expect(count()).toBe(4);
});

describe.skipIf(process.platform === 'win32')('mode bits', () => {
  // The database and its directory are this user's alone.
  test('TestPermissions', () => {
    const dir = join(temp(), 'a', 'b');
    const path = join(dir, 'chat.db');
    const db = openT(path, v1);
    db.exec("INSERT INTO chats (id) VALUES ('c1')");
    for (const [p, want] of [
      [dir, 0o700],
      [path, 0o600],
      [path + '-wal', 0o600],
      [path + '-shm', 0o600],
    ] as const)
      expect([p, mode(p)]).toEqual([p, want]);
    db.close();

    // Looser modes of the user's own directory and file are made private.
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(path, 0o644);
    openT(path, v1).close();
    expect(mode(dir)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
  });
});

// A link is refused where the database, its journal or its directory
// would be, and so is what is not a regular file.
test('TestLinksRefused', () => {
  const base = temp();
  const real = join(base, 'real.db');
  openT(real, v1).close();

  const link = join(base, 'link.db');
  try {
    fs.symlinkSync(real, link);
  } catch {
    return; // no symbolic links
  }
  expect(() => open(link, { migrations: [v1] })).toThrow(UnsafeError);
  const dangling = join(base, 'dangling.db');
  fs.symlinkSync(join(base, 'elsewhere.db'), dangling);
  expect(() => open(dangling, { migrations: [v1] })).toThrow();
  expect(fs.existsSync(join(base, 'elsewhere.db'))).toBe(false); // a link's target was not created

  const dirLink = join(base, 'dirlink');
  fs.symlinkSync(base, dirLink);
  expect(() => open(join(dirLink, 'x.db'), { migrations: [v1] })).toThrow(UnsafeError);

  const wal = join(base, 'w.db');
  fs.symlinkSync(join(base, 'target'), wal + '-wal');
  expect(() => open(wal, { migrations: [v1] })).toThrow(UnsafeError);

  const notFile = join(base, 'adir.db');
  fs.mkdirSync(notFile, { mode: 0o700 });
  expect(() => open(notFile, { migrations: [v1] })).toThrow(UnsafeError);
  expect(() => open('relative.db')).toThrow('not an absolute path');
});

// Paths with characters a URI quotes open as themselves.
test('TestPathsQuoted', () => {
  const dir = join(temp(), 'a b?c#d%e');
  const path = join(dir, 'chat x.db');
  openT(path, v1).close();
  expect(fs.existsSync(path)).toBe(true);
  for (const name of fs.readdirSync(dir)) expect(['chat x.db', 'chat x.db-wal', 'chat x.db-shm']).toContain(name);
  expect(runs(openT(path, v1))).toHaveLength(1); // the database opened again is the same
});
