// Applies the appearance settings: light/dark theme (also sent to the core,
// which switches VS Code windows to match), UI and terminal font sizes.

import { getPrefs, usePrefs, type Prefs } from './prefs';
import { conn } from './lib/conn';
import { allTerms } from './terminal/registry';

export type ThemeKind = 'dark' | 'light';

const darkQuery = typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)');

export function resolveTheme(pref: Prefs['theme'], systemDark = darkQuery?.matches ?? true): ThemeKind {
  if (pref === 'dark' || pref === 'light') return pref;
  return systemDark ? 'dark' : 'light';
}

/** The theme kind in use. */
export function themeKind(): ThemeKind {
  return resolveTheme(getPrefs().theme);
}

function apply(p: Prefs) {
  const kind = resolveTheme(p.theme);
  const root = document.documentElement;
  root.dataset.theme = kind;
  root.style.fontSize = `${p.uiFontSize}px`;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
  conn.setTheme(kind);
  for (const t of allTerms()) t.setAppearance({ theme: kind, fontSize: p.termFontSize, optionIsMeta: p.optionIsMeta });
}

/** Applies the current settings and follows later changes. */
export function initAppearance() {
  apply(getPrefs());
  usePrefs.subscribe((s, prev) => {
    if (s.prefs !== prev.prefs) apply(s.prefs);
  });
  darkQuery?.addEventListener('change', () => apply(getPrefs()));
}
