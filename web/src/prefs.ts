// What the UI reads from the settings (settings.ts), typed and named for its
// users: `usePrefs((s) => s.prefs.theme)` in components, `getPrefs()`
// elsewhere. The values are the core's (shared by every client of the core);
// setPref saves one there. Pure per-device state (sidebar, panel sizes, the
// selected machine, transfer history) stays in the browser (state/store.ts).

import { create } from 'zustand';
import { setSetting, settingValue, useSettings, type SettingValue } from './settings';
import { schemeColors } from './terminal/schemes';

/** A theme's terminal colors: the 16 ANSI colors are black to white, then
 * their bright variants. */
export interface TermColors {
  foreground: string;
  background: string;
  cursor: string;
  selection: string;
  palette: string[];
}

/** The settings each field reads. */
export const prefKeys = {
  locale: 'appearance.language',
  theme: 'appearance.theme',
  uiFontSize: 'appearance.uiFontSize',
  dockPosition: 'layout.panelPosition',
  termFontFamily: 'terminal.fontFamily',
  termFontSize: 'terminal.fontSize',
  termFontWeight: 'terminal.fontWeight',
  termLineHeight: 'terminal.lineHeight',
  cursorStyle: 'terminal.cursorStyle',
  cursorBlink: 'terminal.cursorBlink',
  scrollback: 'terminal.scrollback',
  copyOnSelect: 'terminal.copyOnSelect',
  bell: 'terminal.bell',
  boldIsBright: 'terminal.boldIsBright',
  optionIsMeta: 'terminal.optionIsMeta',
  programClipboard: 'terminal.programClipboard',
  mathHover: 'terminal.mathHover',
  notifySound: 'notifications.sound',
  notifySystem: 'notifications.system',
  notifyBadge: 'notifications.badge',
  notifySoundMuted: 'notifications.mutedAgents',
} as const;

export type PrefKey = keyof typeof prefKeys;

export interface Prefs {
  locale: 'auto' | 'en' | 'zh-CN';
  theme: 'system' | 'dark' | 'light';
  uiFontSize: number;
  dockPosition: 'right' | 'bottom';
  termFontFamily: string;
  termFontSize: number;
  termFontWeight: 'regular' | 'medium';
  termLineHeight: number;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelect: boolean;
  bell: 'none' | 'sound' | 'visual';
  boldIsBright: boolean;
  optionIsMeta: boolean;
  programClipboard: 'auto' | 'ask' | 'off';
  mathHover: boolean;
  notifySound: boolean;
  notifySystem: boolean;
  notifyBadge: boolean;
  notifySoundMuted: string[];
  colors: { dark: TermColors; light: TermColors };
}

/** A theme's terminal colors: its scheme's, each replaced by the user's
 * own color when one is set. */
export function colors(theme: 'dark' | 'light'): TermColors {
  const base = schemeColors(String(settingValue(`terminal.colorScheme.${theme}`) ?? 'default'), theme);
  const values = useSettings.getState().values;
  const own = <T>(name: keyof TermColors, fallback: T): T => {
    const v = values[`terminal.colors.${theme}.${name}`];
    return v && v.source !== 'default' ? (v.value as T) : fallback;
  };
  return {
    foreground: own('foreground', base.foreground),
    background: own('background', base.background),
    cursor: own('cursor', base.cursor),
    selection: own('selection', base.selection),
    palette: own('palette', base.palette),
  };
}

/** The UI's view of the current values. */
export function readPrefs(): Prefs {
  const out = {} as Record<string, unknown>;
  for (const [field, key] of Object.entries(prefKeys)) out[field] = settingValue(key);
  out.colors = { dark: colors('dark'), light: colors('light') };
  return out as unknown as Prefs;
}

interface PrefState {
  prefs: Prefs;
  /** Saves a setting; the value applies at once. */
  setPref<K extends PrefKey>(key: K, value: Prefs[K]): void;
}

export const usePrefs = create<PrefState>(() => ({
  prefs: readPrefs(),
  setPref(key, value) {
    const done = setSetting(prefKeys[key], value as SettingValue);
    // The language is read once, when the page starts.
    if (key === 'locale') void done.then((error) => !error && location.reload());
  },
}));

useSettings.subscribe((s, prev) => {
  if (s.values !== prev.values) usePrefs.setState({ prefs: readPrefs() });
});

export function getPrefs(): Prefs {
  return usePrefs.getState().prefs;
}
