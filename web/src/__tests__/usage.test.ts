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
import { UsageStatusItem } from '../plugins/usage/StatusItem';
import { applySnapshot, costStale, fetchCost, fetchSnapshot, setView, useUsage } from '../plugins/usage/state';
import {
  costOf,
  daily,
  dailyDetails,
  equivalents,
  rank,
  rankTokens,
  sortAccounts,
  modelBreakdown,
  shortModel,
  tightest,
  tightestFor,
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
});
