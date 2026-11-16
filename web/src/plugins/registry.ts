// The plugins the app has and which of them are on (api.ts).
import { createElement } from 'react';
import { create } from 'zustand';
import { riskDialog } from '../dialog';
import { t } from '../i18n';
import { builtinDefaults, setSetting, useSettings, type Client, type Section } from '../settings';
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

/** The browsers' switch of a plugin whose content runs on the UI's origin
 * (browserRisk). */
export const browserSetting = (p: PluginDef): string => `plugins.${p.id}.browser`;

/** The setting that turns p on for this kind of client (the core's
 * verdict on this page, settings.ts Client): the browsers' own for a
 * plugin with browserRisk in a browser; undefined when it is always on. */
export function enableSetting(p: PluginDef, client: Client = useSettings.getState().client): string | undefined {
  if (p.enableSetting === null) return undefined;
  if (p.browserRisk && client === 'browser') return browserSetting(p);
  return p.enableSetting ?? `plugins.${p.id}.enabled`;
}

/** The value of p's switch for every machine without one of its own (the
 * app's value), on when the core has none; true for plugins always on. */
export function pluginSwitch(p: PluginDef, values = useSettings.getState().values, client = useSettings.getState().client): boolean {
  const key = enableSetting(p, client);
  if (!key) return true;
  const v = values[key]?.value ?? builtinDefaults[key];
  return v !== false;
}

/** Whether p is on: its switch, or, for a setting machines can have of
 * their own (program windows), that of any machine. */
export function pluginOn(p: PluginDef, values = useSettings.getState().values, client = useSettings.getState().client): boolean {
  if (pluginSwitch(p, values, client)) return true;
  const own = values[enableSetting(p, client)!]?.machines ?? {};
  return Object.values(own).some((v) => v !== false);
}

/** Asks before a setting turns on that is the browsers' switch of a plugin
 * whose content runs on the UI's origin (browserRisk): what that content
 * can reach, and Enable only once the user ticked that they understand.
 * True when accepted, and for every other setting. */
export function acceptRisk(key: string): Promise<boolean> {
  const r = plugins.find((p) => p.browserRisk && browserSetting(p) === key)?.browserRisk;
  if (!r) return Promise.resolve(true);
  return riskDialog({
    title: t(r.title),
    intro: t(r.intro),
    points: r.points.map((k) => t(k)),
    outro: r.outro.map((k) => t(k)),
    check: t(r.check),
    confirm: t(r.confirm),
  });
}

/** Turns the plugin of this id on or off for this kind of client; in a
 * browser, turning on one whose content runs on the UI's origin asks
 * first (acceptRisk), and declining changes nothing. Resolves to an error
 * message, or undefined. */
export async function setPluginSwitch(id: string, on: boolean): Promise<string | undefined> {
  const p = plugins.find((x) => x.id === id);
  const key = p && enableSetting(p);
  if (!key) return undefined;
  if (on && !(await acceptRisk(key))) return undefined;
  return setSetting(key, on);
}

/** The plugins that are on. */
export const activePlugins = (): PluginDef[] => plugins.filter((p) => pluginOn(p));

/** The settings section of p: the one it names, else the one the core
 * says is its (Section.plugin). */
export function pluginSection(p: PluginDef, sections: readonly Section[] = useSettings.getState().sections): string | undefined {
  return p.settings?.section ?? sections.find((s) => s.plugin === p.id)?.id;
}

/** The id of the plugin a settings section belongs to: the core's word
 * for it (Section.plugin), else the plugin naming it. */
export function sectionPlugin(section: string, sections: readonly Section[] = useSettings.getState().sections): string | undefined {
  return sections.find((s) => s.id === section)?.plugin ?? plugins.find((p) => p.settings?.section === section)?.id;
}

/** Whether the plugin of this id is there and on. */
export const isPluginOn = (id: string): boolean => activePlugins().some((p) => p.id === id);

/** The plugins that are on, re-rendered when settings change. */
export function useActivePlugins(): PluginDef[] {
  const values = useSettings((s) => s.values);
  const client = useSettings((s) => s.client);
  usePluginList((s) => s.list);
  return plugins.filter((p) => pluginOn(p, values, client));
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

/** The kind of pane that shows a panel of the right sidebar, which every
 * plugin with panels has: `{view: {plugin, kind: 'panel', panel}}`, panel
 * being the panel's id. */
export const PANEL_VIEW = 'panel';

/** A plugin's panel by its id. */
export function findPanel(plugin: string, id: unknown): PanelDef | undefined {
  return plugins.find((p) => p.id === plugin)?.panels?.find((x) => x.id === id);
}

/** The plugin a panel belongs to. */
export function panelPlugin(panel: PanelDef): PluginDef | undefined {
  return plugins.find((p) => p.panels?.includes(panel));
}

/** The drawer of a plugin's panels as panes: the panel's component, in a
 * pane as in the sidebar. */
const panelViews = new WeakMap<PluginDef, PaneViewDef>();
function panelView(p: PluginDef): PaneViewDef {
  let def = panelViews.get(p);
  if (!def) {
    def = {
      icon: p.panels![0].icon,
      title: (_m, v) => t(findPanel(p.id, v.panel)?.title ?? p.title),
      component: ({ view }) => {
        const panel = findPanel(view.plugin, view.panel);
        return panel
          ? createElement('div', { className: 'panel-pane', 'data-panel': panel.id }, createElement(panel.component))
          : createElement('div', { className: 'plugin-pane-off muted' }, t('plugins.panelUnknown'));
      },
    };
    panelViews.set(p, def);
  }
  return def;
}

/** The drawer of a pane kind, also of a plugin that is off (it says so). */
export function paneView(plugin: string, kind: string): { def?: PaneViewDef; on: boolean } {
  const p = plugins.find((x) => x.id === plugin);
  const def = p?.paneViews?.[kind] ?? (kind === PANEL_VIEW && p?.panels?.length ? panelView(p) : undefined);
  return { def, on: !!p && pluginOn(p) };
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
