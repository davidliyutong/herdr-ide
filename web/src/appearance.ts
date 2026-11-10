// Applies the appearance settings: light/dark theme (also sent to the core,
// which switches VS Code windows to match, and to the desktop app's shell,
// whose title bar follows it) and the UI font. The pane surface follows the
// terminal settings itself (components/SurfaceView.tsx).

import { create } from 'zustand';
import { getPrefs, usePrefs, type Prefs } from './prefs';
import { conn } from './lib/conn';
import type { TermFontWeight } from './terminal/fonts';
import type { DesktopShell } from './desktop';

export type ThemeKind = 'dark' | 'light';

/** What terminals take from the settings. */
export interface Appearance {
  theme: ThemeKind;
  fontSize: number;
  fontWeight: TermFontWeight;
  optionIsMeta: boolean;
}

const darkQuery = typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)');

/** Whether the system asks for a dark theme, which the "system" setting
 * follows. In the desktop app it is Electron's nativeTheme.themeSource,
 * which the setting itself changes (apply): after switching from "dark" to
 * "system" it turns light only once the shell has been told. Components
 * that draw with the theme (the pane surface) subscribe to it, as they do
 * to the settings. */
export const useSystemDark = create<{ dark: boolean }>(() => ({ dark: darkQuery?.matches ?? true }));

export function resolveTheme(pref: Prefs['theme'], systemDark = useSystemDark.getState().dark): ThemeKind {
  if (pref === 'dark' || pref === 'light') return pref;
  return systemDark ? 'dark' : 'light';
}

/** The theme kind in use. */
export function themeKind(): ThemeKind {
  return resolveTheme(getPrefs().theme);
}

/** The theme kind in use, for components: it changes with the setting and,
 * for "system", with the system's theme. */
export function useThemeKind(): ThemeKind {
  const pref = usePrefs((s) => s.prefs.theme);
  const dark = useSystemDark((s) => s.dark);
  return resolveTheme(pref, dark);
}

export function appearanceOf(p: Prefs): Appearance {
  return {
    theme: resolveTheme(p.theme),
    fontSize: p.termFontSize,
    fontWeight: p.termFontWeight === 'medium' ? 500 : 400,
    optionIsMeta: p.optionIsMeta,
  };
}

/** The terminal appearance the settings ask for. */
export function currentAppearance(): Appearance {
  return appearanceOf(getPrefs());
}

function apply(p: Prefs) {
  const kind = resolveTheme(p.theme);
  const root = document.documentElement;
  root.dataset.theme = kind;
  root.style.fontSize = `${p.uiFontSize}px`;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
  conn.setTheme(kind);
  // The setting, not the kind: "system" keeps following the system.
  (globalThis as { desktopShell?: DesktopShell }).desktopShell?.setTheme(p.theme);
}

/** Applies the current settings and follows later changes. */
export function initAppearance() {
  apply(getPrefs());
  usePrefs.subscribe((s, prev) => {
    if (s.prefs !== prev.prefs) apply(s.prefs);
  });
  useSystemDark.subscribe((s, prev) => {
    if (s.dark !== prev.dark) apply(getPrefs());
  });
  darkQuery?.addEventListener('change', (e) => useSystemDark.setState({ dark: e.matches }));
}
