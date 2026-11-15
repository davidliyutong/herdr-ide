// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { keyName } from '../keys';
import { disabledCommands, runMenuCommand } from '../desktop';
import { handleFrameKey } from '../keymap';
import { useKeys, type Binding } from '../keybindings';
import registry from '../../../design/generated/registry.json';
import { useDialog } from '../dialog';
import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { resetFrames, useFrames } from '../codeFrames';
import { FakeCore, settle } from './fakeTerms';

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
  FakeCore.term(address, { pid: 10, foreground: { pid: 10, name: 'zsh', argv: ['-zsh'], cwd: '/srv/app' }, ...extra });
const running = (address: string, name: string, extra: Record<string, unknown> = {}) =>
  FakeCore.term(address, { pid: 10, foreground: { pid: 20, name, argv: [name], cwd: '/srv/app' }, ...extra });

describe('runMenuCommand', () => {
  let core: FakeCore;
  const setup = async (terminals: Array<Record<string, unknown> & { address: string }>) => {
    core = new FakeCore();
    core.machine('m', terminals, layout());
    core.install();
    const s = useStore.getState();
    s.upsertMachine({ id: 'm', label: 'm', kind: 'local', status: 'ready' } as unknown as MachineState);
    s.selectMachine('m');
    core.model.subscribe('m');
    await settle();
  };
  beforeEach(() => setup([shell('t1'), shell('t2')]));
  afterEach(() => {
    useDialog.setState({ current: undefined });
    document.body.innerHTML = '';
  });

  const dialog = () => useDialog.getState().current;
  /** Answers the confirmation shown, as Dialogs.tsx does, and returns its
   * message. */
  const reply = async (ok: boolean) => {
    await vi.waitFor(() => expect(dialog()?.kind).toBe('confirm'));
    const req = dialog()!;
    useDialog.setState({ current: undefined });
    if (req.kind !== 'confirm') throw new Error(req.kind);
    req.resolve(ok);
    await new Promise((r) => setTimeout(r));
    return req.message;
  };
  const killed = () => core.calls.filter((c) => c.method === 'terminal.kill').map((c) => c.params.terminal);

  it('closes a tab at once when its terminals only have shells at the prompt', async () => {
    runMenuCommand('tab.close');
    await vi.waitFor(() => expect(killed()).toEqual(['t1', 't2']));
    expect(dialog()).toBeUndefined();
    await settle();
    expect(core.layout('m')?.workspaces[0].tabs).toEqual([]);
  });

  it('asks before closing a tab with a program running, naming it', async () => {
    await setup([shell('t1'), running('t2', 'vim')]);
    runMenuCommand('tab.close');
    expect(await reply(false)).toBe('Closing this tab ends the programs still running in it: vim.');
    expect(killed()).toEqual([]);

    // An agent waiting for input still runs: it goes by its name.
    await setup([running('t1', 'node', { agent: 'claude', agent_status: 'idle' }), shell('t2')]);
    runMenuCommand('tab.close');
    expect(await reply(true)).toContain(': claude.');
    await vi.waitFor(() => expect(killed()).toEqual(['t1', 't2']));
  });

  it('asks before closing a pane with a program running; a shell closes at once', async () => {
    await setup([running('t1', 'htop'), shell('t2')]);
    runMenuCommand('pane.close');
    expect(await reply(false)).toBe('Closing this pane ends the program still running in it: htop.');
    expect(killed()).toEqual([]);
    core.model.mutate('m', (l) => ({ ...l, workspaces: [{ ...l.workspaces[0], tabs: [{ ...l.workspaces[0].tabs[0], focused: 't2' }] }] }));
    runMenuCommand('pane.close');
    await vi.waitFor(() => expect(killed()).toEqual(['t2']));
    await settle();
    expect(core.layout('m')?.workspaces[0].tabs[0].root).toEqual({ terminal: 't1' });
  });

  it('does nothing while a dialog is open', async () => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    document.body.append(backdrop);
    runMenuCommand('tab.close');
    runMenuCommand('tab.new');
    await settle();
    expect(useDialog.getState().current).toBeUndefined();
    expect(core.calls.filter((c) => c.method.startsWith('terminal.'))).toEqual([]);
  });

  it("runs the main UI's commands for the VS Code pane that has the keyboard: cmd+w closes it", async () => {
    core.model.mutate('m', (l) => L.splitPane(l, 't2', 'vertical', { code: { id: 'c1', folder: '/srv/app' } }));
    // The layout still has t1 focused: the pane whose iframe has the keyboard counts.
    core.model.mutate('m', (l) => L.focusPane(l, 't1'));
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
      expect(L.findLeaf(core.layout('m') as L.Layout, 'code:c1')).toBeNull();
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
    expect(useDialog.getState().current?.kind).toBe('newWorkspace');
  });

  it('takes cmd+w from VS Code before VS Code does: it closes the VS Code pane', async () => {
    core.model.mutate('m', (l) => L.splitPane(l, 't2', 'vertical', { code: { id: 'c1', folder: '/srv/app' } }));
    useKeys.setState({ effective: registry.keybindings.mac as Binding[] });
    try {
      const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });
      const focus = vi.fn(() => core.model.mutate('m', (l) => L.focusPane(l, 'code:c1')));
      // VS Code keeps its other keys.
      expect(handleFrameKey(key({ key: 't', code: 'KeyT', metaKey: true }), focus)).toBe(false);
      expect(handleFrameKey(key({ key: 'j', code: 'KeyJ', metaKey: true }), focus)).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(handleFrameKey(key({ key: 'w', code: 'KeyW', metaKey: true }), focus)).toBe(true);
      expect(focus).toHaveBeenCalled();
      await settle();
      expect(L.findLeaf(core.layout('m') as L.Layout, 'code:c1')).toBeNull();
      expect(killed()).toEqual([]);
    } finally {
      useKeys.setState({ effective: registry.keybindings['pc-browser'] as Binding[] });
    }
  });

  it('opens VS Code for the focused terminal as a tab, and selects it again', async () => {
    runMenuCommand('code.open');
    await vi.waitFor(() => expect(core.layout('m')?.workspaces[0].tabs).toHaveLength(2));
    const views = () => L.codeViews(L.parseLayout(core.layout('m')).workspaces[0]);
    expect(views().map((v) => [v.view.folder, v.tab])).toEqual([['/srv/app', 1]]);
    core.model.mutate('m', (l) => L.selectTab(l, 'wwwwwwww', 0));
    runMenuCommand('code.open');
    await vi.waitFor(() => expect(core.layout('m')?.workspaces[0].selected).toBe(1));
    expect(views()).toHaveLength(1);
  });

  it('ignores unknown commands', () => {
    const calls = core.calls.length;
    runMenuCommand('nope.command');
    expect(useDialog.getState().current).toBeUndefined();
    expect(core.calls.length).toBe(calls);
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
