import { useStore, activeTabId } from '../state/store';
import { actions } from '../actions';
import { LayoutView } from './LayoutView';
import { StatusDot } from './StatusDot';
import { statusRank, type AgentStatus } from '../lib/herdr';
import { t, type MessageKey } from '../i18n';
import { keyHint } from '../keymap';

export function Workspace() {
  const m = useStore((s) => s.machineId);
  const ws = useStore((s) => s.workspaceId);
  const machine = useStore((s) => (s.machineId ? s.machines[s.machineId] : undefined));
  const tabId = useStore((s) => {
    const snap = s.machineId ? s.machines[s.machineId]?.snapshot : undefined;
    return s.machineId && snap && s.workspaceId ? activeTabId(s, s.machineId, snap, s.workspaceId) : undefined;
  });
  const selectTab = useStore((s) => s.selectTab);

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
  const tabs = snap.tabs.filter((t) => t.workspace_id === ws).sort((a, b) => a.number - b.number);
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
          ☰
        </button>
        <span className="crumb">
          <span className="muted">{machine.label}</span> / {workspace?.label}
        </span>
        <div className="tabs">
          {tabs.map((tab) => {
            const st = tabStatus(tab.tab_id);
            return (
              <div
                key={tab.tab_id}
                className={`tab ${tab.tab_id === tabId ? 'active' : ''}`}
                onClick={() => selectTab(m, ws, tab.tab_id)}
                onDoubleClick={() => actions.renameTab(m, tab.tab_id, tab.label)}
                title={tab.label}
              >
                {st && <StatusDot status={st} />}
                <span>{tab.label}</span>
                {tab.pane_count > 1 && <span className="muted small">{tab.pane_count}</span>}
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.closeTab(m, tab.tab_id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button className="icon" title={t('workspace.newTab', { key: keyHint('new_tab') })} onClick={() => actions.newTab(m, ws)}>
            ＋
          </button>
        </div>
      </div>
      <div className="workspace-body">
        {layout ? (
          <LayoutView key={`${m}|${tabId}`} m={m} layout={layout} />
        ) : (
          <div className="muted pad">{t('workspace.loadingLayout')}</div>
        )}
      </div>
    </main>
  );
}
