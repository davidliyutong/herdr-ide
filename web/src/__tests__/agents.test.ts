// @vitest-environment jsdom
//
// How the agents plugin shows a terminal's pane (plugins/agents/view.ts):
// what its surface covers for each state of the leaf, the agent and the
// session's transcript; where on its terminal's screen a waiting agent's
// question is; the switch between the conversation and the
// terminal, written into the layout and refused on a read-only page; the
// new agent tab's program and leaf; and find in a terminal the
// conversation covers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { FakeCore, settle } from './fakeTerms';
import { allPlugins, definePlugins, newTabGroups } from '../plugins/registry';
import { agentsPlugin } from '../plugins/agents';
import { agentTabKinds, agentView, covers, newSessionId, rowsUnder, toggleView, waitingView } from '../plugins/agents/view';
import { resetFeeds, useFeeds, feedKey, type FeedState } from '../plugins/agents/transcript';
import { commandEnabled, runCommand } from '../keymap';
import { commands } from '../commands';
import { setCover, useCovers } from '../state/covers';
import { registerPane } from '../state/panes';
import { useSettings } from '../settings';

const SESSION = '0f0e0d0c-0b0a-4908-8706-050403020100';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let core: FakeCore;
const saved = [...allPlugins()];

/** Machine a: t1 runs Claude Code (its session found), t2 a shell, t3
 * Gemini CLI (no native view), t4 Codex before its first prompt; each in
 * a tab of its own, t1's shown and focused. */
async function setup(o: { t1?: Partial<L.TerminalLeaf>; record?: Record<string, unknown>; readOnly?: boolean } = {}) {
  core = new FakeCore();
  core.machine(
    'a',
    [
      FakeCore.term('t1', { agent: 'claude', agent_status: 'idle', agent_session: SESSION, agent_session_source: 'pid', ...o.record }),
      FakeCore.term('t2'),
      FakeCore.term('t3', { agent: 'gemini', agent_status: 'idle' }),
      FakeCore.term('t4', { agent: 'codex', agent_status: 'idle' }),
    ],
    {
      version: 2,
      workspaces: [
        {
          id: 'w1',
          name: '',
          cwd: '/home/u',
          tabs: [
            { root: { terminal: 't1', ...o.t1 }, focused: 't1' },
            { root: { terminal: 't2', render: 'native' }, focused: 't2' },
            { root: { terminal: 't3', render: 'native' }, focused: 't3' },
            { root: { terminal: 't4', render: 'native' }, focused: 't4' },
          ],
          selected: 0,
        },
      ],
      selected: 0,
    },
  );
  // New terminals get addresses no terminal of the machine has.
  core.next = 10;
  core.install();
  const s = useStore.getState();
  s.setReadOnly(!!o.readOnly);
  s.setMachines([{ id: 'a', label: 'Box', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  s.selectMachine('a');
  core.model.subscribe('a');
  await settle();
}

const leafOf = (terminal: string) => L.findLeaf(core.model.layout('a')!, terminal) as L.TerminalLeaf;
const savedLeaf = (terminal: string) => L.findLeaf(core.layout('a')!, terminal) as L.TerminalLeaf;
const feed = (session: string, state: FeedState, kind = 'claude') =>
  useFeeds.setState((s) => ({ status: { ...s.status, [feedKey('a', kind, session)]: { state } } }));
const focus = (pane: string) => core.model.mutate('a', (l) => L.focusPane(l, pane));

beforeEach(() => {
  vi.stubGlobal('fetch', () => new Promise(() => {}));
  useSettings.setState({ values: {} });
  definePlugins([agentsPlugin]);
  resetFeeds();
});
afterEach(() => {
  resetFeeds();
  useCovers.setState({ covers: {} });
  definePlugins(saved);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('what the surface covers', () => {
  it('follows the leaf, the agent and what was read of its session', async () => {
    await setup({ t1: { render: 'native' } });
    // A shell, an agent without a native view, Codex without a session yet: the terminal.
    expect(covers('a', 't2', leafOf('t2'))).toBeUndefined();
    expect(covers('a', 't3', leafOf('t3'))).toBeUndefined();
    expect(covers('a', 't4', leafOf('t4'))).toBeUndefined();
    // A session not read yet: the conversation's place, from the first frame.
    expect(covers('a', 't1', leafOf('t1'))).toBe('all');
    feed(SESSION, 'ok');
    expect(covers('a', 't1', leafOf('t1'))).toBe('all');
    // Nothing to show: the terminal, a strip over its top.
    for (const state of ['not_found', 'compressed', 'error', 'bad'] as const) {
      feed(SESSION, state);
      expect(covers('a', 't1', leafOf('t1')), state).toBeUndefined();
    }
    // The CLI view.
    feed(SESSION, 'ok');
    expect(covers('a', 't1', { terminal: 't1' })).toBeUndefined();
  });

  it('is nothing while the agent waits for the user: the surface says the upper part as it draws it', async () => {
    await setup({ t1: { render: 'native' }, record: { agent_status: 'blocked', status: { state: 'blocked', msg: 'approve Write: /x' } } });
    expect(covers('a', 't1', leafOf('t1'))).toBeUndefined();
    expect(agentView(leafOf('t1'), core.model.terminal('a', 't1'), () => undefined)).toMatchObject({ mode: 'strip', reason: 'loading' });
    feed(SESSION, 'ok');
    expect(agentView(leafOf('t1'), core.model.terminal('a', 't1'), () => ({ state: 'ok' }))).toMatchObject({ mode: 'peek' });
    expect(covers('a', 't1', leafOf('t1'))).toBeUndefined();
  });

  it('shows the machine’s session, else the one the leaf remembers', async () => {
    await setup({ t1: { render: 'native', session: OTHER }, record: { agent_session: null } });
    expect(agentView(leafOf('t1'), core.model.terminal('a', 't1'), () => undefined)).toMatchObject({ mode: 'loading', session: OTHER });
    core.event('a', 'agent', 't1', { agent_session: SESSION, agent_session_source: 'pid' });
    await settle();
    expect(agentView(leafOf('t1'), core.model.terminal('a', 't1'), () => undefined)).toMatchObject({ session: SESSION });
    // A terminal whose program ended is shown as the terminal.
    const leaf = leafOf('t1');
    core.event('a', 'finished', 't1', {});
    await settle();
    expect(covers('a', 't1', leaf)).toBeUndefined();
  });
});

describe('where a waiting agent’s question is', () => {
  /** A screen of rows, those of lines with text in them. */
  const screen = (rows: number, lines: Record<number, string>) => Array.from({ length: rows }, (_, i) => lines[i] ?? '').join('\n');

  it('takes the rows a box over the terminal covers from where its edge is drawn', () => {
    // 25 rows in 400 pixels are 15.4 to 16 pixels high: rows 0 to 9 begin
    // above 152 pixels, row 10 below.
    expect(rowsUnder(25, 400, 152)).toEqual({ covered: 10, shown: 10 });
    // Row 10 begins between 153.8 and 160 pixels: the edge may cross it,
    // and it counts in neither part.
    expect(rowsUnder(25, 400, 160)).toEqual({ covered: 10, shown: 11 });
    // Over none of it, over all of it.
    expect(rowsUnder(25, 400, 0)).toEqual({ covered: 0, shown: 0 });
    expect(rowsUnder(25, 400, 500)).toEqual({ covered: 25, shown: 25 });
    // Not drawn, not known.
    expect(rowsUnder(25, 0, 0)).toBeUndefined();
    expect(rowsUnder(25, 400, NaN)).toBeUndefined();
    expect(rowsUnder(0, 400, 152)).toBeUndefined();
  });

  it('shows the terminal whole when all it shows is under the upper part, or it cannot be read', () => {
    // A dialog at the bottom (Claude Code): the upper part over the terminal.
    expect(waitingView(screen(25, { 0: '> fix it', 20: '╭ Allow Write? ╮', 21: '│ 1. Yes      │', 24: '╰─────────────╯' }), 400, 152)).toBe(
      'peek',
    );
    // At the top of a cleared screen (Codex): the terminal whole.
    expect(waitingView(screen(25, { 1: '  Update available!', 3: '› 1. Update now', 4: '  2. Skip' }), 400, 152)).toBe('under');
    // Reaching below the part: what shows there is the user's to see.
    expect(waitingView(screen(25, { 1: '  Review hooks', 12: '  3. Trust all' }), 400, 152)).toBe('peek');
    // In the row the edge crosses only: under it.
    expect(waitingView(screen(25, { 1: 'Update?', 10: '  2. Skip' }), 400, 160)).toBe('under');
    // Nothing on screen: nothing to hide.
    expect(waitingView(screen(25, {}), 400, 152)).toBe('peek');
    expect(waitingView(screen(25, { 2: '   ' }), 400, 152)).toBe('peek');
    // Not read, or not where it is drawn.
    expect(waitingView(undefined, 400, 152)).toBe('unread');
    expect(waitingView(screen(25, { 1: 'Update?' }), 0, 0)).toBe('unread');
  });
});

describe('the switch', () => {
  it('writes the leaf for every client, both ways', async () => {
    await setup();
    expect(commandEnabled('agents.toggleView')).toBe(true);
    runCommand('agents.toggleView');
    await settle();
    expect(savedLeaf('t1').render).toBe('native');
    expect(toggleView('a', 't1')).toBe(true);
    await settle();
    expect(savedLeaf('t1')).not.toHaveProperty('render');
  });

  it('is offered for terminals that run an agent with a native view only', async () => {
    await setup();
    focus('t2');
    expect(commandEnabled('agents.toggleView')).toBe(false);
    focus('t3');
    expect(commandEnabled('agents.toggleView')).toBe(false);
    // Before its session is known too.
    focus('t4');
    expect(commandEnabled('agents.toggleView')).toBe(true);
  });

  it('is refused on a read-only page', async () => {
    await setup({ readOnly: true });
    expect(commandEnabled('agents.toggleView')).toBe(false);
    expect(toggleView('a', 't1')).toBe(false);
    runCommand('agents.toggleView');
    await settle();
    expect(savedLeaf('t1')).not.toHaveProperty('render');
    expect(leafOf('t1')).not.toHaveProperty('render');
  });

  it('is no command while the plugin is off', async () => {
    await setup();
    useSettings.setState({ values: { 'plugins.agents.enabled': { value: false, source: 'global' } } as never });
    expect(commandEnabled('agents.toggleView')).toBe(false);
    expect(newTabGroups('a')).toEqual([]);
  });
});

describe('a new agent tab', () => {
  it('is offered for each kind with a native view', async () => {
    await setup();
    expect(agentTabKinds()).toEqual(['claude', 'codex']);
    const [items] = newTabGroups('a');
    expect(items.map((i) => [i.id, i.title])).toEqual([
      ['agents.claude', 'agents.newTab.claude'],
      ['agents.codex', 'agents.newTab.codex'],
    ]);
  });

  it('starts Claude Code with a new session id that its leaf remembers, shown as its conversation', async () => {
    await setup();
    const [items] = newTabGroups('a');
    await items[0].run('a', 'w1');
    await settle();
    const run = core.calls.find((c) => c.method === 'terminal.run')!;
    const argv = run.params.argv as string[];
    expect(argv.slice(0, 2)).toEqual(['claude', '--session-id']);
    expect(argv[2]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(argv).toHaveLength(3);
    const ws = core.layout('a')!.workspaces[0];
    expect(ws.tabs).toHaveLength(5);
    expect(ws.selected).toBe(4);
    expect(ws.tabs[4].root).toEqual({ terminal: 't10', render: 'native', session: argv[2] });
  });

  it('starts Codex without one', async () => {
    await setup();
    const [items] = newTabGroups('a');
    await items[1].run('a', 'w1');
    await settle();
    expect(core.calls.find((c) => c.method === 'terminal.run')!.params.argv).toEqual(['codex']);
    expect(core.layout('a')!.workspaces[0].tabs[4].root).toEqual({ terminal: 't10', render: 'native' });
  });

  it('is the first kind’s for its command, which a read-only page cannot run', async () => {
    await setup();
    expect(commandEnabled('agents.newTab')).toBe(true);
    runCommand('agents.newTab');
    await settle();
    await settle();
    expect((core.calls.find((c) => c.method === 'terminal.run')!.params.argv as string[])[0]).toBe('claude');
    useStore.getState().setReadOnly(true);
    expect(commandEnabled('agents.newTab')).toBe(false);
  });

  it('makes session ids without crypto.randomUUID too', () => {
    const real = crypto.randomUUID;
    try {
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
      const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
      expect(ids.size).toBe(50);
      for (const id of ids) expect(L.isSessionId(id)).toBe(true);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: real });
    }
  });
});

describe('find in a terminal the conversation covers', () => {
  function terminal() {
    const openFind = vi.fn();
    const off = registerPane('a', 't1', { focus: () => {}, type: () => {}, paste: () => {}, openFind, screenText: () => '' });
    return { openFind, off };
  }

  it('shows the terminal first, then opens find in it', async () => {
    await setup({ t1: { render: 'native' } });
    setCover('a', 't1', 'all', 'agents');
    const t = terminal();
    vi.useFakeTimers();
    commands['find.open'].run();
    expect(leafOf('t1').render).toBeUndefined();
    expect(t.openFind).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.openFind).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await settle();
    expect(savedLeaf('t1')).not.toHaveProperty('render');
    t.off();
  });

  it('opens find at once in a terminal shown', async () => {
    await setup({ t1: { render: 'native' } });
    const t = terminal();
    // Native, but nothing covers it (no conversation to show yet).
    commands['find.open'].run();
    expect(t.openFind).toHaveBeenCalledTimes(1);
    expect(leafOf('t1').render).toBe('native');
    t.off();
  });

  it('cannot on a read-only page', async () => {
    await setup({ t1: { render: 'native' }, readOnly: true });
    setCover('a', 't1', 'all', 'agents');
    expect(commands['find.open'].enabled!()).toBe(false);
    setCover('a', 't1', undefined, 'agents');
    expect(commands['find.open'].enabled!()).toBe(true);
  });
});
