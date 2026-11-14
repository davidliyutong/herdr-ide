// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve({}));
vi.mock('../lib/conn', () => ({ conn: { api: (...a: unknown[]) => api(...a), setTheme: () => {} } }));

import { keyName } from '../keys';
import { runShortcut } from '../desktop';
import { useDialog } from '../dialog';
import { PROCESS_INFO_TIMEOUT_MS } from '../actions';
import { useStore, currentDock } from '../state/store';
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
    runShortcut('tab.close');
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('m', 'tab.close', { tab_id: 't1' }));
    expect(dialog()).toBeUndefined();
  });

  it('asks before closing a tab with a program running, naming it', async () => {
    answer({ p1: shell, p2: running('vim') });
    runShortcut('tab.close');
    expect(await reply(false)).toBe('Closing this tab ends the programs still running in it: vim.');
    expect(api).not.toHaveBeenCalledWith('m', 'tab.close', expect.anything());

    // An agent waiting for input still runs: it goes by its name.
    const mach = machine();
    mach.snapshot!.panes[0] = { ...mach.snapshot!.panes[0], agent: 'claude', agent_status: 'idle' };
    useStore.getState().upsertMachine(mach);
    answer({ p1: running('node'), p2: shell });
    runShortcut('tab.close');
    expect(await reply(true)).toContain(': claude.');
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('m', 'tab.close', { tab_id: 't1' }));
  });

  it('asks when herdr cannot tell what runs, or a pane was started with another program', async () => {
    answer({ p1: shell, p2: new Error('unknown method') });
    runShortcut('tab.close');
    expect(await reply(false)).toContain('2');
    expect(api).not.toHaveBeenCalledWith('m', 'tab.close', expect.anything());

    answer({
      p1: shell,
      p2: { process_info: { shell_pid: 30, foreground_process_group_id: 30, foreground_processes: [{ pid: 30, name: 'htop' }] } },
    });
    runShortcut('tab.close');
    expect(await reply(false)).toContain(': htop.');
  });

  it('asks when herdr does not answer in time', async () => {
    vi.useFakeTimers();
    try {
      api.mockImplementation((_m, method) => (method === 'pane.process_info' ? new Promise(() => {}) : Promise.resolve({})));
      runShortcut('tab.close');
      // A second key while the first is pending does nothing.
      runShortcut('tab.close');
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
    runShortcut('tab.close');
    runShortcut('tab.new');
    expect(useDialog.getState().current).toBeUndefined();
    expect(api).not.toHaveBeenCalled();
  });

  it('opens the settings', () => {
    useStore.getState().openSettings(false);
    runShortcut('app.settings');
    expect(useStore.getState().settingsOpen).toBe(true);
    useStore.getState().openSettings(false);
  });

  it('asks for a new workspace', () => {
    runShortcut('workspace.new');
    expect(useDialog.getState().current?.kind).toBe('newWorkspace');
  });

  it('shows and hides the VS Code panel, coming back to the one shown last', () => {
    const s = useStore.getState();
    s.openDock(undefined);
    useStore.setState({ docks: {} });
    // Nothing shown before: the focused pane's folder opens.
    runShortcut('view.toggleCode');
    expect(currentDock(useStore.getState())).toEqual({ kind: 'code', m: 'm', folder: undefined });
    runShortcut('view.toggleCode');
    expect(currentDock(useStore.getState())).toBeUndefined();
    // The panel shown last comes back, as it was.
    s.openDock({ kind: 'code', m: 'm', folder: '/srv/app' });
    runShortcut('view.toggleCode');
    expect(currentDock(useStore.getState())).toBeUndefined();
    runShortcut('view.toggleCode');
    expect(currentDock(useStore.getState())).toEqual({ kind: 'code', m: 'm', folder: '/srv/app' });
    // A preview panel hides too.
    s.openDock({ kind: 'preview', m: 'm', path: '/srv/a.png' });
    runShortcut('view.toggleCode');
    expect(currentDock(useStore.getState())).toBeUndefined();
    // Another machine's last panel is not brought back.
    s.openDock({ kind: 'code', m: 'other', folder: '/x' });
    s.openDock(undefined);
    runShortcut('view.toggleCode');
    expect(currentDock(useStore.getState())).toEqual({ kind: 'code', m: 'm', folder: undefined });
    s.openDock(undefined);
  });

  it('ignores unknown commands', () => {
    runShortcut('nope.command');
    expect(useDialog.getState().current).toBeUndefined();
    expect(api).not.toHaveBeenCalled();
  });
});
