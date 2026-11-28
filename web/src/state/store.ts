import { create } from 'zustand';
import type { MachineState } from '../lib/machine';
import { storage } from '../brand';

/** Something being renamed in place: a terminal's pane, a tab (id: the
 * workspace's id and the tab's index), a workspace, or an SSH machine. */
export interface Renaming {
  kind: 'pane' | 'tab' | 'workspace' | 'machine';
  m: string;
  id: string;
}

/** A button on a toast; the click also dismisses the toast. */
export interface ToastAction {
  label: string;
  run(): void;
  /** Stays until clicked or dismissed. */
  sticky?: boolean;
  /** Closes after this many milliseconds instead of the default. */
  ttl?: number;
}

/** How a toast looks: plain, or with the icon and bar of a warning or a
 * failure. Only these two have a color: most toasts report something done. */
export type ToastKind = 'info' | 'warning' | 'error';

export type ToastPosition = 'bottom-right' | 'bottom-left';

export interface Toast {
  id: number;
  msg: string;
  kind?: ToastKind;
  position?: ToastPosition;
  action?: ToastAction;
}

/** A pane shown alone in its tab: its machine and key (term/layout.ts paneKey). */
export interface PaneRef {
  m: string;
  pane: string;
}

export interface SettingsView {
  page?: string;
  machine?: string;
  /** A row of the page to bring into view. */
  row?: string;
}

/** The sidebar's default width and the range it can be dragged in. */
export const SIDEBAR_WIDTH = { def: 260, min: 180, max: 520 };
/** The right sidebar's (plugins' panels). */
export const PANEL_WIDTH = { def: 320, min: 220, max: 720 };

export interface UIState {
  connected: boolean;
  order: string[];
  machines: Record<string, MachineState>;

  /** The machine shown. Its workspaces, tabs and focus are in its layout
   * document, shared with every client (state/terms.ts). */
  machineId?: string;
  /** The workspace the machine's layout selects. */
  workspaceId?: string;
  /** A pane shown alone in its tab, per browser. */
  zoomed?: PaneRef;

  sidebarOpen: boolean;
  palette?: 'commands' | 'workspaces';
  /** The settings dialog when open: its page and scope (a machine's id, or
   * none for the user's settings). */
  settings?: SettingsView;
  /** The sidebar's width in pixels. */
  sidebarWidth: number;
  /** The panel the right sidebar shows (web/src/plugins), none while it is hidden. */
  panel?: string;
  /** The last panel shown, which showing the right sidebar again brings back. */
  lastPanel?: string;
  panelWidth: number;
  renaming?: Renaming;
  toasts: Toast[];
  auth?: string;
  /** Machines with a terminal core action (start, stop, restart) under way. */
  hcBusy: Record<string, true>;
  setHcBusy(m: string, busy: boolean): void;
  /** The add-machine dialog is open. */
  addMachine: boolean;
  /** The server runs with --read-only. */
  readOnly: boolean;
  /** The hub can hold an interactive ssh login (not on Windows, whose ssh
   * shares no connections): the sidebar offers Sign in. */
  sshLogin: boolean;

  setConnected(c: boolean): void;
  setMachines(list: MachineState[]): void;
  upsertMachine(st: MachineState): void;
  selectMachine(m: string): void;
  setWorkspace(ws: string | undefined): void;
  setZoomed(z: PaneRef | undefined): void;
  toggleSidebar(): void;
  setPalette(p: UIState['palette']): void;
  /** Opens the settings dialog (on a page, in a scope), or closes it (false). */
  openSettings(view: SettingsView | false): void;
  setSidebarWidth(w: number): void;
  /** Shows a panel in the right sidebar, or hides it (undefined). */
  setPanel(id: string | undefined): void;
  setPanelWidth(w: number): void;
  setRenaming(r: Renaming | undefined): void;
  /** Shows a toast for ttl ms (default: 5 s, 15 s with an action, or the
   * action's own) and returns its id. */
  toast(msg: string, action?: ToastAction, ttl?: number, kind?: ToastKind, position?: ToastPosition): number;
  openAuth(m?: string): void;
  openAddMachine(open: boolean): void;
  /** Status bar widget ids hidden in this browser. */
  hiddenStatusWidgets: string[];
  setStatusWidgetVisible(id: string, visible: boolean): void;
  toggleStatusWidget(id: string): void;
  showAllStatusWidgets(): void;
  /** Right sidebar rail panel order (ids) and hidden panel ids in this browser
   * (independent of enabling/disabling plugins). */
  railOrder: string[];
  hiddenRailPanels: string[];
  setRailOrder(order: string[]): void;
  setRailPanelVisible(id: string, visible: boolean): void;
  toggleRailPanel(id: string): void;
  showAllRailPanels(): void;
  resetRailOrder(): void;
  setReadOnly(v: boolean): void;
}

let toastSeq = 0;

/** What earlier versions kept in the browser for the VS Code panel beside
 * the panes, which VS Code panes replaced: dropped once. */
const DROPPED_PREFS = ['docks', 'dockWidth', 'dockHeight'];

function dropOldPrefs() {
  try {
    for (const key of DROPPED_PREFS) storage.remove(key);
  } catch {
    /* no storage */
  }
}

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = storage.get(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, v: unknown) {
  storage.set(key, JSON.stringify(v));
}

dropOldPrefs();

export const useStore = create<UIState>((set, get) => ({
  connected: false,
  order: [],
  machines: {},
  sidebarOpen: loadPref('sidebarOpen', true),
  sidebarWidth: loadPref('sidebarWidth', SIDEBAR_WIDTH.def),
  panel: loadPref<string | null>('panel', null) ?? undefined,
  lastPanel: loadPref<string | null>('lastPanel', null) ?? undefined,
  panelWidth: loadPref('panelWidth', PANEL_WIDTH.def),
  hiddenStatusWidgets: loadPref<string[]>('hiddenStatusWidgets', []),
  railOrder: loadPref<string[]>('railOrder', []),
  hiddenRailPanels: loadPref<string[]>('hiddenRailPanels', []),
  toasts: [],

  setConnected: (connected) => set({ connected }),
  setMachines: (list) => {
    const machines: Record<string, MachineState> = {};
    for (const m of list) machines[m.id] = m;
    set({ machines, order: list.map((m) => m.id) });
    ensureSelection(set, get);
  },
  upsertMachine: (st) => {
    set((s) => ({ machines: { ...s.machines, [st.id]: st }, order: s.order.includes(st.id) ? s.order : [...s.order, st.id] }));
    ensureSelection(set, get);
  },
  selectMachine: (m) => {
    if (get().machineId === m) return;
    savePref('machine', m);
    set({ machineId: m, workspaceId: undefined });
  },
  setWorkspace: (workspaceId) => {
    if (get().workspaceId !== workspaceId) set({ workspaceId });
  },
  setZoomed: (zoomed) => set({ zoomed }),
  toggleSidebar: () => {
    const v = !get().sidebarOpen;
    savePref('sidebarOpen', v);
    set({ sidebarOpen: v });
  },
  setPalette: (palette) => set({ palette }),
  openSettings: (view) => set({ settings: view === false ? undefined : view }),
  setSidebarWidth: (w) => {
    const width = Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, w)));
    savePref('sidebarWidth', width);
    set({ sidebarWidth: width });
  },
  setPanel: (panel) => {
    savePref('panel', panel ?? null);
    if (panel) savePref('lastPanel', panel);
    set(panel ? { panel, lastPanel: panel } : { panel: undefined });
  },
  setPanelWidth: (w) => {
    const width = Math.round(Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, w)));
    savePref('panelWidth', width);
    set({ panelWidth: width });
  },
  setRenaming: (renaming) => set({ renaming }),
  openAuth: (auth) => set({ auth }),
  hcBusy: {},
  setHcBusy: (m, busy) =>
    set((s) => {
      const hcBusy = { ...s.hcBusy };
      if (busy) hcBusy[m] = true;
      else delete hcBusy[m];
      return { hcBusy };
    }),
  addMachine: false,
  openAddMachine: (addMachine) => set({ addMachine }),
  readOnly: false,
  setReadOnly: (readOnly) => set({ readOnly }),
  setStatusWidgetVisible: (id, visible) => {
    const cur = get().hiddenStatusWidgets;
    const next = visible ? cur.filter((x) => x !== id) : cur.includes(id) ? cur : [...cur, id];
    if (next === cur) return;
    savePref('hiddenStatusWidgets', next);
    set({ hiddenStatusWidgets: next });
  },
  toggleStatusWidget: (id) => {
    const hidden = get().hiddenStatusWidgets.includes(id);
    get().setStatusWidgetVisible(id, hidden);
  },
  showAllStatusWidgets: () => {
    if (!get().hiddenStatusWidgets.length) return;
    savePref('hiddenStatusWidgets', []);
    set({ hiddenStatusWidgets: [] });
  },
  setRailOrder: (order) => {
    const next = [...new Set(order.filter((x) => typeof x === 'string' && x))];
    savePref('railOrder', next);
    set({ railOrder: next });
  },
  setRailPanelVisible: (id, visible) => {
    const cur = get().hiddenRailPanels;
    const next = visible ? cur.filter((x) => x !== id) : cur.includes(id) ? cur : [...cur, id];
    if (next === cur) return;
    savePref('hiddenRailPanels', next);
    set({ hiddenRailPanels: next });
  },
  toggleRailPanel: (id) => {
    const hidden = get().hiddenRailPanels.includes(id);
    get().setRailPanelVisible(id, hidden);
  },
  showAllRailPanels: () => {
    if (!get().hiddenRailPanels.length) return;
    savePref('hiddenRailPanels', []);
    set({ hiddenRailPanels: [] });
  },
  resetRailOrder: () => {
    if (!get().railOrder.length) return;
    savePref('railOrder', []);
    set({ railOrder: [] });
  },
  sshLogin: true,
  toast: (msg, action, ttl, kind, position) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, msg, action, kind, position }] }));
    // A toast with an action waits longer for the click.
    if (!action?.sticky)
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), action?.ttl ?? ttl ?? (action ? 15000 : 5000));
    return id;
  },
}));

type Setter = (p: Partial<UIState>) => void;

/** Orders items by saved railOrder (unknown ids stay in their natural order). */
export function orderRailItems<T extends { id: string }>(items: readonly T[], order: readonly string[]): T[] {
  if (!order.length) return [...items];
  const rank = new Map(order.map((id, i) => [id, i]));
  return items
    .map((item, idx) => ({ item, idx, r: rank.get(item.id) ?? Infinity }))
    .sort((a, b) => a.r - b.r || a.idx - b.idx)
    .map((x) => x.item);
}

/** Moves `id` to insertion slot `slot` among `visibleIds`, preserving any hidden
 * ids from `fullOrder` in place relative to their neighbors. */
export function moveRailId(fullOrder: readonly string[], visibleIds: readonly string[], id: string, slot: number): string[] {
  const fromVis = visibleIds.indexOf(id);
  if (fromVis < 0) return [...fullOrder];
  const clamped = Math.max(0, Math.min(visibleIds.length, slot));
  if (clamped === fromVis || clamped === fromVis + 1) return [...fullOrder];
  const nextVis = visibleIds.filter((x) => x !== id);
  const insertAt = clamped > fromVis ? clamped - 1 : clamped;
  nextVis.splice(insertAt, 0, id);
  // Splice the reordered visible ids back into the slots they occupied in fullOrder.
  const visSet = new Set(visibleIds);
  let k = 0;
  const out = fullOrder.map((x) => (visSet.has(x) ? nextVis[k++]! : x));
  while (k < nextVis.length) out.push(nextVis[k++]!);
  return out;
}

/** Keeps the shown machine one that exists: the one shown last, else the
 * local machine, else the first. */
function ensureSelection(set: Setter, get: () => UIState) {
  const s = get();
  if (s.machineId && s.machines[s.machineId]) return;
  const saved = loadPref<string | undefined>('machine', undefined);
  const id = [saved, ...s.order.filter((m) => s.machines[m]?.kind === 'local'), ...s.order].find((m) => m && s.machines[m]);
  if (id) set({ machineId: id, workspaceId: undefined });
}
