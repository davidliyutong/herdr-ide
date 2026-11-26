// Lazy plugin wrapper: registers a lightweight PluginDef stub synchronously so
// rail icons, plugin lists, settings navigation and view metadata are available
// immediately at startup without bundling heavy plugin modules into the main
// entry chunk. On first UI render, command invocation or hub message, the full
// plugin module is imported once, replaces the stub in registry.ts, and replays
// any buffered hub messages in order.
import { createElement, lazy, type ComponentType } from 'react';
import type {
  CommandDef,
  IconComponent,
  NewTabItem,
  PanelDef,
  PaneViewDef,
  PaneViewProps,
  PluginDef,
  PluginSettingsLayoutProps,
  PluginSettingsProps,
  SettingControlProps,
  StatusItemDef,
} from './api';
import type { MessageKey } from '../i18n';
import type { PluginView } from '../term/layout';
import { registerPluginLoader, replacePlugin } from './registry';

const Empty: ComponentType<Record<string, never>> = () => null;
const EmptyLayout: ComponentType<PluginSettingsLayoutProps> = ({ defs, rows, lead }) => createElement('div', null, lead, rows(defs));

export interface LazyPanelStub {
  id: string;
  title: MessageKey;
  icon: IconComponent;
  command?: string;
}

export interface LazyPaneViewStub {
  icon: IconComponent;
  title(m: string, view: PluginView): string;
  path?(m: string, view: PluginView): string | undefined;
  directory?(m: string, view: PluginView): string | undefined;
  preview?(m: string, view: PluginView): boolean;
}

export interface LazySettingsStub {
  section: string;
  hasLayout?: boolean;
  hasExtra?: boolean;
  controlKeys?: readonly string[];
}

export interface LazyStatusWidgetStub {
  id: string;
  title: MessageKey;
}

export interface LazyNewTabStub {
  id: string;
  title: MessageKey;
  icon: IconComponent;
}

export interface LazyPluginStub {
  id: string;
  title: MessageKey;
  description?: MessageKey;
  icon: IconComponent;
  enableSetting?: string | null;
  panels?: readonly LazyPanelStub[];
  paneViews?: Record<string, LazyPaneViewStub>;
  commands?: Record<string, { enabled?(): boolean }>;
  settings?: LazySettingsStub;
  /** Toggleable status bar widgets mounted after first paint; rendering one
   * triggers loading the real plugin module. */
  statusWidgets?: readonly LazyStatusWidgetStub[];
  /** New-tab menu items advertised synchronously before the plugin loads. */
  newTabItems?: readonly LazyNewTabStub[];
  /** Whether the plugin mounts non-widget background status items (e.g. modal
   * portals or approval prompts) that should load after first paint. */
  hasBackgroundStatus?: boolean;
  /** Whether the plugin receives /ws plugin messages (buffered until loaded). */
  receivesMessages?: boolean;
  /** Optional lightweight synchronous message handler run before the full
   * plugin loads (also triggers loading the plugin so UI overlays mount). */
  onMessage?(m: string, data: unknown): void;
}

/** Creates a PluginDef shell backed by a dynamic import. */
export function lazyPlugin(stub: LazyPluginStub, load: () => Promise<PluginDef>): PluginDef {
  let loaded: PluginDef | undefined;
  let pending: Promise<PluginDef> | undefined;
  let buffered: Array<{ m: string; data: unknown }> = [];

  const ensure = (): Promise<PluginDef> => {
    if (loaded) return Promise.resolve(loaded);
    pending ??= load()
      .then((real) => {
        loaded = real;
        replacePlugin(stub.id, real, def);
        const queued = buffered;
        buffered = [];
        for (const msg of queued) real.onMessage?.(msg.m, msg.data);
        return real;
      })
      .catch((err) => {
        pending = undefined;
        throw err;
      });
    return pending;
  };

  const panels: PanelDef[] | undefined = stub.panels?.map((p) => {
    const LazyPanel = lazy(async () => {
      const real = await ensure();
      const found = real.panels?.find((x) => x.id === p.id);
      return { default: found?.component ?? Empty };
    });
    return {
      id: p.id,
      title: p.title,
      icon: p.icon,
      command: p.command,
      component: LazyPanel,
    };
  });

  const paneViews: Record<string, PaneViewDef> | undefined = stub.paneViews
    ? Object.fromEntries(
        Object.entries(stub.paneViews).map(([kind, v]) => {
          const LazyPane = lazy<ComponentType<PaneViewProps>>(async () => {
            const real = await ensure();
            const found = real.paneViews?.[kind];
            return { default: found?.component ?? (Empty as unknown as ComponentType<PaneViewProps>) };
          });
          const viewDef: PaneViewDef = {
            icon: v.icon,
            title: (m, view) => loaded?.paneViews?.[kind]?.title(m, view) ?? v.title(m, view),
            ...(v.path ? { path: (m, view) => loaded?.paneViews?.[kind]?.path?.(m, view) ?? v.path!(m, view) } : {}),
            ...(v.directory ? { directory: (m, view) => loaded?.paneViews?.[kind]?.directory?.(m, view) ?? v.directory!(m, view) } : {}),
            ...(v.preview ? { preview: (m, view) => loaded?.paneViews?.[kind]?.preview?.(m, view) ?? v.preview!(m, view) } : {}),
            menu: (m, view) => {
              if (loaded) return loaded.paneViews?.[kind]?.menu?.(m, view) ?? [];
              void ensure();
              return [];
            },
            component: LazyPane,
          };
          return [kind, viewDef];
        }),
      )
    : undefined;

  const commands: Record<string, CommandDef> | undefined = stub.commands
    ? Object.fromEntries(
        Object.entries(stub.commands).map(([id, c]) => [
          id,
          {
            ...(c.enabled ? { enabled: () => (loaded ? (loaded.commands?.[id]?.enabled?.() ?? true) : c.enabled!()) } : {}),
            run() {
              void ensure().then((real) => real.commands?.[id]?.run());
            },
          },
        ]),
      )
    : undefined;

  const settings = stub.settings
    ? {
        section: stub.settings.section,
        ...(stub.settings.hasLayout
          ? {
              layout: lazy<ComponentType<PluginSettingsLayoutProps>>(async () => {
                const real = await ensure();
                return { default: real.settings?.layout ?? EmptyLayout };
              }),
            }
          : {}),
        ...(stub.settings.hasExtra
          ? {
              extra: lazy<ComponentType<PluginSettingsProps>>(async () => {
                const real = await ensure();
                return { default: real.settings?.extra ?? (Empty as unknown as ComponentType<PluginSettingsProps>) };
              }),
            }
          : {}),
        ...(stub.settings.controlKeys?.length
          ? {
              controls: Object.fromEntries(
                stub.settings.controlKeys.map((key) => [
                  key,
                  lazy<ComponentType<SettingControlProps>>(async () => {
                    const real = await ensure();
                    return { default: real.settings?.controls?.[key] ?? (Empty as unknown as ComponentType<SettingControlProps>) };
                  }),
                ]),
              ),
            }
          : {}),
      }
    : undefined;

  const statusItems: StatusItemDef[] = [];
  for (const w of stub.statusWidgets ?? []) {
    const LazyWidget = lazy(async () => {
      const real = await ensure();
      const found = real.statusItems?.find((entry) => typeof entry === 'object' && entry !== null && 'id' in entry && entry.id === w.id);
      return { default: found && 'component' in found ? found.component : Empty };
    });
    statusItems.push({ id: w.id, title: w.title, component: LazyWidget });
  }
  if (stub.hasBackgroundStatus) {
    // Triggers loading the plugin when StatusBar mounts so background status
    // components (approvals, dialogs) activate right after first paint.
    const BackgroundLoader = lazy(async () => {
      await ensure();
      return { default: Empty };
    });
    statusItems.push(BackgroundLoader);
  }

  const newTabItems: ((m: string) => NewTabItem[]) | undefined = stub.newTabItems?.length
    ? (m) => {
        if (loaded) return loaded.newTabItems?.(m) ?? [];
        return stub.newTabItems!.map((item) => ({
          id: item.id,
          title: item.title,
          icon: item.icon,
          run: (machine, ws) => {
            void ensure().then((real) =>
              real
                .newTabItems?.(machine)
                .find((x) => x.id === item.id)
                ?.run(machine, ws),
            );
          },
        }));
      }
    : undefined;

  const def: PluginDef = {
    id: stub.id,
    title: stub.title,
    ...(stub.description ? { description: stub.description } : {}),
    icon: stub.icon,
    ...(stub.enableSetting !== undefined ? { enableSetting: stub.enableSetting } : {}),
    ...(panels ? { panels } : {}),
    ...(paneViews ? { paneViews } : {}),
    ...(commands ? { commands } : {}),
    ...(settings ? { settings } : {}),
    ...(statusItems.length ? { statusItems } : {}),
    ...(newTabItems ? { newTabItems } : {}),
    ...(stub.onMessage
      ? {
          onMessage(m: string, data: unknown) {
            if (loaded) {
              loaded.onMessage?.(m, data);
              return;
            }
            stub.onMessage!(m, data);
            void ensure();
          },
        }
      : stub.receivesMessages
        ? {
            onMessage(m: string, data: unknown) {
              if (loaded) {
                loaded.onMessage?.(m, data);
                return;
              }
              if (buffered.length < 64) buffered.push({ m, data });
              void ensure();
            },
          }
        : {}),
  };

  registerPluginLoader(stub.id, ensure, def);
  return def;
}
