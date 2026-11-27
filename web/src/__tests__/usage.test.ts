// @vitest-environment jsdom
//
// The AI usage plugin: ordering accounts, the hub's alerts shown once per
// browser, the cost report's sums, and the panel and status bar item drawn
// from a stubbed hub.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { storage } from '../brand';
import { useStore } from '../state/store';
import { useSettings } from '../settings';
import type { MachineState } from '../lib/machine';
import { groupWindows, UsagePanel } from '../plugins/usage/UsagePanel';
import { formatStatusBarLabel, UsageStatusItem } from '../plugins/usage/StatusItem';
import {
  COLLAPSED_ACCOUNTS_KEY,
  accountCollapseKey,
  applySnapshot,
  costStale,
  fetchCost,
  fetchSnapshot,
  setView,
  useUsage,
} from '../plugins/usage/state';
import {
  accountUsedPct,
  costOf,
  daily,
  dailyDetails,
  dayOf,
  equivalents,
  estimateAccountValue,
  estimatePlanUsd,
  estimatePlanWeight,
  isMergedAccount,
  mergeProviderAccounts,
  pickAccountWindows,
  previewAccounts,
  primaryWindowsOf,
  rank,
  rankTokens,
  sortAccounts,
  statusBarSelection,
  modelBreakdown,
  shortModel,
  tightest,
  tightestFor,
  tightestWindow,
  tokenKinds,
  windowApplies,
  windowSpend,
  type CostReport,
  type CostRow,
  type CostSlot,
  type UsageAccount,
  type UsageAlert,
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

  it('leaves windows past their reset out of the tightest', () => {
    const past = account('codex:q', [95, 30]);
    past.windows[0].resetsAt = now - 60;
    expect(tightest(snapshot([past]))!.window.usedPct).toBe(30);
  });

  it('shows each alert of the hub once in a browser: again in a snapshot, another page or after a reload', () => {
    const alert = (id: string, at = now): UsageAlert => ({
      id,
      kind: 'threshold',
      key: 'claude:x',
      provider: 'claude',
      email: 'x@example.com',
      window: { kind: 'weekly', usedPct: 82, resetsAt: now + 3630 },
      threshold: 80,
      at,
    });
    const shown = () => useStore.getState().toasts.map((x) => x.msg);
    useStore.setState({ toasts: [] });
    localStorage.clear();
    const s = { ...snapshot([account('claude:x', [82])]), updatedAt: now, alerts: [alert('a1'), alert('old', now - 7200)] };
    applySnapshot(s);
    expect(shown()).toEqual(['Claude · x@example.com: Weekly at 82%, resets in 1h 0m']);
    // The same alert in the next snapshot, from another page of the
    // browser (the same storage) and after a reload: not again.
    applySnapshot({ ...s, updatedAt: now + 60 });
    useUsage.setState({ snapshot: undefined });
    applySnapshot({ ...s, updatedAt: now + 120 });
    expect(shown()).toHaveLength(1);
    // A new one is.
    applySnapshot({ ...s, updatedAt: now + 180, alerts: [alert('a1'), alert('a2')] });
    expect(shown()).toHaveLength(2);
    useUsage.setState({ snapshot: undefined });
    useStore.setState({ toasts: [] });
  });

  it('keeps a newer snapshot over an older answer', () => {
    applySnapshot({ ...snapshot([account('claude:n', [10])]), updatedAt: now });
    applySnapshot({ ...snapshot([account('claude:n', [90])]), updatedAt: now - 120, polling: true });
    expect(useUsage.getState().snapshot!.accounts[0].windows[0].usedPct).toBe(10);
    useUsage.setState({ snapshot: undefined });
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

describe('usage windows of an agent', () => {
  it('follows the service, machine and model of the focused agent', () => {
    const claude = account('claude:a', [30, 50], {
      windows: [
        { kind: 'session', usedPct: 30, resetsAt: now + 3600, windowSec: 18000 },
        { kind: 'weekly', usedPct: 50, resetsAt: now + 86400, windowSec: 604800 },
        { kind: 'model', label: 'Opus', usedPct: 90, resetsAt: now + 86400, windowSec: 604800 },
      ],
    });
    const codex = account('codex:b', [95], { machines: ['box'] });
    const s = snapshot([claude, codex]);
    expect(tightest(s)!.account.key).toBe('codex:b');
    expect(windowApplies(claude.windows[2], 'claude-opus-4-6-20260101')).toBe(true);
    expect(windowApplies(claude.windows[2], 'claude-sonnet-4-6')).toBe(false);
    expect(windowApplies(claude.windows[2])).toBe(false);
    expect(tightestFor(s, 'claude', 'local', 'claude-opus-4-6')!.window.usedPct).toBe(90);
    expect(tightestFor(s, 'claude', 'local', 'claude-sonnet-4-6')!.window.usedPct).toBe(50);
    expect(tightestFor(s, 'claude', 'local')!.window.usedPct).toBe(50);
    // Read on another machine only: that account.
    expect(tightestFor(s, 'codex', 'local')!.account.key).toBe('codex:b');
    expect(tightestFor(s, 'grok', 'local')).toBeUndefined();
    expect(shortModel('claude-opus-4-6-20260101')).toBe('opus-4-6');
    expect(shortModel('gpt-5.5')).toBe('gpt-5.5');
  });

  it('sums the spend of a window since it started, and the whole window at that rate', () => {
    const a = account('claude:a', [20], {
      windows: [{ kind: 'session', usedPct: 20, resetsAt: now + 3600, windowSec: 5 * 3600 }],
      machines: ['local', 'box'],
    });
    const start = now + 3600 - 5 * 3600;
    const slot = (at: number, over: Partial<CostSlot> = {}): CostSlot => ({
      at,
      provider: 'claude',
      machine: 'local',
      tokens: 1000,
      requests: 2,
      cost: 1,
      priced: true,
      ...over,
    });
    const rep = {
      generatedAt: now,
      days: 7,
      weekHours: 168,
      monthHours: 750,
      machines: {},
      rows: [],
      recentSince: now - 8 * 86400,
      recent: [
        slot(start - 900), // before the window
        slot(start - 300), // most of it in the window
        slot(start + 600, { machine: 'box', priced: false }),
        slot(start + 1200, { provider: 'codex' }),
        slot(start + 1800, { machine: 'other' }),
      ],
    } satisfies CostReport;
    const s = windowSpend(rep, a, a.windows[0], now)!;
    expect(s).toMatchObject({ cost: 2, tokens: 2000, requests: 4, priced: false });
    expect(s.full).toEqual({ cost: 10, tokens: 10000 });
    // A model's window, a window that started before the slots, none at all.
    expect(windowSpend(rep, a, { ...a.windows[0], kind: 'model', label: 'Opus' }, now)).toBeUndefined();
    expect(windowSpend({ ...rep, recentSince: now }, a, a.windows[0], now)).toBeUndefined();
    expect(windowSpend({ ...rep, recent: undefined }, a, a.windows[0], now)).toBeUndefined();
    // Under 5% used: no estimate of the whole.
    expect(windowSpend(rep, a, { ...a.windows[0], usedPct: 3 }, now)!.full).toBeUndefined();
  });
});

describe('usage tokens', () => {
  const today = new Date(2026, 10, 16, 12);
  const row = (day: string, model: string, over: Partial<CostRow> = {}): CostRow => ({
    day,
    provider: 'codex',
    model,
    project: 'p',
    machine: 'local',
    input: 100,
    cached: 50,
    cacheWrite: 20,
    output: 30,
    reasoning: 10,
    requests: 2,
    cost: 1,
    priced: true,
    ...over,
  });
  const rows = [
    row('2026-11-16', 'known'),
    row('2026-11-15', 'new-model', { cost: 0, priced: false, input: 1000 }),
    row('2026-08-01', 'known'),
  ];

  it('breaks the days down by service and model, with their kinds', () => {
    const more = [...rows, row('2026-11-16', 'known', { provider: 'claude', cost: 5 })];
    const byCost = modelBreakdown(more, 7, today);
    expect(byCost.map((m) => `${m.provider}/${m.name}`)).toEqual(['claude/known', 'codex/known', 'codex/new-model']);
    expect(byCost[1]).toMatchObject({
      input: 100,
      cached: 50,
      cacheWrite: 20,
      output: 30,
      reasoning: 10,
      total: 200,
      requests: 2,
      cost: 1,
    });
    expect(byCost[2].unpriced).toBe(true);
    expect(modelBreakdown(more, 7, today, 'tokens')[0].name).toBe('new-model');
    expect(modelBreakdown(more, 7, today).some((m) => m.total === 400)).toBe(false);
  });

  it('sums the kinds, with reasoning inside the output', () => {
    expect(tokenKinds(rows, 7, today)).toEqual({
      input: 1100,
      cached: 100,
      cacheWrite: 40,
      output: 60,
      reasoning: 20,
      total: 1300,
      requests: 4,
    });
  });

  it('gives a series per day, unpriced rows included', () => {
    const det = dailyDetails(
      [...rows, row('2026-11-16', 'claude-opus-4-6', { provider: 'claude', cost: 2.5, input: 50, cached: 0, cacheWrite: 0, output: 10 })],
      3,
      today,
    );
    expect(det[2].cost).toBe(3.5);
    expect(det[2].kinds.total).toBe(260);
    expect(det[2].byProvider.map((p) => [p.provider, p.cost, p.tokens])).toEqual([
      ['claude', 2.5, 60],
      ['codex', 1, 200],
    ]);
  });

  it('ranks by tokens and marks the model without a price', () => {
    const r = rankTokens(rows, 'model', 30, today);
    expect(r.map((x) => [x.name, x.tokens, x.cost, x.unpriced])).toEqual([
      ['new-model', 1100, 0, true],
      ['known', 200, 1, false],
    ]);
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
              {
                day,
                provider: 'claude',
                model: 'mystery-1',
                project: 'alpha',
                machine: 'local',
                input: 4000,
                cached: 0,
                cacheWrite: 0,
                output: 1000,
                reasoning: 300,
                requests: 3,
                cost: 0,
                priced: false,
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
    storage.remove(COLLAPSED_ACCOUNTS_KEY);
    setView({ tab: 'overview', remaining: false, costDays: 30, metric: 'spend' });
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
    // usage.statusBar off: not shown.
    await act(async () => useSettings.setState({ values: { 'usage.statusBar': { value: false, source: 'global' } } }));
    expect(host.querySelector('.usage-status-item')).toBeNull();
  });

  it('shows a tile per service and the accounts, tightest first; a service its cards', async () => {
    useUsage.setState({
      snapshot: snapshot([
        account('codex:a', [20], { plan: 'Plus', email: 'c@example.com' }),
        account('claude:b', [90, 50], { status: 'stale', code: 'token_expired', machines: ['local', 'box'] }),
      ]),
    });
    await act(async () => root.render(createElement(UsagePanel)));
    expect(calls).toContain('GET /api/p/usage?watch=1');
    // The overview, Claude and Codex (in the services' order), and Claude
    // from its spend.
    const tiles = [...host.querySelectorAll<HTMLButtonElement>('.usage-tile')];
    expect(tiles.map((b) => b.dataset.provider ?? 'overview')).toEqual(['overview', 'claude', 'codex']);
    expect(tiles[1].querySelector<HTMLElement>('.usage-tile-meter i')!.style.width).toBe('10%');
    const rows = [...host.querySelectorAll<HTMLElement>('.usage-row')];
    expect(rows.map((c) => c.dataset.account)).toEqual(['claude:b', 'codex:a']);
    expect(rows[0].classList.contains('level-warn')).toBe(true);
    expect(rows[1].textContent).toContain('Plus');
    // A row shows its service.
    await act(async () => rows[0].click());
    const card = host.querySelector<HTMLElement>('.usage-card[data-account="claude:b"]')!;
    expect(card.querySelectorAll('.usage-window')).toHaveLength(2);
    expect(card.querySelector('.usage-window-name')!.textContent).toContain('5 hours');
    expect(card.querySelector('.usage-window')!.classList.contains('level-warn')).toBe(true);
    expect(card.querySelector('.usage-hint')!.textContent).toContain('Run Claude once');
    expect(card.querySelector('.usage-machines')!.textContent).toContain('local, box');
    // Remaining instead of used.
    const left = [...host.querySelectorAll<HTMLButtonElement>('.usage-meta [role=radio]')].find((b) => b.textContent === 'Remaining')!;
    await act(async () => left.click());
    expect(card.querySelector('.usage-pct')!.textContent).toBe('10% left');
    // Refresh asks the hub.
    await act(async () => host.querySelector<HTMLButtonElement>('.usage-refresh')!.click());
    expect(calls).toContain('POST /api/p/usage/refresh');
    // A wallet in another currency says which.
    await act(async () =>
      useUsage.setState({
        snapshot: snapshot([account('kimi:k', [10], { credits: { balance: 12.5, used: 3, limit: 50, enabled: true, unit: 'cny' } })]),
      }),
    );
    await act(async () => setView({ tab: 'kimi' }));
    expect(host.querySelector('.usage-money')!.textContent).toBe('Credits: 12.50 CNY · Extra usage: 3.00 CNY of 50.00 CNY');
  });

  it('shows OpenCode from its spend alone: a tile after the others, a page without accounts', async () => {
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const row = (provider: string, model: string, cost: number): CostRow => ({
      day,
      provider,
      model,
      machine: 'local',
      input: 100,
      cached: 1000,
      cacheWrite: 10,
      output: 25,
      reasoning: 5,
      requests: 1,
      cost,
      priced: cost > 0,
    });
    useUsage.setState({
      snapshot: snapshot([account('claude:b', [30])]),
      cost: {
        generatedAt: Math.floor(Date.now() / 1000),
        days: 90,
        weekHours: 168,
        monthHours: 750,
        machines: { local: { files: 2, unpriced: ['opencode/glm-5'], failed: ['opencode:too_large'] } },
        rows: [row('opencode', 'deepseek-v4-flash', 0.25), row('opencode', 'glm-5', 0), row('claude', 'claude-opus-4-6', 1)],
      },
    });
    await act(async () => root.render(createElement(UsagePanel)));
    const tiles = [...host.querySelectorAll<HTMLButtonElement>('.usage-tile')];
    expect(tiles.map((b) => b.dataset.provider ?? 'overview')).toEqual(['overview', 'claude', 'opencode']);
    // A log the machine could not read says so, with why.
    const errors = [...host.querySelectorAll('.callout.error')].map((e) => e.textContent);
    expect(errors).toEqual(['local: could not read OpenCode (too_large); its spend is as last read.']);
    const tile = tiles[2];
    expect(tile.textContent).toBe('OpenCode');
    expect(tile.style.getPropertyValue('--brand')).toBe('var(--usage-opencode)');
    expect(tile.querySelector('.ai-logo svg')).not.toBeNull();
    expect(tile.querySelector('.usage-tile-meter i')).toBeNull();
    await act(async () => tile.click());
    expect(host.querySelector('.usage-card[data-account]')).toBeNull();
    const spend = host.querySelector<HTMLElement>('.usage-spend')!;
    expect(spend.textContent).toContain('$0.25');
    expect(spend.textContent).toContain('deepseek-v4-flash');
  });

  it('does not keep the hub asking from a hidden page', async () => {
    vi.useFakeTimers();
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      await act(async () => root.render(createElement(UsagePanel)));
      await act(async () => {
        vi.advanceTimersByTime(5 * 60_000);
      });
      expect(calls.filter((c) => c.includes('watch=1'))).toEqual([]);
      vis.mockReturnValue('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(calls.filter((c) => c.includes('watch=1'))).toHaveLength(1);
    } finally {
      vis.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reads the spend again while the panel stays open, once older than usage.costRefresh', async () => {
    vi.useFakeTimers();
    try {
      useSettings.setState({ values: { 'usage.costRefresh': { value: 2, source: 'global' } } });
      await act(async () => root.render(createElement(UsagePanel)));
      const costs = () => calls.filter((c) => c.startsWith('GET /api/p/usage/cost')).length;
      expect(costs()).toBe(1);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(costs()).toBe(1);
      await act(async () => {
        vi.advanceTimersByTime(2 * 60_000);
      });
      expect(costs()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists the machines that could not read an account another machine read, and sets the interval', async () => {
    const a = account('kimi:u1', [20], {
      machines: ['local', 'box'],
      issues: [{ machine: 'box', status: 'stale', code: 'token_expired' }],
    });
    applySnapshot({ ...snapshot([a]), updatedAt: now + 2 });
    setView({ tab: 'kimi' });
    await act(async () => root.render(createElement(UsagePanel)));
    expect(host.querySelector('.usage-issues')?.textContent).toContain('box');
    const select = host.querySelector<HTMLSelectElement>('.usage-interval')!;
    await act(async () => {
      select.value = '30';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(calls).toContain('PUT /api/settings');
    useUsage.setState({ snapshot: undefined });
  });

  it('opens DeepSeek’s key form without a DeepSeek account', async () => {
    applySnapshot({ ...snapshot([account('claude:a', [10])]), updatedAt: now + 1 });
    await act(async () => root.render(createElement(UsagePanel)));
    const add = host.querySelector<HTMLButtonElement>('.usage-add-key');
    expect(add).not.toBeNull();
    await act(async () => add!.click());
    expect(useUsage.getState().tab).toBe('deepseek');
    expect(host.querySelector('.usage-provider')).not.toBeNull();
    // Turned off: neither.
    useSettings.setState({ values: { 'usage.providers.deepseek': { value: false } } as never });
    await act(async () => root.render(createElement(UsagePanel)));
    expect(host.querySelector('.usage-provider')).toBeNull();
  });

  it('groups windows by the models they count, the session first', () => {
    const g = groupWindows([
      { kind: 'weekly', label: 'Gemini', usedPct: 10 },
      { kind: 'session', label: 'Gemini', usedPct: 5 },
      { kind: 'weekly', usedPct: 1 },
      { kind: 'weekly', label: 'Claude and GPT', usedPct: 50 },
    ]);
    expect(g.map((x) => [x.label, x.windows.map((w) => w.kind)])).toEqual([
      [undefined, ['weekly']],
      ['Gemini', ['session', 'weekly']],
      ['Claude and GPT', ['weekly']],
    ]);
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
      useUsage.setState({ snapshot: snapshot([account('claude:b', [30], { machines: ['local', 'box'] }), account('deepseek:k', [])]) });
      setView({ tab: 'deepseek' });
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

  it("shows the spend: total, daily bars in the services' colors, ranking and machines that failed", async () => {
    await act(async () => root.render(createElement(UsagePanel)));
    await act(async () => {});
    expect(calls.some((c) => c.startsWith('GET /api/p/usage/cost?days=90&tz='))).toBe(true);
    expect(host.querySelector('.usage-big')!.textContent).toBe('~$12.50');
    expect(host.querySelectorAll('.usage-daily g')).toHaveLength(30);
    expect(host.querySelector('.usage-daily rect')!.getAttribute('fill')).toBe('var(--usage-claude)');
    expect(host.querySelector('.usage-models li')!.textContent).toContain('claude-opus-4-6');
    expect(host.querySelector('.usage-spend .callout.error')!.textContent).toContain('offline');
    // A service's own spend.
    await act(async () => host.querySelector<HTMLButtonElement>('.usage-tile[data-provider="claude"]')!.click());
    expect([...host.querySelectorAll('.usage-stat-value')].map((e) => e.textContent)).toEqual(['$12.50', '$12.50', '5.0k', '5.0k']);
  });

  it('switches to tokens: kinds, the model without a price, kept per browser', async () => {
    await act(async () => root.render(createElement(UsagePanel)));
    await act(async () => {});
    const sw = () => [...host.querySelectorAll<HTMLButtonElement>('.usage-spend [aria-pressed]')];
    expect(sw().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    await act(async () => sw()[1].click());
    expect(host.querySelector('.usage-big')!.textContent).toBe('~5.0k');
    const legend = host.querySelector('.usage-kind-legend')!.textContent!;
    expect(legend).toContain('input 4.0k');
    expect(legend).toContain('output 1.0k (reasoning 300)');
    // No native SVG <title> tooltips (avoids hover delay); hovering shows the custom tooltip at once.
    expect(host.querySelectorAll('.usage-daily title')).toHaveLength(0);
    const bars = host.querySelectorAll('.usage-daily g');
    await act(async () => {
      bars[bars.length - 1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const tip = host.querySelector('.usage-daily-tooltip')!;
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain('5.0k');
    expect(tip.textContent).toContain('input');
    expect(tip.textContent).toContain('4.0k');
    expect(tip.textContent).toContain('reasoning 300');
    await act(async () => {
      host.querySelector('.usage-daily-box')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(host.querySelector('.usage-daily-tooltip')).toBeNull();
    // Every model by tokens, with its kinds.
    const first = host.querySelector('.usage-models li')!;
    expect(first.textContent).toContain('mystery-1');
    expect(first.querySelector('.usage-model-kinds')!.textContent).toContain('requests');
    expect(first.textContent).toContain('no price');
    expect(host.querySelectorAll('.usage-noprice')).toHaveLength(1);
    expect(useUsage.getState().metric).toBe('tokens');
    expect(JSON.parse(storage.get('usage.view') ?? '{}').metric).toBe('tokens');
    // A service shows its tokens by kind.
    await act(async () => host.querySelector<HTMLButtonElement>('.usage-tile[data-provider="claude"]')!.click());
    expect(host.querySelector('.usage-kind-legend')).not.toBeNull();
    await act(async () => host.querySelectorAll<HTMLButtonElement>('.usage-spend [aria-pressed]')[0].click());
    expect(useUsage.getState().metric).toBe('spend');
  });

  it('sends If-None-Match and handles 304 Not Modified for snapshot and cost', async () => {
    const snapHeaders: Array<string | null> = [];
    const costHeaders: Array<string | null> = [];
    const oldGen = Math.floor(Date.now() / 1000) - 3600;
    const day = new Date().toISOString().slice(0, 10);
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      if (String(url).startsWith('/api/p/usage/cost')) {
        costHeaders.push(h.get('If-None-Match'));
        if (h.get('If-None-Match') === '"cost-1"') {
          return new Response(null, { status: 304, headers: { ETag: '"cost-1"' } });
        }
        return new Response(
          JSON.stringify({
            generatedAt: oldGen,
            days: 90,
            tzOffset: 0,
            since: 0,
            weekHours: 168,
            monthHours: 750,
            machines: { local: { files: 1 } },
            rows: [
              {
                day,
                provider: 'claude',
                model: 'claude-opus-4-6',
                project: 'alpha',
                machine: 'local',
                input: 10,
                cached: 0,
                cacheWrite: 0,
                output: 5,
                requests: 1,
                cost: 1.25,
                priced: true,
              },
            ],
          }),
          { headers: { ETag: '"cost-1"' } },
        );
      }
      if (String(url).startsWith('/api/p/usage')) {
        snapHeaders.push(h.get('If-None-Match'));
        if (h.get('If-None-Match') === '"snap-1"') {
          return new Response(null, { status: 304, headers: { ETag: '"snap-1"' } });
        }
        return new Response(JSON.stringify(snapshot([account('claude:b', [40])])), {
          headers: { ETag: '"snap-1"' },
        });
      }
      return new Response('{}', { status: 404 });
    });

    await fetchSnapshot(true);
    expect(useUsage.getState().snapshot?.accounts).toHaveLength(1);
    await fetchSnapshot(true);
    expect(snapHeaders).toEqual([null, '"snap-1"']);
    expect(useUsage.getState().snapshot?.accounts).toHaveLength(1);

    await fetchCost();
    expect(useUsage.getState().cost?.rows).toHaveLength(1);
    expect(costStale()).toBe(true);
    await fetchCost();
    expect(costHeaders).toEqual([null, '"cost-1"']);
    expect(useUsage.getState().costLoading).toBe(false);
    expect(useUsage.getState().cost?.rows).toHaveLength(1);
    expect(costStale()).toBe(false);
  });

  it('shows immediate custom daily tooltip with breakdown on bar hover and pointer move', async () => {
    await act(async () => root.render(createElement(UsagePanel)));
    await act(async () => {});
    const svg = host.querySelector<SVGSVGElement>('.usage-daily')!;
    const box = host.querySelector<HTMLElement>('.usage-daily-box')!;
    const bars = host.querySelectorAll('.usage-daily g');
    const lastDay = bars[bars.length - 1].getAttribute('data-day')!;
    const firstDay = bars[0].getAttribute('data-day')!;

    // Hovering the today bar immediately displays date, cost, tokens, requests and provider/kind breakdown.
    await act(async () => {
      bars[bars.length - 1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const tip = host.querySelector('.usage-daily-tooltip')!;
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.textContent).toContain(lastDay);
    expect(tip.textContent).toContain('$12.50');
    expect(tip.textContent).toContain('5.0k tokens');
    expect(tip.textContent).toContain('4 requests');
    expect(tip.textContent).toContain('Claude');

    // Moving the pointer over an empty day column immediately shows that date without lag.
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 300,
      bottom: 72,
      width: 300,
      height: 72,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    await act(async () => {
      svg.dispatchEvent(new MouseEvent('mousemove', { clientX: 2, bubbles: true }));
    });
    expect(host.querySelector('.usage-daily-tooltip')!.textContent).toContain(firstDay);
    expect(host.querySelector('.usage-daily-tooltip')!.textContent).toContain('No usage');

    await act(async () => {
      box.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(host.querySelector('.usage-daily-tooltip')).toBeNull();
  });

  it('includes disabled machines in usage statistics, machine rankings and accounts', async () => {
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    useStore
      .getState()
      .setMachines([
        { id: 'local', label: 'This Mac', kind: 'local', enabled: true, status: 'ready', updated_at: now } as MachineState,
        { id: 'gpu', label: 'Disabled GPU', kind: 'ssh', enabled: false, status: 'disabled', updated_at: now } as MachineState,
      ]);
    useUsage.setState({
      snapshot: snapshot([account('claude:b', [40], { machines: ['local', 'gpu'] })]),
      cost: {
        generatedAt: now,
        days: 90,
        weekHours: 168,
        monthHours: 750,
        machines: { local: { files: 1 }, gpu: { files: 2 } },
        rows: [
          {
            day,
            provider: 'claude',
            model: 'claude-opus-4-6',
            machine: 'local',
            input: 100,
            cached: 0,
            cacheWrite: 0,
            output: 50,
            requests: 1,
            cost: 2.0,
            priced: true,
          },
          {
            day,
            provider: 'claude',
            model: 'claude-opus-4-6',
            machine: 'gpu',
            input: 200,
            cached: 0,
            cacheWrite: 0,
            output: 100,
            requests: 2,
            cost: 5.5,
            priced: true,
          },
        ],
      },
    });
    await act(async () => root.render(createElement(UsagePanel)));
    expect(host.querySelector('.usage-big')!.textContent).toBe('~$7.50');
    const byMachine = [...host.querySelectorAll('.usage-spend [role="radio"]')].find((b) => b.textContent === 'Machines')!;
    await act(async () => (byMachine as HTMLButtonElement).click());
    const ranks = [...host.querySelectorAll('.usage-rank li')].map((li) => li.textContent);
    expect(ranks[0]).toContain('Disabled GPU');
    expect(ranks[0]).toContain('$5.50');
    expect(ranks[1]).toContain('This Mac');
    expect(ranks[1]).toContain('$2.00');
    // Account card still lists the disabled machine label.
    await act(async () => host.querySelector<HTMLButtonElement>('.usage-tile[data-provider="claude"]')!.click());
    expect(host.querySelector('.usage-machines')!.textContent).toContain('Disabled GPU');
    useStore.getState().setMachines([]);
  });

  it('shows a subtle note instead of error alerts for actively disabled hosts while keeping alerts for enabled ones', async () => {
    useStore
      .getState()
      .setMachines([
        { id: 'local', label: 'This Mac', kind: 'local', enabled: true, status: 'ready', updated_at: now } as MachineState,
        { id: 'gpu', label: 'Disabled GPU', kind: 'ssh', enabled: false, status: 'disabled', updated_at: now } as MachineState,
      ]);
    useUsage.setState({
      snapshot: {
        ...snapshot([
          account('claude:b', [40], {
            machines: ['local', 'gpu'],
            issues: [{ machine: 'gpu', status: 'error', code: 'offline' }],
          }),
        ]),
        machines: {
          local: { status: 'ok', at: now },
          gpu: { status: 'disabled', at: now },
        },
      },
      cost: {
        generatedAt: now,
        days: 30,
        weekHours: 168,
        monthHours: 750,
        machines: { local: { files: 1 }, gpu: { files: 2, error: 'offline', failed: ['claude:read'], disabled: true } },
        rows: [],
      },
    });
    await act(async () => root.render(createElement(UsagePanel)));
    expect(host.querySelector('.callout.error')).toBeNull();
    expect(host.querySelector('.usage-disabled-note')?.textContent).toContain('Disabled GPU');
    await act(async () => host.querySelector<HTMLButtonElement>('.usage-tile[data-provider="claude"]')!.click());
    expect(host.querySelector('.usage-issues')).toBeNull();
    // An enabled host that fails still surfaces the error callout.
    useStore
      .getState()
      .setMachines([
        { id: 'local', label: 'This Mac', kind: 'local', enabled: true, status: 'ready', updated_at: now } as MachineState,
        { id: 'gpu', label: 'Active GPU', kind: 'ssh', enabled: true, status: 'error', updated_at: now } as MachineState,
      ]);
    useUsage.setState((s) => ({
      ...s,
      cost: { ...s.cost!, machines: { local: { files: 1 }, gpu: { files: 2, error: 'offline' } } },
    }));
    await act(async () => setView({ tab: 'overview' }));
    expect(host.querySelector('.callout.error')?.textContent).toContain('Active GPU');
    useStore.getState().setMachines([]);
  });

  it('supports customizable status bar window display and default provider', async () => {
    const claudeAcc = account('claude:a', [30, 65], {
      windows: [
        { kind: 'session', usedPct: 30, resetsAt: now + 3600, windowSec: 18000 },
        { kind: 'weekly', usedPct: 65, resetsAt: now + 86400, windowSec: 604800 },
      ],
    });
    const codexAcc = account('codex:b', [15, 45], {
      windows: [
        { kind: 'session', usedPct: 15, resetsAt: now + 3600, windowSec: 18000 },
        { kind: 'weekly', usedPct: 45, resetsAt: now + 86400, windowSec: 604800 },
      ],
    });
    const s = snapshot([claudeAcc, codexAcc]);
    useUsage.setState({ snapshot: s, remaining: false });
    // Pure model checks for all window modes and default provider selection.
    const selAuto = statusBarSelection(s, { defaultProvider: 'auto', windowMode: 'auto', now })!;
    expect([selAuto.account.key, selAuto.primary.usedPct, selAuto.showLogo]).toEqual(['claude:a', 65, false]);
    const sel5h = statusBarSelection(s, { defaultProvider: 'codex', windowMode: '5h', now })!;
    expect([sel5h.account.key, sel5h.primary.usedPct, sel5h.showLogo]).toEqual(['codex:b', 15, true]);
    expect(formatStatusBarLabel(sel5h.primary, sel5h.secondary, '5h', false)).toBe('5h · 15% used');
    const sel7d = statusBarSelection(s, { defaultProvider: 'codex', windowMode: '7d', now })!;
    expect(formatStatusBarLabel(sel7d.primary, sel7d.secondary, '7d', true)).toBe('7d · 55% left');
    const selBoth = statusBarSelection(s, { defaultProvider: 'codex', windowMode: 'both', now })!;
    expect(formatStatusBarLabel(selBoth.primary, selBoth.secondary, 'both', false)).toBe('5h 15% · 7d 45%');
    expect(formatStatusBarLabel(selBoth.primary, selBoth.secondary, 'both', true)).toBe('5h 85% · 7d 55% left');
    // Fallback when default provider has no active windows.
    const selFallback = statusBarSelection(s, { defaultProvider: 'grok', windowMode: 'auto', now })!;
    expect([selFallback.account.key, selFallback.showLogo]).toEqual(['claude:a', false]);
    // Active focused agent overrides defaultProvider.
    const selAgent = statusBarSelection(s, {
      agent: { provider: 'claude', m: 'local' },
      defaultProvider: 'codex',
      windowMode: 'both',
      now,
    })!;
    expect([selAgent.account.key, selAgent.primary.usedPct, selAgent.secondary?.usedPct]).toEqual(['claude:a', 30, 65]);
    // Rendered StatusItem reflects settings.
    useSettings.setState({
      values: {
        'usage.statusBar': { value: true, source: 'global' },
        'usage.statusBarWindow': { value: 'both', source: 'global' },
        'usage.statusBarProvider': { value: 'codex', source: 'global' },
      } as never,
    });
    await act(async () => root.render(createElement(UsageStatusItem)));
    const btn = host.querySelector<HTMLButtonElement>('.usage-status-item')!;
    expect(btn.textContent?.trim()).toBe('5h 15% · 7d 45%');
    expect(btn.querySelector('.ai-logo')).not.toBeNull();
  });

  it('merges multi-account providers using quota tier weights, cycle-consistent bucketing, and empirical cycle API value', () => {
    // True quota tier multipliers (baseline paid plan = 1; Claude Max 20x is 20x Pro, not 10x).
    expect(estimatePlanWeight('claude', 'Pro')).toBe(1);
    expect(estimatePlanWeight('claude', 'Max 5x')).toBe(5);
    expect(estimatePlanWeight('claude', 'Max 20x')).toBe(20);
    expect(estimatePlanWeight('codex', 'Plus')).toBe(1);
    expect(estimatePlanWeight('codex', 'Pro')).toBe(10);
    expect(estimatePlanWeight('antigravity', 'Free')).toBe(0.2);
    expect(estimatePlanWeight('antigravity', 'Google AI Pro')).toBe(1);
    expect(estimatePlanWeight('antigravity', 'Google One AI Ultra')).toBe(12.5);
    expect(estimatePlanWeight('grok', 'SuperGrok')).toBe(1);
    expect(estimatePlanWeight('grok', 'SuperGrok Heavy')).toBe(10);
    expect(estimatePlanWeight('claude', 'UnknownTier')).toBeUndefined();
    expect(estimatePlanUsd('claude', 'Max 20x')).toBe(200);

    // Without CostReport: tier-weighted over comparable cycles (never mixes 5h with 7d,
    // never displays monthly subscription fees as current-cycle API capacity).
    // Claude Pro (1x: 5h=80%, 7d=50%) + Max 20x (20x: 5h=10%, 7d=20%)
    // 5h merged = (1*80 + 20*10) / 21 = 13.33%; 7d merged = (1*50 + 20*20) / 21 = 21.43%.
    // Tightest shared cycle is 7d (21.43% used / 78.57% left).
    const cPro = account('claude:pro', [], {
      plan: 'Pro',
      email: 'pro@example.com',
      machines: ['m1'],
      windows: [
        { kind: 'session', usedPct: 80, resetsAt: now + 3600, windowSec: 18000 },
        { kind: 'weekly', usedPct: 50, resetsAt: now + 86400, windowSec: 604800 },
      ],
    });
    const cMax = account('claude:max', [], {
      plan: 'Max 20x',
      email: 'max@example.com',
      machines: ['m2'],
      windows: [
        { kind: 'session', usedPct: 10, resetsAt: now + 3600, windowSec: 18000 },
        { kind: 'weekly', usedPct: 20, resetsAt: now + 2 * 86400, windowSec: 604800 },
      ],
    });
    const mergedClaudeTier = mergeProviderAccounts([cPro, cMax], 'claude', now)!;
    expect(isMergedAccount(mergedClaudeTier)).toBe(true);
    expect(mergedClaudeTier.key).toBe('claude:merged');
    expect(mergedClaudeTier.accountCount).toBe(2);
    expect(mergedClaudeTier.summary.weighting).toBe('tier');
    expect(mergedClaudeTier.summary.window?.kind).toBe('weekly');
    expect(mergedClaudeTier.summary.capacityUsd).toBeUndefined();
    expect(mergedClaudeTier.summary.usedUsd).toBeUndefined();
    expect(mergedClaudeTier.summary.usedPct).toBeCloseTo(21.43, 1);
    expect(mergedClaudeTier.summary.remainingPct).toBeCloseTo(78.57, 1);
    expect(mergedClaudeTier.summary.resetsAt).toBe(now + 86400);
    expect(mergedClaudeTier.windows.find((w) => w.kind === 'session')?.usedPct).toBeCloseTo(13.33, 1);
    expect(mergedClaudeTier.windows.find((w) => w.kind === 'weekly')?.usedPct).toBeCloseTo(21.43, 1);

    // With CostReport (disjoint machines): estimates real current-cycle equivalent API value!
    // m1 (Pro, 7d=50%) spent $50 -> $100 full 7d API capacity;
    // m2 (Max 20x, 7d=20%) spent $400 -> $2000 full 7d API capacity.
    // Combined 7d cycle: $450 used / $2100 total ($1650 left) = 21.43% used.
    const slot = (provider: string, machine: string, at: number, cost: number): CostSlot => ({
      at,
      provider,
      machine,
      tokens: 1000,
      requests: 1,
      cost,
      priced: true,
    });
    const costRep = (recent: CostSlot[], rows: CostRow[] = []): CostReport => ({
      generatedAt: now,
      days: 90,
      weekHours: 168,
      monthHours: 750,
      machines: {},
      rows,
      recentSince: now - 8 * 86400,
      recent,
    });
    const claudeCost = costRep([
      slot('claude', 'm1', now - 2 * 86400, 42),
      slot('claude', 'm1', now - 1800, 8),
      slot('claude', 'm2', now - 2 * 86400, 380),
      slot('claude', 'm2', now - 1800, 20),
    ]);
    const mergedClaudeApi = mergeProviderAccounts([cPro, cMax], 'claude', now, claudeCost)!;
    expect(mergedClaudeApi.summary).toMatchObject({
      weighting: 'api',
      usedUsd: 450,
      capacityUsd: 2100,
      availableUsd: 1650,
      priced: true,
    });
    expect(mergedClaudeApi.summary.usedPct).toBeCloseTo(21.43, 1);
    expect(mergedClaudeApi.summary.remainingPct).toBeCloseTo(78.57, 1);

    // Disjoint machines where one large-tier sibling is unused (0% used, $0 logs):
    // Pro (1x, 60% used, $60 spent -> $100/unit) calibrates Max 20x (20x, 0% used -> $2000 full, $0 used).
    const cPro60 = account('claude:p60', [], {
      plan: 'Pro',
      machines: ['m1'],
      windows: [{ kind: 'weekly', usedPct: 60, resetsAt: now + 86400, windowSec: 604800 }],
    });
    const cMax0 = account('claude:m0', [], {
      plan: 'Max 20x',
      machines: ['m2'],
      windows: [{ kind: 'weekly', usedPct: 0, resetsAt: now + 86400, windowSec: 604800 }],
    });
    const mergedCalibrated = mergeProviderAccounts([cPro60, cMax0], 'claude', now, costRep([slot('claude', 'm1', now - 3600, 60)]))!;
    expect(mergedCalibrated.summary).toMatchObject({ weighting: 'api', usedUsd: 60, capacityUsd: 2100, availableUsd: 2040 });
    expect(mergedCalibrated.summary.usedPct).toBeCloseTo(2.86, 1);

    // Same shared machine: logs are deduplicated (never double-counted), weighted by tier ratio!
    const sharedPro = account('claude:sp', [], {
      plan: 'Pro',
      machines: ['local'],
      windows: [{ kind: 'weekly', usedPct: 80, resetsAt: now + 86400, windowSec: 604800 }],
    });
    const sharedMax = account('claude:sm', [], {
      plan: 'Max 20x',
      machines: ['local'],
      windows: [{ kind: 'weekly', usedPct: 20, resetsAt: now + 2 * 86400, windowSec: 604800 }],
    });
    const mergedShared = mergeProviderAccounts([sharedPro, sharedMax], 'claude', now, costRep([slot('claude', 'local', now - 3600, 480)]))!;
    // Weighted used = 1*0.8 + 20*0.2 = 4.8 out of 21 units = 22.86%; $480 / (4.8/21) = $2100.
    expect(mergedShared.summary).toMatchObject({ weighting: 'api', usedUsd: 480, capacityUsd: 2100, availableUsd: 1620 });
    expect(mergedShared.summary.usedPct).toBeCloseTo(22.86, 1);

    // Same shared machine with unused large-tier sibling (0%): activeFraction = 60% >= 5% still calibrates cleanly!
    const sharedPro60 = account('claude:sp60', [], {
      plan: 'Pro',
      machines: ['local'],
      windows: [{ kind: 'weekly', usedPct: 60, resetsAt: now + 86400, windowSec: 604800 }],
    });
    const sharedMax0 = account('claude:sm0', [], {
      plan: 'Max 20x',
      machines: ['local'],
      windows: [{ kind: 'weekly', usedPct: 0, resetsAt: now + 86400, windowSec: 604800 }],
    });
    const mergedSharedZero = mergeProviderAccounts(
      [sharedPro60, sharedMax0],
      'claude',
      now,
      costRep([slot('claude', 'local', now - 3600, 60)]),
    )!;
    expect(mergedSharedZero.summary).toMatchObject({ weighting: 'api', usedUsd: 60, capacityUsd: 2100, availableUsd: 2040 });
    expect(mergedSharedZero.summary.usedPct).toBeCloseTo(2.86, 1);

    // Incomplete local logs guard (known tiers on disjoint hosts): Max 20x used 40% mostly off-host
    // ($2 local logs vs Pro's $100/unit) is calibrated from Pro instead of collapsing its tier weight.
    const cMaxOffHost = account('claude:moff', [], {
      plan: 'Max 20x',
      machines: ['m2'],
      windows: [{ kind: 'weekly', usedPct: 40, resetsAt: now + 86400, windowSec: 604800 }],
    });
    const mergedOffHost = mergeProviderAccounts(
      [cPro60, cMaxOffHost],
      'claude',
      now,
      costRep([slot('claude', 'm1', now - 3600, 60), slot('claude', 'm2', now - 3600, 2)]),
    )!;
    // Pro: $60/$100; Max 20x calibrated at $100/unit -> $800/$2000 -> total $860/$2100 (40.95%).
    expect(mergedOffHost.summary).toMatchObject({ weighting: 'api', usedUsd: 860, capacityUsd: 2100, availableUsd: 1240 });
    expect(mergedOffHost.summary.usedPct).toBeCloseTo(40.95, 1);

    // Unknown plan tiers on disjoint hosts with observed logs: empirical API capacity
    // automatically discovers the real 1:12 tier ratio without a plan field!
    const unkSmall = account('kimi:u1', [], {
      machines: ['m1'],
      windows: [{ kind: 'weekly', usedPct: 80, resetsAt: now + 86400, windowSec: 604800 }],
    });
    const unkLarge = account('kimi:u2', [], {
      machines: ['m2'],
      windows: [{ kind: 'weekly', usedPct: 10, resetsAt: now + 86400, windowSec: 604800 }],
    });
    const mergedUnkApi = mergeProviderAccounts(
      [unkSmall, unkLarge],
      'kimi',
      now,
      costRep([slot('kimi', 'm1', now - 3600, 40), slot('kimi', 'm2', now - 3600, 60)]),
    )!;
    // u1: $40 / 0.8 = $50; u2: $60 / 0.1 = $600 -> combined $100 / $650 = 15.38% used!
    expect(mergedUnkApi.summary).toMatchObject({ weighting: 'api', usedUsd: 100, capacityUsd: 650, availableUsd: 550 });
    expect(mergedUnkApi.summary.usedPct).toBeCloseTo(15.38, 1);

    // Early in cycle (<5% used): reports observed spend so far without noisy capacity extrapolation.
    const early1 = account('codex:e1', [], {
      plan: 'Plus',
      machines: ['m1'],
      windows: [{ kind: 'weekly', usedPct: 2, resetsAt: now + 6 * 86400, windowSec: 604800 }],
    });
    const early2 = account('codex:e2', [], {
      plan: 'Pro',
      machines: ['m2'],
      windows: [{ kind: 'weekly', usedPct: 1, resetsAt: now + 6 * 86400, windowSec: 604800 }],
    });
    const mergedEarly = mergeProviderAccounts(
      [early1, early2],
      'codex',
      now,
      costRep([slot('codex', 'm1', now - 3600, 3), slot('codex', 'm2', now - 3600, 15)]),
    )!;
    expect(mergedEarly.summary.weighting).toBe('tier');
    expect(mergedEarly.summary.usedUsd).toBe(18);
    expect(mergedEarly.summary.capacityUsd).toBeUndefined();
    expect(mergedEarly.summary.usedPct).toBeCloseTo(1.09, 1);

    // Long >8d cycle (e.g. Kimi 30-day monthly window) falls back to daily CostReport.rows when recent does not reach back.
    const todayStr = dayOf(new Date(now * 1000));
    const kimiMon1 = account('kimi:m1', [], {
      plan: 'Moderato',
      machines: ['m1'],
      windows: [{ kind: 'monthly', usedPct: 50, resetsAt: now + 15 * 86400, windowSec: 30 * 86400 }],
    });
    const kimiMon2 = account('kimi:m2', [], {
      plan: 'Vivace',
      machines: ['m2'],
      windows: [{ kind: 'monthly', usedPct: 10, resetsAt: now + 15 * 86400, windowSec: 30 * 86400 }],
    });
    const monRow = (machine: string, cost: number): CostRow => ({
      day: todayStr,
      provider: 'kimi',
      model: 'kimi-k2',
      machine,
      input: 100,
      cached: 0,
      cacheWrite: 0,
      output: 50,
      requests: 1,
      cost,
      priced: true,
    });
    const mergedKimiMonthly = mergeProviderAccounts([kimiMon1, kimiMon2], 'kimi', now, costRep([], [monRow('m1', 50), monRow('m2', 100)]))!;
    // m1: $50 / 0.5 = $100; m2: $100 / 0.1 = $1000 -> combined $150 / $1100 = 13.64%.
    expect(mergedKimiMonthly.summary).toMatchObject({ weighting: 'api', usedUsd: 150, capacityUsd: 1100, availableUsd: 950 });
    expect(mergedKimiMonthly.summary.usedPct).toBeCloseTo(13.64, 1);

    // Codex Plus (1x, 100% used) + Pro (10x, 20% used) without cost report -> 27.27% used (tier weighting).
    const xPlus = account('codex:plus', [100], { plan: 'Plus', email: 'plus@example.com' });
    const xPro = account('codex:pro', [20], { plan: 'Pro', email: 'pro@example.com' });
    const mergedCodex = mergeProviderAccounts([xPlus, xPro], 'codex', now)!;
    expect(mergedCodex.summary.weighting).toBe('tier');
    expect(mergedCodex.summary.capacityUsd).toBeUndefined();
    expect(mergedCodex.summary.usedPct).toBeCloseTo(27.27, 1);
    expect(mergedCodex.summary.remainingPct).toBeCloseTo(72.73, 1);

    // Antigravity Free (0.2x, 100% used) + Pro (1x, 50% used) + Ultra (12.5x, 10% used)
    // Weighted = (0.2*100 + 1*50 + 12.5*10) / 13.7 = 195 / 13.7 = 14.23% used.
    const agFree = account('antigravity:f', [100], { plan: 'Free' });
    const agPro = account('antigravity:p', [50], { plan: 'Pro' });
    const agUltra = account('antigravity:u', [10], { plan: 'Ultra' });
    const mergedAg = mergeProviderAccounts([agFree, agPro, agUltra], 'antigravity', now)!;
    expect(mergedAg.summary.weighting).toBe('tier');
    expect(mergedAg.summary.usedPct).toBeCloseTo(14.23, 1);

    // Grok SuperGrok (1x, 90% used) + SuperGrok Heavy (10x, 10% used) -> 190 / 11 = 17.27% used.
    const g1 = account('grok:1', [90], { plan: 'SuperGrok' });
    const g2 = account('grok:2', [10], { plan: 'SuperGrok Heavy' });
    const mergedGrok = mergeProviderAccounts([g1, g2], 'grok', now)!;
    expect(mergedGrok.summary.weighting).toBe('tier');
    expect(mergedGrok.summary.usedPct).toBeCloseTo(17.27, 1);

    // Explicit dollar balances / limits without subscription windows.
    const cr1 = account('claude:cr1', [], { credits: { unit: 'usd', balance: 80, limit: 100, enabled: true } });
    const cr2 = account('claude:cr2', [], { credits: { unit: 'usd', used: 15, limit: 20, enabled: true } });
    const mergedCredits = mergeProviderAccounts([cr1, cr2], 'claude', now)!;
    expect(mergedCredits.summary).toMatchObject({ weighting: 'explicit', capacityUsd: 120, availableUsd: 85, usedUsd: 35 });
    expect(mergedCredits.summary.usedPct).toBeCloseTo(29.17, 1);

    // Hybrid: subscription + enabled USD extra usage with observed API logs (deducts extra-usage
    // overlap at 100% so extra usage logged locally is never double-counted; synthetic Extra window excluded).
    const hybrid = account('claude:hyb', [], {
      plan: 'Pro',
      machines: ['m1'],
      windows: [
        { kind: 'weekly', usedPct: 100, resetsAt: now + 86400, windowSec: 604800 },
        { kind: 'monthly', label: 'Extra', usedPct: 50 },
      ],
      credits: { unit: 'usd', enabled: true, limit: 30, used: 15 },
    });
    const max5 = account('claude:m5', [], {
      plan: 'Max 5x',
      machines: ['m2'],
      windows: [{ kind: 'weekly', usedPct: 20, resetsAt: now + 86400, windowSec: 604800 }],
      credits: { unit: 'usd', enabled: false, limit: 100, used: 0 },
    });
    const hybridCost = costRep([slot('claude', 'm1', now - 3600, 115), slot('claude', 'm2', now - 3600, 100)]);
    // hybrid on m1: $115 logs - $15 extra overlap = $100 sub cap + $30 extra cap = $130 ($115 used, $15 avail).
    // max5 on m2: $100 logs at 20% = $500 sub cap ($100 used, $400 avail). Disabled extra ignored.
    expect(estimateAccountValue(hybrid, now, { cost: hybridCost })).toMatchObject({
      capacityUsd: 130,
      availableUsd: 15,
      usedUsd: 115,
      basis: 'hybrid',
    });
    expect(estimateAccountValue(max5, now, { cost: hybridCost })).toMatchObject({
      capacityUsd: 500,
      availableUsd: 400,
      usedUsd: 100,
      basis: 'api',
    });
    const mergedHybrid = mergeProviderAccounts([hybrid, max5], 'claude', now, hybridCost)!;
    expect(mergedHybrid.summary).toMatchObject({ weighting: 'api', capacityUsd: 630, availableUsd: 415, usedUsd: 215 });
    expect(mergedHybrid.summary.usedPct).toBeCloseTo(34.13, 1);

    // Mixed known + unknown plan without cost: unknown sibling defaults to baseline tier (1x).
    const cMax7d = account('claude:m7', [], {
      plan: 'Max 20x',
      windows: [{ kind: 'weekly', usedPct: 20, resetsAt: now + 86400, windowSec: 604800 }],
    });
    const cUnknown = account('claude:unk', [], {
      windows: [{ kind: 'weekly', usedPct: 90, resetsAt: now + 86400, windowSec: 604800 }],
    });
    const mergedMixed = mergeProviderAccounts([cMax7d, cUnknown], 'claude', now)!;
    // (20*20 + 1*90) / 21 = 490 / 21 = 23.33%.
    expect(mergedMixed.summary.weighting).toBe('tier');
    expect(mergedMixed.summary.usedPct).toBeCloseTo(23.33, 1);

    // Prepaid balance mixed with explicit bounded credit account.
    const boundedAndPrepaid = account('claude:bp', [], {
      credits: { unit: 'usd', enabled: true, limit: 100, used: 40 },
      balances: [{ currency: 'USD', total: 20 }],
    });
    expect(estimateAccountValue(boundedAndPrepaid, now)).toMatchObject({ capacityUsd: 120, availableUsd: 80, usedUsd: 40 });
    const boundedOnly = account('claude:bo', [], {
      credits: { unit: 'usd', enabled: true, limit: 100, used: 40 },
    });
    const prepaidOnly = account('claude:po', [], {
      balances: [{ currency: 'USD', total: 20 }],
    });
    const mergedPrepaidMix = mergeProviderAccounts([boundedOnly, prepaidOnly], 'claude', now)!;
    expect(mergedPrepaidMix.summary).toMatchObject({ weighting: 'explicit', capacityUsd: 120, availableUsd: 80, usedUsd: 40 });
    expect(mergedPrepaidMix.summary.usedPct).toBeCloseTo(33.33, 1);

    // All plans unknown and no cost/credits: clean equal-weight fallback.
    const k1 = account('kimi:k1', [80]);
    const k2 = account('kimi:k2', [20]);
    const mergedKimi = mergeProviderAccounts([k1, k2], 'kimi', now)!;
    expect(mergedKimi.summary.usedPct).toBe(50);
    expect(mergedKimi.summary.remainingPct).toBe(50);
    expect(mergedKimi.summary.availableUsd).toBeUndefined();
    expect(mergedKimi.summary.capacityUsd).toBeUndefined();
    expect(mergedKimi.summary.usedUsd).toBeUndefined();
    expect(mergedKimi.summary.weighting).toBe('equal');
    expect(mergedKimi.summary.resetsAt).toBe(now + 3600);

    // Prepaid balance-only accounts (DeepSeek): sums available balance without inventing a %.
    const ds1 = account('deepseek:d1', [], { balances: [{ currency: 'USD', total: 10 }] });
    const ds2 = account('deepseek:d2', [], { balances: [{ currency: 'USD', total: 25 }] });
    const mergedDs = mergeProviderAccounts([ds1, ds2], 'deepseek', now)!;
    expect(mergedDs.summary.usedPct).toBeUndefined();
    expect(mergedDs.summary.capacityUsd).toBeUndefined();
    expect(mergedDs.summary.availableUsd).toBe(35);

    // previewAccounts merges every 2+ account provider and leaves singletons untouched.
    const singleGrok = account('grok:solo', [40]);
    const preview = previewAccounts([cPro, cMax, xPlus, xPro, k1, k2, singleGrok], now);
    expect(preview.map((a) => a.key)).toEqual(['kimi:merged', 'grok:solo', 'codex:merged', 'claude:merged']);
    expect(accountUsedPct(mergedClaudeTier, now)).toBeCloseTo(21.43, 1);

    // Status bar selection and tightestFor merge 2+ accounts consistently across 5h/7d/both/auto.
    const snapMulti = snapshot([cPro, cMax, xPlus, xPro]);
    const sbClaude = statusBarSelection(snapMulti, { defaultProvider: 'claude', windowMode: 'both', now })!;
    expect(sbClaude.account.key).toBe('claude:merged');
    expect(sbClaude.primary.usedPct).toBeCloseTo(13.33, 1);
    expect(sbClaude.secondary?.usedPct).toBeCloseTo(21.43, 1);
    const sbCodex = statusBarSelection(snapMulti, { agent: { provider: 'codex', m: 'local' }, windowMode: 'auto', now })!;
    expect(sbCodex.account.key).toBe('codex:merged');
    expect(sbCodex.primary.usedPct).toBeCloseTo(27.27, 1);
    const tf = tightestFor(snapMulti, 'claude', 'local', undefined, now)!;
    expect(tf.account.key).toBe('claude:merged');
    expect(tf.window.usedPct).toBeCloseTo(21.43, 1);
  });

  it('uses primary Gemini windows (not third-party Claude/GPT quotas) for Antigravity summaries while still showing all windows in cards', async () => {
    // 1. Antigravity agy CLI shape: Gemini Models vs exhausted Claude and GPT.
    const agCli = account('antigravity:cli1', [], {
      plan: 'Pro',
      email: 'cli@example.com',
      machines: ['m1'],
      windows: [
        { kind: 'session', label: 'Gemini Models', usedPct: 10, resetsAt: now + 3600, windowSec: 18000 },
        { kind: 'weekly', label: 'Gemini Models', usedPct: 25, resetsAt: now + 86400, windowSec: 604800 },
        { kind: 'session', label: 'Claude and GPT', usedPct: 100, resetsAt: now + 1800, windowSec: 18000 },
        { kind: 'weekly', label: 'Claude and GPT', usedPct: 100, resetsAt: now + 2 * 86400, windowSec: 604800 },
      ],
    });
    expect(primaryWindowsOf(agCli).map((w) => w.label)).toEqual(['Gemini Models', 'Gemini Models']);
    expect(tightestWindow(agCli, now)).toMatchObject({ kind: 'weekly', label: 'Gemini Models', usedPct: 25 });
    expect(accountUsedPct(agCli, now)).toBe(25);
    // Default / 5h / 7d / both status bar modes pick Gemini Models, never Claude and GPT.
    expect(pickAccountWindows(agCli, 'auto', undefined, now, false)?.primary).toMatchObject({ label: 'Gemini Models', usedPct: 25 });
    expect(pickAccountWindows(agCli, '5h', undefined, now, false)?.primary).toMatchObject({ label: 'Gemini Models', usedPct: 10 });
    expect(pickAccountWindows(agCli, '7d', undefined, now, false)?.primary).toMatchObject({ label: 'Gemini Models', usedPct: 25 });
    // Model-filtered focused pane: Gemini model -> Gemini Models; Claude model -> Claude and GPT; unknown -> Gemini Models.
    expect(pickAccountWindows(agCli, 'auto', 'gemini-3-pro', now, true)?.primary).toMatchObject({ label: 'Gemini Models', usedPct: 25 });
    expect(pickAccountWindows(agCli, 'auto', 'claude-sonnet-4-5', now, true)?.primary).toMatchObject({
      label: 'Claude and GPT',
      usedPct: 100,
    });
    expect(pickAccountWindows(agCli, 'auto', undefined, now, true)?.primary).toMatchObject({ label: 'Gemini Models', usedPct: 25 });

    // 2. Antigravity LS shape: per-model windows (Gemini 3 Pro/Flash vs Claude/GPT).
    const agLs = account('antigravity:ls1', [], {
      plan: 'Pro',
      email: 'ls@example.com',
      windows: [
        { kind: 'model', label: 'Gemini 3 Pro (High)', usedPct: 30, resetsAt: now + 3600 },
        { kind: 'model', label: 'Gemini 3 Flash', usedPct: 15, resetsAt: now + 3600 },
        { kind: 'model', label: 'Claude Sonnet 4.5', usedPct: 100, resetsAt: now + 7200 },
        { kind: 'model', label: 'GPT-OSS 120B (Medium)', usedPct: 100, resetsAt: now + 7200 },
      ],
    });
    expect(tightestWindow(agLs, now)).toMatchObject({ label: 'Gemini 3 Pro (High)', usedPct: 30 });
    expect(accountUsedPct(agLs, now)).toBe(30);
    expect(pickAccountWindows(agLs, 'auto', 'gemini-3-pro', now, true)?.primary).toMatchObject({
      label: 'Gemini 3 Pro (High)',
      usedPct: 30,
    });
    expect(pickAccountWindows(agLs, 'auto', 'claude-sonnet-4-5', now, true)?.primary).toMatchObject({
      label: 'Claude Sonnet 4.5',
      usedPct: 100,
    });

    // 3. Past-reset Gemini with active exhausted Claude/GPT must not leak Claude/GPT into summary.
    const agPastGemini = account('antigravity:past', [], {
      plan: 'Pro',
      windows: [
        { kind: 'weekly', label: 'Gemini Models', usedPct: 80, resetsAt: now - 60, windowSec: 604800 },
        { kind: 'weekly', label: 'Claude and GPT', usedPct: 100, resetsAt: now + 86400, windowSec: 604800 },
      ],
    });
    expect(tightestWindow(agPastGemini, now)).toBeUndefined();

    // 4. Multi-account Antigravity merge (Pro 1x + Ultra 12.5x) ignores exhausted Claude/GPT
    // and estimates combined Gemini cycle API value from logs.
    const agUltra = account('antigravity:cli2', [], {
      plan: 'Google AI Ultra',
      email: 'ultra@example.com',
      machines: ['m2'],
      windows: [
        { kind: 'session', label: 'Gemini Models', usedPct: 5, resetsAt: now + 3600, windowSec: 18000 },
        { kind: 'weekly', label: 'Gemini Models', usedPct: 10, resetsAt: now + 2 * 86400, windowSec: 604800 },
        { kind: 'session', label: 'Claude and GPT', usedPct: 100, resetsAt: now + 1800, windowSec: 18000 },
        { kind: 'weekly', label: 'Claude and GPT', usedPct: 100, resetsAt: now + 2 * 86400, windowSec: 604800 },
      ],
    });
    const agCost: CostReport = {
      generatedAt: now,
      days: 90,
      weekHours: 168,
      monthHours: 750,
      machines: {},
      rows: [],
      recentSince: now - 8 * 86400,
      recent: [
        { at: now - 3600, provider: 'antigravity', machine: 'm1', tokens: 1000, requests: 1, cost: 25, priced: true },
        { at: now - 3600, provider: 'antigravity', machine: 'm2', tokens: 1000, requests: 1, cost: 125, priced: true },
      ],
    };
    const mergedAg = mergeProviderAccounts([agCli, agUltra], 'antigravity', now, agCost)!;
    // m1 Pro: $25 / 0.25 = $100; m2 Ultra: $125 / 0.10 = $1250 -> total $150 / $1350 = 11.11% used!
    expect(mergedAg.summary).toMatchObject({ weighting: 'api', usedUsd: 150, capacityUsd: 1350, availableUsd: 1200 });
    expect(mergedAg.summary.usedPct).toBeCloseTo(11.11, 1);
    expect(mergedAg.summary.resetsAt).toBe(now + 86400);

    // UI check: tile, overview, and summary bar show ~11% used ($150 / $1350), NOT 100% from Claude/GPT,
    // while expanded account cards still list both Gemini Models and Claude and GPT groups.
    useUsage.setState({ snapshot: snapshot([agCli, agUltra]), cost: agCost, remaining: false });
    await act(async () => setView({ tab: 'overview', remaining: false }));
    await act(async () => root.render(createElement(UsagePanel)));
    const tile = host.querySelector<HTMLButtonElement>('.usage-tile[data-provider="antigravity"]')!;
    expect(tile.title).toContain('89%');
    expect(tile.title).toContain('$1200 / $1350');
    const row = host.querySelector<HTMLElement>('.usage-row[data-account="antigravity:merged"]')!;
    expect(row.textContent).toContain('~11%');
    expect(row.textContent).toContain('$150 / $1350');
    await act(async () => tile.click());
    const summaryBar = host.querySelector<HTMLElement>('.usage-summary-bar[data-merged-summary="antigravity"]')!;
    expect(summaryBar.textContent).toContain('~11% used');
    expect(summaryBar.textContent).toContain('$150 / $1350');
    const card = host.querySelector<HTMLElement>('.usage-card[data-account="antigravity:cli1"]')!;
    expect(card.textContent).toContain('25% used');
    expect(card.textContent).toContain('Gemini Models');
    expect(card.textContent).toContain('Claude and GPT');
  });

  it('shows only merged approximate usage in overview/tiles and one compact summary bar in provider detail (no bulky merged card)', async () => {
    const cPro = account('claude:pro', [], {
      plan: 'Pro',
      email: 'pro@example.com',
      machines: ['m1'],
      windows: [{ kind: 'weekly', usedPct: 80, resetsAt: now + 86400, windowSec: 604800 }],
    });
    const cMax = account('claude:max', [], {
      plan: 'Max 20x',
      email: 'max@example.com',
      machines: ['m2'],
      windows: [{ kind: 'weekly', usedPct: 10, resetsAt: now + 2 * 86400, windowSec: 604800 }],
    });
    const ag1 = account('antigravity:a1', [], {
      email: 'one@example.com',
      windows: [
        { kind: 'model', label: 'Gemini 3 Pro', usedPct: 80, resetsAt: now + 3600 },
        { kind: 'weekly', label: 'Gemini Models', usedPct: 60, resetsAt: now + 7200, windowSec: 604800 },
      ],
    });
    const ag2 = account('antigravity:a2', [], {
      email: 'two@example.com',
      windows: [
        // Past reset counts as replenished (0% used) in the Gemini 3 Pro bucket; weekly is 20%.
        { kind: 'model', label: 'Gemini 3 Pro', usedPct: 90, resetsAt: now - 60 },
        { kind: 'weekly', label: 'Gemini Models', usedPct: 20, resetsAt: now + 5400, windowSec: 604800 },
      ],
    });
    const soloCodex = account('codex:solo', [35], { plan: 'Plus', email: 'solo@example.com' });
    // Real API-priced logs for Claude: m1 (Pro, 80%) spent $80 -> $100 full; m2 (Max 20x, 10%) spent $200 -> $2000 full.
    // Combined Claude 7d: $280 / $2100 used = 13.33% used (86.67% left, $1820 left).
    // Antigravity shared weekly cycle: (60 + 20) / 2 = 40% used (60% left), equal-weight without logs.
    const demoCost: CostReport = {
      generatedAt: now,
      days: 90,
      weekHours: 168,
      monthHours: 750,
      machines: {},
      rows: [],
      recentSince: now - 8 * 86400,
      recent: [
        { at: now - 3600, provider: 'claude', machine: 'm1', tokens: 1000, requests: 1, cost: 80, priced: true },
        { at: now - 3600, provider: 'claude', machine: 'm2', tokens: 1000, requests: 1, cost: 200, priced: true },
      ],
    };

    useUsage.setState({ snapshot: snapshot([cPro, cMax, ag1, ag2, soloCodex]), cost: demoCost, remaining: false });
    await act(async () => setView({ tab: 'overview', remaining: false }));
    await act(async () => root.render(createElement(UsagePanel)));

    // Tiles show empirical API-value-weighted remaining % for Claude (~87% left) and equal-weight remaining % for Antigravity (~60% left).
    const claudeTile = host.querySelector<HTMLButtonElement>('.usage-tile[data-provider="claude"]')!;
    expect(claudeTile.title).toContain('87%');
    expect(claudeTile.title).toContain('$1820 / $2100');
    expect(claudeTile.querySelector<HTMLElement>('.usage-tile-meter i')?.style.width).toBe('86.67%');
    const agTile = host.querySelector<HTMLButtonElement>('.usage-tile[data-provider="antigravity"]')!;
    expect(agTile.title).toContain('60%');
    expect(agTile.querySelector<HTMLElement>('.usage-tile-meter i')?.style.width).toBe('60%');

    // Overview displays ONLY merged rows for multi-account providers — NO nested per-account subrows.
    expect(host.querySelectorAll('.usage-subrow')).toHaveLength(0);
    const overviewRows = [...host.querySelectorAll<HTMLElement>('.usage-row')];
    expect(overviewRows.map((r) => r.dataset.account)).toEqual(['antigravity:merged', 'codex:solo', 'claude:merged']);
    const claudeRow = host.querySelector<HTMLElement>('.usage-row[data-account="claude:merged"]')!;
    expect(claudeRow.textContent).toContain('2 accounts');
    expect(claudeRow.textContent).toContain('~13%');
    expect(claudeRow.textContent).toContain('$280 / $2100');
    expect(claudeRow.title).toContain('$1820');
    // Antigravity merged row shows shared cycle label (Weekly), never a single model's name.
    const agRow = host.querySelector<HTMLElement>('.usage-row[data-account="antigravity:merged"]')!;
    expect(agRow.textContent).toContain('~40%');
    expect(agRow.textContent).not.toContain('Gemini 3 Pro');

    // Toggling to Remaining keeps overview row and tile consistent (100 - 13.33 = 86.67 -> ~87%).
    const remBtn = [...host.querySelectorAll<HTMLButtonElement>('.usage-meta [role=radio]')].find((b) => b.textContent === 'Remaining')!;
    await act(async () => remBtn.click());
    expect(claudeRow.textContent).toContain('~87%');
    expect(claudeRow.textContent).toContain('$1820 / $2100');

    // Provider detail tab: NO bulky MergedAccountCard; ONLY one compact summary progress bar above individual account cards.
    await act(async () => claudeTile.click());
    expect(host.querySelector('.usage-card-merged')).toBeNull();
    expect(host.querySelector('.usage-card[data-account="claude:merged"]')).toBeNull();
    const summaryBar = host.querySelector<HTMLElement>('.usage-summary-bar[data-merged-summary="claude"]')!;
    expect(summaryBar).not.toBeNull();
    expect(summaryBar.querySelectorAll('[role="meter"]')).toHaveLength(1);
    expect(summaryBar.querySelectorAll('.usage-window')).toHaveLength(0);
    expect(summaryBar.textContent).toContain('Combined (2 accounts)');
    expect(summaryBar.textContent).toContain('~87% left');
    expect(summaryBar.textContent).toContain('$1820 / $2100');
    expect(summaryBar.title).toContain('$1820');

    // Switching back to Used mode updates the summary bar consistently (~13% used).
    const usedBtn = [...host.querySelectorAll<HTMLButtonElement>('.usage-meta [role=radio]')].find((b) => b.textContent === 'Used')!;
    await act(async () => usedBtn.click());
    expect(summaryBar.textContent).toContain('~13% used');
    expect(summaryBar.textContent).toContain('$280 / $2100');

    // Individual account cards are listed without a synthetic merged card.
    const cards = [...host.querySelectorAll<HTMLElement>('.usage-card[data-account]')].map((c) => c.dataset.account);
    expect(cards).toEqual(['claude:pro', 'claude:max']);

    // Single-account provider tab has no summary bar and no collapsible toggle button.
    await act(async () => host.querySelector<HTMLButtonElement>('.usage-tile[data-provider="codex"]')!.click());
    expect(host.querySelector('.usage-summary-bar')).toBeNull();
    expect(host.querySelector('.usage-card-toggle')).toBeNull();
  });

  it('makes multi-account detail cards collapsible with header summaries and persists layout across tab switches and remounts', async () => {
    const c1 = account('claude:a1', [85], { plan: 'Pro', email: 'alpha@example.com', status: 'stale', code: 'token_expired' });
    const c2 = account('claude:a2', [25], { plan: 'Max 20x', email: 'beta@example.com' });
    const x1 = account('codex:x1', [60], { plan: 'Plus', email: 'x1@example.com' });
    const x2 = account('codex:x2', [15], { plan: 'Pro', email: 'x2@example.com' });
    useUsage.setState({ snapshot: snapshot([c1, c2, x1, x2]), remaining: false });
    setView({ tab: 'claude', remaining: false });

    await act(async () => root.render(createElement(UsagePanel)));

    const card1 = () => host.querySelector<HTMLElement>('.usage-card[data-account="claude:a1"]')!;
    const card2 = () => host.querySelector<HTMLElement>('.usage-card[data-account="claude:a2"]')!;
    const toggle1 = () => card1().querySelector<HTMLButtonElement>('.usage-card-toggle')!;
    const toggle2 = () => card2().querySelector<HTMLButtonElement>('.usage-card-toggle')!;

    // Expanded by default.
    expect(toggle1().getAttribute('aria-expanded')).toBe('true');
    expect(toggle2().getAttribute('aria-expanded')).toBe('true');
    expect(card1().querySelectorAll('.usage-window')).toHaveLength(1);

    // Collapse first account card: hides windows/body but retains compact header summary (name, plan, status, headline %).
    await act(async () => toggle1().click());
    expect(toggle1().getAttribute('aria-expanded')).toBe('false');
    expect(card1().classList.contains('collapsed')).toBe(true);
    expect(card1().querySelectorAll('.usage-window')).toHaveLength(0);
    expect(toggle1().textContent).toContain('alpha@example.com');
    expect(toggle1().textContent).toContain('Pro');
    expect(toggle1().textContent).toContain('Stale');
    expect(toggle1().textContent).toContain('85% used');
    // Second card stays expanded.
    expect(toggle2().getAttribute('aria-expanded')).toBe('true');
    expect(card2().querySelectorAll('.usage-window')).toHaveLength(1);

    // Persisted via brand storage wrapper.
    const saved = JSON.parse(storage.get(COLLAPSED_ACCOUNTS_KEY) ?? '{}') as Record<string, boolean>;
    expect(saved[accountCollapseKey('claude', 'claude:a1')]).toBe(true);

    // Switch to Codex tab, collapse x2, then switch back to Claude: both providers keep their own state.
    await act(async () => host.querySelector<HTMLButtonElement>('.usage-tile[data-provider="codex"]')!.click());
    const x2Toggle = host.querySelector<HTMLButtonElement>('.usage-card[data-account="codex:x2"] .usage-card-toggle')!;
    expect(x2Toggle.getAttribute('aria-expanded')).toBe('true');
    await act(async () => x2Toggle.click());
    expect(x2Toggle.getAttribute('aria-expanded')).toBe('false');

    await act(async () => host.querySelector<HTMLButtonElement>('.usage-tile[data-provider="claude"]')!.click());
    expect(toggle1().getAttribute('aria-expanded')).toBe('false');
    expect(toggle2().getAttribute('aria-expanded')).toBe('true');

    // Simulate closing/reopening panel or reloading the app: unmount and remount fresh root.
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(UsagePanel)));
    expect(toggle1().getAttribute('aria-expanded')).toBe('false');
    expect(card1().querySelectorAll('.usage-window')).toHaveLength(0);
    expect(toggle2().getAttribute('aria-expanded')).toBe('true');
    expect(card2().querySelectorAll('.usage-window')).toHaveLength(1);

    // Re-expanding updates storage and restores card body.
    await act(async () => toggle1().click());
    expect(toggle1().getAttribute('aria-expanded')).toBe('true');
    expect(card1().querySelectorAll('.usage-window')).toHaveLength(1);
    const after = JSON.parse(storage.get(COLLAPSED_ACCOUNTS_KEY) ?? '{}') as Record<string, boolean>;
    expect(after[accountCollapseKey('claude', 'claude:a1')]).toBe(false);
    expect(after[accountCollapseKey('codex', 'codex:x2')]).toBe(true);
  });

  it('merges non-Antigravity providers in the status bar button and hover preview with matching summary percentages and API value subtitles', async () => {
    vi.useFakeTimers();
    try {
      // Multi-window Claude accounts: Pro (1x: 5h=80%/7d=50%, $50 logs -> $100) + Max 20x (20x: 5h=10%/7d=20%, $400 logs -> $2000)
      // => 7d tightest cycle = 21.43% used ($450 / $2100).
      const cPro = account('claude:pro', [], {
        plan: 'Pro',
        email: 'pro@example.com',
        machines: ['m1'],
        windows: [
          { kind: 'session', usedPct: 80, resetsAt: now + 3600, windowSec: 18000 },
          { kind: 'weekly', usedPct: 50, resetsAt: now + 86400, windowSec: 604800 },
        ],
      });
      const cMax = account('claude:max', [], {
        plan: 'Max 20x',
        email: 'max@example.com',
        machines: ['m2'],
        windows: [
          { kind: 'session', usedPct: 10, resetsAt: now + 3600, windowSec: 18000 },
          { kind: 'weekly', usedPct: 20, resetsAt: now + 2 * 86400, windowSec: 604800 },
        ],
      });
      // Hybrid subscription (100% used on Plus, $50 logs + untouched $50 extra USD credits) alongside Plus (0% used, calibrated $50)
      // => $50 / $150 = 33.33% used.
      const hyb1 = account('codex:hyb1', [], {
        plan: 'Plus',
        email: 'hyb1@example.com',
        machines: ['m1'],
        windows: [{ kind: 'session', usedPct: 100, resetsAt: now + 3600, windowSec: 18000 }],
        credits: { unit: 'usd', enabled: true, limit: 50, used: 0 },
      });
      const hyb2 = account('codex:hyb2', [], {
        plan: 'Plus',
        email: 'hyb2@example.com',
        machines: ['m2'],
        windows: [{ kind: 'session', usedPct: 0, resetsAt: now + 3600, windowSec: 18000 }],
      });
      const sbCost: CostReport = {
        generatedAt: now,
        days: 90,
        weekHours: 168,
        monthHours: 750,
        machines: {},
        rows: [],
        recentSince: now - 8 * 86400,
        recent: [
          { at: now - 3600, provider: 'claude', machine: 'm1', tokens: 1000, requests: 1, cost: 50, priced: true },
          { at: now - 3600, provider: 'claude', machine: 'm2', tokens: 1000, requests: 1, cost: 400, priced: true },
          { at: now - 1800, provider: 'codex', machine: 'm1', tokens: 1000, requests: 1, cost: 50, priced: true },
        ],
      };
      useUsage.setState({ snapshot: snapshot([cPro, cMax, hyb1, hyb2]), cost: sbCost, remaining: false });
      useSettings.setState({
        values: {
          'usage.statusBar': { value: true, source: 'global' },
          'usage.statusBarProvider': { value: 'auto', source: 'global' },
          'usage.statusBarWindow': { value: 'auto', source: 'global' },
        } as never,
      });
      await act(async () => root.render(createElement(UsageStatusItem)));
      const btn = host.querySelector<HTMLButtonElement>('.usage-status-item')!;
      // Button in auto mode matches summary.usedPct: Codex hybrid 33.33% (33%) > Claude 21.43% (21%).
      expect(btn.textContent?.trim()).toBe('33% used');
      expect(btn.getAttribute('aria-label')).toContain('Combined (2 accounts)');
      const anchor = btn.parentElement!;
      const hoverEvt = new MouseEvent('pointerover', { bubbles: true });
      Object.defineProperty(hoverEvt, 'pointerType', { value: 'mouse' });
      await act(async () => void anchor.dispatchEvent(hoverEvt));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      const claudeHover = host.querySelector<HTMLElement>('.usage-hover [data-account="claude:merged"]')!;
      const codexHover = host.querySelector<HTMLElement>('.usage-hover [data-account="codex:merged"]')!;
      // Hover card displays cycle name + empirical equivalent API values matching summary %.
      expect(claudeHover.textContent).toContain('2 accounts');
      expect(claudeHover.textContent).toContain('21% used');
      expect(claudeHover.textContent).toContain('Weekly');
      expect(claudeHover.textContent).toContain('$450 / $2100');
      expect(codexHover.textContent).toContain('2 accounts');
      expect(codexHover.textContent).toContain('33% used');
      expect(codexHover.textContent).toContain('5 hours');
      expect(codexHover.textContent).toContain('$50.00 / $150');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aggregates only sub-quotas with expected full-cycle value estimates when accounts use disjoint sub-quota pools', async () => {
    const todayStr = dayOf(new Date(now * 1000));
    // Account 1 (nus-ws-1): Gemini untouched (0%), Claude and GPT models 62.22% used ($54.11 spent -> ~$86.97 full).
    const accClaudeOnly = account('antigravity:u1', [], {
      email: 'u1@example.com',
      machines: ['nus-ws-1'],
      windows: [
        { kind: 'session', label: 'Gemini Models', usedPct: 0, resetsAt: now + 4 * 3600, windowSec: 18000 },
        { kind: 'weekly', label: 'Gemini Models', usedPct: 0, resetsAt: now + 6 * 86400, windowSec: 604800 },
        { kind: 'session', label: 'Claude and GPT models', usedPct: 0, resetsAt: now + 4 * 3600, windowSec: 18000 },
        { kind: 'weekly', label: 'Claude and GPT models', usedPct: 62.22, resetsAt: now + 4 * 86400, windowSec: 604800 },
      ],
    });
    // Account 2 (localhost, m920x): Gemini 28.28% used ($405 spent -> ~$1432.11 full), Claude and GPT untouched (0%).
    const accGeminiOnly = account('antigravity:u2', [], {
      email: 'u2@example.com',
      machines: ['localhost', 'm920x'],
      windows: [
        { kind: 'session', label: 'Gemini Models', usedPct: 8.06, resetsAt: now + 4 * 3600, windowSec: 18000 },
        { kind: 'weekly', label: 'Gemini Models', usedPct: 28.28, resetsAt: now + 6 * 86400, windowSec: 604800 },
        { kind: 'session', label: 'Claude and GPT models', usedPct: 0, resetsAt: now + 4 * 3600, windowSec: 18000 },
        { kind: 'weekly', label: 'Claude and GPT models', usedPct: 0, resetsAt: now + 6 * 86400, windowSec: 604800 },
      ],
    });
    const mixedCost: CostReport = {
      generatedAt: now,
      days: 90,
      weekHours: 168,
      monthHours: 750,
      machines: {},
      rows: [
        {
          day: todayStr,
          provider: 'antigravity',
          model: 'claude-sonnet-4-6',
          machine: 'nus-ws-1',
          input: 50_000_000,
          cached: 76_000_000,
          cacheWrite: 0,
          output: 300_000,
          requests: 120,
          cost: 54.11,
          priced: true,
        },
        {
          day: todayStr,
          provider: 'antigravity',
          model: 'gemini-3-pro',
          machine: 'localhost',
          input: 200_000_000,
          cached: 800_000_000,
          cacheWrite: 0,
          output: 5_000_000,
          requests: 400,
          cost: 405,
          priced: true,
        },
      ],
      recentSince: now - 8 * 86400,
      recent: [
        { at: now - 86400, provider: 'antigravity', machine: 'nus-ws-1', tokens: 126_300_000, requests: 120, cost: 54.11, priced: true },
        { at: now - 1800, provider: 'antigravity', machine: 'localhost', tokens: 69_000_000, requests: 40, cost: 21.93, priced: true },
        { at: now - 7200, provider: 'antigravity', machine: 'localhost', tokens: 931_000_000, requests: 360, cost: 383.07, priced: true },
      ],
    };

    // Single-account headlines reflect each account's genuinely active sub-quota (62.22% and 28.28%).
    expect(accountUsedPct(accClaudeOnly, now, mixedCost)).toBeCloseTo(62.22, 1);
    expect(accountUsedPct(accGeminiOnly, now, mixedCost)).toBeCloseTo(28.28, 1);

    // Merged weekly summary sums ONLY the valued sub-quotas: (54.11 + 405) / (86.97 + 1432.11) = 459.11 / 1519.07 = 30.22% used (~70% left).
    // Untouched Gemini on Account 1 and untouched Claude/GPT on Account 2 are NOT imputed!
    const merged = mergeProviderAccounts([accClaudeOnly, accGeminiOnly], 'antigravity', now, mixedCost)!;
    expect(merged.summary.weighting).toBe('api');
    expect(merged.summary.window?.kind).toBe('weekly');
    expect(merged.summary.usedUsd).toBeCloseTo(459.11, 1);
    expect(merged.summary.capacityUsd).toBeCloseTo(1519.07, 0);
    expect(merged.summary.availableUsd).toBeCloseTo(1059.96, 0);
    expect(merged.summary.usedPct).toBeCloseTo(30.22, 1);
    expect(merged.summary.remainingPct).toBeCloseTo(69.78, 1);

    // UI Remaining mode shows ~70% left (NOT 55% equal average and NOT 86% imputed Ultra Gemini),
    // while per-account cards show 38% left and 72% left!
    useUsage.setState({ snapshot: snapshot([accClaudeOnly, accGeminiOnly]), cost: mixedCost, remaining: true });
    await act(async () => setView({ tab: 'antigravity', remaining: true }));
    await act(async () => root.render(createElement(UsagePanel)));
    const summaryBar = host.querySelector<HTMLElement>('.usage-summary-bar[data-merged-summary="antigravity"]')!;
    expect(summaryBar.textContent).toContain('~70% left');
    expect(summaryBar.textContent).toContain('$1060 / $1519');
    const u1Card = host.querySelector<HTMLElement>('.usage-card[data-account="antigravity:u1"]')!;
    const u2Card = host.querySelector<HTMLElement>('.usage-card[data-account="antigravity:u2"]')!;
    expect(u1Card.querySelector('.usage-card-pct')?.textContent).toBe('38% left');
    expect(u2Card.querySelector('.usage-card-pct')?.textContent).toBe('72% left');

    // Same-machine account using BOTH Gemini and Claude/GPT splits CostReport.recent cleanly via CostReport.rows.
    const bothUsed = account('antigravity:both', [], {
      machines: ['m-both'],
      windows: [
        { kind: 'weekly', label: 'Gemini Models', usedPct: 25, resetsAt: now + 5 * 86400, windowSec: 604800 },
        { kind: 'weekly', label: 'Claude and GPT models', usedPct: 50, resetsAt: now + 5 * 86400, windowSec: 604800 },
      ],
    });
    const bothCost: CostReport = {
      generatedAt: now,
      days: 90,
      weekHours: 168,
      monthHours: 750,
      machines: {},
      rows: [
        {
          day: todayStr,
          provider: 'antigravity',
          model: 'gemini-3-pro',
          machine: 'm-both',
          input: 1000,
          cached: 0,
          cacheWrite: 0,
          output: 100,
          requests: 10,
          cost: 200,
          priced: true,
        },
        {
          day: todayStr,
          provider: 'antigravity',
          model: 'claude-opus-4-6',
          machine: 'm-both',
          input: 500,
          cached: 0,
          cacheWrite: 0,
          output: 100,
          requests: 5,
          cost: 50,
          priced: true,
        },
      ],
      recentSince: now - 8 * 86400,
      recent: [{ at: now - 3600, provider: 'antigravity', machine: 'm-both', tokens: 1700, requests: 15, cost: 250, priced: true }],
    };
    const gSpend = windowSpend(bothCost, bothUsed, bothUsed.windows[0], now)!;
    const cSpend = windowSpend(bothCost, bothUsed, bothUsed.windows[1], now)!;
    expect(gSpend).toMatchObject({ cost: 200, full: { cost: 800 } });
    expect(cSpend).toMatchObject({ cost: 50, full: { cost: 100 } });
  });
});
