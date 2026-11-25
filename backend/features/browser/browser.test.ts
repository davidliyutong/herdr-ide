// The browser pane's port forwards: listeners on the core host's loopback
// that carry connections to a machine's port through its agent (a fake of
// the Go agent's dial action, which connects to this host's loopback, so
// the test's services are the machine's), their bounds and their ends;
// the machine's listening ports; the settings.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Op, readBody, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { coreModules } from '#kernel/config/registry.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { createCore } from '#kernel/hub.ts';
import { Guard } from '#kernel/http/guard.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { agentDialer, checkGuarded, localSpec, memoryAudit, running, sshSpec, testCore, testMachines, waitFor } from '#kernel/testing.ts';
import { browserFeature, type BrowserOptions } from './hub.ts';
import { Forwards, listenLoopback, MAX_FORWARDS, temporary } from './forwards.ts';
import { DEFAULT_IDLE, settings } from './settings.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Serves the browser actions as the Go agent does, on this host. */
const browserAgent = (listening: () => Reply) => async (h: Header, conn: AgentStream) => {
  if (h.op !== Op.Plugin || h.plugin !== 'browser') {
    await writeLine(conn.stream, { ok: false, error: 'unsupported' }).catch(() => {});
    conn.reader.release();
    return closeStream(conn.stream);
  }
  const params = (h.params_length ? await readBody(conn.reader, h.params_length) : (h.params ?? {})) as { port?: number };
  if (h.action === 'listening') {
    await writeLine(conn.stream, listening());
    conn.reader.release();
    return closeStream(conn.stream);
  }
  // dial: 127.0.0.1, else ::1.
  const dial = (host: string) =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect({ host, port: params.port ?? 0 });
      s.once('connect', () => resolve(s)).once('error', reject);
    });
  let sock: Socket;
  try {
    sock = await dial('127.0.0.1').catch(() => dial('::1'));
  } catch (e) {
    await writeLine(conn.stream, { ok: false, code: 'refused', error: (e as Error).message }).catch(() => {});
    conn.reader.release();
    return closeStream(conn.stream);
  }
  await writeLine(conn.stream, { ok: true });
  const rest = conn.reader.release();
  const end = () => {
    sock.destroy();
    closeStream(conn.stream);
  };
  sock.on('error', end).on('close', end);
  rest.on('error', end).on('end', end).on('close', end);
  rest.pipe(sock);
  sock.pipe(conn.stream, { end: false });
};

interface Setup {
  request(method: string, path: string, o?: { body?: string; remote?: string }): Promise<{ status: number; body: Record<string, unknown> }>;
  forwards: Forwards;
  settings: Settings;
  audit: ReturnType<typeof memoryAudit>;
  logs: string[];
  forget(m: string): void;
}

/** The feature in a core with two machines: x, an ssh machine whose agent
 * reaches the test's loopback, and the local one (not connected). */
async function setup(o: BrowserOptions & { run?: boolean; listening?: () => Reply } = {}): Promise<Setup> {
  const listening = o.listening ?? (() => ({ ok: true, plugin: { ports: [] } }));
  const machines = testMachines([sshSpec('x'), localSpec('here', false)], { dial: agentDialer({ serve: browserAgent(listening) }) });
  const feature = browserFeature(o);
  const st = new Settings('', { modules: coreModules([feature]) });
  const audit = memoryAudit();
  const logs: string[] = [];
  const core = createCore({
    guard: new Guard(),
    audit: audit.audit,
    readOnly: false,
    logger: (l) => logs.push(l),
    machines,
    settings: st,
    features: [feature],
  });
  // The core's services run only where a test asks; the machines always.
  cleanups.push(o.run ? running(core) : running(machines));
  cleanups.push(() => feature.forwards()!.close());
  await waitFor('x ready', () => machines.get('x')!.ready);
  return {
    async request(method, path, r = {}) {
      const res = await core.fetch(
        new Request(`http://127.0.0.1:7780${path}`, { method, headers: { Host: '127.0.0.1:7780' }, body: r.body }),
        {
          remote: r.remote ?? '127.0.0.1',
          desktop: false,
        },
      );
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    },
    forwards: feature.forwards()!,
    settings: st,
    audit,
    logs,
    forget: (m) => core.forget(m),
  };
}

/** A service on loopback that answers each line with "echo: " and it. */
async function echo(): Promise<number> {
  const srv = createServer((c) => {
    let buf = '';
    c.on('error', () => {});
    c.on('data', (d) => {
      buf += d.toString();
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        c.write(`echo: ${buf.slice(0, i)}\n`);
        buf = buf.slice(i + 1);
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => void srv.close());
  return (srv.address() as AddressInfo).port;
}

/** A connection that reads lines. */
async function dial(host: string, port: number) {
  const s = connect({ host, port });
  s.on('error', () => {});
  await new Promise<void>((resolve, reject) => s.once('connect', () => resolve()).once('error', reject));
  cleanups.push(() => void s.destroy());
  let buf = '';
  const waiters: Array<() => void> = [];
  let ended = false;
  s.on('data', (d) => {
    buf += d.toString();
    for (const w of waiters.splice(0)) w();
  });
  s.on('close', () => {
    ended = true;
    for (const w of waiters.splice(0)) w();
  });
  return {
    s,
    async line(text: string): Promise<string> {
      s.write(text + '\n');
      const deadline = Date.now() + 5000;
      while (!buf.includes('\n')) {
        if (ended || Date.now() > deadline) throw new Error(`no answer to ${text}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
      const i = buf.indexOf('\n');
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      return l;
    },
    /** Whether the other side closed it within 5 s. */
    ended: () =>
      waitFor('the connection to end', () => ended).then(
        () => true,
        () => false,
      ),
  };
}

const refusedAt = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect({ host, port });
    s.once('connect', () => {
      s.destroy();
      resolve(false);
    });
    s.once('error', () => resolve(true));
  });

const forward = async (t: Setup, port: number) => {
  const r = await t.request('POST', '/api/m/x/p/browser/forwards', { body: JSON.stringify({ port }) });
  if (r.status !== 200) throw new Error(`forward of ${port}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.local as number;
};

// A forward listens on the core host's loopback and carries connections to
// the machine's port; it is found again, listed, and ends when stopped,
// with its connections.
test('forward', async () => {
  const t = await setup();
  const port = await echo();
  const local = await forward(t, port);
  // The machine is this host here: the service holds its own port and the
  // forward listens on another.
  expect(local !== port && local >= 1024).toBe(true);
  const c = await dial('127.0.0.1', local);
  expect(await c.line('hello')).toBe('echo: hello');
  // On ::1 too, where "localhost" may lead, when the host has it.
  if (t.forwards.entry('x', port)!.servers.length === 2) expect(await (await dial('::1', local)).line('six')).toBe('echo: six');
  // Asked again it is the same one.
  expect(await forward(t, port)).toBe(local);
  let r = await t.request('GET', '/api/p/browser/forwards');
  expect(r.body).toMatchObject({ forwards: [{ m: 'x', port, local }], available: true });
  expect(typeof (r.body.forwards as Array<{ created: string }>)[0]!.created).toBe('string');
  r = await t.request('GET', '/api/p/browser/forwards', { remote: '10.0.0.5' });
  expect(r.body.available).toBe(false);
  expect(t.audit.records().map((a) => [a.event, a.port, a.local, a.status])).toEqual([
    ['browser.forward', port, local, 200],
    ['browser.forward', port, local, 200],
  ]);
  // Stopping ends the listener and the open connections.
  r = await t.request('DELETE', `/api/m/x/p/browser/forwards/${port}`);
  expect([r.status, r.body]).toEqual([200, { ok: true }]);
  expect(t.audit.records().at(-1)).toMatchObject({ event: 'browser.forward_stop', machine: 'x', port: String(port), status: 200 });
  expect(await c.ended()).toBe(true);
  expect(await refusedAt('127.0.0.1', local)).toBe(true);
  r = await t.request('DELETE', `/api/m/x/p/browser/forwards/${port}`);
  expect([r.status, r.body.error]).toEqual([404, 'not_found']);
  r = await t.request('DELETE', '/api/m/x/p/browser/forwards/http');
  expect([r.status, r.body.error]).toEqual([400, 'bad_request']);
});

// Asks for the same port at once make one forward; one that failed to
// listen leaves the next ask to try again.
test('one forward per port', async () => {
  let fail = true;
  const t = await setup({
    listen: async (pref) => {
      await Bun.sleep(10);
      if (fail) throw new Error('no port');
      return listenLoopback(pref);
    },
  });
  const port = await echo();
  const ask = () => t.request('POST', '/api/m/x/p/browser/forwards', { body: JSON.stringify({ port }) });
  const failed = await Promise.all([ask(), ask()]);
  expect(failed.map((r) => [r.status, r.body.error])).toEqual([
    [400, 'listen'],
    [400, 'listen'],
  ]);
  fail = false;
  const made = await Promise.all([ask(), ask(), ask()]);
  expect(new Set(made.map((r) => r.body.local)).size).toBe(1);
  expect(t.forwards.list().length).toBe(1);
});

// Forwards are for clients on the core's host and for other machines'
// ports; a port nothing answers on closes its connections.
test('refusals', async () => {
  const t = await setup();
  const port = await echo();
  const body = JSON.stringify({ port });
  let r = await t.request('POST', '/api/m/x/p/browser/forwards', { body, remote: '10.0.0.5' });
  expect([r.status, r.body.error]).toEqual([403, 'forward_local_only']);
  r = await t.request('POST', '/api/m/local/p/browser/forwards', { body });
  expect([r.status, r.body.error]).toEqual([400, 'local_machine']);
  for (const bad of ['{"port":0}', '{"port":65536}', '{"port":-1}', '{}', '{"port":"80"}', '{"port":80.5}', 'x', '']) {
    r = await t.request('POST', '/api/m/x/p/browser/forwards', { body: bad });
    expect([bad, r.status, r.body.error]).toEqual([bad, 400, 'bad_request']);
  }
  expect(t.forwards.list()).toEqual([]);
  // A port without a service: the forward exists, its connections end.
  const srv = createServer();
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
  const dead = (srv.address() as AddressInfo).port;
  await new Promise((res) => srv.close(res));
  const local = await forward(t, dead);
  const c = await dial('127.0.0.1', local);
  expect(await c.ended()).toBe(true);
});

/** A clock the test moves. */
const clock = () => {
  const c = { t: Date.now(), now: () => c.t };
  return c;
};

const MIN = 60_000;

// Forwards end unused after the idle time, when their machine is removed,
// and are bounded.
test('ends and bounds', async () => {
  const c = clock();
  const t = await setup({ now: c.now });
  const port = await echo();
  await forward(t, port);
  c.t += (DEFAULT_IDLE - 1) * MIN;
  t.forwards.reap(DEFAULT_IDLE * MIN);
  expect(t.forwards.list().length).toBe(1);
  c.t += 2 * MIN;
  t.forwards.reap(DEFAULT_IDLE * MIN);
  expect(t.forwards.list().length).toBe(0);
  // A removed machine's forwards end.
  await forward(t, port);
  t.forget('other');
  expect(t.forwards.list().length).toBe(1);
  t.forget('x');
  expect(t.forwards.list().length).toBe(0);
  // At most MAX_FORWARDS.
  for (let i = 0; i < MAX_FORWARDS; i++) await forward(t, 20000 + i);
  const r = await t.request('POST', '/api/m/x/p/browser/forwards', { body: '{"port":19999}' });
  expect([r.status, r.body.error]).toEqual([400, 'too_many']);
});

// What keeps a forward is its use: a connection accepted, bytes carried,
// a client asking for it. A connection that only stays open keeps
// nothing: the forward ends idle with it, and closes it.
test('idle is about use', async () => {
  const c = clock();
  const t = await setup({ now: c.now });
  const port = await echo();
  const local = await forward(t, port);
  const almost = (DEFAULT_IDLE - 1) * MIN;
  const rest = 2 * MIN;
  const stays = (what: string) => {
    t.forwards.reap(DEFAULT_IDLE * MIN);
    expect([what, t.forwards.list().length]).toEqual([what, 1]);
  };
  // Asking for it again is a use.
  c.t += almost;
  await forward(t, port);
  c.t += rest;
  stays('asked for again');
  // A connection accepted is one.
  c.t += almost - rest;
  const conn = await dial('127.0.0.1', local);
  await waitFor('the connection', () => t.forwards.entry('x', port)!.conns === 1);
  c.t += rest;
  stays('a connection accepted');
  // Bytes carried are one, in a connection as old as it may be.
  c.t += almost - rest;
  await conn.line('still here');
  c.t += rest;
  stays('bytes carried');
  // They are noted at most every second.
  c.t += 1000;
  await conn.line('one');
  const first = t.forwards.entry('x', port)!.used;
  expect(first).toBe(c.t);
  c.t += 500;
  await conn.line('two');
  expect(t.forwards.entry('x', port)!.used).toBe(first);
  // The connection stays open and carries nothing: the forward ends with it.
  c.t += almost;
  stays('not idle long enough');
  c.t += rest;
  t.forwards.reap(DEFAULT_IDLE * MIN);
  expect(t.forwards.list().length).toBe(0);
  expect(await conn.ended()).toBe(true);
  expect(await refusedAt('127.0.0.1', local)).toBe(true);
});

// The service reaps with the setting's time; at 0 forwards stay until
// stopped, with the feature off none does, and none outlives the core.
test('reaper', async () => {
  const c = clock();
  const t = await setup({ now: c.now, run: true, reapEveryMs: 10 });
  const port = await echo();
  t.settings.set('browser.forwardIdle', '', 5);
  await forward(t, port);
  c.t += 4 * MIN;
  await Bun.sleep(50);
  expect(t.forwards.list().length).toBe(1);
  c.t += 2 * MIN;
  await waitFor('reaped', () => t.forwards.list().length === 0);
  t.settings.set('browser.forwardIdle', '', 0);
  await forward(t, port);
  c.t += 48 * 60 * MIN;
  await Bun.sleep(50);
  expect(t.forwards.list().length).toBe(1);
  t.settings.set('plugins.browser.enabled', '', false);
  await waitFor('ended with the feature off', () => t.forwards.list().length === 0);
  t.settings.set('plugins.browser.enabled', '', true);
  const local = await forward(t, port);
  await cleanups.shift()!(); // the core stops
  expect(t.forwards.list()).toEqual([]);
  expect(await refusedAt('127.0.0.1', local)).toBe(true);
  // A stopped core makes none.
  const r = await t.request('POST', '/api/m/x/p/browser/forwards', { body: JSON.stringify({ port }) });
  expect([r.status, r.body.error]).toEqual([400, 'listen']);
});

// A forward carries at most maxConns connections at a time: one more is
// closed at once, the earlier ones go on, and a place that is freed is
// taken again.
test('connections bound', async () => {
  const t = await setup({ maxConns: 2 });
  const port = await echo();
  const local = await forward(t, port);
  const a = await dial('127.0.0.1', local);
  const b = await dial('127.0.0.1', local);
  expect([await a.line('a'), await b.line('b')]).toEqual(['echo: a', 'echo: b']);
  await waitFor('two connections', () => t.forwards.entry('x', port)!.conns === 2);
  const over = await dial('127.0.0.1', local);
  over.s.write('over\n');
  expect(await over.ended()).toBe(true);
  expect(t.forwards.list()[0]!.connections).toBe(2);
  expect([await a.line('a again'), await b.line('b again')]).toEqual(['echo: a again', 'echo: b again']);
  a.s.destroy();
  await waitFor('one connection', () => t.forwards.entry('x', port)!.conns === 1);
  expect(await (await dial('127.0.0.1', local)).line('after')).toBe('echo: after');
  expect(await b.line('b still')).toBe('echo: b still');
});

// A listener's failure that passes keeps its forward; one for good ends
// it, with every listener and connection of its own, and says so.
test('listener failures', async () => {
  const sys = (code: string) => Object.assign(new Error(`accept ${code}`), { code, syscall: 'accept' });
  for (const code of ['EMFILE', 'ENFILE', 'ECONNABORTED', 'ETIMEDOUT']) expect([code, temporary(sys(code))]).toEqual([code, true]);
  for (const e of [sys('EINVAL'), sys('EBADF'), new Error('broken'), null]) expect(temporary(e)).toBe(false);

  const t = await setup();
  const port = await echo();
  const local = await forward(t, port);
  const other = await forward(t, port + 1 > 65535 ? 1024 : port + 1);
  const c = await dial('127.0.0.1', local);
  await c.line('hi');
  const servers = t.forwards.entry('x', port)!.servers;
  servers[0]!.emit('error', sys('EMFILE'));
  expect(t.forwards.list().length).toBe(2);
  servers[0]!.emit('error', sys('EINVAL'));
  expect(t.forwards.list().map((f) => f.local)).toEqual([other]);
  expect(await c.ended()).toBe(true);
  for (const s of servers) expect(s.listening).toBe(false);
  expect(t.logs.join('\n')).toContain(`browser: the forward of port ${port} of x ended: accept EINVAL`);
  // Stopping says nothing.
  t.logs.length = 0;
  t.forwards.close();
  expect(t.logs).toEqual([]);
});

// The forward listens on the port asked for when it is free, on loopback
// only, never on a port whose ::1 side another program holds.
test('listenLoopback', async () => {
  const closeAll = (ss: Server[]) => ss.forEach((s) => s.close());
  const listenAt = (host: string, port = 0) =>
    new Promise<Server>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject).listen({ host, port, ipv6Only: host.includes(':') }, () => resolve(s));
    });
  const probe = await listenAt('127.0.0.1');
  const free = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  let l = await listenLoopback(free);
  expect(l.local).toBe(free);
  for (const s of l.servers) expect(['127.0.0.1', '::1']).toContain((s.address() as AddressInfo).address);
  closeAll(l.servers);
  // Taken on 127.0.0.1: another port.
  const held = await listenAt('127.0.0.1');
  cleanups.push(() => void held.close());
  const taken = (held.address() as AddressInfo).port;
  l = await listenLoopback(taken);
  expect(l.local).not.toBe(taken);
  closeAll(l.servers);
  // Taken on ::1 only: not used either, or "localhost" could lead there.
  const six = await listenAt('::1').catch(() => null);
  if (six) {
    cleanups.push(() => void six.close());
    const p6 = (six.address() as AddressInfo).port;
    l = await listenLoopback(p6);
    expect(l.local).not.toBe(p6);
    closeAll(l.servers);
  }
  // A port of the system's is not asked for.
  l = await listenLoopback(80);
  expect(l.local).not.toBe(80);
  closeAll(l.servers);
});

// The machine's listening ports, with only their port and process.
test('listening', async () => {
  let reply: Reply = {
    ok: true,
    plugin: {
      ports: [
        { port: 3000, process: 'node', pid: 7 },
        { port: 5432, process: '' },
      ],
    },
  };
  const t = await setup({ listening: () => reply });
  let r = await t.request('GET', '/api/m/x/p/browser/listening');
  expect([r.status, r.body]).toEqual([200, { ports: [{ port: 3000, process: 'node' }, { port: 5432 }] }]);
  reply = { ok: true, plugin: { ports: null } };
  r = await t.request('GET', '/api/m/x/p/browser/listening');
  expect(r.body).toEqual({ ports: [] });
  r = await t.request('GET', '/api/m/local/p/browser/listening');
  expect([r.status, r.body.error]).toEqual([409, 'offline']);
});

// The guards: the forwards' changes are refused to other sites and in
// read-only mode; the reads are not.
test('guards', async () => {
  const core = (readOnly: boolean) =>
    testCore({
      features: [browserFeature()],
      machines: testMachines([sshSpec('x', 'x', 'x', false)]),
      readOnly,
      settings: { 'plugins.browser.enabled': true },
    });
  const { problems, checked } = await checkGuarded(core(false), core(true), { machine: 'x' });
  expect(problems).toEqual([]);
  expect(checked.sort()).toEqual(['DELETE /api/m/:id/p/browser/forwards/:port', 'POST /api/m/:id/p/browser/forwards']);
});

// The links' setting: loopback addresses in a pane by default; anything
// else is no value of it.
test('settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-settings-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const load = (content: string) => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, content);
    const st = new Settings(path, { modules: [settings] });
    st.load();
    return st;
  };
  expect(load('{}').get('browser.openLinks')).toBe('loopback');
  for (const v of ['all', 'external', 'loopback']) expect(load(`{"browser.openLinks": "${v}"}`).get('browser.openLinks')).toBe(v);
  const st = load('{"browser.openLinks": "tab"}');
  expect([st.get('browser.openLinks'), st.state().problems.length]).toEqual(['loopback', 1]);
  expect(new Settings('', { modules: [settings] }).get('browser.forwardIdle')).toBe(DEFAULT_IDLE);
});
