// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve({}));
vi.mock('../lib/conn', () => ({ conn: { api: (...a: unknown[]) => api(...a), setTheme: () => {} } }));

import { keyName } from '../shortcutKey';
import { altOnly, runShortcut, shortcutConflict } from '../desktop';
import { useDialog } from '../dialog';
import { PROCESS_INFO_TIMEOUT_MS } from '../actions';
import { useStore } from '../state/store';
import type { MachineState } from '../lib/herdr';

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

describe('shortcut conflicts', () => {
  const list = [
    { key: 'desktop-new-tab-key', value: 'cmd+t' },
    { key: 'desktop-close-tab-key', value: 'cmd+w' },
  ];
  it('refuses another action’s key and herdr’s prefix', () => {
    expect(shortcutConflict('desktop-close-tab-key', 'cmd+t', list, 'ctrl+b')).toEqual({
      message: 'settings.shortcut.taken',
      action: 'new_tab',
    });
    expect(
      shortcutConflict('desktop-new-tab-key', 'shift+cmd+w', [list[0], { key: 'desktop-close-tab-key', value: 'cmd+shift+w' }], 'ctrl+b')
        ?.action,
    ).toBe('close_tab');
    expect(shortcutConflict('desktop-new-tab-key', 'ctrl+b', list, 'ctrl+b')).toEqual({ message: 'settings.shortcut.prefix' });
  });
  it('accepts free keys, its own key, none and reset', () => {
    expect(shortcutConflict('desktop-new-tab-key', 'cmd+t', list, 'ctrl+b')).toBeUndefined();
    expect(shortcutConflict('desktop-new-tab-key', 'cmd+shift+t', list, 'ctrl+b')).toBeUndefined();
    expect(
      shortcutConflict('desktop-new-tab-key', 'none', [list[0], { key: 'desktop-close-tab-key', value: 'none' }], 'ctrl+b'),
    ).toBeUndefined();
    expect(shortcutConflict('desktop-new-tab-key', '', list, 'ctrl+b')).toBeUndefined();
  });
  it('flags Alt shortcuts without cmd or ctrl', () => {
    expect(altOnly('alt+t')).toBe(true);
    expect(altOnly('alt+shift+t')).toBe(true);
    expect(altOnly('cmd+alt+t')).toBe(false);
    expect(altOnly('cmd+t')).toBe(false);
  });
});

function machine(): MachineState {
  return {
    id: 'm',
    label: 'm',
    status: 'ready',
    snapshot: {
      workspaces: [{ workspace_id: 'w1', active_tab_id: 't1' }],
      tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
      panes: [
        { pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', agent_status: 'unknown' },
        { pane_id: 'p2', workspace_id: 'w1', tab_id: 't1', agent_status: 'unknown' },
      ],
    },
  } as unknown as MachineState;
}

describe('runShortcut', () => {
  beforeEach(() => {
    api.mockClear();
    const s = useStore.getState();
    s.upsertMachine(machine());
    s.selectWorkspace('m', 'w1');
    s.focusPane({ m: 'm', pane: 'p1' });
  });
  afterEach(() => {
    useDialog.setState({ current: undefined });
    document.body.innerHTML = '';
  });

  // herdr's pane.process_info for a pane: its shell waiting at the prompt,
  // or a program in front of it.
  const shell = { process_info: { shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: '-zsh' }] } };
  const running = (name: string) => ({
    process_info: {
      shell_pid: 10,
      foreground_process_group_id: 20,
      foreground_processes: [
        { pid: 21, name: 'cat' },
        { pid: 20, name },
      ],
    },
  });
  const answer = (byPane: Record<string, unknown>) =>
    api.mockImplementation((_m, method, params) => {
      if (method !== 'pane.process_info') return Promise.resolve({});
      const r = byPane[(params as { pane_id: string }).pane_id];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
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
  afterEach(() => api.mockImplementation(() => Promise.resolve({})));

  it('closes a tab at once when its panes only have shells at the prompt', async () => {
    answer({ p1: shell, p2: Object.assign(new Error('pane not found'), { code: 'pane_not_found' }) });
    runShortcut('close_tab');
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('m', 'tab.close', { tab_id: 't1' }));
    expect(dialog()).toBeUndefined();
  });

  it('asks before closing a tab with a program running, naming it', async () => {
    answer({ p1: shell, p2: running('vim') });
    runShortcut('close_tab');
    expect(await reply(false)).toBe('Closing this tab ends the programs still running in it: vim.');
    expect(api).not.toHaveBeenCalledWith('m', 'tab.close', expect.anything());

    // An agent waiting for input still runs: it goes by its name.
    const mach = machine();
    mach.snapshot!.panes[0] = { ...mach.snapshot!.panes[0], agent: 'claude', agent_status: 'idle' };
    useStore.getState().upsertMachine(mach);
    answer({ p1: running('node'), p2: shell });
    runShortcut('close_tab');
    expect(await reply(true)).toContain(': claude.');
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('m', 'tab.close', { tab_id: 't1' }));
  });

  it('asks when herdr cannot tell what runs, or a pane was started with another program', async () => {
    answer({ p1: shell, p2: new Error('unknown method') });
    runShortcut('close_tab');
    expect(await reply(false)).toContain('2');
    expect(api).not.toHaveBeenCalledWith('m', 'tab.close', expect.anything());

    answer({
      p1: shell,
      p2: { process_info: { shell_pid: 30, foreground_process_group_id: 30, foreground_processes: [{ pid: 30, name: 'htop' }] } },
    });
    runShortcut('close_tab');
    expect(await reply(false)).toContain(': htop.');
  });

  it('asks when herdr does not answer in time', async () => {
    vi.useFakeTimers();
    try {
      api.mockImplementation((_m, method) => (method === 'pane.process_info' ? new Promise(() => {}) : Promise.resolve({})));
      runShortcut('close_tab');
      // A second key while the first is pending does nothing.
      runShortcut('close_tab');
      await vi.advanceTimersByTimeAsync(PROCESS_INFO_TIMEOUT_MS);
      expect(dialog()?.kind).toBe('confirm');
      expect(api.mock.calls.filter((c) => c[1] === 'pane.process_info')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
    await reply(false);
  });

  it('does nothing while a dialog is open', () => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    document.body.append(backdrop);
    runShortcut('close_tab');
    runShortcut('new_tab');
    expect(useDialog.getState().current).toBeUndefined();
    expect(api).not.toHaveBeenCalled();
  });

  it('opens the settings', () => {
    useStore.getState().openSettings(false);
    runShortcut('open_settings');
    expect(useStore.getState().settingsOpen).toBe(true);
    useStore.getState().openSettings(false);
  });

  it('asks for a new workspace', () => {
    runShortcut('new_workspace');
    expect(useDialog.getState().current?.kind).toBe('newWorkspace');
  });

  it('shows and hides the VS Code panel, coming back to the one shown last', () => {
    const s = useStore.getState();
    s.openDock(undefined);
    useStore.setState({ lastCode: undefined });
    // Nothing shown before: the focused pane's folder opens.
    runShortcut('toggle_code');
    expect(useStore.getState().dock).toEqual({ kind: 'code', m: 'm', folder: undefined });
    runShortcut('toggle_code');
    expect(useStore.getState().dock).toBeUndefined();
    // The panel shown last comes back, as it was.
    s.openDock({ kind: 'code', m: 'm', folder: '/srv/app' });
    runShortcut('toggle_code');
    expect(useStore.getState().dock).toBeUndefined();
    runShortcut('toggle_code');
    expect(useStore.getState().dock).toEqual({ kind: 'code', m: 'm', folder: '/srv/app' });
    // A preview panel hides too.
    s.openDock({ kind: 'preview', m: 'm', path: '/srv/a.png' });
    runShortcut('toggle_code');
    expect(useStore.getState().dock).toBeUndefined();
    // Another machine's last panel is not brought back.
    useStore.setState({ lastCode: { kind: 'code', m: 'other', folder: '/x' } });
    runShortcut('toggle_code');
    expect(useStore.getState().dock).toEqual({ kind: 'code', m: 'm', folder: undefined });
    s.openDock(undefined);
  });

  it('ignores unknown actions', () => {
    runShortcut('close_workspace');
    expect(useDialog.getState().current).toBeUndefined();
    expect(api).not.toHaveBeenCalled();
  });
});
