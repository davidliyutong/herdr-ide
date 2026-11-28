import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebPreferences } from 'electron';
import { APP_HOST, APP_ORIGIN } from './origin';
import {
  allowGuestPermission,
  allowPermission,
  APP_PARTITION,
  appWindowPreferences,
  BROWSER_PARTITION,
  detachedWindowPreferences,
  guestMayNavigate,
  guestPreferences,
  hostResolver,
  isExternal,
  isInternal,
  mainWindowPreferences,
  POPUP_LIMIT,
  POPUP_WINDOW_MS,
  popupGate,
  webPreferences,
} from './policy';

const origin = APP_ORIGIN;
test('only the exact app origin may navigate or open native windows', () => {
  for (const path of ['/', '/m/local/gui/1', '/m/local/code/?folder=/tmp']) assert.ok(isInternal(origin + path, origin));
  for (const url of [
    `http://${APP_HOST}`,
    `https://${APP_HOST}:8443`,
    'http://127.0.0.1:7780',
    `${origin}.evil.test`,
    'https://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,test',
    'about:blank',
    `https://user@${APP_HOST}`,
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

test('permissions require both the requesting frame and top window to belong to the hub', () => {
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
  // The app's windows: its session, its preload in each frame (sandboxed,
  // no Node); the main window only relaxes autoplay (notification sounds).
  const app = appWindowPreferences('/app/frames.cjs');
  assert.deepEqual(app, { ...webPreferences, nodeIntegrationInSubFrames: true, partition: APP_PARTITION, preload: '/app/frames.cjs' });
  assert.equal(app.sandbox, true);
  assert.equal(app.nodeIntegration, false);
  const main = mainWindowPreferences('/app/preload.cjs');
  assert.deepEqual(
    { ...main, autoplayPolicy: undefined, webviewTag: undefined },
    { ...appWindowPreferences('/app/preload.cjs'), autoplayPolicy: undefined, webviewTag: undefined },
  );
  // Main and detached windows may hold webviews; only main relaxes autoplay.
  assert.equal(main.webviewTag, true);
  assert.equal(webPreferences.webviewTag, false);
  assert.equal(main.autoplayPolicy, 'no-user-gesture-required');
  assert.equal('autoplayPolicy' in webPreferences, false);
  const det = detachedWindowPreferences('/app/preload.cjs');
  assert.deepEqual(det, { ...appWindowPreferences('/app/preload.cjs'), webviewTag: true });
  assert.equal('autoplayPolicy' in det, false);
  assert.notEqual(APP_PARTITION, BROWSER_PARTITION);
});

test('a webview attaches only for the browser partition and an http(s) address without credentials that is not the hub’s', () => {
  const ok = { partition: BROWSER_PARTITION, src: 'https://example.com/a' };
  assert.ok(guestPreferences({}, ok, origin));
  assert.ok(guestPreferences({}, { ...ok, src: 'http://localhost:3000' }, origin));
  const refused: Array<Record<string, string>> = [
    // The app's own host, under any scheme and port.
    { ...ok, src: `${origin}/` },
    { ...ok, src: `http://${APP_HOST}/m/local/code/` },
    { ...ok, src: `https://${APP_HOST.toUpperCase()}:8443/` },
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
    assert.equal(guestPreferences(prefs, params, origin), false, JSON.stringify(params));
    assert.equal(prefs.nodeIntegration, true, 'a refused attach leaves the preferences alone');
  }
  // Without the hub's origin nothing attaches.
  assert.equal(guestPreferences({}, ok, ''), false);
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
  assert.ok(guestPreferences(prefs as WebPreferences, { partition: BROWSER_PARTITION, src: 'https://example.com' }, origin));
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
  assert.ok(guestMayNavigate('https://example.com/x?y#z', origin));
  assert.ok(guestMayNavigate('http://127.0.0.1:8080/', origin));
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
    assert.equal(guestMayNavigate(url, origin), false, url);
  }
});

test("a guest never navigates to the app's own host", () => {
  // The app's session alone takes the app's origin to the hub; a page in
  // a pane must not load the UI's address or open it as a tab.
  for (const url of [
    origin,
    `${origin}/`,
    `${origin}/api/m/local/hc/stop`,
    `http://${APP_HOST}/`,
    `https://${APP_HOST}:7781/m/local/code/`,
    `https://${APP_HOST}./`,
    `http://${APP_HOST}.:8080/api/x`,
    `https://${APP_HOST.toUpperCase()}../`,
  ]) {
    assert.equal(guestMayNavigate(url, origin), false, url);
  }
  // Every other address is another program's, the loopback's too.
  for (const url of [
    'http://127.0.0.1:7780/',
    'http://localhost/',
    'https://localhost/',
    'http://[::1]:3000/',
    `https://x.${APP_HOST}/`,
    'https://app.localhost/',
    'http://192.168.1.5:7781/',
  ]) {
    assert.equal(guestMayNavigate(url, origin), true, url);
  }
  // An origin that does not read is nobody's: nothing is allowed by it.
  for (const bad of ['', 'not an origin']) assert.equal(guestMayNavigate('https://example.com/', bad), false, bad);
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

test('names resolve with the system’s resolver, DNS over HTTPS as by default', () => {
  // Chromium's built-in resolver, Electron's default on macOS, asks the
  // DNS servers itself; the system's honors what it is set up with.
  assert.deepEqual(hostResolver, { enableBuiltInResolver: false });
});
