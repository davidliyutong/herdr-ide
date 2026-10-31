import assert from 'node:assert/strict';
import test from 'node:test';
import { allowPermission, isExternal, isInternal, webPreferences } from './policy';

const origin = 'http://127.0.0.1:7781';
test('only the exact core origin may navigate or open native windows', () => {
  for (const path of ['/', '/m/local/gui/1', '/m/local/code/?folder=/tmp']) assert.ok(isInternal(origin + path, origin));
  for (const url of [
    'http://127.0.0.1:7780',
    'http://localhost:7781',
    `${origin}.evil.test`,
    'https://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,test',
    'about:blank',
    'http://user@127.0.0.1:7781',
    'invalid',
  ]) {
    assert.equal(isInternal(url, origin), false, url);
  }
});

test('OS external opens accept only credential-free HTTP(S)', () => {
  assert.ok(isExternal('https://example.com/path?q=1'));
  assert.ok(isExternal('http://localhost:3000'));
  for (const url of [
    'file:///tmp/run.sh',
    'javascript:alert(1)',
    'mailto:a@b.com',
    'vscode://file/a',
    'https://user:pass@example.com',
    'not a URL',
  ])
    assert.equal(isExternal(url), false, url);
});

test('permissions require both the requesting frame and top window to belong to the core', () => {
  for (const permission of ['notifications', 'clipboard-sanitized-write']) {
    assert.ok(allowPermission(permission, origin + '/m/local/code/', origin, origin));
    assert.equal(allowPermission(permission, 'https://example.com', origin, origin), false);
    assert.equal(allowPermission(permission, origin, 'https://example.com', origin), false);
    assert.equal(allowPermission(permission, '', origin, origin), false);
  }
  for (const permission of ['media', 'geolocation', 'clipboard-read', 'clipboard-read-write', 'openExternal', 'unknown']) {
    assert.equal(allowPermission(permission, origin, origin, origin), false);
  }
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.webSecurity, true);
});
