// Multi-window tear-off tabs: a tab can be dragged out of the main window (or
// opened via its context menu) into a minimal standalone window showing only
// the tab's core panes (no left/right sidebars, tab bar, or status bar).
// The tab stays in the machine's shared layout document while detached so its
// terminals, editors and chats remain live; same-origin windows coordinate via
// BroadcastChannel so the main window hides detached tabs and can dock them
// back cleanly. Closing a detached window directly closes its tab (after
// checking unsaved changes), whereas quitting the app leaves tabs intact.

import { create } from 'zustand';
import { APP_SLUG } from './brand';
import { t } from './i18n';
import { desktopShell } from './shell';
import { useStore } from './state/store';
import { terms } from './state/terms';
import * as L from './term/layout';
import { confirmUnsaved } from './unsaved';

/** Client-side route served by index.html for a standalone tab window. */
export const DETACHED_TAB_PATH = '/window/tab';

/** Default size of a newly opened standalone tab window. */
export const DETACHED_WIDTH = 1040;
export const DETACHED_HEIGHT = 720;

/** Commands permitted inside a detached standalone tab window (shortcuts,
 * native menu dispatch, and command palette). All other commands are scoped
 * to the main window so detached windows never mutate the main window. */
export const DETACHED_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'pane.splitRight',
  'pane.splitDown',
  'pane.zoom',
  'pane.close',
  'pane.leave',
  'pane.actions',
  'pane.rename',
  'pane.focusLeft',
  'pane.focusRight',
  'pane.focusUp',
  'pane.focusDown',
  'pane.focusNext',
  'pane.focusPrevious',
  'tab.close',
  'find.open',
  'find.next',
  'find.previous',
  'view.zoomIn',
  'view.zoomOut',
  'view.zoomReset',
  'app.commandPalette',
]);

export interface DetachedTarget {
  m: string;
  pane: string;
}

export interface DetachedRecord {
  winId: string;
  m: string;
  /** The initial pane key this detached window was opened with (matches
   * desktop/src/main.ts's window map key even after splits/focus changes). */
  initialPane?: string;
  panes: string[];
}

export interface DetachedCurrent {
  m: string;
  wsId: string;
  tabIndex: number;
}

type WindowMsg =
  | { type: 'detached'; winId: string; m: string; initialPane?: string; panes: string[] }
  | { type: 'closed'; winId: string }
  | { type: 'ping' }
  | { type: 'dock'; winId: string; m: string; pane: string }
  | { type: 'focus'; winId: string }
  | { type: 'dockAll'; m?: string; ws?: string }
  | { type: 'confirmClose'; reqId: string; winId: string }
  | { type: 'confirmCloseAck'; reqId: string; winId: string }
  | { type: 'confirmCloseReply'; reqId: string; winId: string; ok: boolean };

const CHANNEL_NAME = `${APP_SLUG}:windows`;

/** Builds the URL for a standalone tab window. */
export function detachedTabUrl(m: string, pane: string): string {
  return `${DETACHED_TAB_PATH}?m=${encodeURIComponent(m)}&pane=${encodeURIComponent(pane)}`;
}

/** Parses a standalone tab window route, or undefined for the main app. */
export function parseDetachedTab(
  pathname: string = typeof location === 'undefined' ? '' : location.pathname,
  search: string = typeof location === 'undefined' ? '' : location.search,
): DetachedTarget | undefined {
  if (pathname !== DETACHED_TAB_PATH && pathname !== `${DETACHED_TAB_PATH}/`) return undefined;
  const params = new URLSearchParams(search);
  const m = params.get('m')?.trim() ?? '';
  const pane = params.get('pane')?.trim() ?? '';
  return m && pane ? { m, pane } : undefined;
}

/** True when this page is running as a detached standalone tab window. */
export function isDetachedWindow(): boolean {
  return desktopShell?.detached === true || !!parseDetachedTab();
}

/** Tracks tabs currently open in detached windows (used by the main window to
 * hide them from its tab bar and coordinate focus / dock-back). */
export const useDetachedTabs = create<{ records: Record<string, DetachedRecord> }>(() => ({ records: {} }));

/** Returns the detached window record holding `tab` of machine `m`, if any. */
export function detachedRecordForTab(
  m: string,
  tab: L.Tab,
  records: Record<string, DetachedRecord> = useDetachedTabs.getState().records,
): DetachedRecord | undefined {
  const panes = L.tabPanes(tab);
  for (const r of Object.values(records)) {
    if (r.m === m && r.panes.some((p) => panes.includes(p))) return r;
  }
  return undefined;
}

/** Returns the detached window record holding `pane` of machine `m`, if any. */
export function detachedRecordForPane(
  m: string,
  pane: string,
  records: Record<string, DetachedRecord> = useDetachedTabs.getState().records,
): DetachedRecord | undefined {
  for (const r of Object.values(records)) {
    if (r.m === m && r.panes.includes(pane)) return r;
  }
  return undefined;
}

function openChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  try {
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return undefined;
  }
}

let sharedChannel: BroadcastChannel | undefined;
function channel(): BroadcastChannel | undefined {
  sharedChannel ??= openChannel();
  return sharedChannel;
}

function post(msg: WindowMsg) {
  try {
    channel()?.postMessage(msg);
  } catch {
    // Channel closed or unavailable in tests.
  }
}

/** Unique id of this window instance for BroadcastChannel messages. */
export const thisWindowId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Starts main-window coordination with detached tab windows: listens for
 * detached/closed/dock messages and pings any already-open detached windows. */
export function initMainWindowSync(opts: { onDock: (m: string, pane: string) => void }): () => void {
  const ch = openChannel();
  if (!ch) return () => {};
  const onMsg = (ev: MessageEvent<WindowMsg>) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'detached') {
      const initialPane = msg.initialPane || msg.panes[0];
      useDetachedTabs.setState((s) => ({
        records: { ...s.records, [msg.winId]: { winId: msg.winId, m: msg.m, initialPane, panes: msg.panes } },
      }));
    } else if (msg.type === 'closed') {
      useDetachedTabs.setState((s) => {
        if (!s.records[msg.winId]) return s;
        const next = { ...s.records };
        delete next[msg.winId];
        return { records: next };
      });
    } else if (msg.type === 'dock') {
      useDetachedTabs.setState((s) => {
        if (!s.records[msg.winId]) return s;
        const next = { ...s.records };
        delete next[msg.winId];
        return { records: next };
      });
      opts.onDock(msg.m, msg.pane);
    }
  };
  ch.addEventListener('message', onMsg);
  ch.postMessage({ type: 'ping' } satisfies WindowMsg);
  return () => {
    ch.removeEventListener('message', onMsg);
    ch.close();
  };
}

/** Starts detached-window coordination: announces this window's tab panes,
 * answers pings from the main window, and handles focus, dockAll, and
 * cross-window close confirmation requests. */
export function initDetachedWindowSync(opts: {
  m: string;
  initialPane: string;
  getPanes: () => string[];
  getWorkspace: () => string | undefined;
  onDockAll: () => void;
  onConfirmClose?: () => Promise<boolean>;
}): { announce: () => void; notifyClosed: () => void; notifyDock: (pane: string) => void; dispose: () => void } {
  const ch = openChannel();
  const announce = () => {
    const panes = opts.getPanes();
    if (panes.length) post({ type: 'detached', winId: thisWindowId, m: opts.m, initialPane: opts.initialPane, panes });
  };
  const notifyClosed = () => post({ type: 'closed', winId: thisWindowId });
  const notifyDock = (pane: string) => post({ type: 'dock', winId: thisWindowId, m: opts.m, pane });
  const onMsg = (ev: MessageEvent<WindowMsg>) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') announce();
    else if (msg.type === 'focus' && msg.winId === thisWindowId) window.focus();
    else if (msg.type === 'dockAll') {
      if (msg.m && msg.m !== opts.m) return;
      if (msg.ws && msg.ws !== opts.getWorkspace()) return;
      opts.onDockAll();
    } else if (msg.type === 'confirmClose' && msg.winId === thisWindowId) {
      post({ type: 'confirmCloseAck', reqId: msg.reqId, winId: thisWindowId });
      void (opts.onConfirmClose ? opts.onConfirmClose() : Promise.resolve(true))
        .then((ok) => post({ type: 'confirmCloseReply', reqId: msg.reqId, winId: thisWindowId, ok }))
        .catch(() => post({ type: 'confirmCloseReply', reqId: msg.reqId, winId: thisWindowId, ok: false }));
    }
  };
  ch?.addEventListener('message', onMsg);
  announce();
  return {
    announce,
    notifyClosed,
    notifyDock,
    dispose: () => {
      ch?.removeEventListener('message', onMsg);
      ch?.close();
    },
  };
}

/** Coordinates an unsaved-changes check with any detached window hosting one
 * of `panes` on machine `m` before the main window removes those tabs from the
 * layout (e.g. closeWorkspaces / closeTabs). Returns false if any detached
 * window's user cancels the confirmation. */
export async function confirmDetachedTabs(m: string, panes: readonly string[], ackTimeoutMs = 1500): Promise<boolean> {
  const paneSet = new Set(panes);
  const affected = Object.values(useDetachedTabs.getState().records).filter((r) => r.m === m && r.panes.some((p) => paneSet.has(p)));
  if (!affected.length) return true;
  const ch = openChannel();
  if (!ch) return true;
  try {
    for (const rec of affected) {
      const ok = await confirmOneDetached(ch, rec, ackTimeoutMs);
      if (!ok) return false;
    }
    return true;
  } finally {
    ch.close();
  }
}

function confirmOneDetached(ch: BroadcastChannel, rec: DetachedRecord, ackTimeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const reqId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let acked = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      ch.removeEventListener('message', onMsg);
      resolve(ok);
    };
    const onMsg = (ev: MessageEvent<WindowMsg>) => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'confirmCloseAck' && msg.reqId === reqId && msg.winId === rec.winId) {
        acked = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      } else if (msg.type === 'confirmCloseReply' && msg.reqId === reqId && msg.winId === rec.winId) {
        finish(msg.ok);
      } else if (msg.type === 'closed' && msg.winId === rec.winId) {
        finish(true);
      }
    };
    ch.addEventListener('message', onMsg);
    timer = setTimeout(() => {
      if (!acked) {
        useDetachedTabs.setState((s) => {
          if (!s.records[rec.winId]) return s;
          const next = { ...s.records };
          delete next[rec.winId];
          return { records: next };
        });
        finish(true);
      }
    }, ackTimeoutMs);
    ch.postMessage({ type: 'confirmClose', reqId, winId: rec.winId } satisfies WindowMsg);
  });
}

/** Asks all detached windows (optionally filtered to one machine/workspace)
 * to dock their tabs back into the main window without closing them. */
export function requestDockAll(m?: string, ws?: string) {
  post({ type: 'dockAll', m, ws });
}

/** Focuses an already-open detached window by its winId. */
export function focusDetachedWindow(winId: string) {
  post({ type: 'focus', winId });
}

/** Brings an already-open detached window to the front using its stable
 * initialPane key so desktop never spawns a duplicate window after splits or
 * focus changes inside the detached tab. */
export async function focusDetachedRecord(rec: DetachedRecord, title?: string): Promise<boolean> {
  focusDetachedWindow(rec.winId);
  if (desktopShell?.windows) {
    const targetPane = rec.initialPane || rec.panes[0];
    if (targetPane) {
      return await desktopShell.windows.openTab({ m: rec.m, pane: targetPane, title });
    }
  }
  return true;
}

/** Registered by DetachedTabApp so PaneActions, Palette and paneDrag can dock
 * the current standalone window back to the main window. */
let dockHandler: (() => void) | undefined;
export function setDockHandler(fn: (() => void) | undefined) {
  dockHandler = fn;
}

/** Docks the current detached tab window back into the main window. */
export function dockCurrentTab() {
  dockHandler?.();
}

/** Registered by DetachedTabApp so actions.current() resolves to this detached
 * window's own tab instead of the shared layout's selected workspace/tab. */
let detachedCurrentGetter: (() => DetachedCurrent | undefined) | undefined;
export function setDetachedCurrentGetter(fn: (() => DetachedCurrent | undefined) | undefined) {
  detachedCurrentGetter = fn;
}

export function getDetachedCurrent(): DetachedCurrent | undefined {
  return detachedCurrentGetter?.();
}

/** Registered by DetachedTabApp so tab.close closes this detached window
 * cleanly after confirming unsaved changes and removing its tab. */
let detachedCloseHandler: (() => void) | undefined;
export function setDetachedCloseHandler(fn: (() => void) | undefined) {
  detachedCloseHandler = fn;
}

export function closeDetachedWindow() {
  detachedCloseHandler?.();
}

/** Opens a tab in a standalone core-pane-only window (Electron BrowserWindow
 * in the desktop app, or a popup window in browsers). Confirms any unsaved
 * editor edits before detaching so edits are never lost across window
 * transitions, and selects a remaining visible tab in the main window when one
 * exists. */
export async function openDetachedTab(
  m: string,
  wsId: string,
  index: number,
  opts: { screenX?: number; screenY?: number; width?: number; height?: number; title?: string } = {},
): Promise<boolean> {
  const layout = terms.layout(m);
  const ws = layout?.workspaces.find((w) => w.id === wsId);
  const tab = ws?.tabs[index];
  if (!ws || !tab) return false;
  const panes = L.tabPanes(tab);
  const pane = tab.focused || panes[0];
  if (!pane) return false;

  // If already detached, just bring that window forward using its stable key.
  const existing = detachedRecordForTab(m, tab);
  if (existing) {
    return await focusDetachedRecord(existing, opts.title);
  }

  // Confirm unsaved edits in this tab before opening a separate window where
  // editors load fresh from disk.
  if (!(await confirmUnsaved(m, panes))) return false;

  // Re-read layout in case tabs changed while the unsaved dialog was open.
  const liveLayout = terms.layout(m);
  const liveWs = liveLayout?.workspaces.find((w) => w.id === wsId);
  const liveTab = liveWs?.tabs[index];
  if (!liveWs || !liveTab) return false;
  const livePanes = L.tabPanes(liveTab);
  const livePane = liveTab.focused || livePanes[0];
  if (!livePane) return false;
  const liveExisting = detachedRecordForTab(m, liveTab);
  if (liveExisting) {
    return await focusDetachedRecord(liveExisting, opts.title);
  }

  const width = opts.width ?? DETACHED_WIDTH;
  const height = opts.height ?? DETACHED_HEIGHT;
  const x = typeof opts.screenX === 'number' ? Math.round(opts.screenX - width / 2) : undefined;
  const y = typeof opts.screenY === 'number' ? Math.round(opts.screenY - 24) : undefined;

  let opened = false;
  if (desktopShell?.windows) {
    opened = await desktopShell.windows.openTab({ m, pane: livePane, x, y, width, height, title: opts.title });
  } else {
    const parts = [`popup`, `width=${width}`, `height=${height}`];
    if (x !== undefined) parts.push(`left=${Math.max(0, x)}`);
    if (y !== undefined) parts.push(`top=${Math.max(0, y)}`);
    const win = window.open(detachedTabUrl(m, livePane), `${APP_SLUG}-tab-${m}-${livePane}`, parts.join(','));
    if (win) {
      win.focus();
      opened = true;
    } else {
      useStore.getState().toast(t('window.popupBlocked'), undefined, undefined, 'warning');
    }
  }

  if (opened && liveWs.tabs.length > 1) {
    const records = useDetachedTabs.getState().records;
    const nextIdx = liveWs.tabs.findIndex((tb, i) => i !== index && !detachedRecordForTab(m, tb, records));
    if (nextIdx >= 0 && liveWs.selected === index) {
      terms.mutate(m, (l) => L.selectTab(l, wsId, nextIdx));
    }
  }
  return opened;
}
