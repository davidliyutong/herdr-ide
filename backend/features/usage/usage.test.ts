// The AI usage scheduler, its snapshot and the spend, with machines whose
// agents answer what each test gives them and a clock of the test's
// (ported from the Go hub's tests).
import { afterAll, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { Fail, offline } from '#kernel/fail.ts';
import { COST_FRESH } from './cost.ts';
import { pace, windowIDs } from './history.ts';
import type { CostParams } from './protocol.ts';
import { parsePrices, PROVIDERS } from './settings.ts';
import { hubDBFile } from './store.ts';
import { acc, DAY, find, HOUR, MIN, removeTempDirs, report, T0, tempDir, testUsage, win } from './testing.ts';
import { DEFAULT_CADENCE, interval, MIN_REFRESH_GAP, Usage } from './usage.ts';

afterAll(removeTempDirs);

test('interval', () => {
  const cases: [string, boolean, boolean, number][] = [
    ['manual', true, true, 0],
    ['1', false, false, MIN],
    ['15', true, false, 15 * MIN],
    ['60', false, false, HOUR],
    ['adaptive', true, true, 5 * MIN],
    ['adaptive', false, true, 10 * MIN],
    ['adaptive', false, false, 30 * MIN],
  ];
  for (const [mode, watching, working, want] of cases)
    expect([mode, interval(mode, watching, working, DEFAULT_CADENCE)]).toEqual([mode, want]);
});

test('cadence', async () => {
  const t = testUsage();
  expect(t.u.due()).toBe(true);
  await t.poll();
  t.clock.now += 29 * MIN;
  expect(t.u.due()).toBe(false);
  // A coding agent working: every 10 minutes.
  t.u.onAgent({ m: 'local', data: { terminal: 't1', agent_status: 'working' } });
  expect(t.u.due()).toBe(true);
  t.u.onAgent({ m: 'local', data: { terminal: 't1', agent_status: 'idle' } });
  expect(t.u.due()).toBe(false);
  // The panel open (GET ?watch=1): every 5 minutes.
  await t.poll();
  t.clock.now += 2 * MIN;
  t.u.watch();
  expect(t.u.due()).toBe(false);
  t.clock.now += 3 * MIN;
  t.u.watch();
  expect(t.u.due()).toBe(true);
  expect([t.snap().interval, t.snap().refresh]).toEqual([300, 'adaptive']);
  // The adaptive cadences are settings.
  t.st.set('usage.refreshOpen', '', 15);
  expect(() => t.st.set('usage.refreshOpen', '', 0.5)).toThrow();
  expect(t.snap().interval).toBe(900);
  // Manual: never by itself.
  t.st.set('usage.refresh', '', 'manual');
  t.clock.now += HOUR;
  expect(t.u.due()).toBe(false);
  // A machine that goes away takes its agents along.
  t.u.onAgent({ m: 'box', data: { terminal: 't2', agent_status: 'working' } });
  t.u.onMachine({ id: 'box', status: 'error' });
  expect(t.u.working.size).toBe(0);
});

test('a poll asks an account once, and lists every machine it is on', async () => {
  let skips: string[] | undefined;
  const t = testUsage({ ready: ['local', 'box'] });
  const shared = () =>
    acc({
      provider: 'claude',
      id: 'acc-1',
      email: 'a@example.com',
      status: 'ok',
      asOf: t.sec(),
      windows: [win('session', 40, t.sec() + 3600, 18000)],
    });
  t.f.limits = (m, o) => {
    if (m === 'box') {
      skips = o.skip;
      const out = [
        acc({ provider: 'codex', status: 'ok', asOf: t.sec(), windows: [win('weekly', 10)] }),
        acc({ provider: 'kimi', status: 'missing' }),
      ];
      return o.skip?.includes('claude:acc-1') ? [...out, acc({ provider: 'claude', id: 'acc-1', status: 'skipped' })] : [...out, shared()];
    }
    return [shared(), acc({ provider: 'codex', status: 'ok', asOf: t.sec(), windows: [win('weekly', 20)] })];
  };
  await t.poll();
  expect(skips).toContain('claude:acc-1');
  const s = t.snap();
  expect(s.accounts).toHaveLength(3);
  const a = find(s, 'claude:acc-1')!;
  expect([a.machines, a.windows[0]!.usedPct]).toEqual([['local', 'box'], 40]);
  // Accounts without an id stay apart per machine.
  expect([find(s, 'codex:@local'), find(s, 'codex:@box')].every(Boolean)).toBe(true);
  expect(s.machines.local!.status).toBe('ok');
  expect(t.sent.length).toBeGreaterThanOrEqual(2);
  // The pace of the session window: 4 h of 5 gone.
  expect(Math.trunc(a.windows[0]!.pace!.expectedPct)).toBe(80);
  expect(a.windows[0]!.pace!.beforeReset).toBeUndefined();
});

test('an answer without numbers keeps the last good ones', async () => {
  let fail = false;
  const t = testUsage();
  t.f.limits = () =>
    fail
      ? [acc({ provider: 'claude', id: 'acc-1', status: 'error', code: 'rate_limited', retryAfter: 600 })]
      : [acc({ provider: 'claude', id: 'acc-1', plan: 'Max', status: 'ok', asOf: t.sec(), windows: [win('weekly', 55)] })];
  await t.poll();
  fail = true;
  t.clock.now += MIN;
  await t.poll();
  let a = find(t.snap(), 'claude:acc-1')!;
  expect([a.status, a.code, a.windows.length, a.windows[0]!.usedPct, a.plan, a.fetchedAt]).toEqual([
    'error',
    'rate_limited',
    1,
    55,
    'Max',
    T0,
  ]);
  // Retry-After: the account is skipped until then.
  let skip: string[] | undefined;
  t.f.limits = (_, o) => {
    skip = o.skip;
    return [];
  };
  await t.poll();
  expect(skip).toContain('claude:acc-1');
  // An offline machine: its poll fails with the agent's code.
  t.f.limits = () => {
    throw offline();
  };
  await t.poll();
  expect(t.snap().machines.local!.code).toBe('offline');
  a = find(t.snap(), 'claude:acc-1')!;
  expect(a).toBeDefined();
  // Accounts no machine reported for a week are forgotten.
  t.clock.now += 8 * DAY;
  t.f.limits = () => [];
  await t.poll();
  expect(t.snap().accounts).toHaveLength(0);
});

test('history', async () => {
  let pct = 10;
  const t = testUsage();
  t.f.limits = () => [
    acc({ provider: 'claude', id: 'acc-1', status: 'ok', asOf: t.sec(), windows: [win('weekly', pct, T0 + 3 * 86400, 7 * 86400)] }),
  ];
  for (let i = 0; i < 5; i++) {
    await t.poll();
    t.clock.now += HOUR;
    pct += 5;
  }
  // Kept in the hub's database beside the settings file.
  const st = statSync(hubDBFile(t.st.path));
  if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600);
  const w = t.snap().accounts[0]!.windows[0]!;
  const pts = t.u.history.windows.get('claude:acc-1')!.get(w.id)!;
  expect([pts.length, pts[4]![1]]).toEqual([5, 30]);
  // 20 % in 4 h: runs out long before the reset 3 days on.
  expect(w.pace!.beforeReset).toBe(true);
  expect(w.pace!.exhaustsAt).toBeGreaterThan(0);
  // A restart shows the accounts again, with their history (the pace from
  // it).
  const q = testUsage({ dir: t.dir, ready: [], now: t.clock.now });
  await q.u.loadHistory();
  const s2 = q.snap();
  expect(s2.accounts).toHaveLength(1);
  expect(s2.accounts[0]!.windows[0]!.pace).toEqual(w.pace!);
  // Points older than 30 days go.
  q.u.history.prune(q.sec() + 31 * 86400);
  expect(q.u.history.windows.size).toBe(0);
});

test('pace', () => {
  const now = 1_000_000;
  // Half the time gone, half used: an even pace.
  expect(pace(win('session', 50, now + 3600, 7200), undefined, now)).toEqual({
    expectedPct: 50,
    exhaustsAt: now + 3600,
    beforeReset: undefined,
  });
  expect(pace(win('session', 100, now + 3600, 7200), undefined, now)?.beforeReset).toBe(true);
  expect(pace(win('weekly', 10), undefined, now)).toBeUndefined();
});

test('status pages', async () => {
  const t = testUsage({ ready: [] });
  t.f.status = async (url) => {
    if (url.includes('claude')) return { status: { indicator: 'minor', description: 'Partially Degraded Service' } };
    if (url.includes('google'))
      return [
        { end: '', severity: 'high', external_desc: 'Antigravity errors', affected_products: [{ id: 'npdyhgECDJ6tB66MxXyo' }] },
        { end: '2026-01-01', severity: 'high', affected_products: [{ id: 'npdyhgECDJ6tB66MxXyo' }] },
        { severity: 'high', affected_products: [{ id: 'other' }] },
      ];
    throw new Error('EOF'); // OpenAI's page does not answer
  };
  const signal = new AbortController().signal;
  await t.u.pollStatus(signal);
  const s = t.snap();
  expect([s.status.claude!.indicator, s.status.antigravity!.indicator, s.status.antigravity!.description]).toEqual([
    'minor',
    'major',
    'Antigravity errors',
  ]);
  expect([s.status.codex!.indicator, s.status.codex!.url, s.status.grok!.url]).toEqual([
    undefined,
    'https://status.openai.com',
    'https://status.x.ai',
  ]);
  // A provider turned off has no status.
  t.st.set('usage.providers.grok', '', false);
  await t.u.pollStatus(signal);
  expect(t.snap().status.grok).toBeUndefined();
});

test('the spend of the machines', async () => {
  const t = testUsage({ ready: ['local', 'box'], now: Date.UTC(2026, 10, 16, 3) });
  const since: number[] = [];
  const recent: number[] = [];
  t.f.cost = (m, o) => {
    since.push(o.since);
    recent.push(o.recentSince ?? 0);
    if (m === 'box') throw new Fail('transport', 502);
    return report({
      files: 3,
      rows: [{ day: '2026-11-16', provider: 'claude', model: 'claude-opus-4-6', cost: 1.5, priced: true }],
      recent: [{ at: t.sec() - 1800, provider: 'claude', tokens: 10, requests: 1, cost: 0.5, priced: true }],
    });
  };
  const { rep } = await t.report(7, 480);
  expect([rep.days, rep.tzOffset, rep.rows.length, rep.rows[0]!.machine, rep.machines.box, rep.monthHours]).toEqual([
    7,
    480,
    1,
    'local',
    { error: 'transport', files: 0 },
    750,
  ]);
  // The user's day (UTC+8: 11:00 on the 16th) and 6 before it.
  expect(since[0]).toBe((Date.UTC(2026, 10, 10) - 8 * HOUR) / 1000);
  // Quarters of an hour from the UTC day 8 days back, the machine's.
  expect([recent[0], rep.recentSince]).toEqual([Date.UTC(2026, 10, 8) / 1000, Date.UTC(2026, 10, 8) / 1000]);
  expect(rep.recent).toEqual([expect.objectContaining({ machine: 'local', cost: 0.5 })]);
  // Served again within a minute.
  await t.report(7, 480);
  expect(since).toHaveLength(2);
});

// The user's prices reach the machines' scans, and a change of them is not
// served from the spend's cache.
test('the spend at the user’s prices', async () => {
  const t = testUsage({ now: Date.UTC(2026, 10, 16, 3) });
  const got: CostParams['prices'][] = [];
  t.f.cost = (_, o) => {
    got.push(o.prices);
    return report({ files: 1 });
  };
  await t.report(7, 0);
  expect(() => t.st.set('usage.prices', '', ['grok-5 x 1 2'])).toThrow();
  t.st.set('usage.prices', '', ['grok-5 3 0.75 9']);
  await t.report(7, 0);
  await t.report(7, 0);
  expect(got).toEqual([undefined, { 'grok-5': { inputMax: null, input: 3, cached: 0.75, output: 9 } }]);
});

test('settings', () => {
  const t = testUsage();
  expect([t.st.string('usage.refresh'), t.st.get('usage.thresholds')]).toEqual(['adaptive', ['80', '95']]);
  expect(() => t.st.set('usage.thresholds', '', ['80', '101'])).toThrow();
  t.st.set('usage.thresholds', '', ['50']);
  expect(t.u.options()).toEqual({ providers: [...PROVIDERS], codexHomes: [], claudeKeychain: true, kimiRefresh: true });
  t.st.set('usage.providers.deepseek', '', false);
  t.st.set('usage.claudeKeychain', '', false);
  t.st.set('usage.kimiRefresh', '', false);
  t.st.set('usage.codexHomes', '', ['~/work-codex']);
  const others = PROVIDERS.filter((p) => p !== 'deepseek');
  expect(t.u.options()).toEqual({ providers: others, codexHomes: ['~/work-codex'], claudeKeychain: false, kimiRefresh: false });
  // A read-only hub never has Kimi Code's sign-in renewed (it rewrites the
  // credentials file on the machine), whatever the setting.
  t.st.set('usage.kimiRefresh', '', true);
  expect(t.u.options().kimiRefresh).toBe(true);
  t.env.readOnly = true;
  expect([t.u.options().kimiRefresh, t.u.options().providers]).toEqual([false, others]);
  // Every provider off: none is read.
  for (const p of PROVIDERS) t.st.set(`usage.providers.${p}`, '', false);
  expect(t.u.options().providers).toEqual(['none']);
});

test('the user’s prices', () => {
  expect(parsePrices(['gpt-6 1.25 0.125 10', '', 'claude-x 3 .3 15 3.75'])).toEqual({
    'gpt-6': { inputMax: null, input: 1.25, cached: 0.125, output: 10 },
    'claude-x': { inputMax: null, input: 3, cached: 0.3, output: 15, cacheWrite: 3.75 },
  });
  for (const bad of [
    ['m 1 2'],
    ['m 1 2 3 4 5'],
    ['-m 1 2 3'],
    ['m 1 2 x'],
    ['m 1 2 10001'],
    ['m 1 2 -1'],
    ['m 1 2 3', 'm 4 5 6'],
    Array(51).fill(''),
  ])
    expect(() => parsePrices(bad)).toThrow();
});

test('a refresh waits for the least gap between polls', async () => {
  let polls = 0;
  const t = testUsage();
  t.f.limits = () => {
    polls++;
    return [];
  };
  t.st.set('usage.refresh', '', 'manual');
  // The first refresh runs at once.
  expect(t.u.refresh()).toBe(t.clock.now);
  expect(t.u.due()).toBe(true);
  await t.poll();
  expect(t.u.due()).toBe(false);
  // Refreshes within the gap wait for it and share one poll.
  t.clock.now += 10_000;
  const want = t.clock.now - 10_000 + MIN_REFRESH_GAP;
  expect([t.u.refresh(), t.u.refresh(), t.u.due(), t.snap().nextAt]).toEqual([want, want, false, want / 1000]);
  t.clock.now += 20_000;
  expect(t.u.due()).toBe(true);
  await t.poll();
  expect([t.u.due(), polls]).toEqual([false, 2]);
  // A refresh while a poll runs waits for the gap after it.
  t.u.polling = true;
  expect(t.u.refresh()).toBe(t.clock.now + MIN_REFRESH_GAP);
  t.u.polling = false;
  expect(t.u.due()).toBe(false);
});

test('Retry-After of an account without an id', async () => {
  const got: Record<string, string[] | undefined> = {};
  let limited = true;
  const t = testUsage({ ready: ['local', 'box'] });
  t.f.limits = (m, o) => {
    got[m] = o.skipLocal;
    if (o.skipLocal?.includes('codex:/srv/codex2')) return [acc({ provider: 'codex', home: '/srv/codex2', status: 'skipped' })];
    if (m === 'local' && limited)
      return [acc({ provider: 'codex', home: '/srv/codex2', status: 'error', code: 'rate_limited', retryAfter: 300 })];
    return [acc({ provider: 'codex', home: '/srv/codex2', status: 'ok', asOf: t.sec(), windows: [win('weekly', 5)] })];
  };
  await t.poll();
  expect(find(t.snap(), 'codex:@local:/srv/codex2')?.code).toBe('rate_limited');
  // Until Retry-After has passed, only that machine skips it.
  t.clock.now += MIN;
  await t.poll();
  expect(got).toEqual({ local: ['codex:/srv/codex2'], box: undefined });
  const a = find(t.snap(), 'codex:@local:/srv/codex2')!;
  expect([a.code, a.machines]).toEqual(['rate_limited', ['local']]);
  // Afterwards it is asked again.
  limited = false;
  t.clock.now += 5 * MIN;
  await t.poll();
  expect(got.local).toBeUndefined();
  expect(find(t.snap(), 'codex:@local:/srv/codex2')?.status).toBe('ok');
});

test('requests share a machine’s scan; a request that gives up does not wait', async () => {
  const t = testUsage({ now: Date.UTC(2026, 10, 16, 3) });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  t.f.cost = async () => {
    calls++;
    await gate;
    return report({ files: 1 });
  };
  const all = Promise.all([t.report(30, 0), t.report(30, 0), t.report(30, 0)]);
  await Bun.sleep(20);
  expect(t.u.spend.flights.size).toBe(1);
  release();
  await all;
  expect(calls).toBe(1);
  // A few ranges are kept.
  await t.report(7, 0);
  await t.report(30, 0);
  await t.report(7, 0);
  expect(calls).toBe(2);
  let unblock!: () => void;
  const block = new Promise<void>((r) => (unblock = r));
  t.f.cost = async () => {
    await block;
    return report({});
  };
  const bg = t.report(1, 0);
  await Bun.sleep(5);
  expect(t.u.spend.flights.size).toBe(1);
  const ac = new AbortController();
  ac.abort();
  expect((await t.report(1, 0, ac.signal)).rep.machines.local).toEqual({ error: 'failed', files: 0 });
  unblock();
  await bg;
});

// A machine that connects after the first poll is asked at the next tick,
// alone, without the accounts already read; the cadence stays.
test('a machine that joins is asked at once', async () => {
  const asked: string[] = [];
  let boxSkip: string[] | undefined;
  const t = testUsage();
  t.f.limits = (m, o) => {
    asked.push(m);
    if (m === 'box') {
      boxSkip = o.skip;
      return [
        acc({ provider: 'claude', id: 'acc-1', status: 'skipped' }),
        acc({ provider: 'kimi', status: 'ok', asOf: t.sec(), windows: [win('weekly', 5)] }),
      ];
    }
    return [acc({ provider: 'claude', id: 'acc-1', status: 'ok', asOf: t.sec(), windows: [win('weekly', 40)] })];
  };
  const signal = new AbortController().signal;
  t.u.onMachine({ id: 'local', status: 'ready' });
  await t.u.pollDue(signal);
  const first = t.u.lastPoll;
  t.clock.now += 20_000;
  t.env.ready = ['local', 'box'];
  t.u.onMachine({ id: 'box', status: 'ready' });
  t.u.onMachine({ id: 'box', status: 'ready' }); // again: no second poll
  await t.u.pollDue(signal);
  await t.u.pollDue(signal);
  expect([asked, boxSkip]).toEqual([['local', 'box'], ['claude:acc-1']]);
  const s = t.snap();
  expect(find(s, 'claude:acc-1')?.machines).toEqual(['box', 'local']);
  expect([!!find(s, 'kimi:@box'), t.u.lastPoll, s.machines.local!.status]).toEqual([true, first, 'ok']);
});

// No poll runs, and none counts as the last, while no machine is connected.
test('no poll without machines', async () => {
  const t = testUsage({ ready: [] });
  t.u.refresh();
  expect(t.u.due()).toBe(false);
  await t.poll();
  expect([t.u.lastPoll, t.u.polling]).toEqual([0, false]);
});

// A machine whose poll failed stays among an account's machines; the
// history gets points only for numbers read again.
test('a failed machine, and numbers not read again', async () => {
  let failBox = false;
  const t = testUsage({ ready: ['local', 'box'] });
  t.f.limits = (m, o) => {
    if (m === 'box' && failBox) throw offline();
    if (o.skip?.includes('claude:acc-1')) return [acc({ provider: 'claude', id: 'acc-1', status: 'skipped' })];
    return [acc({ provider: 'claude', id: 'acc-1', status: 'ok', asOf: t.sec(), windows: [win('weekly', 40)] })];
  };
  await t.poll();
  failBox = true;
  t.clock.now += HOUR;
  await t.poll();
  expect(find(t.snap(), 'claude:acc-1')?.machines).toEqual(['local', 'box']);
  // Every machine offline: the numbers stay, the history gets no point.
  t.f.limits = () => {
    throw offline();
  };
  for (let i = 0; i < 4; i++) {
    t.clock.now += HOUR;
    await t.poll();
  }
  expect(t.u.history.windows.get('claude:acc-1')!.get('weekly|')).toHaveLength(2);
});

test('a provider turned off leaves the snapshot at once', async () => {
  const t = testUsage();
  t.f.limits = () => [acc({ provider: 'claude', id: 'acc-1', status: 'ok', asOf: t.sec(), windows: [win('weekly', 40)] })];
  await t.poll();
  t.st.set('usage.providers.claude', '', false);
  expect(t.snap().accounts).toHaveLength(0);
  t.st.set('usage.providers.claude', '', true);
  expect(t.snap().accounts).toHaveLength(1);
});

test('window ids', () => {
  const ws = [win('session', 1, 0, 18000), win('session', 2, 0, 3600), win('weekly', 3), win('weekly', 4), win('model', 0, 0, 0, 'M')];
  expect(windowIDs(ws)).toEqual(['session||18000', 'session||3600', 'weekly||0', 'weekly||0#1', 'model|M']);
});

// The best answer of a poll counts whatever the machines' order: a sign-in
// expired on one machine does not hide the numbers another read; it is
// listed as an issue.
test('the best answer wins', async () => {
  const t = testUsage({ ready: ['local', 'box'] });
  t.f.limits = (m) =>
    m === 'local'
      ? [acc({ provider: 'kimi', id: 'u1', status: 'stale', code: 'token_expired' })]
      : [acc({ provider: 'kimi', id: 'u1', status: 'ok', asOf: t.sec(), windows: [win('weekly', 30)] })];
  await t.poll();
  const a = find(t.snap(), 'kimi:u1')!;
  expect([a.status, a.windows.length, a.issues]).toEqual(['ok', 1, [{ machine: 'local', status: 'stale', code: 'token_expired' }]]);
  // The other order: the same.
  const t2 = testUsage({ ready: ['box', 'local'] });
  t2.f.limits = (m) =>
    m === 'local'
      ? [acc({ provider: 'kimi', id: 'u1', status: 'unauth', code: 'unauthorized' })]
      : [acc({ provider: 'kimi', id: 'u1', status: 'error', code: 'network' })];
  await t2.poll();
  const b = find(t2.snap(), 'kimi:u1')!;
  expect([b.status, b.issues?.length]).toEqual(['error', 2]);
});

test('an account named replaces its stand-in', async () => {
  let named = false;
  const t = testUsage({ ready: ['local', 'box'] });
  t.f.limits = (m) => [
    acc({ provider: 'antigravity', id: named && m === 'local' ? 'h1' : '', status: 'ok', asOf: t.sec(), windows: [win('weekly', 50)] }),
  ];
  await t.poll();
  expect(find(t.snap(), 'antigravity:@local')).toBeDefined();
  // The machine reads the account's id: one card, not two.
  named = true;
  t.clock.now += HOUR;
  await t.poll();
  const s = t.snap();
  expect([!!find(s, 'antigravity:@local'), !!find(s, 'antigravity:h1'), !!find(s, 'antigravity:@box')]).toEqual([false, true, true]);
});

// Machines that read the account's id after another one did are told to
// skip it: their answers, skipped, replace their accounts without an id all
// the same, and the account lists every machine.
test('skipped answers replace their stand-ins', async () => {
  let named = false;
  const t = testUsage({ ready: ['local', 'box', 'gpu'] });
  t.f.limits = (_, o) => {
    if (named && o.skip?.includes('antigravity:h1')) return [acc({ provider: 'antigravity', id: 'h1', status: 'skipped' })];
    return [acc({ provider: 'antigravity', id: named ? 'h1' : '', status: 'ok', asOf: t.sec(), windows: [win('weekly', 50)] })];
  };
  await t.poll();
  expect(t.snap().accounts).toHaveLength(3);
  named = true;
  t.clock.now += HOUR;
  await t.poll();
  const s = t.snap();
  expect(s.accounts).toHaveLength(1);
  expect(find(s, 'antigravity:h1')?.machines).toHaveLength(3);
});

// Turning a provider off or changing usage.codexHomes is a new report, not
// the cached one.
test('the spend’s cache is per providers and Codex homes', async () => {
  const t = testUsage({ now: Date.UTC(2026, 10, 16, 3) });
  const got: CostParams[] = [];
  t.f.cost = (_, o) => {
    got.push(o);
    return report({ files: got.length });
  };
  await t.report(30, 0);
  await t.report(30, 0);
  expect(got).toHaveLength(1);
  t.st.set('usage.providers.grok', '', false);
  await t.report(30, 0);
  expect([got.length, got[1]!.providers?.includes('grok')]).toEqual([2, false]);
  t.st.set('usage.codexHomes', '', ['/srv/codex-alt']);
  await t.report(30, 0);
  expect([got.length, got[2]!.codexHomes]).toEqual([3, ['/srv/codex-alt']]);
});

// A machine is asked with its report's ETag and its last report is reused
// when it answers notModified; the report's own ETag is of its content.
test('ETags of the machines and of the report', async () => {
  const t = testUsage({ now: Date.UTC(2026, 10, 16, 3) });
  const seen: (string | undefined)[] = [];
  let agentETag = 'cost-v1';
  t.f.cost = (_, o) => {
    seen.push(o.ifNoneMatch);
    if (o.ifNoneMatch === agentETag) return report({ since: o.since, etag: agentETag, notModified: true });
    return report({
      since: o.since,
      etag: agentETag,
      files: 2,
      rows: [{ day: '2026-11-16', provider: 'claude', model: 'claude-opus-4-6', cost: 1.5, requests: 1, priced: true }],
    });
  };
  const first = await t.report(30, 0);
  expect(first.rep.rows).toHaveLength(1);
  expect((await t.report(30, 0)).etag).toBe(first.etag);
  t.clock.now += COST_FRESH + 1000;
  const second = await t.report(30, 0);
  expect([seen, second.etag, second.rep.rows.length]).toEqual([[undefined, 'cost-v1'], first.etag, 1]);
  // A new ETag of the machine with the same rows: the same report.
  agentETag = 'cost-v2';
  t.clock.now += COST_FRESH + 1000;
  expect((await t.report(30, 0)).etag).toBe(first.etag);
  t.f.cost = (_, o) =>
    report({
      since: o.since,
      etag: 'cost-v3',
      files: 3,
      rows: [{ day: '2026-11-16', provider: 'claude', model: 'claude-opus-4-6', cost: 3, requests: 2, priced: true }],
    });
  t.clock.now += COST_FRESH + 1000;
  expect((await t.report(30, 0)).etag).not.toBe(first.etag);
});

// A background poll does not announce its start; a watched or asked-for one
// does; the snapshot's ETag holds between polls.
test('the snapshot’s ETag and broadcasts', async () => {
  const t = testUsage();
  t.f.limits = () => [
    acc({ provider: 'claude', id: 'acc-1', status: 'ok', asOf: t.sec(), windows: [win('session', 25, t.sec() + 3600, 18000)] }),
  ];
  await t.poll();
  expect(t.sent).toHaveLength(2);
  t.sent.length = 0;
  t.clock.now += 30 * MIN;
  await t.poll();
  expect(t.sent.map((s) => s.polling)).toEqual([false]);
  t.u.watch();
  const etag = Usage.etag(t.u.snapshot());
  t.clock.now += 2 * MIN;
  t.u.watch();
  expect(Usage.etag(t.u.snapshot())).toBe(etag);
  t.sent.length = 0;
  await t.poll();
  expect(t.sent.map((s) => s.polling)).toEqual([true, false]);
});

// Machines not connected (disabled, offline) are not asked, yet their last
// spend stays in the report, also narrowed to a range or providers and
// after a restart, until the machine is removed.
test('the spend of machines not connected', async () => {
  const dir = tempDir();
  const polled: string[] = [];
  const start = (ready: string[]) => {
    const t = testUsage({ dir, ready, known: ['local', 'box'], now: Date.UTC(2026, 10, 16, 12) });
    t.f.limits = (m) => {
      polled.push(`limits:${m}`);
      return [];
    };
    t.f.cost = (m) => {
      polled.push(`cost:${m}`);
      if (m === 'local')
        return report({
          etag: 'local-1',
          files: 1,
          rows: [
            { day: '2026-11-16', provider: 'claude', model: 'claude-opus-4-6', input: 10, output: 5, requests: 1, cost: 1, priced: true },
          ],
        });
      return report({
        etag: 'box-1',
        files: 2,
        rows: [
          { day: '2026-11-16', provider: 'claude', model: 'claude-opus-4-6', input: 20, output: 10, requests: 2, cost: 2.5, priced: true },
          { day: '2026-11-01', provider: 'codex', model: 'gpt-5', input: 30, output: 15, requests: 1, cost: 3, priced: true },
        ],
      });
    };
    return t;
  };
  const t = start(['local', 'box']);
  expect((await t.report(30, 0)).rep.rows).toHaveLength(3);
  // Disabled: box is not asked again.
  t.env.ready = ['local'];
  polled.length = 0;
  t.clock.now += COST_FRESH + 1000;
  await t.poll();
  const r2 = (await t.report(30, 0)).rep;
  expect([r2.rows.length, r2.machines.box]).toEqual([3, { files: 2 }]);
  // A narrower range and a provider off filter its rows without asking it.
  expect((await t.report(7, 0)).rep.rows).toHaveLength(2);
  t.st.set('usage.providers.codex', '', false);
  expect((await t.report(30, 0)).rep.rows).toHaveLength(2);
  t.st.set('usage.providers.codex', '', true);
  expect(polled.some((p) => p.endsWith(':box'))).toBe(false);
  // After a restart its spend is still there.
  const q = start(['local']);
  const r3 = (await q.report(30, 0)).rep;
  expect([r3.rows.length, r3.machines.box?.files]).toEqual([3, 2]);
  expect(polled.some((p) => p.endsWith(':box'))).toBe(false);
  // Removed: its spend goes.
  q.u.forget('box');
  expect((await q.report(30, 0)).rep.rows.map((r) => r.machine)).toEqual(['local']);
});
