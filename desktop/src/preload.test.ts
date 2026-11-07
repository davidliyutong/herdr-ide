import test from 'node:test';
import assert from 'node:assert/strict';
import type { DesktopShell } from './bridge';
import { channels } from './bridge';
import { exposed, onDisk, receive, sent } from './fakeElectron';
import './preload';

const shell = exposed.desktopShell as DesktopShell;

test('the page gets only the desktopShell bridge, with these functions', () => {
  assert.deepEqual(Object.keys(exposed), ['desktopShell']);
  assert.deepEqual(Object.keys(shell).sort(), [
    'onOpenFolder',
    'onRecordedKey',
    'onShortcut',
    'pathForFile',
    'recordShortcut',
    'setTheme',
    'shortcutsChanged',
  ]);
});

test('a dropped file has its path; other files and objects have none', () => {
  const folder = new File([], 'app');
  onDisk.set(folder, '/Users/u/Projects/app');
  assert.equal(shell.pathForFile(folder), '/Users/u/Projects/app');
  assert.equal(shell.pathForFile(new File(['x'], 'made-in-js.txt')), '');
  assert.equal(shell.pathForFile({ name: 'not a file' } as unknown as File), '');
  // Nothing goes to the main process for it.
  assert.deepEqual(sent, []);
});

test('folders opened with the app reach the page while it listens, which it tells the shell', () => {
  sent.length = 0;
  const got: string[] = [];
  const off = shell.onOpenFolder((p) => got.push(p));
  assert.deepEqual(sent, [{ channel: channels.foldersWanted, value: true }]);
  receive(channels.openFolder, '/Users/u/Projects/app');
  receive(channels.openFolder, { not: 'a path' });
  assert.deepEqual(got, ['/Users/u/Projects/app']);
  off();
  receive(channels.openFolder, '/Users/u/Projects/lib');
  assert.deepEqual(got, ['/Users/u/Projects/app']);
  assert.deepEqual(sent, [
    { channel: channels.foldersWanted, value: true },
    { channel: channels.foldersWanted, value: false },
  ]);
});
