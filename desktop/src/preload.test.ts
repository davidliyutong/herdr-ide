import test from 'node:test';
import assert from 'node:assert/strict';
import './fakeWindow';
import type { DesktopShell, OpenedFolders } from '../../web/src/shell';
import { channels } from './bridge';
import { answers, exposed, invoked, onDisk, receive, sent } from './fakeElectron';
import { desktopShellFor } from './preload';

const shell = exposed.desktopShell as DesktopShell;
const common = [
  'answerClose',
  'browser',
  'metrics',
  'notifications',
  'onCloseRequest',
  'onCommand',
  'onOpenFolders',
  'pathForFile',
  'setDisabledCommands',
  'setUnsaved',
  'verifyUser',
  'windows',
];

test('the page gets its channels and the desktopShell bridge, with these functions', () => {
  assert.deepEqual(Object.keys(exposed), ['desktopChannels', 'desktopShell']);
  assert.deepEqual(Object.keys(shell).sort(), process.platform === 'darwin' ? [...common, 'privacy', 'titlebar'].sort() : common);
  for (const platform of ['win32', 'linux']) assert.deepEqual(Object.keys(desktopShellFor(platform)).sort(), common);
});

test("integrated title bar is macOS's: reports geometry and boolean full-screen updates", () => {
  const tb = desktopShellFor('darwin').titlebar!;
  assert.equal(tb.kind, 'mac');
  assert.ok(tb.inset >= 80);
  assert.ok(tb.minHeight >= 42);
  assert.ok(tb.topSpace > 0);
  sent.length = 0;
  const states: boolean[] = [];
  const off = tb.onFullScreen((full) => states.push(full));
  assert.deepEqual(sent, [{ channel: channels.fullScreenQuery, value: undefined }]);
  receive(channels.fullScreen, true);
  receive(channels.fullScreen, 'yes');
  receive(channels.fullScreen, 1);
  receive(channels.fullScreen, false);
  off();
  receive(channels.fullScreen, true);
  assert.deepEqual(states, [true, false]);
  sent.length = 0;
});

test("Full Disk Access is macOS's: three requests on their own channels, carrying nothing from the page", () => {
  const privacy = desktopShellFor('darwin').privacy!;
  assert.deepEqual(Object.keys(privacy).sort(), ['openFullDiskAccess', 'relaunch', 'revealTerminalCore']);
  sent.length = 0;
  const anything = privacy as unknown as Record<string, (arg: unknown) => void>;
  anything.openFullDiskAccess('https://example.com');
  anything.revealTerminalCore('/etc/passwd');
  anything.relaunch('--inspect');
  assert.deepEqual(sent, [
    { channel: channels.openFullDiskAccess, value: undefined },
    { channel: channels.revealTerminalCore, value: undefined },
    { channel: channels.relaunch, value: undefined },
  ]);
  sent.length = 0;
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

test('closing with unsaved changes: a count and an answer from the page, a request without data to it', () => {
  sent.length = 0;
  shell.setUnsaved(3);
  shell.setUnsaved(-1);
  shell.setUnsaved(1.5);
  shell.setUnsaved('2' as unknown as number);
  shell.setUnsaved(20000);
  shell.answerClose('asking');
  shell.answerClose('quit' as unknown as 'close');
  shell.answerClose('close');
  assert.deepEqual(sent, [
    { channel: channels.unsaved, value: 3 },
    { channel: channels.unsaved, value: 10000 },
    { channel: channels.closeAnswer, value: 'asking' },
    { channel: channels.closeAnswer, value: 'close' },
  ]);
  let asked = 0;
  const reasons: Array<'close' | 'quit' | undefined> = [];
  const off = shell.onCloseRequest((reason) => {
    asked++;
    reasons.push(reason);
  });
  receive(channels.closeRequest, undefined);
  receive(channels.closeRequest, 'close');
  receive(channels.closeRequest, 'quit');
  receive(channels.closeRequest, 'payload');
  off();
  receive(channels.closeRequest, undefined);
  assert.equal(asked, 3);
  assert.deepEqual(reasons, [undefined, 'close', 'quit']);
  sent.length = 0;
});

test('detached tab windows bridge validates requests and omits macOS integrated titlebar', async () => {
  const det = desktopShellFor('darwin', true);
  assert.equal(det.detached, true);
  assert.equal(det.titlebar, undefined);
  invoked.length = 0;
  sent.length = 0;
  answers.set(channels.windowOpenTab, true);
  answers.set(channels.windowIsOverMain, true);
  assert.equal(await shell.windows!.openTab({ m: '', pane: 't1' }), false);
  assert.equal(await shell.windows!.openTab({ m: 'local', pane: 't1', x: 50, y: 60 }), true);
  shell.windows!.focusMain();
  assert.equal(await shell.windows!.isOverMain(NaN, 10), false);
  assert.equal(await shell.windows!.isOverMain(100, 200), true);
  assert.deepEqual(invoked, [
    { channel: channels.windowOpenTab, args: [{ m: 'local', pane: 't1', x: 50, y: 60 }] },
    { channel: channels.windowIsOverMain, args: [{ x: 100, y: 200 }] },
  ]);
  assert.deepEqual(sent, [{ channel: channels.windowFocusMain, value: undefined }]);
  invoked.length = 0;
  sent.length = 0;
});

test('metrics passes on processes with a kind, as amounts and short text', async () => {
  answers.set(channels.metrics, [
    { type: 'GPU', cpu: 12.5, memory: 2048, extra: 'dropped' },
    { type: 'Tab', name: 'x'.repeat(100), cpu: -1, memory: 'much' },
    { name: 'no kind', cpu: 1, memory: 1 },
    'text',
    null,
  ]);
  assert.deepEqual(await shell.metrics!(), [
    { type: 'GPU', name: '', cpu: 12.5, memory: 2048 },
    { type: 'Tab', name: 'x'.repeat(64), cpu: 0, memory: 0 },
  ]);
  for (const bad of [null, 'text', {}, new Error('no handler')]) {
    answers.set(channels.metrics, bad);
    assert.deepEqual(await shell.metrics!(), []);
  }
});

test('verifyUser asks the main process and passes on only what has the right form', async () => {
  const { verifyUser } = shell;
  assert.deepEqual(Object.keys(verifyUser!).sort(), ['available', 'canUnlock', 'enroll', 'prove', 'unlock']);
  for (const [got, want] of [
    ['touchid', 'touchid'],
    ['hello', 'hello'],
    [null, null],
    [undefined, null],
    ['biometrics', null],
    [{ kind: 'touchid' }, null],
    [new Error('no handler'), null],
  ] as const) {
    answers.set(channels.verifyAvailable, got);
    assert.equal(await verifyUser!.available(), want);
  }
  const mac = 'ab'.repeat(32);
  for (const [got, want] of [
    [mac, mac],
    [mac.toUpperCase(), null],
    [mac + 'a', null],
    ['not hex'.padEnd(64, 'a'), null],
    [null, null],
    [7, null],
    [new Error('refused'), null],
  ] as const) {
    answers.set(channels.verifyProve, got);
    assert.equal(await verifyUser!.prove('n'.repeat(43)), want);
  }
  // Only a string nonce goes on, and nothing else with it.
  invoked.length = 0;
  answers.set(channels.verifyProve, mac);
  for (const bad of [undefined, null, 5, {}, ['x'], { toString: () => 'x' }])
    assert.equal(await verifyUser!.prove(bad as unknown as string), null);
  assert.deepEqual(invoked, []);
  assert.equal(await verifyUser!.prove('n'.repeat(43)), mac);
  assert.deepEqual(invoked, [{ channel: channels.verifyProve, args: ['n'.repeat(43)] }]);
  for (const platform of ['win32', 'linux', 'darwin']) assert.ok(desktopShellFor(platform).verifyUser);
});

test('the unlock key: only true is true, and only an id and a relay, a MAC and a relay, of their forms pass', async () => {
  const verifyUser = shell.verifyUser!;
  for (const [got, want] of [
    [true, true],
    [false, false],
    ['true', false],
    [1, false],
    [null, false],
    [new Error('no handler'), false],
  ] as const) {
    answers.set(channels.verifyCanUnlock, got);
    assert.equal(await verifyUser.canUnlock(), want);
  }
  const id = 'E'.repeat(22);
  const relay = 'r'.repeat(100);
  const mac = 'ab'.repeat(32);
  const n = 'n'.repeat(43);
  for (const [got, want] of [
    [
      { id, relay },
      { id, relay },
    ],
    // This install has no entry: exactly 'none', nothing like it.
    ['none', 'none'],
    ['None', null],
    ['none ', null],
    [{ none: true }, null],
    [
      { id, relay: 'x'.repeat(8192) },
      { id, relay: 'x'.repeat(8192) },
    ],
    [{ id, relay: 'x'.repeat(8193) }, null],
    [{ id, relay: '' }, null],
    [{ id, relay: relay + '=' }, null],
    [{ id, relay: relay + '+' }, null],
    [{ id: 'E'.repeat(21), relay }, null],
    [{ id: 'E'.repeat(23), relay }, null],
    [{ id: 'E'.repeat(21) + '/', relay }, null],
    [{ id, relay, extra: 1 }, null],
    [{ id }, null],
    [{ id: 5, relay }, null],
    [[id, relay], null],
    [null, null],
    ['text', null],
    [new Error('refused'), null],
  ] as const) {
    answers.set(channels.verifyUnlock, got);
    assert.deepEqual(await verifyUser.unlock(n), want, JSON.stringify(got));
  }
  for (const [got, want] of [
    [
      { mac, relay },
      { mac, relay },
    ],
    [{ mac: mac.toUpperCase(), relay }, null],
    [{ mac: mac + 'a', relay }, null],
    [{ mac, relay: 'x'.repeat(8193) }, null],
    [{ mac, relay: 'not/base64url' }, null],
    [{ mac, relay, id: 'x' }, null],
    [{ relay }, null],
    [mac, null],
    [undefined, null],
    [new Error('refused'), null],
  ] as const) {
    answers.set(channels.verifyEnroll, got);
    assert.deepEqual(await verifyUser.enroll(n), want, JSON.stringify(got));
  }
  // The answer is a copy: nothing else of the main process's object goes on.
  const answer = { id, relay };
  answers.set(channels.verifyUnlock, answer);
  assert.notEqual(await verifyUser.unlock(n), answer);
  // Only a string nonce goes on, and nothing else with it.
  invoked.length = 0;
  for (const bad of [undefined, null, 5, {}, ['x']]) {
    assert.equal(await verifyUser.unlock(bad as unknown as string), null);
    assert.equal(await verifyUser.enroll(bad as unknown as string), null);
  }
  assert.deepEqual(invoked, []);
  await verifyUser.unlock(n);
  await verifyUser.enroll(n);
  await verifyUser.canUnlock();
  assert.deepEqual(invoked, [
    { channel: channels.verifyUnlock, args: [n] },
    { channel: channels.verifyEnroll, args: [n] },
    { channel: channels.verifyCanUnlock, args: [] },
  ]);
});

test('browser.onOpen delivers http(s) addresses only, while it listens', () => {
  const got: string[] = [];
  const off = shell.browser!.onOpen((url) => got.push(url));
  receive(channels.browserOpen, 'https://example.com/a');
  receive(channels.browserOpen, 'http://localhost:3000');
  for (const bad of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,x',
    'example.com',
    '',
    5,
    null,
    { url: 'https://example.com' },
  ]) {
    receive(channels.browserOpen, bad);
  }
  off();
  receive(channels.browserOpen, 'https://example.com/b');
  assert.deepEqual(got, ['https://example.com/a', 'http://localhost:3000']);
});

test('notifications validates options and targets in both directions', async () => {
  const notifications = shell.notifications!;
  assert.deepEqual(Object.keys(notifications).sort(), ['close', 'onClick', 'setBadgeCount', 'show', 'supported']);

  answers.set(channels.notifySupported, true);
  assert.equal(await notifications.supported(), true);
  answers.set(channels.notifySupported, 'yes');
  assert.equal(await notifications.supported(), false);
  answers.set(channels.notifySupported, new Error('ipc failed'));
  assert.equal(await notifications.supported(), false);

  invoked.length = 0;
  answers.set(channels.notifyShow, true);
  assert.equal(
    await notifications.show({
      title: '  Agent blocked  ',
      body: 'gpu · 1',
      tag: 'm|t1',
      silent: true,
      urgency: 'critical',
      target: { kind: 'chat', machine: 'm', chat: 'c1', agent: 'claude' },
    }),
    true,
  );
  assert.deepEqual(invoked, [
    {
      channel: channels.notifyShow,
      args: [
        {
          title: 'Agent blocked',
          body: 'gpu · 1',
          tag: 'm|t1',
          silent: true,
          urgency: 'critical',
          target: { kind: 'chat', machine: 'm', chat: 'c1', agent: 'claude' },
        },
      ],
    },
  ]);

  // Invalid payloads are dropped before crossing IPC.
  invoked.length = 0;
  for (const bad of [
    { title: '   ' },
    { title: 'ok', extra: 1 },
    { title: 'ok', urgency: 'high' },
    { title: 'ok', target: { kind: 'pane', machine: 'm', pane: 't1', extra: 1 } },
  ]) {
    assert.equal(await notifications.show(bad as unknown as Parameters<typeof notifications.show>[0]), false);
  }
  assert.deepEqual(invoked, []);

  sent.length = 0;
  notifications.close('m|t1');
  notifications.close('bad\ntag');
  notifications.close('');
  notifications.setBadgeCount!(3);
  notifications.setBadgeCount!(0);
  notifications.setBadgeCount!(50000);
  notifications.setBadgeCount!(-1);
  notifications.setBadgeCount!(1.5);
  notifications.setBadgeCount!('2' as unknown as number);
  assert.deepEqual(sent, [
    { channel: channels.notifyClose, value: 'm|t1' },
    { channel: channels.notifyBadge, value: 3 },
    { channel: channels.notifyBadge, value: 0 },
    { channel: channels.notifyBadge, value: 9999 },
  ]);

  sent.length = 0;
  const clicks: unknown[] = [];
  const off = notifications.onClick((target) => clicks.push(target));
  assert.deepEqual(sent, [{ channel: channels.notifyClickWanted, value: true }]);
  receive(channels.notifyClick, { kind: 'pane', machine: 'm', pane: 't1' });
  receive(channels.notifyClick, { kind: 'chat', machine: 'm', chat: 'c1' });
  receive(channels.notifyClick, { kind: 'bad', machine: 'm' });
  receive(channels.notifyClick, { kind: 'pane', machine: 'm', pane: 't1', extra: 1 });
  off();
  receive(channels.notifyClick, { kind: 'panel', panel: 'usage' });
  assert.deepEqual(clicks, [
    { kind: 'pane', machine: 'm', pane: 't1' },
    { kind: 'chat', machine: 'm', chat: 'c1' },
  ]);
  assert.deepEqual(sent, [
    { channel: channels.notifyClickWanted, value: true },
    { channel: channels.notifyClickWanted, value: false },
  ]);
});
