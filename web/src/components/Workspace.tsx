import { PanelLeft, Plus, X } from 'lucide-react';
import { useStore, activeTabId } from '../state/store';
import { actions } from '../actions';
import { SurfaceView } from './SurfaceView';
import { PaneToolbar } from './PaneToolbar';
import { StatusDot } from './StatusDot';
import { statusRank, workspaceTabs, type AgentStatus } from '../lib/herdr';
import { t, type MessageKey } from '../i18n';
import { keyHint } from '../keymap';
import { InlineEdit } from './InlineEdit';
import { startTabDrag } from '../reorderDrag';
import { openMenu } from '../contextMenu';
import { tabMenu } from '../menus';

export function Workspace() {
  const m = useStore((s) => s.machineId);
  const ws = useStore((s) => s.workspaceId);
  const machine = useStore((s) => (s.machineId ? s.machines[s.machineId] : undefined));
  const tabId = useStore((s) => {
    const snap = s.machineId ? s.machines[s.machineId]?.snapshot : undefined;
    return s.machineId && snap && s.workspaceId ? activeTabId(s, s.machineId, snap, s.workspaceId) : undefined;
  });
  const selectTab = useStore((s) => s.selectTab);
  const renaming = useStore((s) => (s.renaming?.kind === 'tab' ? s.renaming : undefined));
  const setRenaming = useStore((s) => s.setRenaming);
  const readOnly = useStore((s) => s.readOnly);

  if (!m || !ws || !machine?.snapshot) {
    return (
      <main className="workspace empty">
        <div className="muted">
          {machine
            ? t('workspace.machineStatus', { machine: machine.label, status: t(`machine.${machine.status}` as MessageKey) })
            : t('workspace.waiting')}
          <div className="small">{t('workspace.pick')}</div>
        </div>
      </main>
    );
  }
  const snap = machine.snapshot;
  const workspace = snap.workspaces.find((w) => w.workspace_id === ws);
  const tabs = workspaceTabs(snap, ws);
  const layout = tabId ? machine.layouts?.[tabId] : undefined;

  const tabStatus = (tab: string): AgentStatus | undefined => {
    let best: AgentStatus | undefined;
    for (const p of snap.panes) {
      if (p.tab_id !== tab || !p.agent) continue;
      if (!best || statusRank[p.agent_status] > statusRank[best]) best = p.agent_status;
    }
    return best;
  };

  return (
    <main className="workspace">
      <div className="tabbar">
        <button
          className="icon sidebar-toggle"
          title={t('workspace.sidebar', { key: keyHint('toggle_sidebar') })}
          onClick={() => actions.toggleSidebar()}
        >
          <PanelLeft />
        </button>
        <span className="crumb">
          <span className="muted">{machine.label}</span> / {workspace?.label}
        </span>
        <div className="tabs" data-m={m} data-ws={ws}>
          {tabs.map((tab) => {
            const st = tabStatus(tab.tab_id);
            const editing = renaming?.m === m && renaming.id === tab.tab_id;
            return (
              <div
                key={tab.tab_id}
                className={`tab ${tab.tab_id === tabId ? 'active' : ''}`}
                onDoubleClick={() => !readOnly && actions.startRename('tab', m, tab.tab_id)}
                onPointerDown={(e) => {
                  if (e.button !== 0 || editing || (e.target as HTMLElement).closest('button, input')) return;
                  // A tab is shown on press, as in browsers: a press that turns
                  // into a drag (or whose release lands elsewhere) still switches.
                  selectTab(m, ws, tab.tab_id);
                  if (!readOnly) startTabDrag(e, { m, ws, tab: tab.tab_id, label: tab.label });
                }}
                onContextMenu={(e) => !editing && openMenu(e, tabMenu(m, ws, tab.tab_id))}
                title={readOnly ? tab.label : t('workspace.tabHint', { label: tab.label })}
                data-tab-id={tab.tab_id}
                data-m={m}
              >
                {st && <StatusDot status={st} />}
                {editing ? (
                  <InlineEdit
                    value={tab.label}
                    onDone={(v) => {
                      setRenaming(undefined);
                      if (v && v !== tab.label) actions.renameTab(m, tab.tab_id, v);
                    }}
                  />
                ) : (
                  <span className="tab-label ellipsis">{tab.label}</span>
                )}
                {tab.pane_count > 1 && (
                  <span className="tab-count" title={t('workspace.paneCount', { n: tab.pane_count })}>
                    {tab.pane_count}
                  </span>
                )}
                {!readOnly && (
                  <button
                    className="tab-close"
                    title={t('workspace.closeTab', { key: keyHint('close_tab') })}
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.closeTab(m, tab.tab_id);
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
              title={t('workspace.newTab', { key: keyHint('new_tab') })}
              onClick={() => actions.newTab(m, ws)}
              data-new-tab={ws}
              data-m={m}
            >
              <Plus />
            </button>
          )}
        </div>
      </div>
      {tabId && <PaneToolbar m={m} tabId={tabId} zoomed={layout?.zoomed} />}
      <div className="workspace-body">
        {tabId ? <SurfaceView m={m} tabId={tabId} layout={layout} /> : <div className="muted pad">{t('workspace.loadingLayout')}</div>}
      </div>
    </main>
  );
}
