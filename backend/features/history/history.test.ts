// The terminal history feature: its settings, its scheduler (with machines
// and a clock of the test's) and its routes over a fake of the Go agent's
// plugin op.
import { afterEach, describe, expect, test } from 'bun:test';
import { discard } from '#shared/lib/log.ts';
import { write } from '#shared/lib/streamio.ts';
import {
  HistoryLimits,
  MAX_INLINE,
  Op,
  readBody,
  writeLine,
  type Header,
  type HistoryCaptureParams,
  type Reply,
} from '#shared/proto/agentproto/index.ts';
import { hubModules } from '#kernel/config/registry.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { createHub } from '#kernel/hub.ts';
import { enableSetting } from '#kernel/feature.ts';
import { Fail } from '#kernel/fail.ts';
import { Guard } from '#kernel/http/guard.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { agentDialer, checkGuarded, memoryAudit, running, sshSpec, testHub, testMachines, waitFor } from '#kernel/testing.ts';
import { historyFeature, type HistoryOptions } from './hub.ts';
import { clearWait, Scheduler, TIMING } from './scheduler.ts';
import { LIMITS, settings } from './settings.ts';

const SWITCH = 'plugins.history.enabled';
const newSettings = () => new Settings('', { modules: hubModules([historyFeature()]) });

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

test('feature', () => {
  const f = historyFeature();
  expect([f.id, enableSetting(f, 'browser'), enableSetting(f, 'desktop')]).toEqual(['history', SWITCH, SWITCH]);
  expect(newSettings().get(SWITCH)).toBe(true);
});

// Every route is a machine's; only the clear and the adopt change
// something: guarded (refused in read-only mode, audited).
test('routes', async () => {
  const hub = (readOnly: boolean) =>
    testHub({
      features: [historyFeature()],
      machines: testMachines([sshSpec('x', 'x', 'x', false)]),
      readOnly,
      settings: { [SWITCH]: true },
    });
  const { problems, checked } = await checkGuarded(hub(false), hub(true), { machine: 'x' });
  expect(problems).toEqual([]);
  expect(checked.sort()).toEqual(['DELETE /api/m/:id/p/history', 'POST /api/m/:id/p/history/adopt']);
  const gets = hub(true).hub.http.app.routes.filter((r) => r.method === 'GET' && r.path.startsWith('/api/m/:id/p/history'));
  expect([...new Set(gets.map((r) => r.path))].sort()).toEqual(['/api/m/:id/p/history', '/api/m/:id/p/history/read']);
});

// Capturing is off until the user turns it on, also per machine; every
// limit is bounded by the machine's hard limits, and each can differ per
// machine.
test('settings', () => {
  const st = new Settings('', { modules: [settings] });
  expect([st.bool('history.capture'), st.bool('history.capture', 'local')]).toEqual([false, false]);
  const want: Record<string, [number, number, number]> = {
    'history.interval': [30, 10, 600],
    'history.lines': [2000, 100, 10000],
    'history.maxTerminals': [32, 1, 128],
    'history.maxTotalMB': [64, 1, 512],
    'history.days': [7, 1, 30],
  };
  for (const d of st.defs()) {
    expect([d.key, d.section, d.scope]).toEqual([d.key, 'history', 'machine']);
    if (d.key === 'history.capture') {
      expect([d.flag, d.usage?.includes('secrets')]).toEqual(['history-capture', true]);
      continue;
    }
    expect([d.key, d.default, d.min, d.max, d.integer]).toEqual([d.key, ...want[d.key]!, true]);
    expect(() => st.set(d.key, '', want[d.key]![2] + 1)).toThrow();
  }
  st.set('history.capture', 'gpu', true);
  expect([st.bool('history.capture', 'gpu'), st.bool('history.capture')]).toEqual([true, false]);
  expect([LIMITS.lines, LIMITS.maxTerminals, LIMITS.days]).toEqual([
    [HistoryLimits.minLines, HistoryLimits.maxLines],
    [HistoryLimits.minTerminals, HistoryLimits.maxTerminals],
    [HistoryLimits.minDays, HistoryLimits.maxDays],
  ]);
  expect(LIMITS.maxTotalMB.map((n) => n * 2 ** 20)).toEqual([HistoryLimits.minTotalBytes, HistoryLimits.maxTotalBytes]);
});

interface Call {
  m: string;
  action: string;
  params: unknown;
}

/** The scheduler over machines of the test: what they were asked; reply
 * gives an action's result or throws; block holds every action. */
function testScheduler(...ready: string[]) {
  const f = {
    calls: [] as Call[],
    ready: [...ready],
    block: undefined as Promise<void> | undefined,
    reply: undefined as ((m: string, action: string, params: unknown) => unknown) | undefined,
    readOnly: false,
    now: Date.UTC(2026, 10, 22, 10),
  };
  const ask = async (m: string, action: string, params: unknown, signal: AbortSignal) => {
    f.calls.push({ m, action, params });
    if (f.block)
      await Promise.race([f.block, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Fail('transport', 502))))]);
    return f.reply?.(m, action, params) ?? (action === 'clear' ? { removed: 0 } : {});
  };
  const st = newSettings();
  const audit = memoryAudit();
  const s = new Scheduler({
    calls: {
      capture: (m, p, signal) => ask(m, 'capture', p, signal),
      clear: (m, signal) => ask(m, 'clear', {}, signal) as Promise<{ removed: number }>,
    },
    ready: () => [...f.ready],
    settings: st,
    enabled: () => st.bool(SWITCH),
    switchKey: SWITCH,
    readOnly: () => f.readOnly,
    audit: audit.audit,
    logger: discard,
    now: () => f.now,
  });
  st.onChange((c) => s.settingsChanged(c));
  const signal = new AbortController().signal;
  const step = async () => {
    s.step(signal);
    await s.idle();
  };
  const actions = (m: string, calls = f.calls) => calls.filter((c) => c.m === m).map((c) => c.action);
  return { s, f, st, audit, step, actions };
}

const HOUR = 3_600_000;

describe('scheduler', () => {
  // Captures run per machine whose setting is on, with its settings, every
  // interval after the last one ended; never in read-only mode nor while
  // the feature is off.
  test('captures', async () => {
    const { f, st, step, actions } = testScheduler('local', 'gpu', 'far');
    await step();
    // Seen the first time with capturing off: each is cleared once.
    for (const m of ['local', 'gpu', 'far']) expect([m, actions(m)]).toEqual([m, ['clear']]);
    await step();
    expect(f.calls.length).toBe(3);
    f.calls = [];
    st.set('history.capture', 'gpu', true);
    st.set('history.lines', 'gpu', 500);
    st.set('history.maxTotalMB', 'gpu', 8);
    st.set('history.interval', 'gpu', 60);
    await step();
    expect(f.calls).toEqual([
      {
        m: 'gpu',
        action: 'capture',
        params: { lines: 500, maxTerminals: 32, maxTotalBytes: 8 << 20, days: 7 } satisfies HistoryCaptureParams,
      },
    ]);
    // Not again before the interval passed since it ended.
    f.now += 59_000;
    await step();
    expect(f.calls.length).toBe(1);
    f.now += 1000;
    await step();
    expect(f.calls.length).toBe(2);
    // Read-only: nothing.
    f.now += HOUR;
    f.readOnly = true;
    await step();
    expect(f.calls.length).toBe(2);
    f.readOnly = false;
    // The feature off: no capture, the snapshots gpu kept go, once.
    st.set(SWITCH, '', false);
    for (let i = 0; i < 3; i++) {
      f.now += HOUR;
      await step();
    }
    expect(actions('gpu')).toEqual(['capture', 'capture', 'clear']);
    st.set(SWITCH, '', true);
    // On for every machine: each is asked.
    st.set('history.capture', '', true);
    await step();
    const c = f.calls.slice(3);
    expect(c.map((x) => [x.m, x.action]).sort()).toEqual([
      ['far', 'capture'],
      ['gpu', 'capture'],
      ['local', 'capture'],
    ]);
  });

  // A machine first seen not keeping snapshots is asked for one clear,
  // audited only when it removed some.
  test('clears at first sight', async () => {
    let t = testScheduler('gpu', 'far');
    t.f.reply = (m) => ({ removed: m === 'gpu' ? 3 : 0 });
    for (let i = 0; i < 5; i++) {
      await t.step();
      t.f.now += HOUR;
    }
    for (const m of ['gpu', 'far']) expect([m, t.actions(m)]).toEqual([m, ['clear']]);
    expect(t.audit.records().map(({ time: _, ...r }) => r)).toEqual([
      { event: 'history.clear', plugin: 'history', machine: 'gpu', reason: 'capture_off', removed: 3 },
    ]);
    // A machine first connected later is cleared then.
    t.f.ready.push('new');
    await t.step();
    expect(t.actions('new')).toEqual(['clear']);

    // The feature off from the start, capturing on: the same.
    t = testScheduler('gpu');
    t.st.set('history.capture', '', true);
    t.st.set(SWITCH, '', false);
    await t.step();
    expect(t.actions('gpu')).toEqual(['clear']);
  });

  // One capture at a time per machine, however long it takes.
  test('one at a time', async () => {
    const { s, f, st, step } = testScheduler('gpu');
    st.set('history.capture', 'gpu', true);
    let release!: () => void;
    f.block = new Promise((r) => (release = r));
    const signal = new AbortController().signal;
    s.step(signal);
    for (let i = 0; i < 5; i++) {
      f.now += HOUR;
      s.step(signal);
    }
    await Bun.sleep(20);
    expect(f.calls.length).toBe(1);
    release();
    await s.idle();
    f.now += HOUR;
    await step();
    expect(f.calls.length).toBe(2);
  });

  // Turning the setting off clears the machine's snapshots once, audited;
  // also when it happens while the machine is away (when it is back), and
  // when it is turned on again before the next tick. Read-only hubs clear
  // nothing.
  test('clears when turned off', async () => {
    const { f, st, audit, step, actions } = testScheduler('gpu', 'far');
    st.set('history.capture', '', true);
    await step();
    f.calls = [];
    st.set('history.capture', 'gpu', false);
    f.now += HOUR;
    await step();
    expect([actions('gpu'), actions('far')]).toEqual([['clear'], ['capture']]);
    expect(audit.records().map((r) => [r.event, r.machine, r.reason])).toEqual([['history.clear', 'gpu', 'capture_off']]);
    // Once.
    f.now += HOUR;
    await step();
    expect(actions('gpu')).toEqual(['clear']);

    // far is away when its setting goes off, and is turned on again before
    // it is back: cleared once it is back, then captured again.
    f.ready = ['gpu'];
    f.calls = [];
    st.set('history.capture', 'far', false);
    st.set('history.capture', 'far', true);
    f.now += HOUR;
    await step();
    expect(actions('far')).toEqual([]);
    f.ready = ['gpu', 'far'];
    await step();
    await step();
    expect(actions('far')).toEqual(['clear', 'capture']);

    // Read-only: the clear waits.
    f.calls = [];
    f.readOnly = true;
    st.set('history.capture', 'far', false);
    f.now += HOUR;
    await step();
    expect(f.calls).toEqual([]);
  });

  // A failed clear is asked again later, twice as long after each failure
  // up to an hour, and at once when the machine connects again; never
  // given up, and audited once it is done.
  test('clear retries', async () => {
    const { f, st, audit, step, actions } = testScheduler('gpu');
    st.set('history.capture', 'gpu', true);
    await step();
    let failing = true;
    f.reply = (_m, action) => {
      if (failing && action === 'clear') throw new Fail('transport', 502, 'lost');
      return action === 'clear' ? { removed: 0 } : {};
    };
    st.set('history.capture', 'gpu', false);
    const clears = () => actions('gpu').length - 1;
    const start = f.now;
    const at: number[] = [];
    for (let i = 0; i < 24 * 60 && f.now - start <= 12 * HOUR; i++) {
      await step();
      if (clears() > at.length) at.push(f.now - start);
      f.now += 30_000;
    }
    expect(at[0]).toBe(0);
    expect(at.length).toBeGreaterThanOrEqual(12);
    for (let i = 1; i < at.length; i++) {
      const actual = at[i] - at[i - 1];
      const base = clearWait(i, TIMING);
      expect(actual).toBeGreaterThanOrEqual(base * 0.8);
      expect(actual).toBeLessThan(base * 1.2 + 30_000);
    }
    // Away and back: asked at once.
    f.ready = [];
    await step();
    const n = clears();
    f.ready = ['gpu'];
    failing = false;
    await step();
    expect(clears()).toBe(n + 1);
    expect(audit.records().map((r) => r.reason)).toEqual(['capture_off']);
    // Done: not asked again.
    f.now += 24 * HOUR;
    await step();
    expect(clears()).toBe(n + 1);
  });

  // run goes until its signal ends, asking a machine that is on.
  test('run', async () => {
    const { s, f, st } = testScheduler('gpu');
    st.set('history.capture', 'gpu', true);
    const ac = new AbortController();
    const done = s.run(ac.signal);
    await waitFor('a capture', () => f.calls.some((c) => c.action === 'capture'));
    ac.abort();
    await Promise.race([done, Bun.sleep(2000).then(() => Promise.reject(new Error('run outlived its signal')))]);
  });
});

/** A hub with the feature whose machine x answers the history actions
 * with reply (or waits while block is set). */
async function withMachine(
  reply: (action: string, params: Record<string, unknown>) => Reply,
  o: HistoryOptions & { block?: boolean } = {},
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const serve = async (h: Header, conn: AgentStream) => {
    try {
      if (h.op !== Op.Plugin || h.plugin !== 'history') return void (await writeLine(conn.stream, { ok: false, error: 'unsupported' }));
      const params = (h.params_length ? await readBody(conn.reader, h.params_length) : (h.params ?? {})) as Record<string, unknown>;
      calls.push([h.action ?? '', params]);
      if (o.block) await new Promise((r) => conn.stream.once('close', r));
      // A large result follows its line as a body, as the Go agent sends it.
      const rep = reply(h.action ?? '', params);
      const body = rep.ok && rep.plugin !== undefined ? Buffer.from(JSON.stringify(rep.plugin)) : undefined;
      if (body && body.length > MAX_INLINE) {
        await writeLine(conn.stream, { ok: true, plugin_length: body.length }).catch(() => {});
        await write(conn.stream, body).catch(() => {});
      } else await writeLine(conn.stream, rep).catch(() => {});
    } finally {
      conn.reader.release();
      closeStream(conn.stream);
    }
  };
  const machines = testMachines([sshSpec('x'), sshSpec('far', 'far', 'far', false)], { dial: agentDialer({ serve }) });
  const audit = memoryAudit();
  // A real settings store: the scheduler reads numbers; capturing stays
  // off, and the read-only hub's scheduler asks nothing.
  const hub = createHub({
    guard: new Guard(),
    audit: audit.audit,
    readOnly: false,
    logger: discard,
    machines,
    settings: newSettings(),
    features: [historyFeature(o)],
  });
  stops.push(running(hub));
  await waitFor('x ready', () => machines.get('x')!.ready);
  // The scheduler's clear of a machine first seen.
  await waitFor('the first clear', () => calls.length > 0);
  calls.length = 0;
  const request = (method: string, path: string) =>
    hub.fetch(new Request(`http://127.0.0.1:7780${path}`, { method, headers: { Host: '127.0.0.1:7780' } }), {
      remote: '127.0.0.1',
      desktop: false,
    });
  return { request, calls, audit };
}

const errorOf = async (res: Response) => [res.status, ((await res.json()) as { error: string }).error];

// The routes check what the browser sends before the machine is asked,
// and pass on only what the machine may answer.
test('route guards', async () => {
  const data = Buffer.from('\x1b[31mx'.repeat(1000));
  const { request, calls, audit } = await withMachine((action, p) => {
    switch (action) {
      case 'list':
        return {
          ok: true,
          plugin: {
            restoreScreen: true,
            terminals: [
              { terminal: 't1', pid: 3, extra: 1 },
              { terminal: '../t2' },
              { terminal: 't3', restored: true, previous: { pid: 2, at: 5 } },
            ],
          },
        };
      case 'read':
        if (p.terminal === 't9')
          return {
            ok: true,
            plugin: { terminal: 't9', generation: p.generation, data: Buffer.alloc(HistoryLimits.maxBytes + 1).toString('base64') },
          };
        if (p.terminal === 't8') return { ok: false, code: 'not_found', error: 'history: no snapshot' };
        if (p.terminal === 't7') return { ok: true, plugin: { terminal: 't6', generation: p.generation, data: '' } };
        return {
          ok: true,
          plugin: {
            terminal: p.terminal,
            generation: p.generation,
            data: data.toString('base64'),
            pid: 42,
            at: 1700000000000,
            cols: 120,
            rows: 40,
            lines: 2000,
            bytes: data.length,
          },
        };
      case 'clear':
        return { ok: true, plugin: { removed: 1 } };
    }
    return { ok: false, code: 'bad_params', error: 'unknown' };
  });
  // Bad requests never reach the machine.
  for (const q of [
    '',
    '?terminal=t1',
    '?generation=previous',
    '?terminal=../x&generation=previous',
    '?terminal=t1&generation=prev',
    `?terminal=${'a'.repeat(65)}&generation=current`,
    '?terminal=.t&generation=current',
  ])
    expect([q, ...(await errorOf(await request('GET', `/api/m/x/p/history/read${q}`)))]).toEqual([q, 400, 'bad_request']);
  for (const q of ['?terminal=../x', '?terminal=a/b', '?terminal=..']) {
    expect([q, ...(await errorOf(await request('DELETE', `/api/m/x/p/history${q}`)))]).toEqual([q, 400, 'bad_request']);
    expect(audit.records().at(-1)!.terminal).toBeUndefined();
  }
  expect(calls).toEqual([]);
  // The list without what could not name a terminal, as the Go hub wrote it.
  let res = await request('GET', '/api/m/x/p/history');
  expect([res.status, res.headers.get('Cache-Control'), await res.json()]).toEqual([
    200,
    'no-store',
    {
      terminals: [
        { terminal: 't1', pid: 3, at: 0, lines: 0, bytes: 0, cols: 0, rows: 0 },
        {
          terminal: 't3',
          pid: 0,
          at: 0,
          lines: 0,
          bytes: 0,
          cols: 0,
          rows: 0,
          restored: true,
          previous: { pid: 2, at: 5, lines: 0, bytes: 0, cols: 0, rows: 0 },
        },
      ],
      restoreScreen: true,
    },
  ]);
  // The bytes as they are, described by headers.
  res = await request('GET', '/api/m/x/p/history/read?terminal=t1&generation=previous');
  const hd = Object.fromEntries(res.headers);
  expect([res.status, Buffer.from(await res.arrayBuffer()).equals(data)]).toEqual([200, true]);
  expect(hd).toMatchObject({
    'content-type': 'application/octet-stream',
    'content-length': String(data.length),
    'x-history-pid': '42',
    'x-history-at': '1700000000000',
    'x-history-cols': '120',
    'x-history-rows': '40',
    'x-history-lines': '2000',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': 'attachment',
  });
  expect(calls.at(-1)).toEqual(['read', { terminal: 't1', generation: 'previous' }]);
  // An answer over the limit or of another terminal; none.
  expect(await errorOf(await request('GET', '/api/m/x/p/history/read?terminal=t9&generation=current'))).toEqual([502, 'bad_reply']);
  expect(await errorOf(await request('GET', '/api/m/x/p/history/read?terminal=t7&generation=current'))).toEqual([502, 'bad_reply']);
  expect(await errorOf(await request('GET', '/api/m/x/p/history/read?terminal=t8&generation=current'))).toEqual([404, 'not_found']);
  // Clear one terminal, audited with it; clear all.
  res = await request('DELETE', '/api/m/x/p/history?terminal=t1');
  expect([res.status, await res.json()]).toEqual([200, { removed: 1 }]);
  expect(audit.records().at(-1)).toMatchObject({
    event: 'history.clear',
    plugin: 'history',
    machine: 'x',
    terminal: 't1',
    removed: 1,
    status: 200,
  });
  expect(calls.at(-1)).toEqual(['clear', { terminal: 't1' }]);
  res = await request('DELETE', '/api/m/x/p/history');
  expect(res.status).toBe(200);
  expect(calls.at(-1)).toEqual(['clear', {}]);
  // No session with the machine: offline.
  expect(await errorOf(await request('GET', '/api/m/far/p/history'))).toEqual([409, 'offline']);
});

// What is not the machine's coded failure is answered with a fixed
// wording, never the error's text.
test('failures', async () => {
  let t = await withMachine(() => ({ ok: true, plugin: { terminals: '/home/u/.x/history' } }));
  let res = await t.request('GET', '/api/m/x/p/history');
  expect([res.status, await res.json()]).toEqual([502, { error: 'bad_reply', message: "the machine's answer was not understood" }]);
  await stops.pop()!();
  t = await withMachine(() => ({ ok: true, plugin: {} }), { block: true, routeMs: { clear: 50 } });
  res = await t.request('DELETE', '/api/m/x/p/history');
  expect([res.status, await res.json()]).toEqual([504, { error: 'timeout', message: 'the machine did not answer in time' }]);
});

// An adopt's addresses are checked before the machine is asked; it is
// audited with them and with its result, and the machine's failures keep
// their codes.
test('adopt', async () => {
  const { request, calls, audit } = await withMachine((action, p) => {
    if (action !== 'adopt') return { ok: false, code: 'bad_params', error: 'x' };
    if (p.to === 't9') return { ok: false, code: 'not_found', error: 'history: no such terminal' };
    if (p.to === 't8') return { ok: false, code: 'not_running', error: 'history: the terminal core is not running' };
    return { ok: true, plugin: { adopted: true } };
  });
  for (const q of [
    '',
    '?from=t1',
    '?to=t2',
    '?from=t1&to=t1',
    '?from=../t1&to=t2',
    '?from=t1&to=t2.prev',
    `?from=t1&to=${'a'.repeat(65)}`,
    '?from=.lock&to=t2',
    '?from=t1&to=a%2Fb',
  ]) {
    expect([q, ...(await errorOf(await request('POST', `/api/m/x/p/history/adopt${q}`)))]).toEqual([q, 400, 'bad_request']);
    const { time: _, remote: __, ...rec } = audit.records().at(-1)!;
    expect(rec).toEqual({ event: 'history.adopt', plugin: 'history', machine: 'x', status: 400, error: 'bad_request' });
  }
  expect(calls).toEqual([]);
  const res = await request('POST', '/api/m/x/p/history/adopt?from=t1&to=t2');
  expect([res.status, await res.text()]).toEqual([200, '{"adopted":true}']);
  expect(audit.records().at(-1)).toMatchObject({ from: 't1', to: 't2', adopted: true });
  expect(calls).toEqual([['adopt', { from: 't1', to: 't2' }]]);
  for (const [to, code, status] of [
    ['t9', 'not_found', 404],
    ['t8', 'not_running', 400],
  ] as const) {
    expect(await errorOf(await request('POST', `/api/m/x/p/history/adopt?from=t1&to=${to}`))).toEqual([status, code]);
    expect(audit.records().at(-1)!.adopted).toBeUndefined();
  }
  expect(await errorOf(await request('POST', '/api/m/far/p/history/adopt?from=t1&to=t2'))).toEqual([409, 'offline']);
});
