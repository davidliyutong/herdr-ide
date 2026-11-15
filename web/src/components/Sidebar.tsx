import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Settings } from 'lucide-react';
import { useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import { conn } from '../lib/conn';
import { actions, attentionList } from '../actions';
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
          <button className="icon" title={withKey(t('sidebar.newWorkspace'), 'workspace.new')} onClick={() => void actions.newWorkspace()}>
            <Plus />
          </button>
        )}
        <button className="icon" title={withKey(t('settings.open'), 'app.settings')} onClick={() => useStore.getState().openSettings(true)}>
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
    </aside>
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
    <div className="inbox">
      <div className="section-title">
        {t('sidebar.agents')}
        <span className="muted">
          {working > 0 && t('sidebar.working', { n: working })}
          {items.length > 0 && t('sidebar.pending', { n: items.length })}
        </span>
      </div>
      {items.length === 0 && <div className="muted small pad">{t('sidebar.noPending')}</div>}
      {items.map(({ m, terminal, record, status }) => (
        <div key={`${m} ${terminal}`} className={`inbox-item st-${status}`} onClick={() => actions.focusTerminal(m, terminal)}>
          <StatusDot status={status} />
          <div className="inbox-text">
            <div className="inbox-title">
              {agentOf(record) ?? terminalTitle(record, terminal)} · {statusLabel(status)}
            </div>
            <div className="muted small ellipsis">
              {machines[m]?.label} · {terminalTitle(record, terminal)} · {shortPath(terms.directory(m, terminal), machines[m]?.info?.home)}
            </div>
          </div>
        </div>
      ))}
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
        onClick={() => !renamingMachine && setOpen(!open)}
        onContextMenu={(e) => !renamingMachine && openMenu(e, machineMenu(m.id))}
        title={machineProblem(m) || m.platform}
      >
        <span className={`mstatus ms-${m.status}`} />
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
        <span className="muted small">{m.platform}</span>
        <span className="caret">{open ? <ChevronDown /> : <ChevronRight />}</span>
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
            const name = w.name || t('workspace.default');
            return (
              <div
                key={w.id}
                className={`ws-item ${selected ? 'selected' : ''}`}
                onClick={() => actions.selectWorkspace(m.id, w.id)}
                onDoubleClick={() => !readOnly && actions.startRename('workspace', m.id, w.id)}
                onPointerDown={(e) => {
                  if (e.button !== 0 || readOnly || editing || (e.target as HTMLElement).closest('button, input')) return;
                  startWorkspaceDrag(e, { m: m.id, ws: w.id, label: name });
                }}
                onContextMenu={(e) => !editing && openMenu(e, workspaceMenu(m.id, w.id))}
                title={
                  readOnly ? name : t('sidebar.workspaceHint', { label: w.cwd ? `${name} · ${shortPath(w.cwd, m.info?.home)}` : name })
                }
                data-ws-id={w.id}
                data-m={m.id}
              >
                <span className="ws-num">{i + 1}</span>
                {editing ? (
                  <InlineEdit
                    value={w.name}
                    onDone={(v) => {
                      setRenaming(undefined);
                      if (v && v !== w.name) actions.renameWorkspace(m.id, w.id, v);
                    }}
                  />
                ) : (
                  <span className="ellipsis">{name}</span>
                )}
                <span className="ws-meta">
                  {agg && <StatusDot status={agg} />}
                  <span className="muted small">{w.tabs.length > 1 ? t('sidebar.tabs', { n: w.tabs.length }) : ''}</span>
                </span>
              </div>
            );
          })}
          {layout && !readOnly && (
            <div className="ws-item add" onClick={() => void actions.newWorkspace(m.id)}>
              {t('sidebar.addWorkspace')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
