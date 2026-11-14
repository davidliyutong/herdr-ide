// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

const api = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve({}));
vi.mock('../lib/conn', () => ({ conn: { api: (...a: unknown[]) => api(...a), setTheme: () => {} } }));

import { useStore } from '../state/store';
import { insertSlot, near } from '../reorderDrag';
import { dragBegins, trackDrag } from '../drag';
import { withOrder, workspaceTabs, type MachineState } from '../lib/herdr';
import { closeMenu, isItem, openMenu, stepIndex, tidy, useMenu, type MenuEntry, type MenuItem } from '../contextMenu';
import { machineMenu, paneMenu, sidebarMenu, tabMenu, workspaceMenu } from '../menus';
import { actions } from '../actions';
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

describe('withOrder', () => {
  const id = (x: { id: string }) => x.id;
  const items = [{ id: 'a1' }, { id: 'b1' }, { id: 'a2' }, { id: 'a3' }];
  it('puts a group in its new order where the group was', () => {
    const fresh = [{ id: 'a3', v: 1 }, { id: 'a1' }, { id: 'a2' }];
    expect(withOrder(items, id, fresh)).toEqual([{ id: 'a3', v: 1 }, { id: 'b1' }, { id: 'a1' }, { id: 'a2' }]);
  });
  it('leaves the list alone when the group is not in it', () => {
    expect(withOrder(items, id, [{ id: 'a2' }, { id: 'a1' }])).toEqual([{ id: 'a2' }, { id: 'b1' }, { id: 'a1' }, { id: 'a3' }]);
    expect(withOrder(items, id, [{ id: 'a1' }, { id: 'a2' }, { id: 'zz' }])).toBe(items);
    expect(withOrder(items, id, [{ id: 'a1' }, { id: 'a1' }, { id: 'a2' }])).toBe(items);
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

// Tab numbers are not positions in herdr: the order is the snapshot's.
function machine(): MachineState {
  return {
    id: 'm',
    label: 'm',
    status: 'ready',
    snapshot: {
      workspaces: [
        { workspace_id: 'w1', number: 1, label: 'one', active_tab_id: 't1' },
        { workspace_id: 'w2', number: 2, label: 'two', active_tab_id: 'u1' },
      ],
      tabs: [
        { tab_id: 't1', workspace_id: 'w1', number: 1, label: 'a' },
        { tab_id: 'tA', workspace_id: 'w1', number: 10, label: 'b' },
        { tab_id: 'u1', workspace_id: 'w2', number: 1, label: 'c' },
        { tab_id: 't2', workspace_id: 'w1', number: 2, label: 'd' },
      ],
      panes: [{ pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', cwd: '/src' }],
    },
  } as unknown as MachineState;
}

const labels = (e: MenuEntry[]) => e.filter(isItem).map((i) => i.label);
const find = (e: MenuEntry[], label: string) => e.filter(isItem).find((i) => i.label === label)!;
const tabIds = () => workspaceTabs(useStore.getState().machines.m.snapshot!, 'w1').map((t) => t.tab_id);

describe('menus', () => {
  beforeEach(() => {
    api.mockReset();
    api.mockImplementation(() => Promise.resolve({}));
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([machine()]);
    s.selectWorkspace('m', 'w1');
    s.selectTab('m', 'w1', 't1');
  });

  it('has no items in read-only mode, so the browser menu shows', () => {
    useStore.getState().setReadOnly(true);
    expect(paneMenu('m', 'p1', false)).toEqual([]);
    expect(tabMenu('m', 'w1', 't1')).toEqual([]);
    expect(workspaceMenu('m', 'w1')).toEqual([]);
    const ev = { clientX: 1, clientY: 1, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    openMenu(ev, tabMenu('m', 'w1', 't1'));
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(useMenu.getState().menu).toBeUndefined();
  });

  it('offers the pane commands', () => {
    expect(labels(paneMenu('m', 'p1', false))).toEqual([
      'Rename pane',
      'Split right',
      'Split down',
      'Zoom',
      'Open folder in VS Code',
      'Changes of the repository',
      'Git Graph',
      'Close pane',
    ]);
    expect(labels(paneMenu('m', 'p1', true))).toContain('Restore');
    find(paneMenu('m', 'p1', false), 'Split down').run();
    expect(api).toHaveBeenCalledWith('m', 'pane.split', { target_pane_id: 'p1', direction: 'down', cwd: '/src', focus: false });
  });

  it('moves tabs by slot and shows key hints only for the current tab', async () => {
    const first = tabMenu('m', 'w1', 't1');
    expect(find(first, 'Move left').disabled).toBe(true);
    expect(find(first, 'Move right').disabled).toBe(false);
    expect(find(first, 'Rename tab').hint).toBeTruthy();
    const last = tabMenu('m', 'w1', 't2');
    expect(find(last, 'Move right').disabled).toBe(true);
    expect(find(last, 'Rename tab').hint).toBeUndefined();

    // herdr answers with the workspace's tabs in their new order.
    api.mockImplementation(() =>
      Promise.resolve({
        type: 'tab_list',
        tabs: [
          { tab_id: 'tA', workspace_id: 'w1', number: 10, label: 'b' },
          { tab_id: 't1', workspace_id: 'w1', number: 1, label: 'a' },
          { tab_id: 't2', workspace_id: 'w1', number: 2, label: 'd' },
        ],
      }),
    );
    find(first, 'Move right').run();
    expect(api).toHaveBeenCalledWith('m', 'tab.move', { tab_id: 't1', insert_index: 2 });
    await vi.waitFor(() => expect(tabIds()).toEqual(['tA', 't1', 't2']));
    find(tabMenu('m', 'w1', 't2'), 'Move left').run();
    expect(api).toHaveBeenLastCalledWith('m', 'tab.move', { tab_id: 't2', insert_index: 1 });
  });

  it('moves from where the item is when the menu item runs', () => {
    const left = find(tabMenu('m', 'w1', 't2'), 'Move left');
    const down = find(workspaceMenu('m', 'w1'), 'Move down');
    // Another client moves t2 to the front and w1 to the end meanwhile.
    const m = machine();
    const snap = m.snapshot!;
    snap.tabs = [snap.tabs[3], snap.tabs[0], snap.tabs[1], snap.tabs[2]];
    snap.workspaces = [snap.workspaces[1], snap.workspaces[0]];
    useStore.getState().setMachines([m]);
    left.run();
    down.run();
    expect(api).not.toHaveBeenCalled();
    find(tabMenu('m', 'w1', 't1'), 'Move left').run();
    expect(api).toHaveBeenLastCalledWith('m', 'tab.move', { tab_id: 't1', insert_index: 0 });
  });

  it('moves workspaces and reports failures', async () => {
    const w2 = workspaceMenu('m', 'w2');
    expect(find(w2, 'Move down').disabled).toBe(true);
    expect(find(w2, 'Close workspace').hint).toBeUndefined();
    expect(find(workspaceMenu('m', 'w1'), 'Close workspace').hint).toBeTruthy();
    api.mockImplementation(() => Promise.reject(new Error('workspace_move_failed: nope')));
    find(w2, 'Move up').run();
    expect(api).toHaveBeenCalledWith('m', 'workspace.move', { workspace_id: 'w2', insert_index: 0 });
    await vi.waitFor(() =>
      expect(useStore.getState().toasts.map((t) => t.msg)).toContain('Could not move the workspace: workspace_move_failed: nope'),
    );
  });

  it('creates a tab with the cwd of the focused pane only in its workspace', async () => {
    useStore.getState().focusPane({ m: 'm', pane: 'p1' });
    await actions.newTab('m', 'w2');
    expect(api).toHaveBeenLastCalledWith('m', 'tab.create', { workspace_id: 'w2', cwd: undefined, focus: false });
    await actions.newTab('m', 'w1');
    expect(api).toHaveBeenLastCalledWith('m', 'tab.create', { workspace_id: 'w1', cwd: '/src', focus: false });
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
        'Restart herdr…',
        'Stop herdr…',
        'Update herdr…',
        '-',
        'Disable machine',
        '-',
        'Add machine…',
        'Reload machines from herdr',
      ]);
      // The dialog offers to stop the machine's herdr too, checked; unchecked
      // only the machine is disabled.
      (entries[4] as MenuItem).run();
      const req = useDialog.getState().current;
      expect(req?.kind).toBe('confirm');
      if (req?.kind !== 'confirm') throw new Error('no dialog');
      expect(req.check).toBe(
        'Also stop herdr on gpu: its terminals close and the programs in them end. Unchecked, panes keep running there.',
      );
      expect(req.checked).toBe(true);
      req.resolve(true, false);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock.mock.calls[0][0]).toBe('/api/m/gpu/enabled');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ enabled: false }) });

      // Checked, herdr is stopped first, while the agent can still do it.
      fetchMock.mockClear();
      useDialog.setState({ current: undefined });
      (machineMenu('gpu')[4] as MenuItem).run();
      const stop = useDialog.getState().current;
      if (stop?.kind === 'confirm') stop.resolve(true, true);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/m/gpu/herdr/stop', '/api/m/gpu/enabled']);

      // Without a connected agent there is nothing to stop, and no checkbox.
      fetchMock.mockClear();
      useDialog.setState({ current: undefined });
      useStore.getState().setMachines([ssh('error')]);
      (machineMenu('gpu')[4] as MenuItem).run();
      const plain = useDialog.getState().current;
      expect(plain?.kind === 'confirm' && plain.check).toBeFalsy();
      if (plain?.kind === 'confirm') plain.resolve(true);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0][0]).toBe('/api/m/gpu/enabled');

      // Enabling does not ask.
      fetchMock.mockClear();
      useDialog.setState({ current: undefined });
      useStore.getState().setMachines([ssh('disabled')]);
      const off = machineMenu('gpu');
      expect(labels(off)).toEqual(['Enable machine', '-', 'Add machine…', 'Reload machines from herdr']);
      (off[0] as MenuItem).run();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ body: JSON.stringify({ enabled: true }) });
      expect(useDialog.getState().current).toBeUndefined();

      useStore.getState().setReadOnly(true);
      expect(machineMenu('gpu')).toEqual([]);
    } finally {
      useStore.getState().setReadOnly(false);
      useDialog.setState({ current: undefined });
      vi.unstubAllGlobals();
    }
  });

  it('restarts herdr on a connected machine after asking', async () => {
    const { useDialog } = await import('../dialog');
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ managed: false, running: true }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.spyOn(useStore.getState(), 'toast');
    try {
      useStore.getState().setReadOnly(false);
      useStore.getState().setMachines([ssh('degraded')]);
      const restart = machineMenu('gpu')[0] as MenuItem;
      expect(restart.disabled).toBe(false);
      restart.run();
      const req = useDialog.getState().current;
      expect(req?.kind).toBe('confirm');
      if (req?.kind === 'confirm') req.resolve(true);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock.mock.calls[0][0]).toBe('/api/m/gpu/herdr/restart');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
      await vi.waitFor(() => expect(toast).toHaveBeenLastCalledWith('herdr restarted on gpu.'));

      // A failure names the machine and herdr's output.
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ managed: false, running: false, error: 'start_failed', output: 'no tty' }), { status: 200 }),
      );
      useDialog.setState({ current: undefined });
      (machineMenu('gpu')[0] as MenuItem).run();
      const again = useDialog.getState().current;
      if (again?.kind === 'confirm') again.resolve(true);
      await vi.waitFor(() => expect(toast).toHaveBeenLastCalledWith('Could not restart herdr on gpu: The server did not start. no tty'));

      // Declining sends nothing; without the agent there is nothing to ask.
      useDialog.setState({ current: undefined });
      (machineMenu('gpu')[0] as MenuItem).run();
      const no = useDialog.getState().current;
      if (no?.kind === 'confirm') no.resolve(false);
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      useStore.getState().setMachines([ssh('error')]);
      const entries = machineMenu('gpu') as MenuItem[];
      expect(entries[0].disabled).toBe(true);
      expect(entries[1].disabled).toBe(true);
    } finally {
      toast.mockRestore();
      useDialog.setState({ current: undefined });
      vi.unstubAllGlobals();
    }
  });

  it('offers to install herdr where it was removed', () => {
    useStore.getState().setReadOnly(false);
    const gone = (status: string) => ({ ...ssh(status), info: { os: 'linux' } }) as unknown as MachineState;
    for (const status of ['degraded', 'ready']) {
      useStore.getState().setMachines([gone(status)]);
      const entries = machineMenu('gpu');
      expect(labels(entries)).toEqual([
        'Restart herdr…',
        'Stop herdr…',
        'Install herdr…',
        '-',
        'Disable machine',
        '-',
        'Add machine…',
        'Reload machines from herdr',
      ]);
      // Without herdr there, a restart or stop would do nothing.
      expect((entries[0] as MenuItem).disabled).toBe(true);
      expect((entries[1] as MenuItem).disabled).toBe(true);
      (entries[2] as MenuItem).run();
      expect(useStore.getState().remoteHerdr).toBe('gpu');
      useStore.getState().openRemoteHerdr(undefined);
    }
    useStore.getState().setMachines([{ ...ssh('ready'), info: { os: 'linux', herdr_bin: '/usr/bin/herdr' } } as unknown as MachineState]);
    expect(labels(machineMenu('gpu'))[2]).toBe('Update herdr…');
  });

  it('stops herdr on a connected machine after asking', async () => {
    const { useDialog } = await import('../dialog');
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ managed: false, running: false }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.spyOn(useStore.getState(), 'toast');
    try {
      useStore.getState().setReadOnly(false);
      useStore.getState().setMachines([ssh('ready')]);
      (machineMenu('gpu')[1] as MenuItem).run();
      const req = useDialog.getState().current;
      expect(req?.kind === 'confirm' && req.title).toBe('Stop herdr on gpu?');
      if (req?.kind === 'confirm') req.resolve(true);
      await vi.waitFor(() => expect(toast).toHaveBeenLastCalledWith('herdr stopped on gpu.'));
      expect(fetchMock.mock.calls[0][0]).toBe('/api/m/gpu/herdr/stop');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    } finally {
      toast.mockRestore();
      useDialog.setState({ current: undefined });
      vi.unstubAllGlobals();
    }
  });

  it("updates the application's herdr on the local machine after a check", async () => {
    const { useDialog } = await import('../dialog');
    const local = { id: 'local', label: 'local', kind: 'local', status: 'ready' } as unknown as MachineState;
    let reply: Record<string, unknown> = {};
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify(reply), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.spyOn(useStore.getState(), 'toast');
    try {
      useStore.getState().setReadOnly(false);
      useStore.getState().setMachines([local]);
      const update = () => (machineMenu('local').find((e) => isItem(e) && e.label === 'Update herdr…') as MenuItem).run();

      // Up to date, or the user's own installation: only a toast.
      reply = { managed: true, running: true, version: '0.9.5', latest: '0.9.5' };
      update();
      await vi.waitFor(() => expect(toast).toHaveBeenLastCalledWith('herdr 0.9.5 is up to date.'));
      reply = { managed: false, running: true, version: '0.9.5', latest: '0.9.6' };
      update();
      await vi.waitFor(() =>
        expect(toast).toHaveBeenLastCalledWith('This herdr is your own installation; update it the way you installed it.'),
      );
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/m/local/herdr/check', '/api/m/local/herdr/check']);

      // A newer release for the managed copy is installed after asking.
      fetchMock.mockClear();
      reply = { managed: true, running: true, version: '0.9.5', latest: '0.9.6' };
      update();
      await vi.waitFor(() => expect(useDialog.getState().current?.kind).toBe('confirm'));
      const req = useDialog.getState().current;
      expect(req?.kind === 'confirm' && req.title).toBe('Update herdr to 0.9.6?');
      reply = { managed: true, running: true, version: '0.9.6', restart_needed: true };
      if (req?.kind === 'confirm') req.resolve(true);
      await vi.waitFor(() => expect(toast).toHaveBeenLastCalledWith('herdr 0.9.6 is installed. Restart herdr to use it.'));
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/m/local/herdr/check', '/api/m/local/herdr/update']);
    } finally {
      toast.mockRestore();
      useDialog.setState({ current: undefined });
      vi.unstubAllGlobals();
    }
  });

  it('removes a saved machine after asking, with herdr, and reports why it could not', async () => {
    const { useDialog } = await import('../dialog');
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.spyOn(useStore.getState(), 'toast');
    try {
      useStore.getState().setReadOnly(false);
      const saved = (status: string) => ({ ...ssh(status), saved: true, target: 'u@gpu' }) as unknown as MachineState;
      // Machines given with --ssh and the local machine are not herdr's.
      useStore
        .getState()
        .setMachines([ssh('ready'), { id: 'local', label: 'mac', kind: 'local', status: 'ready' } as unknown as MachineState]);
      for (const id of ['gpu', 'local']) {
        expect(labels(machineMenu(id))).not.toContain('Remove machine…');
        expect(labels(machineMenu(id))).not.toContain('Rename machine');
      }

      for (const status of ['ready', 'disabled']) {
        useStore.getState().setMachines([saved(status)]);
        expect(labels(machineMenu('gpu')).slice(-6)).toEqual([
          '-',
          'Rename machine',
          'Remove machine…',
          '-',
          'Add machine…',
          'Reload machines from herdr',
        ]);
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

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'herdr', detail: 'machine profile was not found' }), { status: 502 }),
      );
      useDialog.setState({ current: undefined });
      remove.run();
      req = useDialog.getState().current;
      if (req?.kind === 'confirm') req.resolve(true);
      await vi.waitFor(() => expect(toast).toHaveBeenLastCalledWith('Could not remove gpu: machine profile was not found'));
    } finally {
      toast.mockRestore();
      useDialog.setState({ current: undefined });
      vi.unstubAllGlobals();
    }
  });

  it("offers to add a machine and to reload them in the sidebar's free space, except read-only", () => {
    useStore.getState().setReadOnly(false);
    const entries = sidebarMenu();
    expect(labels(entries)).toEqual(['Add machine…', 'Reload machines from herdr']);
    (entries[0] as MenuItem).run();
    expect(useStore.getState().addMachine).toBe(true);
    useStore.getState().openAddMachine(false);
    useStore.getState().setReadOnly(true);
    expect(sidebarMenu()).toEqual([]);
    useStore.getState().setReadOnly(false);
  });

  it('renames a saved machine in place with herdr, and says why it could not', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.spyOn(useStore.getState(), 'toast');
    try {
      useStore.getState().setReadOnly(false);
      useStore.getState().setMachines([{ ...ssh('ready'), saved: true } as unknown as MachineState]);
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
      expect(toast).toHaveBeenLastCalledWith('Could not rename gpu: another saved machine has this name.');
    } finally {
      toast.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('reloads the machines and says what changed', async () => {
    const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => reply({ added: null, removed: null, updated: null }));
    vi.stubGlobal('fetch', fetchMock);
    const toast = vi.spyOn(useStore.getState(), 'toast');
    try {
      await actions.refreshMachines();
      expect(fetchMock.mock.calls[0][0]).toBe('/api/machines/refresh');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
      expect(toast).toHaveBeenLastCalledWith('herdr’s machines are unchanged.');
      fetchMock.mockReturnValueOnce(reply({ added: ['a'], removed: null, updated: ['b', 'c'] }));
      await actions.refreshMachines();
      expect(toast).toHaveBeenLastCalledWith('Reloaded herdr’s machines: 1 added, 0 removed, 2 changed.');
      fetchMock.mockReturnValueOnce(reply({ error: 'catalog', detail: 'bad json' }, 502));
      await actions.refreshMachines();
      expect(toast).toHaveBeenLastCalledWith('Could not reload herdr’s machines: bad json');
    } finally {
      toast.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
