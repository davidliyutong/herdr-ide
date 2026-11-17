import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebPreferences } from 'electron';
import {
  allowGuestPermission,
  allowPermission,
  BROWSER_PARTITION,
  guestMayNavigate,
  guestPreferences,
  isExternal,
  isInternal,
  mainWindowPreferences,
  POPUP_LIMIT,
  POPUP_WINDOW_MS,
  popupGate,
  webPreferences,
} from './policy';

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
  for (const permission of ['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fileSystem', 'local-fonts']) {
    assert.ok(allowPermission(permission, origin + '/m/local/code/', origin, origin));
    assert.equal(allowPermission(permission, 'https://example.com', origin, origin), false);
    assert.equal(allowPermission(permission, origin, 'https://example.com', origin), false);
    assert.equal(allowPermission(permission, '', origin, origin), false);
  }
  for (const permission of ['media', 'geolocation', 'clipboard-read-write', 'openExternal', 'unknown']) {
    assert.equal(allowPermission(permission, origin, origin, origin), false);
  }
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.webSecurity, true);
  // The main window only relaxes autoplay (notification sounds).
  assert.deepEqual(
    { ...mainWindowPreferences, autoplayPolicy: undefined, webviewTag: undefined },
    { ...webPreferences, autoplayPolicy: undefined, webviewTag: undefined },
  );
  // Only the main window may hold webviews.
  assert.equal(mainWindowPreferences.webviewTag, true);
  assert.equal(webPreferences.webviewTag, false);
  assert.equal(mainWindowPreferences.autoplayPolicy, 'no-user-gesture-required');
  assert.equal('autoplayPolicy' in webPreferences, false);
});

test('a webview attaches only for the browser partition and an http(s) address without credentials', () => {
  const ok = { partition: BROWSER_PARTITION, src: 'https://example.com/a' };
  assert.ok(guestPreferences({}, ok));
  assert.ok(guestPreferences({}, { ...ok, src: 'http://localhost:3000' }));
  const refused: Array<Record<string, string>> = [
    { ...ok, partition: 'persist:other' },
    { ...ok, partition: '' },
    { src: ok.src },
    { ...ok, src: 'file:///etc/passwd' },
    { ...ok, src: 'javascript:alert(1)' },
    { ...ok, src: 'data:text/html,x' },
    { ...ok, src: 'https://user:pw@example.com/' },
    { ...ok, src: 'not a url' },
    { partition: ok.partition },
  ];
  for (const params of refused) {
    const prefs: WebPreferences = { nodeIntegration: true };
    assert.equal(guestPreferences(prefs, params), false, JSON.stringify(params));
    assert.equal(prefs.nodeIntegration, true, 'a refused attach leaves the preferences alone');
  }
});

test('an allowed attach resets every dangerous preference of the guest', () => {
  const prefs = {
    nodeIntegration: true,
    nodeIntegrationInSubFrames: true,
    nodeIntegrationInWorker: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    allowRunningInsecureContent: true,
    webviewTag: true,
    plugins: true,
    experimentalFeatures: true,
    preload: '/tmp/evil.js',
    preloadURL: 'file:///tmp/evil.js',
    partition: 'default',
  };
  assert.ok(guestPreferences(prefs as WebPreferences, { partition: BROWSER_PARTITION, src: 'https://example.com' }));
  assert.deepEqual(prefs, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    plugins: false,
    experimentalFeatures: false,
    partition: BROWSER_PARTITION,
  });
});

test('a guest navigates to http(s) addresses without credentials only', () => {
  assert.ok(guestMayNavigate('https://example.com/x?y#z'));
  assert.ok(guestMayNavigate('http://127.0.0.1:8080/'));
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,x',
    'about:blank',
    'ssh://host',
    'https://u:p@example.com/',
    '',
    'x',
  ]) {
    assert.equal(guestMayNavigate(url), false, url);
  }
});

test('a guest gets no permission but full screen', () => {
  for (const permission of [
    'media',
    'geolocation',
    'notifications',
    'clipboard-read',
    'clipboard-sanitized-write',
    'midi',
    'pointerLock',
    'openExternal',
    'fileSystem',
    'hid',
    'serial',
    'usb',
    'unknown',
  ]) {
    assert.equal(allowGuestPermission(permission), false, permission);
  }
  assert.equal(allowGuestPermission('fullscreen'), true);
});

test('a guest opens a few popups at a time, and more once time has passed', () => {
  let at = 1_000;
  const may = popupGate(() => at);
  for (let i = 0; i < POPUP_LIMIT; i++) assert.equal(may(), true, `popup ${i + 1}`);
  // A script that keeps asking gets none, and its refused tries do not
  // push the next allowed one further away.
  for (let i = 0; i < 50; i++) assert.equal(may(), false);
  at += POPUP_WINDOW_MS - 1;
  assert.equal(may(), false);
  at += 1;
  assert.equal(may(), true);
  // Each guest has a gate of its own.
  assert.equal(popupGate(() => at)(), true);
});
