import test from 'node:test';
import assert from 'node:assert/strict';
import type { DesktopShell, OpenedFolders } from '../../web/src/shell';
import { channels } from './bridge';
import { exposed, onDisk, receive, sent } from './fakeElectron';
import './preload';

const shell = exposed.desktopShell as DesktopShell;

test('the page gets only the desktopShell bridge, with these functions', () => {
  assert.deepEqual(Object.keys(exposed), ['desktopShell']);
  assert.deepEqual(Object.keys(shell).sort(), ['onCommand', 'onOpenFolders', 'pathForFile', 'setDisabledCommands']);
});

test('the menu sends the page commands, strings only, while it listens', () => {
  const got: string[] = [];
  const off = shell.onCommand((c) => got.push(c));
  receive(channels.command, 'tab.new');
  receive(channels.command, { command: 'tab.new' });
  off();
  receive(channels.command, 'pane.close');
  assert.deepEqual(got, ['tab.new']);
  assert.deepEqual(sent, []);
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
  const got: OpenedFolders[] = [];
  const off = shell.onOpenFolders((o) => got.push(o));
  assert.deepEqual(sent, [{ channel: channels.foldersWanted, value: true }]);
  receive(channels.openFolders, { folders: ['/Users/u/Projects/app'], skipped: 1 });
  for (const bad of ['/Users/u/x', { folders: [1], skipped: 0 }, { folders: [], skipped: -1 }, { folders: ['/a'] }, null])
    receive(channels.openFolders, bad);
  assert.deepEqual(got, [{ folders: ['/Users/u/Projects/app'], skipped: 1 }]);
  off();
  receive(channels.openFolders, { folders: ['/Users/u/Projects/lib'], skipped: 0 });
  assert.equal(got.length, 1);
  assert.deepEqual(sent, [
    { channel: channels.foldersWanted, value: true },
    { channel: channels.foldersWanted, value: false },
  ]);
});

test('the page tells the shell which commands to disable, as strings', () => {
  sent.length = 0;
  shell.setDisabledCommands(['tab.close', 7 as unknown as string, 'pane.zoom']);
  shell.setDisabledCommands('tab.close' as unknown as string[]);
  assert.deepEqual(sent, [{ channel: channels.menuState, value: ['tab.close', 'pane.zoom'] }]);
});
