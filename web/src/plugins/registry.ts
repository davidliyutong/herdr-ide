// The plugins the app has and which of them are on (api.ts).
import { create } from 'zustand';
import { builtinDefaults, useSettings } from '../settings';
import type { CommandDef, PaletteItem, PanelDef, PaneViewDef, PluginDef } from './api';

let plugins: PluginDef[] = [];

/** Sets the app's plugins (index.ts; tests). */
export function definePlugins(list: PluginDef[]) {
  const seen = new Set<string>();
  for (const p of list) {
    if (!/^[a-z][a-z0-9]*$/.test(p.id) || seen.has(p.id)) throw new Error(`bad plugin id ${p.id}`);
    seen.add(p.id);
  }
  plugins = list;
  usePluginList.setState({ list });
}

/** The plugins, for components that follow their list. */
export const usePluginList = create<{ list: PluginDef[] }>(() => ({ list: [] }));

/** Every plugin, on or off. */
export const allPlugins = (): readonly PluginDef[] => plugins;

/** The setting that turns p on, undefined when it is always on. */
export function enableSetting(p: PluginDef): string | undefined {
  if (p.enableSetting === null) return undefined;
  return p.enableSetting ?? `plugins.${p.id}.enabled`;
}

/** The value of p's switch for every machine without one of its own (the
 * app's value), on when the core has none; true for plugins always on. */
export function pluginSwitch(p: PluginDef, values = useSettings.getState().values): boolean {
  const key = enableSetting(p);
  if (!key) return true;
  const v = values[key]?.value ?? builtinDefaults[key];
  return v !== false;
}

/** Whether p is on: its switch, or, for a setting machines can have of
 * their own (program windows), that of any machine. */
export function pluginOn(p: PluginDef, values = useSettings.getState().values): boolean {
  if (pluginSwitch(p, values)) return true;
  const own = values[enableSetting(p)!]?.machines ?? {};
  return Object.values(own).some((v) => v !== false);
}

/** The plugins that are on. */
export const activePlugins = (): PluginDef[] => plugins.filter((p) => pluginOn(p));

/** Whether the plugin of this id is there and on. */
export const isPluginOn = (id: string): boolean => activePlugins().some((p) => p.id === id);

/** The plugins that are on, re-rendered when settings change. */
export function useActivePlugins(): PluginDef[] {
  const values = useSettings((s) => s.values);
  usePluginList((s) => s.list);
  return plugins.filter((p) => pluginOn(p, values));
}

/** Whether the plugin of this id is on, for components. */
export function usePluginOn(id: string): boolean {
  return useActivePlugins().some((p) => p.id === id);
}

/** The panels of the plugins that are on. */
export const activePanels = (): PanelDef[] => activePlugins().flatMap((p) => p.panels ?? []);

export function usePanels(): PanelDef[] {
  return useActivePlugins().flatMap((p) => p.panels ?? []);
}

/** The drawer of a pane kind, also of a plugin that is off (it says so). */
export function paneView(plugin: string, kind: string): { def?: PaneViewDef; on: boolean } {
  const p = plugins.find((x) => x.id === plugin);
  return { def: p?.paneViews?.[kind], on: !!p && pluginOn(p) };
}

/** The handler of a command that a plugin that is on runs. */
export function pluginCommand(id: string): CommandDef | undefined {
  for (const p of activePlugins()) {
    const c = p.commands?.[id];
    if (c) return c;
    for (const panel of p.panels ?? []) if (panel.command === id) return panelCommand(panel);
  }
  return undefined;
}

/** Whether a command belongs to a plugin that is off (it is then disabled
 * and runs nothing). */
export function commandOfOffPlugin(id: string): boolean {
  return plugins.some((p) => !pluginOn(p) && (!!p.commands?.[id] || (p.panels ?? []).some((panel) => panel.command === id)));
}

/** A panel's command shows it, or hides the sidebar when it is shown. */
let panelCommand: (panel: PanelDef) => CommandDef = () => ({ run() {} });
export function setPanelCommand(f: (panel: PanelDef) => CommandDef) {
  panelCommand = f;
}

/** The palette's items of the plugins that are on. */
export const pluginPaletteItems = (): PaletteItem[] => activePlugins().flatMap((p) => p.paletteItems?.() ?? []);

/** Hands a message of a plugin's core side to the plugin, when it is on. */
export function pluginMessage(plugin: string, m: string, data: unknown) {
  const p = activePlugins().find((x) => x.id === plugin);
  p?.onMessage?.(m, data);
}

/** What the app shows about a plugin's pane: its drawer's title and path,
 * or the plugin's name while its drawer is missing or off. */
export function describeView(m: string, view: import('../term/layout').PluginView) {
  const { def } = paneView(view.plugin, view.kind);
  return {
    def,
    title: def?.title(m, view) ?? view.plugin,
    path: def?.path?.(m, view),
    directory: def?.directory?.(m, view),
    preview: def?.preview?.(m, view) ?? false,
  };
}
