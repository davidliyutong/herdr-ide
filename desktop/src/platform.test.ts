import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP_SLUG } from '../../web/src/brand';
import { APP_ID, coreBinary, foldersOf, keyPlatform, quitsWithLastWindow } from './platform';

test('the keybindings, the last window and the app id by platform', () => {
  assert.equal(keyPlatform('darwin'), 'mac');
  assert.equal(keyPlatform('win32'), 'pc');
  assert.equal(keyPlatform('linux'), 'pc');
  assert.equal(quitsWithLastWindow('darwin'), false);
  assert.equal(quitsWithLastWindow('win32'), true);
  assert.equal(quitsWithLastWindow('linux'), true);
  assert.equal(APP_ID, `dev.${APP_SLUG}.desktop`);
});

test("the core is the app's resource, or scripts/build.sh's in development", () => {
  assert.equal(coreBinary('darwin', 'arm64', '/App/Resources', '/repo'), join('/App/Resources', 'bin', APP_SLUG));
  assert.equal(coreBinary('win32', 'x64', 'C:/App/resources', '/repo'), join('C:/App/resources', 'bin', `${APP_SLUG}.exe`));
  assert.equal(coreBinary('linux', 'x64', undefined, '/repo'), join('/repo', 'dist', `${APP_SLUG}-linux-amd64`));
  assert.equal(coreBinary('win32', 'x64', undefined, '/repo'), join('/repo', 'dist', `${APP_SLUG}-windows-amd64.exe`));
  assert.equal(coreBinary('darwin', 'arm64', undefined, '/repo'), join('/repo', 'dist', `${APP_SLUG}-darwin-arm64`));
});

test('a command line names folders as paths or file: URLs; switches and leading arguments are not items', () => {
  const dirs = new Set(['/home/u/app', '/home/u/my dir', '/work/x']);
  const isDir = (p: string) => dirs.has(p);
  assert.deepEqual(
    foldersOf(['/opt/app/app', '/home/u/app', '--original-process-start-time=1', 'file:///home/u/my%20dir'], 1, '/', isDir),
    {
      folders: ['/home/u/app', '/home/u/my dir'],
      skipped: 0,
    },
  );
  // Relative to the launch's directory; files and missing paths are counted.
  assert.deepEqual(foldersOf(['electron', '.', 'x', 'notes.txt', ''], 2, '/work', isDir), { folders: ['/work/x'], skipped: 1 });
  assert.deepEqual(foldersOf(['/opt/app/app'], 1, '/', isDir), { folders: [], skipped: 0 });
  assert.deepEqual(foldersOf(['/opt/app/app', 'file://host/x'], 1, '/', isDir), { folders: [], skipped: 1 });
});
