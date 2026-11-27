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

/** Client-side route served by index.html for a standalone tab window. */
export const DETACHED_TAB_PATH = '/window/tab';

/** Default size of a newly opened standalone tab window. */
export const DETACHED_WIDTH = 1040;
export const DETACHED_HEIGHT = 720;

export interface DetachedTarget {
  m: string;
  pane: string;
}

export interface DetachedRecord {
  winId: string;
  m: string;
  panes: string[];
}

type WindowMsg =
  | { type: 'detached'; winId: string; m: string; panes: string[] }
  | { type: 'closed'; winId: string }
  | { type: 'ping' }
  | { type: 'dock'; winId: string; m: string; pane: string }
  | { type: 'focus'; winId: string }
  | { type: 'dockAll'; m?: string; ws?: string };

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
      useDetachedTabs.setState((s) => ({
        records: { ...s.records, [msg.winId]: { winId: msg.winId, m: msg.m, panes: msg.panes } },
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
 * answers pings from the main window, and handles focus / dockAll requests. */
export function initDetachedWindowSync(opts: {
  m: string;
  getPanes: () => string[];
  getWorkspace: () => string | undefined;
  onDockAll: () => void;
}): { announce: () => void; notifyClosed: () => void; notifyDock: (pane: string) => void; dispose: () => void } {
  const ch = openChannel();
  const announce = () => {
    const panes = opts.getPanes();
    if (panes.length) post({ type: 'detached', winId: thisWindowId, m: opts.m, panes });
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

/** Asks all detached windows (optionally filtered to one machine/workspace)
 * to dock their tabs back into the main window without closing them. */
export function requestDockAll(m?: string, ws?: string) {
  post({ type: 'dockAll', m, ws });
}

/** Focuses an already-open detached window by its winId. */
export function focusDetachedWindow(winId: string) {
  post({ type: 'focus', winId });
}

/** Registered by DetachedTabApp so PaneActions and paneDrag can dock the
 * current standalone window back to the main window. */
let dockHandler: (() => void) | undefined;
export function setDockHandler(fn: (() => void) | undefined) {
  dockHandler = fn;
}

/** Docks the current detached tab window back into the main window. */
export function dockCurrentTab() {
  dockHandler?.();
}

/** Opens a tab in a standalone core-pane-only window (Electron BrowserWindow
 * in the desktop app, or a popup window in browsers). Selects a remaining
 * visible tab in the main window when one exists. */
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

  // If already detached, just bring that window forward.
  const existing = detachedRecordForTab(m, tab);
  if (existing) {
    focusDetachedWindow(existing.winId);
    if (desktopShell?.windows) {
      await desktopShell.windows.openTab({ m, pane, title: opts.title });
    }
    return true;
  }

  const width = opts.width ?? DETACHED_WIDTH;
  const height = opts.height ?? DETACHED_HEIGHT;
  const x = typeof opts.screenX === 'number' ? Math.round(opts.screenX - width / 2) : undefined;
  const y = typeof opts.screenY === 'number' ? Math.round(opts.screenY - 24) : undefined;

  let opened = false;
  if (desktopShell?.windows) {
    opened = await desktopShell.windows.openTab({ m, pane, x, y, width, height, title: opts.title });
  } else {
    const parts = [`popup`, `width=${width}`, `height=${height}`];
    if (x !== undefined) parts.push(`left=${Math.max(0, x)}`);
    if (y !== undefined) parts.push(`top=${Math.max(0, y)}`);
    const win = window.open(detachedTabUrl(m, pane), `${APP_SLUG}-tab-${m}-${pane}`, parts.join(','));
    if (win) {
      win.focus();
      opened = true;
    } else {
      useStore.getState().toast(t('window.popupBlocked'), undefined, undefined, 'warning');
    }
  }

  if (opened && ws.tabs.length > 1) {
    const records = useDetachedTabs.getState().records;
    const nextIdx = ws.tabs.findIndex((tb, i) => i !== index && !detachedRecordForTab(m, tb, records));
    if (nextIdx >= 0 && ws.selected === index) {
      terms.mutate(m, (l) => L.selectTab(l, wsId, nextIdx));
    }
  }
  return opened;
}
