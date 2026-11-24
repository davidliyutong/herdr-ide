// The settings of the core and of the user interfaces (backend/kernel/config/settings):
// definitions and values from GET /api/settings, kept current by the core's
// "settings" pushes on /ws, changed with PUT and DELETE. The settings dialog
// renders itself from the definitions; prefs.ts reads the values the UI
// uses. Until the core answers, the defaults of spec/generated/registry.json
// apply (the same build's registry).

import { create } from 'zustand';
import registry from '../../spec/generated/registry.json';
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
  /** The plugin it belongs to (plugins/api.ts): listed under the
   * plugins, saying when the plugin is off. */
  plugin?: string;
}

/** The kind of client this page is, as the core tells from its requests
 * (the desktop app's windows carry the token of its launch): which switch
 * of a plugin with one per kind of client applies here (plugins/api.ts
 * browserRisk). A browser until the core answers. */
export type Client = 'browser' | 'desktop';

interface SettingsStore {
  loaded: boolean;
  sections: Section[];
  defs: SettingDef[];
  values: Record<string, SettingState>;
  problems: SettingProblem[];
  readOnly: boolean;
  file: string;
  client: Client;
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
  client: 'browser',
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
      client: j.client === 'desktop' ? 'desktop' : 'browser',
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
