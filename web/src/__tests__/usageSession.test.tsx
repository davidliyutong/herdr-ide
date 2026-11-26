// @vitest-environment jsdom
//
// The AI usage plugin's status bar item of the focused pane's agent session
// (usage.session): when it shows, how it formats the cost and the context,
// its card, when it reads the session from the machine (fake timers), and
// its place among the status bar's widgets.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { StatusBar } from '../App';
import { useMenu, isItem } from '../contextMenu';
import { useStore } from '../state/store';
import { useTerms } from '../state/terms';
import { useSettings } from '../settings';
import { allPlugins, definePlugins } from '../plugins/registry';
import { usagePlugin } from '../plugins/usage';
import { UsageSessionItem } from '../plugins/usage/SessionItem';
import { UsageStatusItem } from '../plugins/usage/StatusItem';
import {
  resetSessionReads,
  SESSION_KEEP,
  SESSION_RETRY_MS,
  SESSION_TIMEOUT_MS,
  SESSION_WORKING_EVERY,
  sessionKey,
} from '../plugins/usage/session';
import { setView, useUsage } from '../plugins/usage/state';
import {
  contextShort,
  sessionAccount,
  sessionCost,
  sessionUsageOf,
  tokensShort,
  type SessionUsage,
  type UsageAccount,
  type UsageSnapshot,
} from '../plugins/usage/model';
import { HOVER_OPEN_MS } from '../components/useHoverOpen';
import type { TerminalRecord } from '../term/protocol';
import type * as L from '../term/layout';
import { t } from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S1 = '0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f';
const S2 = '1c7a6d2f-9e4b-4d3c-8f2a-3b4c5d6e7f80';
const S3 = '2d8b7e3a-0f5c-4e4d-9a3b-4c5d6e7f8091';

const now = Math.floor(Date.now() / 1000);

function usage(o: Partial<SessionUsage> = {}): SessionUsage {
  return {
    model: 'claude-opus-4-6',
    input: 4000,
    cached: 120_000,
    cacheWrite: 20_000,
    output: 1500,
    reasoning: 0,
    requests: 12,
    cost: 1.234,
    priced: true,
    contextUsed: 84_000,
    contextSize: 200_000,
    ...o,
  };
}

function account(key: string, machines: string[], pcts: number[], extra: Partial<UsageAccount> = {}): UsageAccount {
  return {
    key,
    provider: key.split(':')[0],
    status: 'ok',
    machines,
    seenAt: now,
    windows: pcts.map((p, i) => ({ kind: i ? 'weekly' : 'session', usedPct: p, resetsAt: now + 3600 * (i + 1), windowSec: 18000 })),
    ...extra,
  };
}

const snap = (accounts: UsageAccount[]): UsageSnapshot => ({
  updatedAt: now,
  refresh: 'adaptive',
  interval: 1800,
  polling: false,
  accounts,
  machines: {},
  status: {},
});

/** A terminal record of an agent with a session. */
function rec(address: string, o: Record<string, unknown> = {}): TerminalRecord {
  return { address, agent: 'claude', agent_status: 'idle', agent_session: S1, agent_session_source: 'pid', ...o };
}

/** The machine's terminals, side by side in one tab, focused one of them. */
function show(records: TerminalRecord[], focused: string) {
  const leaves: L.Node[] = records.map((r) => ({ terminal: r.address }));
  const root: L.Node = leaves.length === 1 ? leaves[0] : { split: 'horizontal', ratio: 0.5, children: [leaves[0], leaves[1]] };
  const layout: L.Layout = {
    version: 2,
    selected: 0,
    workspaces: [{ id: 'w', name: '', cwd: '', selected: 0, tabs: [{ root, focused }] }],
  };
  useTerms.setState({ machines: { local: { terminals: Object.fromEntries(records.map((r) => [r.address, r])), layout } } });
}

/** The machine's answers by session; the numbers of usage() otherwise. */
let answers: Map<string, { status: number; body: unknown }>;
/** The sessions read, in order. */
let reads: string[];
/** While set, the machine's answers wait for it. */
let hold: Promise<void> | undefined;
/** While true, the machine never answers: a request ends only when it is aborted. */
let hang: boolean;

let host: HTMLDivElement;
let root: Root;

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const set = (fn: () => void) =>
  act(async () => {
    fn();
    await vi.advanceTimersByTimeAsync(0);
  });
const item = () => host.querySelector<HTMLButtonElement>('.usage-session-item');
const render = () => set(() => root.render(createElement(UsageSessionItem)));

beforeEach(() => {
  vi.useFakeTimers();
  answers = new Map();
  reads = [];
  hold = undefined;
  hang = false;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = new URL(String(url), 'http://hub');
    if (u.pathname === '/api/m/local/p/usage/session') {
      const session = u.searchParams.get('session') ?? '';
      const cwd = u.searchParams.get('cwd') ?? '';
      const kind = u.searchParams.get('kind') ?? '';
      const key = session || `${kind}:${cwd}`;
      reads.push(key);
      if (hang)
        await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      if (hold) await hold;
      const a = answers.get(key) ?? { status: 200, body: usage() };
      return { ok: a.status < 300, status: a.status, json: async () => a.body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  resetSessionReads();
  useUsage.setState({
    sessions: {},
    snapshot: snap([
      account('claude:a', ['local'], [40, 70], { email: 'a@example.com' }),
      account('claude:b', ['box'], [95], { email: 'b@example.com' }),
      account('codex:c', ['local'], [10]),
    ]),
  });
  setView({ tab: 'overview', remaining: false });
  useSettings.setState({ values: {} });
  useStore.setState({ machineId: 'local', panel: undefined });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetSessionReads();
  useTerms.setState({ machines: {} });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usage session model', () => {
  it('formats the cost as the spend does and the context as a share or tokens', () => {
    expect(sessionCost(usage())).toBe('$1.23');
    expect(sessionCost(usage({ cost: 123.4 }))).toBe('$123');
    expect(sessionCost(usage({ priced: false, cost: 0.4 }))).toBe('—');
    expect(contextShort(usage())).toBe('42%');
    expect(contextShort(usage({ contextSize: 0 }))).toBe('84k');
    expect(contextShort(usage({ contextSize: 0, contextUsed: 0 }))).toBe('');
    expect([999, 84_321, 999_600, 1_234_567, 12_345_678].map(tokensShort)).toEqual(['999', '84k', '1.0M', '1.2M', '12M']);
  });

  it('takes only numbers from the answer', () => {
    expect(sessionUsageOf(null)).toBeUndefined();
    expect(sessionUsageOf([1])).toBeUndefined();
    expect(sessionUsageOf({ model: 3, input: -1, cached: 'x', output: Infinity, cost: 0.5, priced: 'yes', contextUsed: 10 })).toEqual({
      model: undefined,
      input: 0,
      cached: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      requests: 0,
      cost: 0.5,
      priced: false,
      contextUsed: 10,
      contextSize: 0,
    });
  });

  it('finds the account of the service read on the agent’s machine', () => {
    const s = useUsage.getState().snapshot;
    expect(sessionAccount(s, 'claude', 'local')?.key).toBe('claude:a');
    expect(sessionAccount(s, 'claude', 'box')?.key).toBe('claude:b');
    expect(sessionAccount(s, 'claude', 'other')).toBeUndefined();
    expect(sessionAccount(s, 'grok', 'local')).toBeUndefined();
  });
});

describe('usage session item', () => {
  it('shows nothing and reads nothing without a focused agent session of a service that is on', async () => {
    await render();
    const cases: [string, () => void][] = [
      ['no terminal focused', () => show([rec('t1')], 'code:x')],
      ['no agent', () => show([rec('t1', { agent: undefined })], 't1')],
      ['no session', () => show([rec('t1', { agent_session: undefined })], 't1')],
      ['not a session id', () => show([rec('t1', { agent_session: 'x; rm -rf ~' })], 't1')],
      ['a session the machine only guessed', () => show([rec('t1', { agent_session_source: 'guess' })], 't1')],
      ['a session of no known source', () => show([rec('t1', { agent_session_source: undefined })], 't1')],
      ['no usage provider', () => show([rec('t1', { agent: 'gemini' })], 't1')],
      [
        'its service turned off',
        () => {
          useSettings.setState({ values: { 'usage.providers.claude': { value: false, source: 'global' } } as never });
          show([rec('t1')], 't1');
        },
      ],
    ];
    for (const [name, arrange] of cases) {
      await set(arrange);
      await advance(60_000);
      expect(item(), name).toBeNull();
      expect(reads, name).toEqual([]);
    }
  });

  it('shows the cost and the context once the machine answered: priced with a window, unpriced without', async () => {
    answers.set(S2, { status: 200, body: usage({ priced: false, cost: 0.5, contextSize: 0, model: 'gpt-x' }) });
    show([rec('t1'), rec('t2', { agent_session: S2 })], 't1');
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    await render();
    // Before the first answer: nothing.
    expect(reads).toEqual([S1]);
    expect(item()).toBeNull();
    await set(() => release());
    hold = undefined;
    const b = item()!;
    expect(b.dataset.provider).toBe('claude');
    expect(b.querySelector('.ai-logo')).not.toBeNull();
    expect(b.querySelector('.usage-session-cost')!.textContent).toBe('$1.23');
    expect(b.querySelector('.usage-session-ctx')!.textContent).toBe('42% ctx');
    expect(b.getAttribute('aria-label')).toBe('AI usage of the Claude Code session: $1.23, context 42%');
    await set(() => show([rec('t1'), rec('t2', { agent_session: S2 })], 't2'));
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('—');
    expect(item()!.querySelector('.usage-session-ctx')!.textContent).toBe('84k ctx');
    // A session without context yet: the cost alone.
    answers.set(S3, { status: 200, body: usage({ contextUsed: 0, contextSize: 0 }) });
    await set(() => show([rec('t1', { agent_session: S3 })], 't1'));
    expect(item()!.querySelector('.usage-session-ctx')).toBeNull();
    expect(item()!.getAttribute('aria-label')).toBe('AI usage of the Claude Code session: $1.23');
  });

  it('lists the session’s numbers and the account’s tightest window on hover; a click shows the service', async () => {
    show([rec('t1')], 't1');
    await render();
    const anchor = item()!.parentElement!;
    const e = new MouseEvent('pointerover', { bubbles: true });
    Object.defineProperty(e, 'pointerType', { value: 'mouse' });
    await set(() => void anchor.dispatchEvent(e));
    await advance(HOVER_OPEN_MS);
    const card = host.querySelector<HTMLElement>('.usage-session-hover')!;
    expect(card.getAttribute('role')).toBe('tooltip');
    expect(item()!.getAttribute('aria-describedby')).toBe(card.id);
    const facts = [...card.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]);
    expect(facts).toEqual([
      ['Model', 'claude-opus-4-6'],
      ['Cost at API prices', '$1.23'],
      ['Context', '84.0k of 200.0k (42%)'],
      ['Requests', '12'],
      ['Input', '4.0k'],
      ['Cache reads', '120.0k'],
      ['Cache writes', '20.0k'],
      ['Output', '1.5k'],
    ]);
    // The account read on this machine, not the tighter one of another.
    const line = card.querySelector<HTMLElement>('.usage-session-account [data-account]')!;
    expect(line.dataset.account).toBe('claude:a');
    expect(line.textContent).toContain('70% used');
    expect(line.textContent).toContain('a@example.com');
    expect(line.classList.contains('level-ok')).toBe(true);
    await set(() => item()!.click());
    expect(useStore.getState().panel).toBe('usage');
    expect(useUsage.getState().tab).toBe('claude');
    expect(host.querySelector('.usage-session-hover')).toBeNull();
  });

  it('says when a model has no price and lists the reasoning when there is some', async () => {
    answers.set(S2, { status: 200, body: usage({ priced: false, reasoning: 300, contextSize: 0, model: undefined }) });
    show([rec('t1', { agent: 'codex', agent_session: S2 })], 't1');
    await render();
    const anchor = item()!.parentElement!;
    const e = new MouseEvent('pointerover', { bubbles: true });
    Object.defineProperty(e, 'pointerType', { value: 'mouse' });
    await set(() => void anchor.dispatchEvent(e));
    await advance(HOVER_OPEN_MS);
    const card = host.querySelector<HTMLElement>('.usage-session-hover')!;
    const facts = Object.fromEntries([...card.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]));
    expect(facts.Model).toBeUndefined();
    expect(facts['Cost at API prices']).toBe('— · a model has no price');
    expect(facts.Context).toBe('84.0k');
    expect(facts['Reasoning (part of output)']).toBe('300');
    expect(card.querySelector<HTMLElement>('.usage-session-account [data-account]')!.dataset.account).toBe('codex:c');
  });
});

describe('usage window in the status bar', () => {
  it('follows the agent in the focused pane: its service on its machine, its model among the windows of models', async () => {
    const limit = () => host.querySelector<HTMLButtonElement>('.usage-status-item:not(.usage-session-item)');
    useUsage.setState({
      snapshot: snap([
        account('claude:a', ['local'], [40, 70], {
          windows: [
            { kind: 'session', usedPct: 40, resetsAt: now + 3600, windowSec: 18000 },
            { kind: 'weekly', usedPct: 70, resetsAt: now + 7200, windowSec: 604800 },
            { kind: 'model', label: 'Sonnet', usedPct: 99, resetsAt: now + 7200, windowSec: 604800 },
          ],
        }),
        account('claude:b', ['box'], [95]),
        account('codex:c', ['local'], [10]),
      ]),
    });
    // No agent: the tightest across preview accounts (claude:a 5h=40% and claude:b 5h=95% merge on the shared 5h cycle to 67.5% -> 68%).
    show([{ address: 't0' }], 't0');
    await set(() => root.render(createElement('div', null, createElement(UsageStatusItem), createElement(UsageSessionItem))));
    expect(limit()!.textContent!.trim()).toBe('68% used');
    expect(limit()!.querySelector('.ai-logo')).toBeNull();
    // Claude Code on this machine with Opus: its account's weekly window,
    // not Sonnet's; the session item names the model.
    await set(() => show([rec('t1')], 't1'));
    expect(limit()!.textContent!.trim()).toBe('70% used');
    expect(limit()!.querySelector('.ai-logo')).not.toBeNull();
    expect(item()!.querySelector('.usage-session-model')!.textContent).toBe('opus-4-6');
    // The agent turned to Sonnet.
    answers.set(S2, { status: 200, body: usage({ model: 'claude-sonnet-4-6' }) });
    await set(() => show([rec('t1', { agent_session: S2 })], 't1'));
    expect(limit()!.textContent!.trim()).toBe('99% used');
    expect(item()!.querySelector('.usage-session-model')!.textContent).toBe('sonnet-4-6');
    // Codex: its own account.
    await set(() => show([rec('t2', { agent: 'codex', agent_session: S3 })], 't2'));
    expect(limit()!.textContent!.trim()).toBe('10% used');
    // Antigravity with model-only windows: followed even without a matching model name.
    useUsage.setState((s) => ({
      ...s,
      snapshot: snap([
        ...(s.snapshot?.accounts ?? []),
        account('antigravity:a1', ['local'], [], {
          email: 'a1@example.com',
          windows: [{ kind: 'model', label: 'Gemini 3 Pro', usedPct: 60, resetsAt: now + 3600 }],
        }),
        account('antigravity:a2', ['local'], [], {
          email: 'a2@example.com',
          windows: [{ kind: 'model', label: 'Gemini 3 Pro', usedPct: 20, resetsAt: now + 7200 }],
        }),
      ]),
    }));
    await set(() => show([rec('t3', { agent: 'agy', agent_session: undefined, cwd: '/work/ag' })], 't3'));
    expect(limit()!.textContent!.trim()).toBe('40% used');
    // Hovering the status bar item shows merged Antigravity with per-account breakdown.
    const statusAnchor = limit()!.parentElement!;
    const hoverEvt = new MouseEvent('pointerover', { bubbles: true });
    Object.defineProperty(hoverEvt, 'pointerType', { value: 'mouse' });
    await set(() => void statusAnchor.dispatchEvent(hoverEvt));
    await advance(HOVER_OPEN_MS);
    const mergedLine = host.querySelector<HTMLElement>('.usage-hover [data-account="antigravity:merged"]')!;
    expect(mergedLine.textContent).toContain('2 accounts');
    expect(mergedLine.textContent).toContain('40% used');
    expect([...mergedLine.querySelectorAll('.usage-hover-sub')].map((el) => el.textContent)).toEqual([
      'a1@example.com60% used',
      'a2@example.com20% used',
    ]);
    // Focused Chat pane: status bar window follows its agent without rendering terminal UsageSessionItem.
    const chatLayout: L.Layout = {
      version: 2,
      selected: 0,
      workspaces: [
        {
          id: 'w',
          name: '',
          cwd: '',
          selected: 0,
          tabs: [{ root: { view: { id: 'p1', plugin: 'chat', kind: 'chat', agent: 'codex', chat: S1 } }, focused: 'view:p1' }],
        },
      ],
    };
    await set(() => useTerms.setState({ machines: { local: { terminals: {}, layout: chatLayout } } }));
    expect(limit()!.textContent!.trim()).toBe('10% used');
    expect(item()).toBeNull();
  });

  it('resolves session usage by cwd for grok, kimi, opencode, agy and codex when unambiguous', async () => {
    answers.set('grok:/work/repo', {
      status: 200,
      body: usage({ model: 'grok-4.6', cost: 0.42, contextUsed: 10_000, contextSize: 100_000 }),
    });
    show(
      [rec('t1', { agent: 'grok', agent_session: undefined, agent_session_source: undefined, cwd: '/work/repo', foreground: { pid: 99 } })],
      't1',
    );
    await render();
    expect(reads).toEqual(['grok:/work/repo']);
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('$0.42');
    expect(item()!.querySelector('.usage-session-ctx')!.textContent).toBe('10% ctx');
    // Two live terminals of the same agent in the same cwd: ambiguous, do not fetch or misattribute.
    reads = [];
    await set(() =>
      show(
        [
          rec('t1', { agent: 'kimi', agent_session: undefined, agent_session_source: undefined, cwd: '/work/shared' }),
          rec('t2', { agent: 'kimi', agent_session: undefined, agent_session_source: undefined, cwd: '/work/shared' }),
        ],
        't1',
      ),
    );
    expect(reads).toEqual([]);
    expect(item()).toBeNull();
  });

  it('accepts confirmed OpenCode ses_* session ids and rejects guessed or malformed ones', async () => {
    answers.set('ses_alpha123', {
      status: 200,
      body: usage({ model: 'deepseek-v4-flash', cost: 0.35, contextUsed: 5000, contextSize: 0 }),
    });
    show([rec('t1', { agent: 'opencode', agent_session: 'ses_alpha123', agent_session_source: 'pid', cwd: '/work/oc' })], 't1');
    await render();
    expect(reads).toEqual(['ses_alpha123']);
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('$0.35');
    expect(item()!.querySelector('.usage-session-ctx')!.textContent).toBe('5k ctx');
    // Guessed or malformed ses_* is never queried (and does not fall back to cwd).
    reads = [];
    for (const bad of [
      { agent_session: 'ses_beta456', agent_session_source: 'guess' },
      { agent_session: 'ses_../bad', agent_session_source: 'pid' },
    ]) {
      await set(() => show([rec('t1', { agent: 'opencode', cwd: '/work/oc', ...bad })], 't1'));
      expect(reads).toEqual([]);
      expect(item()).toBeNull();
    }
  });
});

describe('usage session reads', () => {
  it('reads a working agent’s session every 30 s, once more when it stops, at most once in 10 s', async () => {
    show([rec('t1', { agent_status: 'working' })], 't1');
    await render();
    expect(reads).toHaveLength(1);
    await advance(29_999);
    expect(reads).toHaveLength(1);
    await advance(1);
    expect(reads).toHaveLength(2);
    // Done 5 s after a read: the last read waits for the gap.
    await advance(5_000);
    await set(() => show([rec('t1', { agent_status: 'done' })], 't1'));
    expect(reads).toHaveLength(2);
    await advance(4_999);
    expect(reads).toHaveLength(2);
    await advance(1);
    expect(reads).toHaveLength(3);
    // Done: no more reads.
    await advance(60_000);
    expect(reads).toHaveLength(3);
    // Idle: once.
    await set(() => show([rec('t1', { agent_status: 'idle' })], 't1'));
    expect(reads).toHaveLength(4);
    // Working and done again within the gap: one read, after it.
    await advance(1_000);
    await set(() => show([rec('t1', { agent_status: 'working' })], 't1'));
    await advance(1_000);
    await set(() => show([rec('t1', { agent_status: 'done' })], 't1'));
    expect(reads).toHaveLength(4);
    await advance(7_999);
    expect(reads).toHaveLength(4);
    await advance(1);
    expect(reads).toHaveLength(5);
    await advance(120_000);
    expect(reads).toEqual([S1, S1, S1, S1, S1]);
  });

  it('reads nothing from a hidden page, and what it owes once shown', async () => {
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      show([rec('t1', { agent_status: 'working' })], 't1');
      await render();
      await advance(120_000);
      expect(reads).toEqual([]);
      expect(item()).toBeNull();
      vis.mockReturnValue('visible');
      await set(() => void document.dispatchEvent(new Event('visibilitychange')));
      expect(reads).toEqual([S1]);
      expect(item()).not.toBeNull();
      // Shown again with nothing owed: no read.
      await advance(5_000);
      await set(() => void document.dispatchEvent(new Event('visibilitychange')));
      expect(reads).toEqual([S1]);
    } finally {
      vis.mockRestore();
    }
  });

  it('reads a pane’s new session at once and shows a pane focused again with its numbers kept', async () => {
    answers.set(S2, { status: 200, body: usage({ cost: 0.5 }) });
    answers.set(S3, { status: 200, body: usage({ cost: 2 }) });
    const both = (focused: string, s2 = S2) => show([rec('t1'), rec('t2', { agent_session: s2 })], focused);
    both('t1');
    await render();
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('$1.23');
    await advance(2_000);
    await set(() => both('t2'));
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('$0.50');
    // Back within the gap: the numbers kept, no read.
    await advance(2_000);
    act(() => both('t1'));
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('$1.23');
    expect(reads).toEqual([S1, S2]);
    // Back after the gap: the numbers kept at once, and read again.
    await advance(10_000);
    act(() => both('t2'));
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('$0.50');
    expect(reads).toEqual([S1, S2, S2]);
    await advance(0);
    // The pane's agent starts another session: read at once.
    await set(() => both('t2', S3));
    expect(reads).toEqual([S1, S2, S2, S3]);
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('$2.00');
    expect(Object.keys(useUsage.getState().sessions).sort()).toEqual(
      [sessionKey('local', 'claude', S1), sessionKey('local', 'claude', S2), sessionKey('local', 'claude', S3)].sort(),
    );
  });

  it('shows nothing for a session without a transcript yet, and asks again at its agent’s next status change', async () => {
    answers.set(S1, { status: 404, body: { error: 'not_found' } });
    const both = (focused: string, status = 'idle') =>
      show([rec('t1', { agent_status: status }), rec('t2', { agent_session: S2 })], focused);
    both('t1');
    await render();
    expect(reads).toEqual([S1]);
    expect(item()).toBeNull();
    // Focused again later, its agent as it was: not asked.
    await advance(20_000);
    await set(() => both('t2'));
    await advance(20_000);
    await set(() => both('t1'));
    expect(reads).toEqual([S1, S2]);
    expect(item()).toBeNull();
    // Its agent works: asked, and the transcript is there.
    answers.delete(S1);
    await set(() => both('t1', 'working'));
    expect(reads).toEqual([S1, S2, S1]);
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('$1.23');
  });

  it('shows nothing while the provider is off, and never asks again for an agent whose sessions are not priced', async () => {
    answers.set(S1, { status: 404, body: { error: 'provider_off' } });
    answers.set(S2, { status: 400, body: { error: 'bad_request' } });
    show([rec('t1')], 't1');
    await render();
    expect(reads).toEqual([S1]);
    expect(item()).toBeNull();
    const kimi = (status: string) => show([rec('t2', { agent: 'kimi', agent_session: S2, agent_status: status })], 't2');
    await set(() => kimi('idle'));
    expect(reads).toEqual([S1, S2]);
    expect(item()).toBeNull();
    await advance(20_000);
    await set(() => kimi('working'));
    await advance(60_000);
    await set(() => kimi('done'));
    await advance(20_000);
    expect(reads).toEqual([S1, S2]);
    expect(item()).toBeNull();
  });

  it('keeps the last numbers while the machine cannot answer', async () => {
    show([rec('t1', { agent_status: 'working' })], 't1');
    await render();
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('$1.23');
    answers.set(S1, { status: 409, body: { error: 'offline' } });
    await advance(30_000);
    expect(reads).toEqual([S1, S1]);
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('$1.23');
  });

  it('gives up a read the machine does not answer, and reads on', async () => {
    hang = true;
    show([rec('t1', { agent_status: 'working' })], 't1');
    await render();
    expect(reads).toEqual([S1]);
    expect(item()).toBeNull();
    await advance(SESSION_TIMEOUT_MS);
    hang = false;
    await advance(SESSION_WORKING_EVERY - SESSION_TIMEOUT_MS);
    expect(reads).toEqual([S1, S1]);
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('$1.23');
  });

  it('tries the read when the agent stopped once more after it failed, and only once', async () => {
    show([rec('t1', { agent_status: 'working' })], 't1');
    await render();
    answers.set(S1, { status: 409, body: { error: 'offline' } });
    await advance(11_000);
    await set(() => show([rec('t1', { agent_status: 'done' })], 't1'));
    expect(reads).toHaveLength(2);
    answers.set(S1, { status: 200, body: usage({ cost: 2 }) });
    await advance(SESSION_RETRY_MS - 1);
    expect(reads).toHaveLength(2);
    await advance(1);
    expect(reads).toHaveLength(3);
    expect(item()!.querySelector('.usage-session-cost')!.textContent).toBe('$2.00');
    // Failing again, it is tried once, not more.
    await set(() => show([rec('t1', { agent_status: 'working' })], 't1'));
    answers.set(S1, { status: 502, body: {} });
    await advance(11_000);
    await set(() => show([rec('t1', { agent_status: 'idle' })], 't1'));
    expect(reads).toHaveLength(4);
    await advance(SESSION_RETRY_MS);
    expect(reads).toHaveLength(5);
    await advance(10 * 60_000);
    expect(reads).toHaveLength(5);
  });

  it('reads every 30 s while the agent alternates between working and blocked, and not again while it stays blocked', async () => {
    show([rec('t1', { agent_status: 'working' })], 't1');
    await render();
    for (let i = 0; i < 15; i++) {
      await advance(20_000);
      await set(() => show([rec('t1', { agent_status: i % 2 ? 'working' : 'blocked' })], 't1'));
    }
    // The first read and one each 30 s of the 5 minutes.
    expect(reads).toHaveLength(11);
    // Blocked for long (the user is away): read once more for the work before, then not.
    await set(() => show([rec('t1', { agent_status: 'blocked' })], 't1'));
    await advance(10 * 60_000);
    expect(reads).toHaveLength(12);
    await set(() => show([rec('t1', { agent_status: 'working' })], 't1'));
    await advance(SESSION_WORKING_EVERY);
    expect(reads).toHaveLength(13);
  });

  it('keeps the numbers of at most SESSION_KEEP sessions, the oldest leaving first', async () => {
    const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    await render();
    for (let i = 0; i <= SESSION_KEEP; i++) {
      await set(() => show([rec('t1', { agent_session: id(i) })], 't1'));
      await advance(1);
    }
    const kept = useUsage.getState().sessions;
    expect(Object.keys(kept)).toHaveLength(SESSION_KEEP);
    expect(kept[sessionKey('local', 'claude', id(0))]).toBeUndefined();
    expect(kept[sessionKey('local', 'claude', id(SESSION_KEEP))]).toBeDefined();
  });
});

describe('usage session in the status bar', () => {
  const saved = [...allPlugins()];
  afterEach(() => {
    // Unmounted before the plugins come back, so that none of theirs mounts.
    act(() => root.unmount());
    root = createRoot(host);
    definePlugins(saved);
    useMenu.setState({ menu: undefined });
    useStore.setState({ hiddenStatusWidgets: [] });
  });

  it('is one of the widgets the status bar’s menu shows and hides', async () => {
    definePlugins([usagePlugin]);
    useSettings.setState({ values: { 'plugins.usage.enabled': { value: true, source: 'global' } } as never });
    useStore.setState({
      order: ['local'],
      hiddenStatusWidgets: [],
      machines: {
        local: { id: 'local', label: 'Local', kind: 'local', status: 'ready', platform: 'darwin/arm64', enabled: true, updated_at: 0 },
      },
    });
    show([rec('t1')], 't1');
    await set(() => root.render(createElement(StatusBar, { connected: true, chord: false })));
    expect(host.querySelector('[data-status-widget="usage.session"] .usage-session-item')).not.toBeNull();
    await set(() => host.querySelector<HTMLButtonElement>('.status-widgets-btn')!.click());
    const entry = useMenu.getState().menu!.entries.find((e) => isItem(e) && e.label === t('usage.session.title'));
    expect(entry).toBeDefined();
    await set(() => {
      if (isItem(entry)) entry.run?.();
    });
    expect(useStore.getState().hiddenStatusWidgets).toContain('usage.session');
    expect(host.querySelector('[data-status-widget="usage.session"]')).toBeNull();
    // The accounts' item stays.
    expect(host.querySelector('[data-status-widget="usage"]')).not.toBeNull();
  });
});
