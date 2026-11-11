// Browser settings. Each one is defined once here; the settings dialog renders
// its controls from these definitions (labels come from i18n keys
// settings.<key>), so a new setting needs a definition and its translations.
// Core settings are defined in Go and fetched from /api/settings in the same
// shape (see internal/settings).

import { create } from 'zustand';
import { storage } from './brand';

export type SectionId = 'appearance' | 'layout' | 'terminal' | 'notifications' | 'shortcuts' | 'codeServer' | 'gui' | 'server';

interface Base {
  section: SectionId;
  /** Changing the setting reloads the page (it is read once at startup). */
  reload?: boolean;
}
export type PrefDef = Base &
  (
    | { kind: 'enum'; default: string; options: readonly string[] }
    | { kind: 'number'; default: number; min: number; max: number }
    | { kind: 'bool'; default: boolean }
    | { kind: 'string'; default: string }
  );

export const prefDefs = {
  locale: { section: 'appearance', kind: 'enum', default: 'auto', options: ['auto', 'en', 'zh-CN'], reload: true },
  theme: { section: 'appearance', kind: 'enum', default: 'system', options: ['system', 'dark', 'light'] },
  uiFontSize: { section: 'appearance', kind: 'number', default: 13, min: 11, max: 20 },
  termFontSize: { section: 'appearance', kind: 'number', default: 13, min: 9, max: 24 },
  termFontWeight: { section: 'appearance', kind: 'enum', default: 'regular', options: ['regular', 'medium'] },
  dockPosition: { section: 'layout', kind: 'enum', default: 'right', options: ['right', 'bottom'] },
  optionIsMeta: { section: 'terminal', kind: 'bool', default: false },
  // What a pane program's clipboard write (OSC 52) does (surface/session.ts).
  programClipboard: { section: 'terminal', kind: 'enum', default: 'auto', options: ['auto', 'ask', 'off'] },
  // LaTeX formulas in panes shown rendered under the pointer (terminal/math.ts).
  mathHover: { section: 'terminal', kind: 'bool', default: true },
  // On by default, and droid muted, as in herdr's [ui.sound].
  notifySound: { section: 'notifications', kind: 'bool', default: true },
  notifySoundMuted: { section: 'notifications', kind: 'string', default: 'droid' },
} satisfies Record<string, PrefDef>;

export type PrefKey = keyof typeof prefDefs;
type ValueOf<D> = D extends { kind: 'number' } ? number : D extends { kind: 'bool' } ? boolean : string;
export type Prefs = { [K in PrefKey]: ValueOf<(typeof prefDefs)[K]> };

/** Parses a stored value; invalid or missing values give the default. An
 * empty text is a value of its own. */
export function parsePref<K extends PrefKey>(key: K, raw: string | null): Prefs[K] {
  const d: PrefDef = prefDefs[key];
  if (raw === null || (raw === '' && d.kind !== 'string')) return d.default as Prefs[K];
  switch (d.kind) {
    case 'number': {
      const n = Number(raw);
      return (Number.isFinite(n) ? Math.min(d.max, Math.max(d.min, Math.round(n))) : d.default) as Prefs[K];
    }
    case 'bool':
      return (raw === 'true') as Prefs[K];
    case 'enum':
      return (d.options.includes(raw) ? raw : d.default) as Prefs[K];
    case 'string':
      return raw.trim() as Prefs[K];
  }
}

// Values are stored as plain strings under the setting's key, which keeps
// the keys written before settings existed ('locale', 'optionIsMeta').
function load(): Prefs {
  const out = {} as Record<PrefKey, unknown>;
  for (const key of Object.keys(prefDefs) as PrefKey[]) out[key] = parsePref(key, storage.get(key));
  return out as Prefs;
}

interface PrefState {
  prefs: Prefs;
  setPref<K extends PrefKey>(key: K, value: Prefs[K]): void;
}

export const usePrefs = create<PrefState>((set, get) => ({
  prefs: load(),
  setPref(key, value) {
    const d: PrefDef = prefDefs[key];
    const v = parsePref(key, String(value));
    // The locale's default ('auto') is stored as empty: follow the browser.
    storage.set(key, key === 'locale' && v === d.default ? '' : String(v));
    set({ prefs: { ...get().prefs, [key]: v } });
    if (d.reload) location.reload();
  },
}));

export function getPrefs(): Prefs {
  return usePrefs.getState().prefs;
}
