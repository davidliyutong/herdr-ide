// @vitest-environment jsdom
//
// A failed display in the status bar shows the core's error when clicked,
// not only in a tooltip.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { api: () => Promise.resolve({}), setTheme: () => {} } }));

import { GuiTray } from '../gui/GuiMenus';
import { useGui } from '../gui/state';
import { useStore } from '../state/store';
import type { MachineState } from '../lib/herdr';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  useGui.setState({ machines: {}, dismissed: {} });
});

const machine = (status: string) =>
  useStore.getState().setMachines([{ id: 'ws2', label: 'ws2', kind: 'ssh', status, saved: true } as unknown as MachineState]);

function renderTray() {
  const host = document.createElement('footer');
  host.className = 'statusbar';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(GuiTray)));
  return host;
}

describe('display error', () => {
  it('opens the error on click and closes on Escape', () => {
    const error = 'xvfb: exit status 1: cannot open /dev/dri';
    machine('ready');
    useGui.setState({ machines: { ws2: { m: 'ws2', phase: 'error', error, windows: [] } } });
    const host = renderTray();
    const note = host.querySelector<HTMLButtonElement>('button.gui-note.error')!;
    expect(note).not.toBeNull();
    expect(host.querySelector('.gui-error')).toBeNull();
    act(() => note.click());
    expect(host.querySelector('.gui-error-text')?.textContent).toBe(error);
    expect(note.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(host.querySelector('.gui-error')).toBeNull();
    // The settings button opens the settings, where the machine's display
    // can be turned off.
    act(() => note.click());
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.gui-error-actions button')];
    expect(buttons).toHaveLength(3);
    act(() => buttons[1].click());
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(host.querySelector('.gui-error')).toBeNull();
  });

  it('dismisses the error until the display fails again after recovering', () => {
    machine('ready');
    const st = (phase: 'error' | 'ready') => ({ m: 'ws2', phase, error: phase === 'error' ? 'boom' : undefined, windows: [] });
    act(() => useGui.getState().setState(st('error')));
    const host = renderTray();
    act(() => host.querySelector<HTMLButtonElement>('button.gui-note.error')!.click());
    const dismiss = [...host.querySelectorAll<HTMLButtonElement>('.gui-error-actions button')].at(-1)!;
    act(() => dismiss.click());
    expect(host.querySelector('button.gui-note.error')).toBeNull();
    // Retrying fails again: still hidden.
    act(() => useGui.getState().setState(st('error')));
    expect(host.querySelector('button.gui-note.error')).toBeNull();
    // Recovered, then failed: shown again.
    act(() => useGui.getState().setState(st('ready')));
    act(() => useGui.getState().setState(st('error')));
    expect(host.querySelector('button.gui-note.error')).not.toBeNull();
  });

  it('shows nothing for a machine that is not connected', () => {
    machine('disabled');
    useGui.setState({ machines: { ws2: { m: 'ws2', phase: 'error', error: 'boom', windows: [] } } });
    const host = renderTray();
    expect(host.querySelector('.gui-note')).toBeNull();
    // The core reports the display as disconnected once the machine is.
    machine('ready');
    act(() => useGui.getState().setState({ m: 'ws2', phase: 'disconnected', windows: [] }));
    expect(host.querySelector('.gui-note')).toBeNull();
  });
});
