import { afterEach, describe, expect, test } from 'bun:test';
import { discard } from '#shared/lib/log.ts';
import { channelPair, CloseCode, type ChannelOpen, type Message } from '#kernel/channel.ts';
import { createHub } from '#kernel/hub.ts';
import { Guard } from '#kernel/http/guard.ts';
import { serveUI } from '#kernel/http/static.ts';
import type { Machines } from '#kernel/machines/manager.ts';
import {
  agentDialer,
  checkGuarded,
  localSpec,
  memoryAudit,
  running,
  sleep,
  sshSpec,
  testMachines,
  waitFor,
  type RequestOptions,
  type TestHub,
} from '#kernel/testing.ts';
import { terminalsFeature } from '#features/terminals/hub.ts';
import { guiFeature, type GUIOptions } from './hub.ts';
import type { Shells } from './enable.ts';
import { FakeDisplay, testSettings } from './testing.ts';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

/** A core with program windows (and terminals, wired as the host does)
 * over machines (local and m1 by default, not connected). */
function guiHub(o: { readOnly?: boolean; machines?: Machines; gui?: GUIOptions } = {}) {
  const audit = memoryAudit();
  const settings = testSettings();
  const gui = guiFeature({ timing: { interruptPauseMs: 1, closeGraceMs: 30 }, ...o.gui });
  const terminals = terminalsFeature({ paneEnv: gui.paneEnv, onReady: gui.terminalReady });
  const machines = o.machines ?? testMachines([localSpec(), sshSpec('m1')]);
  const core = createHub({
    guard: new Guard(),
    audit: audit.audit,
    readOnly: o.readOnly ?? false,
    logger: discard,
    machines,
    settings,
    features: [terminals, gui],
  });
  serveUI(core.http.app, { get: async (p) => (p === 'index.html' ? Buffer.from('<html></html>') : null) });
  const request = (method: string, path: string, r: RequestOptions = {}) => {
    const host = r.host ?? '127.0.0.1:7780';
    const headers = new Headers(r.headers);
    headers.set('Host', host);
    if (r.origin) headers.set('Origin', r.origin);
    return core.fetch(new Request(`http://${host}${path}`, { method, headers, body: r.body }), {
      remote: r.remote ?? '127.0.0.1',
      desktop: false,
      upgrade: r.upgrade,
    });
  };
  const t: TestHub & { mgr: () => NonNullable<ReturnType<typeof gui.manager>>; settings: Record<string, boolean> } = {
    hub: core,
    settings: {},
    audit,
    request,
    mgr: () => gui.manager()!,
  };
  return { ...t, prefs: settings, machines };
}

/** Opens a browser window's WebSocket: what it gets, and how it closed. */
async function openWindow(t: ReturnType<typeof guiHub>, path: string) {
  const { a, b } = channelPair();
  const got: Message[] = [];
  let closed: [number, string] | undefined;
  b.adopt(() => ({ message: (m) => void got.push(m), close: (code, reason) => void (closed = [code, reason]) }));
  let compress: boolean | undefined;
  const res = await t.request('GET', path, {
    upgrade: (open: ChannelOpen, opts) => {
      compress = opts?.compress;
      a.adopt(open);
      return new Response(null);
    },
  });
  await sleep(5);
  const events = () => got.filter((m) => typeof m === 'string').map((m) => JSON.parse(m as string) as Record<string, unknown>);
  return { res, got, events, closed: () => closed, compress: () => compress, send: (m: string) => b.send(m), close: () => b.close() };
}

describe('routes', () => {
  // Closing a program window needs the page's own Origin; "null"
  // (sandboxed frames, data: pages) and other sites are refused. It is
  // audited, and refused in read-only mode.
  test('close', async () => {
    const t = guiHub();
    for (const [origin, status] of [
      ['null', 403],
      ['https://evil.example', 403],
      ['http://127.0.0.1:7780', 204],
    ] as const) {
      const res = await t.request('POST', '/m/m1/gui/7/close', { origin });
      expect([origin, res.status]).toEqual([origin, status]);
    }
    expect(t.audit.records()).toEqual([expect.objectContaining({ event: 'gui.close', machine: 'm1', window: 7 })]);
    expect((await t.request('POST', '/m/nope/gui/7/close')).status).toBe(404);
    const bad = await t.request('POST', '/m/m1/gui/4294967296/close');
    expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([400, 'bad_window']);
    const ro = guiHub({ readOnly: true });
    const res = await ro.request('POST', '/m/m1/gui/7/close', { origin: 'http://127.0.0.1:7780' });
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([403, 'read_only']);
  });

  test('states', async () => {
    const t = guiHub();
    const res = await t.request('GET', '/api/gui');
    expect([res.status, await res.text()]).toEqual([200, '[]']);
    t.mgr().display(t.machines.get('m1')!);
    expect(await (await t.request('GET', '/api/gui')).json()).toEqual([{ m: 'm1', phase: 'starting', windows: [] }]);
  });

  // A program window's page is the app shell, with its policy, whatever
  // the machine.
  test('page', async () => {
    const t = guiHub();
    const res = await t.request('GET', '/m/x/gui/1', { host: 'localhost:7780' });
    expect([res.status, await res.text()]).toEqual([200, '<html></html>']);
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(csp).toContain("; frame-src 'self' http://127.0.0.1:*; ");
  });

  // The routes that change something are refused from other sites and in
  // read-only mode.
  test('guards', async () => {
    const { problems, checked } = await checkGuarded(guiHub(), guiHub({ readOnly: true }), { machine: 'm1' });
    expect(problems).toEqual([]);
    expect(checked).toEqual(expect.arrayContaining(['POST /m/:id/gui/:win/close', 'POST /api/m/:id/gui/enable']));
  });

  // Each page starts from every machine's state.
  test('pages', async () => {
    const t = guiHub();
    t.mgr().display(t.machines.get('m1')!);
    const { a, b } = channelPair();
    const got: unknown[] = [];
    a.adopt((ch) => t.hub.pages.connect(ch, { client: 'browser', readOnly: false, who: {} }));
    b.adopt(() => ({ message: (m) => void got.push(JSON.parse(m as string)) }));
    await waitFor('the states', () => got.length > 0);
    expect(got).toEqual([{ t: 'gui', state: { m: 'm1', phase: 'starting', windows: [] } }]);
  });
});

describe('browser windows', () => {
  /** A core whose machine m1 has a display with window 7. */
  async function withWindow(readOnly = false) {
    // Read-only mode attaches only to a display that runs.
    const disp = new FakeDisplay(readOnly ? { running: true, kind: 'xvfb' } : {});
    const machines = testMachines([sshSpec('m1')], { dial: agentDialer({ serve: disp.serve }) });
    const t = guiHub({ readOnly, machines });
    stops.push(running(t.hub));
    const agent = await disp.attached();
    await agent.event({ ev: 'window', window: { id: 7, title: 'plot', w: 640, h: 480 } });
    await waitFor('the window', () => t.mgr().states()[0]?.windows.length === 1);
    return { t, disp, agent };
  }

  test('a window that does not exist', async () => {
    const t = guiHub();
    const w = await openWindow(t, '/m/m1/gui/7/ws');
    expect(w.res.status).toBe(200);
    expect(w.events()).toEqual([{ ev: 'gone', id: 7 }]);
    expect(w.closed()).toEqual([CloseCode.Normal, 'no such window']);
    expect((await t.request('GET', '/m/m1/gui/7/ws')).status).toBe(426);
    const bad = await t.request('GET', '/m/m1/gui/x/ws');
    expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([400, 'bad_window']);
    expect((await t.request('GET', '/m/nope/gui/7/ws')).status).toBe(404);
  });

  // A browser window gets the window and its role, its commands reach
  // the agent as the core builds them, frames reach it; leaving releases
  // the window. Opening is audited.
  test('viewing and input', async () => {
    const { t, agent } = await withWindow();
    const w = await openWindow(t, '/m/m1/gui/7/ws?video=vp8,avc1,BAD');
    expect(w.compress()).toBe(false);
    expect(w.events()).toEqual([
      { ev: 'window', window: { id: 7, title: 'plot', w: 640, h: 480 } },
      { ev: 'role', control: true },
    ]);
    expect(await agent.command(0)).toEqual({ cmd: 'watch', id: 7, codecs: ['avc1', 'vp8'] });
    expect(t.audit.records().find((r) => r.event === 'gui.open')).toMatchObject({ machine: 'm1', window: 7 });
    await agent.frame({ window: 7, layer: 7, x: 0, y: 0, w: 1, h: 1, enc: 2, seq: 1 });
    await waitFor('the frame', () => w.got.some((m) => typeof m !== 'string'));
    w.send(JSON.stringify({ cmd: 'ack', seq: 1 }));
    w.send(JSON.stringify({ cmd: 'pointer', id: 99, x: 3, y: 4, codecs: ['x'] }));
    w.send('not json');
    expect(await agent.command(1)).toEqual({ cmd: 'ack', id: 7, seq: 1 });
    expect(await agent.command(2)).toEqual({ cmd: 'pointer', id: 7, x: 3, y: 4 });
    w.close();
    expect(await agent.command(3)).toEqual({ cmd: 'release', id: 7 });
    expect(await agent.command(4)).toEqual({ cmd: 'unwatch', id: 7 });
  });

  // Closing the browser window closes the program window after a grace.
  test('closing', async () => {
    const { t, agent } = await withWindow();
    const w = await openWindow(t, '/m/m1/gui/7/ws');
    await agent.command(0);
    expect((await t.request('POST', '/m/m1/gui/7/close', { origin: 'http://127.0.0.1:7780' })).status).toBe(204);
    w.close();
    expect(await agent.command(3)).toEqual({ cmd: 'close', id: 7 });
  });

  // In read-only mode a browser window views: no input, no control.
  test('read-only', async () => {
    const { t, agent } = await withWindow(true);
    const w = await openWindow(t, '/m/m1/gui/7/ws');
    await agent.command(0);
    w.send(JSON.stringify({ cmd: 'key', keycode: 38, down: true }));
    w.send(JSON.stringify({ cmd: 'control' }));
    w.send(JSON.stringify({ cmd: 'refresh' }));
    expect(await agent.command(1)).toEqual({ cmd: 'refresh', id: 7 });
    await sleep(20);
    expect(agent.commands.length).toBe(2);
  });

  // A message over the limit ends the connection.
  test('message too big', async () => {
    const { t, agent } = await withWindow();
    const w = await openWindow(t, '/m/m1/gui/7/ws');
    await agent.command(0);
    w.send('x'.repeat((64 << 10) + 1));
    await waitFor('the close', () => w.closed() !== undefined);
    expect(w.closed()![0]).toBe(CloseCode.TooBig);
    expect(await agent.command(2)).toEqual({ cmd: 'unwatch', id: 7 });
  });
});

describe('enable', () => {
  const idle = (pid: number): Shells => ({
    all: () => ['t1'],
    shell: async () => ({ pid, idle: true }),
    send: async () => {},
  });

  test('refusals', async () => {
    let shells: Shells | undefined;
    const disp = new FakeDisplay();
    const machines = testMachines([sshSpec('m1')], { dial: agentDialer({ serve: disp.serve }) });
    const t = guiHub({ machines, gui: { shells: () => shells } });
    const post = async (body?: string) => {
      const res = await t.request('POST', '/api/m/m1/gui/enable', { origin: 'http://127.0.0.1:7780', body });
      return [res.status, ((await res.json()) as { error: string }).error];
    };
    expect(await post('{}')).toEqual([409, 'no_terminals']);
    shells = idle(11);
    expect(await post('{"terminals": "x"}')).toEqual([400, 'invalid']);
    expect(await post('{')).toEqual([400, 'invalid']);
    expect(await post('x'.repeat((64 << 10) + 1))).toEqual([400, 'invalid']);
    expect(await post()).toEqual([409, 'not_ready']);
    t.prefs.set('gui.enabled', 'm1', false);
    expect(await post('{"terminals": null}')).toEqual([409, 'off']);
    expect(t.audit.records()).toEqual([]);
  });

  test('types and audits', async () => {
    const disp = new FakeDisplay();
    disp.procs = [{ pid: 11, comm: 'bash' }];
    const machines = testMachines([sshSpec('m1')], { dial: agentDialer({ serve: disp.serve }) });
    const sent: string[] = [];
    const shells: Shells = { ...idle(11), send: async (_id, text) => void sent.push(text) };
    const t = guiHub({ machines, gui: { shells: () => shells } });
    stops.push(running(t.hub));
    await disp.attached();
    await waitFor('the display', () => t.mgr().states()[0]?.phase === 'ready');
    const res = await t.request('POST', '/api/m/m1/gui/enable', { origin: 'http://127.0.0.1:7780', body: '{"terminals":["t1"]}' });
    expect([res.status, await res.json()]).toEqual([
      200,
      { enabled: 1, already: 0, busy: [], typed: ['t1'], failed: [], command: " export DISPLAY=':20' XAUTHORITY='/h/xauth'" },
    ]);
    expect(sent).toEqual(['\x03', " export DISPLAY=':20' XAUTHORITY='/h/xauth'\r"]);
    expect(t.audit.records().find((r) => r.event === 'gui.enable')).toMatchObject({ machine: 'm1', typed: ['t1'], busy: [], failed: [] });

    // The agent cannot be asked: transport, audited with the error.
    disp.failing.set('shells', 'boom');
    const failed = await t.request('POST', '/api/m/m1/gui/enable', { origin: 'http://127.0.0.1:7780' });
    expect([failed.status, ((await failed.json()) as { error: string }).error]).toEqual([502, 'transport']);
    expect(
      t.audit
        .records()
        .filter((r) => r.event === 'gui.enable')
        .at(-1),
    ).toMatchObject({ error: 'agent gui: boom', typed: [] });
  });
});
