// Applies the appearance settings: light/dark theme (also sent to the core,
// which switches VS Code windows to match) and the UI font. The pane surface
// follows the terminal settings itself (components/SurfaceView.tsx).

import { getPrefs, usePrefs, type Prefs } from './prefs';
import { conn } from './lib/conn';
import type { TermFontWeight } from './terminal/fonts';

export type ThemeKind = 'dark' | 'light';

/** What terminals take from the settings. */
export interface Appearance {
  theme: ThemeKind;
  fontSize: number;
  fontWeight: TermFontWeight;
  optionIsMeta: boolean;
}

const darkQuery = typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)');

export function resolveTheme(pref: Prefs['theme'], systemDark = darkQuery?.matches ?? true): ThemeKind {
  if (pref === 'dark' || pref === 'light') return pref;
  return systemDark ? 'dark' : 'light';
}

/** The theme kind in use. */
export function themeKind(): ThemeKind {
  return resolveTheme(getPrefs().theme);
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
}

/** Applies the current settings and follows later changes. */
export function initAppearance() {
  apply(getPrefs());
  usePrefs.subscribe((s, prev) => {
    if (s.prefs !== prev.prefs) apply(s.prefs);
  });
  darkQuery?.addEventListener('change', () => apply(getPrefs()));
}
