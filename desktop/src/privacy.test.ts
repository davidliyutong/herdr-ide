import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_SLUG } from '../../web/src/brand';
import { bundleOf, FULL_DISK_ACCESS_URL, privacyActions, reopenCommand, terminalCoreExecutable, type PrivacyOptions } from './privacy';

const exe = `/Users/u/.${APP_SLUG}-desktop/hc/herdr-core`;
const app = `/Applications/${APP_SLUG}.app`;

/** The privacy actions of a platform, with every effect recorded. */
function actions(over: Partial<PrivacyOptions> = {}, exists = true) {
  const done: string[] = [];
  const a = privacyActions(
    {
      platform: 'darwin',
      executable: exe,
      bundle: app,
      pid: 4242,
      dev: false,
      ...over,
    },
    {
      openExternal: (url) => done.push(`openExternal ${url}`),
      showItemInFolder: (path) => done.push(`showItemInFolder ${path}`),
      exists: () => exists,
      spawnDetached: (file, args) => done.push(`spawn ${file} ${args.join(' ')}`),
      relaunch: () => done.push('relaunch'),
      quit: () => done.push('quit'),
    },
  );
  return { a, done };
}

test('System Settings opens at Full Disk Access, the only URL, on macOS only', () => {
  assert.equal(FULL_DISK_ACCESS_URL, 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  const { a, done } = actions();
  a.openFullDiskAccess();
  assert.deepEqual(done, [`openExternal ${FULL_DISK_ACCESS_URL}`]);
  for (const platform of ['win32', 'linux'] as const) {
    const other = actions({ platform });
    other.a.openFullDiskAccess();
    other.a.revealTerminalCore();
    other.a.relaunch();
    assert.deepEqual(other.done, [], platform);
  }
});

test("Finder shows the instance's terminal core executable, when it is installed", () => {
  assert.equal(terminalCoreExecutable('/Users/u', 'desktop'), exe);
  assert.equal(terminalCoreExecutable('/Users/u', 'fda'), `/Users/u/.${APP_SLUG}-fda/hc/herdr-core`);
  assert.equal(terminalCoreExecutable('/Users/u', ''), `/Users/u/.${APP_SLUG}/hc/herdr-core`);
  const { a, done } = actions();
  a.revealTerminalCore();
  assert.deepEqual(done, [`showItemInFolder ${exe}`]);
  const missing = actions({}, false);
  missing.a.revealTerminalCore();
  assert.deepEqual(missing.done, []);
});

test('the packaged app reopens through Launch Services after it quit, development through Electron', () => {
  assert.equal(bundleOf(`${app}/Contents/MacOS/${APP_SLUG}`), app);
  for (const path of ['/usr/local/bin/electron', '/Applications/x/Contents/MacOS/x', '/a.app/Contents/Resources/x'])
    assert.equal(bundleOf(path), '', path);
  const [file, args] = reopenCommand(4242, app);
  assert.equal(file, '/bin/sh');
  assert.deepEqual(args.slice(2), ['sh', '4242', app]);
  // It waits for the pid at most 300 × 0.2 s, and opens a new instance only
  // once that pid is gone.
  assert.match(args[1], /\$i -lt 300/);
  assert.match(args[1], /\|\| exec \/usr\/bin\/open -n "\$2"$/);

  const packaged = actions();
  packaged.a.relaunch();
  assert.deepEqual(packaged.done, [`spawn /bin/sh ${args.join(' ')}`, 'quit']);
  for (const over of [{ dev: true }, { bundle: '' }]) {
    const dev = actions(over);
    dev.a.relaunch();
    assert.deepEqual(dev.done, ['relaunch', 'quit']);
  }
});

test('a smoke test sees what would open, and nothing opens or quits', () => {
  const lines: string[] = [];
  const { a, done } = actions({ dev: true, log: (line) => lines.push(line) });
  a.openFullDiskAccess();
  a.revealTerminalCore();
  a.relaunch();
  assert.deepEqual(done, []);
  assert.deepEqual(lines, [`open ${FULL_DISK_ACCESS_URL}`, `reveal ${exe}`, 'relaunch']);
});
