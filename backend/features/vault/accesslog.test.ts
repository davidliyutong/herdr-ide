import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessLog, coreDBBeside, noisy, released, type Access } from './accesslog.ts';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const dbOf = () => {
  const d = mkdtempSync(join(tmpdir(), 'tw-vault-'));
  dirs.push(d);
  return coreDBBeside(join(d, 'vault-dev.json'));
};
const rec = (result: string, names = ['A']): Omit<Access, 'id'> => ({
  time: new Date().toISOString(),
  m: 'm1',
  tool: 'get',
  names,
  result,
});
const add = (l: AccessLog, r: Omit<Access, 'id'>) => l.add(r, noisy(r.result), released(r.result));

test("the core's database beside the vault's file, per host", () => {
  expect(coreDBBeside('/c/vault-dev.json')).toMatch(/^\/c\/core-dev-.+\.db$/);
  expect(coreDBBeside('')).toBe('');
});

test('records survive a restart; releases are never merged, repeated refusals are', () => {
  const db = dbOf();
  const l = new AccessLog({ db, logger: () => {} });
  add(l, rec('allowed'));
  add(l, rec('allowed'));
  add(l, rec('not_found'));
  add(l, rec('not_found'));
  add(l, rec('not_found', ['B']));
  expect(l.list().map((a) => [a.result, a.count ?? 1])).toEqual([
    ['not_found', 1],
    ['not_found', 2],
    ['allowed', 1],
    ['allowed', 1],
  ]);
  l.close();
  const again = new AccessLog({ db, logger: () => {} });
  expect(again.list().map((a) => [a.id, a.result, a.count ?? 1])).toEqual([
    [4, 'not_found', 1],
    [3, 'not_found', 2],
    [2, 'allowed', 1],
    [1, 'allowed', 1],
  ]);
  again.close();
});

test('releases and the others are bounded apart', () => {
  const l = new AccessLog({ db: dbOf(), logger: () => {}, maxReleases: 2, maxOthers: 1 });
  for (const r of ['allowed', 'denied', 'approved', 'denied', 'exempted']) add(l, rec(r, [r]));
  expect(l.list().map((a) => a.result)).toEqual(['exempted', 'denied', 'approved']);
  l.close();
});

test('a log that cannot be read keeps its records in memory and tries again', () => {
  const logs: string[] = [];
  const l = new AccessLog({ db: '/nonexistent\0/core.db', logger: (m) => logs.push(m) });
  expect(add(l, rec('allowed')).ok).toBe(false);
  expect(l.list()[0].result).toBe('log_failed');
  expect(add(l, rec('listed')).ok).toBe(true);
  expect(logs.length).toBeGreaterThan(0);
});
