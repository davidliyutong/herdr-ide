import { useEffect, useState } from 'react';
import { useStore } from './state/store';
import { conn } from './lib/conn';
import { Sidebar } from './components/Sidebar';
import { Workspace } from './components/Workspace';
import { Dock } from './components/Dock';
import { Palette } from './components/Palette';
import { AuthDialog } from './components/AuthDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { Dialogs } from './components/Dialogs';
import { ContextMenu } from './components/ContextMenu';
import { usePrefs } from './prefs';
import { getKeyConfig, handleKey, loadKeymap, onKeyConfig, onPrefixChange } from './keymap';
import { t } from './i18n';
import { notifyAgent, updateBadge } from './notify';
import { paneCwd, shortPath } from './lib/herdr';
import { findPane } from './state/store';
import { getTerm } from './terminal/registry';
import { bracketedPaste } from './terminal/TermController';

/** Text sent from VS Code ("Send to agent") is pasted, not submitted, into the
 * focused pane when it is on the same machine, else that machine's most
 * attention-worthy agent pane. */
function pasteToAgent(m: string, text: string) {
  const s = useStore.getState();
  let pane = s.focused?.m === m ? s.focused.pane : undefined;
  if (!pane) {
    const agents = (s.machines[m]?.snapshot?.panes ?? []).filter((p) => p.agent);
    pane = agents.find((p) => p.agent_status === 'idle' || p.agent_status === 'done')?.pane_id ?? agents[0]?.pane_id;
  }
  const term = pane ? getTerm(m, pane) : undefined;
  if (!term) {
    s.toast(t('app.noAgentPane'));
    return;
  }
  term.input(bracketedPaste(text));
  term.focus();
}

export function App() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const dockPosition = usePrefs((s) => s.prefs.dockPosition);
  const connected = useStore((s) => s.connected);
  const toasts = useStore((s) => s.toasts);
  const [prefix, setPrefix] = useState(false);

  useEffect(() => {
    const s = useStore.getState();
    conn.start({
      onMachines: (list) => s.setMachines(list),
      onMachine: (st) => {
        useStore.getState().upsertMachine(st);
        updateBadge();
      },
      onAgent: (m, data) => notifyAgent(m, data),
      onConnection: (c) => useStore.getState().setConnected(c),
      onBridgeSend: (m, text) => pasteToAgent(m, text),
    });
    loadKeymap();
    fetch('/api/config')
      .then((r) => r.json())
      .then((c) => useStore.getState().setReadOnly(!!c.read_only))
      .catch(() => {});
    const off = onPrefixChange(setPrefix);
    // The prefix key also works when focus is outside a terminal.
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t?.closest('.xterm') || t?.closest('input, textarea, iframe, [contenteditable]')) return;
      handleKey(ev);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className={`app ${sidebarOpen ? '' : 'no-sidebar'} dock-at-${dockPosition}`}>
      {sidebarOpen && <Sidebar />}
      <Workspace />
      <Dock />
      <StatusBar connected={connected} prefix={prefix} />
      <Palette />
      <SettingsDialog />
      <Dialogs />
      <AuthDialog />
      <ContextMenu />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBar({ connected, prefix }: { connected: boolean; prefix: boolean }) {
  const readOnly = useStore((s) => s.readOnly);
  const [keyPrefix, setKeyPrefix] = useState(getKeyConfig().prefix);
  useEffect(() => {
    const off = onKeyConfig(() => setKeyPrefix(getKeyConfig().prefix));
    return () => void off();
  }, []);
  const focused = useStore((s) => s.focused);
  const pane = useStore((s) => findPane(s, s.focused));
  const machine = useStore((s) => (s.focused ? s.machines[s.focused.m] : undefined));
  const counts = useStore((s) => {
    let ready = 0;
    for (const id of s.order) if (s.machines[id]?.status === 'ready') ready++;
    return `${ready}/${s.order.length}`;
  });
  return (
    <footer className="statusbar">
      <span className={`conn ${connected ? 'on' : 'off'}`}>{connected ? t('app.connected') : t('app.reconnecting')}</span>
      {readOnly && <span className="prefix-badge ro">{t('app.readOnly')}</span>}
      <span className="muted">{t('app.machines', { n: counts })}</span>
      {focused && machine && (
        <span className="muted ellipsis">
          {machine.label} · {focused.pane} · {shortPath(paneCwd(pane), machine.info?.home)}
        </span>
      )}
      <span className="spacer" />
      {prefix && <span className="prefix-badge">PREFIX</span>}
      <span className="muted small">{t('app.hint', { prefix: keyPrefix })}</span>
    </footer>
  );
}
