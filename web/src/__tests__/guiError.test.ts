// @vitest-environment jsdom
//
// A failed display in the status bar shows the hub's error when clicked,
// not only in a tooltip.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { api: () => Promise.resolve({}), setTheme: () => {} } }));

import { GuiTray } from '../gui/GuiMenus';
import { useGui } from '../gui/state';
import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';

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
    // The settings button opens the machine's settings, where its display
    // can be turned off.
    act(() => note.click());
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.gui-error-actions button')];
    expect(buttons).toHaveLength(3);
    act(() => buttons[1].click());
    expect(useStore.getState().settings?.page).toBe('gui');
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
    // The hub reports the display as disconnected once the machine is.
    machine('ready');
    act(() => useGui.getState().setState({ m: 'ws2', phase: 'disconnected', windows: [] }));
    expect(host.querySelector('.gui-note')).toBeNull();
  });
});

describe('program windows', () => {
  it('lists the windows of several machines in a searchable list and opens the one chosen', async () => {
    useStore
      .getState()
      .setMachines([
        { id: 'ws2', label: 'ws2', kind: 'ssh', status: 'ready' } as unknown as MachineState,
        { id: 'gpu', label: 'gpu', kind: 'ssh', status: 'ready' } as unknown as MachineState,
      ]);
    useGui.setState({
      machines: {
        ws2: { m: 'ws2', phase: 'ready', windows: [{ id: 1, title: 'xterm', w: 640, h: 480 }] },
        gpu: {
          m: 'gpu',
          phase: 'ready',
          windows: [
            { id: 2, title: 'paraview', w: 800, h: 600 },
            { id: 3, title: '', w: 300, h: 200 },
          ],
        },
      },
    });
    const opened = vi.fn(() => ({ focus() {} }) as unknown as Window);
    vi.stubGlobal('open', opened);
    const host = renderTray();
    const button = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
    button.focus();
    await act(async () => button.click());
    const rows = () => [...document.body.querySelectorAll<HTMLElement>('.picker-row, .picker-group')].map((r) => r.textContent);
    expect(rows()).toEqual(['ws2', 'xterm640×480', 'gpu', 'paraview800×600', 'Untitled window300×200']);
    const search = document.body.querySelector<HTMLInputElement>('.picker-search')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'para');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows()).toEqual(['gpu', 'paraview800×600']);
    await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(opened).toHaveBeenCalledWith(expect.stringContaining('/m/gpu/gui/2'), expect.any(String), expect.any(String));
    expect(document.activeElement).toBe(button);
    vi.unstubAllGlobals();
  });
});
