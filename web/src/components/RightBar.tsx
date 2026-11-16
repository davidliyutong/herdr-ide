// The right sidebar: a rail with a button per panel of the plugins that are
// on (web/src/plugins), and the panel shown. On a wide window the panel
// takes a column of its own and covers no pane; on a narrow one it lies
// over the panes, as the left sidebar does, and a press beside it or
// Escape hides it. Large content (diffs, editors, graphs) opens as panes,
// and a panel itself can be a pane (panelPanes.ts): its rail button or its
// title dragged onto the panes, or Open in Pane.
import { useEffect } from 'react';
import { SquareArrowOutUpLeft, X } from 'lucide-react';
import { PANEL_WIDTH, useStore } from '../state/store';
import { usePanels } from '../plugins/registry';
import { keyHint } from '../keymap';
import { t } from '../i18n';
import type { PanelDef } from '../plugins/api';
import { PluginBoundary } from './PluginBoundary';
import { openPanelInPane, startPanelDrag } from '../panelPanes';

/** A press that may become a drag of a panel onto the panes. */
function dragPanel(ev: React.PointerEvent, panel: PanelDef) {
  if (ev.button !== 0 || useStore.getState().readOnly) return;
  startPanelDrag(ev, panel);
}

/** Shows a panel, or hides the right sidebar when it is the one shown. */
export function togglePanel(id: string) {
  const s = useStore.getState();
  s.setPanel(s.panel === id ? undefined : id);
}

export function RightBar() {
  const panels = usePanels();
  const id = useStore((s) => s.panel);
  const shown = panels.find((p) => p.id === id);
  if (!panels.length) return null;
  return (
    <>
      {shown && <Panel panel={shown} />}
      {shown && <div className="panel-backdrop" onClick={() => useStore.getState().setPanel(undefined)} />}
      <nav className="panel-rail" aria-label={t('plugins.rail')}>
        {panels.map((p) => {
          const Icon = p.icon;
          const key = p.command ? keyHint(p.command) : '';
          const label = t(p.title);
          return (
            <button
              key={p.id}
              className={`rail-button ${p.id === id ? 'active' : ''}`}
              title={key ? `${label} (${key})` : label}
              aria-label={label}
              aria-pressed={p.id === id}
              data-panel={p.id}
              onPointerDown={(e) => dragPanel(e, p)}
              onClick={() => togglePanel(p.id)}
            >
              <Icon />
            </button>
          );
        })}
      </nav>
    </>
  );
}

function Panel({ panel }: { panel: PanelDef }) {
  const Body = panel.component;
  const readOnly = useStore((s) => s.readOnly);
  useEffect(() => {
    // Escape hides the panel while it lies over the panes.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && window.matchMedia('(max-width: 760px)').matches) useStore.getState().setPanel(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <aside className="panel" data-panel={panel.id} aria-label={t(panel.title)}>
      <PanelResizer />
      <div className="panel-head">
        <span className="panel-title ellipsis" title={t('plugins.dragPanel')} onPointerDown={(e) => dragPanel(e, panel)}>
          {t(panel.title)}
        </span>
        {!readOnly && (
          <button
            className="icon"
            title={t('plugins.openInPane')}
            aria-label={t('plugins.openInPane')}
            onClick={() => void openPanelInPane(panel)}
          >
            <SquareArrowOutUpLeft />
          </button>
        )}
        <button
          className="icon"
          title={t('plugins.hidePanel')}
          aria-label={t('plugins.hidePanel')}
          onClick={() => useStore.getState().setPanel(undefined)}
        >
          <X />
        </button>
      </div>
      <div className="panel-body">
        <PluginBoundary plugin={t(panel.title)} resetKey={panel.id}>
          <Body />
        </PluginBoundary>
      </div>
    </aside>
  );
}

/** The panel's left edge: dragging it sets the width (kept per browser),
 * dragging it far right hides the panel, a double click gives the default
 * width back. */
function PanelResizer() {
  const onPointerDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const s = useStore.getState();
    const start = ev.clientX;
    const startW = s.panelWidth;
    const panel = s.panel;
    document.body.classList.add('resizing');
    const width = (e: PointerEvent) => startW - (e.clientX - start);
    const move = (e: PointerEvent) => useStore.getState().setPanelWidth(width(e));
    const up = (e: PointerEvent) => {
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (width(e) < PANEL_WIDTH.min - 60) {
        useStore.getState().setPanelWidth(startW);
        if (useStore.getState().panel === panel) useStore.getState().setPanel(undefined);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      title={t('sidebar.resize')}
      onPointerDown={onPointerDown}
      onDoubleClick={() => useStore.getState().setPanelWidth(PANEL_WIDTH.def)}
    />
  );
}
