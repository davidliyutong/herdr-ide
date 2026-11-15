import { useState } from 'react';
import { ChevronDown, ChevronRight, Ellipsis, FolderPlus, ServerPlus, Settings } from 'lucide-react';
import { SIDEBAR_WIDTH, useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import { conn } from '../lib/conn';
import { actions, attentionList, terminalPlace, workspaceTitle } from '../actions';
import { aggregate, agentOf, agentStatus, codeText, shortPath, terminalTitle, type MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { StatusDot, statusLabel } from './StatusDot';
import { t, type MessageKey } from '../i18n';
import { withKey } from '../keymap';
import { APP_NAME } from '../brand';
import { InlineEdit } from './InlineEdit';
import { startWorkspaceDrag } from '../reorderDrag';
import { openMenu } from '../contextMenu';
import { machineMenu, sidebarMenu, workspaceMenu } from '../menus';
import { carriesFiles, dropFolders, folderDropTarget } from '../drop';

export function Sidebar() {
  const order = useStore((s) => s.order);
  const machines = useStore((s) => s.machines);
  const readOnly = useStore((s) => s.readOnly);
  // The local machine while folders from Finder are dragged over the sidebar
  // (desktop app only): dropping them creates workspaces there.
  const [dropOn, setDropOn] = useState<string>();
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
        className="sidebar-scroll"
        onContextMenu={(e) => !(e.target as HTMLElement).closest('input, textarea') && openMenu(e, sidebarMenu())}
      >
        {order.map((id) => machines[id] && <MachineItem key={id} m={machines[id]} />)}
      </div>
      {dropOn && <div className="sidebar-drop">{t('sidebar.dropFolders', { machine: dropOn })}</div>}
      <SidebarResizer />
    </aside>
  );
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

function Inbox() {
  // Recomputed on every change of the terminals; the lists are small.
  useTerms((s) => s.machines);
  const machines = useStore((s) => s.machines);
  const all = attentionList();
  const items = all.filter((i) => i.status === 'blocked' || i.status === 'done');
  const working = all.filter((i) => i.status === 'working').length;
  return (
    <div className="inbox" aria-label={t('sidebar.agents')}>
      <div className="section-title">
        {t('sidebar.agents')}
        <span className="muted">
          {working > 0 && t('sidebar.working', { n: working })}
          {items.length > 0 && t('sidebar.pending', { n: items.length })}
        </span>
      </div>
      {items.length === 0 && <div className="muted small pad">{t('sidebar.noPending')}</div>}
      {items.map(({ m, terminal, record, status }) => {
        // Where the agent is (workspace and tab, which a long machine name
        // must not cut off), its terminal's title, its machine; the
        // directory is in the tooltip.
        const title = terminalTitle(record, terminal);
        const where = [terminalPlace(m, terminal), title, machines[m]?.label].filter(Boolean).join(' · ');
        return (
          <div
            key={`${m} ${terminal}`}
            className={`inbox-item st-${status}`}
            title={[where, shortPath(terms.directory(m, terminal), machines[m]?.info?.home)].filter(Boolean).join('\n')}
            onClick={() => actions.focusTerminal(m, terminal)}
          >
            <StatusDot status={status} />
            <div className="inbox-text">
              <div className="inbox-title">
                {agentOf(record) ?? title} · {statusLabel(status)}
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
  const backend = mt?.backend;
  const followed = terms.isSubscribed(m.id);
  return (
    <div className="machine">
      <div
        className="machine-head"
        // A click folds or unfolds; the second click of a double click
        // leaves it as the first left it, and the double click renames.
        onClick={(e) => !renamingMachine && e.detail < 2 && !(e.target as HTMLElement).closest('button') && setOpen(!open)}
        onDoubleClick={(e) => {
          if (renamingMachine || readOnly || m.kind !== 'ssh' || (e.target as HTMLElement).closest('button')) return;
          setOpen((o) => !o);
          actions.startRename('machine', m.id, m.id);
        }}
        onContextMenu={(e) => !renamingMachine && openMenu(e, machineMenu(m.id))}
        title={[m.kind === 'ssh' && !readOnly ? t('sidebar.machineHint', { label: m.label }) : m.label, machineProblem(m) || m.platform]
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
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openMenu(
                { clientX: r.left, clientY: r.bottom, preventDefault() {}, stopPropagation: () => e.stopPropagation() },
                machineMenu(m.id),
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
            <div className="ws-item add" onClick={() => actions.showMachine(m.id)}>
              {t('sidebar.showTerminals')}
            </div>
          )}
          {m.status === 'ready' && followed && !layout && backend?.phase !== 'error' && (
            <div className="muted small pad">{t('workspace.hcStarting', { machine: m.label })}</div>
          )}
          {layout?.workspaces.map((w, i) => {
            const agg = aggregate(L.workspaceTerminals(w).map((a) => agentStatus(mt?.terminals[a])));
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
                className={`ws-item ${selected ? 'selected' : ''}`}
                onClick={() => actions.selectWorkspace(m.id, w.id)}
                onDoubleClick={(e) =>
                  !readOnly && !(e.target as HTMLElement).closest('button') && actions.startRename('workspace', m.id, w.id)
                }
                onPointerDown={(e) => {
                  if (e.button !== 0 || readOnly || editing || (e.target as HTMLElement).closest('button, input')) return;
                  startWorkspaceDrag(e, { m: m.id, ws: w.id, label: name });
                }}
                onContextMenu={(e) => !editing && openMenu(e, workspaceMenu(m.id, w.id))}
                title={readOnly ? about : t('sidebar.workspaceHint', { label: about })}
                data-ws-id={w.id}
                data-m={m.id}
              >
                <span className="ws-num">{i + 1}</span>
                {editing ? (
                  <InlineEdit
                    value={name}
                    placeholder={L.folderName(w.cwd, m.info?.home)}
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
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      openMenu(
                        { clientX: r.left, clientY: r.bottom, preventDefault() {}, stopPropagation() {} },
                        workspaceMenu(m.id, w.id),
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
