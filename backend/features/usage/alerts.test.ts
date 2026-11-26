// The alerts the hub fires: at most once per period of a window and
// threshold, whatever the numbers do between polls (the Go hub's
// alerts_test.go). The first tests are the ways alerts fired again and
// again when pages decided them: use jittering around a threshold, a reset
// time that moves, a pace alert whose reset is a second off, a "started
// over" from a second of drift, windows coming and going, machines
// answering in turn.
import { afterAll, expect, test } from 'bun:test';
import type { Window } from './protocol.ts';
import { acc, removeTempDirs, T0, tempDir, testUsage, win } from './testing.ts';

afterAll(removeTempDirs);

/** Polls one account whose windows each poll sets; poll returns the
 * alerts fired, as kind or kind:threshold (pace only with withPace). */
function alertRun(thresholds?: string[], withPace = false, dir?: string) {
  let ws: Window[] = [];
  const t = testUsage({ dir });
  t.f.limits = () => [acc({ provider: 'antigravity', id: 'h1', status: 'ok', windows: ws, asOf: t.sec() })];
  if (thresholds) t.st.set('usage.thresholds', '', thresholds);
  const poll = async (at: number, ...w: Window[]) => {
    t.clock.now = (T0 + at) * 1000;
    ws = w;
    await t.poll();
    return (t.u.snapshot().alerts ?? [])
      .filter((a) => a.at === T0 + at && (withPace || a.kind !== 'pace'))
      .map((a) => (a.threshold ? `${a.kind}:${a.threshold}` : a.kind));
  };
  return { t, poll };
}

test('use jittering around a threshold', async () => {
  const r = alertRun(['80']);
  const got: string[] = [];
  for (const [i, pct] of [80.4, 79.6, 80.2, 79.9, 80.1, 79.0, 81].entries())
    got.push(...(await r.poll(i * 300, win('weekly', pct, T0 + 86400, 604800))));
  expect(got).toEqual(['threshold:80']);
});

test('a reset moving forward', async () => {
  const r = alertRun(['80']);
  const got: string[] = [];
  // A rolling window: its reset moves 4 minutes at each 5-minute poll.
  for (let i = 0; i < 12; i++) got.push(...(await r.poll(i * 300, win('session', 85, T0 + 3600 + i * 240, 18000))));
  expect(got).toEqual(['threshold:80']);
  // Once the period it fired in is over, the next one may fire.
  expect(await r.poll(12 * 300 + 60, win('session', 85, T0 + 3600 + 12 * 240 + 60, 18000))).toEqual(['threshold:80']);
});

test('a pace alert with a reset a second off', async () => {
  const r = alertRun(['95'], true);
  const got: string[] = [];
  // An hour into a 5-hour window, half used: it runs out before the reset,
  // which the provider says a second apart at each poll.
  for (const [i, d] of [0, 1, 0, 1, 0].entries()) got.push(...(await r.poll(i * 120, win('session', 50, T0 + 4 * 3600 + d, 18000))));
  expect(got).toEqual(['pace']);
});

test('no "started over" from drift', async () => {
  const r = alertRun(['80']);
  const got = [
    ...(await r.poll(0, win('weekly', 85, T0 + 86400, 604800))),
    ...(await r.poll(300, win('weekly', 84.5, T0 + 86401, 604800))),
    ...(await r.poll(600, win('weekly', 85, T0 + 86400 + 300, 604800))),
  ];
  expect(got).toEqual(['threshold:80']);
});

test('windows coming and going', async () => {
  const r = alertRun(['80']);
  const five = win('session', 85, T0 + 3600, 18000);
  const one = win('session', 10, T0 + 600, 3600);
  const got = [
    ...(await r.poll(0, five, one)),
    ...(await r.poll(300, five)),
    ...(await r.poll(500, five, one)),
    ...(await r.poll(550, one, five)),
  ];
  expect(got).toEqual(['threshold:80']);
});

test('machines answering in turn', async () => {
  let turn = 0;
  const t = testUsage({ ready: ['local', 'box'] });
  t.f.limits = (m, o) => {
    if (o.skip?.includes('claude:acc')) return [acc({ provider: 'claude', id: 'acc', status: 'skipped' })];
    // The machines take turns having an expired sign-in.
    if ((m === 'local') === (turn % 2 === 1)) return [acc({ provider: 'claude', id: 'acc', status: 'stale', code: 'token_expired' })];
    return [acc({ provider: 'claude', id: 'acc', status: 'ok', asOf: t.sec(), windows: [win('weekly', 85, T0 + 86400, 604800)] })];
  };
  for (turn = 0; turn < 6; turn++) {
    t.clock.now = (T0 + turn * 300) * 1000;
    await t.poll();
  }
  expect(t.u.snapshot().alerts).toHaveLength(1);
});

test('new periods', async () => {
  const r = alertRun(['80', '95']);
  expect(await r.poll(0, win('session', 85, T0 + 3600, 18000))).toEqual(['threshold:80']);
  // The period ended unseen; the next one is over the threshold when first
  // read: it started over, and is at the threshold again.
  expect(await r.poll(5000, win('session', 82, T0 + 3600 + 18000, 18000))).toEqual(['reset', 'threshold:80']);
  expect(await r.poll(5300, win('session', 96, T0 + 3600 + 18000, 18000))).toEqual(['threshold:95']);
  // Started over early (a provider's reset): said once, and the thresholds
  // are armed for the new period.
  expect(await r.poll(5600, win('session', 5, T0 + 5600 + 18000, 18000))).toEqual(['reset']);
  expect(await r.poll(5900, win('session', 6, T0 + 5600 + 18001, 18000))).toEqual([]);
  expect(await r.poll(9000, win('session', 81, T0 + 5600 + 18000, 18000))).toEqual(['threshold:80']);
});

test('without a known reset', async () => {
  const r = alertRun(['80']);
  const got: string[] = [];
  // Armed again only after falling 10 points below.
  for (const [i, pct] of [81, 75, 81, 69, 81].entries()) got.push(...(await r.poll(i * 300, win('monthly', pct))));
  expect(got).toEqual(['threshold:80', 'threshold:80']);
});

test('the switch and the snapshot', async () => {
  const r = alertRun(['80']);
  const st = r.t.st;
  st.set('usage.alerts', '', false);
  expect(await r.poll(0, win('weekly', 90, T0 + 86400, 604800))).toEqual([]);
  expect(r.t.u.snapshot().alerts).toBeUndefined();
  // Turned on: what is over a threshold now is said once.
  st.set('usage.alerts', '', true);
  expect(await r.poll(300, win('weekly', 90, T0 + 86400, 604800))).toEqual(['threshold:80']);
  const a = r.t.u.snapshot().alerts![0]!;
  expect([a.key, a.provider, a.window.usedPct, a.window.id, !!a.id]).toEqual(['antigravity:h1', 'antigravity', 90, 'weekly|', true]);
  // Turned off again: the snapshot carries none.
  st.set('usage.alerts', '', false);
  expect(r.t.u.snapshot().alerts).toBeUndefined();
  st.set('usage.alerts', '', true);
  // A provider turned off: its alerts leave the snapshot.
  st.set('usage.providers.antigravity', '', false);
  expect(r.t.u.snapshot().alerts).toBeUndefined();
  st.set('usage.providers.antigravity', '', true);
  // An hour later the snapshot no longer carries it.
  await r.poll(300 + 3601, win('weekly', 91, T0 + 86400, 604800));
  expect(r.t.u.snapshot().alerts).toBeUndefined();
});

test('kept across restarts', async () => {
  const dir = tempDir();
  const first = alertRun(undefined, false, dir);
  expect(await first.poll(0, win('weekly', 85, T0 + 86400, 604800))).toEqual(['threshold:80']);
  const again = alertRun(undefined, false, dir);
  await again.t.u.loadHistory();
  expect(await again.poll(7200, win('weekly', 85, T0 + 86400, 604800))).toEqual([]);
});
