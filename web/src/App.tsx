import { useEffect, useState } from 'react';
import { useStore } from './state/store';
import { conn } from './lib/conn';
import { Sidebar } from './components/Sidebar';
import { Workspace } from './components/Workspace';
import { Dock } from './components/Dock';
import { Palette } from './components/Palette';
import { AuthDialog } from './components/AuthDialog';
import { RemoteHerdrDialog } from './components/RemoteHerdrDialog';
import { AddMachineDialog } from './components/AddMachineDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { Dialogs } from './components/Dialogs';
import { ContextMenu } from './components/ContextMenu';
import { usePrefs } from './prefs';
import { initDesktop } from './desktop';
import { takeOpenedFolders } from './drop';
import { getKeyConfig, handleKey, loadKeymap, onKeyConfig, onPrefixChange } from './keymap';
import { t } from './i18n';
import { notifyAgent, updateBadge } from './notify';
import { paneCwd, shortPath } from './lib/herdr';
import { findPane } from './state/store';
import { getTerm } from './terminal/registry';
import { initSurface, surfaceDisconnected } from './surface/session';
import { isFindKey, openFind } from './surface/find';
import { useGui } from './gui/state';
import { GuiTray } from './gui/GuiMenus';
import { bridgeDownload, downloadEvent, resyncDownloads } from './download';
import { sendTarget } from './lib/bridge';
import { TransfersTray } from './components/Transfers';
import { DownloadsTray } from './components/Downloads';

/** Text sent from VS Code ("Send to agent") is pasted, not submitted, into
 * the pane sendTarget picks: the focused one, or an agent pane of the
 * workspace whose panel shows the sending window. */
function pasteToAgent(m: string, text: string, folders?: string[]) {
  const s = useStore.getState();
  const pane = sendTarget(s, m, folders);
  const term = pane ? getTerm(m, pane) : undefined;
  if (!term) {
    s.toast(t('app.noAgentPane'));
    return;
  }
  term.paste(text);
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
    initSurface();
    conn.start({
      onMachines: (list) => s.setMachines(list),
      onMachine: (st) => {
        useStore.getState().upsertMachine(st);
        updateBadge();
      },
      onAgent: (m, data, sound) => notifyAgent(m, data, sound),
      onConnection: (c) => {
        useStore.getState().setConnected(c);
        if (!c) surfaceDisconnected();
        else resyncDownloads();
      },
      onBridgeSend: (m, text, folders) => pasteToAgent(m, text, folders),
      onBridgeDownload: (m, paths) => bridgeDownload(m, paths),
      onDownload: (ev) => downloadEvent(ev),
      onGui: (st) => useGui.getState().setState(st),
    });
    loadKeymap();
    const offDesktop = initDesktop();
    const offFolders = takeOpenedFolders();
    fetch('/api/config')
      .then((r) => r.json())
      .then((c) => useStore.getState().setReadOnly(!!c.read_only))
      .catch(() => {});
    const off = onPrefixChange(setPrefix);
    // The prefix key also works when focus is outside a terminal.
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t?.closest('.surface-host') || t?.closest('input, textarea, iframe, [contenteditable]')) return;
      // Find also opens for the focused pane from outside it (the sidebar).
      if (isFindKey(ev) && !document.querySelector('.modal-backdrop, .palette-backdrop')) {
        const s = useStore.getState();
        if (s.focused) {
          ev.preventDefault();
          openFind(s.focused.m, s.focused.pane);
          return;
        }
      }
      handleKey(ev);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      offDesktop();
      offFolders();
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
      <RemoteHerdrDialog />
      <AddMachineDialog />
      <Dialogs />
      <AuthDialog />
      <ContextMenu />
      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            <span>{toast.msg}</span>
            {toast.action && (
              <button
                className="primary"
                onClick={() => {
                  toast.action!.run();
                  useStore.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== toast.id) }));
                }}
              >
                {toast.action.label}
              </button>
            )}
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
      <TransfersTray />
      <DownloadsTray />
      <GuiTray />
      {prefix && <span className="prefix-badge">PREFIX</span>}
      <span className="muted small">{t('app.hint', { prefix: keyPrefix })}</span>
    </footer>
  );
}
