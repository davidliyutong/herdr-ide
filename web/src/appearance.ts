// Applies the appearance settings: light/dark theme (also sent to the core,
// which switches VS Code windows to match) and the UI font. Terminals follow
// the terminal settings themselves (components/TerminalView.tsx); the
// desktop app's shell reads the theme from the core itself.

import { create } from 'zustand';
import { getPrefs, usePrefs, type Prefs, type TermColors } from './prefs';
import { conn } from './lib/conn';
import type { TermFontWeight } from './terminal/fonts';
import type { Display } from './term/connection';
import { accentAttribute } from './themes';

export type ThemeKind = 'dark' | 'light';

/** What terminals take from the settings. */
export interface Appearance {
  theme: ThemeKind;
  /** The resolved theme's terminal colors. */
  colors: TermColors;
  fontFamily: string;
  fontSize: number;
  fontWeight: TermFontWeight;
  /** Rows are this many times the font's own line height. */
  lineHeight: number;
  optionIsMeta: boolean;
  boldIsBright: boolean;
  cursorStyle: 'block' | 'bar' | 'underline';
  /** The bar's and underline's thickness, CSS pixels. */
  cursorWidth: number;
  cursorBlink: boolean;
}

const darkQuery = typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)');

/** Whether the system asks for a dark theme, which the "system" setting
 * follows. In the desktop app it is Electron's nativeTheme.themeSource,
 * which the setting itself changes (apply): after switching from "dark" to
 * "system" it turns light only once the shell has been told. Components
 * that draw with the theme (terminals) subscribe to it, as they do
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

/** A color setting as the terminal core takes it (`#rrggbb`). */
function coreColor(css: string): string | undefined {
  const m = /^#?([0-9a-f]{6})/i.exec(css.trim());
  return m ? `#${m[1].toLowerCase()}` : undefined;
}

/** The colors the terminal core answers programs with: the theme's
 * terminal colors (term/connection.ts Display). */
export function displayColors(colors: TermColors): Display {
  const out: Display = {};
  const fg = coreColor(colors.foreground);
  const bg = coreColor(colors.background);
  const cursor = coreColor(colors.cursor);
  if (fg) out.fg = fg;
  if (bg) out.bg = bg;
  if (cursor) out.cursor = cursor;
  return out;
}

/** The display of the current theme, for terminals started before a pane
 * shows them. */
export function currentDisplay(): Display {
  return displayColors(appearanceOf(getPrefs()).colors);
}

export function appearanceOf(p: Prefs): Appearance {
  const theme = resolveTheme(p.theme);
  return {
    theme,
    colors: p.colors[theme],
    fontFamily: p.termFontFamily,
    fontSize: p.termFontSize,
    fontWeight: p.termFontWeight === 'medium' ? 500 : 400,
    lineHeight: p.termLineHeight,
    optionIsMeta: p.optionIsMeta,
    boldIsBright: p.boldIsBright,
    cursorStyle: p.cursorStyle,
    cursorWidth: p.cursorWidth,
    cursorBlink: p.cursorBlink,
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
  const accent = accentAttribute(p.colorTheme);
  if (accent) root.dataset.accent = accent;
  else delete root.dataset.accent;
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
  useSystemDark.subscribe((s, prev) => {
    if (s.dark !== prev.dark) apply(getPrefs());
  });
  darkQuery?.addEventListener('change', (e) => useSystemDark.setState({ dark: e.matches }));
}
