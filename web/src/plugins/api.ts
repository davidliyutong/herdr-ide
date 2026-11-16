// The web UI's side of plugins: features built into the app that add
// panels to the right sidebar, kinds of panes, commands, status bar items,
// palette items and handlers of their messages from the core (/ws
// plugin {plugin, m, data}). The core's side of each is in internal/plugin;
// docs/features/27-plugins.md has the design. Plugins are compiled in.
import type { ComponentType } from 'react';
import type { MessageKey } from '../i18n';
import type { PluginView } from '../term/layout';

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
  panels?: PanelDef[];
  /** By kind. */
  paneViews?: Record<string, PaneViewDef>;
  /** By command id. */
  commands?: Record<string, CommandDef>;
  /** Shown in the status bar, right of the machine's line. */
  statusItems?: ComponentType[];
  paletteItems?(): PaletteItem[];
  /** A message of its core side for machine m ("" for the core's). */
  onMessage?(m: string, data: unknown): void;
}
