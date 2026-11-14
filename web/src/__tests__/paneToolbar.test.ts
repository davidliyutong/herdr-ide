// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const api = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve({}));
vi.mock('../lib/conn', () => ({ conn: { api: (...a: unknown[]) => api(...a), setTheme: () => {} } }));
const command = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock('../lib/bridge', () => ({ bridge: { command: (...a: unknown[]) => command(...a) } }));

import { useStore, currentDock } from '../state/store';
import type { MachineState } from '../lib/herdr';
import { PaneToolbar } from '../components/PaneToolbar';
import { PaneHeader } from '../components/PaneHeader';
import { toolbarShown } from '../components/Workspace';
import { useMenu } from '../contextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function machine(): MachineState {
  return {
    id: 'm',
    label: 'm',
    status: 'ready',
    info: { home: '/home/u' },
    snapshot: {
      workspaces: [{ workspace_id: 'w1', number: 1, label: 'one', active_tab_id: 't1' }],
      tabs: [
        { tab_id: 't1', workspace_id: 'w1', number: 1, label: 'a' },
        { tab_id: 't2', workspace_id: 'w1', number: 2, label: 'b' },
      ],
      panes: [
        { pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', cwd: '/home/u/src', label: 'build' },
        { pane_id: 'p2', workspace_id: 'w1', tab_id: 't2', cwd: '/tmp' },
      ],
    },
  } as unknown as MachineState;
}

describe('PaneToolbar', () => {
  let host: HTMLDivElement;
  let root: Root;
  const buttons = () => [...host.querySelectorAll('button')];
  const render = () => act(async () => root.render(createElement(PaneToolbar, { m: 'm', tabId: 't1' })));

  beforeEach(() => {
    command.mockClear();
    api.mockClear();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([machine()]);
    s.openDock(undefined);
    s.focusPane({ m: 'm', pane: 'p1' });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("has the focused pane's commands and opens its folder in VS Code, its changes and Git Graph", async () => {
    await render();
    expect(host.querySelector('.pane-title')?.textContent).toBe('build');
    expect(host.querySelector('.pane-cwd')?.textContent).toBe('~/src');
    expect(buttons().map((b) => b.title.replace(/ \(.*\)$/, ''))).toEqual([
      'Open folder in VS Code',
      'Changes of the repository',
      'Git Graph',
      'Split right',
      'Split down',
      'Zoom',
      'Close pane',
    ]);
    expect(buttons().some((b) => b.disabled)).toBe(false);

    const [code, diff, graph] = buttons();
    await act(async () => code.click());
    expect(currentDock(useStore.getState())).toEqual({ kind: 'code', m: 'm', folder: '/home/u/src' });
    await act(async () => diff.click());
    expect(command).toHaveBeenLastCalledWith('m', '/home/u/src', { cmd: 'openDiff', repo: '/home/u/src' });
    await act(async () => graph.click());
    expect(command).toHaveBeenLastCalledWith('m', '/home/u/src', { cmd: 'gitGraph', repo: '/home/u/src' });
  });

  it('splits the focused pane', async () => {
    await render();
    await act(async () => buttons()[3].click());
    expect(api).toHaveBeenCalledWith('m', 'pane.split', { target_pane_id: 'p1', direction: 'right', cwd: '/home/u/src', focus: false });
  });

  it('stays in place with its buttons disabled while the focus is outside the shown tab', async () => {
    useStore.getState().focusPane({ m: 'm', pane: 'p2' });
    await render();
    expect(host.querySelector('.pane-toolbar')).not.toBeNull();
    expect(buttons()).toHaveLength(7);
    expect(buttons().every((b) => b.disabled)).toBe(true);
  });

  it('renames the focused pane from its title and has its menu', async () => {
    await render();
    await act(async () => (host.querySelector('.pane-title') as HTMLElement).click());
    expect(useStore.getState().renaming).toEqual({ kind: 'pane', m: 'm', id: 'p1' });
    expect(host.querySelector('.pane-title-edit')).not.toBeNull();
    useStore.getState().setRenaming(undefined);

    await act(async () => {
      host.querySelector('.pane-toolbar')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    });
    expect(useMenu.getState().menu).toBeDefined();
  });

  it('keeps the title, folder and program windows in read-only mode, without commands', async () => {
    useStore.getState().setReadOnly(true);
    await render();
    expect(host.querySelector('.pane-toolbar')).not.toBeNull();
    expect(host.querySelector('.pane-title')?.textContent).toBe('build');
    expect(buttons()).toHaveLength(0);
  });
});

describe('PaneHeader', () => {
  let host: HTMLDivElement;
  let root: Root;
  const buttons = () => [...host.querySelectorAll('button')];
  const render = () => act(async () => root.render(createElement(PaneHeader, { m: 'm', paneId: 'p1', style: {} })));

  beforeEach(() => {
    api.mockClear();
    command.mockClear();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([machine()]);
    // The focus is elsewhere: a header's buttons act on its own pane.
    s.focusPane({ m: 'm', pane: 'p2' });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("has its pane's own buttons, which act on that pane", async () => {
    await render();
    expect(host.querySelector('.pane-title')?.textContent).toBe('build');
    expect(host.querySelector('.pane-cwd')?.textContent).toBe('~/src');
    expect(buttons().map((b) => b.title.replace(/ \(.*\)$/, ''))).toEqual([
      'Open folder in VS Code',
      'Changes of the repository',
      'Git Graph',
      'Split right',
      'Split down',
      'Zoom',
      'Close pane',
    ]);
    expect(buttons().some((b) => b.disabled)).toBe(false);
    await act(async () => buttons()[1].click());
    expect(command).toHaveBeenLastCalledWith('m', '/home/u/src', { cmd: 'openDiff', repo: '/home/u/src' });
    await act(async () => buttons()[4].click());
    expect(api).toHaveBeenCalledWith('m', 'pane.split', { target_pane_id: 'p1', direction: 'down', cwd: '/home/u/src', focus: false });
    await act(async () => buttons()[6].click());
    expect(api).toHaveBeenCalledWith('m', 'pane.close', { pane_id: 'p1' });
  });

  it('keeps keyboard focus in the terminal when a button is pressed', async () => {
    await render();
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    buttons()[0].dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('has no commands in read-only mode', async () => {
    useStore.getState().setReadOnly(true);
    await render();
    expect(host.querySelector('.pane-title')?.textContent).toBe('build');
    expect(buttons()).toHaveLength(0);
  });
});

describe('toolbar above the grid', () => {
  it('is shown for a pane without a border row, from the rendered surface when there is one', () => {
    expect(toolbarShown(true, 1)).toBe(true);
    // herdr draws outer borders: the lone pane has its own header.
    expect(toolbarShown(false, 1)).toBe(false);
    // Split (and zoomed) panes have border rows.
    expect(toolbarShown(false, 3)).toBe(false);
    // Before herdr rendered the tab: only a lone pane.
    expect(toolbarShown(undefined, 1)).toBe(true);
    expect(toolbarShown(undefined, 2)).toBe(false);
  });
});
