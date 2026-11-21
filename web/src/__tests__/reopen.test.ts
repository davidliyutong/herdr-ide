// @vitest-environment jsdom
// Closing with a way back (pane.undoClose) and going back and forward
// through the panes focused (pane.back, pane.forward).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { FakeCore, settle } from './fakeTerms';
import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { actions } from '../actions';
import { commandEnabled, runCommand } from '../keymap';
import '../commands';
import { resetClosed } from '../closedPanes';
import { useDialog } from '../dialog';
import { canGo, go, noteFocus, resetHistory } from '../paneHistory';
import * as L from '../term/layout';

const t = (terminal: string, extra = {}) => ({ terminal, ...extra });
const split = (axis: L.Axis, ratio: number, a: L.Node, b: L.Node): L.Split => ({ split: axis, ratio, children: [a, b] });
const layoutWith = (...tabs: L.Tab[]): L.Layout => ({
  version: 2,
  workspaces: [{ id: 'wwwwwwww', name: 'w', cwd: '', tabs, selected: 0 }],
  selected: 0,
});

describe('layout.reopen', () => {
  const root = split('horizontal', 0.3, t('t1'), split('vertical', 0.7, t('t2', { name: 'logs' }), t('t3')));
  const tab: L.Tab = { root, focused: 't2' };
  const closed: L.Closed = { ws: 'wwwwwwww', index: 0, tab, closed: ['t2'] };

  it('puts a pane back where it was, with the splits’ shares, in a tab unchanged since', () => {
    const after = L.closePane(layoutWith(tab), 't2');
    const back = L.reopen(after, closed, new Map([['t2', t('t9', { name: 'logs' })]]));
    expect(back.workspaces[0].tabs[0]).toEqual({
      root: split('horizontal', 0.3, t('t1'), split('vertical', 0.7, t('t9', { name: 'logs' }), t('t3'))),
      focused: 't9',
    });
  });

  it('splits a pane in beside its neighbor of then in a tab that changed', () => {
    let after = L.closePane(layoutWith(tab), 't2');
    after = L.splitPane(after, 't1', 'vertical', t('t4'));
    const back = L.reopen(after, closed, new Map([['t2', t('t9')]]));
    const r = back.workspaces[0].tabs[0].root;
    expect(L.panesOf(r)).toEqual(['t1', 't4', 't9', 't3']);
    // Above t3, as it was.
    expect(L.isSplit(r) && r.children[1]).toEqual(split('vertical', 0.5, t('t9'), t('t3')));
    expect(back.workspaces[0].tabs[0].focused).toBe('t9');
  });

  it('brings a closed tab back at its place, pane by pane', () => {
    const other: L.Tab = { root: t('t5'), focused: 't5' };
    const code = { code: { id: 'c1', folder: '/srv' } };
    const named: L.Tab = { name: 'build', root: split('horizontal', 0.6, t('t1'), code), focused: 'code:c1' };
    const all: L.Closed = { ws: 'wwwwwwww', index: 0, tab: named, closed: ['t1', 'code:c1'] };
    const after = L.closeTab(layoutWith(named, other), 'wwwwwwww', 0);
    const one = L.reopen(after, all, new Map([['t1', t('t7')]]));
    expect(one.workspaces[0].tabs.map((x) => x.root)).toEqual([t('t7'), t('t5')]);
    const both = L.reopen(
      one,
      all,
      new Map<string, L.Leaf>([
        ['t1', t('t7')],
        ['code:c1', code],
      ]),
    );
    expect(both.workspaces[0].tabs[0]).toEqual({ name: 'build', root: split('horizontal', 0.6, t('t7'), code), focused: 'code:c1' });
    expect(both.workspaces[0].selected).toBe(0);
  });

  it('puts a closed workspace back at its place, empty, for its tabs to follow', () => {
    const one: L.Workspace = { id: 'aaaaaaaa', name: 'one', cwd: '/srv', tabs: [{ root: t('t1'), focused: 't1' }], selected: 0 };
    const two: L.Workspace = { id: 'bbbbbbbb', name: 'two', cwd: '', tabs: [], selected: 0, extra: 1 };
    const three: L.Workspace = { ...one, id: 'cccccccc', name: 'three' };
    const after = L.closeWorkspace({ version: 2, workspaces: [one, two, three], selected: 2 }, 'bbbbbbbb');
    const back = L.restoreWorkspace(after, two, 1);
    expect(back.workspaces.map((w) => w.name)).toEqual(['one', 'two', 'three']);
    expect(back.workspaces[1]).toEqual({ ...two, tabs: [] });
    expect(back.selected).toBe(1);
    // Past the end: at the end; one there already: as it is.
    expect(L.restoreWorkspace(after, two, 9).workspaces.map((w) => w.name)).toEqual(['one', 'three', 'two']);
    expect(L.restoreWorkspace(back, { ...two, name: 'again' }, 0)).toBe(back);
    // The blank one a layout got when its last workspace closed goes.
    const blank: L.Workspace = { id: 'dddddddd', name: '', cwd: '', tabs: [], selected: 0 };
    const alone = L.restoreWorkspace({ version: 2, workspaces: [blank], selected: 0 }, one, 0, ['aaaaaaaa']);
    expect(alone.workspaces.map((w) => w.id)).toEqual(['aaaaaaaa']);
    // One that was there when it closed stays.
    const known = L.restoreWorkspace({ version: 2, workspaces: [blank], selected: 0 }, one, 0, ['aaaaaaaa', 'dddddddd']);
    expect(known.workspaces.map((w) => w.id)).toEqual(['aaaaaaaa', 'dddddddd']);
  });

  it('brings a tab of a workspace that is gone to the selected one', () => {
    const all: L.Closed = { ws: 'gone', index: 3, tab: { root: t('t1'), focused: 't1' }, closed: ['t1'] };
    const back = L.reopen(layoutWith({ root: t('t5'), focused: 't5' }), all, new Map([['t1', t('t8')]]));
    expect(back.workspaces[0].tabs.map((x) => x.root)).toEqual([t('t5'), t('t8')]);
    expect(back.workspaces[0].selected).toBe(1);
  });
});

describe('closing with a way back, and going back, with a terminal core', () => {
  let core: FakeCore;
  const running = (address: string, cwd: string, extra = {}) =>
    FakeCore.term(address, { pid: 10, cwd, foreground: { pid: 20, name: 'vim', argv: ['vim'], cwd }, ...extra });
  const tabs = () => core.layout('m')!.workspaces[0].tabs;

  const setup = async (extra: ReturnType<typeof running>[] = []) => {
    resetClosed(300);
    resetHistory();
    core = new FakeCore();
    core.machine('m', [running('t1', '/srv/a'), running('t2', '/srv/b'), ...extra], {
      version: 2,
      workspaces: [
        {
          id: 'wwwwwwww',
          name: 'w',
          cwd: '',
          tabs: [{ root: { split: 'horizontal', ratio: 0.3, children: [{ terminal: 't1' }, { terminal: 't2' }] }, focused: 't2' }],
          selected: 0,
        },
      ],
      selected: 0,
    });
    core.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.upsertMachine({ id: 'm', label: 'm', kind: 'local', status: 'ready' } as unknown as MachineState);
    s.selectMachine('m');
    core.model.subscribe('m');
    await settle();
  };
  beforeEach(() => setup());
  afterEach(() => {
    resetClosed();
    document.body.innerHTML = '';
  });

  const killed = () => core.calls.filter((c) => c.method === 'terminal.kill').map((c) => c.params.terminal);
  const closing = (a: string) =>
    core.calls
      .filter((c) => c.method === 'terminal.label' && c.params.terminal === a)
      .map((c) => (c.params.labels as Record<string, string>).closing);

  it('closes a pane at once, its program running until the time to undo is over', async () => {
    await actions.closePane('m', 't2');
    await settle();
    expect(useDialog.getState().current).toBeUndefined();
    expect(tabs()[0].root).toEqual({ terminal: 't1' });
    expect(killed()).toEqual([]);
    expect(Number(closing('t2')[0])).toBeGreaterThan(Date.now());
    await vi.waitFor(() => expect(killed()).toEqual(['t2']), { timeout: 2000 });
  });

  it('puts a closed pane back as it was, with the same terminal, which then keeps running', async () => {
    await actions.closePane('m', 't2');
    await settle();
    expect(commandEnabled('pane.undoClose')).toBe(true);
    runCommand('pane.undoClose');
    await settle();
    expect(tabs()[0]).toEqual({
      root: { split: 'horizontal', ratio: 0.3, children: [{ terminal: 't1' }, { terminal: 't2' }] },
      focused: 't2',
    });
    expect(closing('t2').at(-1)).toBe('');
    expect(commandEnabled('pane.undoClose')).toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    expect(killed()).toEqual([]);
  });

  it('puts a closed tab back with its terminals; nothing to undo once the time is over', async () => {
    await actions.closeTab('m', 'wwwwwwww', 0);
    await settle();
    expect(tabs()).toEqual([]);
    actions.undoClose();
    await settle();
    expect(L.panesOf(tabs()[0].root as L.Node)).toEqual(['t1', 't2']);
    await actions.closeTab('m', 'wwwwwwww', 0);
    await vi.waitFor(() => expect(killed().sort()).toEqual(['t1', 't2']), { timeout: 2000 });
    expect(commandEnabled('pane.undoClose')).toBe(false);
  });

  it('closes a workspace at once and puts it back with its tabs and terminals', async () => {
    // A second tab, shown, in the workspace.
    await setup([running('t3', '/srv/c')]);
    core.model.mutate('m', (l) => L.openTerminal(l, 't3', 'wwwwwwww'));
    await settle();
    const before = core.layout('m')!;
    const terminals = L.workspaceTerminals(before.workspaces[0]);
    expect(terminals).toHaveLength(3);
    await actions.closeWorkspace('m', 'wwwwwwww');
    await settle();
    expect(useDialog.getState().current).toBeUndefined();
    // The machine's last workspace closes as any other: none is left.
    expect(core.layout('m')!.workspaces).toEqual([]);
    expect(killed()).toEqual([]);
    for (const a of terminals) expect(Number(closing(a)[0])).toBeGreaterThan(Date.now());
    expect(commandEnabled('pane.undoClose')).toBe(true);
    runCommand('pane.undoClose');
    await settle();
    const back = core.layout('m')!;
    expect(back.workspaces).toEqual(before.workspaces);
    for (const a of terminals) expect(closing(a).at(-1)).toBe('');
    await new Promise((r) => setTimeout(r, 500));
    expect(killed()).toEqual([]);
    // Once the time is over, its terminals end.
    await actions.closeWorkspace('m', 'wwwwwwww');
    await vi.waitFor(() => expect(killed().sort()).toEqual([...terminals].sort()), { timeout: 2000 });
    expect(commandEnabled('pane.undoClose')).toBe(false);
  });

  it('ends a terminal another page closed when its time is over, also without that page', async () => {
    // t3 has no pane: a page closed it and is gone.
    await setup([running('t3', '/srv/c', { labels: { closing: String(Date.now() + 100) } })]);
    expect(killed()).toEqual([]);
    await vi.waitFor(() => expect(killed()).toEqual(['t3']), { timeout: 2000 });
  });

  it('goes back and forward through the panes focused, past those closed', async () => {
    const focused = () => L.focusedPane(core.model.layout('m')!);
    expect(commandEnabled('pane.back')).toBe(false);
    noteFocus({ m: 'm', pane: 't2' });
    actions.focusPane('m', 't1');
    noteFocus({ m: 'm', pane: 't1' });
    expect(commandEnabled('pane.back')).toBe(true);
    runCommand('pane.back');
    expect(focused()).toBe('t2');
    expect(commandEnabled('pane.forward')).toBe(true);
    runCommand('pane.forward');
    expect(focused()).toBe('t1');
    expect(commandEnabled('pane.forward')).toBe(false);
  });
});

describe('paneHistory', () => {
  beforeEach(resetHistory);
  const open =
    (gone: string[] = []) =>
    (s: { pane: string }) =>
      !gone.includes(s.pane);

  it('keeps the panes focused as a browser keeps pages', () => {
    for (const pane of ['a', 'b', 'c']) noteFocus({ m: 'm', pane });
    noteFocus({ m: 'm', pane: 'c' });
    expect(go(-1, open())?.pane).toBe('b');
    // Arriving there is not a new step.
    noteFocus({ m: 'm', pane: 'b' });
    expect(go(-1, open())?.pane).toBe('a');
    expect(go(-1, open())).toBeUndefined();
    expect(go(1, open())?.pane).toBe('b');
    // A pane focused otherwise drops what lay ahead.
    noteFocus({ m: 'n', pane: 'd' });
    expect(canGo(1, open())).toBe(false);
    expect(go(-1, open(['b']))?.pane).toBe('a');
  });

  it('passes over a closed pane and the one beside it that took the focus', () => {
    for (const pane of ['a', 'b', 'c']) noteFocus({ m: 'm', pane });
    // c closes and b, beside it, has the focus again.
    noteFocus({ m: 'm', pane: 'b' });
    const left = open(['c']);
    // Back is a, not c (gone) and not b (where the user is).
    expect(go(-1, left)?.pane).toBe('a');
    noteFocus({ m: 'm', pane: 'a' });
    expect(canGo(-1, left)).toBe(false);
    expect(go(1, left)?.pane).toBe('b');
    noteFocus({ m: 'm', pane: 'b' });
    // Ahead are only c and b itself.
    expect(canGo(1, left)).toBe(false);
  });
});
