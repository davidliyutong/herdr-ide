import { useEffect, useState } from 'react';
import { useStore } from './state/store';
import { terms, useTerms } from './state/terms';
import { paneHandle } from './state/panes';
import { conn } from './lib/conn';
import { Sidebar } from './components/Sidebar';
import { Workspace } from './components/Workspace';
import { Dock } from './components/Dock';
import { Palette } from './components/Palette';
import { AuthDialog } from './components/AuthDialog';
import { AddMachineDialog } from './components/AddMachineDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { Dialogs } from './components/Dialogs';
import { ContextMenu } from './components/ContextMenu';
import { usePrefs } from './prefs';
import { initDesktop } from './desktop';
import { takeOpenedFolders } from './drop';
import { commandLabel, handleKey, keyHint, onChordChange, pendingChord, runCommand } from './keymap';
import { applySettings, loadSettings } from './settings';
import { applyKeybindings, loadKeybindings, useKeys } from './keybindings';
import { t } from './i18n';
import { notifyAgent, updateBadge } from './notify';
import { shortPath } from './lib/machine';
import * as L from './term/layout';
import { useGui } from './gui/state';
import { GuiTray } from './gui/GuiMenus';
import { bridgeDownload, downloadEvent, resyncDownloads } from './download';
import { sendTarget } from './lib/bridge';
import { TransfersTray } from './components/Transfers';
import { DownloadsTray } from './components/Downloads';
import { actions } from './actions';

/** Text sent from VS Code ("Send to agent") is pasted, not submitted, into
 * the terminal sendTarget picks: the focused one, or an agent of the
 * workspace whose panel shows the sending window. */
function pasteToAgent(m: string, text: string, folders?: string[]) {
  const s = useStore.getState();
  const { terminal, workspace } = sendTarget(s, m, folders);
  if (!terminal) {
    const name = workspace && terms.layout(m)?.workspaces.find((w) => w.id === workspace)?.name;
    s.toast(workspace ? t('app.noAgentInWorkspace', { workspace: name || t('workspace.default') }) : t('app.noAgentPane'));
    return;
  }
  // Shown first, so the terminal is attached and takes the paste.
  actions.focusTerminal(m, terminal);
  const paste = () => {
    const h = paneHandle(m, terminal);
    if (!h) return false;
    h.paste(text);
    h.focus();
    return true;
  };
  if (!paste()) setTimeout(paste, 300);
}

/** Follows the shown machine's terminals and keeps the store's view of its
 * layout current: the selected workspace (for its dock), and the docks of
 * workspaces that are gone. */
function followTerms() {
  terms.start();
  const show = (m?: string) => m && terms.subscribe(m);
  show(useStore.getState().machineId);
  const offStore = useStore.subscribe((s, prev) => {
    if (s.machineId !== prev.machineId) show(s.machineId);
    // Machines removed from the core are no longer followed.
    for (const m of prev.order) if (!s.machines[m] && prev.machines[m]) terms.forget(m);
  });
  const offTerms = useTerms.subscribe((st, prev) => {
    const s = useStore.getState();
    const m = s.machineId;
    const layout = m ? st.machines[m]?.layout : undefined;
    if (layout && layout !== (m ? prev.machines[m]?.layout : undefined)) {
      s.setWorkspace(L.selectedWorkspace(layout)?.id);
      s.pruneDocks(
        m!,
        layout.workspaces.map((w) => w.id),
      );
    }
    updateBadge();
  });
  return () => {
    offStore();
    offTerms();
  };
}

export function App() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const dockPosition = usePrefs((s) => s.prefs.dockPosition);
  const connected = useStore((s) => s.connected);
  const toasts = useStore((s) => s.toasts);
  const [chord, setChord] = useState(false);

  useEffect(() => {
    const s = useStore.getState();
    conn.start({
      onMachines: (list) => s.setMachines(list),
      onMachine: (st) => {
        useStore.getState().upsertMachine(st);
        updateBadge();
      },
      onAgent: (m, data, sound) => notifyAgent(m, data, sound),
      onConnection: (c) => {
        useStore.getState().setConnected(c);
        if (c) {
          resyncDownloads();
          // Changes made while the page was away (e.g. a core restart).
          void loadSettings();
          void loadKeybindings();
        }
      },
      onBridgeSend: (m, text, folders) => pasteToAgent(m, text, folders),
      onBridgeDownload: (m, paths) => bridgeDownload(m, paths),
      onDownload: (ev) => downloadEvent(ev),
      onGui: (st) => useGui.getState().setState(st),
      onSettings: (m) => applySettings(m),
      onKeybindings: (m) => applyKeybindings(m),
    });
    const offTerms = followTerms();
    void loadKeybindings();
    const offDesktop = initDesktop();
    const offFolders = takeOpenedFolders();
    fetch('/api/config')
      .then((r) => r.json())
      .then((c) => useStore.getState().setReadOnly(!!c.read_only))
      .catch(() => {});
    const off = onChordChange(setChord);
    // Bindings also work when the focus is outside a terminal.
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el?.closest('.term-host') || el?.closest('input, textarea, iframe, [contenteditable]')) return;
      handleKey(ev);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      offTerms();
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
      <StatusBar connected={connected} chord={chord} />
      <Palette />
      <SettingsDialog />
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

function StatusBar({ connected, chord }: { connected: boolean; chord: boolean }) {
  const readOnly = useStore((s) => s.readOnly);
  // Re-rendered when the bindings change.
  useKeys((s) => s.effective);
  const m = useStore((s) => s.machineId);
  const machine = useStore((s) => (s.machineId ? s.machines[s.machineId] : undefined));
  const focused = useTerms((s) => {
    const layout = m ? s.machines[m]?.layout : undefined;
    return layout ? L.focusedTerminal(layout) : undefined;
  });
  const cwd = useTerms(() => (m && focused ? terms.directory(m, focused) : undefined));
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
          {machine.label} · {focused} · {shortPath(cwd, machine.info?.home)}
        </span>
      )}
      <span className="spacer" />
      <TransfersTray />
      <DownloadsTray />
      <GuiTray />
      {chord && <span className="prefix-badge">{pendingChord()}</span>}
      <StatusCommand command="app.keyboardShortcuts" />
      <StatusCommand command="app.commandPalette" />
    </footer>
  );
}

/** A command the status bar offers: its name, and its key when it has one. */
function StatusCommand({ command }: { command: string }) {
  const key = keyHint(command);
  return (
    <button className="status-command muted small" data-command={command} onClick={() => runCommand(command)}>
      {commandLabel(command)}
      {key && <kbd>{key}</kbd>}
    </button>
  );
}
