// The usage feature's machine side through the wire: the actions as the
// hub calls them (#kernel/agent.ts, the protocol's schemas checking the
// results), their refusals and codes, one hub's limits answering
// another's, no credential in a reply or an error.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { call } from '#kernel/agent.ts';
import { Fail } from '#shared/lib/fail.ts';
import { Op } from '#shared/proto/agentproto/index.ts';
import { machineOf, rig, type Rig } from '#machine/testing.ts';
import { FakeAPI, TEST_NOW, jwt, removeHomes, write } from './testdata/machine.ts';
import { openRegular } from './machine/logs.ts';
import { usageMachine, type UsageMachineOptions } from './machine.ts';
import { usageProtocol } from './protocol.ts';

let r: Rig | undefined;
const apis: FakeAPI[] = [];
afterEach(async () => {
  await r?.close();
  r = undefined;
  for (const a of apis.splice(0)) a.stop();
});
afterAll(removeHomes);

/** An agent with the usage feature on a home of the test's own: no
 * environment of the user's, no program of the machine's. */
async function start(o: UsageMachineOptions = {}) {
  const api = new FakeAPI();
  apis.push(api);
  r = await rig({
    features: [
      usageMachine({
        urls: api.urls(),
        environ: () => ({}),
        platform: 'linux',
        now: () => TEST_NOW,
        programs: { security: '/nonexistent/security', ps: '/nonexistent/ps', lsof: '/nonexistent/lsof', extraPath: [] },
        ...o,
      }),
    ],
  });
  const m = machineOf(r.session);
  return { api, home: r.home, base: r.dirs.base, m };
}

/** The refusal's code of a call, as the hub sees it. */
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Fail) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error('not refused');
};

const raw = async (action: string, params: unknown) => {
  try {
    await r!.session.request({ op: Op.Plugin, plugin: 'usage', action, params } as never);
    return { ok: true };
  } catch (e) {
    return (e as { reply?: { code?: string; error?: string } }).reply ?? { code: 'failed' };
  }
};

describe('the actions', () => {
  test('nothing signed in, no logs: missing, no rows; the key file written, never read back', async () => {
    const { base, m } = await start();
    const lim = await call(m, usageProtocol, 'limits', { providers: ['claude', 'kimi'] });
    expect(lim.accounts.map((a) => [a.provider, a.status])).toEqual([
      ['claude', 'missing'],
      ['kimi', 'missing'],
    ]);
    const cost = await call(m, usageProtocol, 'cost', { since: 0 });
    expect(cost.rows).toEqual([]);
    expect(cost.etag).toBeTruthy();
    expect(await call(m, usageProtocol, 'setDeepseekKey', { key: 'sk-abc' })).toEqual({ set: true });
    expect(readFileSync(join(base, 'usage/deepseek.key'), 'utf8').trim()).toBe('sk-abc');
    expect(statSync(join(base, 'usage/deepseek.key')).mode & 0o777).toBe(0o600);
    const bad = await refusal(call(m, usageProtocol, 'setDeepseekKey', { key: 'two words' }));
    expect(bad.code).toBe('bad_key');
    expect(bad.message).not.toContain('two words');
    expect(await call(m, usageProtocol, 'setDeepseekKey', { key: '' })).toEqual({ set: undefined });
    expect(() => statSync(join(base, 'usage/deepseek.key'))).toThrow();
    expect(await raw('nope', {})).toMatchObject({ code: 'bad_params' });
    expect(await raw('limits', [1])).toMatchObject({ code: 'bad_params' });
  });

  test('the user’s prices only as usage.prices holds them', async () => {
    await start();
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`m${i}`, { inputMax: null, input: 1, cached: 0, output: 1 }]));
    for (const prices of [
      many,
      { '': { inputMax: null, input: 1, cached: 0, output: 1 } },
      { 'grok-5': { inputMax: null, input: -1, cached: 0, output: 1 } },
      { 'grok-5': { inputMax: 5, input: 1, cached: 0, output: 1 } },
      { 'grok-5': { inputMax: null, input: 1, cached: 0, output: 1, cacheWrite: 20000 } },
    ])
      expect(await raw('cost', { since: 0, prices })).toMatchObject({ code: 'bad_params' });
    expect(await raw('cost', { since: 0, prices: { 'grok-5': { inputMax: null, input: 3, cached: 0.75, output: 9 } } })).toEqual({
      ok: true,
    });
  });

  test('the spend of a Claude Code log and of OpenCode’s database', async () => {
    const { home, m } = await start();
    write(
      join(home, '.claude/projects/-work/s.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(TEST_NOW - 3600_000).toISOString(),
        cwd: '/work',
        message: { role: 'assistant', id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 1_000_000, output_tokens: 100_000 } },
      }) + '\n',
    );
    const db = join(home, '.local/share/opencode/opencode.db');
    write(db, '');
    const d = new DatabaseSync(db);
    d.exec('CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text)');
    d.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
      'm1',
      's',
      TEST_NOW,
      TEST_NOW,
      JSON.stringify({
        role: 'assistant',
        time: { created: TEST_NOW },
        modelID: 'deepseek-v4-flash',
        providerID: 'deepseek',
        cost: 0.25,
        tokens: { input: 1, output: 1 },
      }),
    );
    d.close();
    const rep = await call(m, usageProtocol, 'cost', { since: 0, tzOffset: 0 });
    expect(rep.rows.map((x) => [x.provider, x.model, x.project, x.cost, x.priced])).toEqual([
      ['claude', 'claude-opus-5-5', 'work', 6, true],
      ['opencode', 'deepseek-v4-flash', undefined, 0.25, true],
    ]);
    const again = await call(m, usageProtocol, 'cost', { since: 0, tzOffset: 0, ifNoneMatch: rep.etag });
    expect(again).toMatchObject({ notModified: true, rows: [], etag: rep.etag });
  });

  test('no token in a reply', async () => {
    const { api, home, m } = await start();
    api.json('/api/oauth/usage', '{"five_hour":{"utilization":10}}');
    write(join(home, '.claude/.credentials.json'), `{"claudeAiOauth":{"accessToken":"sk-ant-SECRET","expiresAt":${TEST_NOW + 3600_000}}}`);
    write(join(home, '.codex/auth.json'), `{"tokens":{"access_token":"${jwt({ exp: TEST_NOW / 1000 + 3600 })}","account_id":"acc"}}`);
    api.status('/backend-api/wham/usage', 500);
    const res = await r!.session.request({
      op: Op.Plugin,
      plugin: 'usage',
      action: 'limits',
      params: { providers: ['claude', 'codex'] },
    } as never);
    const text = JSON.stringify(res);
    expect(text).not.toContain('sk-ant-SECRET');
    expect(text).not.toContain(jwt({ exp: TEST_NOW / 1000 + 3600 }));
    expect(text).toContain('"status":"ok"');
    void m;
  });
});

describe('the hubs of a node', () => {
  test('one hub’s limits answer another’s same request within a minute; not the same hub’s, nor other params', async () => {
    const { api, base } = await start();
    api.json('/user/balance', '{"is_available":true}');
    write(join(base, 'usage/deepseek.key'), 'sk-shared\n');
    const a = machineOf(r!.session);
    const b = machineOf(r!.connect('hub-2'));
    const ask = (m: typeof a, providers = ['deepseek']) => call(m, usageProtocol, 'limits', { providers });
    expect((await ask(a)).accounts[0]?.status).toBe('ok');
    expect(api.hits.get('/user/balance')).toBe(1);
    expect((await ask(b)).accounts[0]?.status).toBe('ok');
    expect(api.hits.get('/user/balance')).toBe(1);
    await ask(a);
    expect(api.hits.get('/user/balance')).toBe(2);
    await ask(b, ['deepseek', 'kimi']);
    expect(api.hits.get('/user/balance')).toBe(3);
  });
});

describe('a session', () => {
  const kind = 'claude';
  const session = 'e6cdc860-1055-488f-9ed2-8b8019061bb9';

  test('only a known kind and a session id; without a locator not found; with one its numbers', async () => {
    await start();
    expect(await raw('session', { kind: 'grok', session })).toMatchObject({ code: 'bad_params' });
    expect(await raw('session', { kind, session: '../../etc/passwd' })).toMatchObject({ code: 'bad_params' });
    expect(await raw('session', { kind, session })).toMatchObject({ code: 'not_found' });
    await r!.close();
    let asked = '';
    const { home, m } = await start({
      locate: async (k, s) => {
        asked = `${k}/${s}`;
        const p = join(home, 's.jsonl');
        return [{ path: p, open: () => openRegular(p) }];
      },
    });
    write(
      join(home, 's.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(TEST_NOW).toISOString(),
        message: {
          role: 'assistant',
          id: 'm1',
          model: 'claude-opus-5-5',
          usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 2 },
        },
      }) + '\n',
    );
    const u = await call(m, usageProtocol, 'session', { kind, session });
    expect(asked).toBe(`${kind}/${session}`);
    expect(u).toMatchObject({ model: 'claude-opus-5-5', input: 10, cached: 5, output: 2, requests: 1, priced: true, contextUsed: 15 });
  });

  test("the agents' sessions locate a session's transcript in the agent's home, through no link", async () => {
    const { home, m } = await start();
    const dir = join(home, '.claude', 'projects', '-work-x');
    write(
      join(dir, `${session}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(TEST_NOW).toISOString(),
        message: { role: 'assistant', id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 7, output_tokens: 3 } },
      }) + '\n',
    );
    expect(await call(m, usageProtocol, 'session', { kind, session })).toMatchObject({ input: 7, output: 3, requests: 1 });
    // Another session has no transcript; a link in its place is not read.
    const other = 'f6cdc860-1055-488f-9ed2-8b8019061bb9';
    expect(await raw('session', { kind, session: other })).toMatchObject({ code: 'not_found' });
    symlinkSync(join(dir, `${session}.jsonl`), join(dir, `${other}.jsonl`));
    expect(await raw('session', { kind, session: other })).toMatchObject({ code: 'not_found' });
  });

  test('codes: a transcript gone is not found, one too large too_large; no path in an error', async () => {
    const { home } = await start({
      locate: async () => [{ path: join(home, 'gone.jsonl'), open: () => openRegular(join(home, 'gone.jsonl')) }],
    });
    const gone = await raw('session', { kind, session });
    expect(gone).toMatchObject({ code: 'not_found' });
    expect(JSON.stringify(gone)).not.toContain(home);
    await r!.close();
    const s = await start({
      sessionLimits: { maxFileBytes: 10 },
      locate: async () => [{ path: join(s.home, 'big.jsonl'), open: () => openRegular(join(s.home, 'big.jsonl')) }],
    });
    write(join(s.home, 'big.jsonl'), 'x'.repeat(100));
    expect(await raw('session', { kind, session })).toMatchObject({ code: 'too_large' });
  });
});
