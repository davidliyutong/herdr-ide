import { describe, expect, it } from 'vitest';
import { xKeycode } from '../gui/keycodes';
import { guiKey, paneWindows, parseGuiPath, useGui, type GuiState } from '../gui/state';
import { serverSection } from '../components/SettingsDialog';

describe('xKeycode', () => {
  it('maps physical keys to evdev keycodes plus 8', () => {
    expect(xKeycode('KeyA')).toBe(38);
    expect(xKeycode('Escape')).toBe(9);
    expect(xKeycode('Space')).toBe(65);
    expect(xKeycode('ArrowLeft')).toBe(113);
    expect(xKeycode('ControlLeft')).toBe(37);
    expect(xKeycode('Unidentified')).toBeUndefined();
  });
});

describe('parseGuiPath', () => {
  it('recognizes the page of a program window', () => {
    expect(parseGuiPath('/m/abc/gui/4194305')).toEqual({ m: 'abc', id: 4194305 });
    expect(parseGuiPath('/m/a%20b/gui/7/')).toEqual({ m: 'a b', id: 7 });
    expect(parseGuiPath('/m/abc/gui/x')).toBeUndefined();
    expect(parseGuiPath('/m/abc/code/')).toBeUndefined();
  });
});

const state = (m: string, ...windows: [number, string?][]): GuiState => ({
  m,
  phase: 'ready',
  windows: windows.map(([id, pane]) => ({ id, title: `w${id}`, w: 100, h: 80, pane })),
});

describe('gui state', () => {
  it('marks windows that appear after the first state as unseen', () => {
    const g = useGui.getState();
    g.setState(state('m1', [1, 'p1']));
    expect(useGui.getState().unseen).toEqual({});
    g.setState(state('m1', [1, 'p1'], [2, 'p1'], [3]));
    expect(Object.keys(useGui.getState().unseen).sort()).toEqual([guiKey('m1', 2), guiKey('m1', 3)]);
    expect(paneWindows(useGui.getState(), 'm1', 'p1').map((w) => w.id)).toEqual([1, 2]);

    g.markSeen('m1', 2);
    expect(Object.keys(useGui.getState().unseen)).toEqual([guiKey('m1', 3)]);
    g.setState(state('m1', [1, 'p1']));
    expect(useGui.getState().unseen).toEqual({});
  });
});

describe('settings sections', () => {
  it('groups the GUI settings', () => {
    expect(serverSection('gui')).toBe('gui');
    expect(serverSection('gui-gpu')).toBe('gui');
    expect(serverSection('code-server-install')).toBe('codeServer');
  });
});
