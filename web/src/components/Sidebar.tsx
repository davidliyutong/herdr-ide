import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Settings } from 'lucide-react';
import { useStore } from '../state/store';
import { conn } from '../lib/conn';
import { actions, attentionList } from '../actions';
import { paneCwd, paneTitle, shortPath, statusRank, type AgentStatus, type MachineState } from '../lib/herdr';
import { StatusDot, statusLabel } from './StatusDot';
import { t, type MessageKey } from '../i18n';
import { keyHint } from '../keymap';
import { APP_NAME } from '../brand';
import { InlineEdit } from './InlineEdit';
import { startWorkspaceDrag } from '../reorderDrag';
import { openMenu } from '../contextMenu';
import { machineMenu, workspaceMenu } from '../menus';
import { isNewer } from '../lib/localHerdr';
import { carriesFiles, dropFolders, folderDropTarget } from '../drop';

function aggregate(statuses: AgentStatus[]): AgentStatus | undefined {
  let best: AgentStatus | undefined;
  for (const s of statuses) if (!best || statusRank[s] > statusRank[best]) best = s;
  return best;
}

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
            title={t('sidebar.newWorkspace', { key: keyHint('new_workspace') })}
            onClick={() => actions.newWorkspace()}
          >
            <Plus />
          </button>
        )}
        <button
          className="icon"
          title={t('settings.open', { key: keyHint('open_settings') })}
          onClick={() => useStore.getState().openSettings(true)}
        >
          <Settings />
        </button>
      </div>
      <Inbox />
      <div className="sidebar-scroll">{order.map((id) => machines[id] && <MachineItem key={id} m={machines[id]} />)}</div>
      {dropOn && <div className="sidebar-drop">{t('sidebar.dropFolders', { machine: dropOn })}</div>}
    </aside>
  );
}

function Inbox() {
  // Recomputed on every store change; the lists are small.
  useStore((s) => s.machines);
  const items = attentionList().filter((i) => i.pane.agent_status === 'blocked' || i.pane.agent_status === 'done');
  const working = attentionList().filter((i) => i.pane.agent_status === 'working').length;
  const machines = useStore.getState().machines;
  return (
    <div className="inbox">
      <div className="section-title">
        {t('sidebar.agents')}
        <span className="muted">
          {working > 0 && t('sidebar.working', { n: working })}
          {items.length > 0 && t('sidebar.pending', { n: items.length })}
        </span>
      </div>
      {items.length === 0 && <div className="muted small pad">{t('sidebar.noPending')}</div>}
      {items.map(({ m, pane }) => (
        <div key={m + pane.pane_id} className={`inbox-item st-${pane.agent_status}`} onClick={() => actions.focusAgent(m, pane.pane_id)}>
          <StatusDot status={pane.agent_status} />
          <div className="inbox-text">
            <div className="inbox-title">
              {pane.agent} · {statusLabel(pane.agent_status)}
            </div>
            <div className="muted small ellipsis">
              {machines[m]?.label} · {paneTitle(pane)} · {shortPath(paneCwd(pane), machines[m]?.info?.home)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MachineItem({ m }: { m: MachineState }) {
  const [open, setOpen] = useState(true);
  const selM = useStore((s) => s.machineId);
  const selWs = useStore((s) => s.workspaceId);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const readOnly = useStore((s) => s.readOnly);
  // Remote herdr older than the local one: herdr itself installs the local
  // version there when the user attaches (RemoteHerdrDialog).
  const localHerdr = useStore((s) => Object.values(s.machines).find((x) => x.kind === 'local')?.info?.herdr_version);
  const renaming = useStore((s) => (s.renaming?.kind === 'workspace' && s.renaming.m === m.id ? s.renaming.id : undefined));
  const setRenaming = useStore((s) => s.setRenaming);
  const snap = m.snapshot;
  const workspaces = snap?.workspaces ?? [];
  return (
    <div className="machine">
      <div
        className="machine-head"
        onClick={() => setOpen(!open)}
        onContextMenu={(e) => openMenu(e, machineMenu(m.id))}
        title={m.error || m.platform}
      >
        <span className={`mstatus ms-${m.status}`} />
        <span className="machine-label ellipsis">{m.label}</span>
        <span className="muted small">{m.platform}</span>
        <span className="caret">{open ? <ChevronDown /> : <ChevronRight />}</span>
      </div>
      {open && (
        <div className="machine-body" data-m={m.id}>
          {m.status !== 'ready' && (
            <div className={`machine-status ms-${m.status}`}>
              {t(`machine.${m.status}` as MessageKey)}
              {m.error && <div className="small ellipsis2">{m.error}</div>}
              {m.status === 'disabled' && !readOnly && (
                <div className="row">
                  <button onClick={() => void actions.setMachineEnabled(m.id, true)}>{t('menu.enableMachine')}</button>
                </div>
              )}
              {(m.status === 'auth_required' || m.status === 'error' || m.status === 'degraded') && (
                <div className="row">
                  {m.status === 'auth_required' && m.kind === 'ssh' && (
                    <button onClick={() => useStore.getState().openAuth?.(m.id)}>{t('sidebar.authenticate')}</button>
                  )}
                  {m.kind === 'local' && !readOnly && (
                    <button onClick={() => useStore.getState().openHerdr(m.id)}>{t('sidebar.manageHerdr')}</button>
                  )}
                  {!readOnly && <button onClick={() => conn.retry(m.id)}>{t('sidebar.retry')}</button>}
                </div>
              )}
            </div>
          )}
          {m.kind === 'ssh' && m.status === 'ready' && isNewer(localHerdr, m.info?.herdr_version) && (
            <div className="machine-status ms-degraded">
              {t('sidebar.herdrOlder', { remote: m.info?.herdr_version ?? '', local: localHerdr ?? '' })}
              {!readOnly && (
                <div className="row">
                  <button onClick={() => useStore.getState().openRemoteHerdr(m.id)}>{t('sidebar.updateHerdr')}</button>
                </div>
              )}
            </div>
          )}
          {workspaces.map((w) => {
            const panes = snap!.panes.filter((p) => p.workspace_id === w.workspace_id && p.agent);
            const agg = aggregate(panes.map((p) => p.agent_status));
            const selected = selM === m.id && selWs === w.workspace_id;
            const editing = renaming === w.workspace_id;
            return (
              <div
                key={w.workspace_id}
                className={`ws-item ${selected ? 'selected' : ''}`}
                onClick={() => selectWorkspace(m.id, w.workspace_id)}
                onDoubleClick={() => !readOnly && actions.startRename('workspace', m.id, w.workspace_id)}
                onPointerDown={(e) => {
                  if (e.button !== 0 || readOnly || editing || (e.target as HTMLElement).closest('button, input')) return;
                  startWorkspaceDrag(e, { m: m.id, ws: w.workspace_id, label: w.label });
                }}
                onContextMenu={(e) => !editing && openMenu(e, workspaceMenu(m.id, w.workspace_id))}
                title={readOnly ? w.label : t('sidebar.workspaceHint', { label: w.label })}
                data-ws-id={w.workspace_id}
                data-m={m.id}
              >
                <span className="ws-num">{w.number}</span>
                {editing ? (
                  <InlineEdit
                    value={w.label}
                    onDone={(v) => {
                      setRenaming(undefined);
                      if (v && v !== w.label) actions.renameWorkspace(m.id, w.workspace_id, v);
                    }}
                  />
                ) : (
                  <span className="ellipsis">{w.label}</span>
                )}
                <span className="ws-meta">
                  {panes.length > 0 && <StatusDot status={agg} />}
                  <span className="muted small">{w.tab_count > 1 ? t('sidebar.tabs', { n: w.tab_count }) : ''}</span>
                </span>
              </div>
            );
          })}
          {m.status === 'ready' && !readOnly && (
            <div className="ws-item add" onClick={() => actions.newWorkspace(m.id)}>
              {t('sidebar.addWorkspace')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
