// The plugins the app has and which of them are on (api.ts).
import { createElement, useSyncExternalStore, type MouseEvent } from 'react';
import { create } from 'zustand';
import { PluginBoundary } from '../components/PluginBoundary';
import { riskDialog } from '../dialog';
import { t } from '../i18n';
import { statusRank, type AgentStatus } from '../lib/machine';
import { builtinDefaults, setSetting, useSettings, type Client, type Section } from '../settings';
import type { NotificationTarget } from '../shell';
import type { PluginView } from '../term/layout';
import type { CommandDef, NewTabItem, PaletteItem, PanelDef, PaneViewDef, PluginDef, TerminalHeaderProps, UnopenedAgent } from './api';

let plugins: PluginDef[] = [];
const pluginLoaders = new Map<string, () => Promise<PluginDef>>();
const lazyStubs = new Map<string, PluginDef>();

/** Registers the dynamic loader for a lazy plugin id (lazy.ts). */
export function registerPluginLoader(id: string, load: () => Promise<PluginDef>, stub?: PluginDef) {
  pluginLoaders.set(id, load);
  if (stub) lazyStubs.set(id, stub);
}

/** Whether a registered plugin is still a lazy stub waiting to load. */
export function isPluginPending(id: string): boolean {
  const stub = lazyStubs.get(id);
  return !!stub && plugins.some((p) => p === stub);
}

/** Triggers loading a registered lazy plugin by id (no-op if already eager or
 * unknown). */
export function ensurePluginLoaded(id: string): Promise<PluginDef | undefined> {
  const load = pluginLoaders.get(id);
  return load ? load() : Promise.resolve(plugins.find((p) => p.id === id));
}

/** Triggers loading all registered lazy plugins. */
export function ensurePluginsLoaded(): Promise<void> {
  const active = plugins.map((p) => pluginLoaders.get(p.id)).filter((fn): fn is () => Promise<PluginDef> => !!fn);
  return Promise.all(active.map((fn) => fn().catch(() => undefined))).then(() => undefined);
}

/** Replaces a registered plugin by id (used by lazy.ts once a plugin module
 * loads). When expected is given, replaces only if that exact stub is still
 * registered so test suites swapping plugins via definePlugins are unaffected. */
export function replacePlugin(id: string, next: PluginDef, expected?: PluginDef) {
  if (!expected || lazyStubs.get(id) === expected) lazyStubs.delete(id);
  const idx = plugins.findIndex((p) => p.id === id);
  if (idx < 0 || (expected && plugins[idx] !== expected)) return;
  plugins = [...plugins.slice(0, idx), next, ...plugins.slice(idx + 1)];
  usePluginList.setState({ list: plugins });
}

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

/** The setting that turns p on for this kind of client (the hub's
 * verdict on this page, settings.ts Client): the browsers' own for a
 * plugin with browserRisk in a browser; undefined when it is always on. */
export function enableSetting(p: PluginDef, client: Client = useSettings.getState().client): string | undefined {
  if (p.enableSetting === null) return undefined;
  if (p.browserRisk && client === 'browser') return browserSetting(p);
  return p.enableSetting ?? `plugins.${p.id}.enabled`;
}

/** The value of p's switch for every machine without one of its own (the
 * app's value), on when the hub has none; true for plugins always on. */
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

/** The settings section of p: the one it names, else the one the hub
 * says is its (Section.plugin). */
export function pluginSection(p: PluginDef, sections: readonly Section[] = useSettings.getState().sections): string | undefined {
  return p.settings?.section ?? sections.find((s) => s.plugin === p.id)?.id;
}

/** The id of the plugin a settings section belongs to: the hub's word
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

/** The buttons the plugins that are on add to a terminal pane's header
 * (PaneHeader.tsx), each plugin's in its error boundary; nothing when no
 * plugin that is on has any. A press leaves the keyboard where it is. */
export function TerminalHeaderActions(props: TerminalHeaderProps) {
  const list = useActivePlugins().flatMap((p) => (p.headerActions ?? []).map((component, i) => ({ p, component, i })));
  if (!list.length) return null;
  return createElement(
    'span',
    {
      className: 'pane-plugin-actions',
      onMouseDown: (e: MouseEvent) => (e.target as HTMLElement).closest('button') && e.preventDefault(),
    },
    list.map(({ p, component, i }) =>
      createElement(PluginBoundary, { key: `${p.id}:${i}`, plugin: t(p.title), compact: true, children: createElement(component, props) }),
    ),
  );
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

/** The kinds of tab the plugins that are on add to the new-tab menu for
 * machine m, a group for each plugin that has any, in plugin order. */
export function newTabGroups(m: string): NewTabItem[][] {
  return activePlugins()
    .map((p) => p.newTabItems?.(m) ?? [])
    .filter((items) => items.length > 0);
}

/** Hands a message of a plugin's hub side to the plugin, when it is on. */
export function pluginMessage(plugin: string, m: string, data: unknown) {
  const p = activePlugins().find((x) => x.id === plugin);
  p?.onMessage?.(m, data);
}

/** A plugin's viewStatus while the plugin is on. */
function statusOwner(id: string) {
  const p = plugins.find((x) => x.id === id);
  return p?.viewStatus && pluginOn(p) ? { p, def: p.viewStatus } : undefined;
}

const warned = new Set<string>();

/** Runs a plugin's viewStatus member: one that throws counts as none (and
 * is said once in the console), so the views that show statuses, outside
 * any plugin's error boundary, keep going. */
function guarded<T>(p: { id: string }, what: string, f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (!warned.has(`${p.id}.${what}`)) {
      warned.add(`${p.id}.${what}`);
      console.warn(`plugin ${p.id}: viewStatus.${what}`, e);
    }
    return undefined;
  }
}

/** The agent status of a plugin's pane, as its plugin has it
 * (ViewStatusDef.status): undefined for a plugin without one or off, and
 * for what is no status. */
export function viewStatus(m: string, view: PluginView): AgentStatus | undefined {
  const o = statusOwner(view.plugin);
  const s = o && guarded(o.p, 'status', () => o.def.status(m, view));
  return typeof s === 'string' && Object.hasOwn(statusRank, s) ? s : undefined;
}

/** The pane of machine m an agent notification without a terminal points
 * to (its data, /ws agent): the first answer of a plugin that is on
 * (ViewStatusDef.paneOf), when it is a view:<id> key. */
export function viewPaneOf(m: string, data: Record<string, unknown>): string | undefined {
  for (const p of activePlugins()) {
    const def = p.viewStatus;
    if (!def?.paneOf) continue;
    const pane = guarded(p, 'paneOf', () => def.paneOf!(m, data));
    if (typeof pane === 'string' && pane.startsWith('view:')) return pane;
  }
  return undefined;
}

/** Tells a pane's plugin that the user saw the pane while its status was
 * done (ViewStatusDef.seen; seen.ts). */
export function viewSeen(m: string, view: PluginView) {
  const o = statusOwner(view.plugin);
  if (o?.def.seen) guarded(o.p, 'seen', () => o.def.seen!(m, view));
}

/** Conversations/agents on machine m from active plugins that have no open pane. */
export function viewUnopened(m: string): Array<UnopenedAgent & { plugin: string }> {
  const out: Array<UnopenedAgent & { plugin: string }> = [];
  for (const p of activePlugins()) {
    const def = p.viewStatus;
    if (!def?.unopened) continue;
    const list = guarded(p, 'unopened', () => def.unopened!(m));
    if (!Array.isArray(list)) continue;
    for (const item of list) out.push({ ...item, plugin: p.id });
  }
  return out;
}

/** Routes a chat notification click without an open pane to the plugin that owns it. */
export function viewOpenTarget(target: Extract<NotificationTarget, { kind: 'chat' }>): boolean {
  for (const p of activePlugins()) {
    const def = p.viewStatus;
    if (!def?.openTarget) continue;
    guarded(p, 'openTarget', () => void def.openTarget!(target));
    return true;
  }
  return false;
}

// One subscription to each plugin's statuses serves every listener: taken
// with the first listener, given back with the last, taken again when the
// plugins change. Turning a plugin that has statuses on or off changes them
// too.
const statusListeners = new Set<() => void>();
let statusSubs: Array<() => void> = [];
let statusOff: Array<() => void> = [];

function statusChanged() {
  for (const f of [...statusListeners]) f();
}

function subscribeStatuses() {
  for (const off of statusSubs) off();
  statusSubs = plugins.flatMap((p) => {
    const def = p.viewStatus;
    return def ? [guarded(p, 'subscribe', () => def.subscribe(statusChanged)) ?? (() => {})] : [];
  });
}

/** The plugins with statuses that are on, as one string. */
const statusPlugins = () =>
  activePlugins()
    .filter((p) => p.viewStatus)
    .map((p) => p.id)
    .join();

/** Calls fn whenever the status of a plugin's pane may have changed
 * (viewStatus); returns an unsubscribe. */
export function onViewStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  if (statusListeners.size === 1) {
    subscribeStatuses();
    let on = statusPlugins();
    statusOff = [
      usePluginList.subscribe(() => {
        subscribeStatuses();
        on = statusPlugins();
        statusChanged();
      }),
      useSettings.subscribe(() => {
        const now = statusPlugins();
        if (now === on) return;
        on = now;
        statusChanged();
      }),
    ];
  }
  return () => {
    if (!statusListeners.delete(fn) || statusListeners.size) return;
    for (const off of [...statusSubs, ...statusOff]) off();
    statusSubs = [];
    statusOff = [];
  };
}

/** A React hook: what f makes of the plugins' panes' statuses (for the
 * views that aggregate them), made again whenever they may have changed;
 * the component draws again only when that changed (Object.is), so f
 * returns a string or a number. */
export function useViewStatusOf<T extends string | number | undefined>(f: () => T): T {
  return useSyncExternalStore(onViewStatus, f);
}

/** A React hook: the status of a plugin's pane (viewStatus), kept current. */
export function useViewStatus(m: string, view: PluginView): AgentStatus | undefined {
  return useViewStatusOf(() => viewStatus(m, view));
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
