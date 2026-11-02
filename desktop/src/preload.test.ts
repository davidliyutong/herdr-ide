import test from 'node:test';
import assert from 'node:assert/strict';
import type { DesktopShell } from './bridge';
import { exposed, onDisk, sent } from './fakeElectron';
import './preload';

const shell = exposed.desktopShell as DesktopShell;

test('the page gets only the desktopShell bridge, with these functions', () => {
  assert.deepEqual(Object.keys(exposed), ['desktopShell']);
  assert.deepEqual(Object.keys(shell).sort(), [
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
