// The settings of the core and of the user interfaces (internal/settings):
// definitions and values from GET /api/settings, kept current by the core's
// "settings" pushes on /ws, changed with PUT and DELETE. The settings dialog
// renders itself from the definitions; prefs.ts reads the values the UI
// uses. Until the core answers, the defaults of design/generated/registry.json
// apply (the same build's registry).

import { create } from 'zustand';
import registry from '../../design/generated/registry.json';
import { storage } from './brand';
import { hasMessage, t } from './i18n';

export type SettingType = 'bool' | 'number' | 'string' | 'enum' | 'color' | 'list';
export type SettingValue = boolean | number | string | string[];

export interface SettingDef {
  key: string;
  type: SettingType;
  default: SettingValue;
  enum?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  /** What a stepper adds (1 when absent). */
  step?: number;
  item?: SettingType;
  length?: number;
  /** The values offered for a list of strings; others can be added. */
  options?: string[];
  scope: 'app' | 'machine' | 'remote-machine';
  section: string;
  /** A heading within the section. */
  group?: string;
  order: number;
  flag?: string;
}

export interface SettingState {
  value: SettingValue;
  source: 'default' | 'global' | 'machine' | 'flag';
  machines?: Record<string, SettingValue>;
  locked?: boolean;
}

export interface SettingProblem {
  key?: string;
  machine?: string;
  code: string;
  detail?: string;
}

export interface Section {
  id: string;
  order: number;
  /** Listed after the others, under "Advanced". */
  advanced?: boolean;
}

interface SettingsStore {
  loaded: boolean;
  sections: Section[];
  defs: SettingDef[];
  values: Record<string, SettingState>;
  problems: SettingProblem[];
  readOnly: boolean;
  file: string;
}

/** The built-in defaults: what the UI uses before the core answers. */
export const builtinDefaults = registry.settings as Record<string, SettingValue>;

function defaultValues(): Record<string, SettingState> {
  const out: Record<string, SettingState> = {};
  for (const [k, v] of Object.entries(builtinDefaults)) out[k] = { value: v, source: 'default' };
  return out;
}

export const useSettings = create<SettingsStore>(() => ({
  loaded: false,
  sections: [],
  defs: [],
  values: defaultValues(),
  problems: [],
  readOnly: false,
  file: '',
}));

/** A setting's global value: the core's, else the built-in default. */
export function settingValue(key: string): SettingValue | undefined {
  return useSettings.getState().values[key]?.value ?? builtinDefaults[key];
}

/** Applies a "settings" push (or a change's reply): every value and the problems. */
export function applySettings(m: { values?: unknown; problems?: unknown }) {
  if (!m.values || typeof m.values !== 'object') return;
  useSettings.setState({
    values: m.values as Record<string, SettingState>,
    problems: Array.isArray(m.problems) ? (m.problems as SettingProblem[]) : [],
  });
}

/** Reads the definitions and values. */
export async function loadSettings(): Promise<boolean> {
  try {
    const r = await fetch('/api/settings');
    if (!r.ok) return false;
    const j = await r.json();
    useSettings.setState({
      loaded: true,
      sections: j.sections ?? [],
      defs: j.definitions ?? [],
      readOnly: !!j.read_only,
      file: j.file ?? '',
    });
    applySettings(j);
    return true;
  } catch {
    return false;
  }
}

/** A failed change as the dialog shows it: a translated code, and the OS
 * error of a failed save. */
function errorText(j: { error?: string; detail?: string }): string {
  const code = `settings.error.${j.error}`;
  return (hasMessage(code) ? t(code) : String(j.error)) + (j.error === 'save' && j.detail ? `: ${j.detail}` : '');
}

/** Sends a change; on failure the values shown before it come back (unless
 * something else changed them meanwhile). */
async function change(
  method: 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  before?: SettingsStore['values'],
): Promise<string | undefined> {
  const shown = useSettings.getState().values;
  const restore = () => {
    if (before && useSettings.getState().values === shown) useSettings.setState({ values: before });
  };
  try {
    const r = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) {
      restore();
      return errorText(j);
    }
    applySettings(j);
    return undefined;
  } catch {
    restore();
    return t('settings.error.network');
  }
}

/** Saves a value, globally or as a machine's own; resolves to an error
 * message, or undefined. A global value shows at once and is replaced by
 * the core's answer. */
export function setSetting(key: string, value: SettingValue, machine?: string): Promise<string | undefined> {
  const s = useSettings.getState();
  const cur = s.values[key];
  if (!machine && !cur?.locked) {
    useSettings.setState({ values: { ...s.values, [key]: { ...(cur ?? { source: 'global' }), value, source: 'global' } } });
  }
  return change('PUT', '/api/settings', { key, value, machine: machine || undefined }, s.values);
}

/** Removes a value: the global one goes back to the default, a machine's
 * own to the global value. */
export function resetSetting(key: string, machine?: string): Promise<string | undefined> {
  const q = new URLSearchParams({ key });
  if (machine) q.set('machine', machine);
  return change('DELETE', `/api/settings?${q}`);
}

/** Browser settings of earlier versions, kept in localStorage under these
 * names, and the settings that took their place. */
export const legacyPrefs: Record<string, { key: string; parse(raw: string): SettingValue | undefined }> = {
  locale: { key: 'appearance.language', parse: (r) => (['en', 'zh-CN'].includes(r) ? r : undefined) },
  theme: { key: 'appearance.theme', parse: (r) => (['system', 'dark', 'light'].includes(r) ? r : undefined) },
  uiFontSize: { key: 'appearance.uiFontSize', parse: (r) => num(r, 11, 20, true) },
  termFontSize: { key: 'terminal.fontSize', parse: (r) => num(r, 6, 40, false) },
  termFontWeight: { key: 'terminal.fontWeight', parse: (r) => (['regular', 'medium'].includes(r) ? r : undefined) },
  dockPosition: { key: 'layout.panelPosition', parse: (r) => (['right', 'bottom'].includes(r) ? r : undefined) },
  optionIsMeta: { key: 'terminal.optionIsMeta', parse: bool },
  programClipboard: { key: 'terminal.programClipboard', parse: (r) => (['auto', 'ask', 'off'].includes(r) ? r : undefined) },
  mathHover: { key: 'terminal.mathHover', parse: bool },
  notifySound: { key: 'notifications.sound', parse: bool },
  notifySoundMuted: {
    key: 'notifications.mutedAgents',
    parse: (r) =>
      r
        .split(/[\s,]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
  },
};

function num(raw: string, min: number, max: number, integer: boolean): number | undefined {
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) return;
  return Math.min(max, Math.max(min, integer ? Math.round(n) : n));
}

function bool(raw: string): boolean | undefined {
  return raw === 'true' ? true : raw === 'false' ? false : undefined;
}

/** The values a browser kept before settings moved to the core, for the
 * settings still at their defaults there. */
export function legacyImports(
  get: (name: string) => string | null,
  values: Record<string, SettingState>,
): { name: string; key: string; value?: SettingValue }[] {
  const out: { name: string; key: string; value?: SettingValue }[] = [];
  for (const [name, l] of Object.entries(legacyPrefs)) {
    const raw = get(name);
    if (raw === null) continue;
    const v = l.parse(raw);
    const cur = values[l.key];
    // Only a value the core does not have yet; the old key goes either way.
    const take = v !== undefined && cur?.source === 'default' && JSON.stringify(v) !== JSON.stringify(cur.value);
    out.push({ name, key: l.key, value: take ? v : undefined });
  }
  return out;
}

/** Moves the browser settings of earlier versions to the core once: each
 * value the core still has at its default is saved there, then the old key
 * is removed. Nothing happens in read-only mode (the keys stay for a later
 * writable session). */
export async function importLegacyPrefs() {
  const s = useSettings.getState();
  if (!s.loaded || s.readOnly) return;
  for (const { name, key, value } of legacyImports(storage.get, s.values)) {
    if (value !== undefined && (await setSetting(key, value)) !== undefined) continue;
    storage.remove(name);
  }
}
