import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Ellipsis, FolderPlus, ServerPlus, Settings } from 'lucide-react';
import { SIDEBAR_WIDTH, useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import { conn } from '../lib/conn';
import {
  actions,
  attentionList,
  attentionName,
  attentionTitle,
  paneDirectory,
  terminalPlace,
  workspaceStatus,
  workspaceTitle,
} from '../actions';
import { codeText, shortPath, type MachineState } from '../lib/machine';
import { useViewStatusOf } from '../plugins/registry';
import { StatusDot, statusLabel } from './StatusDot';
import { t, type MessageKey } from '../i18n';
import { withKey } from '../keymap';
import { APP_NAME, storage } from '../brand';
import { InlineEdit } from './InlineEdit';
import { startMachineDrag, startWorkspaceDrag } from '../reorderDrag';
import { openMenu } from '../contextMenu';
import { machineMenu, machinesMenu, sidebarMenu, workspaceMenu, workspacesMenu } from '../menus';
import { carriesFiles, dropFolders, folderDropTarget } from '../drop';
import {
  clearMulti,
  clickRow,
  extendTo,
  inMulti,
  selectAllRows,
  selectedIds,
  targetIds,
  useMulti,
  type MultiScope,
} from '../state/multiSelect';
import { navigationKey, TypeAhead, type NavRow } from './tree';
import { ensureTabStop, isDeleteKey, isMenuKey, isToggleKey, keepFocus, openRowMenu, rove, ROW } from '../rowKeys';

const MACHINES: MultiScope = { kind: 'machine' };
const workspacesOf = (m: string): MultiScope => ({ kind: 'workspace', m });
/** The workspace a machine's layout selects, which starts a selection of its workspaces. */
const shownWorkspace = (m: string) => {
  const l = terms.layout(m);
  return l?.workspaces[l.selected]?.id;
};

/** The menu of a workspace, or of the workspaces selected with it. */
function workspaceMenuFor(m: string, ws: string) {
  if (inMulti(workspacesOf(m), ws)) return workspacesMenu(m, selectedIds(workspacesOf(m)));
  clearMulti();
  return workspaceMenu(m, ws);
}

/** The menu of a machine, or of the machines selected with it. */
function machineMenuFor(m: string) {
  if (inMulti(MACHINES, m)) return machinesMenu(selectedIds(MACHINES));
  clearMulti();
  return machineMenu(m);
}

const typeahead = new TypeAhead();

/** The sidebar's keys on its rows (machines, workspaces and the rows that
 * add): arrows, pages, Home and End move (Shift extends a selection of
 * workspaces of one machine, or of machines), ← → fold and unfold a
 * machine and go to it, letters go to a row by its name, Enter or Space
 * does what a click does, Ctrl+Space toggles a row in the selection,
 * ⌘/Ctrl+A selects every row of its kind, F2 renames, Delete closes
 * workspaces or removes SSH machines (asking), the menu key or Shift+F10
 * opens the row's menu, Escape clears the selection. */
function onRowsKey(e: React.KeyboardEvent<HTMLElement>) {
  const list = e.currentTarget;
  const row = (e.target as HTMLElement).closest<HTMLElement>(ROW);
  if (!row || (e.target as HTMLElement).closest('input, textarea')) return;
  const els = [...list.querySelectorAll<HTMLElement>(ROW)];
  const rows: NavRow[] = els.map((el) => ({
    id: el.dataset.nav!,
    parent: el.dataset.navParent,
    expanded: el.dataset.expanded === undefined ? undefined : el.dataset.expanded === 'true',
    label: el.dataset.navLabel,
  }));
  const id = row.dataset.nav!;
  const elOf = (x: string) => els.find((el) => el.dataset.nav === x);
  const ws = row.dataset.wsId;
  const m = row.dataset.m ?? row.closest<HTMLElement>('[data-machine]')?.dataset.machine;
  const kind = ws ? 'workspace' : row.dataset.machineHead !== undefined ? 'machine' : undefined;
  const scope = ws && m ? workspacesOf(m) : MACHINES;
  const readOnly = useStore.getState().readOnly;
  const done = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  const action = navigationKey(e, rows, id, {
    multi: true,
    typeahead,
    page: Math.max(1, Math.floor(list.clientHeight / row.offsetHeight) - 1),
  });
  if (action) {
    done();
    if (action.kind === 'move') {
      const to = elOf(action.to);
      if (!to) return;
      to.focus();
      to.scrollIntoView?.({ block: 'nearest' });
      // A selection holds rows of one list: workspaces of one machine, or machines.
      const toWs = to.dataset.wsId;
      const sameList = kind && (kind === 'workspace' ? toWs && to.dataset.m === m : to.dataset.machineHead !== undefined);
      if (action.extend && sameList)
        extendTo(
          scope,
          kind === 'workspace' ? ws! : m!,
          kind === 'workspace' ? toWs! : to.closest<HTMLElement>('[data-machine]')!.dataset.machine!,
        );
    } else if (action.kind === 'expand' || action.kind === 'collapse') elOf(action.id)?.click();
    else if (action.kind === 'selectAll' && kind) selectAllRows(scope, kind === 'workspace' && m ? shownWorkspace(m) : undefined);
    return;
  }
  const key = kind === 'workspace' ? ws! : m!;
  if (e.key === 'Escape') {
    if (!useMulti.getState().sel) return;
    done();
    clearMulti();
  } else if (e.key === 'Enter' || (e.key === ' ' && !e.metaKey && !e.ctrlKey)) {
    done();
    row.click();
  } else if (kind && isToggleKey(e)) {
    done();
    clickRow({ shiftKey: false, metaKey: true, ctrlKey: true }, scope, key, kind === 'workspace' && m ? shownWorkspace(m) : undefined);
  } else if (kind && e.key === 'F2' && !readOnly && m) {
    done();
    actions.startRename(kind, m, key);
  } else if (kind && isDeleteKey(e) && !readOnly && m) {
    done();
    if (kind === 'workspace') void actions.closeWorkspaces(m, targetIds(scope, key));
    else void actions.removeMachines(targetIds(scope, key));
  } else if (isMenuKey(e)) {
    done();
    openRowMenu(row);
  }
}

export function Sidebar() {
  const order = useStore((s) => s.order);
  const machines = useStore((s) => s.machines);
  const readOnly = useStore((s) => s.readOnly);
  // The local machine while folders from Finder are dragged over the sidebar
  // (desktop app only): dropping them creates workspaces there.
  const [dropOn, setDropOn] = useState<string>();
  const scroll = useRef<HTMLDivElement>(null);
  // Where the list was scrolled stays across reloads of the page, once its
  // machines are back.
  const restored = useRef(false);
  useEffect(() => {
    const el = scroll.current;
    if (restored.current || !el || !order.length) return;
    restored.current = true;
    el.scrollTop = keptScroll();
  }, [order.length]);
  return (
    <aside
      className="sidebar"
      onDragOver={(e) => {
        const local = carriesFiles(e.dataTransfer) ? folderDropTarget() : undefined;
        if (!local) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (dropOn !== local.label) setDropOn(local.label);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(undefined);
      }}
      onDrop={(e) => {
        setDropOn(undefined);
        if (!carriesFiles(e.dataTransfer) || !folderDropTarget()) return;
        e.preventDefault();
        void dropFolders(e.dataTransfer);
      }}
    >
      <div className="sidebar-head">
        <span className="brand">{APP_NAME}</span>
        {!readOnly && (
          <button
            className="icon"
            title={withKey(t('command.workspace.new'), 'workspace.new')}
            aria-label={t('command.workspace.new')}
            onClick={() => void actions.newWorkspace()}
          >
            <FolderPlus />
          </button>
        )}
        {!readOnly && (
          <button
            className="icon"
            title={t('menu.addMachine')}
            aria-label={t('menu.addMachine')}
            onClick={() => useStore.getState().openAddMachine(true)}
          >
            <ServerPlus />
          </button>
        )}
        <button
          className="icon"
          title={withKey(t('command.app.settings'), 'app.settings')}
          aria-label={t('command.app.settings')}
          onClick={() => useStore.getState().openSettings({})}
        >
          <Settings />
        </button>
      </div>
      <Inbox />
      {/* Right-clicking free space (or a part of a machine without its own
          menu) offers to add a machine. */}
      <div
        ref={scroll}
        className="sidebar-scroll"
        role="tree"
        aria-label={t('sidebar.machines')}
        aria-multiselectable
        onKeyDown={onRowsKey}
        onFocus={(e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>(ROW);
          if (row && scroll.current) rove(scroll.current, row);
        }}
        onScroll={(e) => keepScroll(e.currentTarget.scrollTop)}
        onContextMenu={(e) => !(e.target as HTMLElement).closest('input, textarea') && openMenu(e, sidebarMenu())}
      >
        {order.map((id) => machines[id] && <MachineItem key={id} m={machines[id]} />)}
      </div>
      {dropOn && <div className="sidebar-drop">{t('sidebar.dropFolders', { machine: dropOn })}</div>}
      <SidebarResizer />
    </aside>
  );
}

const SCROLL_KEY = `${storage}.sidebarScroll`;

/** Where the sidebar's list was scrolled in this tab of the browser. */
function keptScroll(): number {
  try {
    return Number(sessionStorage.getItem(SCROLL_KEY)) || 0;
  } catch {
    return 0;
  }
}

let scrollTimer: ReturnType<typeof setTimeout> | undefined;
function keepScroll(top: number) {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    try {
      sessionStorage.setItem(SCROLL_KEY, String(Math.round(top)));
    } catch {
      // Storage refused (private mode): the position is not kept.
    }
  }, 150);
}

/** The sidebar's right edge: dragging it sets the width (kept per
 * browser), dragging it far left hides the sidebar, a double click gives
 * the default width back. */
function SidebarResizer() {
  const onPointerDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const s = useStore.getState();
    const start = ev.clientX;
    const startW = s.sidebarWidth;
    document.body.classList.add('resizing');
    const width = (e: PointerEvent) => startW + e.clientX - start;
    const move = (e: PointerEvent) => useStore.getState().setSidebarWidth(width(e));
    const up = (e: PointerEvent) => {
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // Dropped well below the narrowest width: hidden, at the width it had.
      if (width(e) < SIDEBAR_WIDTH.min - 60) {
        useStore.getState().setSidebarWidth(startW);
        useStore.getState().toggleSidebar();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      title={t('sidebar.resize')}
      onPointerDown={onPointerDown}
      onDoubleClick={() => useStore.getState().setSidebarWidth(SIDEBAR_WIDTH.def)}
    />
  );
}

/** The Agents section's keys: ↑ ↓ Home End move between the agents (one
 * stop of the Tab key), Enter or Space shows the agent's pane. */
function onInboxKey(e: React.KeyboardEvent<HTMLElement>) {
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(`.inbox-item${ROW}`)];
  const at = rows.indexOf(e.target as HTMLElement);
  if (at < 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  e.stopPropagation();
  rows[Math.max(0, Math.min(rows.length - 1, to))].focus();
}

function Inbox() {
  // Recomputed on every change of the terminals and of the plugins' panes'
  // statuses (a chat's); the lists are small.
  useTerms((s) => s.machines);
  useViewStatusOf(() =>
    attentionList()
      .map((i) => `${i.m} ${i.terminal} ${i.status} ${attentionName(i)}`)
      .join('\n'),
  );
  const machines = useStore((s) => s.machines);
  const all = attentionList();
  const items = all.filter((i) => i.status === 'blocked' || i.status === 'done');
  const working = all.filter((i) => i.status === 'working').length;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => ensureTabStop(box.current, `.inbox-item${ROW}`));
  return (
    <div
      ref={box}
      className="inbox"
      role="group"
      aria-label={t('sidebar.agents')}
      onKeyDown={onInboxKey}
      onFocus={(e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>(ROW);
        if (row && box.current) rove(box.current, row);
      }}
    >
      <div className="section-title">
        {t('sidebar.agents')}
        <span className="muted">
          {working > 0 && t('sidebar.working', { n: working })}
          {items.length > 0 && t('sidebar.pending', { n: items.length })}
        </span>
      </div>
      {items.length === 0 && <div className="muted small pad">{t('sidebar.noPending')}</div>}
      {items.map((item) => {
        const { m, terminal, status } = item;
        // Where the agent is (workspace and tab, which a long machine name
        // must not cut off), its terminal's title, its machine; the
        // directory is in the tooltip. A plugin's pane (a chat) goes by its
        // title, said once (attentionName).
        const where = [terminalPlace(m, terminal), !item.view && attentionTitle(item), machines[m]?.label].filter(Boolean).join(' · ');
        return (
          <div
            key={`${m} ${terminal}`}
            className={`inbox-item st-${status}`}
            role="button"
            tabIndex={-1}
            data-nav={`${m} ${terminal}`}
            onMouseDown={keepFocus}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              actions.focusPane(m, terminal);
            }}
            title={[where, shortPath(paneDirectory(m, item.view ? { view: item.view } : { terminal }), machines[m]?.info?.home)]
              .filter(Boolean)
              .join('\n')}
            onClick={() => actions.focusPane(m, terminal)}
          >
            <StatusDot status={status} />
            <div className="inbox-text">
              <div className="inbox-title">
                {attentionName(item)} · {statusLabel(status)}
              </div>
              <div className="muted small ellipsis">{where}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Why a machine is not connected, as its tooltip says it. */
function machineProblem(m: MachineState): string {
  return [m.code && codeText(m.code), m.error].filter(Boolean).join('\n');
}

function MachineItem({ m }: { m: MachineState }) {
  // Disabled machines start folded: their body only holds the Enable button
  // (also in the machine's menu). Disabling folds a machine and enabling
  // unfolds it; clicking the header toggles it in between.
  const disabled = m.status === 'disabled';
  const [open, setOpen] = useState(!disabled);
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (disabled !== wasDisabled) {
    setWasDisabled(disabled);
    setOpen(!disabled);
  }
  const selM = useStore((s) => s.machineId);
  const readOnly = useStore((s) => s.readOnly);
  const sshLogin = useStore((s) => s.sshLogin);
  const renaming = useStore((s) => (s.renaming?.kind === 'workspace' && s.renaming.m === m.id ? s.renaming.id : undefined));
  const renamingMachine = useStore((s) => s.renaming?.kind === 'machine' && s.renaming.m === m.id);
  const setRenaming = useStore((s) => s.setRenaming);
  const busy = useStore((s) => s.hcBusy[m.id] === true);
  const mt = useTerms((s) => s.machines[m.id]);
  const layout = mt?.layout;
  // The workspaces' dots follow the plugins' panes' statuses too.
  useViewStatusOf(() => layout?.workspaces.map((w) => workspaceStatus(m.id, w) ?? '').join());
  const backend = mt?.backend;
  const followed = terms.isSubscribed(m.id);
  const sel = useMulti((s) => s.sel);
  const machinePicked = selectedIds(MACHINES, sel).includes(m.id);
  const picked = new Set(selectedIds(workspacesOf(m.id), sel));
  const box = useRef<HTMLDivElement>(null);
  // One row of the list is its tab stop: the one the keyboard was on last,
  // else the workspace shown (of the machine shown).
  useEffect(() =>
    ensureTabStop(
      box.current?.closest<HTMLElement>('.sidebar-scroll') ?? null,
      selM ? `.ws-item.selected[data-m="${CSS.escape(selM)}"]` : '.ws-item.selected',
    ),
  );
  return (
    <div className="machine" data-machine={m.id} ref={box}>
      <div
        className={`machine-head ${machinePicked ? 'multi' : ''}`}
        data-nav={`m:${m.id}`}
        data-nav-label={m.label}
        data-machine-head
        data-expanded={open}
        role="treeitem"
        aria-level={1}
        aria-expanded={open}
        aria-selected={machinePicked}
        tabIndex={-1}
        onMouseDown={keepFocus}
        onPointerDown={(e) => {
          if (e.button !== 0 || readOnly || renamingMachine || (e.target as HTMLElement).closest('button, input')) return;
          if (e.shiftKey || e.metaKey || e.ctrlKey) return;
          startMachineDrag(e, { m: m.id, label: m.label, block: inMulti(MACHINES, m.id) ? selectedIds(MACHINES) : undefined });
        }}
        // A click folds or unfolds; the second click of a double click
        // leaves it as the first left it, and the double click renames.
        // With ⌘/Ctrl or Shift it selects instead.
        onClick={(e) => {
          if (renamingMachine || (e.target as HTMLElement).closest('button')) return;
          if (clickRow(e, MACHINES, m.id)) return;
          if (e.detail < 2) setOpen(!open);
        }}
        onDoubleClick={(e) => {
          if (renamingMachine || readOnly || (e.target as HTMLElement).closest('button') || e.shiftKey || e.metaKey || e.ctrlKey) return;
          setOpen((o) => !o);
          actions.startRename('machine', m.id, m.id);
        }}
        onContextMenu={(e) => !renamingMachine && openMenu(e, machineMenuFor(m.id))}
        title={[readOnly ? m.label : t('sidebar.machineHint', { label: m.label }), machineProblem(m) || m.platform]
          .filter(Boolean)
          .join('\n')}
      >
        <span className="caret">{open ? <ChevronDown /> : <ChevronRight />}</span>
        <span className={`mstatus ms-${m.status}`} title={t(`machine.${m.status}` as MessageKey)} />
        {renamingMachine ? (
          <InlineEdit
            value={m.label}
            onDone={(v) => {
              setRenaming(undefined);
              if (v && v !== m.label) void actions.renameMachine(m.id, v);
            }}
          />
        ) : (
          <span className="machine-label ellipsis">{m.label}</span>
        )}
        {!readOnly && (
          <button
            className="icon row-action"
            title={t('sidebar.machineActions')}
            aria-label={t('sidebar.machineActions')}
            tabIndex={-1}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openMenu(
                { clientX: r.left, clientY: r.bottom, preventDefault() {}, stopPropagation: () => e.stopPropagation() },
                machineMenuFor(m.id),
              );
            }}
          >
            <Ellipsis />
          </button>
        )}
      </div>
      {open && (
        <div className="machine-body" data-m={m.id}>
          {m.status !== 'ready' && (
            <div className={`machine-status ms-${m.status}`}>
              {t(`machine.${m.status}` as MessageKey)}
              {m.code && <div className="small">{codeText(m.code)}</div>}
              {m.error && <div className="small ellipsis2">{m.error}</div>}
              {m.status === 'disabled' && !readOnly && (
                <div className="row">
                  <button onClick={() => void actions.setMachineEnabled(m.id, true)}>{t('menu.enableMachine')}</button>
                </div>
              )}
              {m.status === 'auth_required' && m.kind === 'ssh' && !sshLogin && <div className="small">{t('sidebar.signInElsewhere')}</div>}
              {(m.status === 'auth_required' || m.status === 'error') && !m.code && (
                <div className="row">
                  {m.status === 'auth_required' && m.kind === 'ssh' && sshLogin && (
                    <button onClick={() => useStore.getState().openAuth?.(m.id)}>{t('sidebar.authenticate')}</button>
                  )}
                  {!readOnly && <button onClick={() => conn.retry(m.id)}>{t('sidebar.retry')}</button>}
                </div>
              )}
            </div>
          )}
          {m.status === 'ready' && backend?.phase === 'error' && (
            <div className="machine-status ms-notice" title={backend.code}>
              {t(`backend.${backend.code}` as MessageKey)}
              {!readOnly && (
                <div className="row">
                  <button disabled={busy} onClick={() => void actions.terminalCore(m.id, 'start')}>
                    {t('menu.startCore')}
                  </button>
                </div>
              )}
            </div>
          )}
          {m.status === 'ready' && !followed && (
            <div
              className="ws-item add"
              role="treeitem"
              aria-level={2}
              tabIndex={-1}
              data-nav={`show:${m.id}`}
              data-nav-parent={`m:${m.id}`}
              onMouseDown={keepFocus}
              onClick={() => actions.showMachine(m.id)}
            >
              {t('sidebar.showTerminals')}
            </div>
          )}
          {m.status === 'ready' && followed && !layout && backend?.phase !== 'error' && (
            <div className="muted small pad">{t('workspace.hcStarting', { machine: m.label })}</div>
          )}
          {layout?.workspaces.map((w, i) => {
            const agg = workspaceStatus(m.id, w);
            const selected = selM === m.id && layout.selected === i;
            const editing = renaming === w.id;
            const name = workspaceTitle(m.id, w);
            // The row stays quiet: the tab count is in the tooltip.
            const about = [
              name,
              w.cwd && shortPath(w.cwd, m.info?.home),
              w.tabs.length === 1 ? t('sidebar.oneTab') : t('sidebar.tabs', { n: w.tabs.length }),
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <div
                key={w.id}
                className={`ws-item ${selected ? 'selected' : ''} ${picked.has(w.id) ? 'multi' : ''}`}
                role="treeitem"
                aria-level={2}
                aria-selected={picked.has(w.id) || selected}
                aria-current={selected || undefined}
                tabIndex={-1}
                onMouseDown={keepFocus}
                // A click shows it; with ⌘/Ctrl or Shift it selects instead.
                onClick={(e) => {
                  if (editing || clickRow(e, workspacesOf(m.id), w.id, shownWorkspace(m.id))) return;
                  actions.selectWorkspace(m.id, w.id);
                }}
                onDoubleClick={(e) =>
                  !readOnly &&
                  !e.shiftKey &&
                  !e.metaKey &&
                  !e.ctrlKey &&
                  !(e.target as HTMLElement).closest('button') &&
                  actions.startRename('workspace', m.id, w.id)
                }
                onPointerDown={(e) => {
                  if (e.button !== 0 || readOnly || editing || (e.target as HTMLElement).closest('button, input')) return;
                  if (e.shiftKey || e.metaKey || e.ctrlKey) return;
                  const scope = workspacesOf(m.id);
                  startWorkspaceDrag(e, { m: m.id, ws: w.id, label: name, block: inMulti(scope, w.id) ? selectedIds(scope) : undefined });
                }}
                onContextMenu={(e) => !editing && openMenu(e, workspaceMenuFor(m.id, w.id))}
                title={readOnly ? about : t('sidebar.workspaceHint', { label: about })}
                data-ws-id={w.id}
                data-m={m.id}
                data-nav={`w:${m.id}:${w.id}`}
                data-nav-parent={`m:${m.id}`}
                data-nav-label={name}
              >
                <span className="ws-num">{i + 1}</span>
                {editing ? (
                  <InlineEdit
                    value={name}
                    onDone={(v) => {
                      setRenaming(undefined);
                      // Emptied, it is named after its folder again.
                      if (v !== undefined && v !== name) actions.renameWorkspace(m.id, w.id, v);
                    }}
                  />
                ) : (
                  <span className="ellipsis ws-name">{name}</span>
                )}
                {agg && (
                  <span className="ws-meta">
                    <StatusDot status={agg} />
                  </span>
                )}
                {!readOnly && !editing && (
                  <button
                    className="icon row-action"
                    title={t('sidebar.workspaceActions')}
                    aria-label={t('sidebar.workspaceActions')}
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      openMenu(
                        { clientX: r.left, clientY: r.bottom, preventDefault() {}, stopPropagation() {} },
                        workspaceMenuFor(m.id, w.id),
                      );
                    }}
                  >
                    <Ellipsis />
                  </button>
                )}
              </div>
            );
          })}
          {layout && !readOnly && (
            <div
              className="ws-item add"
              role="treeitem"
              aria-level={2}
              tabIndex={-1}
              data-nav={`new:${m.id}`}
              data-nav-parent={`m:${m.id}`}
              onMouseDown={keepFocus}
              title={t('sidebar.newWorkspaceOn', { machine: m.label })}
              onClick={() => void actions.newWorkspace(m.id)}
            >
              <FolderPlus />
              {t('command.workspace.new')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
