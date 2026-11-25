// The web UI's side of plugins: features built into the app that add
// panels to the right sidebar, kinds of panes, commands, status bar items,
// palette items and handlers of their messages from the hub (/ws
// plugin {plugin, m, data}). The hub's side of each is in backend/kernel/feature.ts;
// docs/features/27-plugins.md has the design. Plugins are compiled in.
import type { ComponentType, ReactNode } from 'react';
import type { MenuEntry } from '../contextMenu';
import type { MessageKey } from '../i18n';
import type { AgentStatus } from '../lib/machine';
import type { SettingDef, SettingValue } from '../settings';
import type { NotificationTarget } from '../shell';
import type { PluginView, TerminalLeaf } from '../term/layout';

/** An icon: lucide's, or one drawn the same way (components/icons.tsx). */
export type IconComponent = ComponentType<{ className?: string }>;

/** A panel of the right sidebar. */
export interface PanelDef {
  /** Unique among all panels: <plugin> or <plugin>.<name>. */
  id: string;
  title: MessageKey;
  icon: IconComponent;
  component: ComponentType;
  /** The command that shows it (declared in backend/kernel/config/keybindings). */
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

/** What runs a command declared in backend/kernel/config/keybindings. */
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

/** A control of a plugin's own for one of its settings: the dialog's row
 * keeps its title, description, menu and errors around it. */
export interface SettingControlProps {
  d: SettingDef;
  value: SettingValue;
  disabled: boolean;
  onChange(v: SettingValue): void;
}

/** A plugin's page in Settings. */
export interface PluginSettingsDef {
  /** The section of its settings (backend/kernel/config/settings), whose page the
   * Plugins page's settings button opens. The hub's section names its
   * plugin as well; a section without settings is a page for extra alone. */
  section: string;
  /** Lays out the page's settings in place of their rows one after the
   * other (pages of its own within the page); a search shows the rows it
   * finds as on any page. */
  layout?: ComponentType<PluginSettingsLayoutProps>;
  /** Drawn at the end of the page. */
  extra?: ComponentType<PluginSettingsProps>;
  /** Controls of its own for some of its settings, by key, in place of
   * the dialog's control of their type (in the user's scope). */
  controls?: Record<string, ComponentType<SettingControlProps>>;
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

/** What a terminal pane's header gives the buttons plugins add to it. */
export interface TerminalHeaderProps {
  m: string;
  /** The terminal's address (its pane's key). */
  terminal: string;
  leaf: TerminalLeaf;
}

/** Buttons a plugin adds to a terminal pane's header, before the pane's
 * own (PaneHeader.tsx; registry.ts TerminalHeaderActions). The header is
 * one stop of the Tab key, its buttons reached with the arrows: they take
 * tabIndex -1. A press leaves the keyboard where it is. */
export type HeaderActionsComponent = ComponentType<TerminalHeaderProps>;

/** An active or attention-needing conversation/agent without an open pane. */
export interface UnopenedAgent {
  id: string;
  title: string;
  directory?: string;
  status: AgentStatus;
  open(): void;
}

/** Status of a plugin's panes as terminal agents have it, for dots, badges, the attention list and
 * notifications (registry.ts viewStatus; notify.ts, seen.ts). */
export interface ViewStatusDef {
  /** Status of the pane showing `view` on machine m: 'working' | 'blocked' | 'done' | 'idle', or undefined.
   * Pure: reads state only. */
  status(m: string, view: PluginView): AgentStatus | undefined;
  /** Calls fn whenever a status may have changed; returns an unsubscribe. */
  subscribe(fn: () => void): () => void;
  /** The pane key (`view:<id>`) an agent notification of this plugin (the /ws agent data, which has
   * plugin-specific members such as `chat`) points to on machine m, if a pane shows it. */
  paneOf?(m: string, data: Record<string, unknown>): string | undefined;
  /** The user saw the pane (it is visible and focused while the page is visible) and its status was done. */
  seen?(m: string, view: PluginView): void;
  /** Conversations/agents on machine m that do not currently have an open pane. */
  unopened?(m: string): UnopenedAgent[];
  /** Opens/focuses a chat target when a notification without an open pane is clicked. */
  openTarget?(target: Extract<NotificationTarget, { kind: 'chat' }>): void | Promise<void>;
}

export interface PluginDef {
  /** As the hub's plugin (backend/kernel/feature.ts): lower-case letters and digits. */
  id: string;
  title: MessageKey;
  description?: MessageKey;
  icon: IconComponent;
  /** The setting that turns it on and off: plugins.<id>.enabled unless
   * it has one of its own; none for parts of the app that are always on. */
  enableSetting?: string | null;
  /** Its content runs on the UI's own origin (VS Code's windows), where
   * its scripts reach whatever the page reaches (the hub's
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
  /** A message of its hub side for machine m ("" for the hub's). */
  onMessage?(m: string, data: unknown): void;
  /** Buttons in terminals' panes' headers (HeaderActionsComponent). */
  headerActions?: HeaderActionsComponent[];
  /** The agent status of its panes, which the app shows and counts as it
   * does terminals' agents' (ViewStatusDef). */
  viewStatus?: ViewStatusDef;
  /** A React hook, as PaneViewDef.useGone, for a file of machine m: the
   * app's own panes that show a file (previews) mark their titles with
   * what the first plugin that is on with one says (the file explorer's);
   * with none on, nothing is marked. */
  useFileGone?(m: string, path: string): string | undefined;
}
