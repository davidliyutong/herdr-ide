// Project Search's route: a read, also in read-only mode; its parameters,
// checked before the machine is asked; what reaches a machine (a fake of
// the Go agent's plugin op) and passes back; its time limit.
import { afterEach, expect, test } from 'bun:test';
import { Op, readBody, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { agentDialer, checkGuarded, running, sshSpec, testHub, testMachines, waitFor } from '#kernel/testing.ts';
import { MAX_BODY, problem, searchFeature, type SearchOptions } from './hub.ts';
import { MAX_GLOBS, MAX_QUERY } from './protocol.ts';

const ON = { 'plugins.search.enabled': true };
const offlineHub = (readOnly = false) =>
  testHub({ features: [searchFeature()], machines: testMachines([sshSpec('far', 'far', 'far', false)]), readOnly, settings: { ...ON } });

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

const errorOf = async (res: Response) => [res.status, ((await res.json()) as { error: string }).error];

// One route, a machine's, that only reads: read-only mode searches too.
test('routes', async () => {
  const { problems, checked } = await checkGuarded(offlineHub(), offlineHub(true), {
    machine: 'far',
    readOnlyAllowed: ['POST /api/m/:id/p/search/search'],
  });
  expect([problems, checked]).toEqual([[], ['POST /api/m/:id/p/search/search']]);
  const ro = offlineHub(true);
  expect(await errorOf(await ro.request('POST', '/api/m/far/p/search/search', { body: '{"dir":"~","query":"a"}' }))).toEqual([
    409,
    'offline',
  ]);
  expect(ro.audit.records().filter((r) => String(r.event).startsWith('search'))).toEqual([]);
});

test('params', async () => {
  const tc = offlineHub();
  for (const body of [
    '',
    'not json',
    '{}',
    'null',
    '{"dir":"~","query":""}',
    '{"dir":"","query":"a"}',
    '{"dir":"~","query":"a\\nb"}',
    `{"dir":"~","query":"${'x'.repeat(MAX_QUERY + 1)}"}`,
    `{"dir":"~","query":"a","include":"${'x'.repeat(MAX_GLOBS + 1)}"}`,
    '{"dir":"~","query":"a","maxResults":-1}',
    '{"dir":"~","query":"a","maxResults":5001}',
    '{"dir":"~","query":"a","regex":"yes"}',
    `{"dir":"~","query":"${'x'.repeat(MAX_BODY)}"}`,
  ]) {
    expect([body.slice(0, 50), ...(await errorOf(await tc.request('POST', '/api/m/far/p/search/search', { body })))]).toEqual([
      body.slice(0, 50),
      400,
      'bad_request',
    ]);
  }
  expect(problem({ dir: '~', query: 'a', include: '*.go', maxResults: 10 })).toBeUndefined();
  // A machine without an agent session answers offline.
  expect(await errorOf(await tc.request('POST', '/api/m/far/p/search/search', { body: '{"dir":"~","query":"a"}' }))).toEqual([
    409,
    'offline',
  ]);
});

/** A hub whose machine x answers the search with reply, after wait. */
async function withMachine(reply: (params: Record<string, unknown>) => Reply, o: SearchOptions & { wait?: Promise<void> } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const closed: Array<Promise<void>> = [];
  const serve = async (h: Header, conn: AgentStream) => {
    closed.push(new Promise((r) => conn.stream.once('close', () => r())));
    try {
      if (h.op !== Op.Plugin || h.plugin !== 'search' || h.action !== 'search')
        return void (await writeLine(conn.stream, { ok: false, error: 'unsupported' }));
      const params = (h.params_length ? await readBody(conn.reader, h.params_length) : (h.params ?? {})) as Record<string, unknown>;
      calls.push(params);
      if (o.wait) await Promise.race([o.wait, closed.at(-1)]);
      await writeLine(conn.stream, reply(params)).catch(() => {});
    } finally {
      conn.reader.release();
      closeStream(conn.stream);
    }
  };
  const machines = testMachines([sshSpec('x')], { dial: agentDialer({ serve }) });
  const tc = testHub({ features: [searchFeature(o)], machines, settings: { ...ON } });
  stops.push(running(tc.hub));
  await waitFor('x ready', () => machines.get('x')!.ready);
  return { tc, calls, closed };
}

test('through the machine', async () => {
  const result = {
    engine: 'rg',
    dir: '/home/u/p',
    files: [{ path: 'a.go', matches: [{ line: 1, col: 2, preview: 'xab', ranges: [[1, 2]] }] }],
    matchCount: 1,
    truncated: true,
    reason: 'max_results',
  };
  const { tc, calls } = await withMachine((p) =>
    p.query === 'bad(' ? { ok: false, code: 'bad_regex', error: 'bad_regex: missing )' } : { ok: true, plugin: result },
  );
  let res = await tc.request('POST', '/api/m/x/p/search/search', {
    body: '{"dir":"~/p","query":"ab","regex":false,"caseSensitive":true,"include":"","maxResults":0,"other":1}',
  });
  expect([res.status, res.headers.get('Cache-Control'), await res.json()]).toEqual([200, 'no-store', result]);
  res = await tc.request('POST', '/api/m/x/p/search/search', { body: '{"dir":"~","query":"bad(","regex":true,"maxResults":10}' });
  expect([res.status, await res.json()]).toEqual([400, { error: 'bad_regex', message: 'bad_regex: missing )' }]);
  expect(calls).toEqual([
    { dir: '~/p', query: 'ab', caseSensitive: true },
    { dir: '~', query: 'bad(', regex: true, maxResults: 10 },
  ]);
});

// A search the machine does not answer in time is a 504; the machine's
// stream ends with it.
test('timeout', async () => {
  const { tc, closed } = await withMachine(() => ({ ok: true, plugin: {} }), { timeoutMs: 100, wait: new Promise(() => {}) });
  const res = await tc.request('POST', '/api/m/x/p/search/search', { body: '{"dir":"~","query":"a"}' });
  expect([res.status, await res.json()]).toEqual([504, { error: 'timeout', message: 'the machine did not answer in time' }]);
  await closed[0];
});
