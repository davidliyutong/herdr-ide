// The feature's routes: each client's switch, read-only mode, the guards,
// work ending with a switch, the install mode, bridge commands and idle
// code-servers.
import { afterEach, expect, test } from 'bun:test';
import { Reader } from '#shared/lib/streamio.ts';
import { Op } from '#shared/proto/agentproto/index.ts';
import { checkGuarded, sleep, waitFor, type TestHub } from '#kernel/testing.ts';
import { INSTALL, PATH } from './settings.ts';
import { vscodeHub, type VSCodeHub, type VSCodeHubOptions } from './testdata/hub.ts';

const cores: VSCodeHub[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.stop();
});
const newHub = async (o: VSCodeHubOptions = {}) => {
  const vc = await vscodeHub(o);
  cores.push(vc);
  return vc;
};

const errorOf = async (res: Response) => ((await res.clone().json()) as { error: string }).error;

/** Waits until code-server is ready on the local machine for a client. */
async function ready(vc: VSCodeHub, desktop = false): Promise<void> {
  expect((await vc.request('POST', '/api/m/local/code/start', { desktop })).status).toBe(202);
  await waitFor('ready', () => vc.agent.headers.some((h) => h.action === 'start'));
  for (let i = 0; i < 400; i++) {
    const s = (await (await vc.request('GET', '/api/m/local/code/status', { desktop })).json()) as { ready: boolean };
    if (s.ready) return;
    await sleep(5);
  }
  throw new Error('not ready');
}

// VS Code's routes answer plugin_disabled to a client whose switch is off;
// stopping code-server never does.
test("routes follow their client's switch", async () => {
  const vc = await newHub({ desktopOn: false, browserOn: false });
  const paths: Array<[string, string]> = [
    ['GET', '/api/m/nope/code/status'],
    ['POST', '/api/m/nope/code/start'],
    ['POST', '/api/m/nope/bridge'],
    ['GET', '/m/nope/code/'],
    ['GET', '/m/nope/code'],
  ];
  const check = async (state: string, on: { desktop: boolean; browser: boolean }) => {
    for (const desktop of [true, false]) {
      for (const [method, path] of paths) {
        const res = await vc.request(method, path, { desktop, body: method === 'POST' ? '{}' : undefined });
        const refused = res.status === 404 && (await errorOf(res)) === 'plugin_disabled';
        expect([state, desktop, method, path, refused]).toEqual([state, desktop, method, path, !(desktop ? on.desktop : on.browser)]);
      }
      const stop = await vc.request('POST', '/api/m/nope/code/stop', { desktop });
      expect([state, await errorOf(stop)]).toEqual([state, 'unknown']);
    }
  };
  await check('both off', { desktop: false, browser: false });
  vc.settings.set('plugins.vscode.enabled', '', true);
  await check('the desktop app on', { desktop: true, browser: false });
  vc.settings.set('plugins.vscode.enabled', '', false);
  vc.settings.set('plugins.vscode.browser', '', true);
  await check('browsers on', { desktop: false, browser: true });
});

// Requests from other sites are refused, and in read-only mode everything
// that changes something but stopping code-server (it frees resources)
// and the redirect to the proxy.
test('guards', async () => {
  const rw = await newHub();
  const ro = await newHub({ readOnly: true });
  const asTestHub = (vc: VSCodeHub) =>
    ({
      core: vc.hub,
      request: (method: string, path: string, o: { origin?: string; body?: string } = {}) =>
        vc.request(method, path, { body: o.body, headers: o.origin ? { Origin: o.origin } : {} }),
    }) as unknown as TestHub;
  const { problems, checked } = await checkGuarded(asTestHub(rw), asTestHub(ro), {
    machine: 'local',
    readOnlyAllowed: ['POST /api/m/:id/code/stop', 'ALL /m/:id/code'],
  });
  expect(problems).toEqual([]);
  expect(checked.sort()).toEqual([
    'ALL /m/:id/code',
    'ALL /m/:id/code/*',
    'POST /api/m/:id/bridge',
    'POST /api/m/:id/code/start',
    'POST /api/m/:id/code/stop',
  ]);
  // Read-only: no VS Code at all, its status still.
  expect(await errorOf(await ro.request('GET', '/m/local/code/'))).toBe('read_only');
  expect((await ro.request('GET', '/api/m/local/code/status')).status).toBe(200);
  const stop = await ro.request('POST', '/api/m/local/code/stop');
  expect([stop.status, await stop.json()]).toEqual([200, { ok: true }]);
  expect(ro.audit.records().find((r) => r.event === 'code_server.stop')).toMatchObject({ machine: 'local', status: 200 });
});

// Turning a client's switch off ends its WebSockets and requests; the
// other client's stay.
test('a switch turned off ends its work', async () => {
  const vc = await newHub();
  await ready(vc);
  const browser = await vc.websocket('/m/local/code/stable');
  const desktop = await vc.websocket('/m/local/code/stable', { desktop: true });
  await waitFor('both open', () => vc.cs.sockets.size === 2);
  vc.settings.set('plugins.vscode.browser', '', false);
  await waitFor('the browser closed', () => browser.closed() !== null);
  expect(browser.closed()).toEqual({ code: 1001, reason: 'VS Code turned off' });
  await waitFor('code-server closed', () => vc.cs.sockets.size === 1);
  desktop.ch!.send('still');
  await waitFor('echo', () => desktop.got.length === 1);
  expect(desktop.closed()).toBeNull();
  expect(await errorOf(await vc.request('GET', '/m/local/code/x'))).toBe('plugin_disabled');
  expect(await (await vc.request('GET', '/m/local/code/x', { desktop: true })).text()).toBe('ok');
  // Turned on again: works again.
  vc.settings.set('plugins.vscode.browser', '', true);
  expect(await (await vc.request('GET', '/m/local/code/x')).text()).toBe('ok');
  desktop.ch!.close(1000, '');
});

// A proxied request and a bridge command in flight follow their client's
// switch too: turned off, both end at once, the other client's go on.
test('a switch turned off ends its requests and bridge commands in flight', async () => {
  const vc = await newHub();
  await ready(vc);
  const w = await vc.agents[0].open({ op: Op.Bridge });
  const r = new Reader(w.stream);
  expect(JSON.parse(await r.line(1 << 20))).toEqual({ ok: true });
  w.stream.write(JSON.stringify({ type: 'hello', id: 'w1', folders: ['/srv'] }) + '\n');
  const held = vc.request('GET', '/m/local/code/hold');
  const command = vc.request('POST', '/api/m/local/bridge', { body: JSON.stringify({ cmd: 'openFile', path: '/srv/a', folder: '/srv' }) });
  expect(JSON.parse(await r.line(1 << 20))).toMatchObject({ cmd: 'openFile', type: 'command' }); // never acknowledged
  const desktop = vc.request('GET', '/m/local/code/hold', { desktop: true });
  await waitFor('both held', () => vc.cs.requests.filter((q) => q.path === '/hold').length === 2);
  const started = Date.now();
  vc.settings.set('plugins.vscode.browser', '', false);
  const [h, c] = await Promise.all([held, command]);
  expect([h.status, await errorOf(h)]).toEqual([502, 'code_server_unavailable']);
  expect([c.status, await errorOf(c)]).toEqual([503, 'VS Code turned off']);
  expect(Date.now() - started).toBeLessThan(5000);
  // The desktop app's request is still held: it ends with its own switch.
  expect(await Promise.race([desktop.then(() => 'answered'), sleep(100).then(() => 'held')])).toBe('held');
  vc.settings.set('plugins.vscode.enabled', '', false);
  expect((await desktop).status).toBe(502);
  w.stream.end();
});

// Off for every client, preparing code-server ends; off for one, it goes
// on.
test('preparations end with the last switch', async () => {
  const vc = await newHub();
  let release!: () => void;
  vc.agent.hold = new Promise<void>((r) => (release = r));
  expect((await vc.request('POST', '/api/m/local/code/start')).status).toBe(202);
  await waitFor('starting', () => vc.agent.headers.some((h) => h.action === 'start'));
  vc.settings.set('plugins.vscode.browser', '', false);
  await sleep(50);
  expect(((await (await vc.request('GET', '/api/m/local/code/status', { desktop: true })).json()) as { phase: string }).phase).toBe(
    'start',
  );
  vc.settings.set('plugins.vscode.enabled', '', false);
  vc.settings.set('plugins.vscode.browser', '', true);
  let st: { phase: string; error?: string } = { phase: '' };
  await waitFor('ended', () => {
    void vc
      .request('GET', '/api/m/local/code/status')
      .then((r) => r.json())
      .then((j) => (st = j as typeof st));
    return st.phase === 'error';
  });
  expect(st.error).toBe('VS Code turned off');
  release();
});

test('the install mode is the machine setting', async () => {
  const vc = await newHub();
  vc.agent.existing = true;
  vc.settings.set(INSTALL, 'local', 'existing');
  await ready(vc);
  expect(vc.agent.headers.map((h) => [h.action, h.bin])).toEqual([
    ['status', 'auto'],
    ['start', 'auto'],
  ]);
  vc.settings.set(PATH, '', '~/bin/code-server');
  await vc.request('POST', '/api/m/local/code/stop');
  vc.agent.headers.length = 0;
  await ready(vc);
  expect(vc.agent.headers[0]).toMatchObject({ action: 'status', bin: '~/bin/code-server' });
});

test('bridge commands', async () => {
  const vc = await newHub({ timing: { bridgeWindowMs: 500, bridgeGraceMs: 50, bridgePollMs: 10 } });
  // No window: code-server is prepared, then the command fails with the
  // text the UI shows.
  const none = await vc.request('POST', '/api/m/local/bridge', { body: JSON.stringify({ cmd: 'gitGraph', repo: '/srv', folder: '/srv' }) });
  expect([none.status, await errorOf(none)]).toEqual([503, 'no VS Code window is connected (code-server may still be starting)']);
  expect(vc.agent.headers.some((h) => h.action === 'start')).toBe(true);
  // A window of the folder takes it.
  const w = await vc.agents[0].open({ op: Op.Bridge });
  const r = new Reader(w.stream);
  expect(JSON.parse(await r.line(1 << 20))).toEqual({ ok: true });
  w.stream.write(JSON.stringify({ type: 'hello', id: 'w1', folders: ['/srv'] }) + '\n');
  const answer = vc.request('POST', '/api/m/local/bridge', {
    body: JSON.stringify({ cmd: 'openFile', path: '/srv/a', folder: '/srv', window: '', fresh: false }),
  });
  const cmd = JSON.parse(await r.line(1 << 20)) as Record<string, unknown>;
  expect(cmd).toEqual({ cmd: 'openFile', path: '/srv/a', type: 'command', id: cmd.id });
  w.stream.write(JSON.stringify({ type: 'ack', id: cmd.id, ok: true }) + '\n');
  const res = await answer;
  expect([res.status, await res.json()]).toEqual([200, { ok: true, window: 'w1' }]);
  const records = vc.audit.records().filter((r) => r.event === 'bridge.command');
  expect(records.map((r) => [r.cmd, r.folder, r.status, r.error])).toEqual([
    ['gitGraph', '/srv', 503, 'no VS Code window is connected (code-server may still be starting)'],
    ['openFile', '/srv', 200, undefined],
  ]);
  const bad = await vc.request('POST', '/api/m/local/bridge', { body: '[1]' });
  expect([bad.status, await errorOf(bad)]).toEqual([400, 'bad_request']);
  w.stream.end();
});

// A code-server without connections or requests for --code-server-idle
// is released; an open WebSocket keeps it.
test('idle code-servers are released', async () => {
  const vc = await newHub({ idle: 150, timing: { idleCheckMs: 30 } });
  await ready(vc);
  const ws = await vc.websocket('/m/local/code/stable');
  await sleep(400);
  expect(vc.agent.headers.some((h) => h.action === 'release')).toBe(false);
  ws.ch!.close(1000, '');
  await waitFor('released', () => vc.agent.headers.some((h) => h.action === 'release'), 3000);
  expect(vc.audit.records().find((r) => r.event === 'code_server.idle_stop')).toMatchObject({ machine: 'local' });
  const s = (await (await vc.request('GET', '/api/m/local/code/status')).json()) as { ready: boolean; phase: string };
  expect([s.ready, s.phase]).toEqual([false, 'idle']);
});

// The browsers' WebSocket channel holds code-server back while it is
// behind: code-server's stream is not read until the channel drains.
test('backpressure', async () => {
  const vc = await newHub();
  await ready(vc);
  // Behind until drained once.
  let behind = true;
  let buffered = 0;
  const got: number[] = [];
  let drain: (() => void) | undefined;
  const res = await vc.request('GET', '/m/local/code/stable', {
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
    },
    upgrade: (open) => {
      const h = open({
        send: (d) => {
          got.push(d.length);
          if (behind) buffered += d.length;
        },
        get buffered() {
          return buffered;
        },
        close() {},
      });
      drain = () => h.drain?.();
      queueMicrotask(() => h.message('ready'));
      return new Response(null);
    },
  });
  expect(res.status).toBe(200);
  await waitFor('echo', () => got.length === 1);
  const ws = [...vc.cs.sockets][0];
  const chunk = Buffer.alloc(256 << 10, 'y');
  for (let i = 0; i < 64; i++) ws.send(chunk); // 16 MiB
  await sleep(300);
  const before = got.length;
  expect(before).toBeLessThan(24);
  behind = false;
  buffered = 0;
  drain!();
  await waitFor('the rest', () => got.length === 65, 5000);
});
