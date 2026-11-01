// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve({}));
vi.mock('../lib/conn', () => ({ conn: { api: (...a: unknown[]) => api(...a), setTheme: () => {} } }));

import { keyName } from '../shortcutKey';
import { altOnly, runShortcut, shortcutConflict } from '../desktop';
import { useDialog } from '../dialog';
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

  it('asks before closing a tab, even without working agents', async () => {
    runShortcut('close_tab');
    const req = useDialog.getState().current;
    expect(req?.kind).toBe('confirm');
    if (req?.kind === 'confirm') {
      expect(req.message).toContain('2');
      req.resolve(false);
    }
    await Promise.resolve();
    expect(api).not.toHaveBeenCalledWith('m', 'tab.close', expect.anything());

    runShortcut('close_tab');
    const again = useDialog.getState().current;
    if (again?.kind === 'confirm') again.resolve(true);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('m', 'tab.close', { tab_id: 't1' }));
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

  it('ignores unknown actions', () => {
    runShortcut('close_workspace');
    expect(useDialog.getState().current).toBeUndefined();
    expect(api).not.toHaveBeenCalled();
  });
});
