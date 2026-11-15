import { useEffect, useRef, useState } from 'react';
import { PanelLeft, Plus, X } from 'lucide-react';
import { useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import * as L from '../term/layout';
import { actions, paneRects, tabName } from '../actions';
import { TerminalView } from './TerminalView';
import { PaneHeader } from './PaneHeader';
import { StatusDot } from './StatusDot';
import { aggregate, agentStatus, codeText } from '../lib/machine';
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
          title={withKey(t('workspace.sidebar'), 'view.toggleSidebar')}
          onClick={() => actions.toggleSidebar()}
        >
          <PanelLeft />
        </button>
        <span className="crumb">
          <span className="muted">{machine.label}</span> / {ws.name || t('workspace.default')}
        </span>
        <div className="tabs" data-m={m} data-ws={ws.id}>
          {ws.tabs.map((tb, i) => {
            const st = tabStatus(tb);
            const id = `${ws.id}:${i}`;
            const name = tabName(m, tb);
            const editing = renaming?.m === m && renaming.id === id;
            const count = L.tabTerminals(tb).length;
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
                onContextMenu={(e) => !editing && openMenu(e, tabMenu(m, ws.id, i))}
                title={readOnly ? name : t('workspace.tabHint', { label: name })}
                data-tab={i}
                data-ws={ws.id}
                data-m={m}
              >
                {st && <StatusDot status={st} />}
                {editing ? (
                  <InlineEdit
                    value={tb.name ?? name}
                    onDone={(v) => {
                      setRenaming(undefined);
                      if (v !== undefined && v !== (tb.name ?? '')) actions.renameTab(m, ws.id, i, v);
                    }}
                  />
                ) : (
                  <span className="tab-label ellipsis">{name}</span>
                )}
                {count > 1 && (
                  <span className="tab-count" title={t('workspace.paneCount', { n: count })}>
                    {count}
                  </span>
                )}
                {!readOnly && (
                  <button
                    className="tab-close"
                    title={withKey(t('workspace.closeTab'), 'tab.close')}
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
              className="icon"
              title={withKey(t('workspace.newTab'), 'tab.new')}
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
          <div className="muted pad">
            {t('workspace.noTabs')}
            {!readOnly && (
              <div className="row">
                <button onClick={() => void actions.newTab(m, ws.id)}>{t('command.tab.new')}</button>
              </div>
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

/** A tab's panes, each placed by its share of the split tree; the panes
 * keep their terminals while the tree around them changes. */
function TabView({ m, ws, tab }: { m: string; ws: string; tab: L.Tab }) {
  const zoomed = useStore((s) => (s.zoomed?.m === m ? s.zoomed.terminal : undefined));
  const readOnly = useStore((s) => s.readOnly);
  const terminals = L.tabTerminals(tab);
  const zoom = zoomed && terminals.includes(zoomed) ? zoomed : undefined;
  const rects = zoom ? new Map([[zoom, { x: 0, y: 0, w: 1, h: 1 }]]) : paneRects(tab.root);
  const bars = zoom || readOnly ? [] : splitBars(tab.root);
  const body = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{ path: boolean[]; ratio: number }>();
  const alone = terminals.length === 1;

  // A zoomed terminal that left the tab is no longer zoomed.
  useEffect(() => {
    if (zoomed && !terminals.includes(zoomed)) useStore.getState().setZoomed(undefined);
  }, [zoomed, terminals.join()]);

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
    const move = (ev: PointerEvent) => setDragging({ path: bar.path, ratio: ratioAt(ev) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(undefined);
      const ratio = ratioAt(ev);
      terms.mutate(m, (l) => L.setRatio(l, bar.path, ratio));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className={`tab-panes ${alone ? 'alone' : ''}`} ref={body}>
      {[...rects].map(([terminal, r]) => (
        <div
          key={terminal}
          className={`pane ${terminal === tab.focused && !alone ? 'focused' : ''}`}
          style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}
          data-terminal={terminal}
          data-m={m}
          data-ws={ws}
        >
          <PaneHeader m={m} terminal={terminal} ws={ws} focused={terminal === tab.focused} zoomed={!!zoom} />
          <TerminalView
            m={m}
            terminal={terminal}
            focused={terminal === tab.focused}
            onActivate={() => terminal !== tab.focused && terms.mutate(m, (l) => L.focusTerminal(l, terminal))}
          />
        </div>
      ))}
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
            onPointerDown={(e) => dragBar(e, b)}
          />
        );
      })}
    </div>
  );
}
