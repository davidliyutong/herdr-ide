// The agents feature's route: its checks before the machine is asked, the
// bound on resolves at once, and what passes from a machine (a fake of the
// Go agent's plugin op) to the page.
import { afterEach, expect, test } from 'bun:test';
import { Op, readBody, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { coreModules } from '#kernel/config/registry.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { enableSetting } from '#kernel/feature.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { agentDialer, checkGuarded, running, sshSpec, testCore, testMachines, waitFor, type TestCore } from '#kernel/testing.ts';
import { agentsFeature, goQuery, MAX_CWD, MAX_RESOLVING } from './core.ts';
import { agentsProtocol, RESOLVE_MS } from './protocol.ts';

const sid1 = 'e6cdc860-1055-488f-9ed2-8b8019061bb9';
const sid2 = '01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3';
const resolveQuery = `kind=claude&session=${sid1}&cwd=/x`;

/** A call a machine got. */
interface Call {
  m: string;
  action: string;
  params: Record<string, unknown>;
  /** Resolves when the core closed the call's stream. */
  closed: Promise<void>;
}

/** The test's machines: what they were asked, and how they answer. Every
 * action waits while block is set (or until the core gives up on it). */
interface Agents {
  calls: Call[];
  block?: Promise<void>;
  reply?: (action: string, params: Record<string, unknown>) => Reply;
}

/** A core with the feature over machines box and gpu, whose agents answer
 * the plugin op as a.reply says. */
async function setup(a: Agents, o: { readOnly?: boolean } = {}) {
  const serve = (m: string) => async (h: Header, conn: AgentStream) => {
    const closed = new Promise<void>((r) => conn.stream.once('close', () => r()));
    try {
      if (h.op !== Op.Plugin || h.plugin !== 'agents') return void (await writeLine(conn.stream, { ok: false, error: 'unsupported' }));
      const params = (h.params_length ? await readBody(conn.reader, h.params_length) : (h.params ?? {})) as Record<string, unknown>;
      a.calls.push({ m, action: h.action ?? '', params, closed });
      if (a.block) await Promise.race([a.block, closed]);
      const rep: Reply = a.reply?.(h.action ?? '', params) ?? { ok: true, plugin: { ok: true } };
      await writeLine(conn.stream, rep).catch(() => {});
    } finally {
      conn.reader.release();
      closeStream(conn.stream);
    }
  };
  const machines = testMachines([sshSpec('box'), sshSpec('gpu'), sshSpec('far', 'far', 'far', false)], {
    dial: async (spec) => {
      const d = agentDialer({ serve: serve(spec.id) });
      return d(spec, new AbortController().signal);
    },
  });
  const tc = testCore({ features: [agentsFeature()], machines, readOnly: o.readOnly, settings: { 'plugins.agents.enabled': true } });
  stops.push(running(tc.core));
  for (const id of ['box', 'gpu']) await waitFor(`${id} ready`, () => machines.get(id)!.ready);
  return tc;
}

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

const resolve = async (tc: TestCore, m: string, q: string, signal?: AbortSignal) => {
  const res = await tc.core.fetch(new Request(`http://127.0.0.1:7780/api/m/${m}/p/agents/resolve?${q}`, { signal }), {
    remote: '127.0.0.1',
    desktop: false,
  });
  return { status: res.status, body: await res.text(), cache: res.headers.get('Cache-Control') };
};
const code = (body: string) => (JSON.parse(body) as { error?: string }).error;

// The feature has no settings of its own: its switch is plugins.agents.enabled, on by default.
test('switch', () => {
  const f = agentsFeature();
  expect([f.id, f.settings, enableSetting(f, 'browser'), enableSetting(f, 'desktop')]).toEqual([
    'agents',
    undefined,
    'plugins.agents.enabled',
    'plugins.agents.enabled',
  ]);
  expect(new Settings('', { modules: coreModules([f]) }).get('plugins.agents.enabled')).toBe(true);
});

// The route is a machine's read: answered in read-only mode, not audited,
// and 404 plugin_disabled while the feature is off.
test('routes', async () => {
  const core = (readOnly: boolean) => testCore({ features: [agentsFeature()], readOnly, settings: { 'plugins.agents.enabled': true } });
  const { problems, checked } = await checkGuarded(core(false), core(true), { machine: 'local' });
  expect([problems, checked]).toEqual([[], []]);
  const ro = core(true);
  expect(ro.core.http.app.routes.filter((r) => r.path.includes('/p/agents')).map((r) => `${r.method} ${r.path}`)).toContain(
    'GET /api/m/:id/p/agents/resolve',
  );
  let r = await resolve(ro, 'local', resolveQuery);
  expect([r.status, code(r.body)]).toEqual([409, 'offline']);
  expect(ro.audit.records().filter((x) => String(x.event).startsWith('agents'))).toEqual([]);
  ro.settings['plugins.agents.enabled'] = false;
  r = await resolve(ro, 'local', resolveQuery);
  expect([r.status, code(r.body)]).toEqual([404, 'plugin_disabled']);
});

// A resolve's kind, session and directory are checked before the machine
// is asked; its answer passes with the reply's members only.
test('resolve', async () => {
  const a: Agents = { calls: [] };
  const tc = await setup(a);
  const bad: Array<Record<string, string>> = [
    {},
    { kind: 'claude', session: sid1 },
    { kind: 'gemini', session: sid1, cwd: '/x' },
    { kind: '', session: sid1, cwd: '/x' },
    { kind: 'claude', session: '../' + sid1, cwd: '/x' },
    { kind: 'claude', session: sid1.toUpperCase(), cwd: '/x' },
    { kind: 'claude', session: sid1, cwd: 'x' },
    { kind: 'claude', session: sid1, cwd: './x' },
    { kind: 'claude', session: sid1, cwd: '~/x' },
    { kind: 'claude', session: sid1, cwd: 'C:\\x' },
    { kind: 'claude', session: sid1, cwd: '' },
    { kind: 'claude', session: sid1, cwd: '/x\0' },
    { kind: 'claude', session: sid1, cwd: '/' + 'a'.repeat(MAX_CWD) },
  ];
  for (const q of bad) {
    const r = await resolve(tc, 'box', new URLSearchParams(q).toString());
    expect([q, r.status, code(r.body)]).toEqual([q, 400, 'bad_request']);
  }
  // A directory that is not UTF-8.
  const r0 = await resolve(tc, 'box', `kind=claude&session=${sid1}&cwd=/%FF`);
  expect([r0.status, code(r0.body)]).toEqual([400, 'bad_request']);
  expect(a.calls).toEqual([]);

  const cwd = '/' + 'a'.repeat(MAX_CWD - 1);
  a.reply = () => ({ ok: true, plugin: { ok: false, code: 'other_cwd', cwd: '/home/u/elsewhere' } });
  const r = await resolve(tc, 'box', new URLSearchParams({ kind: 'codex', session: sid2, cwd }).toString());
  expect([r.status, r.body, r.cache]).toEqual([200, '{"ok":false,"code":"other_cwd"}', 'no-store']);
  expect(a.calls.map(({ m, action, params }) => ({ m, action, params }))).toEqual([
    { m: 'box', action: 'resolve', params: { kind: 'codex', session: sid2, cwd } },
  ]);
  expect(agentsProtocol.actions.resolve.timeoutMs).toBe(RESOLVE_MS);
  // The machine's own failure keeps its code.
  a.reply = () => ({ ok: false, code: 'bad_request', error: 'resolve: bad session' });
  const r2 = await resolve(tc, 'box', resolveQuery);
  expect([r2.status, code(r2.body)]).toEqual([400, 'bad_request']);
  // No session with the machine: offline.
  const r3 = await resolve(tc, 'far', resolveQuery);
  expect([r3.status, code(r3.body)]).toEqual([409, 'offline']);
});

// The request to the machine ends when the page's request does.
test('a resolve ends with its request', async () => {
  const a: Agents = { calls: [], block: new Promise(() => {}) };
  const tc = await setup(a);
  const ac = new AbortController();
  const pending = resolve(tc, 'box', resolveQuery, ac.signal).catch(() => undefined);
  await waitFor('the machine is asked', () => a.calls.length === 1);
  ac.abort();
  await pending;
  await Promise.race([a.calls[0]!.closed, Bun.sleep(3000).then(() => Promise.reject(new Error('the machine is still asked')))]);
  // Its place is free again: MAX_RESOLVING more run at once.
  a.block = undefined;
  expect((await resolve(tc, 'box', resolveQuery)).status).toBe(200);
});

// At most MAX_RESOLVING resolves run at once per machine (more: 429
// busy); another machine is not held up.
test('busy', async () => {
  let release!: () => void;
  const a: Agents = { calls: [], block: new Promise<void>((r) => (release = r)) };
  const tc = await setup(a);
  const flying = Array.from({ length: MAX_RESOLVING }, () => resolve(tc, 'box', resolveQuery));
  await waitFor('all asked', () => a.calls.length === MAX_RESOLVING);
  const over = await resolve(tc, 'box', resolveQuery);
  expect([over.status, code(over.body)]).toEqual([429, 'busy']);
  expect(a.calls.length).toBe(MAX_RESOLVING);
  // Another machine.
  const other = resolve(tc, 'gpu', resolveQuery);
  await waitFor('gpu asked', () => a.calls.length === MAX_RESOLVING + 1);
  release();
  expect((await other).status).toBe(200);
  for (const r of await Promise.all(flying)) expect(r.status).toBe(200);
  a.block = undefined;
  expect((await resolve(tc, 'box', resolveQuery)).status).toBe(200);
});

test('goQuery', () => {
  const q = goQuery('?a=1&a=2&b=x+y&c=%2F%E2%9C%93&d=%FF&e=%zz&f;g=1&h');
  expect([...q]).toEqual([
    ['a', '1'],
    ['b', 'x y'],
    ['c', '/✓'],
    ['d', null],
    ['h', ''],
  ]);
});
