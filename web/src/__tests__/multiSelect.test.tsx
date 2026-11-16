// @vitest-environment jsdom
//
// Several tabs, workspaces or machines selected together and acted on at
// once: ⌘/Ctrl- and Shift-clicks, the keyboard of the tab bar and the
// sidebar, the menus of a selection, one confirmation naming what goes and
// one Undo for tabs, and dragging a block of rows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: vi.fn() } }));
// The panes are not what these tests are about.
vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }));

import { useStore } from '../state/store';
import { FakeCore, settle } from './fakeTerms';
import type { MachineState } from '../lib/machine';
import { Workspace } from '../components/Workspace';
import { Sidebar } from '../components/Sidebar';
import { ContextMenu } from '../components/ContextMenu';
import { useMenu, isItem, type MenuItem } from '../contextMenu';
import { useDialog } from '../dialog';
import { clearMulti, selectedIds, useMulti } from '../state/multiSelect';
import { blockSlot } from '../reorderDrag';
import { actions } from '../actions';
import { resetClosed } from '../closedPanes';
import { conn } from '../lib/conn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
        { root: { terminal: 'p3' }, focused: 'p3', name: 'c' },
        { root: { terminal: 'p4' }, focused: 'p4', name: 'd' },
      ],
      selected: 0,
    },
    { id: 'w2w2w2w2', name: 'two', cwd: '/tmp', tabs: [{ root: { terminal: 'p5' }, focused: 'p5' }], selected: 0 },
    { id: 'w3w3w3w3', name: 'three', cwd: '/var', tabs: [{ root: { terminal: 'p6' }, focused: 'p6' }], selected: 0 },
  ],
  selected: 0,
});

let core: FakeCore;
let host: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('{}', { status: 200 })));

const machine = (id: string, kind = 'ssh', status = 'ready') =>
  ({ id, label: id === 'm' ? 'box' : id, kind, status, target: `u@${id}` }) as unknown as MachineState;

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  resetClosed();
  clearMulti();
  core = new FakeCore();
  const terms = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((a) => FakeCore.term(a, { cwd: '/src' }));
  core.machine('m', terms, layout());
  core.install();
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([machine('m', 'local'), machine('gpu'), machine('db'), machine('web', 'ssh', 'disabled')]);
  s.selectMachine('m');
  core.model.subscribe('m');
  await settle();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useMenu.setState({ menu: undefined });
  useDialog.setState({ current: undefined });
  vi.unstubAllGlobals();
});

const render = (c: () => React.ReactNode) =>
  act(async () =>
    root.render(
      createElement(() => (
        <>
          {c()}
          <ContextMenu />
        </>
      )),
    ),
  );
const tabs = () => [...host.querySelectorAll<HTMLElement>('.tab')];
const tabNames = () => core.layout('m')!.workspaces[0].tabs.map((t) => t.name);
// jsdom is no Mac: Ctrl toggles a row.
const press = (el: HTMLElement, o: PointerEventInit = {}) =>
  act(async () => void el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, ...o })));
const key = (el: Element, k: string, o: KeyboardEventInit = {}) =>
  act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o })));
const menuOf = async (el: HTMLElement) => {
  await act(async () => void el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
  return useMenu.getState().menu?.entries.filter(isItem) ?? [];
};
const item = (items: MenuItem[], label: string) => items.find((i) => i.label === label)!;

describe('tabs selected together', () => {
  it('selects with Ctrl and Shift, starting from the tab shown, and acts on them from their menu', async () => {
    await render(() => <Workspace />);
    // Ctrl adds a tab without showing it; the tab shown is part of the selection.
    await press(tabs()[2], { ctrlKey: true });
    expect(core.layout('m')!.workspaces[0].selected).toBe(0);
    expect(tabs().map((t) => t.classList.contains('multi'))).toEqual([true, false, true, false]);
    // Shift selects the tabs from the last one clicked; Ctrl adds more.
    await press(tabs()[3], { shiftKey: true });
    expect(selectedIds({ kind: 'tab', m: 'm', ws: 'w1w1w1w1' })).toEqual(['p3', 'p4']);
    await press(tabs()[0], { ctrlKey: true });
    expect(selectedIds({ kind: 'tab', m: 'm', ws: 'w1w1w1w1' })).toEqual(['p1', 'p3', 'p4']);
    // A right click on one of them: the selection's menu.
    const items = await menuOf(tabs()[3]);
    expect(items.map((i) => i.label)).toEqual(['Move to Workspace', 'Close 3 Tabs']);
    expect(
      item(items, 'Move to Workspace')
        .submenu!.filter(isItem)
        .map((i) => i.label),
    ).toEqual(['two', 'three', 'New Workspace…']);
    // Moving them: to the end of the other workspace, which is shown with the last of them.
    item(item(items, 'Move to Workspace').submenu!.filter(isItem), 'three').run!();
    await settle();
    const l = core.layout('m')!;
    expect(l.workspaces[0].tabs.map((t) => t.name)).toEqual(['b']);
    expect(l.workspaces[2].tabs.map((t) => t.focused)).toEqual(['p6', 'p1', 'p3', 'p4']);
    expect(l.selected).toBe(2);
    expect(l.workspaces[2].selected).toBe(3);
  });

  it('closes them at once, and one Undo brings them all back in their places', async () => {
    await render(() => <Workspace />);
    await press(tabs()[1], { ctrlKey: true });
    await press(tabs()[3], { ctrlKey: true });
    // A right click on a tab outside the selection is that tab's menu, and clears it.
    expect((await menuOf(tabs()[2])).map((i) => i.label)).toContain('Rename Tab');
    expect(useMulti.getState().sel).toBeUndefined();
    await press(tabs()[1], { ctrlKey: true });
    await press(tabs()[3], { ctrlKey: true });
    const items = await menuOf(tabs()[1]);
    item(items, 'Close 3 Tabs').run!();
    await settle();
    expect(tabNames()).toEqual(['c']);
    expect(useStore.getState().toasts.at(-1)?.msg).toBe('3 tabs closed.');
    actions.undoClose();
    await settle();
    expect(tabNames()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is kept by the keyboard: arrows, Shift, Ctrl+A, Delete, Escape, F2 and the menu key', async () => {
    await render(() => <Workspace />);
    // The tab shown is the bar's tab stop.
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    tabs()[0].focus();
    await key(tabs()[0], 'ArrowRight');
    expect(document.activeElement).toBe(tabs()[1]);
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1]);
    await key(tabs()[1], 'ArrowRight', { shiftKey: true });
    expect(selectedIds({ kind: 'tab', m: 'm', ws: 'w1w1w1w1' })).toEqual(['p2', 'p3']);
    await key(tabs()[2], 'Escape');
    expect(useMulti.getState().sel).toBeUndefined();
    await key(tabs()[2], 'a', { ctrlKey: true });
    expect(selectedIds({ kind: 'tab', m: 'm', ws: 'w1w1w1w1' })).toHaveLength(4);
    await key(tabs()[2], 'Escape');
    // Enter shows the tab; F2 renames it; the menu key opens its menu.
    await key(tabs()[2], 'Enter');
    await settle();
    expect(core.layout('m')!.workspaces[0].selected).toBe(2);
    await key(tabs()[2], 'F2');
    expect(useStore.getState().renaming).toEqual({ kind: 'tab', m: 'm', id: 'w1w1w1w1:2' });
    await act(async () => useStore.getState().setRenaming(undefined));
    await key(tabs()[2], 'F10', { shiftKey: true });
    expect(useMenu.getState().menu?.entries.filter(isItem)[0].label).toBe('Rename Tab');
    useMenu.setState({ menu: undefined });
    // Ctrl+Space adds a tab to the one shown; Delete closes the tab, or
    // the tabs selected with it.
    await key(tabs()[3], ' ', { ctrlKey: true });
    expect(selectedIds({ kind: 'tab', m: 'm', ws: 'w1w1w1w1' })).toEqual(['p3', 'p4']);
    await key(tabs()[3], 'Delete');
    await settle();
    expect(tabNames()).toEqual(['a', 'b']);
  });
});

describe('workspaces and machines selected together', () => {
  const rows = () => [...host.querySelectorAll<HTMLElement>('.ws-item[data-ws-id]')];
  const heads = () => [...host.querySelectorAll<HTMLElement>('.machine-head')];

  it('closes several workspaces after one confirmation naming them', async () => {
    await render(() => <Sidebar />);
    await act(async () => rows()[2].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    expect(rows().map((r) => r.classList.contains('multi'))).toEqual([true, false, true]);
    // A plain click shows a workspace and clears the selection.
    await act(async () => rows()[1].click());
    await settle();
    expect(useMulti.getState().sel).toBeUndefined();
    expect(core.layout('m')!.selected).toBe(1);
    await act(async () => rows()[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(selectedIds({ kind: 'workspace', m: 'm' })).toEqual(['w2w2w2w2', 'w3w3w3w3']);
    const items = await menuOf(rows()[2]);
    expect(items.map((i) => i.label)).toEqual(['Close 2 Workspaces…']);
    items[0].run!();
    await vi.waitFor(() => expect(useDialog.getState().current).toBeDefined());
    const req = useDialog.getState().current!;
    expect(req).toMatchObject({ kind: 'confirm', title: 'Close 2 workspaces?', message: expect.stringContaining('“two”, “three”') });
    if (req.kind === 'confirm') req.resolve(true);
    await settle();
    expect(core.layout('m')!.workspaces.map((w) => w.name)).toEqual(['one']);
    expect(core.calls.filter((c) => c.method === 'terminal.kill').map((c) => c.params.terminal)).toEqual(['p5', 'p6']);
  });

  it('acts on several machines from their menu, asking once, and removes the SSH ones', async () => {
    await render(() => <Sidebar />);
    await act(async () => heads()[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    await act(async () => heads()[3].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(selectedIds({ kind: 'machine' })).toEqual(['gpu', 'db', 'web']);
    // Selecting does not fold or unfold.
    expect(heads().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'true', 'true', 'false']);
    const items = await menuOf(heads()[2]);
    expect(items.map((i) => i.label)).toEqual(['Enable Machine', 'Disable 2 Machines…', 'Remove 3 Machines…']);
    item(items, 'Remove 3 Machines…').run!();
    await vi.waitFor(() => expect(useDialog.getState().current).toBeDefined());
    const req = useDialog.getState().current!;
    expect(req).toMatchObject({ title: 'Remove 3 machines?', message: expect.stringContaining('“gpu”, “db”, “web”') });
    if (req.kind === 'confirm') req.resolve(true);
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'DELETE')).toHaveLength(3));
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual(['/api/m/gpu', '/api/m/db', '/api/m/web']);
    await vi.waitFor(() => expect(useStore.getState().toasts.at(-1)?.msg).toBe('Removed 3 machines.'));
  });

  it('disables several machines once, and retries those that failed', async () => {
    await act(async () =>
      useStore.getState().setMachines([machine('m', 'local'), machine('gpu', 'ssh', 'error'), machine('db'), machine('web')]),
    );
    await render(() => <Sidebar />);
    await act(async () => heads()[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    await act(async () => heads()[2].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    const items = await menuOf(heads()[1]);
    expect(items.map((i) => i.label)).toEqual(['Retry', 'Disable 2 Machines…', 'Remove 2 Machines…']);
    item(items, 'Retry').run!();
    expect(conn.retry).toHaveBeenCalledWith('gpu', 0, expect.anything());
    item(items, 'Disable 2 Machines…').run!();
    await vi.waitFor(() => expect(useDialog.getState().current).toBeDefined());
    const req = useDialog.getState().current!;
    // One of them is connected: its terminal service may be stopped too.
    expect(req).toMatchObject({ title: 'Disable 2 machines?', check: expect.any(String), checked: false });
    if (req.kind === 'confirm') req.resolve(true, false);
    await vi.waitFor(() => expect(fetchMock.mock.calls).toHaveLength(2));
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.body])).toEqual([
      ['/api/m/gpu/enabled', '{"enabled":false}'],
      ['/api/m/db/enabled', '{"enabled":false}'],
    ]);
  });

  it('moves through the rows with the keyboard, folds machines and selects workspaces', async () => {
    await render(() => <Sidebar />);
    const list = host.querySelector<HTMLElement>('.sidebar-scroll')!;
    // The workspace shown is the list's tab stop.
    const stop = () => [...list.querySelectorAll<HTMLElement>('[data-nav]')].filter((e) => e.tabIndex === 0);
    expect(stop()).toEqual([rows()[0]]);
    // A press of the mouse leaves the keyboard where it is (the terminal), on rows and tabs alike.
    for (const el of [rows()[1], heads()[0]]) {
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      el.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
    }
    rows()[0].focus();
    await key(rows()[0], 'ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    await key(rows()[1], 'ArrowDown', { shiftKey: true });
    expect(selectedIds({ kind: 'workspace', m: 'm' })).toEqual(['w2w2w2w2', 'w3w3w3w3']);
    // ← goes to the machine, ← again folds it, → unfolds it.
    await key(rows()[2], 'ArrowLeft');
    expect(document.activeElement).toBe(heads()[0]);
    await key(heads()[0], 'ArrowLeft');
    expect(rows()).toHaveLength(0);
    await key(heads()[0], 'ArrowRight');
    expect(rows()).toHaveLength(3);
    // Letters go to a row by its name; F2 renames; Enter shows.
    await key(heads()[0], 't');
    expect(document.activeElement).toBe(rows()[1]);
    await key(rows()[1], 'F2');
    expect(useStore.getState().renaming).toEqual({ kind: 'workspace', m: 'm', id: 'w2w2w2w2' });
    await act(async () => useStore.getState().setRenaming(undefined));
    await key(rows()[1], 'Enter');
    await settle();
    expect(core.layout('m')!.selected).toBe(1);
    // Ctrl+A on a machine selects the machines.
    await key(heads()[1], 'a', { ctrlKey: true });
    expect(selectedIds({ kind: 'machine' })).toEqual(['m', 'gpu', 'db', 'web']);
  });
});

describe('dragging a block', () => {
  // Five rows of 20 pixels from the top.
  const boxes = [0, 1, 2, 3, 4].map((i) => ({ left: 0, top: i * 20, width: 100, height: 20 }));
  const ids = ['a', 'b', 'c', 'd', 'e'];
  it('offers only the slots that change the order', () => {
    // b and d dragged: before a, between them, and at the end change it.
    expect(blockSlot(boxes, ids, ['b', 'd'], 50, 2, 'y')?.index).toBe(0);
    expect(blockSlot(boxes, ids, ['b', 'd'], 50, 98, 'y')?.index).toBe(5);
    expect(blockSlot(boxes, ids, ['b', 'd'], 50, 42, 'y')?.index).toBe(2);
    // b and c, together already, dropped beside themselves: nothing.
    expect(blockSlot(boxes, ids, ['b', 'c'], 50, 22, 'y')).toBeUndefined();
    expect(blockSlot(boxes, ids, ['b', 'c'], 50, 62, 'y')).toBeUndefined();
    expect(blockSlot(boxes, ids, ['b', 'c'], 50, 2, 'y')?.index).toBe(0);
  });

  it('moves workspaces and tabs as a block, keeping what is shown', async () => {
    actions.moveWorkspaces('m', ['w1w1w1w1', 'w3w3w3w3'], 2);
    actions.moveTabs('m', ['p1', 'p3'], 4);
    await settle();
    const l = core.layout('m')!;
    expect(l.workspaces.map((w) => w.name)).toEqual(['two', 'one', 'three']);
    expect(l.selected).toBe(1);
    expect(l.workspaces[1].tabs.map((t) => t.name)).toEqual(['b', 'd', 'a', 'c']);
    expect(l.workspaces[1].selected).toBe(2);
  });
});
