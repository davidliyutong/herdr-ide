// The page's model of the machines' terminals and layouts (state/terms.ts)
// against a scripted core: reading and writing the layout document, other
// clients' changes, programs ending, and terminals asked for early.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { FakeCore, settle } from './fakeTerms';
import { useTerms } from '../state/terms';
import { useStore } from '../state/store';
import { actions, attentionList } from '../actions';
import { terminalOnScreen } from '../seen';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';

const tab = (...terminals: string[]): L.Tab => ({
  root:
    terminals.length === 1
      ? { terminal: terminals[0] }
      : { split: 'horizontal', ratio: 0.5, children: [{ terminal: terminals[0] }, { terminal: terminals[1] }] },
  focused: terminals[0],
});

describe('TermModel', () => {
  it('forgets a removed machine entirely, its terminals and backend too', async () => {
    const core = new FakeCore();
    core.machine('m', [FakeCore.term('t1')], { version: 2, workspaces: [], selected: 0 });
    core.machine('gone', [FakeCore.term('t1')], { version: 2, workspaces: [], selected: 0 });
    const model = core.install();
    model.subscribe('m');
    model.subscribe('gone');
    await settle();
    expect(Object.keys(useTerms.getState().machines).sort()).toEqual(['gone', 'm']);
    model.forget('gone');
    expect(Object.keys(useTerms.getState().machines)).toEqual(['m']);
    expect(model.store.backends.has('gone')).toBe(false);
    expect(model.store.terminals('gone')).toEqual([]);
  });

  it('reads the layout after the terminals, with a first workspace where none was written, without ended terminals', async () => {
    const core = new FakeCore();
    core.machine('m', [FakeCore.term('t1')]);
    // Every workspace of this one was closed: it stays without one.
    core.machine('e', [], { version: 2, workspaces: [], selected: 0 });
    core.machine('n', [FakeCore.term('a'), FakeCore.term('b')], {
      version: 2,
      workspaces: [{ id: 'xxxxxxxx', name: 'x', cwd: '', tabs: [tab('a', 'gone'), tab('b')], selected: 1 }],
      selected: 0,
    });
    const model = core.install();
    model.subscribe('m');
    model.subscribe('n');
    model.subscribe('e');
    await settle();
    expect(useTerms.getState().connected).toBe(true);
    expect(useTerms.getState().machines.e.layout?.workspaces).toEqual([]);
    // A pane opened there makes its workspace.
    model.mutate('e', (l) => L.openTerminal(l, 't9'));
    expect(model.layout('e')?.workspaces.map((w) => L.workspaceTerminals(w))).toEqual([['t9']]);
    const m = useTerms.getState().machines.m;
    expect(m.backend?.phase).toBe('ready');
    expect(Object.keys(m.terminals)).toEqual(['t1']);
    expect(m.layout?.workspaces.map((w) => w.name)).toEqual(['']);
    // Both changes are written back.
    expect(core.layout('m')?.workspaces).toHaveLength(1);
    expect(core.layout('n')?.workspaces[0].tabs.map((x) => L.tabTerminals(x))).toEqual([['a'], ['b']]);
  });

  it('writes one change at a time, and takes another client’s newer layout', async () => {
    const core = new FakeCore();
    core.machine('m', [FakeCore.term('a'), FakeCore.term('b')], {
      version: 2,
      workspaces: [{ id: 'xxxxxxxx', name: 'x', cwd: '', tabs: [tab('a'), tab('b')], selected: 0 }],
      selected: 0,
    });
    const model = core.install();
    model.subscribe('m');
    await settle();
    const sets = () => core.calls.filter((c) => c.method === 'doc.set').length;
    model.mutate('m', (l) => L.renameWorkspace(l, 'xxxxxxxx', 'one'));
    model.mutate('m', (l) => L.selectTab(l, 'xxxxxxxx', 1));
    await settle();
    expect(core.layout('m')).toMatchObject({ workspaces: [{ name: 'one', selected: 1 }] });
    expect(sets()).toBe(2);
    // Another client writes: its version is read.
    const fm = core.machines.get('m')!;
    fm.layout = { ...(fm.layout as L.Layout), workspaces: [{ ...(fm.layout as L.Layout).workspaces[0], name: 'theirs' }] };
    fm.version++;
    core.event('m', 'doc', '', { name: 'layout', version: fm.version });
    await settle();
    expect(model.layout('m')?.workspaces[0].name).toBe('theirs');
    // A write on a stale version is refused: theirs wins, read again.
    fm.version++;
    model.mutate('m', (l) => L.renameWorkspace(l, 'xxxxxxxx', 'mine'));
    await settle();
    expect(model.layout('m')?.workspaces[0].name).toBe('theirs');
  });

  it('closes the pane of a program that ended and removes its terminal', async () => {
    const core = new FakeCore();
    core.machine('m', [FakeCore.term('a'), FakeCore.term('b')], {
      version: 2,
      workspaces: [{ id: 'xxxxxxxx', name: 'x', cwd: '', tabs: [tab('a', 'b')], selected: 0 }],
      selected: 0,
    });
    const model = core.install();
    model.subscribe('m');
    await settle();
    core.event('m', 'finished', 'a', { reason: 'exited', exit_code: 0 });
    await settle();
    expect(model.layout('m')?.workspaces[0].tabs[0].root).toEqual({ terminal: 'b' });
    expect(core.calls.find((c) => c.method === 'terminal.rm')?.params).toEqual({ terminal: 'a' });
  });

  it('runs a terminal asked for before the machine was ready, once it is', async () => {
    const core = new FakeCore();
    core.machine('m', [], { version: 2, workspaces: [{ id: 'xxxxxxxx', name: 'x', cwd: '/srv', tabs: [], selected: 0 }], selected: 0 });
    const model = core.install();
    useStore.getState().setMachines([{ id: 'm', label: 'm', kind: 'local', status: 'ready' } as unknown as MachineState]);
    useStore.getState().selectMachine('m');
    const opened = actions.newTab('m');
    await settle();
    await opened;
    expect(model.isSubscribed('m')).toBe(true);
    expect(core.calls.find((c) => c.method === 'terminal.run')?.params).toEqual({ keep: true, cwd: '/srv', display: expect.any(Object) });
    expect(model.layout('m')?.workspaces[0].tabs.map((x) => x.focused)).toEqual(['t1']);
    expect(terminalOnScreen('m', 't1')).toBe(true);
    expect(terminalOnScreen('m', 'other')).toBe(false);
  });

  it('opens a tab of a workspace in the home directory where the focused terminal is', async () => {
    const core = new FakeCore();
    core.machine('m', [FakeCore.term('a', { foreground: { name: 'zsh', cwd: '/home/u/proj' } })], {
      version: 2,
      workspaces: [{ id: 'xxxxxxxx', name: '', cwd: '/home/u/', tabs: [tab('a')], selected: 0 }],
      selected: 0,
    });
    const model = core.install();
    useStore
      .getState()
      .setMachines([{ id: 'm', label: 'm', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
    model.subscribe('m');
    await settle();
    await actions.newTab('m', 'xxxxxxxx');
    expect(core.calls.filter((c) => c.method === 'terminal.run').pop()?.params).toEqual({
      keep: true,
      cwd: '/home/u/proj',
      display: expect.any(Object),
    });
  });

  it('lists agents by how much they need the user', async () => {
    const core = new FakeCore();
    core.machine('m', [
      FakeCore.term('w', { agent: 'codex', agent_status: 'working' }),
      FakeCore.term('d', { agent: 'claude', agent_status: 'done' }),
      FakeCore.term('b', { agent: 'claude', agent_status: 'blocked' }),
      FakeCore.term('s'),
      FakeCore.term('r', { status: { state: 'working' } }),
    ]);
    const model = core.install();
    useStore.getState().setMachines([{ id: 'm', label: 'm', kind: 'local', status: 'ready' } as unknown as MachineState]);
    model.subscribe('m');
    await settle();
    expect(attentionList().map((i) => [i.terminal, i.status])).toEqual([
      ['b', 'blocked'],
      ['d', 'done'],
      ['r', 'working'],
      ['w', 'working'],
    ]);
  });
});
