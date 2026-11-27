import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampWindowBounds,
  DETACHED_COMMANDS,
  DETACHED_DEFAULT_HEIGHT,
  DETACHED_DEFAULT_WIDTH,
  DETACHED_MIN_HEIGHT,
  DETACHED_MIN_WIDTH,
  detachedWindowUrl,
  menuDisabledFor,
  nextQuitTarget,
  parseOpenTabRequest,
  pointInBounds,
  type QuitWindow,
} from './detached';
import { menuCommands } from './menu';

test('validates and clamps open-tab requests while rejecting malformed inputs', () => {
  assert.equal(parseOpenTabRequest(null), undefined);
  assert.equal(parseOpenTabRequest({ m: '', pane: 't1' }), undefined);
  assert.equal(parseOpenTabRequest({ m: 'local', pane: 'bad pane' }), undefined);
  assert.equal(parseOpenTabRequest({ m: 'local?x=1', pane: 't1' }), undefined);
  assert.deepEqual(parseOpenTabRequest({ m: 'local', pane: 'view:abc-123' }), { m: 'local', pane: 'view:abc-123' });
  assert.deepEqual(
    parseOpenTabRequest({
      m: 'ssh-1',
      pane: 'code:c1',
      x: 120.4,
      y: -50.6,
      width: 100,
      height: 9999,
      title: '  README.md  ',
    }),
    {
      m: 'ssh-1',
      pane: 'code:c1',
      x: 120,
      y: -51,
      width: DETACHED_MIN_WIDTH,
      height: 2160,
      title: 'README.md',
    },
  );
});

test('builds encoded app-origin URLs', () => {
  assert.equal(detachedWindowUrl('https://app.localhost', 'm/1', 'view:a:b'), 'https://app.localhost/window/tab?m=m%2F1&pane=view%3Aa%3Ab');
});

test('clamps window bounds to the display workArea including secondary monitors', () => {
  const workArea = { x: -1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(clampWindowBounds({}, workArea), {
    x: -1920 + Math.round((1920 - DETACHED_DEFAULT_WIDTH) / 2),
    y: Math.round((1080 - DETACHED_DEFAULT_HEIGHT) / 2),
    width: DETACHED_DEFAULT_WIDTH,
    height: DETACHED_DEFAULT_HEIGHT,
  });
  assert.deepEqual(clampWindowBounds({ x: -2500, y: 2000, width: 800, height: 600 }, workArea), {
    x: -1920,
    y: 480,
    width: 800,
    height: 600,
  });
  assert.deepEqual(clampWindowBounds({ width: 200, height: 100 }, { x: 0, y: 0, width: 500, height: 400 }), {
    x: 40,
    y: 50,
    width: DETACHED_MIN_WIDTH,
    height: DETACHED_MIN_HEIGHT,
  });
});

test('checks whether a screen point lies inside window bounds', () => {
  const bounds = { x: 100, y: 50, width: 800, height: 600 };
  assert.equal(pointInBounds(100, 50, bounds), true);
  assert.equal(pointInBounds(900, 650, bounds), true);
  assert.equal(pointInBounds(99, 50, bounds), false);
  assert.equal(pointInBounds(901, 50, bounds), false);
  assert.equal(pointInBounds(500, 651, bounds), false);
});

test('computes native menu disabled commands for detached windows independently of main window state', () => {
  const all = menuCommands();
  const mainDisabled = new Set(['pane.close', 'tab.close', 'pane.splitRight', 'find.open', 'workspace.close']);
  assert.deepEqual(menuDisabledFor(all, mainDisabled, false), mainDisabled);

  const detDisabled = menuDisabledFor(all, mainDisabled, true);
  // Detached-supported commands stay enabled even when mainWindow disabled them (e.g. all tabs detached).
  for (const cmd of ['tab.close', ...DETACHED_COMMANDS]) {
    assert.equal(detDisabled.has(cmd), false, cmd);
  }
  // Main-only commands are disabled while a detached window has focus.
  for (const cmd of ['tab.new', 'tab.rename', 'tab.next', 'workspace.new', 'workspace.close', 'view.toggleSidebar', 'view.togglePanel']) {
    assert.equal(detDisabled.has(cmd), true, cmd);
  }
  // App-level Settings/Shortcuts remain reachable unless disabled by the main window.
  assert.equal(detDisabled.has('app.settings'), false);
  assert.equal(detDisabled.has('app.keyboardShortcuts'), false);
  assert.equal(menuDisabledFor(all, new Set(['app.settings']), true).has('app.settings'), true);
});

test('selects dirty windows before clean windows when quitting sequentially', () => {
  const mainClean: QuitWindow<string> = { window: 'main', kind: 'main', unsaved: false };
  const mainDirty: QuitWindow<string> = { window: 'main', kind: 'main', unsaved: true };
  const detClean: QuitWindow<string> = { window: 'd1', kind: 'detached', unsaved: false };
  const detDirty: QuitWindow<string> = { window: 'd2', kind: 'detached', unsaved: true };

  // Dirty detached is prompted before clean main and clean detached.
  assert.equal(nextQuitTarget([mainClean, detClean, detDirty])?.window, 'd2');
  // Dirty main is prompted before clean detached.
  assert.equal(nextQuitTarget([detClean, mainDirty])?.window, 'main');
  // Dirty detached before dirty main.
  assert.equal(nextQuitTarget([mainDirty, detDirty])?.window, 'd2');
  // Once all dirty windows are gone, clean detached closes before clean main.
  assert.equal(nextQuitTarget([mainClean, detClean])?.window, 'd1');
  assert.equal(nextQuitTarget([mainClean])?.window, 'main');
  assert.equal(nextQuitTarget([]), undefined);
});
