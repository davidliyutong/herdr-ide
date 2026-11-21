// @vitest-environment jsdom
//
// A pane's header: its terminal's title, agent and folder (VS Code's
// folder), and buttons that act on its own pane, whichever has the focus.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));
const command = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock('../lib/bridge', () => ({ bridge: { command: (...a: unknown[]) => command(...a) }, hasFrame: () => false }));

import { useStore } from '../state/store';
import { terminalTitle, type MachineState } from '../lib/machine';
import { PaneHeader } from '../components/PaneHeader';
import * as L from '../term/layout';
import { useMenu } from '../contextMenu';
import { FakeCore, settle } from './fakeTerms';
import { definePlugins } from '../plugins/registry';
import { vscodePlugin } from '../plugins/vscode';
import { vscodeOn } from './fakeSettings';

// VS Code is a plugin, off by default: these tests have it on.
definePlugins([vscodePlugin]);
vscodeOn();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('PaneHeader', () => {
  let host: HTMLDivElement;
  let root: Root;
  let core: FakeCore;
  const buttons = () => [...host.querySelectorAll('button')];
  const render = (pane = 'p1', leaf: L.Leaf = { terminal: 'p1' }) =>
    act(async () => root.render(createElement(PaneHeader, { m: 'm', pane, leaf, ws: 'w1w1w1w1', focused: false, zoomed: false })));

  beforeEach(async () => {
    command.mockClear();
    core = new FakeCore();
    core.machine(
      'm',
      [
        FakeCore.term('p1', { cwd: '/home/u/src', labels: { name: 'build' }, agent: 'claude', agent_status: 'working' }),
        FakeCore.term('p2', { cwd: '/tmp' }),
      ],
      {
        version: 2,
        workspaces: [
          {
            id: 'w1w1w1w1',
            name: 'one',
            cwd: '',
            tabs: [{ root: { split: 'horizontal', ratio: 0.5, children: [{ terminal: 'p1' }, { terminal: 'p2' }] }, focused: 'p2' }],
            selected: 0,
          },
        ],
        selected: 0,
      },
    );
    core.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'm', label: 'm', kind: 'local', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
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
  });

  it("has its pane's own buttons, which act on that pane", async () => {
    await render();
    expect(host.querySelector('.pane-title')?.textContent).toBe('build');
    expect(host.querySelector('.pane-agent')?.textContent).toBe('claude');
    expect(host.querySelector('.dot-working')).not.toBeNull();
    expect(host.querySelector('.pane-cwd')?.textContent).toBe('~/src');
    expect(buttons().map((b) => b.title.replace(/ \(.*\)$/, ''))).toEqual([
      'Open in VS Code',
      'Show Changes in VS Code',
      'Open Git Graph',
      'Split Right',
      'Split Down',
      'Maximize Pane',
      'More Pane Actions',
      'Close Pane',
    ]);
    await act(async () => buttons()[4].click());
    await act(settle);
    // The split starts in p1's folder and goes below p1.
    expect(core.calls.find((c) => c.method === 'terminal.run')?.params).toEqual({
      keep: true,
      cwd: '/home/u/src',
      display: expect.any(Object),
    });
    expect(core.layout('m')!.workspaces[0].tabs[0].root).toMatchObject({
      children: [{ split: 'vertical', children: [{ terminal: 'p1' }, { terminal: 't1' }] }, { terminal: 'p2' }],
    });
    await act(async () => buttons()[5].click());
    expect(useStore.getState().zoomed).toEqual({ m: 'm', pane: 'p1' });
    useStore.getState().setZoomed(undefined);
    // The changes open in VS Code beside p1, for p1's folder.
    await act(async () => buttons()[1].click());
    await act(settle);
    expect(command).toHaveBeenLastCalledWith('m', expect.any(String), '/home/u/src', { cmd: 'openDiff', repo: '/home/u/src' }, true);
    const [view] = L.codeViews(L.parseLayout(core.layout('m')).workspaces[0]);
    expect(L.parseLayout(core.layout('m')).workspaces[0].tabs[0].root).toMatchObject({
      children: [{ split: 'vertical', children: [{ split: 'horizontal', children: [{ terminal: 'p1' }, { code: view.view }] }, {}] }, {}],
    });
    // The menu's button has the pane's commands.
    await act(async () => buttons()[6].click());
    expect(useMenu.getState().menu?.entries.length).toBeGreaterThan(5);
  });

  it("names a VS Code pane by its folder and has VS Code's buttons", async () => {
    core.model.mutate('m', (l) => L.splitPane(l, 'p2', 'vertical', { code: { id: 'c1', folder: '/home/u/src/app' } }));
    await render('code:c1', { code: { id: 'c1', folder: '/home/u/src/app' } });
    expect(host.querySelector('.pane-title')?.textContent).toBe('app');
    expect(host.querySelector<HTMLElement>('.pane-title')?.title).toBe('VS Code on m: /home/u/src/app');
    expect(host.querySelector('.pane-cwd')?.textContent).toBe('~/src/app');
    expect(host.querySelector('.code-icon')).not.toBeNull();
    expect(buttons().map((b) => b.title.replace(/ \(.*\)$/, ''))).toEqual([
      'Reload VS Code',
      'Split Right',
      'Split Down',
      'Maximize Pane',
      'More Pane Actions',
      'Close Pane',
    ]);
    await act(async () => buttons()[5].click());
    await act(settle);
    expect(L.findLeaf(L.parseLayout(core.layout('m')), 'code:c1')).toBeNull();
    expect(core.calls.filter((c) => c.method === 'terminal.kill')).toEqual([]);
  });

  it('keeps keyboard focus in the terminal when a button is pressed', async () => {
    await render();
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    buttons()[0].dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('focuses its terminal when pressed, renames it by a double click on its title and has its menu', async () => {
    await render();
    await act(async () => host.querySelector('.pane-header')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await act(settle);
    expect(core.layout('m')!.workspaces[0].tabs[0].focused).toBe('p1');
    // A click on the title only focuses; a double click renames, as tabs and workspaces.
    await act(async () => host.querySelector<HTMLElement>('.pane-title')!.click());
    expect(host.querySelector('.pane-title-edit')).toBeNull();
    await act(async () => host.querySelector<HTMLElement>('.pane-title')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const input = host.querySelector<HTMLInputElement>('.pane-title-edit');
    expect(input?.value).toBe('build');
    input!.value = 'tests';
    await act(async () => input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(core.calls.find((c) => c.method === 'terminal.label')?.params).toEqual({ terminal: 'p1', labels: { name: 'tests' } });
    await act(async () =>
      host.querySelector('.pane-header')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    expect(useMenu.getState().menu?.entries.length).toBeGreaterThan(0);
  });

  it("names a terminal by its pane's name first, also in tabs and lists", () => {
    const r = { address: 't1', title: 'zsh', name: 'srv', labels: { name: 'build' } };
    expect(terminalTitle(r, 't1')).toBe('build');
    expect(terminalTitle({ ...r, labels: {} }, 't1')).toBe('srv');
    expect(terminalTitle({ address: 't1', title: 'zsh' }, 't1')).toBe('zsh');
    expect(terminalTitle(undefined, 't1')).toBe('t1');
  });

  it('is a toolbar for the keyboard: one Tab stop, arrows, F2 or Enter to rename, the menu key, Escape', async () => {
    await render();
    const header = host.querySelector<HTMLElement>('.pane-header')!;
    expect(header.getAttribute('role')).toBe('toolbar');
    expect(header.tabIndex).toBe(0);
    expect(buttons().every((b) => b.tabIndex === -1)).toBe(true);
    // The keyboard on the header makes its pane the focused one.
    await act(async () => header.focus());
    await settle();
    expect(core.layout('m')!.workspaces[0].tabs[0].focused).toBe('p1');
    const key = (k: string, o: KeyboardEventInit = {}) =>
      act(
        async () =>
          void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o })),
      );
    await key('ArrowRight');
    expect(document.activeElement).toBe(host.querySelector('.pane-title'));
    await key('ArrowRight');
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('Open in VS Code');
    await key('End');
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('Close Pane');
    await key('Home');
    await key('F2');
    expect(useStore.getState().renaming).toEqual({ kind: 'pane', m: 'm', id: 'p1' });
    await act(async () => useStore.getState().setRenaming(undefined));
    header.focus();
    await key('Enter');
    expect(useStore.getState().renaming).toEqual({ kind: 'pane', m: 'm', id: 'p1' });
    await act(async () => useStore.getState().setRenaming(undefined));
    header.focus();
    await key('F10', { shiftKey: true });
    expect(useMenu.getState().menu?.entries.length).toBeGreaterThan(0);
    useMenu.setState({ menu: undefined });
    // A press with the mouse focuses the pane, not the header.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    header.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('has no commands in read-only mode', async () => {
    useStore.getState().setReadOnly(true);
    await render();
    expect(host.querySelector('.pane-title')?.textContent).toBe('build');
    expect(buttons()).toHaveLength(0);
  });
});
