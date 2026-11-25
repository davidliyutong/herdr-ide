// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import registry from '../../../spec/generated/registry.json';
import { keyName } from '../keys';
import { disabledCommands, runMenuCommand } from '../desktop';
import { closeWindowPane, handleKey, leaveWindowPane } from '../keymap';
import { useKeys, type Binding } from '../keybindings';
import '../commands';
import { noteFocus, resetHistory } from '../paneHistory';
import { useDialog } from '../dialog';
import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { frameLoaded, resetFrames, useFrames } from '../codeFrames';
import { FakeHub, settle } from './fakeTerms';
import { resetClosed } from '../closedPanes';
import { definePlugins } from '../plugins/registry';
import { vscodePlugin } from '../plugins/vscode';
import { vscodeOn } from './fakeSettings';

// VS Code is a plugin, off by default: these tests have it on.
definePlugins([vscodePlugin]);
vscodeOn();

describe('keyName', () => {
  it('names a key after its character on the current layout', () => {
    expect(keyName({ key: 't', code: 'KeyT' })).toBe('t');
    expect(keyName({ key: 'T', code: 'KeyT' })).toBe('t');
    // AZERTY: Z where QWERTY has W; Dvorak: comma at KeyW.
    expect(keyName({ key: 'z', code: 'KeyW' })).toBe('z');
    expect(keyName({ key: ',', code: 'KeyW' })).toBe('comma');
    expect(keyName({ key: ' ', code: 'Space' })).toBe('space');
  });
  it('falls back to the physical key', () => {
    expect(keyName({ key: '!', code: 'Digit1' })).toBe('1');
    expect(keyName({ key: 'ц', code: 'KeyW' })).toBe('w');
    expect(keyName({ key: '†', code: 'KeyT' })).toBe('t');
    expect(keyName({ key: 'ArrowLeft', code: 'ArrowLeft' })).toBe('left');
    expect(keyName({ key: 'F5', code: 'F5' })).toBe('f5');
    expect(keyName({ key: 'Meta', code: 'MetaLeft' })).toBeUndefined();
  });
});

const layout = () => ({
  version: 2,
  workspaces: [
    {
      id: 'wwwwwwww',
      name: 'w',
      cwd: '',
      tabs: [{ root: { split: 'horizontal', ratio: 0.5, children: [{ terminal: 't1' }, { terminal: 't2' }] }, focused: 't1' }],
      selected: 0,
    },
  ],
  selected: 0,
});

/** A terminal whose shell (pid 10) waits at its prompt, or runs a program in front. */
const shell = (address: string, extra: Record<string, unknown> = {}) =>
  FakeHub.term(address, { pid: 10, foreground: { pid: 10, name: 'zsh', argv: ['-zsh'], cwd: '/srv/app' }, ...extra });
const running = (address: string, name: string, extra: Record<string, unknown> = {}) =>
  FakeHub.term(address, { pid: 10, foreground: { pid: 20, name, argv: [name], cwd: '/srv/app' }, ...extra });

describe('runMenuCommand', () => {
  let hub: FakeHub;
  const setup = async (terminals: Array<Record<string, unknown> & { address: string }>) => {
    hub = new FakeHub();
    hub.machine('m', terminals, layout());
    hub.install();
    const s = useStore.getState();
    s.upsertMachine({ id: 'm', label: 'm', kind: 'local', status: 'ready' } as unknown as MachineState);
    s.selectMachine('m');
    hub.model.subscribe('m');
    await settle();
  };
  beforeEach(() => {
    // A short time to undo a close: terminals end soon after.
    resetClosed(50);
    return setup([shell('t1'), shell('t2')]);
  });
  afterEach(() => {
    useDialog.setState({ current: undefined });
    document.body.innerHTML = '';
  });

  const dialog = () => useDialog.getState().current;
  const killed = () => hub.calls.filter((c) => c.method === 'terminal.kill').map((c) => c.params.terminal);

  it('closes a tab at once, without asking, its terminals ending once it can no longer be undone', async () => {
    await setup([shell('t1'), running('t2', 'vim')]);
    runMenuCommand('tab.close');
    await settle();
    expect(dialog()).toBeUndefined();
    expect(hub.layout('m')?.workspaces[0].tabs).toEqual([]);
    expect(killed()).toEqual([]);
    await vi.waitFor(() => expect(killed().sort()).toEqual(['t1', 't2']));
  });

  it('closes a pane at once, without asking, a program running in it or not', async () => {
    await setup([running('t1', 'htop'), shell('t2')]);
    runMenuCommand('pane.close');
    await settle();
    expect(dialog()).toBeUndefined();
    expect(hub.layout('m')?.workspaces[0].tabs[0].root).toEqual({ terminal: 't2' });
    await vi.waitFor(() => expect(killed()).toEqual(['t1']));
  });

  it('closes a workspace with no tab left at the next press of the pane’s key, not while it is held', async () => {
    await setup([shell('t1')]);
    const now = vi.spyOn(Date, 'now');
    try {
      // The key held: its press closes the last pane, its repeats leave the
      // workspace, empty now.
      now.mockReturnValue(1_000_000);
      runMenuCommand('pane.close');
      await settle();
      expect(hub.layout('m')?.workspaces[0].tabs).toEqual([]);
      expect(disabledCommands()).not.toContain('pane.close');
      for (let t = 1_000_400; t < 1_000_700; t += 30) {
        now.mockReturnValue(t);
        runMenuCommand('pane.close');
      }
      await settle();
      expect(hub.layout('m')?.workspaces.map((w) => w.id)).toEqual(['wwwwwwww']);
      // Pressed again: it goes, without asking, as it has nothing to lose
      // (a machine may be left with none).
      now.mockReturnValue(1_002_000);
      runMenuCommand('pane.close');
      await settle();
      expect(dialog()).toBeUndefined();
      expect(hub.layout('m')?.workspaces.map((w) => w.id)).not.toContain('wwwwwwww');
    } finally {
      now.mockRestore();
    }
  });

  it('leaves a pinned tab open: cmd+w closes its panes but not its last one', async () => {
    const keysBefore = useKeys.getState().effective;
    useKeys.setState({ effective: registry.keybindings.mac as Binding[] });
    const now = vi.spyOn(Date, 'now');
    const cmdW = () => {
      const ev = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', metaKey: true, cancelable: true });
      expect(handleKey(ev, 'terminal')).toBe(true);
      expect(ev.defaultPrevented).toBe(true);
    };
    const tabs = () => hub.layout('m')!.workspaces[0].tabs;
    try {
      hub.model.mutate('m', (l) => L.pinTab(l, 'wwwwwwww', 0, true));
      await settle();
      // With another pane beside it, the focused pane closes and the tab stays.
      now.mockReturnValue(1_000_000);
      cmdW();
      await settle();
      expect(tabs()).toHaveLength(1);
      expect(tabs()[0]).toMatchObject({ pinned: true, root: { terminal: 't2' } });
      // Its last pane stays, from the key (held or pressed again) and the menu.
      expect(disabledCommands()).toContain('pane.close');
      for (const t of [1_000_400, 1_000_430, 1_002_000]) {
        now.mockReturnValue(t);
        cmdW();
        runMenuCommand('pane.close');
      }
      await settle();
      expect(tabs()).toHaveLength(1);
      expect(tabs()[0]).toMatchObject({ pinned: true, root: { terminal: 't2' } });
      await vi.waitFor(() => expect(killed()).toEqual(['t1']));
      // Close Tab still closes it.
      runMenuCommand('tab.close');
      await settle();
      expect(tabs()).toEqual([]);
      await vi.waitFor(() => expect(killed().sort()).toEqual(['t1', 't2']));
    } finally {
      now.mockRestore();
      useKeys.setState({ effective: keysBefore });
    }
  });

  it('stops a held cmd+w at a pinned tab it reaches', async () => {
    await setup([shell('t1'), shell('t2'), shell('t3'), shell('t4')]);
    // A pinned tab of two panes, then a tab of two panes, shown.
    hub.model.mutate('m', (l) => {
      const both = L.splitPane(L.openTerminal(l, 't3', 'wwwwwwww'), 't3', 'horizontal', { terminal: 't4' });
      return L.focusPane(L.pinTab(both, 'wwwwwwww', 0, true), 't3');
    });
    await settle();
    expect(hub.layout('m')!.workspaces[0].selected).toBe(1);
    const now = vi.spyOn(Date, 'now');
    try {
      // The key held: its press and first repeat close the second tab's
      // panes, the tab goes and the pinned one is shown, whose panes the
      // repeats leave.
      now.mockReturnValue(1_000_000);
      runMenuCommand('pane.close');
      await settle();
      for (let t = 1_000_400; t < 1_000_700; t += 30) {
        now.mockReturnValue(t);
        runMenuCommand('pane.close');
        await settle();
      }
      const tabs = hub.layout('m')!.workspaces[0].tabs;
      expect(tabs).toHaveLength(1);
      expect(tabs[0].pinned).toBe(true);
      expect(L.tabPanes(tabs[0] as L.Tab).sort()).toEqual(['t1', 't2']);
      // Pressed again, it closes the focused pane of the pinned tab.
      now.mockReturnValue(1_005_000);
      runMenuCommand('pane.close');
      await settle();
      expect(L.tabPanes(hub.layout('m')!.workspaces[0].tabs[0] as L.Tab)).toHaveLength(1);
      await vi.waitFor(() => expect(killed()).toHaveLength(3));
      expect(killed().slice(0, 2).sort()).toEqual(['t3', 't4']);
    } finally {
      now.mockRestore();
    }
  });

  it('does nothing while a dialog is open', async () => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    document.body.append(backdrop);
    runMenuCommand('tab.close');
    runMenuCommand('tab.new');
    await settle();
    expect(useDialog.getState().current).toBeUndefined();
    expect(hub.calls.filter((c) => c.method.startsWith('terminal.'))).toEqual([]);
  });

  it("runs the main UI's commands for the VS Code pane that has the keyboard: cmd+w closes it", async () => {
    hub.model.mutate('m', (l) => L.splitPane(l, 't2', 'vertical', { code: { id: 'c1', folder: '/srv/app' } }));
    // The layout still has t1 focused: the pane whose iframe has the keyboard counts.
    hub.model.mutate('m', (l) => L.focusPane(l, 't1'));
    resetFrames();
    useFrames.setState({ frames: { 'm|c1': { m: 'm', id: 'c1', folder: '/srv/app', load: 0 } } });
    const frame = document.createElement('iframe');
    frame.className = 'code-frame';
    frame.dataset.frame = 'm|c1';
    document.body.append(frame);
    frame.focus();
    expect(document.activeElement).toBe(frame);
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      runMenuCommand('pane.close');
      await settle();
      expect(L.findLeaf(hub.layout('m') as L.Layout, 'code:c1')).toBeNull();
      expect(killed()).toEqual([]);
      useStore.getState().openSettings(false);
      runMenuCommand('app.settings');
      expect(useStore.getState().settings).toEqual({});
      useStore.getState().openSettings(false);
    } finally {
      focus.mockRestore();
    }
  });

  it('opens the settings', () => {
    useStore.getState().openSettings(false);
    runMenuCommand('app.settings');
    expect(useStore.getState().settings).toEqual({});
    useStore.getState().openSettings(false);
  });

  it('asks for a new workspace', () => {
    runMenuCommand('workspace.new');
    expect(useDialog.getState().current?.kind).toBe('workspace');
  });

  it('leaves VS Code its keys; cmd+w in a window without editors closes the pane that has the keyboard', async () => {
    hub.model.mutate('m', (l) => L.splitPane(l, 't2', 'vertical', { code: { id: 'c1', folder: '/srv/app' } }));
    useFrames.setState({ frames: { 'm|c1': { m: 'm', id: 'c1', folder: '/srv/app', load: 0 } } });
    const iframe = document.createElement('iframe');
    iframe.className = 'code-frame';
    iframe.dataset.frame = 'm|c1';
    document.body.append(iframe);
    const w = iframe.contentWindow!;
    frameLoaded('m|c1', iframe);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      // The app takes no key from VS Code.
      const ev = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', metaKey: true, cancelable: true });
      w.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      // The extension's cmd+w, from a window whose pane does not have the keyboard: nothing.
      closeWindowPane('m', 'w1', ['/srv/app']);
      await settle();
      expect(L.findLeaf(hub.layout('m') as L.Layout, 'code:c1')).not.toBeNull();
      // From the window the focused iframe shows: its pane closes.
      iframe.focus();
      closeWindowPane('m', 'w1', ['/srv/app']);
      await settle();
      expect(L.findLeaf(hub.layout('m') as L.Layout, 'code:c1')).toBeNull();
      expect(killed()).toEqual([]);
    } finally {
      hasFocus.mockRestore();
      iframe.remove();
    }
  });

  it("leaves a pinned tab's only VS Code pane to VS Code's cmd+w in a window without editors", async () => {
    // The VS Code pane alone in a tab, pinned and shown.
    hub.model.mutate('m', (l) => {
      const alone = L.moveToNewTab(L.splitPane(l, 't2', 'vertical', { code: { id: 'c1', folder: '/srv/app' } }), 'code:c1', 'wwwwwwww');
      return L.pinTab(alone, 'wwwwwwww', 1, true);
    });
    await settle();
    expect(hub.layout('m')!.workspaces[0]).toMatchObject({ selected: 0, tabs: [{ pinned: true, focused: 'code:c1' }, {}] });
    useFrames.setState({ frames: { 'm|c1': { m: 'm', id: 'c1', folder: '/srv/app', load: 0 } } });
    const iframe = document.createElement('iframe');
    iframe.className = 'code-frame';
    iframe.dataset.frame = 'm|c1';
    document.body.append(iframe);
    frameLoaded('m|c1', iframe);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      iframe.focus();
      closeWindowPane('m', 'w1', ['/srv/app']);
      await settle();
      expect(L.findLeaf(hub.layout('m') as L.Layout, 'code:c1')).not.toBeNull();
      // Unpinned, the tab goes with it.
      hub.model.mutate('m', (l) => L.pinTab(l, 'wwwwwwww', 0, false));
      await settle();
      closeWindowPane('m', 'w1', ['/srv/app']);
      await settle();
      expect(L.findLeaf(hub.layout('m') as L.Layout, 'code:c1')).toBeNull();
      expect(hub.layout('m')!.workspaces[0].tabs).toHaveLength(1);
    } finally {
      hasFocus.mockRestore();
      iframe.remove();
    }
  });

  it('gives the keyboard back from VS Code to its pane header, where code.open hides VS Code again', async () => {
    resetHistory();
    hub.model.mutate('m', (l) => L.focusPane(l, 't1'));
    noteFocus({ m: 'm', pane: 't1' });
    runMenuCommand('code.open');
    await vi.waitFor(() => expect(hub.layout('m')?.workspaces[0].tabs).toHaveLength(2));
    const key = L.codeViews(L.parseLayout(hub.layout('m')).workspaces[0])[0].key;
    const id = key.slice('code:'.length);
    noteFocus({ m: 'm', pane: key });
    useFrames.setState({ frames: { [`m|${id}`]: { m: 'm', id, folder: '/srv/app', load: 0 } } });
    const iframe = document.createElement('iframe');
    iframe.className = 'code-frame';
    iframe.dataset.frame = `m|${id}`;
    const header = document.createElement('div');
    header.className = 'pane-header';
    header.tabIndex = 0;
    header.dataset.m = 'm';
    header.dataset.pane = key;
    document.body.append(iframe, header);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      // From a window whose pane does not have the keyboard: nothing.
      leaveWindowPane('m', 'w1', ['/srv/app']);
      expect(document.activeElement).not.toBe(header);
      iframe.focus();
      // Nor while a dialog is open.
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      document.body.append(backdrop);
      leaveWindowPane('m', 'w1', ['/srv/app']);
      backdrop.remove();
      expect(document.activeElement).toBe(iframe);
      const before = JSON.stringify(hub.layout('m'));
      leaveWindowPane('m', 'w1', ['/srv/app']);
      expect(document.activeElement).toBe(header);
      // The pane had the focus already: the layout is as it was.
      await settle();
      expect(JSON.stringify(hub.layout('m'))).toBe(before);
      // There code.open shows the pane focused before VS Code.
      runMenuCommand('code.open');
      await vi.waitFor(() => expect(hub.layout('m')?.workspaces[0].selected).toBe(0));
      expect(hub.layout('m')?.workspaces[0].tabs[0].focused).toBe('t1');
      expect(L.codeViews(L.parseLayout(hub.layout('m')).workspaces[0])).toHaveLength(1);
    } finally {
      hasFocus.mockRestore();
      iframe.remove();
      header.remove();
      resetHistory();
    }
  });

  it('opens VS Code for the focused terminal as a tab, and selects it again', async () => {
    runMenuCommand('code.open');
    await vi.waitFor(() => expect(hub.layout('m')?.workspaces[0].tabs).toHaveLength(2));
    const views = () => L.codeViews(L.parseLayout(hub.layout('m')).workspaces[0]);
    expect(views().map((v) => [v.view.folder, v.tab])).toEqual([['/srv/app', 1]]);
    hub.model.mutate('m', (l) => L.selectTab(l, 'wwwwwwww', 0));
    runMenuCommand('code.open');
    await vi.waitFor(() => expect(hub.layout('m')?.workspaces[0].selected).toBe(1));
    expect(views()).toHaveLength(1);
  });

  it('ignores unknown commands', () => {
    const calls = hub.calls.length;
    runMenuCommand('nope.command');
    expect(useDialog.getState().current).toBeUndefined();
    expect(hub.calls.length).toBe(calls);
  });

  it('names the commands whose menu items cannot run now', async () => {
    // Two panes in one tab, one tab, one workspace.
    let off = disabledCommands();
    for (const id of ['tab.next', 'tab.previous', 'workspace.next', 'tab.select1', 'app.agentAttention']) expect(off, id).toContain(id);
    for (const id of ['tab.new', 'tab.close', 'pane.close', 'pane.zoom', 'pane.focusNext', 'find.open', 'app.settings'])
      expect(off, id).not.toContain(id);
    // While a dialog is open, only the commands for dialogs and everywhere run.
    useStore.getState().openSettings({});
    off = disabledCommands();
    expect(off).toContain('tab.new');
    expect(off).toContain('code.open');
    useStore.getState().openSettings(false);
    // Read-only: nothing that changes anything.
    useStore.getState().setReadOnly(true);
    off = disabledCommands();
    for (const id of ['tab.new', 'pane.splitRight', 'tab.close', 'workspace.new', 'app.addMachine']) expect(off, id).toContain(id);
    useStore.getState().setReadOnly(false);
  });
});
