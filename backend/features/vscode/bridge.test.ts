// VS Code's bridge: windows saying hello, the events they send the pages,
// the theme, and where commands go.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { duplexPair, type Duplex } from 'node:stream';
import { Reader } from '#shared/lib/streamio.ts';
import { Op } from '#shared/proto/agentproto/index.ts';
import type { Channel } from '#kernel/channel.ts';
import type { Client } from '#kernel/http/env.ts';
import type { AgentStream } from '#kernel/machines/transport/session.ts';
import { sleep, waitFor } from '#kernel/testing.ts';
import { Bridge, type BridgeEvent, type Target } from './bridge.ts';
import { vscodeHub, type VSCodeHub } from './testdata/hub.ts';
import { DEFAULT_TIMING } from './timing.ts';

const timing = { ...DEFAULT_TIMING, bridgeGraceMs: 100, bridgeWindowMs: 600, bridgePollMs: 20, bridgeAckMs: 300 };

/** A VS Code window on the far end of a bridge connection: what it was
 * sent, and what it says. With ack, it acknowledges every command. */
class FakeWindow {
  readonly got: Array<Record<string, unknown>> = [];
  readonly commands: string[] = [];
  private readonly b: Duplex;

  constructor(b: Duplex, ack: boolean, name: string) {
    this.b = b;
    const r = new Reader(b);
    void (async () => {
      for (;;) {
        let line: string;
        try {
          line = await r.line(1 << 20);
        } catch {
          return;
        }
        const m = JSON.parse(line) as Record<string, unknown>;
        this.got.push(m);
        if (m.type === 'command') {
          this.commands.push(name);
          if (ack) this.say({ type: 'ack', id: m.id, ok: true });
        }
      }
    })();
  }

  say(m: object): void {
    this.b.write(JSON.stringify(m) + '\n');
  }

  close(): void {
    this.b.destroy();
  }
}

/** Connects a window of machine to bridge; with hello, it says hello and
 * is known once this resolves. */
async function connect(
  bridge: Bridge,
  machine: string,
  o: { hello?: { id: string; folders: string[]; focused?: boolean }; ack?: boolean } = {},
): Promise<FakeWindow> {
  const [a, b] = duplexPair();
  void bridge.serve(machine, { stream: a, reader: new Reader(a) } as unknown as AgentStream);
  const w = new FakeWindow(b, o.ack ?? true, o.hello?.id ?? '');
  await waitFor('the reply', () => w.got.length > 0);
  expect(w.got.shift()).toEqual({ ok: true });
  if (o.hello) {
    w.say({ type: 'hello', ...o.hello });
    await waitFor(`hello of ${o.hello.id}`, () => bridge.byID(machine, o.hello!.id) !== undefined);
  }
  return w;
}

const newBridge = () => {
  const events: BridgeEvent[] = [];
  return { bridge: new Bridge({ broadcast: (ev) => void events.push(ev), timing }), events };
};

test('pick', async () => {
  const { bridge } = newBridge();
  const a = await connect(bridge, 'm1', { hello: { id: 'a', folders: ['/home/u/proj'] } });
  const b = await connect(bridge, 'm1', { hello: { id: 'b', folders: ['/home/u/proj/sub'] } });
  await connect(bridge, 'm2', { hello: { id: 'c', folders: ['/home/u/proj/sub'] } });
  expect(bridge.pick('m1', '/home/u/proj/sub')).toMatchObject({ window: { id: 'b' }, score: 3 });
  expect(bridge.pick('m1', '/home/u/proj/sub/')).toMatchObject({ window: { id: 'b' }, score: 3 });
  expect(bridge.pick('m1', '/home/u/proj/other')).toMatchObject({ window: { id: 'a' }, score: 2 });
  expect(bridge.pick('m3', '/x').window).toBeUndefined();
  a.close();
  b.close();
  await waitFor('gone', () => bridge.byID('m1', 'a') === undefined && bridge.byID('m1', 'b') === undefined);
});

// Windows get the pages' theme kind when they connect and when it changes.
test('theme', async () => {
  const { bridge } = newBridge();
  const w = await connect(bridge, 'm', { hello: { id: 'w', folders: [] } });
  bridge.setTheme('light');
  bridge.setTheme('light'); // unchanged: not sent again
  bridge.setTheme('purple');
  bridge.setTheme('dark');
  await waitFor('themes', () => w.got.length === 2);
  await sleep(50);
  expect(w.got).toEqual([
    { type: 'theme', kind: 'light' },
    { type: 'theme', kind: 'dark' },
  ]);
  const later = await connect(bridge, 'm', { hello: { id: 'later', folders: [] } });
  await waitFor('theme', () => later.got.length === 1);
  expect(later.got).toEqual([{ type: 'theme', kind: 'dark' }]);
});

test('targets', async () => {
  const { bridge } = newBridge();
  await connect(bridge, 'm', { hello: { id: 'a', folders: ['/srv/app'] } });
  await sleep(5);
  const b = await connect(bridge, 'm', { hello: { id: 'b', folders: ['/srv/app'] } });
  const signal = AbortSignal.timeout(5000);
  const send = (t: Partial<Target>) => bridge.command('m', { folder: '', window: '', fresh: false, ...t }, { cmd: 'openDiff' }, signal);
  // Two windows show the folder: a named one gets it, else the one used
  // last (b said hello last).
  expect(await send({ folder: '/srv/app', window: 'a' })).toBe('a');
  expect(await send({ folder: '/srv/app' })).toBe('b');
  expect(b.got.at(-1)).toMatchObject({ type: 'command', cmd: 'openDiff' });
  // A window that is gone counts as unnamed.
  expect(await send({ folder: '/srv/app', window: 'gone' })).toBe('b');
  // A fresh pane's command waits for a window that says hello after it,
  // although others show the folder.
  const fresh = send({ folder: '/srv/app', fresh: true });
  await sleep(100);
  const before = [...b.commands];
  await connect(bridge, 'm', { hello: { id: 'c', folders: ['/srv/other'] } });
  const d = await connect(bridge, 'm', { hello: { id: 'd', folders: ['/srv/app/'] } });
  expect(await fresh).toBe('d');
  expect(d.commands).toEqual(['d']);
  expect(b.commands).toEqual(before);
  // A window containing the folder after the grace period; any window
  // without a folder.
  expect(await send({ folder: '/srv/app/src' })).toBe('d');
  expect(await send({})).toBe('d');
  // No window of the machine: an error after the wait.
  await expect(bridge.command('x', { folder: '/a', window: '', fresh: false }, { cmd: 'gitGraph' }, signal)).rejects.toThrow(
    'no VS Code window is connected',
  );
});

test('acknowledgements', async () => {
  const { bridge } = newBridge();
  const w = await connect(bridge, 'm', { hello: { id: 'w', folders: ['/a'] }, ack: false });
  const signal = AbortSignal.timeout(5000);
  const target = { folder: '/a', window: '', fresh: false };
  const refused = bridge.command('m', target, { cmd: 'openFile', path: '/a/x' }, signal);
  await waitFor('command', () => w.commands.length === 1);
  const cmd = w.got.at(-1)!;
  expect(cmd).toEqual({ cmd: 'openFile', path: '/a/x', type: 'command', id: cmd.id });
  w.say({ type: 'ack', id: cmd.id, ok: false, error: 'no such file' });
  await expect(refused).rejects.toThrow('no such file');
  // Unanswered.
  await expect(bridge.command('m', target, { cmd: 'gitGraph' }, signal)).rejects.toThrow('VS Code did not answer');
  // The window goes while a command waits.
  const pending = bridge.command('m', target, { cmd: 'gitGraph' }, signal);
  await waitFor('command', () => w.commands.length === 3);
  w.close();
  await expect(pending).rejects.toThrow('VS Code window closed');
});

// Send to Agent reaches the pages with the sending window's folders, so
// the page can pick the workspace whose panel shows that window.
test('send to agent, focus', async () => {
  const { bridge, events } = newBridge();
  const w = await connect(bridge, 'm');
  // Before its hello a window's folders are unknown: none are sent. A
  // window without a folder sends an empty list.
  w.say({ type: 'sendToAgent', text: '@/a:1' });
  w.say({ type: 'hello', id: 'w1', folders: ['/srv/app'] });
  w.say({ type: 'sendToAgent', text: '@/srv/app/x.go:3', file: '/srv/app/x.go', line: 3, end_line: 3 });
  w.say({ type: 'hello', id: 'w1', folders: [] });
  w.say({ type: 'sendToAgent', text: '@/b:2' });
  // A member of the wrong type drops the message.
  w.say({ type: 'sendToAgent', text: 5 });
  // A window that gets the keyboard is announced, with its id, so the page
  // showing it learns which window its pane is; so is one that has it as
  // it says hello.
  w.say({ type: 'focus' });
  w.say({ type: 'hello', id: 'w1', folders: ['/srv/app'], focused: true });
  await waitFor('events', () => events.length === 5);
  expect(events).toEqual([
    { t: 'bridge.send', m: 'm', text: '@/a:1', file: '', line: 0, end_line: 0 },
    {
      t: 'bridge.send',
      m: 'm',
      text: '@/srv/app/x.go:3',
      file: '/srv/app/x.go',
      line: 3,
      end_line: 3,
      folders: ['/srv/app'],
      window: 'w1',
    },
    { t: 'bridge.send', m: 'm', text: '@/b:2', file: '', line: 0, end_line: 0, folders: [], window: 'w1' },
    { t: 'bridge.focus', m: 'm', window: 'w1', folders: [] },
    { t: 'bridge.focus', m: 'm', window: 'w1', folders: ['/srv/app'] },
  ]);
});

test('close, leave, download', async () => {
  const { bridge, events } = newBridge();
  const w = await connect(bridge, 'm');
  // Only a window that said hello is one a page can name.
  w.say({ type: 'closePane' });
  w.say({ type: 'download', paths: [] });
  w.say({ type: 'download', paths: ['/srv/a', '/srv/b'] });
  w.say({ type: 'download', paths: Array.from({ length: 1001 }, (_, i) => `/f${i}`) });
  w.say({ type: 'hello', id: 'w1', folders: ['/srv'] });
  w.say({ type: 'closePane' });
  w.say({ type: 'leave' });
  w.say({ type: 'download', paths: ['/srv/a'] });
  await waitFor('events', () => events.length === 4);
  expect(events).toEqual([
    { t: 'bridge.download', m: 'm', paths: ['/srv/a', '/srv/b'] },
    { t: 'bridge.close', m: 'm', window: 'w1', folders: ['/srv'] },
    { t: 'bridge.leave', m: 'm', window: 'w1', folders: ['/srv'] },
    { t: 'bridge.download', m: 'm', paths: ['/srv/a'], window: 'w1' },
  ]);
});

describe('through a core', () => {
  let vc: VSCodeHub;
  beforeAll(async () => {
    vc = await vscodeHub({ desktopOn: false, browserOn: false });
  });
  afterAll(() => vc.stop());

  /** A page of a kind of client on the core's /ws. */
  const page = (client: Client, readOnly = false) => {
    const sent: Array<Record<string, unknown>> = [];
    const ch: Channel = { send: (d) => void sent.push(JSON.parse(String(d))), buffered: 0, close() {} };
    const h = vc.core.pages.connect(ch, { client, readOnly, who: {} });
    return { sent, send: (m: object) => h.message(JSON.stringify(m)), bridge: () => sent.filter((m) => String(m.t).startsWith('bridge.')) };
  };

  // Messages of VS Code's windows reach only the pages for which VS Code
  // is on: a browser whose switch is off gets nothing of VS Code's while
  // the desktop app's is on, and the other way round.
  test("messages follow each client's switch; the pages' theme", async () => {
    const desktop = page('desktop');
    const browser = page('browser');
    const watcher = page('browser', true);
    const conn = await vc.agents[0].open({ op: Op.Bridge });
    const reader = new Reader(conn.stream);
    // Off: the agent's stream is refused.
    expect(JSON.parse(await reader.line(1 << 20))).toMatchObject({ ok: false, code: 'plugin_disabled' });
    vc.settings.set('plugins.vscode.enabled', '', true);
    const w = await vc.agents[0].open({ op: Op.Bridge });
    const r = new Reader(w.stream);
    expect(JSON.parse(await r.line(1 << 20))).toEqual({ ok: true });
    const say = (m: object) => w.stream.write(JSON.stringify(m) + '\n');
    say({ type: 'hello', id: 'w', folders: ['/x'] });
    say({ type: 'sendToAgent', text: '@x' });
    await waitFor('desktop', () => desktop.bridge().length === 1);
    expect(browser.bridge()).toEqual([]);
    vc.settings.set('plugins.vscode.enabled', '', false);
    vc.settings.set('plugins.vscode.browser', '', true);
    say({ type: 'sendToAgent', text: '@y' });
    await waitFor('browser', () => browser.bridge().length === 1);
    expect(desktop.bridge().length).toBe(1);
    // The pages' theme reaches the window; a watcher's does not.
    watcher.send({ t: 'theme', kind: 'light' });
    browser.send({ t: 'theme', kind: 'dark' });
    expect(JSON.parse(await r.line(1 << 20))).toEqual({ type: 'theme', kind: 'dark' });
    w.stream.end();
  });
});
