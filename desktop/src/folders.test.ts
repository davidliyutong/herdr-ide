import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenedFolders } from './folders';

test('folders opened before the page takes them wait for it, in order', () => {
  const folders = new OpenedFolders();
  folders.add('/Users/u/app');
  folders.add('/Users/u/lib');
  const got: string[] = [];
  folders.takenBy((p) => got.push(p));
  assert.deepEqual(got, ['/Users/u/app', '/Users/u/lib']);
  folders.add('/Users/u/web');
  assert.deepEqual(got, ['/Users/u/app', '/Users/u/lib', '/Users/u/web']);
});

test('folders opened while the page reloads go to the next page', () => {
  const folders = new OpenedFolders();
  const first: string[] = [];
  folders.takenBy((p) => first.push(p));
  folders.takenBy(undefined);
  folders.add('/Users/u/app');
  assert.deepEqual(first, []);
  const next: string[] = [];
  folders.takenBy((p) => next.push(p));
  assert.deepEqual(next, ['/Users/u/app']);
  // Each folder is delivered once.
  folders.takenBy((p) => next.push(p));
  assert.deepEqual(next, ['/Users/u/app']);
});
