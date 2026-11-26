// The history in the hub's database (the Go hub's history_test.go): the
// rows Go writes, a save before the history was read back, the merge of
// what memory recorded meanwhile, rows gone, tables of a newer version.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { discard } from '#shared/lib/log.ts';
import { openShared } from '#shared/store/index.ts';
import { extended } from '#shared/testdata/extended.ts';
import { History, type Kept } from './history.ts';
import { hubDBFile, keptJSON, Store } from './store.ts';
import { WorkerStore } from './store-worker.ts';
import { acc, removeTempDirs, T0, tempDir, testUsage, win } from './testing.ts';

afterAll(removeTempDirs);

/** The history the tests start from: an account, its points and an alert. */
function seed(dir: string): void {
  const h = new History();
  h.windows.set(
    'claude:acc-1',
    new Map([
      [
        'weekly|',
        [
          [1799996400, 10],
          [1800000000, 15],
        ],
      ],
    ]),
  );
  h.alerts.set('claude:acc-1|weekly||604800|80', { end: 1800259200 });
  new Store(dbOf(dir), discard).writeHistory(h, [seedAccount()]);
}

const seedAccount = (): Kept => ({
  key: 'claude:acc-1',
  account: acc({ provider: 'claude', id: 'acc-1', status: 'ok', windows: [win('weekly', 15, 1800259200, 604800)] }),
  machines: ['local'],
  fetchedAt: T0,
  seenAt: T0,
  notBefore: 0,
});

extended('a blocked usage transaction leaves the hub thread free to release the writer', async () => {
  const dir = tempDir();
  seed(dir);
  const file = dbOf(dir);
  const store = new WorkerStore(file, discard);
  const db = openShared(file);
  try {
    const loaded = await store.readHistory();
    expect(loaded?.stored.accounts).toHaveLength(1);
    const history = loaded!.stored.history;
    history.windows.set('claude:acc-2', new Map([['session|', [[1800000000, 5]]]]));
    db.exec('BEGIN IMMEDIATE');
    const saving = store.writeHistory(history, loaded!.stored.accounts);
    await Bun.sleep(100);
    db.exec('COMMIT');
    await saving;
    expect((await store.readHistory())?.stored.history.windows.get('claude:acc-2')?.get('session|')).toEqual([[1800000000, 5]]);
  } finally {
    db.close();
    await store.close();
  }
});

const dbOf = (dir: string) => hubDBFile(join(dir, 'settings-dev.json'));

/** The rows of the history's tables in dir's hub database. */
function rowsIn(dir: string): [number, number, number] {
  const db = openShared(dbOf(dir));
  try {
    const n = (t: string) => Number(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n);
    return [n('usage_windows'), n('usage_accounts'), n('usage_alerts')];
  } finally {
    db.close();
  }
}

// An account is kept as the Go hub keeps it, so either reads the other's.
test('the rows are Go’s', () => {
  expect(JSON.stringify(keptJSON(seedAccount()))).toBe(
    '{"provider":"claude","id":"acc-1","status":"ok","windows":[{"kind":"weekly","usedPct":15,"resetsAt":1800259200,"windowSec":604800,"id":""}],' +
      '"key":"claude:acc-1","machines":["local"],"fetchedAt":1800000000,"seenAt":1800000000}',
  );
  expect(hubDBFile('')).toBe('');
  expect(hubDBFile('/x/settings-dev.json').replaceAll('\\', '/')).toMatch(/^\/x\/hub-dev-.+\.db$/);
});

// A save before the history was read back (the read failed) does not
// remove what it did not read: it reads it first, and writes nothing while
// it cannot; once read, what was recorded meanwhile joins it.
test('a save after a failed read', async () => {
  const dir = tempDir();
  seed(dir);
  const file = dbOf(dir);
  // The database cannot be opened: a directory takes its name.
  renameSync(file, file + '.away');
  rmSync(file + '-wal', { force: true });
  rmSync(file + '-shm', { force: true });
  mkdirSync(file, { mode: 0o700 });
  const q = testUsage({ dir, ready: [] });
  await q.u.loadHistory();
  q.u.history.windows.set('claude:acc-2', new Map([['session|', [[1800000100, 5]]]]));
  await q.u.save(); // cannot read: writes nothing
  rmSync(file, { recursive: true });
  renameSync(file + '.away', file);
  expect(rowsIn(dir)).toEqual([1, 1, 1]);
  await q.u.save();
  expect(rowsIn(dir)).toEqual([2, 1, 1]);
  expect([q.u.history.windows.get('claude:acc-1')?.get('weekly|')?.length, q.snap().accounts.length]).toEqual([2, 1]);
});

// What memory recorded before the read joins what was kept: a window's
// earlier points come first, alerts fired meanwhile stay.
test('merge', () => {
  const h = new History();
  h.windows.set(
    'a',
    new Map([
      [
        'w',
        [
          [30, 3],
          [40, 4],
        ],
      ],
    ]),
  );
  h.alerts.set('k1', { end: 9 });
  const s = new History();
  s.windows.set(
    'a',
    new Map([
      [
        'w',
        [
          [10, 1],
          [20, 2],
          [30, 2],
        ],
      ],
      ['v', [[5, 1]]],
    ]),
  );
  s.windows.set('b', new Map([['w', [[1, 1]]]]));
  s.alerts.set('k1', { end: 1 });
  s.alerts.set('k2', { end: 2 });
  h.merge(s);
  expect(h.windows.get('a')!.get('w')).toEqual([
    [10, 1],
    [20, 2],
    [30, 3],
    [40, 4],
  ]);
  expect([h.windows.get('a')!.get('v')?.length, h.windows.get('b')!.get('w')?.length]).toEqual([1, 1]);
  expect([h.alerts.get('k1')!.end, h.alerts.get('k2')!.end]).toEqual([9, 2]);
});

// A save writes what changed and removes what memory no longer has.
test('a save removes what is gone', async () => {
  const dir = tempDir();
  seed(dir);
  const p = testUsage({ dir, ready: [] });
  await p.u.loadHistory();
  p.u.history.windows.set('claude:acc-2', new Map([['session|', [[1800000000, 5]]]]));
  p.u.accounts.clear();
  p.u.history.alerts.clear();
  await p.u.save();
  expect(rowsIn(dir)).toEqual([2, 0, 0]);
  const q = testUsage({ dir, ready: [] });
  await q.u.loadHistory();
  expect(q.u.history.windows.get('claude:acc-2')?.get('session|')).toEqual([[1800000000, 5]]);
});

// Tables of a newer version are read, not written.
test('a newer version', async () => {
  const dir = tempDir();
  seed(dir);
  const db = openShared(dbOf(dir));
  db.run("UPDATE store_features SET version = version + 1 WHERE feature = 'usage'");
  db.close();
  const q = testUsage({ dir, ready: [] });
  await q.u.loadHistory();
  expect(q.snap().accounts).toHaveLength(1);
  q.u.accounts.clear();
  await q.u.save();
  expect(rowsIn(dir)[1]).toBe(1);
});
