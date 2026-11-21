// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The page runs in the desktop app: its shell zooms the windows to the setting.
vi.mock('../shell', () => ({
  desktopShell: { onCommand: () => () => {}, pathForFile: () => '', onOpenFolders: () => () => {}, setDisabledCommands: () => {} },
}));
vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useSettings } from '../settings';
import { useKeys } from '../keybindings';
import { useStore } from '../state/store';
import { commandEnabled, handleKey, runCommand } from '../keymap';
import '../commands';
import { currentZoom, zoomStep, ZOOM_LEVELS } from '../zoom';
import { fakeSettingsApi } from './fakeSettings';

describe('zoom levels', () => {
  it('steps through the levels browsers use and stops at the ends', () => {
    expect(zoomStep(100, 1)).toBe(110);
    expect(zoomStep(100, -1)).toBe(90);
    expect(zoomStep(110, 1)).toBe(125);
    expect(zoomStep(67, -1)).toBe(50);
    // A zoom typed in the settings goes to the nearest level that way.
    expect(zoomStep(105, 1)).toBe(110);
    expect(zoomStep(105, -1)).toBe(100);
    expect(zoomStep(300, 1)).toBe(300);
    expect(zoomStep(50, -1)).toBe(50);
    expect(ZOOM_LEVELS).toContain(100);
  });
});

describe('the zoom commands', () => {
  const requests: Array<{ method?: string; url: string; body?: unknown }> = [];
  const zoomTo = (v: number) =>
    useSettings.setState({
      values: { ...useSettings.getState().values, 'window.zoom': { value: v, source: v === 100 ? 'default' : 'global' } },
    });

  beforeEach(() => {
    fakeSettingsApi();
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      requests.push({ method: init?.method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === 'DELETE') {
        const values = { ...useSettings.getState().values, 'window.zoom': { value: 100, source: 'default' } };
        return Promise.resolve(new Response(JSON.stringify({ values, problems: [] }), { status: 200 }));
      }
      return fetch(url, init);
    });
    useKeys.setState({
      effective: [
        { key: 'cmd+shift+equal', command: 'view.zoomIn', when: 'always' },
        { key: 'cmd+equal', command: 'view.zoomIn', when: 'always' },
        { key: 'cmd+minus', command: 'view.zoomOut', when: 'always' },
        { key: 'cmd+0', command: 'view.zoomReset', when: 'always' },
      ],
    });
    zoomTo(100);
  });
  afterEach(() => {
    requests.length = 0;
    vi.unstubAllGlobals();
  });

  it('change the setting, which the shell applies', async () => {
    runCommand('view.zoomIn');
    expect(currentZoom()).toBe(110);
    runCommand('view.zoomIn');
    expect(currentZoom()).toBe(125);
    runCommand('view.zoomOut');
    await vi.waitFor(() => expect(requests.length).toBe(3));
    expect(requests.map((r) => r.body)).toEqual([
      { key: 'window.zoom', value: 110 },
      { key: 'window.zoom', value: 125 },
      { key: 'window.zoom', value: 110 },
    ]);
    runCommand('view.zoomReset');
    await vi.waitFor(() => expect(requests.at(-1)?.method).toBe('DELETE'));
    expect(requests.at(-1)?.url).toBe('/api/settings?key=window.zoom');
    await vi.waitFor(() => expect(currentZoom()).toBe(100));
  });

  it('are enabled while they change something, never in read-only mode', () => {
    expect(commandEnabled('view.zoomIn')).toBe(true);
    expect(commandEnabled('view.zoomOut')).toBe(true);
    expect(commandEnabled('view.zoomReset')).toBe(false);
    zoomTo(300);
    expect(commandEnabled('view.zoomIn')).toBe(false);
    expect(commandEnabled('view.zoomReset')).toBe(true);
    zoomTo(50);
    expect(commandEnabled('view.zoomOut')).toBe(false);
    useStore.setState({ readOnly: true });
    expect(commandEnabled('view.zoomIn')).toBe(false);
    useStore.setState({ readOnly: false });
  });

  it('take their keys from the terminal while bound, and leave them when not', () => {
    const key = (k: string, code: string, shift = false) =>
      new KeyboardEvent('keydown', { key: k, code, metaKey: true, shiftKey: shift, cancelable: true });
    // ⌘+ on a US layout is Cmd+Shift+=.
    const plus = key('+', 'Equal', true);
    expect(handleKey(plus, 'terminal')).toBe(true);
    expect(plus.defaultPrevented).toBe(true);
    expect(handleKey(key('0', 'Digit0'), 'dialog')).toBe(true);
    expect(handleKey(key('-', 'Minus'), 'vscode')).toBe(true);
    useKeys.setState({ effective: [] });
    const unbound = key('=', 'Equal');
    expect(handleKey(unbound, 'terminal')).toBe(false);
    expect(unbound.defaultPrevented).toBe(false);
  });
});
