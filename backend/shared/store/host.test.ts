import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as hostid from '#shared/host/hostid.ts';
import {
  HOST_FILE_RETENTION,
  JOURNALS,
  MARK_GRACE,
  hostFile,
  hostFileName,
  hostKey,
  keepMarked,
  marked,
  pruneHostFiles,
  refreshMarked,
  removeUnheld,
  thisHost,
  validHostKey,
} from './host.ts';
import { DB, MACHINE_DB, open, openShared } from './index.ts';

const dirs: string[] = [];
const temp = () => {
  const d = fs.mkdtempSync(join(tmpdir(), 'store-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

const HOUR = 3600 * 1000;
const MONTH = HOST_FILE_RETENTION + HOUR;
const INDEX = join(import.meta.dir, 'index.ts');

// A database of a host is named after the host's whole name, sanitized,
// and a hash of its machine id: two hosts sharing a data directory never
// share a database, also when their names are alike or the same.
test('TestHostFile', () => {
  const names: Array<[string, string]> = [
    ['node01.cluster.example.org', 'node01.cluster.example.org'],
    ['MacBook-Pro.local', 'macbook-pro.local'],
    ['  ', 'localhost'],
    ['', 'localhost'],
    ['.local', 'local'],
    ['a/b\\c:d e', 'a_b_c_d_e'],
    ['..', 'localhost'],
    ['büro', 'b_ro'],
    ['x.', 'x'],
    ['x'.repeat(200), 'x'.repeat(hostid.MAX_NAME)],
  ];
  for (const [h, want] of names) expect([h, hostid.name(h)]).toEqual([h, want]);
  // node01 of two clusters, and two machines of one name.
  const a = hostKey('node01.a.example.org', 'id-1');
  const b = hostKey('node01.b.example.org', 'id-1');
  const c = hostKey('node01', 'id-1');
  const d = hostKey('node01', 'id-2');
  expect(new Set([a, b, c, d]).size).toBe(4);
  expect(c.startsWith('node01-')).toBe(true);
  expect(c).toHaveLength('node01-'.length + 8);
  expect(c).not.toContain('id-1');
  expect(hostKey('Node01', ' \n')).toBe('node01');
  for (const k of [a, b, c, d, 'node01', 'elsewhere', 'x'.repeat(hostid.MAX_NAME) + '-0123abcd'])
    expect([k, validHostKey(k)]).toEqual([k, true]);
  for (const k of ['', 'Upper', '.x', 'x.', 'a b', 'a/b', 'x'.repeat(hostid.MAX_NAME + 10)])
    expect([k, validHostKey(k)]).toEqual([k, false]);
  expect(hostFileName('machine.db', 'h1')).toBe('machine-h1.db');
  expect(hostFileName('chat', 'h1')).toBe('chat-h1');
  const dir = temp();
  const p = hostFile(dir, MACHINE_DB);
  const want = hostKey(hostname(), hostid.machineID());
  expect(dirname(p)).toBe(dir);
  expect(basename(p)).toBe(`machine-${want}.db`);
  expect(thisHost()).toBe(want);
  expect(validHostKey(thisHost())).toBe(true);
});

/** Sets the modification time of the database at p and of its journal
 * files to ms before now. */
function age(p: string, ms: number) {
  const old = new Date(Date.now() - ms);
  for (const s of ['', ...JOURNALS]) {
    try {
      fs.utimesSync(p + s, old, old);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

function makeDB(p: string) {
  const db = open(p, { migrations: ['CREATE TABLE t (n INTEGER)'] });
  db.exec('INSERT INTO t VALUES (1)');
  db.close();
}

const exists = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Starts a process that holds the database at p open until stopped: as
 * the store's openShared does (its connection idle between transactions),
 * as a connection idle after a read, or as one inside a write transaction
 * (BEGIN IMMEDIATE). The returned function ends it. */
async function hold(p: string, how: 'shared' | 'idle' | 'writing' = 'shared'): Promise<() => Promise<void>> {
  const body =
    how === 'shared'
      ? `import { openShared } from ${JSON.stringify(INDEX)};
         const db = openShared(${JSON.stringify(p)});
         db.migrate('held', ['CREATE TABLE held_t (n INTEGER)']);
         db.run('INSERT INTO held_t VALUES (1)');`
      : `import { DatabaseSync } from 'node:sqlite';
         const db = new DatabaseSync(${JSON.stringify(p)});
         db.prepare('SELECT count(*) FROM sqlite_master').get();
         ${how === 'writing' ? "db.exec('BEGIN IMMEDIATE');" : ''}`;
  const script = `${body}
    process.stdout.write('ready\\n');
    process.stdin.resume();
    process.stdin.on('end', () => { db.close(); process.exit(0); });`;
  const c = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise<void>((r) => c.on('exit', () => r()));
  await new Promise<void>((resolve, reject) => {
    c.stdout!.once('data', (b: Buffer) => (b.toString() === 'ready\n' ? resolve() : reject(new Error(`holder: ${b}`))));
    c.once('exit', (code) => reject(new Error(`holder exited ${code}`)));
  });
  let done = false;
  const stop = async () => {
    if (done) return;
    done = true;
    c.stdin!.end();
    await exited;
  };
  cleanups.push(stop);
  return stop;
}

describe.skipIf(process.platform === 'win32')('unix', () => {
  // Other hosts' databases (and the name of no host's) unopened for the
  // retention and held by no process go with their journal files; this
  // host's, recent ones, held ones, ones this process has open and names
  // of no database stay.
  test('TestPruneHostFiles', async () => {
    const dir = temp();
    const mine = hostFile(dir, MACHINE_DB);
    const other = join(dir, 'machine-other_host.db');
    // Another host's of this version: its whole name and its id's hash.
    const named = join(dir, 'machine-node01.cluster.example.org-0a1b2c3d.db');
    const recent = join(dir, 'machine-recent.db');
    const held = join(dir, 'machine-held.db');
    const openHereP = join(dir, 'machine-here.db');
    for (const p of [mine, other, named, recent]) makeDB(p);
    // A journal file left beside other's database goes with it.
    fs.writeFileSync(other + '-wal', 'x', { mode: 0o600 });
    // Names of no host's database, and a link.
    const upper = join(dir, 'machine-Upper.db');
    const dotted = join(dir, 'machine-.b.db');
    const chat = join(dir, 'chat-other.db');
    const link = join(dir, 'machine-link.db');
    for (const p of [upper, dotted, chat]) makeDB(p);
    fs.symlinkSync(other, link);
    const stop = await hold(held); // creates it
    const here = openShared(openHereP);
    cleanups.push(() => here.close());
    for (const p of [mine, other, named, held, openHereP, upper, dotted, chat]) age(p, MONTH);
    let removed = pruneHostFiles(dir, MACHINE_DB, HOST_FILE_RETENTION, new Date()).sort();
    expect(removed).toEqual(['machine-node01.cluster.example.org-0a1b2c3d.db', 'machine-other_host.db']);
    for (const p of [other, other + '-wal', other + '-shm', named]) expect([basename(p), exists(p)]).toEqual([basename(p), false]);
    for (const p of [mine, recent, held, openHereP, upper, dotted, chat]) expect([basename(p), exists(p)]).toEqual([basename(p), true]);
    // The holder's database is whole and still its own.
    await stop();
    const check = open(held);
    expect(check.get<{ n: number }>('SELECT count(*) AS n FROM held_t')!.n).toBe(1);
    check.close();
    here.close();
    age(held, MONTH);
    age(openHereP, MONTH);
    removed = pruneHostFiles(dir, MACHINE_DB, HOST_FILE_RETENTION, new Date()).sort();
    expect(removed).toEqual(['machine-held.db', 'machine-here.db']);
    expect(exists(held + '-wal') || exists(held + '-shm')).toBe(false);
    expect(exists(mine)).toBe(true);
    expect(pruneHostFiles(join(dir, 'missing'), MACHINE_DB)).toEqual([]);
  });

  // A database whose journal file was written within the retention is in
  // use: it stays.
  test('TestPruneHostFilesRecentJournal', () => {
    const dir = temp();
    const p = join(dir, 'chat-b.db');
    makeDB(p);
    fs.writeFileSync(p + '-wal', '', { mode: 0o600 });
    age(p, MONTH);
    const now = new Date();
    fs.utimesSync(p + '-wal', now, now);
    expect(pruneHostFiles(dir, 'chat.db', HOST_FILE_RETENTION, now)).toEqual([]);
    expect(exists(p)).toBe(true);
  });

  // open marks a database used: its modification time is when it was last
  // opened (at most an hour off), from which pruneHostFiles counts.
  test('TestOpenMarksUsed', () => {
    const p = join(temp(), 'machine-b.db');
    makeDB(p);
    age(p, 48 * HOUR);
    open(p, { migrations: ['CREATE TABLE t (n INTEGER)'] }).close();
    expect(Date.now() - fs.statSync(p).mtimeMs).toBeLessThan(60_000);
    expect(pruneHostFiles(dirname(p), MACHINE_DB)).toEqual([]);
  });

  // A database stays marked used while it is open, also for longer than
  // the retention without a write: a process that holds this host's
  // database open keeps it from another host's pruneHostFiles. Once closed
  // it is marked no more, and forgotten.
  test('TestOpenKeepsMarked', () => {
    const dir = temp();
    const p = join(dir, 'machine-b.db');
    const db = open(p, { migrations: ['CREATE TABLE t (n INTEGER)'] });
    cleanups.push(() => db.close());
    expect(marked.has(p)).toBe(true);
    const modified = () => Date.now() - fs.statSync(p).mtimeMs;
    // Open longer than the retention, without a write: an hourly pass
    // marks it.
    age(p, MONTH);
    refreshMarked(new Date(Date.now() + MARK_GRACE));
    expect(modified()).toBeLessThan(60_000);
    expect(modified()).toBeGreaterThan(-2 * 60_000);
    expect(pruneHostFiles(dir, MACHINE_DB)).toEqual([]);
    // Closed: no longer marked, and forgotten.
    db.close();
    age(p, MONTH);
    refreshMarked(new Date(Date.now() + MARK_GRACE));
    expect(modified()).toBeGreaterThanOrEqual(HOST_FILE_RETENTION);
    expect(marked.has(p)).toBe(false);
    // One open just took (it has no log yet) stays kept.
    const q = join(dir, 'machine-c.db');
    keepMarked(q);
    refreshMarked(new Date());
    expect(marked.has(q)).toBe(true);
    marked.delete(q);
  });

  // A database of no host's name is not one of pruneHostFiles', and the
  // default instance's hub database (hub.db, and core.db of releases
  // before the rename) skips other instances' databases in the shared
  // config directory.
  test('TestPruneHostFilesHubInstances', () => {
    const dir = temp();
    const plain = join(dir, MACHINE_DB);
    makeDB(plain);
    age(plain, MONTH);
    expect(pruneHostFiles(dir, MACHINE_DB)).toEqual([]);
    expect(exists(plain)).toBe(true);

    for (const stem of ['hub', 'core']) {
      // Instance isolation: pruning hub.db must not remove hub-dev-*.db.
      const cdir = temp();
      fs.writeFileSync(join(cdir, 'settings-dev.json'), '{}', { mode: 0o600 });
      const mine = hostFile(cdir, `${stem}.db`);
      const dev = join(cdir, `${stem}-dev-otherhost-0a1b2c3d.db`);
      const other = join(cdir, `${stem}-otherhost-0a1b2c3d.db`);
      for (const p of [mine, dev, other]) makeDB(p);
      age(mine, MONTH);
      age(dev, MONTH);
      age(other, MONTH);
      expect(pruneHostFiles(cdir, `${stem}.db`)).toEqual([`${stem}-otherhost-0a1b2c3d.db`]);
      expect(exists(dev)).toBe(true);
      expect(exists(mine)).toBe(true);
      // The instance's own name takes its other hosts' databases.
      expect(pruneHostFiles(cdir, `${stem}-dev.db`)).toEqual([`${stem}-dev-otherhost-0a1b2c3d.db`]);
    }
  });

  // removeUnheld takes SQLite's own exclusive lock of the database (Go
  // takes it with fcntl): a database another process holds stays, whether
  // its connection is idle or writing; one nobody holds goes with its
  // journal files.
  describe('removeUnheld', () => {
    const yes = () => true;

    for (const how of ['writing', 'idle', 'shared'] as const) {
      test(`held by a connection ${how} elsewhere`, async () => {
        const p = join(temp(), 'machine-x.db');
        // The store's holder creates its shared database; the others hold
        // one open made.
        if (how !== 'shared') makeDB(p);
        const table = how === 'shared' ? 'held_t' : 't';
        const stop = await hold(p, how);
        expect(removeUnheld(p, yes)).toBe(false);
        expect(exists(p)).toBe(true);
        await stop();
        // The holder's database is whole, and goes once released.
        const check = new DatabaseSync(p);
        expect(check.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(1);
        check.close();
        expect(removeUnheld(p, yes)).toBe(true);
        for (const s of ['', ...JOURNALS]) expect([s, exists(p + s)]).toEqual([s, false]);
      });
    }

    // still is asked once the lock is held, and told which journal files
    // the lock's connection made.
    test('still is told what the lock made', () => {
      const p = join(temp(), 'machine-x.db');
      makeDB(p);
      const asked: string[][] = [];
      expect(
        removeUnheld(p, (created) => {
          asked.push([...created]);
          return true;
        }),
      ).toBe(true);
      expect(asked).toEqual([['-wal']]);
    });

    test('unheld, with journal files a crash left', () => {
      const p = join(temp(), 'machine-x.db');
      makeDB(p);
      fs.writeFileSync(p + '-wal', 'x', { mode: 0o600 });
      fs.writeFileSync(p + '-shm', 'x', { mode: 0o600 });
      expect(removeUnheld(p, yes)).toBe(true);
      expect(fs.readdirSync(dirname(p))).toEqual([]);
    });

    // SQLite counts its own connections' locks: a database this process
    // has open, also with open rather than openShared, stays (Go's fcntl
    // lock does not conflict with its own process's).
    test('held in this process', () => {
      const p = join(temp(), 'machine-x.db');
      const db: DB = open(p, { migrations: ['CREATE TABLE t (n INTEGER)'] });
      try {
        expect(removeUnheld(p, yes)).toBe(false);
        expect(db.get<{ n: number }>('SELECT count(*) AS n FROM t')!.n).toBe(0);
      } finally {
        db.close();
      }
      expect(removeUnheld(p, yes)).toBe(true);
    });

    test('still says no once locked', () => {
      const p = join(temp(), 'machine-x.db');
      makeDB(p);
      let asked = 0;
      expect(
        removeUnheld(p, () => {
          asked++;
          return false;
        }),
      ).toBe(false);
      expect(asked).toBe(1);
      expect(exists(p)).toBe(true);
      const check = open(p);
      expect(check.get<{ n: number }>('SELECT count(*) AS n FROM t')!.n).toBe(1);
      check.close();
    });

    test('a link, something not a file, or not a database stays', () => {
      const dir = temp();
      const real = join(dir, 'real.db');
      makeDB(real);
      const link = join(dir, 'link.db');
      fs.symlinkSync(real, link);
      expect(removeUnheld(link, yes)).toBe(false);
      expect(exists(link) && exists(real)).toBe(true);
      const sub = join(dir, 'sub.db');
      fs.mkdirSync(sub);
      expect(removeUnheld(sub, yes)).toBe(false);
      const junk = join(dir, 'junk.db');
      fs.writeFileSync(junk, 'not a database, not at all, no SQLite header in here', { mode: 0o600 });
      expect(removeUnheld(junk, yes)).toBe(false);
      expect(fs.readFileSync(junk, 'utf8')).toContain('not a database');
      expect(removeUnheld(join(dir, 'missing.db'), yes)).toBe(false);
      expect(exists(join(dir, 'missing.db'))).toBe(false);
    });
  });
});

test.skipIf(process.platform !== 'win32')('nothing is removed on Windows', () => {
  const p = join(temp(), 'machine-x.db');
  makeDB(p);
  age(p, MONTH);
  expect(pruneHostFiles(dirname(p), MACHINE_DB)).toEqual([]);
  expect(exists(p)).toBe(true);
});
