// The web UI's side of plugins: features built into the app that add
// panels to the right sidebar, kinds of panes, commands, status bar items,
// palette items and handlers of their messages from the core (/ws
// plugin {plugin, m, data}). The core's side of each is in internal/plugin;
// docs/features/27-plugins.md has the design. Plugins are compiled in.
import type { ComponentType, ReactNode } from 'react';
import type { MenuEntry } from '../contextMenu';
import type { MessageKey } from '../i18n';
import type { SettingDef } from '../settings';
import type { PluginView, TerminalLeaf } from '../term/layout';
import type { Cover } from '../state/covers';

/** An icon: lucide's, or one drawn the same way (components/icons.tsx). */
export type IconComponent = ComponentType<{ className?: string }>;

/** A panel of the right sidebar. */
export interface PanelDef {
  /** Unique among all panels: <plugin> or <plugin>.<name>. */
  id: string;
  title: MessageKey;
  icon: IconComponent;
  component: ComponentType;
  /** The command that shows it (declared in internal/keybindings). */
  command?: string;
}

export interface PaneViewProps {
  m: string;
  /** The pane's key (view:<id>). */
  pane: string;
  view: PluginView;
  focused: boolean;
}

/** A kind of pane a plugin draws: the layout's leaf {view: {id, plugin,
 * kind, ...}}, whose other fields are the plugin's. */
export interface PaneViewDef {
  icon: IconComponent;
  /** The pane's title, for its header and tab. */
  title(m: string, view: PluginView): string;
  /** A path the pane is about (header, status bar), if any. */
  path?(m: string, view: PluginView): string | undefined;
  /** The directory new terminals beside it start in. */
  directory?(m: string, view: PluginView): string | undefined;
  /** Whether the pane is a preview, which the next one replaces (its title
   * is in italics, as VS Code's preview editors). */
  preview?(m: string, view: PluginView): boolean;
  /** A React hook, called wherever the pane's title is drawn (its header,
   * its tab): undefined while what the pane shows is there, else what is
   * said of it (the file was deleted or moved away). The title is then
   * struck through and its tooltip ends with that, as VS Code marks the
   * editors of deleted files. */
  useGone?(m: string, view: PluginView): string | undefined;
  /** Entries the menus of the pane's header and tab start with. */
  menu?(m: string, view: PluginView): MenuEntry[];
  component: ComponentType<PaneViewProps>;
}

/** What runs a command declared in internal/keybindings/commands.go. */
export interface CommandDef {
  enabled?(): boolean;
  run(): void;
}

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run(): void;
}

/** What the dialog that turns a plugin on in browsers says: what its
 * content can reach and why, and the box to tick before Enable. */
export interface BrowserRisk {
  title: MessageKey;
  /** The paragraph before the list of what it reaches, and those after. */
  intro: MessageKey;
  points: MessageKey[];
  outro: MessageKey[];
  check: MessageKey;
  confirm: MessageKey;
}

/** What a plugin's page in Settings ends with: actions that are no
 * setting (an import and an export). */
export interface PluginSettingsProps {
  readOnly: boolean;
}

/** What lays out a plugin's settings on its page: the settings of its
 * section the scope shows, in their order, and what draws some of them as
 * the dialog's rows (each with its control, a heading where a group
 * starts). */
export interface PluginSettingsLayoutProps extends PluginSettingsProps {
  defs: SettingDef[];
  rows(defs: SettingDef[]): ReactNode;
  /** The plugin and its switch, which a page shows before its settings:
   * the layout draws it on its first page. */
  lead?: ReactNode;
  /** Counts the times the page was chosen in the dialog's list: a layout
   * with pages of its own shows its first one again when it changes. */
  visit: number;
}

/** A plugin's page in Settings. */
export interface PluginSettingsDef {
  /** The section of its settings (internal/settings), whose page the
   * Plugins page's settings button opens. The core's section names its
   * plugin as well; a section without settings is a page for extra alone. */
  section: string;
  /** Lays out the page's settings in place of their rows one after the
   * other (pages of its own within the page); a search shows the rows it
   * finds as on any page. */
  layout?: ComponentType<PluginSettingsLayoutProps>;
  /** Drawn at the end of the page. */
  extra?: ComponentType<PluginSettingsProps>;
}

/** A kind of tab a plugin offers in the tab bar's new-tab menu, after
 * Terminal; the plugin's items follow each other, a separator between
 * plugins. */
export interface NewTabItem {
  id: string;
  title: MessageKey;
  icon: IconComponent;
  /** Opens the tab on machine m, in the workspace with id `workspace`
   * (the one shown). */
  run(m: string, workspace: string): void | Promise<void>;
}

/** A visible status bar widget that users can hide or show from the status
 * bar's menu. Plain components in statusItems (portal dialogs, overlays)
 * always stay mounted and are not listed as widgets. */
export interface StatusWidgetDef {
  /** Unique widget id (e.g. "<plugin>" or "<plugin>.<name>"). */
  id: string;
  title: MessageKey;
  component: ComponentType;
}

export type StatusItemDef = ComponentType | StatusWidgetDef;

export function isStatusWidget(item: StatusItemDef): item is StatusWidgetDef {
  return typeof item === 'object' && item !== null && 'component' in item;
}

/** What a plugin draws over a terminal's pane, and a terminal pane's header
 * gets from it. */
export interface TerminalSurfaceProps {
  m: string;
  /** The terminal's address (its pane's key). */
  terminal: string;
  leaf: TerminalLeaf;
  /** The tab's focused pane. */
  focused: boolean;
  /** Makes the pane the tab's focused one (a press in the surface). */
  onActivate(): void;
}

/** What a plugin draws over a terminal's pane, shown and with the plugin on
 * (Workspace.tsx; registry.ts TerminalSurfaces): in a layer over the
 * terminal below the pane's header, which takes none of the terminal's
 * room, so the terminal keeps its size. A surface that covers all or part
 * of the terminal says so: at render time from the leaf (covers), and
 * while mounted for what changes otherwise (state/covers.ts useSetCover,
 * with its id as the owner). Covered all, the terminal is not drawn and
 * gives up the keyboard, and stays attached at the pane's size: what is
 * typed or pasted into it (state/panes.ts paneHandle, withPane) reaches
 * its program. A surface that takes the pane's focus registers it with
 * state/panes.ts useSurfaceFocus; the pane is then focused through it
 * (withView), also when it is focused as it mounts. Panes kept hidden draw
 * no surface. */
export interface TerminalSurfaceDef {
  /** Unique among the surfaces of all plugins: <plugin> or
   * <plugin>.<name> (registry.ts definePlugins refuses a second). */
  id: string;
  component: ComponentType<TerminalSurfaceProps>;
  /** What the surface covers of the terminal as it is drawn for this
   * leaf, said while the pane is rendered so that the terminal is not
   * drawn for a frame before the surface mounts (a tab shown again). Pure:
   * it reads the leaf and state, and changes nothing. Called for plugins
   * that are on. */
  covers?(m: string, terminal: string, leaf: TerminalLeaf): Cover | undefined;
}

/** Buttons a plugin adds to a terminal pane's header, before the pane's
 * own (PaneHeader.tsx; registry.ts TerminalHeaderActions). The header is
 * one stop of the Tab key, its buttons reached with the arrows: they take
 * tabIndex -1. A press leaves the keyboard where it is. */
export type HeaderActionsComponent = ComponentType<Omit<TerminalSurfaceProps, 'focused' | 'onActivate'>>;

export interface PluginDef {
  /** As the core's plugin (internal/plugin): lower-case letters and digits. */
  id: string;
  title: MessageKey;
  description?: MessageKey;
  icon: IconComponent;
  /** The setting that turns it on and off: plugins.<id>.enabled unless
   * it has one of its own; none for parts of the app that are always on. */
  enableSetting?: string | null;
  /** Its content runs on the UI's own origin (VS Code's windows), where
   * its scripts reach whatever the page reaches (the core's
   * plugin.BrowserRisk): enableSetting is then the desktop app's switch,
   * browsers have one of their own, plugins.<id>.browser, and turning that
   * on asks the user to accept this risk first (registry.ts
   * setPluginSwitch). The dialog's texts. */
  browserRisk?: BrowserRisk;
  /** Its settings page. */
  settings?: PluginSettingsDef;
  panels?: PanelDef[];
  /** By kind. */
  paneViews?: Record<string, PaneViewDef>;
  /** By command id. */
  commands?: Record<string, CommandDef>;
  /** Shown in the status bar, right of the machine's line. StatusWidgetDef
   * entries can be toggled from the status bar's menu; plain components stay
   * mounted (portal dialogs, overlays). */
  statusItems?: StatusItemDef[];
  paletteItems?(): PaletteItem[];
  /** The kinds of tab it adds to the new-tab menu for machine m: any
   * number, in the order it lists them. Nothing while the plugin is off. */
  newTabItems?(m: string): NewTabItem[];
  /** A message of its core side for machine m ("" for the core's). */
  onMessage?(m: string, data: unknown): void;
  /** What it draws over terminals' panes (TerminalSurfaceDef). */
  terminalSurfaces?: TerminalSurfaceDef[];
  /** Buttons in terminals' panes' headers (HeaderActionsComponent). */
  headerActions?: HeaderActionsComponent[];
  /** A React hook, as PaneViewDef.useGone, for a file of machine m: the
   * app's own panes that show a file (previews) mark their titles with
   * what the first plugin that is on with one says (the file explorer's);
   * with none on, nothing is marked. */
  useFileGone?(m: string, path: string): string | undefined;
}
