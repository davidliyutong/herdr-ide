// @vitest-environment jsdom
//
// The "system" theme follows the system's theme without the settings
// changing. In the desktop app that happens right after switching from
// "dark" to "system": the shell's nativeTheme.themeSource turns from dark to
// system, and only then does the page's color-scheme query change. The pane
// surface draws with useThemeKind, so it must re-render then.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { usePrefs } from '../prefs';
import { fakeSettingsApi } from './fakeSettings';
import { appearanceOf, initAppearance, useSystemDark, useThemeKind } from '../appearance';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  return createElement('span', null, useThemeKind());
}

describe('useThemeKind', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    useSystemDark.setState({ dark: true });
    fakeSettingsApi();
    usePrefs.getState().setPref('theme', 'dark');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('turns light when the system does after switching from dark to system', async () => {
    expect(host.textContent).toBe('dark');
    // The setting changes first, while the system still reads dark.
    await act(async () => usePrefs.getState().setPref('theme', 'system'));
    expect(host.textContent).toBe('dark');
    await act(async () => useSystemDark.setState({ dark: false }));
    expect(host.textContent).toBe('light');
    expect(appearanceOf(usePrefs.getState().prefs).theme).toBe('light');
  });

  it('ignores the system when the setting names a theme', async () => {
    await act(async () => useSystemDark.setState({ dark: false }));
    expect(host.textContent).toBe('dark');
    await act(async () => usePrefs.getState().setPref('theme', 'light'));
    await act(async () => useSystemDark.setState({ dark: true }));
    expect(host.textContent).toBe('light');
  });

  it('applies separate UI and monospace English/CJK font stacks to root CSS and clears on reset', async () => {
    initAppearance();
    await act(async () => {
      usePrefs.getState().setPref('uiFontFamily', 'Inter');
      usePrefs.getState().setPref('uiCjkFontFamily', 'LXGW WenKai');
      usePrefs.getState().setPref('termFontFamily', 'Fira Code');
      usePrefs.getState().setPref('termCjkFontFamily', 'Sarasa Mono SC');
    });
    const rootStyle = document.documentElement.style;
    expect(rootStyle.fontFamily).toContain('Inter');
    expect(rootStyle.fontFamily).toContain('LXGW WenKai');
    expect(rootStyle.fontFamily.indexOf('Inter')).toBeLessThan(rootStyle.fontFamily.indexOf('LXGW WenKai'));
    const mono = rootStyle.getPropertyValue('--mono');
    expect(mono).toContain('Fira Code');
    expect(mono).toContain('Sarasa Mono SC');
    expect(mono.indexOf('Fira Code')).toBeLessThan(mono.indexOf('Sarasa Mono SC'));

    await act(async () => {
      usePrefs.getState().setPref('uiFontFamily', '');
      usePrefs.getState().setPref('uiCjkFontFamily', '');
      usePrefs.getState().setPref('termFontFamily', '');
      usePrefs.getState().setPref('termCjkFontFamily', '');
    });
    expect(rootStyle.fontFamily).toBe('');
    expect(rootStyle.getPropertyValue('--mono')).toBe('');
  });
});
