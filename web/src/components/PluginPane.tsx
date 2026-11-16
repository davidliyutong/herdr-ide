// The body of a plugin's pane (term/layout.ts PluginLeaf), drawn by the
// plugin that made it (web/src/plugins); while that plugin is off or
// unknown to this version the pane says so and keeps its place.
import { useEffect, useRef } from 'react';
import { Eye, Puzzle } from 'lucide-react';
import { registerPane } from '../state/panes';
import * as L from '../term/layout';
import { allPlugins, findPanel, paneView, PANEL_VIEW } from '../plugins/registry';
import { useSettings } from '../settings';
import { t } from '../i18n';
import { CodeIcon } from './icons';
import { PluginBoundary } from './PluginBoundary';

/** A plugin's name as the user reads it (its id when it has none). */
export function pluginName(id: string): string {
  const p = allPlugins().find((x) => x.id === id);
  return p ? t(p.title) : id;
}

export function PluginPane({ m, pane, view, focused }: { m: string; pane: string; view: L.PluginView; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Re-rendered when a plugin is turned on or off.
  useSettings((s) => s.values);
  const { def, on } = paneView(view.plugin, view.kind);
  useEffect(
    () =>
      registerPane(m, pane, {
        focus: () => {
          const el = ref.current;
          (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el)?.focus();
        },
      }),
    [m, pane],
  );
  const Body = on ? def?.component : undefined;
  return (
    <div ref={ref} className="plugin-pane" tabIndex={-1}>
      {Body ? (
        <PluginBoundary plugin={pluginName(view.plugin)} resetKey={JSON.stringify(view)}>
          <Body m={m} pane={pane} view={view} focused={focused} />
        </PluginBoundary>
      ) : (
        <div className="plugin-pane-off muted">{t(def ? 'plugins.paneOff' : 'plugins.paneUnknown', { plugin: view.plugin })}</div>
      )}
    </div>
  );
}

/** The icon of a pane that is not a terminal: VS Code, a preview, or its plugin's. */
export function LeafIcon({ leaf, className }: { m: string; leaf: L.Leaf; className?: string }) {
  if (L.isCodeLeaf(leaf)) return <CodeIcon className={className} />;
  if (L.isPluginLeaf(leaf)) {
    const v = leaf.view;
    const Icon = (v.kind === PANEL_VIEW ? findPanel(v.plugin, v.panel)?.icon : undefined) ?? paneView(v.plugin, v.kind).def?.icon ?? Puzzle;
    return <Icon className={className} />;
  }
  return <Eye className={className} />;
}
