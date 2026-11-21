import test from 'node:test';
import assert from 'node:assert/strict';
import type { DesktopShell, OpenedFolders } from '../../web/src/shell';
import { channels } from './bridge';
import { answers, exposed, invoked, onDisk, receive, sent } from './fakeElectron';
import { desktopShellFor } from './preload';

const shell = exposed.desktopShell as DesktopShell;
const common = [
  'answerClose',
  'browser',
  'metrics',
  'onCloseRequest',
  'onCommand',
  'onOpenFolders',
  'pathForFile',
  'setDisabledCommands',
  'setUnsaved',
  'verifyUser',
];

test('the page gets only the desktopShell bridge, with these functions', () => {
  assert.deepEqual(Object.keys(exposed), ['desktopShell']);
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
  const off = shell.onCloseRequest(() => asked++);
  receive(channels.closeRequest, undefined);
  receive(channels.closeRequest, 'payload');
  off();
  receive(channels.closeRequest, undefined);
  assert.equal(asked, 1);
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
  assert.deepEqual(Object.keys(verifyUser!).sort(), ['available', 'prove']);
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
