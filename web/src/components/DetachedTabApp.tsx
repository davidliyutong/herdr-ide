// Minimal standalone window showing only the core pane(s) of a single detached
// tab — no left sidebar, no right sidebar, no tab bar, no status bar.
// Closing this window directly closes the tab (asking first if any editor in it
// has unsaved changes), while docking back returns the tab to the main window
// untouched and quitting the app preserves tabs across restarts.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { useStore } from '../state/store';
import { terms, useTerms } from '../state/terms';
import { allUnsaved, onUnsavedChange, paneHandle } from '../state/panes';
import { conn } from '../lib/conn';
import { TabView } from './Workspace';
import { CodeLayer } from './CodeLayer';
import { ContextMenu } from './ContextMenu';
import { quitDialog, useDialog } from '../dialog';
import { setLeaving, warnOnUnload } from '../unsaved';
import { closeWindowPane, handleKey, handleEditorKey, leaveWindowPane } from '../keymap';
import { runMenuCommand } from '../desktop';
import { desktopShell } from '../shell';
import { applySettings, loadSettings } from '../settings';
import { applyKeybindings, loadKeybindings, useKeys, type Binding } from '../keybindings';
import { t } from '../i18n';
import * as L from '../term/layout';
import { useGui } from '../gui/state';
import { bridgeDownload, downloadEvent, resyncDownloads } from '../download';
import { sendTarget } from '../lib/bridge';
import { windowFocused } from '../codeFrames';
import { followVSCodeSwitch } from '../plugins/vscode/workers';
import { pluginMessage, usePluginOn } from '../plugins/registry';
import { actions, paneTitle, tabName, terminalPlace, workspaceTitle } from '../actions';
import { loadConfig, retryFailedBootstrap, startBootstrap } from '../bootstrap';
import {
  DETACHED_ALLOWED_COMMANDS,
  initDetachedWindowSync,
  setDetachedCloseHandler,
  setDetachedCurrentGetter,
  setDockHandler,
} from '../detachedWindow';
import { APP_NAME } from '../brand';
import '../plugins';
import '../commands';

const BrowserLayer = lazy(() => import('../plugins/browser/BrowserLayer').then((m) => ({ default: m.BrowserLayer })));
const Palette = lazy(() => import('./Palette').then((m) => ({ default: m.Palette })));
const AuthDialog = lazy(() => import('./AuthDialog').then((m) => ({ default: m.AuthDialog })));
const Dialogs = lazy(() => import('./Dialogs').then((m) => ({ default: m.Dialogs })));

/** Maximum time to wait for remote terminal.close calls when closing a detached window. */
const TERMINAL_CLOSE_WAIT_MS = 1500;

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

/** Finds the workspace and tab in `layout` that holds any pane of `panes`. */
function locateTabByPanes(
  layout: L.Layout | undefined,
  panes: readonly string[],
): { ws: L.Workspace; index: number; tab: L.Tab } | undefined {
  if (!layout || !panes.length) return undefined;
  for (const p of panes) {
    const at = L.locate(layout, p);
    if (at) {
      const ws = layout.workspaces[at.workspace];
      const tab = ws?.tabs[at.tab];
      if (ws && tab) return { ws, index: at.tab, tab };
    }
  }
  return undefined;
}

export function DetachedTabApp({ m, pane }: { m: string; pane: string }) {
  const machine = useStore((s) => s.machines[m]);
  const mt = useTerms((s) => s.machines[m]);
  const toasts = useStore((s) => s.toasts);
  const browserOn = usePluginOn('browser');
  const paletteOpen = useStore((s) => !!s.palette);
  const authOpen = useStore((s) => !!s.auth);
  const dialogOpen = useDialog((s) => !!s.current);

  const knownPanesRef = useRef<string[]>([pane]);
  const seenTabRef = useRef(false);
  const wsIdRef = useRef<string | undefined>(undefined);
  const dockingRef = useRef(false);
  const dockConfirmingRef = useRef(false);
  const closingTabRef = useRef(false);
  const syncRef = useRef<ReturnType<typeof initDetachedWindowSync> | undefined>(undefined);

  const found = useMemo(() => locateTabByPanes(mt?.layout, knownPanesRef.current), [mt?.layout]);
  if (found) {
    seenTabRef.current = true;
    wsIdRef.current = found.ws.id;
    const nextPanes = L.tabPanes(found.tab);
    if (nextPanes.join('\n') !== knownPanesRef.current.join('\n')) {
      knownPanesRef.current = nextPanes;
    }
  }

  /** Checks unsaved changes for this tab's panes; returns true if transitioning
   * or closing may proceed. Brings this window forward when asking the user. */
  const confirmTabUnsaved = useCallback(async (): Promise<boolean> => {
    const panes = new Set(knownPanesRef.current);
    const files = allUnsaved().filter((f) => f.m === m && panes.has(f.pane));
    if (!files.length) return true;
    window.focus();
    if (desktopShell?.windows) {
      void desktopShell.windows.openTab({ m, pane });
    }
    const machineLabel = useStore.getState().machines[m]?.label ?? m;
    const answer = await quitDialog(
      files.map((f) => ({
        name: f.name,
        place: [machineLabel, terminalPlace(f.m, f.pane)].filter(Boolean).join(' · '),
      })),
    );
    if (answer === 'discard') return true;
    if (answer === 'save') {
      for (const f of files) if (!(await f.save())) return false;
      return true;
    }
    if (typeof answer === 'object' && files[answer.show]) {
      actions.focusPane(files[answer.show].m, files[answer.show].pane);
    }
    return false;
  }, [m, pane]);

  /** Docks this tab back into the main window without closing it, confirming
   * any unsaved edits first so in-memory edits are never silently discarded. */
  const dock = useCallback(async () => {
    if (dockingRef.current || dockConfirmingRef.current) return;
    dockConfirmingRef.current = true;
    try {
      if (!(await confirmTabUnsaved())) return;
      dockingRef.current = true;
      const live = locateTabByPanes(terms.layout(m), knownPanesRef.current);
      const targetPane = live?.tab.focused || knownPanesRef.current[0] || pane;
      syncRef.current?.notifyDock(targetPane);
      desktopShell?.windows?.focusMain();
      setLeaving(true);
      window.close();
    } finally {
      dockConfirmingRef.current = false;
    }
  }, [m, pane, confirmTabUnsaved]);

  const dockRef = useRef(dock);
  dockRef.current = dock;

  /** Closes the tab in the machine's layout and terminates its terminals. */
  const closeOwnedTab = useCallback(async () => {
    if (closingTabRef.current || dockingRef.current) return;
    closingTabRef.current = true;
    const layout = terms.layout(m);
    const live = locateTabByPanes(layout, knownPanesRef.current);
    if (!live) return;
    const terminals = L.tabTerminals(live.tab);
    terms.mutate(m, (l) => {
      const cur = locateTabByPanes(l, knownPanesRef.current);
      return cur ? L.closeTab(l, cur.ws.id, cur.index) : l;
    });
    if (terminals.length) {
      await Promise.race([
        Promise.allSettled(terminals.map((addr) => terms.call(m, 'terminal.close', { terminal: addr }))),
        new Promise((r) => setTimeout(r, TERMINAL_CLOSE_WAIT_MS)),
      ]);
    }
  }, [m]);

  // Core startup: connect event channel, subscribe to this machine's terminals,
  // coordinate with main window, and wire close guard & keyboard shortcuts.
  useEffect(() => {
    const s = useStore.getState();
    s.selectMachine(m);
    const boot = startBootstrap();
    let hadConnection = false;
    conn.start({
      onMachines: (list) => s.setMachines(list),
      onMachine: (st) => useStore.getState().upsertMachine(st),
      onAgent: () => {},
      onConnection: (c) => {
        useStore.getState().setConnected(c);
        if (c) {
          resyncDownloads();
          if (hadConnection) {
            void loadSettings();
            void loadKeybindings();
            void loadConfig();
          } else {
            void retryFailedBootstrap(boot);
          }
          hadConnection = true;
        }
      },
      onBridgeSend: (bm, text, win, folders) => pasteToAgent(bm, text, win, folders),
      onBridgeDownload: (bm, paths, win) => bridgeDownload(bm, paths, win),
      onBridgeFocus: (bm, win, folders) => void windowFocused(bm, win, folders),
      onBridgeClose: (bm, win, folders) => closeWindowPane(bm, win, folders),
      onBridgeLeave: (bm, win, folders) => leaveWindowPane(bm, win, folders),
      onDownload: (ev) => downloadEvent(ev),
      onGui: (st) => useGui.getState().setState(st),
      onSettings: (msg) => applySettings(msg),
      onKeybindings: (msg) => applyKeybindings(msg),
      onPlugin: (plugin, pm, data) => pluginMessage(plugin, pm, data),
    });
    terms.start();
    terms.subscribe(m);

    // Keep keybindings in this detached window restricted to detached-safe
    // commands so neither app chrome nor terminal key handlers mutate main.
    let savedEffective: Binding[] | undefined;
    const pruneBindings = () => {
      const cur = useKeys.getState().effective;
      const filtered = cur.filter((b) => DETACHED_ALLOWED_COMMANDS.has(b.command));
      if (filtered.length !== cur.length) {
        savedEffective = cur;
        useKeys.setState({ effective: filtered });
      }
    };
    pruneBindings();
    const offKeys = useKeys.subscribe(pruneBindings);

    setDetachedCurrentGetter(() => {
      const live = locateTabByPanes(terms.layout(m), knownPanesRef.current);
      return live ? { m, wsId: live.ws.id, tabIndex: live.index } : undefined;
    });

    const sync = initDetachedWindowSync({
      m,
      initialPane: pane,
      getPanes: () => knownPanesRef.current,
      getWorkspace: () => wsIdRef.current,
      onDockAll: () => void dockRef.current(),
      onConfirmClose: async () => {
        const ok = await confirmTabUnsaved();
        if (ok) setLeaving(true);
        return ok;
      },
    });
    syncRef.current = sync;
    setDockHandler(() => void dockRef.current());
    setDetachedCloseHandler(() => {
      if (desktopShell) {
        window.close();
        return;
      }
      void (async () => {
        if (dockingRef.current || closingTabRef.current) return;
        if (!(await confirmTabUnsaved())) return;
        setLeaving(true);
        await closeOwnedTab();
        syncRef.current?.notifyClosed();
        window.close();
      })();
    });

    const offUnload = warnOnUnload();
    const offWorkers = followVSCodeSwitch();

    // Sync unsaved count & handle close requests from Electron shell.
    let offUnsaved = () => {};
    let offCloseReq = () => {};
    let offMenuCmd = () => {};
    const shell = desktopShell;
    if (shell) {
      let told = -1;
      const tell = () => {
        const panes = new Set(knownPanesRef.current);
        const n = allUnsaved().filter((f) => f.m === m && panes.has(f.pane)).length;
        if (n !== told) shell.setUnsaved((told = n));
      };
      tell();
      offUnsaved = onUnsavedChange(tell);
      offCloseReq = shell.onCloseRequest((reason) => {
        void (async () => {
          if (dockingRef.current) {
            setLeaving(true);
            shell.answerClose('close');
            return;
          }
          setLeaving(false);
          shell.answerClose('asking');
          let ok = false;
          try {
            ok = await confirmTabUnsaved();
            if (ok && reason !== 'quit') {
              await closeOwnedTab();
            }
          } catch (e) {
            console.warn(e);
            ok = false;
          }
          if (ok) {
            setLeaving(true);
            sync.notifyClosed();
            shell.answerClose('close');
          } else {
            shell.answerClose('stay');
          }
        })();
      });
      offMenuCmd = shell.onCommand((cmd) => {
        if (cmd === 'tab.close') {
          window.close();
          return;
        }
        if (!DETACHED_ALLOWED_COMMANDS.has(cmd)) return;
        runMenuCommand(cmd);
      });
    }

    // Browser mode: closing the popup closes the tab unless docking back.
    const onPageHide = () => {
      if (!desktopShell && !dockingRef.current && !closingTabRef.current) {
        void closeOwnedTab();
      }
      if (!dockingRef.current) sync.notifyClosed();
    };
    window.addEventListener('pagehide', onPageHide);

    const onCaptureKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (!el || el.closest('.term-host') || el.closest('.pane-header') || el.closest('.inline-edit')) return;
      if (el.closest('.pane')) handleEditorKey(ev);
    };
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el?.closest('.term-host') || el?.closest('.monaco-editor') || el?.closest('input, textarea, iframe, [contenteditable]')) return;
      handleKey(ev);
    };
    window.addEventListener('keydown', onCaptureKey, true);
    window.addEventListener('keydown', onKey);

    return () => {
      offKeys();
      if (savedEffective) useKeys.setState({ effective: savedEffective });
      setDetachedCurrentGetter(undefined);
      setDetachedCloseHandler(undefined);
      setDockHandler(undefined);
      sync.dispose();
      syncRef.current = undefined;
      offUnload();
      offWorkers();
      offUnsaved();
      offCloseReq();
      offMenuCmd();
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('keydown', onCaptureKey, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [m, pane, confirmTabUnsaved, closeOwnedTab]);

  // Re-announce whenever the tab's panes change (splits added/closed).
  const panesSig = found ? L.tabPanes(found.tab).join('\n') : '';
  useEffect(() => {
    if (panesSig) syncRef.current?.announce();
  }, [panesSig]);

  // Keep native window title synced to the active pane / tab title.
  useEffect(() => {
    if (!found) {
      document.title = machine?.label ? `${machine.label} · ${APP_NAME}` : APP_NAME;
      return;
    }
    const leaf = L.leafOf(found.tab.root, found.tab.focused);
    const label = found.tab.name || (leaf ? paneTitle(m, leaf, found.tab.focused) : tabName(m, found.tab));
    document.title = machine?.label ? `${label} · ${machine.label}` : label;
  }, [m, found, machine?.label, mt?.terminals]);

  // If the tab disappeared after we showed it (e.g. its last pane was closed),
  // close this detached window automatically.
  useEffect(() => {
    if (!seenTabRef.current || found || dockingRef.current) return;
    closingTabRef.current = true;
    setLeaving(true);
    syncRef.current?.notifyClosed();
    window.close();
  }, [found]);

  return (
    <div className="detached-app">
      <main className="workspace detached-workspace">
        <div className="workspace-body">
          {found ? (
            <TabView m={m} ws={found.ws.id} tab={found.tab} />
          ) : (
            <div className="empty-state muted">
              <div>{seenTabRef.current ? t('window.tabGone') : t('workspace.waiting')}</div>
            </div>
          )}
        </div>
      </main>
      <CodeLayer />
      {browserOn && (
        <Suspense fallback={null}>
          <BrowserLayer />
        </Suspense>
      )}
      {paletteOpen && (
        <Suspense fallback={null}>
          <Palette />
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
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((toast) => (
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
