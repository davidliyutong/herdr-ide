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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

describe('display error', () => {
  it('opens the error on click and closes on Escape', () => {
    const error = 'xvfb: exit status 1: cannot open /dev/dri';
    useGui.setState({ machines: { ws2: { m: 'ws2', phase: 'error', error, windows: [] } } });
    const host = document.createElement('footer');
    host.className = 'statusbar';
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(GuiTray)));
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
    expect(buttons).toHaveLength(2);
    act(() => buttons[1].click());
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(host.querySelector('.gui-error')).toBeNull();
  });
});
