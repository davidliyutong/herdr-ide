// @vitest-environment jsdom
//
// The AI usage plugin: ordering accounts, alerts on thresholds, resets and
// pace, the cost report's sums, and the panel and status bar item drawn
// from a stubbed core.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import { useSettings } from '../settings';
import type { MachineState } from '../lib/machine';
import { UsagePanel } from '../plugins/usage/UsagePanel';
import { UsageStatusItem } from '../plugins/usage/StatusItem';
import { applySnapshot, setView, useUsage } from '../plugins/usage/state';
import {
  alerts,
  costOf,
  daily,
  equivalents,
  rank,
  sortAccounts,
  tightest,
  type CostRow,
  type UsageAccount,
  type UsageSnapshot,
} from '../plugins/usage/model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Math.floor(Date.now() / 1000);

function account(key: string, pcts: number[], extra: Partial<UsageAccount> = {}): UsageAccount {
  return {
    key,
    provider: key.split(':')[0],
    status: 'ok',
    machines: ['local'],
    seenAt: now,
    windows: pcts.map((p, i) => ({ kind: i ? 'weekly' : 'session', usedPct: p, resetsAt: now + 3600 * (i + 1), windowSec: 18000 })),
    ...extra,
  };
}

function snapshot(accounts: UsageAccount[]): UsageSnapshot {
  return { updatedAt: now - 60, refresh: 'adaptive', interval: 1800, polling: false, accounts, machines: {}, status: {} };
}

describe('usage model', () => {
  it('sorts accounts tightest first and finds the tightest window', () => {
    const list = [account('codex:a', [10, 30]), account('claude:b', [85, 20]), account('grok:c', []), account('kimi:d', [50])];
    expect(sortAccounts(list).map((a) => a.key)).toEqual(['claude:b', 'kimi:d', 'codex:a', 'grok:c']);
    const top = tightest(snapshot(list))!;
    expect(top.account.key).toBe('claude:b');
    expect(top.window.usedPct).toBe(85);
    expect(tightest(snapshot([account('grok:c', [])]))).toBeUndefined();
  });

  it('alerts once per threshold, again after recovering, and on resets and pace', () => {
    const fired: Record<string, number> = {};
    const a1 = snapshot([account('claude:x', [82])]);
    expect(alerts(undefined, a1, [80, 95], fired).map((a) => [a.kind, a.threshold])).toEqual([['threshold', 80]]);
    // The same use again: nothing new.
    expect(alerts(a1, snapshot([account('claude:x', [83])]), [80, 95], fired)).toEqual([]);
    const a2 = snapshot([account('claude:x', [96])]);
    expect(alerts(a1, a2, [80, 95], fired).map((a) => a.threshold)).toEqual([95]);
    // The window started over: a reset, and the thresholds are armed again.
    const reset = account('claude:x', [5]);
    reset.windows[0].resetsAt = now + 18000;
    expect(alerts(a2, snapshot([reset]), [80, 95], fired).map((a) => a.kind)).toEqual(['reset']);
    expect(alerts(snapshot([reset]), a1, [80, 95], fired).map((a) => a.threshold)).toEqual([80]);
    // A pace that runs out before the reset: once per period.
    const fast = account('codex:y', [40]);
    fast.windows[0].pace = { expectedPct: 10, exhaustsAt: now + 600, beforeReset: true };
    expect(alerts(undefined, snapshot([fast]), [80], fired).map((a) => a.kind)).toEqual(['pace']);
    expect(alerts(undefined, snapshot([fast]), [80], fired)).toEqual([]);
    // Accounts that are not ok bring no alerts.
    expect(alerts(undefined, snapshot([account('kimi:z', [99], { status: 'stale' })]), [80], {})).toEqual([]);
  });

  it('sums the cost of days, ranks and extrapolates', () => {
    const today = new Date(2026, 10, 16, 12);
    const row = (day: string, cost: number, model: string, machine = 'local'): CostRow => ({
      day,
      provider: 'claude',
      model,
      project: 'p',
      machine,
      input: 10,
      cached: 0,
      cacheWrite: 0,
      output: 5,
      requests: 1,
      cost,
      priced: true,
    });
    const rows = [
      row('2026-11-16', 1, 'opus'),
      row('2026-11-15', 2, 'sonnet', 'box'),
      row('2026-11-01', 4, 'opus'),
      row('2026-08-01', 8, 'opus'),
    ];
    expect(costOf(rows, 1, today)).toBe(1);
    expect(costOf(rows, 7, today)).toBe(3);
    expect(costOf(rows, 30, today)).toBe(7);
    expect(daily(rows, 3, today)).toEqual([
      { day: '2026-11-14', cost: 0 },
      { day: '2026-11-15', cost: 2 },
      { day: '2026-11-16', cost: 1 },
    ]);
    expect(rank(rows, 'model', 30, today).map((r) => [r.name, r.cost])).toEqual([
      ['opus', 5],
      ['sonnet', 2],
    ]);
    expect(rank(rows, 'machine', 7, today).map((r) => r.name)).toEqual(['box', 'local']);
    const eq = equivalents(7, 7);
    expect(eq.week).toBeCloseTo(7);
    expect(eq.month).toBeCloseTo((7 * 750) / 168);
  });
});

describe('usage panel and status item', () => {
  let host: HTMLDivElement;
  let root: Root;
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (String(url).startsWith('/api/p/usage/cost')) {
        const today = new Date();
        const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        return new Response(
          JSON.stringify({
            generatedAt: now,
            days: 90,
            weekHours: 168,
            monthHours: 750,
            machines: { local: { files: 2 }, box: { error: 'offline', files: 0 } },
            rows: [
              {
                day,
                provider: 'claude',
                model: 'claude-opus-4-6',
                project: 'alpha',
                machine: 'local',
                input: 1,
                cached: 0,
                cacheWrite: 0,
                output: 1,
                requests: 1,
                cost: 12.5,
                priced: true,
              },
            ],
          }),
        );
      }
      if (String(url).startsWith('/api/p/usage/refresh')) return new Response('{"queued":true}', { status: 202 });
      if (String(url).startsWith('/api/p/usage')) return new Response(JSON.stringify(useUsage.getState().snapshot ?? snapshot([])));
      return new Response('{}', { status: 404 });
    });
    useSettings.setState({ values: {}, readOnly: false });
    useUsage.setState({ snapshot: undefined, cost: undefined });
    setView({ tab: 'limits', remaining: false, compact: false, costDays: 30 });
    useStore.getState().setPanel(undefined);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('shows the tightest window in the status bar and opens the panel', async () => {
    await act(async () => root.render(createElement(UsageStatusItem)));
    expect(host.querySelector('.usage-status-item')).toBeNull();
    expect(calls).toContain('GET /api/p/usage');
    await act(async () => applySnapshot(snapshot([account('codex:a', [40]), account('claude:b', [85])])));
    const item = host.querySelector<HTMLButtonElement>('.usage-status-item')!;
    expect(item.textContent).toBe('85% used');
    expect(item.classList.contains('warn')).toBe(true);
    await act(async () => item.click());
    expect(useStore.getState().panel).toBe('usage');
    // Remaining instead of used; below the first threshold, no warning.
    await act(async () => {
      setView({ remaining: true });
      applySnapshot(snapshot([account('codex:a', [40])]));
    });
    expect(item.textContent).toBe('60% left');
    expect(item.classList.contains('warn')).toBe(false);
  });

  it('draws the accounts tightest first, with their windows and machines', async () => {
    useUsage.setState({
      snapshot: snapshot([
        account('codex:a', [20], { plan: 'Plus', email: 'c@example.com' }),
        account('claude:b', [90, 50], { status: 'stale', code: 'token_expired', machines: ['local', 'box'] }),
      ]),
    });
    await act(async () => root.render(createElement(UsagePanel)));
    expect(calls).toContain('GET /api/p/usage?watch=1');
    const cards = [...host.querySelectorAll<HTMLElement>('.usage-card')];
    expect(cards.map((c) => c.dataset.account)).toEqual(['claude:b', 'codex:a']);
    expect(cards[0].querySelectorAll('.usage-window')).toHaveLength(2);
    expect(cards[0].querySelector('.usage-window')!.classList.contains('warn')).toBe(true);
    expect(cards[0].querySelector('.usage-hint')!.textContent).toContain('Run Claude once');
    expect(cards[0].querySelector('.usage-machines')!.textContent).toContain('local, box');
    expect(cards[1].querySelector('.usage-plan')!.textContent).toBe('Plus');
    // Compact: one window per account.
    const compact = [...host.querySelectorAll<HTMLButtonElement>('.usage-toggle')].find((b) => b.textContent === 'Detailed')!;
    await act(async () => compact.click());
    expect(host.querySelector('.usage-card')!.querySelectorAll('.usage-window')).toHaveLength(1);
    // Refresh asks the core.
    await act(async () => host.querySelector<HTMLButtonElement>('.usage-refresh')!.click());
    expect(calls).toContain('POST /api/p/usage/refresh');
  });

  it('renders with ready machines in the store (no render loop)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      useStore
        .getState()
        .setMachines([
          { id: 'local', label: 'This Mac', kind: 'local', status: 'ready' } as unknown as MachineState,
          { id: 'box', label: 'box', kind: 'ssh', status: 'ready' } as unknown as MachineState,
        ]);
      useUsage.setState({ snapshot: snapshot([account('claude:b', [30], { machines: ['local', 'box'] })]) });
      await act(async () => root.render(createElement(UsagePanel)));
      await act(async () => {});
      expect(host.querySelector('.usage-card')).not.toBeNull();
      const options = [...host.querySelectorAll<HTMLOptionElement>('.usage-deepseek option')].map((o) => o.textContent);
      expect(options).toEqual(['This Mac', 'box']);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      useStore.getState().setMachines([]);
    }
  });

  it('shows the cost tab: totals, daily bars, ranking and machines that failed', async () => {
    await act(async () => root.render(createElement(UsagePanel)));
    const costTab = [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')].find((b) => b.textContent === 'Cost')!;
    await act(async () => costTab.click());
    await act(async () => {});
    expect(calls.some((c) => c.startsWith('GET /api/p/usage/cost?days=90&tz='))).toBe(true);
    const totals = [...host.querySelectorAll('.usage-total-value')].map((e) => e.textContent);
    expect(totals).toEqual(['$12.50', '$12.50', '$12.50', '$12.50']);
    expect(host.querySelectorAll('.usage-daily rect')).toHaveLength(30);
    expect(host.querySelector('.usage-rank li')!.textContent).toContain('claude-opus-4-6');
    expect(host.querySelector('.usage-cost .error')!.textContent).toContain('offline');
  });
});
