// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { api: () => Promise.resolve({}), setTheme: () => {} } }));

import { currentDock, currentLastCode, dockKey, useStore } from '../state/store';
import type { MachineState } from '../lib/herdr';
import { Dock, FRAME_TTL, MAX_HIDDEN_FRAMES, frameKey, nextFrames, type Frame } from '../components/Dock';
import { sendTarget } from '../lib/bridge';
import { actions } from '../actions';
import { storage } from '../brand';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function machine(id: string, workspaces: string[], status = 'ready'): MachineState {
  return {
    id,
    label: id,
    status,
    info: { home: '/home/u' },
    snapshot: {
      workspaces: workspaces.map((ws, i) => ({ workspace_id: ws, number: i + 1, label: ws, active_tab_id: `${ws}-t` })),
      tabs: workspaces.map((ws, i) => ({ tab_id: `${ws}-t`, workspace_id: ws, number: i + 1, label: 't' })),
      panes: workspaces.flatMap((ws) => [
        { pane_id: `${ws}-shell`, workspace_id: ws, tab_id: `${ws}-t`, cwd: `/home/u/${ws}` },
        { pane_id: `${ws}-agent`, workspace_id: ws, tab_id: `${ws}-t`, cwd: `/home/u/${ws}`, agent: 'claude', agent_status: 'idle' },
      ]),
    },
  } as unknown as MachineState;
}

const dock = () => currentDock(useStore.getState());

beforeEach(() => {
  useStore.setState({ docks: {}, machineId: undefined, workspaceId: undefined, focused: undefined, readOnly: false });
  useStore.getState().setMachines([machine('a', ['w1', 'w2']), machine('b', ['w3'])]);
  useStore.getState().selectWorkspace('a', 'w1');
});

describe('the dock of a workspace', () => {
  it('belongs to the workspace: switching workspace switches the panel and the one toggled back', () => {
    const s = useStore.getState();
    s.openDock({ kind: 'code', m: 'a', folder: '/home/u/w1/' });
    expect(dock()).toEqual({ kind: 'code', m: 'a', folder: '/home/u/w1' });
    s.selectWorkspace('a', 'w2');
    expect(dock()).toBeUndefined();
    s.openDock({ kind: 'preview', m: 'a', path: '/home/u/w2/a.png' });
    s.selectWorkspace('b', 'w3');
    s.openDock({ kind: 'code', m: 'b', folder: '/srv' });
    s.selectWorkspace('a', 'w1');
    expect(dock()).toEqual({ kind: 'code', m: 'a', folder: '/home/u/w1' });
    s.selectWorkspace('a', 'w2');
    expect(dock()).toEqual({ kind: 'preview', m: 'a', path: '/home/u/w2/a.png' });
    expect(currentLastCode(useStore.getState())).toBeUndefined();
    // cmd+j brings back this workspace's own last VS Code panel.
    s.selectWorkspace('b', 'w3');
    s.focusPane({ m: 'b', pane: 'w3-shell' });
    actions.toggleCode();
    expect(dock()).toBeUndefined();
    s.selectWorkspace('a', 'w1');
    expect(dock()?.kind).toBe('code');
    s.selectWorkspace('b', 'w3');
    actions.toggleCode();
    expect(dock()).toEqual({ kind: 'code', m: 'b', folder: '/srv' });
  });

  it('is kept per browser, without the dock of no workspace', () => {
    const s = useStore.getState();
    s.openDock({ kind: 'code', m: 'a', folder: '/x' });
    useStore.setState({ machineId: undefined, workspaceId: undefined });
    s.openDock({ kind: 'preview', m: 'a', path: '/y.png' });
    expect(JSON.parse(storage.get('docks')!)).toEqual({
      'a|w1': { m: 'a', ws: 'w1', view: { kind: 'code', m: 'a', folder: '/x' }, lastCode: { kind: 'code', m: 'a', folder: '/x' } },
    });
  });

  it('is restored after a reload, dropping what is malformed', async () => {
    storage.set(
      'docks',
      JSON.stringify({
        'a|w1': { m: 'a', ws: 'w1', view: { kind: 'code', m: 'a', folder: '/x' } },
        'a|w2': { m: 'a', ws: 'w9', view: { kind: 'code', m: 'a' } },
        'b|w3': { m: 'b', ws: 'w3', view: { kind: 'shell', m: 'b' } },
      }),
    );
    vi.resetModules();
    const fresh = await import('../state/store');
    expect(Object.keys(fresh.useStore.getState().docks)).toEqual(['a|w1']);
    storage.set('docks', '{}');
  });

  it('goes with its workspace or machine', () => {
    const s = useStore.getState();
    s.openDock({ kind: 'code', m: 'a', folder: '/x' });
    s.selectWorkspace('a', 'w2');
    s.openDock({ kind: 'code', m: 'a', folder: '/y' });
    s.selectWorkspace('b', 'w3');
    s.openDock({ kind: 'code', m: 'b', folder: '/z' });
    // w2 was closed in herdr.
    s.upsertMachine(machine('a', ['w1']));
    expect(Object.keys(useStore.getState().docks).sort()).toEqual(['a|w1', 'b|w3']);
    // A machine without a snapshot (reconnecting) keeps its workspaces' docks.
    s.upsertMachine({ ...machine('a', []), snapshot: undefined } as MachineState);
    expect(Object.keys(useStore.getState().docks).sort()).toEqual(['a|w1', 'b|w3']);
    // b is removed from herdr's machines.
    s.setMachines([machine('a', ['w1'])]);
    expect(Object.keys(useStore.getState().docks)).toEqual(['a|w1']);
  });

  it("closes every workspace's VS Code of a machine whose code-server stops, keeping the last one for cmd+j", () => {
    const s = useStore.getState();
    s.openDock({ kind: 'code', m: 'a', folder: '/x' });
    s.selectWorkspace('a', 'w2');
    s.openDock({ kind: 'code', m: 'a', folder: '/y' });
    s.selectWorkspace('b', 'w3');
    s.openDock({ kind: 'code', m: 'b', folder: '/z' });
    s.closeCode('a');
    const d = useStore.getState().docks;
    expect(d['a|w1'].view).toBeUndefined();
    expect(d['a|w2'].lastCode).toEqual({ kind: 'code', m: 'a', folder: '/y' });
    expect(d['b|w3'].view).toEqual({ kind: 'code', m: 'b', folder: '/z' });
  });

  it('shows no VS Code in read-only mode', () => {
    const s = useStore.getState();
    s.openDock({ kind: 'code', m: 'a', folder: '/x' });
    s.setReadOnly(true);
    expect(dock()).toBeUndefined();
    s.openDock({ kind: 'preview', m: 'a', path: '/x/a.png' });
    expect(dock()?.kind).toBe('preview');
    s.setReadOnly(false);
  });
});

describe('VS Code windows in the dock', () => {
  const none = new Set<string>();
  const code = (m: string, folder?: string) => ({ kind: 'code' as const, m, folder });

  it('are one per machine and folder, shared by workspaces, hidden when not shown', () => {
    let f = nextFrames({}, code('a', '/x'), none, 1000);
    expect(f).toEqual({ 'a|/x': { m: 'a', folder: '/x' } });
    f = nextFrames(f, code('a', '/x/'), none, 2000);
    expect(f).toEqual({ 'a|/x': { m: 'a', folder: '/x' } });
    f = nextFrames(f, code('a', '/y'), none, 3000);
    expect(f).toEqual({ 'a|/x': { m: 'a', folder: '/x', hidden: 3000 }, 'a|/y': { m: 'a', folder: '/y' } });
    f = nextFrames(f, undefined, none, 4000);
    expect(f['a|/y'].hidden).toBe(4000);
    expect(f['a|/x'].hidden).toBe(3000);
    f = nextFrames(f, code('a', '/x'), none, 5000);
    expect(f['a|/x'].hidden).toBeUndefined();
    // The order stays, or the iframes would move and reload.
    expect(Object.keys(f)).toEqual(['a|/x', 'a|/y']);
  });

  it('go when hidden too long, beyond the most recent few, or when their machine is disabled', () => {
    let f: Record<string, Frame> = {};
    for (let i = 0; i <= MAX_HIDDEN_FRAMES + 1; i++) f = nextFrames(f, code('a', `/${i}`), none, i * 1000);
    expect(Object.keys(f).sort()).toEqual([2, 3, 4, 1].map((i) => frameKey('a', `/${i}`)).sort());
    // /2 was hidden at 3000.
    f = nextFrames(f, code('b', '/z'), none, FRAME_TTL + 3500);
    expect(Object.keys(f)).toEqual(['a|/3', 'a|/4', 'b|/z']);
    f = nextFrames(f, code('a', '/4'), new Set(['b']), FRAME_TTL + 3600);
    expect(Object.keys(f)).toEqual(['a|/3', 'a|/4']);
    expect(nextFrames(f, code('a', '/4'), new Set(['a']), FRAME_TTL + 3600)).toEqual({});
  });
});

describe('Dock', () => {
  let host: HTMLDivElement;
  let root: Root;
  const frames = () => [...host.querySelectorAll('iframe')].map((x) => [x.getAttribute('src'), x.style.display]);

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps each workspace's VS Code window and shows the selected workspace's", async () => {
    const s = useStore.getState();
    await act(async () => root.render(createElement(Dock)));
    expect(host.querySelector('.dock')).toBeNull();
    await act(async () => s.openDock({ kind: 'code', m: 'a', folder: '/x' }));
    await act(async () => s.selectWorkspace('b', 'w3'));
    await act(async () => s.openDock({ kind: 'code', m: 'b', folder: '/z' }));
    expect(frames()).toEqual([
      ['/m/a/code/?folder=%2Fx', 'none'],
      ['/m/b/code/?folder=%2Fz', ''],
    ]);
    await act(async () => s.selectWorkspace('a', 'w1'));
    expect(frames()).toEqual([
      ['/m/a/code/?folder=%2Fx', ''],
      ['/m/b/code/?folder=%2Fz', 'none'],
    ]);
    // Another workspace with the same folder shares the window.
    await act(async () => s.selectWorkspace('a', 'w2'));
    expect((host.querySelector('.dock') as HTMLElement).style.display).toBe('none');
    await act(async () => s.openDock({ kind: 'code', m: 'a', folder: '/x' }));
    expect(frames()).toHaveLength(2);
    // A disabled machine's window goes; the panel says why.
    await act(async () => s.upsertMachine(machine('a', ['w1', 'w2'], 'disabled')));
    expect(frames()).toEqual([['/m/b/code/?folder=%2Fz', 'none']]);
    expect(host.querySelector('.dock-body')?.textContent).toContain('a is disabled');
  });
});

describe('Send to agent', () => {
  it('goes to the workspace whose panel shows the sending window', () => {
    const s = useStore.getState();
    s.openDock({ kind: 'code', m: 'a', folder: '/home/u/w1' });
    s.focusPane({ m: 'a', pane: 'w1-shell' });
    const st = () => useStore.getState();
    // The selected workspace shows it: the focused pane.
    expect(sendTarget(st(), 'a', ['/home/u/w1'])).toBe('w1-shell');
    // Another workspace shows it: that workspace's agent.
    s.selectWorkspace('a', 'w2');
    s.focusPane({ m: 'a', pane: 'w2-shell' });
    expect(sendTarget(st(), 'a', ['/home/u/w1'])).toBe('w1-agent');
    // No panel shows it, or the window is unknown: the focused pane.
    expect(sendTarget(st(), 'a', ['/elsewhere'])).toBe('w2-shell');
    expect(sendTarget(st(), 'a')).toBe('w2-shell');
    // Nothing focused on that machine: its first attention-worthy agent.
    s.focusPane(undefined);
    expect(sendTarget(st(), 'a', ['/elsewhere'])).toBe('w1-agent');
    expect(dockKey(st())).toBe('a|w2');
  });
});
