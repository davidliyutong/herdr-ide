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
import { workspaceMenu } from '../menus';

function aggregate(statuses: AgentStatus[]): AgentStatus | undefined {
  let best: AgentStatus | undefined;
  for (const s of statuses) if (!best || statusRank[s] > statusRank[best]) best = s;
  return best;
}

export function Sidebar() {
  const order = useStore((s) => s.order);
  const machines = useStore((s) => s.machines);
  const readOnly = useStore((s) => s.readOnly);
  return (
    <aside className="sidebar">
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
  const renaming = useStore((s) => (s.renaming?.kind === 'workspace' && s.renaming.m === m.id ? s.renaming.id : undefined));
  const setRenaming = useStore((s) => s.setRenaming);
  const snap = m.snapshot;
  const workspaces = snap?.workspaces ?? [];
  return (
    <div className="machine">
      <div className="machine-head" onClick={() => setOpen(!open)} title={m.error || m.platform}>
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
              {(m.status === 'auth_required' || m.status === 'error' || m.status === 'degraded') && (
                <div className="row">
                  {m.status === 'auth_required' && m.kind === 'ssh' && (
                    <button onClick={() => useStore.getState().openAuth?.(m.id)}>{t('sidebar.authenticate')}</button>
                  )}
                  <button onClick={() => conn.retry(m.id)}>{t('sidebar.retry')}</button>
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
