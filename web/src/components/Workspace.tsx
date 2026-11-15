import { useEffect, useRef, useState } from 'react';
import { Columns2, Eye, PanelLeft, Plus, X } from 'lucide-react';
import { useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import * as L from '../term/layout';
import { actions, paneRects, paneTitle, tabLabel, tabName, workspaceTitle } from '../actions';
import { TerminalView } from './TerminalView';
import { PaneHeader } from './PaneHeader';
import { CodeSlot } from './CodeLayer';
import { PreviewPane } from './PreviewPane';
import { CodeIcon } from './icons';
import { StatusDot } from './StatusDot';
import { aggregate, agentStatus, codeText, shortPath, terminalTitle } from '../lib/machine';
import { t, type MessageKey } from '../i18n';
import { withKey } from '../keymap';
import { InlineEdit } from './InlineEdit';
import { startTabDrag } from '../reorderDrag';
import { openMenu } from '../contextMenu';
import { tabMenu } from '../menus';

/** The shown machine's selected workspace: its tab bar and the selected tab's panes. */
export function Workspace() {
  const m = useStore((s) => s.machineId);
  const machine = useStore((s) => (s.machineId ? s.machines[s.machineId] : undefined));
  const mt = useTerms((s) => (m ? s.machines[m] : undefined));
  const renaming = useStore((s) => (s.renaming?.kind === 'tab' ? s.renaming : undefined));
  const setRenaming = useStore((s) => s.setRenaming);
  const readOnly = useStore((s) => s.readOnly);
  const layout = mt?.layout;
  const ws = layout ? L.selectedWorkspace(layout) : undefined;

  if (!m || !machine || !layout || !ws) {
    const backend = mt?.backend;
    const status = !machine
      ? t('workspace.waiting')
      : machine.status !== 'ready'
        ? t('workspace.machineStatus', { machine: machine.label, status: t(`machine.${machine.status}` as MessageKey) })
        : backend?.phase === 'error'
          ? t('workspace.hcError', { machine: machine.label, error: t(`backend.${backend.code}` as MessageKey) })
          : t('workspace.hcStarting', { machine: machine.label });
    return (
      <main className="workspace empty">
        <div className="muted">
          {status}
          {machine?.code && <div className="small">{codeText(machine.code)}</div>}
          <div className="small">{t('workspace.pick')}</div>
        </div>
      </main>
    );
  }
  const tab = ws.tabs[ws.selected];
  const tabStatus = (tb: L.Tab) => aggregate(L.tabTerminals(tb).map((a) => agentStatus(mt.terminals[a])));

  return (
    <main className="workspace">
      <div className="tabbar">
        <button
          className="icon sidebar-toggle"
          title={withKey(t('command.view.toggleSidebar'), 'view.toggleSidebar')}
          aria-label={t('command.view.toggleSidebar')}
          onClick={() => actions.toggleSidebar()}
        >
          <PanelLeft />
        </button>
        <span className="crumb">
          <span className="muted">{machine.label}</span> / {workspaceTitle(m, ws)}
        </span>
        <div className="tabs" data-m={m} data-ws={ws.id}>
          {ws.tabs.map((tb, i) => {
            const st = tabStatus(tb);
            const id = `${ws.id}:${i}`;
            // A tab the user has not named shows its number, or, holding no
            // terminal, its VS Code's or preview's mark and name; the focused
            // pane's title (program, directory) is its tooltip.
            const name = tabName(m, tb);
            const focusedLeaf = L.leafOf(tb.root, tb.focused);
            const title = paneAbout(m, focusedLeaf, tb.focused, mt.terminals[tb.focused]);
            const editing = renaming?.m === m && renaming.id === id;
            const count = L.tabPanes(tb).length;
            const view = !tb.name && !L.tabTerminals(tb).length && focusedLeaf && !L.isTerminalLeaf(focusedLeaf) ? focusedLeaf : undefined;
            const about = [
              tb.name && tb.name !== title ? `${tb.name} · ${title}` : title,
              count > 1 && t('workspace.paneCount', { n: count }),
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <div
                key={`${i}:${tb.focused}`}
                className={`tab ${i === ws.selected ? 'active' : ''}`}
                onDoubleClick={() => !readOnly && actions.startRename('tab', m, id)}
                onPointerDown={(e) => {
                  if (e.button !== 0 || editing || (e.target as HTMLElement).closest('button, input')) return;
                  // A tab is shown on press, as in browsers: a press that turns
                  // into a drag (or whose release lands elsewhere) still switches.
                  actions.selectTab(m, ws.id, i);
                  if (!readOnly) startTabDrag(e, { m, ws: ws.id, index: i, label: name });
                }}
                // A middle click closes the tab, as in browsers.
                onAuxClick={(e) => {
                  if (e.button !== 1 || readOnly || editing) return;
                  e.preventDefault();
                  void actions.closeTab(m, ws.id, i);
                }}
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                onContextMenu={(e) => !editing && openMenu(e, tabMenu(m, ws.id, i))}
                title={readOnly ? about : t('workspace.tabHint', { label: about })}
                aria-label={tb.name ? name : t('workspace.tabNumber', { n: i + 1, title })}
                data-tab={i}
                data-ws={ws.id}
                data-m={m}
              >
                {st && <StatusDot status={st} />}
                {editing ? (
                  <InlineEdit
                    value={name}
                    onDone={(v) => {
                      setRenaming(undefined);
                      // Unchanged keeps it as it was; emptied, it shows its number again.
                      if (v !== undefined && v !== name) actions.renameTab(m, ws.id, i, v);
                    }}
                  />
                ) : tb.name ? (
                  <span className="tab-label ellipsis">{tb.name}</span>
                ) : view ? (
                  <>
                    {L.isCodeLeaf(view) ? <CodeIcon className="tab-kind" /> : <Eye className="tab-kind" />}
                    <span className="tab-label ellipsis">{paneTitle(m, view, tb.focused)}</span>
                  </>
                ) : (
                  <span className="tab-label tab-num">{tabLabel(tb, i)}</span>
                )}
                {count > 1 && <Columns2 className="tab-split" aria-label={t('workspace.paneCount', { n: count })} />}
                {!readOnly && (
                  <button
                    className="tab-close"
                    title={withKey(t('command.tab.close'), 'tab.close')}
                    aria-label={t('command.tab.close')}
                    onClick={(e) => {
                      e.stopPropagation();
                      void actions.closeTab(m, ws.id, i);
                    }}
                  >
                    <X />
                  </button>
                )}
              </div>
            );
          })}
          {!readOnly && (
            <button
              className="icon new-tab"
              title={withKey(t('command.tab.new'), 'tab.new')}
              aria-label={t('command.tab.new')}
              onClick={() => void actions.newTab(m, ws.id)}
              data-new-tab={ws.id}
              data-m={m}
            >
              <Plus />
            </button>
          )}
        </div>
      </div>
      <div className="workspace-body">
        {tab ? (
          <TabView m={m} ws={ws.id} tab={tab} />
        ) : (
          <div className="empty-state">
            <div>{t('workspace.noTabs')}</div>
            {!readOnly && (
              <button className="primary" onClick={() => void actions.newTab(m, ws.id)}>
                {withKey(t('command.tab.new'), 'tab.new')}
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

interface SplitBar {
  path: boolean[];
  axis: L.Axis;
  /** The split's area, as fractions of the tab. */
  area: { x: number; y: number; w: number; h: number };
  ratio: number;
}

/** The splits of a tree with their areas, for their handles. */
function splitBars(node: L.Node, area = { x: 0, y: 0, w: 1, h: 1 }, path: boolean[] = [], out: SplitBar[] = []): SplitBar[] {
  if (!L.isSplit(node)) return out;
  out.push({ path, axis: node.split, area, ratio: node.ratio });
  const [a, b] = node.children;
  if (node.split === 'horizontal') {
    const w1 = area.w * node.ratio;
    splitBars(a, { ...area, w: w1 }, [...path, false], out);
    splitBars(b, { ...area, x: area.x + w1, w: area.w - w1 }, [...path, true], out);
  } else {
    const h1 = area.h * node.ratio;
    splitBars(a, { ...area, h: h1 }, [...path, false], out);
    splitBars(b, { ...area, y: area.y + h1, h: area.h - h1 }, [...path, true], out);
  }
  return out;
}

const pct = (v: number) => `${v * 100}%`;

/** What a pane is, for tooltips: a terminal's title, VS Code and its
 * folder, a preview and its file. */
function paneAbout(m: string, leaf: L.Leaf | null, key: string, record: Parameters<typeof terminalTitle>[0]): string {
  const home = useStore.getState().machines[m]?.info?.home;
  if (leaf && L.isCodeLeaf(leaf)) return `${t('code.title')} · ${shortPath(leaf.code.folder, home) || '~'}`;
  if (leaf && L.isPreviewLeaf(leaf)) return `${t('preview.title')} · ${shortPath(leaf.preview.path, home)}`;
  return terminalTitle(record, key);
}

/** A tab's panes, each placed by its share of the split tree; the panes
 * keep their terminals (and VS Code its window) while the tree around them
 * changes. */
function TabView({ m, ws, tab }: { m: string; ws: string; tab: L.Tab }) {
  const zoomed = useStore((s) => (s.zoomed?.m === m ? s.zoomed.pane : undefined));
  const readOnly = useStore((s) => s.readOnly);
  const panes = L.tabPanes(tab);
  const zoom = zoomed && panes.includes(zoomed) ? zoomed : undefined;
  const rects = zoom ? new Map([[zoom, { x: 0, y: 0, w: 1, h: 1 }]]) : paneRects(tab.root);
  const bars = zoom || readOnly ? [] : splitBars(tab.root);
  const body = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{ path: boolean[]; ratio: number }>();
  const alone = panes.length === 1;

  // A zoomed pane that left the tab is no longer zoomed.
  useEffect(() => {
    if (zoomed && !panes.includes(zoomed)) useStore.getState().setZoomed(undefined);
  }, [zoomed, panes.join()]);

  const dragBar = (e: React.PointerEvent, bar: SplitBar) => {
    e.preventDefault();
    const box = body.current!.getBoundingClientRect();
    const ratioAt = (ev: { clientX: number; clientY: number }) => {
      const r =
        bar.axis === 'horizontal'
          ? ((ev.clientX - box.left) / box.width - bar.area.x) / bar.area.w
          : ((ev.clientY - box.top) / box.height - bar.area.y) / bar.area.h;
      return Math.min(0.9, Math.max(0.1, r));
    };
    let moved = false;
    const cls = bar.axis === 'horizontal' ? 'resizing' : 'resizing-row';
    const move = (ev: PointerEvent) => {
      if (!moved) document.body.classList.add(cls);
      moved = true;
      setDragging({ path: bar.path, ratio: ratioAt(ev) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove(cls);
      setDragging(undefined);
      // A press without a move (the first click of a double click) leaves the ratio.
      if (!moved) return;
      const ratio = ratioAt(ev);
      terms.mutate(m, (l) => L.setRatio(l, bar.path, ratio));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className={`tab-panes ${alone ? 'alone' : ''}`} ref={body}>
      {[...rects].map(([key, r]) => {
        const leaf = L.leafOf(tab.root, key);
        if (!leaf) return null;
        const focused = key === tab.focused;
        return (
          <div
            // Machines name their terminals alike ("t1" on each): the
            // machine is part of the key, so a pane of another machine gets
            // its own canvas, not one whose WebGL context the pane before
            // it gave up.
            key={`${m}\n${key}`}
            className={`pane ${focused && !alone ? 'focused' : ''}`}
            style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}
            data-pane={key}
            data-m={m}
            data-ws={ws}
          >
            <PaneHeader m={m} pane={key} leaf={leaf} ws={ws} focused={focused} zoomed={!!zoom} />
            {L.isTerminalLeaf(leaf) ? (
              <TerminalView
                m={m}
                terminal={key}
                focused={focused}
                onActivate={() => key !== tab.focused && terms.mutate(m, (l) => L.focusPane(l, key))}
              />
            ) : L.isCodeLeaf(leaf) ? (
              <CodeSlot m={m} pane={key} view={leaf.code} />
            ) : (
              <PreviewPane m={m} pane={key} path={leaf.preview.path} />
            )}
          </div>
        );
      })}
      {bars.map((b) => {
        const ratio = dragging && dragging.path.join() === b.path.join() ? dragging.ratio : b.ratio;
        const style =
          b.axis === 'horizontal'
            ? { left: pct(b.area.x + b.area.w * ratio), top: pct(b.area.y), height: pct(b.area.h) }
            : { top: pct(b.area.y + b.area.h * ratio), left: pct(b.area.x), width: pct(b.area.w) };
        return (
          <div
            key={b.path.map(Number).join('') || 'root'}
            className={`split-handle ${b.axis === 'horizontal' ? 'h' : 'v'} ${dragging?.path.join() === b.path.join() ? 'dragging' : ''}`}
            style={style}
            role="separator"
            aria-orientation={b.axis === 'horizontal' ? 'vertical' : 'horizontal'}
            title={t('pane.dividerHint')}
            onPointerDown={(e) => e.button === 0 && dragBar(e, b)}
            // A double click shares the split equally again.
            onDoubleClick={() => terms.mutate(m, (l) => L.setRatio(l, b.path, 0.5))}
          />
        );
      })}
    </div>
  );
}
