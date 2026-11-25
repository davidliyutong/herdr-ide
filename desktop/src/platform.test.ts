import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP_DOMAIN } from '../../web/src/brand';
import { APP_ID, coreResources, reverseDomain, foldersOf, keyPlatform, quitsWithLastWindow } from './platform';

test('the keybindings, the last window and the app id by platform', () => {
  assert.equal(keyPlatform('darwin'), 'mac');
  assert.equal(keyPlatform('win32'), 'windows');
  assert.equal(keyPlatform('linux'), 'linux');
  assert.equal(quitsWithLastWindow('darwin'), false);
  assert.equal(quitsWithLastWindow('win32'), true);
  assert.equal(quitsWithLastWindow('linux'), true);
  // The domain reversed, label by label.
  assert.equal(reverseDomain('example.app'), 'app.example');
  assert.equal(reverseDomain('a.example.org'), 'org.example.a');
  assert.equal(APP_ID, `${reverseDomain(APP_DOMAIN)}.desktop`);
});

test("the core's payloads are the app's resources, or scripts/build.sh's and the web UI's build in development", () => {
  assert.deepEqual(coreResources('/App/Resources', '/repo'), {
    payload: join('/App/Resources', 'payload'),
    web: join('/App/Resources', 'web'),
  });
  assert.deepEqual(coreResources(undefined, '/repo'), { payload: join('/repo', 'dist', 'payload'), web: join('/repo', 'web', 'dist') });
});

test(
  'a command line names folders as paths or file: URLs; switches and leading arguments are not items',
  { skip: process.platform === 'win32' && 'POSIX paths: Linux only' },
  () => {
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
  },
);
