import { lazy, Suspense, useEffect, useState } from 'react';
import { Check, CircleAlert, TriangleAlert } from 'lucide-react';
import { useStore } from './state/store';
import { terms, useTerms } from './state/terms';
import { rememberFollowed } from './state/followed';
import { paneHandle } from './state/panes';
import { conn } from './lib/conn';
import { Sidebar } from './components/Sidebar';
import { Workspace } from './components/Workspace';
import { CodeLayer } from './components/CodeLayer';
import { ContextMenu } from './components/ContextMenu';
import { useDialog } from './dialog';
import { initDesktop } from './desktop';
import { warnOnUnload } from './unsaved';
import { followDesktopClose } from './quitGuard';
import { takeOpenedFolders } from './drop';
import {
  closeWindowPane,
  leaveWindowPane,
  commandLabel,
  handleKey,
  handlePaneLeaveKey,
  keyHint,
  onChordChange,
  pendingChord,
  runCommand,
} from './keymap';
import { applySettings, loadSettings } from './settings';
import { applyKeybindings, loadKeybindings, useKeys } from './keybindings';
import { t } from './i18n';
import { initNotifications, notifyAgent, updateBadge } from './notify';
import { shortPath, terminalTitle } from './lib/machine';
import * as L from './term/layout';
import { useGui } from './gui/state';
import { bridgeDownload, downloadEvent, resyncDownloads } from './download';
import { noteFocusedTerminal, sendTarget } from './lib/bridge';
import { windowFocused } from './codeFrames';
import { followVSCodeSwitch } from './plugins/vscode/workers';
import { isStatusWidget, type StatusWidgetDef } from './plugins/api';
import { describeView, pluginMessage, useActivePlugins, usePanels, usePluginOn } from './plugins/registry';
import { RightBar } from './components/RightBar';
import { PluginBoundary } from './components/PluginBoundary';
import { openMenu, type MenuEntry } from './contextMenu';
import './plugins';
import './commands';
import { actions, current, workspaceTitle } from './actions';
import { initMainWindowSync } from './detachedWindow';
import { noteFocus } from './paneHistory';
import { loadConfig, retryFailedBootstrap, startBootstrap } from './bootstrap';

// Lazy-loaded overlays and optional layers: none is visible on initial paint,
// keeping them out of the startup JS parse/eval path until opened.
const BrowserLayer = lazy(() => import('./plugins/browser/BrowserLayer').then((m) => ({ default: m.BrowserLayer })));
const Palette = lazy(() => import('./components/Palette').then((m) => ({ default: m.Palette })));
const AuthDialog = lazy(() => import('./components/AuthDialog').then((m) => ({ default: m.AuthDialog })));
const AddMachineDialog = lazy(() => import('./components/AddMachineDialog').then((m) => ({ default: m.AddMachineDialog })));
const SettingsDialog = lazy(() => import('./components/SettingsDialog').then((m) => ({ default: m.SettingsDialog })));
const Dialogs = lazy(() => import('./components/Dialogs').then((m) => ({ default: m.Dialogs })));

/** Text sent from VS Code ("Send to agent") is pasted, not submitted, into
 * the terminal sendTarget picks: an agent of the sending VS Code pane's tab
 * or workspace. The page whose pane that is takes it. */
function pasteToAgent(m: string, text: string, window?: string, folders?: string[]) {
  const s = useStore.getState();
  const target = sendTarget(m, window, folders);
  if (!target) return;
  const { terminal, workspace } = target;
  if (!terminal) {
    const ws = workspace ? terms.layout(m)?.workspaces.find((w) => w.id === workspace) : undefined;
    s.toast(ws ? t('app.noAgentInWorkspace', { workspace: workspaceTitle(m, ws) }) : t('app.noAgentPane'));
    return;
  }
  // Shown first, so the terminal is attached and takes the paste.
  actions.focusPane(m, terminal);
  const paste = () => {
    const h = paneHandle(m, terminal);
    if (!h) return false;
    h.paste(text);
    h.focus();
    return true;
  };
  if (!paste()) setTimeout(paste, 300);
}

/** Follows the shown machine's terminals (and those followed before,
 * state/followed.ts) and keeps the store's view of its
 * layout current: the selected workspace, and the terminal focused last in
 * it (Send to Agent's choice when the workspace has no agent). */
function followTerms() {
  terms.start();
  const show = (m?: string) => m && terms.subscribe(m);
  show(useStore.getState().machineId);
  // The machines followed before are followed again once connected.
  const offFollowed = rememberFollowed(() => terms);
  // The panes focused, for Go Back and Go Forward.
  const noteFocused = () => {
    const c = current();
    if (c?.focused) noteFocus({ m: c.m, pane: c.focused });
  };
  const offStore = useStore.subscribe((s, prev) => {
    if (s.machineId !== prev.machineId) {
      show(s.machineId);
      noteFocused();
    }
    // Machines removed from the hub are no longer followed.
    for (const m of prev.order) if (!s.machines[m] && prev.machines[m]) terms.forget(m);
  });
  const offTerms = useTerms.subscribe((st, prev) => {
    const s = useStore.getState();
    const m = s.machineId;
    const layout = m ? st.machines[m]?.layout : undefined;
    if (layout && layout !== (m ? prev.machines[m]?.layout : undefined)) {
      s.setWorkspace(L.selectedWorkspace(layout)?.id);
      noteFocusedTerminal(m!, layout);
      noteFocused();
    }
    updateBadge();
  });
  return () => {
    offStore();
    offTerms();
    offFollowed();
  };
}

export function App() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const connected = useStore((s) => s.connected);
  const toasts = useStore((s) => s.toasts);
  const panels = usePanels();
  const browserOn = usePluginOn('browser');
  const panel = useStore((s) => s.panel);
  const panelWidth = useStore((s) => s.panelWidth);
  const panelShown = panels.some((p) => p.id === panel);
  const paletteOpen = useStore((s) => !!s.palette);
  const settingsOpen = useStore((s) => !!s.settings);
  const addMachineOpen = useStore((s) => s.addMachine);
  const authOpen = useStore((s) => !!s.auth);
  const dialogOpen = useDialog((s) => !!s.current);
  const [chord, setChord] = useState(false);

  useEffect(() => {
    const s = useStore.getState();
    // Ensure initial settings, keybindings and config fetches are in flight
    // (no-op when main.tsx already kicked them off in parallel).
    const boot = startBootstrap();
    let hadConnection = false;
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
          if (hadConnection) {
            // Re-sync changes made while the page was away (e.g. a hub restart).
            void loadSettings();
            void loadKeybindings();
            void loadConfig();
          } else {
            // Retry only any initial bootstrap request that failed transiently.
            void retryFailedBootstrap(boot);
          }
          hadConnection = true;
        }
      },
      onBridgeSend: (m, text, window, folders) => pasteToAgent(m, text, window, folders),
      onBridgeDownload: (m, paths, window) => bridgeDownload(m, paths, window),
      onBridgeFocus: (m, window, folders) => void windowFocused(m, window, folders),
      onBridgeClose: (m, window, folders) => closeWindowPane(m, window, folders),
      onBridgeLeave: (m, window, folders) => leaveWindowPane(m, window, folders),
      onDownload: (ev) => downloadEvent(ev),
      onGui: (st) => useGui.getState().setState(st),
      onSettings: (m) => applySettings(m),
      onKeybindings: (m) => applyKeybindings(m),
      onPlugin: (plugin, m, data) => pluginMessage(plugin, m, data),
    });
    const offTerms = followTerms();
    const offDesktop = initDesktop();
    const offNotify = initNotifications();
    const offUnload = warnOnUnload();
    const offClose = followDesktopClose();
    const offFolders = takeOpenedFolders();
    const offWorkers = followVSCodeSwitch();
    const offWindows = initMainWindowSync({ onDock: (dm, dpane) => actions.focusPane(dm, dpane) });
    const off = onChordChange(setChord);
    // Ctrl+B escapes focus from editors and pane inputs before they consume it;
    // terminals route their own keys through TermPane -> appKey -> handleKey.
    const onCaptureKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (!el || el.closest('.term-host') || el.closest('.pane-header') || el.closest('.inline-edit')) return;
      if (el.closest('.pane') || (el.closest('.panel') && el.closest('input, textarea, [contenteditable]'))) {
        handlePaneLeaveKey(ev);
      }
    };
    // Bindings also work when the focus is outside a terminal or Monaco editor.
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el?.closest('.term-host') || el?.closest('.monaco-editor') || el?.closest('input, textarea, iframe, [contenteditable]')) return;
      handleKey(ev);
    };
    window.addEventListener('keydown', onCaptureKey, true);
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      offTerms();
      offDesktop();
      offNotify();
      offUnload();
      offClose();
      offFolders();
      offWorkers();
      offWindows();
      window.removeEventListener('keydown', onCaptureKey, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div
      className={`app ${sidebarOpen ? '' : 'no-sidebar'}`}
      style={
        {
          '--sidebar-w': `${sidebarWidth}px`,
          '--panel-w': panelShown ? `${panelWidth}px` : '0px',
          '--panel-px': `${panelWidth}px`,
          '--rail-w': panels.length ? 'var(--ds-size-rail)' : '0px',
        } as React.CSSProperties
      }
    >
      {sidebarOpen && <Sidebar />}
      {/* On a narrow screen the sidebar lies over the panes: a press beside it closes it. */}
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => actions.toggleSidebar()} />}
      <Workspace />
      <CodeLayer />
      {browserOn && (
        <Suspense fallback={null}>
          <BrowserLayer />
        </Suspense>
      )}
      <RightBar />
      <StatusBar connected={connected} chord={chord} />
      {paletteOpen && (
        <Suspense fallback={null}>
          <Palette />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog />
        </Suspense>
      )}
      {addMachineOpen && (
        <Suspense fallback={null}>
          <AddMachineDialog />
        </Suspense>
      )}
      {dialogOpen && (
        <Suspense fallback={null}>
          <Dialogs />
        </Suspense>
      )}
      {authOpen && (
        <Suspense fallback={null}>
          <AuthDialog />
        </Suspense>
      )}
      <ContextMenu />
      <div className="toasts">
        {toasts
          .filter((toast) => toast.position !== 'bottom-left')
          .map((toast) => (
            <div key={toast.id} className={`toast ${toast.kind ?? ''}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
              {toast.kind === 'error' && <CircleAlert />}
              {toast.kind === 'warning' && <TriangleAlert />}
              <span>{toast.msg}</span>
              {toast.action && (
                <button
                  className="sm"
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
      {toasts.some((toast) => toast.position === 'bottom-left') && (
        <div className="toasts toasts-left">
          {toasts
            .filter((toast) => toast.position === 'bottom-left')
            .map((toast) => (
              <div key={toast.id} className={`toast ${toast.kind ?? ''}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
                {toast.kind === 'error' && <CircleAlert />}
                {toast.kind === 'warning' && <TriangleAlert />}
                <span>{toast.msg}</span>
                {toast.action && (
                  <button
                    className="sm"
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
      )}
    </div>
  );
}

const BUILTIN_STATUS_WIDGETS = [
  { id: 'app.machines', title: 'statusbar.widget.machines' },
  { id: 'app.pane', title: 'statusbar.widget.pane' },
  { id: 'app.keyboardShortcuts', title: 'command.app.keyboardShortcuts' },
  { id: 'app.commandPalette', title: 'command.app.commandPalette' },
] as const;

export function StatusBar({ connected, chord }: { connected: boolean; chord: boolean }) {
  const readOnly = useStore((s) => s.readOnly);
  const hiddenList = useStore((s) => s.hiddenStatusWidgets);
  const hidden = new Set(hiddenList);
  const plugins = useActivePlugins();
  // Re-rendered when the bindings change.
  useKeys((s) => s.effective);
  const m = useStore((s) => s.machineId);
  const machine = useStore((s) => (s.machineId ? s.machines[s.machineId] : undefined));
  // The focused pane: a terminal (its title and directory), VS Code (its
  // folder) or a preview (its file).
  const leaf = useTerms((s) => {
    const tab = m && s.machines[m]?.layout ? L.selectedTab(s.machines[m].layout!) : undefined;
    return tab ? L.leafOf(tab.root, tab.focused) : null;
  });
  const terminal = leaf && L.isTerminalLeaf(leaf) ? leaf.terminal : undefined;
  const cwd = useTerms(() => (m && terminal ? terms.directory(m, terminal) : undefined));
  const title = useTerms((s) => (m && terminal ? terminalTitle(s.machines[m]?.terminals[terminal], terminal) : undefined));
  const about = !leaf
    ? undefined
    : L.isCodeLeaf(leaf)
      ? { title: t('code.title'), path: leaf.code.folder }
      : L.isPreviewLeaf(leaf)
        ? { title: t('preview.title'), path: leaf.preview.path }
        : L.isPluginLeaf(leaf)
          ? (({ title, path }) => ({ title, path }))(describeView(m!, leaf.view))
          : { title, path: cwd };
  const counts = useStore((s) => {
    let ready = 0;
    for (const id of s.order) if (s.machines[id]?.status === 'ready') ready++;
    return `${ready}/${s.order.length}`;
  });

  const pluginWidgets: StatusWidgetDef[] = plugins.flatMap((p) => (p.statusItems ?? []).filter(isStatusWidget));
  const allWidgets = [
    ...BUILTIN_STATUS_WIDGETS.slice(0, 2).map((w) => ({ id: w.id, label: t(w.title) })),
    ...pluginWidgets.map((w) => ({ id: w.id, label: t(w.title) })),
    ...BUILTIN_STATUS_WIDGETS.slice(2).map((w) => ({ id: w.id, label: t(w.title) })),
  ];

  const openWidgetMenu = (
    ev: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void },
    targetWidgetId?: string,
  ) => {
    const s = useStore.getState();
    const entries: MenuEntry[] = [];
    if (targetWidgetId) {
      const target = allWidgets.find((w) => w.id === targetWidgetId);
      if (target && !s.hiddenStatusWidgets.includes(target.id)) {
        entries.push({
          label: t('statusbar.hideWidget', { name: target.label }),
          run: () => s.setStatusWidgetVisible(target.id, false),
        });
        entries.push('sep');
      }
    }
    for (const w of allWidgets) {
      const visible = !s.hiddenStatusWidgets.includes(w.id);
      entries.push({
        label: w.label,
        icon: visible ? <Check /> : <span className="status-menu-blank" aria-hidden />,
        run: () => s.toggleStatusWidget(w.id),
      });
    }
    if (allWidgets.some((w) => s.hiddenStatusWidgets.includes(w.id))) {
      entries.push('sep');
      entries.push({
        label: t('statusbar.showAll'),
        run: () => s.showAllStatusWidgets(),
      });
    }
    openMenu(ev, entries);
  };

  return (
    <footer
      className="statusbar"
      onContextMenu={(e) => {
        const hit = (e.target as HTMLElement).closest<HTMLElement>('[data-status-widget]')?.dataset.statusWidget;
        openWidgetMenu(e, hit);
      }}
    >
      <span className={`conn ${connected ? 'on' : 'off'}`}>{connected ? t('app.connected') : t('app.reconnecting')}</span>
      {readOnly && <span className="prefix-badge ro">{t('app.readOnly')}</span>}
      {!hidden.has('app.machines') && <span data-status-widget="app.machines">{t('app.machines', { n: counts })}</span>}
      {!hidden.has('app.pane') && about && machine && (
        <span className="ellipsis" data-status-widget="app.pane">
          {machine.label} · {about.title} · {shortPath(about.path, machine.info?.home) || '~'}
        </span>
      )}
      <span className="spacer" />
      <PluginStatusItems hidden={hidden} />
      {chord && <span className="prefix-badge">{pendingChord()}</span>}
      {!hidden.has('app.keyboardShortcuts') && <StatusCommand widgetId="app.keyboardShortcuts" command="app.keyboardShortcuts" />}
      {!hidden.has('app.commandPalette') && <StatusCommand widgetId="app.commandPalette" command="app.commandPalette" />}
    </footer>
  );
}

/** A command the status bar offers: its name, and its key when it has one. */
function StatusCommand({ widgetId, command }: { widgetId: string; command: string }) {
  const key = keyHint(command);
  return (
    <button className="status-command" data-command={command} data-status-widget={widgetId} onClick={() => runCommand(command)}>
      {commandLabel(command)}
      {key && <kbd>{key}</kbd>}
    </button>
  );
}

/** The status bar's items of the plugins that are on, each in an error
 * boundary of its own. Toggleable widgets (StatusWidgetDef) are skipped while
 * hidden; plain components (dialogs, overlays) always stay mounted. */
function PluginStatusItems({ hidden }: { hidden: ReadonlySet<string> }) {
  const plugins = useActivePlugins();
  return (
    <>
      {plugins.flatMap((p) =>
        (p.statusItems ?? []).map((entry, i) => {
          if (isStatusWidget(entry)) {
            if (hidden.has(entry.id)) return null;
            const Item = entry.component;
            return (
              <span key={`${p.id}:${entry.id}`} className="status-widget" data-status-widget={entry.id}>
                <PluginBoundary plugin={t(p.title)} compact>
                  <Item />
                </PluginBoundary>
              </span>
            );
          }
          const Item = entry;
          return (
            <PluginBoundary key={`${p.id}:${i}`} plugin={t(p.title)} compact>
              <Item />
            </PluginBoundary>
          );
        }),
      )}
    </>
  );
}
