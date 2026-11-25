import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { Op, readLine, type Reply } from '#shared/proto/agentproto/index.ts';
import { channelPair, type Message } from './channel.ts';
import { defineFeature, type FeatureContext } from './feature.ts';
import { Fail } from './fail.ts';
import { jsonBody } from './http/app.ts';
import { agentDialer, localSpec, running, sleep, sshSpec, testHub, testMachines, waitFor } from './testing.ts';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

/** A feature whose routes answer their names under /api, as several
 * features' routes share that prefix. */
const apiFeature = (id: string, extra: Partial<Parameters<typeof defineFeature>[0]> = {}) =>
  defineFeature({
    id,
    ...extra,
    setup(ctx) {
      ctx.route('/api').get(`/${id}`, (c) => c.json({ id }));
      ctx.route('/api/m/:id').get(`/${id}`, (c) => c.json({ id, machine: c.var.machine.id }));
      ctx.api.get('/', (c) => c.json({ id, own: true }));
      ctx.machineApi.get('/x', (c) => c.json({ id, machine: c.var.machine.id }));
    },
  });

const json = async (res: Response) => [res.status, await res.json()] as const;

describe('features', () => {
  // A toggleable feature's routes answer 404 plugin_disabled while it is
  // off, under its own prefixes and under prefixes it shares; the routes of
  // other features under the same prefix are not affected. A feature that
  // is always on has no switch.
  test('the switch of a feature reaches its routes only', async () => {
    const t = testHub({
      features: [apiFeature('a'), apiFeature('b', { toggle: false }), apiFeature('c'), apiFeature('d', { toggle: 'custom.d' })],
      settings: { 'plugins.a.enabled': false, 'plugins.c.enabled': true, 'custom.d': true },
    });
    expect(await json(await t.request('GET', '/api/a'))).toEqual([404, { error: 'plugin_disabled', message: 'plugin_disabled' }]);
    expect(await json(await t.request('GET', '/api/p/a'))).toEqual([404, { error: 'plugin_disabled', message: 'plugin_disabled' }]);
    expect((await t.request('GET', '/api/m/local/a')).status).toBe(404);
    expect((await t.request('GET', '/api/m/local/p/a/x')).status).toBe(404);
    expect(await json(await t.request('GET', '/api/b'))).toEqual([200, { id: 'b' }]);
    expect(await json(await t.request('GET', '/api/c'))).toEqual([200, { id: 'c' }]);
    expect(await json(await t.request('GET', '/api/d'))).toEqual([200, { id: 'd' }]);
    expect(await json(await t.request('GET', '/api/p/c'))).toEqual([200, { id: 'c', own: true }]);
    expect(await json(await t.request('GET', '/api/m/local/b'))).toEqual([200, { id: 'b', machine: 'local' }]);
    expect(await json(await t.request('GET', '/api/m/local/p/c/x'))).toEqual([200, { id: 'c', machine: 'local' }]);
    // The machine of the path: unknown ones are not found.
    expect(await json(await t.request('GET', '/api/m/nope/b'))).toEqual([404, { error: 'unknown', message: 'unknown machine' }]);
    expect(await json(await t.request('GET', '/api/m/nope/p/c/x'))).toEqual([404, { error: 'unknown', message: 'unknown machine' }]);
    // Switched at runtime.
    t.settings['plugins.a.enabled'] = true;
    t.settings['plugins.c.enabled'] = false;
    t.settings['custom.d'] = false;
    expect(await json(await t.request('GET', '/api/a'))).toEqual([200, { id: 'a' }]);
    expect((await t.request('GET', '/api/c')).status).toBe(404);
    expect((await t.request('GET', '/api/d')).status).toBe(404);
    expect((await t.request('GET', '/api/b')).status).toBe(200);
    // No route: not_found, as JSON.
    expect(await json(await t.request('GET', '/api/none'))).toEqual([404, { error: 'not_found', message: 'no route for GET /api/none' }]);
  });

  // A route of one feature that would take the requests of another's (a
  // middleware or a wildcard under a shared prefix, the same route twice)
  // is refused when the core is made: its gate and middleware would run
  // before the other's handler. Under a prefix of its own a feature's
  // middleware reaches its own routes only.
  test('routes of features do not overlap', async () => {
    const b = defineFeature({ id: 'b', toggle: false, setup: (ctx) => void ctx.route('/api').get('/b', (c) => c.text('b')) });
    const cases: Array<[string, (ctx: FeatureContext) => void, string]> = [
      [
        'use',
        (ctx) => void ctx.route('/api').use(async (_c, next) => next()),
        'feature a: ALL /api/* takes the requests of GET /api/b of feature b',
      ],
      [
        'all',
        (ctx) => void ctx.route('/api').all('/*', (c) => c.text('a')),
        'feature a: ALL /api/* takes the requests of GET /api/b of feature b',
      ],
      [
        'same',
        (ctx) => void ctx.route('/api').get('/b', (c) => c.text('a')),
        'feature a: GET /api/b takes the requests of GET /api/b of feature b',
      ],
      [
        'param',
        (ctx) => void ctx.route('/api').get('/:x', (c) => c.text('a')),
        'feature a: GET /api/:x takes the requests of GET /api/b of feature b',
      ],
    ];
    for (const [, setup, want] of cases) {
      const a = defineFeature({ id: 'a', setup });
      expect(() => testHub({ features: [a, b] })).toThrow(want);
    }
    // Other methods, other paths and the features' own prefixes are fine.
    const seen: string[] = [];
    const a = defineFeature({
      id: 'a',
      setup(ctx) {
        ctx.route('/api').post('/b', (c) => c.text('a'));
        ctx.route('/api').get('/b/c', (c) => c.text('a'));
        ctx.api.use(async (c, next) => {
          seen.push(c.req.path);
          await next();
        });
        ctx.api.get('/x', (c) => c.text('x'));
      },
    });
    const t = testHub({ features: [a, b], settings: { 'plugins.a.enabled': false } });
    expect((await t.request('GET', '/api/b')).status).toBe(200);
    expect((await t.request('GET', '/api/p/a/x')).status).toBe(404);
    t.settings['plugins.a.enabled'] = true;
    expect(await (await t.request('GET', '/api/p/a/x')).text()).toBe('x');
    expect(await (await t.request('GET', '/api/b')).text()).toBe('b');
    expect(seen).toEqual(['/api/p/a/x']);
  });

  // A feature whose content runs on the UI's origin has a switch of its own
  // for browsers; the desktop app's windows use its toggle.
  test('browserRisk', async () => {
    const t = testHub({
      features: [apiFeature('vs', { browserRisk: true })],
      settings: { 'plugins.vs.enabled': true, 'plugins.vs.browser': false },
    });
    expect((await t.request('GET', '/api/p/vs', { desktop: true })).status).toBe(200);
    expect((await t.request('GET', '/api/p/vs')).status).toBe(404);
    t.settings['plugins.vs.enabled'] = false;
    t.settings['plugins.vs.browser'] = true;
    expect((await t.request('GET', '/api/p/vs', { desktop: true })).status).toBe(404);
    expect((await t.request('GET', '/api/p/vs')).status).toBe(200);
  });

  test('enabledFor', () => {
    let ctx!: FeatureContext;
    const t = testHub({
      features: [defineFeature({ id: 'vs', browserRisk: true, setup: (c) => void (ctx = c) })],
      settings: { 'plugins.vs.enabled': true },
    });
    expect([ctx.enabledFor('desktop'), ctx.enabledFor('browser')]).toEqual([true, false]);
    t.settings['plugins.vs.browser'] = true;
    expect(ctx.enabledFor('browser')).toBe(true);
  });

  // Two features may not serve the same agent op.
  test('agent ops are served once', () => {
    const f = (id: string) => defineFeature({ id, setup: (ctx) => ctx.agentStream('x.op', () => {}) });
    expect(() => testHub({ features: [f('a'), f('b')] })).toThrow('agent op x.op is served by a already');
  });
});

describe('mutating routes', () => {
  // A route that changes state is audited as <audit prefix>.<event> once it
  // answered: the feature (for one that can be off), the machine and the
  // path's parameters, what the handler named, the status, and the error's
  // code when it failed; a handler may name another event.
  const feature = (o: { toggle?: false; audit?: string }) =>
    defineFeature({
      id: 'thing',
      ...o,
      setup(ctx) {
        const one = ctx.route('/api/m/:id/things/:name');
        one.put('/', ctx.mutating('put'), jsonBody(z.object({ v: z.number() })), (c) => {
          c.var.audit.v = c.req.valid('json').v;
          if (c.req.valid('json').v < 0) throw new Fail('negative', 422, 'below zero');
          if (c.req.valid('json').v === 0) c.set('event', 'clear');
          return c.json({ ok: true });
        });
        one.delete('/', ctx.mutating(), (c) => c.json({ error: 'busy' }, 409));
        ctx.api.post('/plain', ctx.mutating('plain'), (c) => c.text('no', 500));
        ctx.api.post('/crash', ctx.mutating('crash'), () => {
          throw new Error('boom');
        });
        ctx.api.post('/w', ctx.writable, (c) => c.json({ ok: true }));
      },
    });

  test('audit records', async () => {
    const t = testHub({ features: [feature({ audit: 'stuff' })], settings: { 'plugins.thing.enabled': true } });
    const put = (v: string) => t.request('PUT', '/api/m/local/things/n1', { body: v });
    expect((await put('{"v":1}')).status).toBe(200);
    expect((await put('{"v":0}')).status).toBe(200);
    expect(await json(await put('{"v":-1}'))).toEqual([422, { error: 'negative', message: 'below zero' }]);
    expect((await put('{"v":"x"}')).status).toBe(400);
    expect((await t.request('DELETE', '/api/m/local/things/n2')).status).toBe(409);
    expect((await t.request('POST', '/api/p/thing/plain')).status).toBe(500);
    expect(await json(await t.request('POST', '/api/p/thing/crash'))).toEqual([500, { error: 'failed', message: 'boom' }]);
    // A refused request is not the route's event.
    expect((await t.request('PUT', '/api/m/nope/things/n1', { body: '{"v":1}' })).status).toBe(404);
    t.settings['plugins.thing.enabled'] = false;
    expect((await put('{"v":1}')).status).toBe(404);

    const recs = t.audit.records().map(({ time, ...r }) => (expect(typeof time).toBe('string'), r));
    const base = { remote: '127.0.0.1', plugin: 'thing', machine: 'local', name: 'n1' };
    expect(recs).toEqual([
      { ...base, event: 'stuff.put', v: 1, status: 200 },
      { ...base, event: 'stuff.clear', v: 0, status: 200 },
      { ...base, event: 'stuff.put', v: -1, status: 422, error: 'negative' },
      { ...base, event: 'stuff.put', status: 400, error: 'bad_request' },
      { ...base, event: 'stuff', name: 'n2', status: 409, error: 'busy' },
      { remote: '127.0.0.1', plugin: 'thing', event: 'stuff.plain', status: 500, error: 'failed' },
      { remote: '127.0.0.1', plugin: 'thing', event: 'stuff.crash', status: 500, error: 'failed' },
    ]);
  });

  // A feature that is always on has no plugin field; its id is the prefix
  // without an audit prefix of its own.
  test('a feature that is always on', async () => {
    const t = testHub({ features: [feature({ toggle: false })] });
    expect((await t.request('PUT', '/api/m/local/things/n1', { body: '{"v":1}' })).status).toBe(200);
    const { time: _, ...rec } = t.audit.records()[0];
    expect(rec).toEqual({ remote: '127.0.0.1', event: 'thing.put', machine: 'local', name: 'n1', v: 1, status: 200 });
  });

  // In read-only mode both refuse, before the body is read, and nothing is
  // audited.
  test('read-only', async () => {
    const t = testHub({ features: [feature({})], settings: { 'plugins.thing.enabled': true }, readOnly: true });
    expect(await json(await t.request('PUT', '/api/m/local/things/n1', { body: '{' }))).toEqual([
      403,
      { error: 'read_only', message: 'read-only mode' },
    ]);
    expect(await json(await t.request('POST', '/api/p/thing/w'))).toEqual([403, { error: 'read_only', message: 'read-only mode' }]);
    expect(t.audit.lines).toEqual([]);
  });

  // Who did it: the proxy's X-Forwarded-For and the user a proxy names.
  test('who', async () => {
    const t = testHub({ features: [feature({ toggle: false })] });
    await t.request('PUT', '/api/m/local/things/n1', {
      body: '{"v":1}',
      headers: { 'X-Forwarded-For': '10.1.1.1', 'Remote-User': 'ann' },
      host: 'localhost:7780',
    });
    const r = t.audit.records()[0];
    expect([r.remote, r.forwarded_for, r.user]).toEqual(['127.0.0.1', '10.1.1.1', 'ann']);
  });
});

describe('agent streams', () => {
  // The streams agents open towards the core go to the feature that serves
  // their op, while it is on for any client; otherwise they are refused.
  test('dispatched by op', async () => {
    const got: Array<[string, string]> = [];
    const f = defineFeature({
      id: 'vault',
      setup(ctx) {
        ctx.agentStream('vault.get', (m, conn, h) => {
          got.push([m.id, h.op]);
          void conn.stream.end(JSON.stringify({ ok: true }) + '\n');
        });
      },
    });
    const dial = agentDialer();
    const machines = testMachines([sshSpec('x')], { dial });
    const t = testHub({ features: [f], machines, settings: { 'plugins.vault.enabled': true } });
    stops.push(running(t.core.machines));
    await waitFor('ready', () => machines.get('x')!.ready);
    const agent = dial.agents[0];
    const ask = async (op: string) => readLine<Reply>((await agent.open({ op: op as never })).reader);

    expect(await ask('vault.get')).toEqual({ ok: true });
    expect(got).toEqual([['x', 'vault.get']]);
    expect(await ask('nobody.op')).toEqual({ ok: false, error: 'unsupported op' });
    t.settings['plugins.vault.enabled'] = false;
    expect(await ask('vault.get')).toEqual({ ok: false, error: 'plugin is off', code: 'plugin_disabled' });
    expect(got.length).toBe(1);
    // Still the node's own op.
    expect(await ask(Op.NodeDrain)).toEqual({ ok: true });
  });
});

describe('the rest of the context', () => {
  // broadcast reaches every page as a plugin message; forget runs every
  // feature's onForget, whatever fails; services run until the core stops.
  test('broadcast, forget, services', async () => {
    const forgotten: string[] = [];
    let ctx!: FeatureContext;
    let serviceEnded = false;
    const f = defineFeature({
      id: 'p',
      setup(c) {
        ctx = c;
        c.onForget(() => {
          throw new Error('one fails');
        });
        c.onForget((id) => void forgotten.push(id));
        c.service('loop', async (signal) => {
          await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
          serviceEnded = true;
        });
        c.service('fails', async () => {
          throw new Error('at once');
        });
      },
    });
    const t = testHub({ features: [f], machines: testMachines([localSpec()]) });
    const { a, b } = channelPair();
    const received: Message[] = [];
    a.adopt((ch) => t.core.pages.connect(ch, { client: 'browser', readOnly: false, who: {} }));
    b.adopt(() => ({ message: (m) => void received.push(m) }));
    ctx.broadcast({ hello: 1 }, 'm1');
    ctx.broadcast('two');
    await sleep(10);
    expect(received.map((m) => JSON.parse(m as string))).toEqual([
      { t: 'plugin', plugin: 'p', m: 'm1', data: { hello: 1 } },
      { t: 'plugin', plugin: 'p', m: '', data: 'two' },
    ]);
    ctx.forget('gone');
    t.core.forget('gone2');
    expect(forgotten).toEqual(['gone', 'gone2']);

    const stop = running(t.core);
    await sleep(10);
    expect(serviceEnded).toBe(false);
    await stop();
    expect(serviceEnded).toBe(true);
  });
});

describe('/ws', () => {
  test('needs an upgrade', async () => {
    const t = testHub({ features: [] });
    const res = await t.request('GET', '/ws');
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([426, 'upgrade_required']);
  });

  test('adopts the channel as a page, compressed, with the client and read-only mode', async () => {
    const t = testHub({ features: [], readOnly: true });
    const { a, b } = channelPair();
    const got: unknown[] = [];
    b.adopt(() => ({ message: (m) => void got.push(JSON.parse(m as string)) }));
    let compress: boolean | undefined;
    const res = await t.request('GET', '/ws', {
      desktop: true,
      upgrade: (open, opts) => {
        compress = opts?.compress;
        a.adopt(open);
        return new Response(null);
      },
    });
    expect(res.status).toBe(200);
    expect(compress).toBe(true);
    expect(t.core.pages.size).toBe(1);
    b.send(JSON.stringify({ t: 'ping', rid: 7 }));
    await waitFor('pong', () => got.length > 0);
    expect(got).toEqual([{ t: 'pong', rid: 7 }]);
  });
});
