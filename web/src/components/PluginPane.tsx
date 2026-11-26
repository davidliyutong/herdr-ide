// The body of a plugin's pane (term/layout.ts PluginLeaf), drawn by the
// plugin that made it (web/src/plugins); while that plugin is off or
// unknown to this version the pane says so and keeps its place.
import { useEffect, useRef, type ReactNode } from 'react';
import { Eye, Puzzle } from 'lucide-react';
import { registerPane } from '../state/panes';
import * as L from '../term/layout';
import { allPlugins, findPanel, paneView, PANEL_VIEW, useActivePlugins } from '../plugins/registry';
import type { PluginDef } from '../plugins/api';
import { useSettings } from '../settings';
import { t } from '../i18n';
import { CodeIcon } from './icons';
import { PluginBoundary } from './PluginBoundary';

/** A plugin's name as the user reads it (its id when it has none). */
export function pluginName(id: string): string {
  const p = allPlugins().find((x) => x.id === id);
  return p ? t(p.title) : id;
}

export function PluginPane({
  m,
  pane,
  view,
  focused,
  shown = true,
}: {
  m: string;
  pane: string;
  view: L.PluginView;
  focused: boolean;
  shown?: boolean;
}) {
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
          <Body m={m} pane={pane} view={view} focused={focused} shown={shown} />
        </PluginBoundary>
      ) : (
        <div className="plugin-pane-off muted">{t(def ? 'plugins.paneOff' : 'plugins.paneUnknown', { plugin: view.plugin })}</div>
      )}
    </div>
  );
}

interface TitleProps {
  m: string;
  className: string;
  /** The tooltip, given what is said of a pane whose content is gone. */
  tooltip(gone?: string): string;
  children: ReactNode;
}

/** A plugin pane's title in its header or tab: in italics for a preview,
 * struck through while what it shows is gone (PaneViewDef.useGone), its
 * tooltip then saying so. */
export function ViewTitle(p: TitleProps & { view: L.PluginView }) {
  const { def, on } = paneView(p.view.plugin, p.view.kind);
  const className = `${p.className} ${def?.preview?.(p.m, p.view) ? 'is-preview' : ''}`;
  const use = on ? def?.useGone : undefined;
  // A component of its own for the hook, which only an active plugin has.
  if (use) return <GoneTitle key={`${p.view.plugin}:${p.view.kind}`} {...p} className={className} useGone={() => use(p.m, p.view)} />;
  return (
    <span className={className} title={p.tooltip()}>
      {p.children}
    </span>
  );
}

/** The plugin that is on and says whether files are gone
 * (PluginDef.useFileGone), re-rendered when plugins are turned on or off. */
function useFileGoneSource(): PluginDef | undefined {
  return useActivePlugins().find((x) => x.useFileGone);
}

/** The title of an app's pane that shows a file of machine m (a preview)
 * in its header or tab: struck through while the file is gone, as the
 * plugin that knows says (PluginDef.useFileGone), its tooltip then saying
 * so; plain with no such plugin on. */
export function FileTitle(p: TitleProps & { path: string }) {
  const source = useFileGoneSource();
  const use = source?.useFileGone;
  if (use) return <GoneTitle key={source.id} {...p} useGone={() => use(p.m, p.path)} />;
  return (
    <span className={p.className} title={p.tooltip()}>
      {p.children}
    </span>
  );
}

/** Calls onBack when the file at path of machine m, gone (as FileTitle
 * marks it), is there again: a pane that shows it loads it again. */
export function FileBack({ m, path, onBack }: { m: string; path: string; onBack(): void }) {
  const source = useFileGoneSource();
  const use = source?.useFileGone;
  return use ? <GoneWatch key={source.id} useGone={() => use(m, path)} onBack={onBack} /> : null;
}

function GoneWatch({ useGone, onBack }: { useGone(): string | undefined; onBack(): void }) {
  const gone = !!useGone();
  const was = useRef(gone);
  useEffect(() => {
    if (was.current && !gone) onBack();
    was.current = gone;
  }, [gone]);
  return null;
}

/** A title with what useGone (a hook) says of its content: struck through
 * while that is gone. */
function GoneTitle(p: Omit<TitleProps, 'm'> & { useGone(): string | undefined }) {
  const gone = p.useGone();
  return (
    <span className={`${p.className} ${gone ? 'is-gone' : ''}`} title={p.tooltip(gone)}>
      {p.children}
    </span>
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
