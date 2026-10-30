// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

const api = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve({}));
vi.mock('../lib/conn', () => ({ conn: { api: (...a: unknown[]) => api(...a), setTheme: () => {} } }));

import { useStore } from '../state/store';
import { insertSlot, near } from '../reorderDrag';
import { withOrder, workspaceTabs, type MachineState } from '../lib/herdr';
import { closeMenu, isItem, openMenu, stepIndex, tidy, useMenu, type MenuEntry, type MenuItem } from '../contextMenu';
import { paneMenu, tabMenu, workspaceMenu } from '../menus';
import { actions } from '../actions';
import { ContextMenu } from '../components/ContextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const box = (left: number, width: number) => ({ left, top: 10, width, height: 20 });

describe('insertSlot', () => {
  // Three tabs at 0-100, 100-200, 200-300.
  const boxes = [box(0, 100), box(100, 100), box(200, 100)];
  it('maps a position to the slot nearest to it', () => {
    expect(insertSlot(boxes, 2, 20, 'x')?.index).toBe(0);
    expect(insertSlot(boxes, 2, 120, 'x')?.index).toBe(1);
    expect(insertSlot(boxes, 0, 260, 'x')?.index).toBe(3);
    expect(insertSlot(boxes, 0, 900, 'x')?.index).toBe(3);
    expect(insertSlot(boxes, 2, -50, 'x')?.index).toBe(0);
  });
  it('has no slot on either side of the dragged item', () => {
    expect(insertSlot(boxes, 1, 120, 'x')).toBeUndefined();
    expect(insertSlot(boxes, 1, 180, 'x')).toBeUndefined();
    expect(insertSlot(boxes, 0, 20, 'x')).toBeUndefined();
    expect(insertSlot(boxes, 2, 260, 'x')).toBeUndefined();
    expect(insertSlot([], 0, 5, 'x')).toBeUndefined();
  });
  it('puts the bar on the boundary', () => {
    expect(insertSlot(boxes, 2, 120, 'x')?.box).toEqual({ left: 99, top: 10, width: 2, height: 20 });
    expect(insertSlot(boxes, 0, 290, 'x')?.box).toEqual({ left: 299, top: 10, width: 2, height: 20 });
    const rows = [
      { left: 0, top: 0, width: 200, height: 30 },
      { left: 0, top: 34, width: 200, height: 30 },
    ];
    expect(insertSlot(rows, 1, 5, 'y')).toEqual({ index: 0, box: { left: 0, top: -1, width: 200, height: 2 } });
    expect(insertSlot(rows, 0, 60, 'y')).toEqual({ index: 2, box: { left: 0, top: 63, width: 200, height: 2 } });
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
