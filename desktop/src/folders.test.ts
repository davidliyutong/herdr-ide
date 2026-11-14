import test from 'node:test';
import assert from 'node:assert/strict';
import type { OpenedFolders } from '../../web/src/shell';
import { FolderQueue } from './folders';

const opened = (...folders: string[]): OpenedFolders => ({ folders, skipped: 0 });

test('folders opened before the page takes them wait for it, in order', () => {
  const queue = new FolderQueue();
  queue.add(opened('/Users/u/app'));
  queue.add({ folders: ['/Users/u/lib'], skipped: 2 });
  const got: OpenedFolders[] = [];
  queue.takenBy((o) => got.push(o));
  assert.deepEqual(got, [opened('/Users/u/app'), { folders: ['/Users/u/lib'], skipped: 2 }]);
  queue.add(opened('/Users/u/web'));
  assert.deepEqual(got.at(-1), opened('/Users/u/web'));
});

test('folders opened while the page reloads go to the next page', () => {
  const queue = new FolderQueue();
  const first: OpenedFolders[] = [];
  queue.takenBy((o) => first.push(o));
  queue.takenBy(undefined);
  queue.add(opened('/Users/u/app'));
  assert.deepEqual(first, []);
  const next: OpenedFolders[] = [];
  queue.takenBy((o) => next.push(o));
  assert.deepEqual(next, [opened('/Users/u/app')]);
  // Each request is delivered once.
  queue.takenBy((o) => next.push(o));
  assert.deepEqual(next, [opened('/Users/u/app')]);
});
