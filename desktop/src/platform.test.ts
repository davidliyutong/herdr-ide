import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP_DOMAIN, APP_SLUG } from '../../web/src/brand';
import { APP_ID, hubResources, reverseDomain, foldersOf, keyPlatform, quitsWithLastWindow } from './platform';

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

test("the hub executable and Stage 1 machine archives are in the app's bundle, or dist/ in development", () => {
  assert.deepEqual(hubResources('/App/Contents/Resources', '/repo', 'darwin', 'arm64'), {
    hub: join('/App/Contents/Resources', '..', 'Helpers', APP_SLUG),
    machines: join('/App/Contents/Resources', 'machines'),
  });
  assert.deepEqual(hubResources('/opt/app/resources', '/repo', 'linux', 'x64'), {
    hub: join('/opt/app/resources', 'bin', APP_SLUG),
    machines: join('/opt/app/resources', 'machines'),
  });
  assert.deepEqual(hubResources('C:\\App\\resources', 'C:\\repo', 'win32', 'x64'), {
    hub: join('C:\\App\\resources', 'bin', `${APP_SLUG}.exe`),
    machines: join('C:\\App\\resources', 'machines'),
  });
  assert.deepEqual(hubResources(undefined, '/repo', 'darwin', 'arm64'), {
    hub: join('/repo', 'dist', `${APP_SLUG}-darwin-arm64`),
    machines: join('/repo', 'dist', 'release'),
  });
  assert.deepEqual(hubResources(undefined, '/repo', 'win32', 'x64'), {
    hub: join('/repo', 'dist', `${APP_SLUG}-windows-amd64.exe`),
    machines: join('/repo', 'dist', 'release'),
  });
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
