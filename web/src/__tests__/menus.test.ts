// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import { insertSlot, near } from '../reorderDrag';
import { dragBegins, trackDrag } from '../drag';
import type { MachineState } from '../lib/machine';
import { FakeCore, settle } from './fakeTerms';
import { closeMenu, isItem, openMenu, stepIndex, tidy, useMenu, type MenuEntry, type MenuItem } from '../contextMenu';
import { machineMenu, paneMenu, sidebarMenu, tabMenu, workspaceMenu } from '../menus';
import { actions } from '../actions';
import { useKeys } from '../keybindings';
import { ContextMenu } from '../components/ContextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const box = (left: number, width: number) => ({ left, top: 10, width, height: 20 });

describe('insertSlot', () => {
  // Three tabs at 0-100, 100-200, 200-300.
  const boxes = [box(0, 100), box(100, 100), box(200, 100)];
  it('maps a position to the slot nearest to it', () => {
    expect(insertSlot(boxes, 2, 20, 20, 'x')?.index).toBe(0);
    expect(insertSlot(boxes, 2, 120, 20, 'x')?.index).toBe(1);
    expect(insertSlot(boxes, 0, 260, 20, 'x')?.index).toBe(3);
    expect(insertSlot(boxes, 0, 900, 20, 'x')?.index).toBe(3);
    expect(insertSlot(boxes, 2, -50, 20, 'x')?.index).toBe(0);
  });
  it('has no slot on either side of the dragged item', () => {
    expect(insertSlot(boxes, 1, 120, 20, 'x')).toBeUndefined();
    expect(insertSlot(boxes, 1, 180, 20, 'x')).toBeUndefined();
    expect(insertSlot(boxes, 0, 20, 20, 'x')).toBeUndefined();
    expect(insertSlot(boxes, 2, 260, 20, 'x')).toBeUndefined();
    expect(insertSlot([], 0, 5, 20, 'x')).toBeUndefined();
  });
  it('puts the bar on the boundary', () => {
    expect(insertSlot(boxes, 2, 120, 20, 'x')?.box).toEqual({ left: 99, top: 10, width: 2, height: 20 });
    expect(insertSlot(boxes, 0, 290, 20, 'x')?.box).toEqual({ left: 299, top: 10, width: 2, height: 20 });
    const rows = [
      { left: 0, top: 0, width: 200, height: 30 },
      { left: 0, top: 34, width: 200, height: 30 },
    ];
    expect(insertSlot(rows, 1, 100, 5, 'y')).toEqual({ index: 0, box: { left: 0, top: -1, width: 200, height: 2 } });
    expect(insertSlot(rows, 0, 100, 60, 'y')).toEqual({ index: 2, box: { left: 0, top: 63, width: 200, height: 2 } });
  });
  it('picks the row under the pointer when tabs wrap', () => {
    // Tabs 0-2 on a first row, 3-4 on a second.
    const at = (left: number, top: number) => ({ left, top, width: 100, height: 28 });
    const wrapped = [at(0, 0), at(100, 0), at(200, 0), at(0, 31), at(100, 31)];
    // Within the second row, indexes count the whole list.
    expect(insertSlot(wrapped, 0, 120, 40, 'x')).toEqual({ index: 4, box: { left: 99, top: 31, width: 2, height: 28 } });
    expect(insertSlot(wrapped, 0, 5, 40, 'x')).toEqual({ index: 3, box: { left: -1, top: 31, width: 2, height: 28 } });
    expect(insertSlot(wrapped, 0, 290, 40, 'x')).toEqual({ index: 5, box: { left: 199, top: 31, width: 2, height: 28 } });
    // The end of the first row is the same slot, drawn on that row.
    expect(insertSlot(wrapped, 4, 290, 10, 'x')).toEqual({ index: 3, box: { left: 299, top: 0, width: 2, height: 28 } });
    expect(insertSlot(wrapped, 2, 290, 10, 'x')).toBeUndefined();
    expect(insertSlot(wrapped, 2, 5, 40, 'x')).toBeUndefined();
    // Outside the rows, the nearest row counts.
    expect(insertSlot(wrapped, 0, 120, 300, 'x')?.index).toBe(4);
    expect(insertSlot(wrapped, 4, 120, -50, 'x')?.index).toBe(1);
  });
});

describe('drag start', () => {
  it('counts pointer movement on the screen, not in the page', () => {
    const at = { screenX: 100, screenY: 5 };
    expect(dragBegins(at, { screenX: 103, screenY: 8 })).toBe(false);
    expect(dragBegins(at, { screenX: 106, screenY: 5 })).toBe(true);
  });

  it('starts no drag when the page moves under a pointer standing still', () => {
    // macOS full screen: the menu bar slides down and moves the page.
    const find = vi.fn(() => 1);
    trackDrag(
      { clientX: 100, clientY: 5, screenX: 100, screenY: 5, pointerId: 1 },
      {
        label: 'tab',
        find,
        marker: () => ({ box: { left: 0, top: 0, width: 1, height: 1 }, zone: 'slot' }),
        drop: () => Promise.resolve(),
      },
    );
    const move = (clientY: number, screenY: number) =>
      window.dispatchEvent(Object.assign(new Event('pointermove'), { pointerId: 1, clientX: 100, clientY, screenX: 100, screenY }));
    move(-24, 5);
    expect(document.querySelector('.drag-ghost')).toBeNull();
    move(-24, 40);
    expect(document.querySelector('.drag-ghost')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.drag-ghost')).toBeNull();
  });
});

describe('near', () => {
  const list = (r: { left: number; top: number; width: number; height: number }) => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height }) as DOMRect;
    return el;
  };

  it('takes any position along a tab bar but only near a workspace list', () => {
    const tabs = list({ left: 100, top: 0, width: 300, height: 30 });
    expect(near(tabs, '.tab', 'data-tab-id', 900, 10, 'x')).toBeDefined();
    expect(near(tabs, '.tab', 'data-tab-id', 200, 80, 'x')).toBeUndefined();
    const ws = list({ left: 0, top: 100, width: 200, height: 100 });
    expect(near(ws, '.ws', 'data-ws-id', 50, 210, 'y')).toBeDefined();
    // Over the next machine's list.
    expect(near(ws, '.ws', 'data-ws-id', 50, 400, 'y')).toBeUndefined();
    expect(near(ws, '.ws', 'data-ws-id', 400, 150, 'y')).toBeUndefined();
  });
});

describe('menu entries', () => {
  const item = (label: string, disabled = false): MenuItem => ({ label, disabled, run: () => {} });
  it('drops stray separators', () => {
    const [a, b] = [item('a'), item('b')];
    expect(tidy(['sep', a, 'sep', 'sep', b, 'sep'])).toEqual([a, 'sep', b]);
    expect(tidy(['sep', 'sep'])).toEqual([]);
  });
  it('steps over separators and disabled items, wrapping around', () => {
    const e: MenuEntry[] = [item('a'), 'sep', item('b', true), item('c'), 'sep', item('d')];
    expect(stepIndex(e, -1, 1)).toBe(0);
    expect(stepIndex(e, 0, 1)).toBe(3);
    expect(stepIndex(e, 3, 1)).toBe(5);
    expect(stepIndex(e, 5, 1)).toBe(0);
    expect(stepIndex(e, 0, -1)).toBe(5);
    expect(stepIndex(e, e.length, -1)).toBe(5);
    expect(stepIndex([item('x', true), 'sep'], -1, 1)).toBe(-1);
  });
});

const layout = () => ({
  version: 2,
  workspaces: [
    {
      id: 'w1w1w1w1',
      name: 'one',
      cwd: '/src',
      tabs: [
        { root: { terminal: 'p1' }, focused: 'p1', name: 'a' },
        { root: { terminal: 'p2' }, focused: 'p2', name: 'b' },
        { root: { terminal: 'p3' }, focused: 'p3', name: 'd' },
      ],
      selected: 0,
    },
    { id: 'w2w2w2w2', name: 'two', cwd: '', tabs: [{ root: { terminal: 'p4' }, focused: 'p4' }], selected: 0 },
  ],
  selected: 0,
});

const labels = (e: MenuEntry[]) => e.filter(isItem).map((i) => i.label);
const find = (e: MenuEntry[], label: string) => e.filter(isItem).find((i) => i.label === label)!;

describe('menus', () => {
  let core: FakeCore;
  const tabNames = () => core.layout('m')!.workspaces[0].tabs.map((t) => t.name);
  beforeEach(async () => {
    core = new FakeCore();
    const term = (a: string, cwd: string) => FakeCore.term(a, { cwd });
    core.machine('m', [term('p1', '/src'), term('p2', '/src'), term('p3', '/src'), term('p4', '/tmp')], layout());
    core.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'm', label: 'm', kind: 'local', status: 'ready' } as unknown as MachineState]);
    s.selectMachine('m');
    core.model.subscribe('m');
    await settle();
  });

  it('has no items in read-only mode, so the browser menu shows', () => {
    useStore.getState().setReadOnly(true);
    expect(paneMenu('m', 'p1')).toEqual([]);
    expect(tabMenu('m', 'w1w1w1w1', 0)).toEqual([]);
    expect(workspaceMenu('m', 'w1w1w1w1')).toEqual([]);
    const ev = { clientX: 1, clientY: 1, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    openMenu(ev, tabMenu('m', 'w1w1w1w1', 0));
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(useMenu.getState().menu).toBeUndefined();
  });

  it('offers the pane commands, which act on that pane', async () => {
    expect(labels(paneMenu('m', 'p1'))).toEqual([
      'Rename pane',
      'Split right',
      'Split down',
      'Zoom',
      'Open folder in VS Code',
      'Changes of the repository',
      'Git Graph',
      'Close pane',
    ]);
    find(paneMenu('m', 'p1'), 'Zoom').run();
    expect(labels(paneMenu('m', 'p1'))).toContain('Restore');
    useStore.getState().setZoomed(undefined);
    find(paneMenu('m', 'p1'), 'Split down').run();
    await vi.waitFor(() => expect(core.calls.some((c) => c.method === 'terminal.run')).toBe(true));
    // The new terminal starts in the split one's folder and goes below it.
    expect(core.calls.find((c) => c.method === 'terminal.run')?.params).toEqual({ keep: false, cwd: '/src' });
    await settle();
    expect(core.layout('m')!.workspaces[0].tabs[0]).toMatchObject({
      root: { split: 'vertical', children: [{ terminal: 'p1' }, { terminal: 't1' }] },
      focused: 't1',
    });
  });

  it('moves tabs and shows key hints only for the current tab', async () => {
    // No default binding renames a tab; a user's does.
    expect(find(tabMenu('m', 'w1w1w1w1', 0), 'Rename tab').hint).toBeUndefined();
    const effective = useKeys.getState().effective;
    useKeys.setState({ effective: [...effective, { key: 'ctrl+k r', command: 'tab.rename', when: 'terminal' }] });
    const first = tabMenu('m', 'w1w1w1w1', 0);
    expect(find(first, 'Move left').disabled).toBe(true);
    expect(find(first, 'Move right').disabled).toBe(false);
    expect(find(first, 'Rename tab').hint).toBe('ctrl+k r');
    const last = tabMenu('m', 'w1w1w1w1', 2);
    expect(find(last, 'Move right').disabled).toBe(true);
    expect(find(last, 'Rename tab').hint).toBeUndefined();
    useKeys.setState({ effective });
    find(first, 'Move right').run();
    await settle();
    expect(tabNames()).toEqual(['b', 'a', 'd']);
    // The selection stays with its tab.
    expect(core.layout('m')!.workspaces[0].selected).toBe(1);
  });

  it('moves from where the item is when the menu item runs', async () => {
    const left = find(tabMenu('m', 'w1w1w1w1', 2), 'Move left');
    const down = find(workspaceMenu('m', 'w1w1w1w1'), 'Move down');
    // Another client moves "d" to the front and "one" to the end meanwhile.
    const l = layout();
    l.workspaces[0].tabs = [l.workspaces[0].tabs[2], l.workspaces[0].tabs[0], l.workspaces[0].tabs[1]];
    l.workspaces.reverse();
    const fm = core.machines.get('m')!;
    fm.layout = l;
    fm.version++;
    core.event('m', 'doc', '', { name: 'layout', version: fm.version });
    await settle();
    left.run();
    down.run();
    await settle();
    expect(core.layout('m')!.workspaces.map((w) => w.name)).toEqual(['two', 'one']);
    expect(core.layout('m')!.workspaces[1].tabs.map((t) => t.name)).toEqual(['d', 'a', 'b']);
  });

  it('moves workspaces', async () => {
    const w2 = workspaceMenu('m', 'w2w2w2w2');
    expect(find(w2, 'Move down').disabled).toBe(true);
    expect(find(w2, 'Close workspace').hint).toBeUndefined();
    // No default binding closes a workspace: the current one's item shows none either.
    expect(find(workspaceMenu('m', 'w1w1w1w1'), 'Close workspace').hint).toBeUndefined();
    find(w2, 'Move up').run();
    await settle();
    expect(core.layout('m')!.workspaces.map((w) => w.name)).toEqual(['two', 'one']);
  });

  it("creates a tab in its workspace's folder, else the focused terminal's", async () => {
    await actions.newTab('m', 'w2w2w2w2');
    expect(core.calls.filter((c) => c.method === 'terminal.run').pop()?.params).toEqual({ keep: false, cwd: '/tmp' });
    await actions.newTab('m', 'w1w1w1w1');
    expect(core.calls.filter((c) => c.method === 'terminal.run').pop()?.params).toEqual({ keep: false, cwd: '/src' });
    await settle();
    expect(core.layout('m')!.workspaces[0].tabs.length).toBe(4);
  });
});

describe('ContextMenu', () => {
  it('runs items from the keyboard and gives focus back', async () => {
    const host = document.createElement('div');
    const before = document.createElement('button');
    document.body.append(host, before);
    before.focus();
    const root = createRoot(host);
    await act(async () => root.render(createElement(ContextMenu)));

    const ran: string[] = [];
    const item = (label: string, disabled = false): MenuItem => ({ label, disabled, run: () => ran.push(label) });
    const ev = { clientX: 10, clientY: 10, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => openMenu(ev, [item('a'), 'sep', item('b', true), item('c')]));
    expect(ev.preventDefault).toHaveBeenCalled();
    const menu = () => host.querySelector<HTMLElement>('[role=menu]');
    expect(document.activeElement).toBe(menu());

    const key = (k: string) => act(async () => void menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    await key('ArrowDown');
    await key('ArrowDown');
    expect(host.querySelector('.context-item.sel')?.textContent).toBe('c');
    await key('Enter');
    expect(ran).toEqual(['c']);
    expect(outer).not.toHaveBeenCalled();
    window.removeEventListener('keydown', outer);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(before);

    await act(async () => openMenu(ev, [item('a')]));
    await key('Escape');
    expect(menu()).toBeNull();
    expect(ran).toEqual(['c']);

    // A click elsewhere closes it without stealing focus back.
    await act(async () => openMenu(ev, [item('a')]));
    await act(async () => void document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(useMenu.getState().menu).toBeUndefined();

    // So does scrolling a list, which scroll events reach without bubbling.
    await act(async () => openMenu(ev, [item('a')]));
    await act(async () => void before.dispatchEvent(new Event('scroll')));
    expect(useMenu.getState().menu).toBeUndefined();
    closeMenu(false);
    await act(async () => root.unmount());
  });
});

describe('machineMenu', () => {
  const labels = (entries: MenuEntry[]) => entries.map((e) => (isItem(e) ? e.label : '-'));
  const ssh = (status: string) => ({ id: 'gpu', label: 'gpu', kind: 'ssh', status }) as unknown as MachineState;

  it('disables a connected machine after asking, and enables a disabled one', async () => {
    const { useDialog } = await import('../dialog');
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      useStore.getState().setReadOnly(false);
      useStore.getState().setMachines([ssh('ready')]);
      const entries = machineMenu('gpu');
      expect(labels(entries)).toEqual([
        'Start terminal core',
        'Restart terminal core…',
        'Stop terminal core…',
        '-',
        'Disable machine',
        '-',
        'Rename machine',
        'Remove machine…',
        '-',
        'Add machine…',
      ]);
      (entries[4] as MenuItem).run();
      const req = useDialog.getState().current;
      expect(req?.kind).toBe('confirm');
      if (req?.kind !== 'confirm') throw new Error('no dialog');
      req.resolve(true);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock.mock.calls[0][0]).toBe('/api/m/gpu/enabled');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ enabled: false }) });

      // Enabling does not ask.
      fetchMock.mockClear();
      useDialog.setState({ current: undefined });
      useStore.getState().setMachines([ssh('disabled')]);
      const off = machineMenu('gpu');
      expect(labels(off)).toEqual(['Enable machine', '-', 'Rename machine', 'Remove machine…', '-', 'Add machine…']);
      (off[0] as MenuItem).run();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ body: JSON.stringify({ enabled: true }) });
      expect(useDialog.getState().current).toBeUndefined();

      // A machine whose stored target the core refuses is never connected:
      // rename and remove only.
      useStore.getState().setMachines([{ ...ssh('error'), code: 'invalid_target' }]);
      expect(labels(tidy(machineMenu('gpu')))).toEqual(['Rename machine', 'Remove machine…', '-', 'Add machine…']);

      useStore.getState().setReadOnly(true);
      expect(machineMenu('gpu')).toEqual([]);
    } finally {
      useStore.getState().setReadOnly(false);
      useDialog.setState({ current: undefined });
      vi.unstubAllGlobals();
    }
  });

  it('starts, restarts and stops the terminal core, asking before ending programs, one action at a time', async () => {
    const { useDialog } = await import('../dialog');
    let release: () => void = () => {};
    const fetchMock = vi.fn(
      (_url: string, _init?: RequestInit) =>
        new Promise<Response>((r) => {
          release = () => r(new Response('{}', { status: 200 }));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      useStore.getState().setReadOnly(false);
      useStore.getState().setMachines([ssh('ready')]);
      const start = find(machineMenu('gpu'), 'Start terminal core');
      expect(start.disabled).toBe(false);
      start.run();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0]).toEqual(['/api/m/gpu/hc/start', { method: 'POST' }]);
      // While it runs, the menu's actions are off and another does nothing.
      expect(find(machineMenu('gpu'), 'Restart terminal core…').disabled).toBe(true);
      release();
      await vi.waitFor(() => expect(useStore.getState().hcBusy.gpu).toBeUndefined());

      find(machineMenu('gpu'), 'Stop terminal core…').run();
      await vi.waitFor(() => expect(useDialog.getState().current?.kind).toBe('confirm'));
      const ask = useDialog.getState().current;
      if (ask?.kind !== 'confirm') throw new Error('no dialog');
      expect(ask.title).toBe('Stop the terminal core of gpu?');
      ask.resolve(false);
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      useDialog.setState({ current: undefined });

      find(machineMenu('gpu'), 'Restart terminal core…').run();
      await vi.waitFor(() => expect(useDialog.getState().current?.kind).toBe('confirm'));
      const again = useDialog.getState().current;
      if (again?.kind === 'confirm') again.resolve(true);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock.mock.calls[1][0]).toBe('/api/m/gpu/hc/restart');
      release();

      // Not connected: nothing to start there.
      useStore.getState().setMachines([ssh('error')]);
      expect(find(machineMenu('gpu'), 'Start terminal core').disabled).toBe(true);
    } finally {
      useDialog.setState({ current: undefined });
      vi.unstubAllGlobals();
    }
  });

  it('removes an SSH machine after asking, and reports why it could not', async () => {
    const { useDialog } = await import('../dialog');
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.spyOn(useStore.getState(), 'toast');
    try {
      useStore.getState().setReadOnly(false);
      const saved = (status: string) => ({ ...ssh(status), target: 'u@gpu' }) as unknown as MachineState;
      // The local machine keeps its name and stays.
      useStore.getState().setMachines([{ id: 'local', label: 'mac', kind: 'local', status: 'ready' } as unknown as MachineState]);
      expect(labels(machineMenu('local'))).not.toContain('Remove machine…');
      expect(labels(machineMenu('local'))).not.toContain('Rename machine');

      for (const status of ['ready', 'disabled']) {
        useStore.getState().setMachines([saved(status)]);
        expect(labels(machineMenu('gpu')).slice(-5)).toEqual(['-', 'Rename machine', 'Remove machine…', '-', 'Add machine…']);
      }
      const remove = machineMenu('gpu').find((e) => isItem(e) && e.label === 'Remove machine…') as MenuItem;
      expect(remove.danger).toBe(true);

      // Declining sends nothing.
      remove.run();
      let req = useDialog.getState().current;
      expect(req?.kind === 'confirm' && req.message).toContain('u@gpu');
      if (req?.kind === 'confirm') req.resolve(false);
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();

      useDialog.setState({ current: undefined });
      remove.run();
      req = useDialog.getState().current;
      if (req?.kind === 'confirm') req.resolve(true);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock.mock.calls[0][0]).toBe('/api/m/gpu');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
      await vi.waitFor(() => expect(toast).toHaveBeenLastCalledWith('Removed gpu.'));

      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'save', detail: 'read-only file system' }), { status: 500 }));
      useDialog.setState({ current: undefined });
      remove.run();
      req = useDialog.getState().current;
      if (req?.kind === 'confirm') req.resolve(true);
      await vi.waitFor(() =>
        expect(toast).toHaveBeenLastCalledWith('Could not remove gpu: the machines file could not be saved (read-only file system).'),
      );

      // Every code of the core is translated.
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unknown' }), { status: 404 }));
      useDialog.setState({ current: undefined });
      remove.run();
      req = useDialog.getState().current;
      if (req?.kind === 'confirm') req.resolve(true);
      await vi.waitFor(() => expect(toast).toHaveBeenLastCalledWith('Could not remove gpu: the machine is no longer there.'));
    } finally {
      toast.mockRestore();
      useDialog.setState({ current: undefined });
      vi.unstubAllGlobals();
    }
  });

  it("offers to add a machine in the sidebar's free space, except read-only", () => {
    useStore.getState().setReadOnly(false);
    const entries = sidebarMenu();
    expect(labels(entries)).toEqual(['Add machine…']);
    (entries[0] as MenuItem).run();
    expect(useStore.getState().addMachine).toBe(true);
    useStore.getState().openAddMachine(false);
    useStore.getState().setReadOnly(true);
    expect(sidebarMenu()).toEqual([]);
    useStore.getState().setReadOnly(false);
  });

  it('renames an SSH machine in place, and says why it could not', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.spyOn(useStore.getState(), 'toast');
    try {
      useStore.getState().setReadOnly(false);
      useStore.getState().setMachines([ssh('ready')]);
      (machineMenu('gpu').find((e) => isItem(e) && e.label === 'Rename machine') as MenuItem).run();
      expect(useStore.getState().renaming).toEqual({ kind: 'machine', m: 'gpu', id: 'gpu' });
      useStore.getState().setRenaming(undefined);

      // An unchanged or empty name sends nothing.
      await actions.renameMachine('gpu', 'gpu');
      await actions.renameMachine('gpu', '');
      expect(fetchMock).not.toHaveBeenCalled();
      await actions.renameMachine('gpu', 'GPU box');
      expect(fetchMock.mock.calls[0][0]).toBe('/api/m/gpu/label');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ label: 'GPU box' }) });

      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'label_taken' }), { status: 409 }));
      await actions.renameMachine('gpu', 'robot');
      expect(toast).toHaveBeenLastCalledWith('Could not rename gpu: another machine has this name.');
    } finally {
      toast.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('adds a machine, and opens the authentication terminal when it needs a login', async () => {
    const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => reply({ id: 'n1', status: 'connecting' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.spyOn(useStore.getState(), 'toast');
    try {
      useStore.getState().openAuth(undefined);
      expect(await actions.addMachine({ target: ' u@new ', label: ' New ' })).toBe(true);
      expect(fetchMock.mock.calls[0][0]).toBe('/api/machines');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ target: 'u@new', label: 'New' }) });
      expect(toast).toHaveBeenLastCalledWith('Added New.');
      const st = (status: string) => ({ id: 'n1', label: 'New', kind: 'ssh', status }) as unknown as MachineState;
      useStore.getState().setMachines([st('connecting')]);
      expect(useStore.getState().auth).toBeUndefined();
      useStore.getState().setMachines([st('auth_required')]);
      expect(useStore.getState().auth).toBe('n1');
      useStore.getState().openAuth(undefined);
      // Once handled, later states open nothing.
      useStore.getState().setMachines([st('ready')]);
      useStore.getState().setMachines([st('auth_required')]);
      expect(useStore.getState().auth).toBeUndefined();

      fetchMock.mockReturnValueOnce(reply({ error: 'machine_exists' }, 409));
      expect(await actions.addMachine({ target: 'u@new', label: '' })).toBe(false);
      expect(toast).toHaveBeenLastCalledWith('Could not add u@new: the machine is there already.');
    } finally {
      toast.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
