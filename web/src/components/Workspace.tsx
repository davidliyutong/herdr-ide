import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { BellOff, ChevronDown, Columns2, PanelLeft, Pin, Plus, X } from 'lucide-react';
import { useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import * as L from '../term/layout';
import { actions, focusPaneInLayout, paneRects, paneTitle, tabLabel, tabName, tabStatus } from '../actions';
import { TerminalView } from './TerminalView';
import { PaneHeader } from './PaneHeader';
import { CodeSlot } from './CodeLayer';
import { FileTitle, LeafIcon, PluginPane, ViewTitle } from './PluginPane';

const PreviewPane = lazy(() => import('./PreviewPane').then((m) => ({ default: m.PreviewPane })));
import { describeView, newTabGroups, useActivePlugins, useViewStatusOf, viewActive } from '../plugins/registry';
import { StatusDot } from './StatusDot';
import { codeText, shortPath, terminalTitle } from '../lib/machine';
import { t, type MessageKey } from '../i18n';
import { withKey } from '../keymap';
import { InlineEdit } from './InlineEdit';
import { startTabDrag } from '../tabDrag';
import { detachedRecordForPane, detachedRecordForTab, isDetachedWindow, requestDockAll, useDetachedTabs } from '../detachedWindow';
import { dropEdit } from '../unsaved';
import { isKeepableChatLeaf, isKeepableFileLeaf, keepChatPanes, keepFilePanes, keepPanes, resetKeptPanes } from '../keptPanes';
import { usePrefs } from '../prefs';
import { openMenu } from '../contextMenu';
import { newTabMenu, tabMenu, tabsMenu } from '../menus';
import {
  clearMulti,
  clickRow,
  extendTo,
  inMulti,
  selectAllRows,
  selectedIds,
  tabId,
  targetIds,
  useMulti,
  type MultiScope,
} from '../state/multiSelect';
import { ensureTabStop, isDeleteKey, isMenuKey, isToggleKey, keepFocus, openRowMenu, rove, ROW } from '../rowKeys';

const tabsOf = (m: string, ws: string): MultiScope => ({ kind: 'tab', m, ws });

/** The visible tab a workspace shows, which starts a selection of its tabs. */
const shownTab = (m: string, ws: string) => {
  const w = terms.layout(m)?.workspaces.find((x) => x.id === ws);
  if (!w) return undefined;
  const records = useDetachedTabs.getState().records;
  const visible = w.tabs.map((tb, i) => ({ tb, i })).filter(({ tb }) => !detachedRecordForTab(m, tb, records));
  const tab = (visible.find((x) => x.i === w.selected) ?? visible[0])?.tb;
  return tab ? tabId(tab) : undefined;
};

/** The menu of a tab, or of the tabs selected with it. */
function tabMenuFor(m: string, ws: string, index: number, id: string) {
  const scope = tabsOf(m, ws);
  if (inMulti(scope, id)) return tabsMenu(m, ws, selectedIds(scope));
  clearMulti();
  return tabMenu(m, ws, index);
}

/** The tab bar's keys on a tab: ← → Home End move between tabs (Shift
 * extends the selection), Enter or Space shows it, Ctrl+Space toggles
 * it in the selection, ⌘/Ctrl+A selects every tab, F2 renames, Delete
 * closes (with Undo), the menu key or Shift+F10 opens its menu, Escape
 * clears the selection. */
function onTabsKey(e: React.KeyboardEvent<HTMLElement>, m: string, ws: string) {
  const row = (e.target as HTMLElement).closest<HTMLElement>(`.tab${ROW}`);
  if (!row || (e.target as HTMLElement).closest('input')) return;
  const els = [...e.currentTarget.querySelectorAll<HTMLElement>(`.tab${ROW}`)];
  const i = els.indexOf(row);
  const layoutIndex = Number(row.dataset.tab);
  const id = row.dataset.nav!;
  const scope = tabsOf(m, ws);
  const readOnly = useStore.getState().readOnly;
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  const mod = e.metaKey || e.ctrlKey;
  const done = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  const go = (to: number) => {
    const el = els[Math.max(0, Math.min(els.length - 1, to))];
    if (!el) return;
    done();
    el.focus();
    if (e.shiftKey) extendTo(scope, id, el.dataset.nav!);
  };
  if (plain && e.key === 'ArrowLeft') go(i - 1);
  else if (plain && e.key === 'ArrowRight') go(i + 1);
  else if (plain && e.key === 'Home') go(0);
  else if (plain && e.key === 'End') go(els.length - 1);
  else if (plain && (e.key === 'Enter' || e.key === ' ')) {
    done();
    if (Number.isInteger(layoutIndex) && layoutIndex >= 0) actions.selectTab(m, ws, layoutIndex);
  } else if (isToggleKey(e)) {
    done();
    clickRow({ shiftKey: false, metaKey: true, ctrlKey: true }, scope, id, shownTab(m, ws));
  } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
    done();
    selectAllRows(scope, shownTab(m, ws));
  } else if (e.key === 'F2' && plain && !readOnly) {
    done();
    if (Number.isInteger(layoutIndex) && layoutIndex >= 0) actions.startRename('tab', m, `${ws}:${layoutIndex}`);
  } else if (isDeleteKey(e) && !readOnly) {
    done();
    void actions.closeTabs(m, targetIds(scope, id));
  } else if (isMenuKey(e)) {
    done();
    openRowMenu(row);
  } else if (e.key === 'Escape' && useMulti.getState().sel) {
    done();
    clearMulti();
  }
}

/** The shown machine's selected workspace: its tab bar and the selected tab's panes. */
function SidebarToggle() {
  return (
    <button
      className="icon sidebar-toggle"
      title={withKey(t('command.view.toggleSidebar'), 'view.toggleSidebar')}
      aria-label={t('command.view.toggleSidebar')}
      onClick={() => actions.toggleSidebar()}
    >
      <PanelLeft />
    </button>
  );
}

export function Workspace() {
  const m = useStore((s) => s.machineId);
  const machine = useStore((s) => (s.machineId ? s.machines[s.machineId] : undefined));
  const mt = useTerms((s) => (m ? s.machines[m] : undefined));
  const renaming = useStore((s) => (s.renaming?.kind === 'tab' ? s.renaming : undefined));
  const setRenaming = useStore((s) => s.setRenaming);
  const readOnly = useStore((s) => s.readOnly);
  const layout = mt?.layout;
  const ws = layout ? L.selectedWorkspace(layout) : undefined;
  const sel = useMulti((s) => s.sel);
  const detachedRecords = useDetachedTabs((s) => s.records);
  // Once a tab moves into a detached window, dispose any kept main-window edit
  // left behind by an unmounting editor (e.g. after choosing Don't Save before
  // detaching) so it does not linger in the main window's unsaved list.
  useEffect(() => {
    for (const r of Object.values(detachedRecords)) {
      for (const p of r.panes) dropEdit(r.m, p);
    }
  }, [detachedRecords]);
  // The new-tab menu follows the plugins that are on, the tabs' dots the
  // statuses of the plugins' panes (a chat's) as of terminals.
  useActivePlugins();
  useViewStatusOf(() => ws?.tabs.map((tb) => tabStatus(m!, tb, !!ws.muted) ?? '').join());
  const tabsRef = useRef<HTMLDivElement>(null);
  // One tab is the bar's tab stop: the one focused last, else the one shown.
  useEffect(() => ensureTabStop(tabsRef.current, '.tab.active'));

  if (m && machine && layout && !ws) {
    // Every workspace of the machine was closed.
    return (
      <main className="workspace">
        <div className="tabbar tabbar-empty">
          <SidebarToggle />
        </div>
        <div className="workspace-body">
          <div className="empty-state">
            <div>{t('workspace.none', { machine: machine.label })}</div>
            {!readOnly && (
              <button className="primary" onClick={() => void actions.newWorkspace(m)}>
                {withKey(t('command.workspace.new'), 'workspace.new')}
              </button>
            )}
          </div>
        </div>
      </main>
    );
  }
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
      <main className="workspace">
        <div className="tabbar tabbar-empty">
          <SidebarToggle />
        </div>
        <div className="workspace-body empty">
          <div className="muted">
            {status}
            {machine?.code && <div className="small">{codeText(machine.code)}</div>}
            <div className="small">{t('workspace.pick')}</div>
          </div>
        </div>
      </main>
    );
  }
  const visibleTabs = ws.tabs.map((tb, i) => ({ tb, i })).filter(({ tb }) => !detachedRecordForTab(m, tb, detachedRecords));
  const detachedCount = ws.tabs.length - visibleTabs.length;
  const selectedEntry = visibleTabs.find((x) => x.i === ws.selected) ?? visibleTabs[0];
  const tab = selectedEntry?.tb;
  const activeTabIndex = selectedEntry?.i ?? -1;
  const kinds = newTabGroups(m).length > 0;
  const picked = new Set(selectedIds(tabsOf(m, ws.id), sel));
  const tabTip = (label: string) => (readOnly ? label : t('workspace.tabHint', { label }));

  return (
    <main className="workspace">
      <div className="tabbar">
        <SidebarToggle />
        <div
          ref={tabsRef}
          className="tabs"
          role="tablist"
          aria-label={t('workspace.tabs')}
          aria-multiselectable
          data-m={m}
          data-ws={ws.id}
          onKeyDown={(e) => onTabsKey(e, m, ws.id)}
          onFocus={(e) => {
            const row = (e.target as HTMLElement).closest<HTMLElement>(`.tab${ROW}`);
            if (row && tabsRef.current) rove(tabsRef.current, row);
          }}
        >
          {visibleTabs.map(({ tb, i }) => {
            const st = tabStatus(m, tb, !!ws.muted);
            const id = `${ws.id}:${i}`;
            // A tab the user has not named shows its number, or, holding no
            // terminal, its VS Code's or preview's mark and name; the focused
            // pane's title (program, directory) is its tooltip.
            const name = tabName(m, tb);
            const focusedLeaf = L.leafOf(tb.root, tb.focused);
            const title = paneAbout(m, focusedLeaf, tb.focused, mt.terminals[tb.focused]);
            const editing = renaming?.m === m && renaming.id === id;
            const key = tabId(tb);
            const count = L.tabPanes(tb).length;
            const leafView = !L.tabTerminals(tb).length && focusedLeaf && !L.isTerminalLeaf(focusedLeaf) ? focusedLeaf : undefined;
            const view = !tb.name ? leafView : undefined;
            const about = [
              tb.name && tb.name !== title ? `${tb.name} · ${title}` : title,
              count > 1 && t('workspace.paneCount', { n: count }),
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <div
                key={`${i}:${tb.focused}`}
                className={`tab ${i === activeTabIndex ? 'active' : ''} ${picked.has(key) ? 'multi' : ''} ${tb.pinned ? 'pinned' : ''}`}
                role="tab"
                aria-selected={i === activeTabIndex || picked.has(key)}
                tabIndex={-1}
                data-nav={key}
                onDoubleClick={(e) => !readOnly && !e.shiftKey && !e.metaKey && !e.ctrlKey && actions.startRename('tab', m, id)}
                onPointerDown={(e) => {
                  if (e.button !== 0 || editing || (e.target as HTMLElement).closest('button, input')) return;
                  const scope = tabsOf(m, ws.id);
                  // With ⌘/Ctrl or Shift the press selects tabs, as in
                  // browsers, and shows none of them.
                  if (clickRow(e, scope, key, shownTab(m, ws.id))) return;
                  // One of several selected: a drag moves them all, a click
                  // (below) shows it alone.
                  const block = inMulti(scope, key) ? selectedIds(scope) : undefined;
                  if (block) {
                    if (!readOnly) startTabDrag(e, { m, ws: ws.id, index: i, label: name, shown: ws.selected, block });
                    return;
                  }
                  // A tab is shown on press, as in browsers: a press that turns
                  // into a drag (or whose release lands elsewhere) still switches.
                  const shown = ws.selected;
                  actions.selectTab(m, ws.id, i);
                  if (!readOnly) startTabDrag(e, { m, ws: ws.id, index: i, label: name, shown });
                }}
                onClick={(e) => {
                  if (e.shiftKey || e.metaKey || e.ctrlKey || !useMulti.getState().sel) return;
                  clearMulti();
                  actions.selectTab(m, ws.id, i);
                }}
                // A middle click closes the tab, as in browsers; not a pinned one.
                onAuxClick={(e) => {
                  if (e.button !== 1 || readOnly || editing || tb.pinned) return;
                  e.preventDefault();
                  void actions.closeTab(m, ws.id, i);
                }}
                // A middle click's scrolling is not started either.
                onMouseDown={keepFocus}
                onContextMenu={(e) => !editing && openMenu(e, tabMenuFor(m, ws.id, i, key))}
                title={tabTip(about)}
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
                  <>
                    {leafView && L.isPluginLeaf(leafView) && leafView.view.plugin === 'chat' && (
                      <LeafIcon m={m} leaf={leafView} className="tab-kind" />
                    )}
                    <span className="tab-label ellipsis">{tb.name}</span>
                  </>
                ) : view ? (
                  <>
                    <LeafIcon m={m} leaf={view} className="tab-kind" />
                    {L.isPluginLeaf(view) ? (
                      <ViewTitle
                        m={m}
                        view={view.view}
                        className="tab-label ellipsis"
                        tooltip={(gone) => tabTip(gone ? `${about} · ${gone}` : about)}
                      >
                        {paneTitle(m, view, tb.focused)}
                      </ViewTitle>
                    ) : L.isPreviewLeaf(view) ? (
                      <FileTitle
                        m={m}
                        path={view.preview.path}
                        className="tab-label ellipsis"
                        tooltip={(gone) => tabTip(gone ? `${about} · ${gone}` : about)}
                      >
                        {paneTitle(m, view, tb.focused)}
                      </FileTitle>
                    ) : (
                      <span className="tab-label ellipsis">{paneTitle(m, view, tb.focused)}</span>
                    )}
                  </>
                ) : (
                  <span className="tab-label tab-num">{tabLabel(tb, i)}</span>
                )}
                {count > 1 && <Columns2 className="tab-split" aria-label={t('workspace.paneCount', { n: count })} />}
                {tb.muted && <BellOff className="tab-muted" aria-label={t('workspace.muted')} />}
                {tb.pinned ? (
                  // A pinned tab shows its pin where others have ×. The pin is
                  // a mark, not a button: a click there shows the tab as one
                  // anywhere else on it, and Unpin Tab is in the tab's menu.
                  <span className="tab-pin" role="img" aria-label={t('workspace.pinned')}>
                    <Pin />
                  </span>
                ) : (
                  !readOnly && (
                    <button
                      tabIndex={-1}
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
                  )
                )}
              </div>
            );
          })}
          {!readOnly && (
            <>
              <button
                className="icon new-tab"
                title={withKey(t('command.tab.new'), 'tab.new')}
                aria-label={t('command.tab.new')}
                // Cmd/Ctrl+click and a right click offer the kinds of tab.
                onClick={(e) => (e.metaKey || e.ctrlKey ? openMenu(e, newTabMenu(m, ws.id)) : void actions.newTab(m, ws.id))}
                onContextMenu={(e) => openMenu(e, newTabMenu(m, ws.id))}
                data-new-tab={ws.id}
                data-m={m}
              >
                <Plus />
              </button>
              {kinds && (
                <button
                  className="icon sm new-tab-kinds"
                  title={t('tab.newMenu')}
                  aria-label={t('tab.newMenu')}
                  aria-haspopup="menu"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    openMenu(
                      { clientX: r.left, clientY: r.bottom, preventDefault: () => {}, stopPropagation: () => e.stopPropagation() },
                      newTabMenu(m, ws.id),
                    );
                  }}
                >
                  <ChevronDown />
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <div className="workspace-body">
        {tab ? (
          <TabView m={m} ws={ws.id} tab={tab} />
        ) : detachedCount > 0 ? (
          <div className="empty-state">
            <div>{t('window.detachedCount', { n: detachedCount })}</div>
            <div className="row">
              <button className="primary" onClick={() => requestDockAll(m, ws.id)}>
                {t('window.bringAllBack')}
              </button>
              {!readOnly && (
                <button className="btn" onClick={() => void actions.newTab(m, ws.id)}>
                  {withKey(t('command.tab.new'), 'tab.new')}
                </button>
              )}
            </div>
          </div>
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
  if (leaf && L.isPluginLeaf(leaf)) {
    const d = describeView(m, leaf.view);
    return d.path ? `${d.title} · ${shortPath(d.path, home)}` : d.title;
  }
  return terminalTitle(record, key);
}

/** Updates the ratio of a split in the tab holding `paneKey` (without relying
 * on layout.selected / ws.selected, so resizing splits in detached windows or
 * fallback tabs mutates the right tab). */
function setSplitRatio(layout: L.Layout, paneKey: string, path: readonly boolean[], ratio: number): L.Layout {
  const at = L.locate(layout, paneKey);
  if (!at || !Number.isFinite(ratio)) return layout;
  const clamped = Math.min(0.9, Math.max(0.1, ratio));
  const ws = layout.workspaces[at.workspace];
  const tab = ws.tabs[at.tab];
  const update = (node: L.Node, rest: readonly boolean[]): L.Node => {
    if (!L.isSplit(node)) return node;
    if (!rest.length) return { ...node, ratio: clamped };
    const [step, ...tail] = rest;
    const [a, b] = node.children;
    return { ...node, children: step ? [a, update(b, tail)] : [update(a, tail), b] };
  };
  const nextTab = { ...tab, root: update(tab.root, path) };
  const tabs = ws.tabs.map((t, i) => (i === at.tab ? nextTab : t));
  const workspaces = layout.workspaces.map((w, i) => (i === at.workspace ? { ...w, tabs } : w));
  return { ...layout, workspaces };
}

/** A tab's panes, each placed by its share of the split tree; the panes
 * keep their terminals (and VS Code its window) while the tree around them
 * changes. */
export function TabView({ m, ws, tab }: { m: string; ws: string; tab: L.Tab }) {
  const zoomed = useStore((s) => (s.zoomed?.m === m ? s.zoomed.pane : undefined));
  const readOnly = useStore((s) => s.readOnly);
  const detachedRecords = useDetachedTabs((s) => s.records);
  const detachedWin = isDetachedWindow();
  const isDetachedElsewhere = (km: string, kpane: string) => !detachedWin && !!detachedRecordForPane(km, kpane, detachedRecords);
  const panes = L.tabPanes(tab);
  const zoom = zoomed && panes.includes(zoomed) ? zoomed : undefined;
  const rects = zoom ? new Map([[zoom, { x: 0, y: 0, w: 1, h: 1 }]]) : paneRects(tab.root);
  const bars = zoom || readOnly ? [] : splitBars(tab.root);
  const keptLimit = usePrefs((s) => s.prefs.keptTerminals);
  // The terminals and file editor/preview panes shown last stay mounted,
  // hidden (keptPanes.ts). They are children of the same list under the same
  // keys as when they are shown, so a terminal keeps its emulator and stream
  // and a file editor/preview keeps its Monaco/Markdown state across tab
  // switches without remounting or flashing "Loading...". Panes owned by a
  // detached window are immediately excluded from main's kept pools.
  const shownTerminals = [...rects].flatMap(([pane, rect]) => {
    const leaf = L.leafOf(tab.root, pane);
    return leaf && L.isTerminalLeaf(leaf) ? [{ m, pane, rect }] : [];
  });
  const kept = keepPanes(shownTerminals, keptLimit, (k) => {
    if (isDetachedElsewhere(k.m, k.pane)) return false;
    const layout = terms.layout(k.m);
    return !!layout && L.locate(layout, k.pane) !== null;
  });
  const shownFilePanes = [...rects].flatMap(([pane, rect]) => {
    const leaf = L.leafOf(tab.root, pane);
    return leaf && isKeepableFileLeaf(leaf) ? [{ m, pane, rect, leaf }] : [];
  });
  const keptFiles = keepFilePanes(shownFilePanes, (k) => {
    if (isDetachedElsewhere(k.m, k.pane)) return null;
    const layout = terms.layout(k.m);
    const live = layout ? L.findLeaf(layout, k.pane) : null;
    return live && isKeepableFileLeaf(live) ? live : null;
  });
  const shownChatPanes = [...rects].flatMap(([pane, rect]) => {
    const leaf = L.leafOf(tab.root, pane);
    return leaf && isKeepableChatLeaf(leaf) ? [{ m, pane, rect, leaf }] : [];
  });
  const keptChats = keepChatPanes(
    shownChatPanes,
    (k) => {
      if (isDetachedElsewhere(k.m, k.pane)) return null;
      const layout = terms.layout(k.m);
      const live = layout ? L.findLeaf(layout, k.pane) : null;
      return live && isKeepableChatLeaf(live) ? live : null;
    },
    (k) => viewActive(k.m, k.leaf.view),
  );
  // Without a tab shown the kept terminals unmount with this view: they are
  // forgotten, not mounted again hidden, where they would not attach.
  useEffect(() => resetKeptPanes, []);
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
      if (panes[0]) terms.mutate(m, (l) => setSplitRatio(l, panes[0], bar.path, ratio));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className={`tab-panes ${alone ? 'alone' : ''}`} ref={body}>
      {[
        ...[...rects].map(([key, r]) => {
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
                  onActivate={() => key !== tab.focused && terms.mutate(m, (l) => focusPaneInLayout(l, key))}
                />
              ) : L.isCodeLeaf(leaf) ? (
                <CodeSlot m={m} pane={key} view={leaf.code} />
              ) : L.isPluginLeaf(leaf) ? (
                <PluginPane
                  m={m}
                  pane={key}
                  view={leaf.view}
                  focused={focused}
                  shown
                  onActivate={() => key !== tab.focused && terms.mutate(m, (l) => focusPaneInLayout(l, key))}
                />
              ) : (
                <Suspense fallback={null}>
                  <PreviewPane
                    m={m}
                    pane={key}
                    path={leaf.preview.path}
                    focused={focused}
                    shown
                    onActivate={() => key !== tab.focused && terms.mutate(m, (l) => focusPaneInLayout(l, key))}
                  />
                </Suspense>
              )}
            </div>
          );
        }),
        // One list: a pane keeps its element between shown and kept only
        // among the same siblings.
        ...kept.map((k) => (
          <div
            key={`${k.m}\n${k.pane}`}
            className="pane kept"
            style={{ left: pct(k.rect.x), top: pct(k.rect.y), width: pct(k.rect.w), height: pct(k.rect.h) }}
            aria-hidden
          >
            {/* The header's place, so that the terminal stays the second child. */}
            {null}
            <TerminalView m={k.m} terminal={k.pane} focused={false} shown={false} onActivate={() => {}} />
          </div>
        )),
        ...keptFiles.map((k) => (
          <div
            key={`${k.m}\n${k.pane}`}
            className="pane kept"
            style={{ left: pct(k.rect.x), top: pct(k.rect.y), width: pct(k.rect.w), height: pct(k.rect.h) }}
            aria-hidden
          >
            {/* The header's place, so that the file pane stays the second child. */}
            {null}
            {L.isPluginLeaf(k.leaf) ? (
              <PluginPane m={k.m} pane={k.pane} view={k.leaf.view} focused={false} shown={false} />
            ) : (
              <Suspense fallback={null}>
                <PreviewPane m={k.m} pane={k.pane} path={k.leaf.preview.path} shown={false} />
              </Suspense>
            )}
          </div>
        )),
        ...keptChats.map((k) => (
          <div
            key={`${k.m}\n${k.pane}`}
            className="pane kept"
            style={{ left: pct(k.rect.x), top: pct(k.rect.y), width: pct(k.rect.w), height: pct(k.rect.h) }}
            aria-hidden
          >
            {/* The header's place, so that the chat pane stays the second child. */}
            {null}
            <PluginPane m={k.m} pane={k.pane} view={k.leaf.view} focused={false} shown={false} />
          </div>
        )),
      ]}
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
            onDoubleClick={() => panes[0] && terms.mutate(m, (l) => setSplitRatio(l, panes[0], b.path, 0.5))}
          />
        );
      })}
    </div>
  );
}
