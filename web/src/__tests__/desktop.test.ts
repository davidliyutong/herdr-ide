// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { keyName } from '../keys';
import { runMenuCommand } from '../desktop';
import { useDialog } from '../dialog';
import { useStore, currentDock } from '../state/store';
import type { MachineState } from '../lib/machine';
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

  it('runs only commands for VS Code or everywhere while VS Code has the keyboard', async () => {
    const frame = document.createElement('iframe');
    frame.className = 'code-frame';
    document.body.append(frame);
    frame.focus();
    expect(document.activeElement).toBe(frame);
    useStore.getState().openSettings(false);
    runMenuCommand('app.settings');
    runMenuCommand('tab.close');
    await settle();
    expect(useStore.getState().settingsOpen).toBe(false);
    expect(killed()).toEqual([]);
    // Showing or hiding the VS Code panel is for everywhere.
    useStore.getState().openDock({ kind: 'code', m: 'm', folder: '/srv/app' });
    runMenuCommand('view.toggleCode');
    expect(currentDock(useStore.getState())).toBeUndefined();
  });

  it('opens the settings', () => {
    useStore.getState().openSettings(false);
    runMenuCommand('app.settings');
    expect(useStore.getState().settingsOpen).toBe(true);
    useStore.getState().openSettings(false);
  });

  it('asks for a new workspace', () => {
    runMenuCommand('workspace.new');
    expect(useDialog.getState().current?.kind).toBe('newWorkspace');
  });

  it('shows and hides the VS Code panel, coming back to the one shown last', () => {
    const s = useStore.getState();
    s.openDock(undefined);
    useStore.setState({ docks: {} });
    // Nothing shown before: the focused terminal's folder opens.
    runMenuCommand('view.toggleCode');
    expect(currentDock(useStore.getState())).toEqual({ kind: 'code', m: 'm', folder: '/srv/app' });
    runMenuCommand('view.toggleCode');
    expect(currentDock(useStore.getState())).toBeUndefined();
    // The panel shown last comes back, as it was.
    s.openDock({ kind: 'code', m: 'm', folder: '/srv/app' });
    runMenuCommand('view.toggleCode');
    expect(currentDock(useStore.getState())).toBeUndefined();
    runMenuCommand('view.toggleCode');
    expect(currentDock(useStore.getState())).toEqual({ kind: 'code', m: 'm', folder: '/srv/app' });
    // A preview panel hides too.
    s.openDock({ kind: 'preview', m: 'm', path: '/srv/a.png' });
    runMenuCommand('view.toggleCode');
    expect(currentDock(useStore.getState())).toBeUndefined();
    // Another machine's last panel is not brought back.
    s.openDock({ kind: 'code', m: 'other', folder: '/x' });
    s.openDock(undefined);
    runMenuCommand('view.toggleCode');
    expect(currentDock(useStore.getState())).toEqual({ kind: 'code', m: 'm', folder: '/srv/app' });
    s.openDock(undefined);
  });

  it('ignores unknown commands', () => {
    const calls = core.calls.length;
    runMenuCommand('nope.command');
    expect(useDialog.getState().current).toBeUndefined();
    expect(core.calls.length).toBe(calls);
  });
});
