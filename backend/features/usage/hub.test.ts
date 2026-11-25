// The feature's routes in a core whose machines' agents answer the usage
// actions as the Go agent does (the Go core's session_test.go and the
// routes of usage_test.go): what is guarded, the ETags, the refresh, the
// DeepSeek key, and a session's numbers.
import { afterEach, expect, test } from 'bun:test';
import { discard } from '#shared/lib/log.ts';
import { Op, readBody, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { coreModules } from '#kernel/config/registry.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { createCore } from '#kernel/hub.ts';
import { Guard } from '#kernel/http/guard.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { agentDialer, checkGuarded, memoryAudit, running, sshSpec, testCore, testMachines, waitFor } from '#kernel/testing.ts';
import { MAX_SESSION_READS, sessionProvider, usageFeature } from './hub.ts';

const SESSION = 'e6cdc860-1055-488f-9ed2-8b8019061bb9';
const SWITCH = 'plugins.usage.enabled';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

test('guards', async () => {
  const core = (readOnly: boolean) =>
    testCore({
      features: [usageFeature()],
      machines: testMachines([sshSpec('x', 'x', 'x', false)]),
      readOnly,
      settings: { [SWITCH]: true },
    });
  const { problems, checked } = await checkGuarded(core(false), core(true), { machine: 'x' });
  expect(problems).toEqual([]);
  expect(checked.sort()).toEqual(['POST /api/p/usage/refresh', 'PUT /api/m/:id/p/usage/deepseek-key']);
});

test('the kinds whose sessions are priced', () => {
  expect(['claude', 'codex', 'opencode', 'gemini', 'kimi', 'grok', 'Claude', ''].map(sessionProvider)).toEqual([
    'claude',
    'codex',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

type Answer = (action: string, params: Record<string, unknown>) => Reply | Promise<Reply>;

/** A core with the feature whose machines box and gpu answer with answer
 * (far is off); every call is recorded. */
async function withCore(answer: Answer, readOnly = false) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const serve = async (h: Header, conn: AgentStream) => {
    try {
      if (h.op !== Op.Plugin || h.plugin !== 'usage') return void (await writeLine(conn.stream, { ok: false, error: 'unsupported' }));
      const params = (h.params_length ? await readBody(conn.reader, h.params_length) : (h.params ?? {})) as Record<string, unknown>;
      calls.push([h.action ?? '', params]);
      await writeLine(conn.stream, await answer(h.action ?? '', params)).catch(() => {});
    } finally {
      conn.reader.release();
      closeStream(conn.stream);
    }
  };
  const machines = testMachines([sshSpec('box'), sshSpec('gpu'), sshSpec('far', 'far', 'far', false)], { dial: agentDialer({ serve }) });
  const st = new Settings('', { modules: coreModules([usageFeature()]) });
  const audit = memoryAudit();
  const core = createCore({
    guard: new Guard(),
    audit: audit.audit,
    readOnly,
    logger: discard,
    machines,
    settings: st,
    features: [usageFeature({ tickMs: 20, status: () => Promise.reject(new Error('no status pages in tests')) })],
  });
  stops.push(running(core));
  await waitFor('machines ready', () => machines.get('box')!.ready && machines.get('gpu')!.ready);
  const request = (method: string, path: string, o: { body?: string; headers?: Record<string, string> } = {}) =>
    core.fetch(new Request(`http://127.0.0.1:7780${path}`, { method, body: o.body, headers: { Host: '127.0.0.1:7780', ...o.headers } }), {
      remote: '127.0.0.1',
      desktop: false,
    });
  return { request, calls, st, audit, of: (action: string) => calls.filter(([a]) => a === action).map(([, p]) => p) };
}

const usageOf = (model = 'claude-opus-5-5') =>
  ({
    ok: true,
    plugin: { model, input: 10, cached: 2000, cacheWrite: 300, output: 40, requests: 2, cost: 0.5, priced: true, contextUsed: 2310 },
  }) satisfies Reply;

/** The agents' default answers. */
const answers: Answer = (action) => {
  switch (action) {
    case 'limits':
      return {
        ok: true,
        plugin: { accounts: [{ provider: 'claude', id: 'acc-1', status: 'ok', windows: [{ kind: 'weekly', usedPct: 40 }] }] },
      };
    case 'cost':
      return {
        ok: true,
        plugin: { files: 1, etag: 'e1', rows: [{ day: '2026-11-16', provider: 'claude', model: 'm', cost: 1, priced: true }] },
      };
    case 'setDeepseekKey':
      return { ok: true, plugin: { set: true } };
    case 'session':
      return usageOf();
  }
  return { ok: false, code: 'bad_params', error: 'unknown' };
};

// The scheduler polls the machines once they connect; the snapshot and the
// spend answer 304 to their ETags.
test('snapshot and spend', async () => {
  const { request, of } = await withCore(answers);
  await waitFor('a poll', () => of('limits').length >= 2);
  // The second machine is told to skip the account the first read.
  expect(of('limits')[1]).toMatchObject({ skip: ['claude:acc-1'] });
  let res = await request('GET', '/api/p/usage?watch=1');
  const etag = res.headers.get('ETag')!;
  const s = (await res.json()) as { accounts: { key: string; machines: string[] }[] };
  expect(s.accounts.map((a) => [a.key, a.machines])).toEqual([['claude:acc-1', ['box', 'gpu']]]);
  res = await request('GET', '/api/p/usage', { headers: { 'If-None-Match': etag } });
  expect([res.status, await res.text(), res.headers.get('ETag')]).toEqual([304, '', etag]);

  res = await request('GET', '/api/p/usage/cost?days=7&tz=480');
  const cost = (await res.json()) as { days: number; tzOffset: number; rows: { machine: string }[] };
  expect([cost.days, cost.tzOffset, cost.rows.map((r) => r.machine)]).toEqual([7, 480, ['box', 'gpu']]);
  const costTag = res.headers.get('ETag')!;
  res = await request('GET', '/api/p/usage/cost?days=7&tz=480', { headers: { 'If-None-Match': costTag } });
  expect(res.status).toBe(304);
  // Days and the time zone are bounded.
  res = await request('GET', '/api/p/usage/cost?days=900&tz=9999');
  expect(((await res.json()) as { days: number; tzOffset: number }).days).toBe(90);
  expect(of('cost').at(-1)).not.toHaveProperty('tzOffset');
});

test('refresh and the DeepSeek key', async () => {
  const { request, of, audit } = await withCore(answers);
  let res = await request('POST', '/api/p/usage/refresh');
  const r = (await res.json()) as { queued: boolean; at: number };
  expect([res.status, r.queued, typeof r.at]).toEqual([202, true, 'number']);
  res = await request('PUT', '/api/m/box/p/usage/deepseek-key', { body: JSON.stringify({ key: 'sk-secret' }) });
  expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  expect(of('setDeepseekKey')).toEqual([{ key: 'sk-secret' }]);
  res = await request('PUT', '/api/m/box/p/usage/deepseek-key', { body: 'x'.repeat(5000) });
  expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, 'bad_request']);
  // The key is not audited.
  expect(audit.text()).not.toContain('sk-secret');
  expect(audit.records().map((a) => a.event)).toEqual(['usage.refresh', 'usage.deepseek_key', 'usage.deepseek_key']);
});

const session = (request: Awaited<ReturnType<typeof withCore>>['request'], kind: string, id: string, m = 'box') =>
  request('GET', `/api/m/${m}/p/usage/session?${new URLSearchParams({ kind, session: id })}`);

test('a session’s numbers', async () => {
  const marker = 'MARKER-a71d';
  const { request, of, st } = await withCore((action, p) =>
    action === 'session'
      ? {
          ok: true,
          plugin: {
            model: 'gpt-6.1-sol',
            input: 7,
            cached: 0,
            cacheWrite: 0,
            output: 3,
            requests: 1,
            cost: 0.01,
            priced: true,
            text: marker,
            path: marker,
          },
        }
      : answers(action, p),
  );
  st.set('usage.prices', '', ['gpt-6.1-sol 3 0.3 20']);
  const res = await session(request, 'codex', SESSION);
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).not.toContain(marker);
  expect(JSON.parse(body)).toEqual({
    model: 'gpt-6.1-sol',
    input: 7,
    cached: 0,
    cacheWrite: 0,
    output: 3,
    requests: 1,
    cost: 0.01,
    priced: true,
  });
  expect(of('session')).toEqual([
    { kind: 'codex', session: SESSION, prices: { 'gpt-6.1-sol': { inputMax: null, input: 3, cached: 0.3, output: 20 } } },
  ]);
});

// Only a kind whose sessions are priced and a session id reach the machine.
test('a session’s params', async () => {
  const { request, of } = await withCore(answers, true);
  for (const [kind, id] of [
    ['', SESSION],
    ['nope', SESSION],
    ['Claude', SESSION],
    ['gemini', SESSION],
    ['opencode', SESSION],
    ['claude', ''],
    ['claude', '../x'],
    ['claude', SESSION.toUpperCase()],
    ['claude', SESSION.slice(0, 35)],
    ['claude', SESSION + '\n'],
    ['claude', SESSION + '/../../etc/passwd'],
    ['claude', '$(id)'],
  ]) {
    const res = await session(request, kind!, id!);
    expect([kind, id, res.status, ((await res.json()) as { error: string }).error]).toEqual([kind, id, 400, 'bad_request']);
  }
  expect(of('session')).toEqual([]);
  // Valid ones are asked, also of a read-only core.
  for (const kind of ['claude', 'codex']) expect((await session(request, kind, SESSION)).status).toBe(200);
  expect(of('session')).toEqual([
    { kind: 'claude', session: SESSION },
    { kind: 'codex', session: SESSION },
  ]);
});

test('a session of a provider turned off', async () => {
  const { request, of, st } = await withCore(answers);
  st.set('usage.providers.claude', '', false);
  const res = await session(request, 'claude', SESSION);
  expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([404, 'provider_off']);
  expect((await session(request, 'codex', SESSION)).status).toBe(200);
  expect(of('session').map((p) => p.kind)).toEqual(['codex']);
});

test('a session’s failures', async () => {
  let fail: Reply = { ok: false };
  const { request } = await withCore((action, p) => (action === 'session' ? fail : answers(action, p)));
  for (const [code, status] of [
    ['not_found', 404],
    ['too_large', 400],
    ['compressed', 400],
  ] as const) {
    fail = { ok: false, code, error: 'usage: …' };
    const res = await session(request, 'claude', SESSION);
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([status, code]);
  }
  const res = await session(request, 'claude', SESSION, 'far');
  expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([409, 'offline']);
});

// At most MAX_SESSION_READS session requests are under way per machine
// (more: 429 busy, the machine not asked); another machine is not held up,
// and a request ended gives its place back.
test('a machine busy reading sessions', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { request, of } = await withCore(async (action, p) => {
    if (action !== 'session') return answers(action, p);
    if (of('session').length <= MAX_SESSION_READS) await gate;
    return usageOf();
  });
  const held = Array.from({ length: MAX_SESSION_READS }, () => session(request, 'claude', SESSION));
  await waitFor('the reads under way', () => of('session').length === MAX_SESSION_READS);
  let res = await session(request, 'claude', SESSION);
  expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([429, 'busy']);
  expect(of('session')).toHaveLength(MAX_SESSION_READS);
  // Another machine is not held up.
  res = await session(request, 'claude', SESSION, 'gpu');
  expect(res.status).toBe(200);
  release();
  expect((await Promise.all(held)).map((r) => r.status)).toEqual(Array(MAX_SESSION_READS).fill(200));
  expect((await session(request, 'claude', SESSION)).status).toBe(200);
});
