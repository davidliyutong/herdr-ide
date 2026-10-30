import { create } from 'zustand';
import { withOrder, type MachineState, type Pane, type Snapshot, type Tab, type Workspace } from '../lib/herdr';
import { storage } from '../brand';

export interface PaneRef {
  m: string;
  pane: string;
}

/** Something being renamed in place (pane title, tab or workspace). */
export interface Renaming {
  kind: 'pane' | 'tab' | 'workspace';
  m: string;
  id: string;
}

export type DockView =
  { kind: 'preview'; m: string; path: string } | { kind: 'code'; m: string; folder?: string } | { kind: 'agent'; m: string; pane: string };

interface UIState {
  connected: boolean;
  order: string[];
  machines: Record<string, MachineState>;

  // Local view selection; independent from herdr's focused workspace so
  // several clients (and the herdr TUI) can look at different things.
  machineId?: string;
  workspaceId?: string;
  tabByWorkspace: Record<string, string>;
  focused?: PaneRef;

  sidebarOpen: boolean;
  dock?: DockView;
  dockWidth: number;
  /** Height of the dock when it sits below the panes. */
  dockHeight: number;
  palette?: 'commands' | 'workspaces' | 'help';
  settingsOpen: boolean;
  renaming?: Renaming;
  toasts: { id: number; msg: string }[];
  auth?: string;
  /** The server runs with --read-only. */
  readOnly: boolean;

  setConnected(c: boolean): void;
  setMachines(list: MachineState[]): void;
  upsertMachine(st: MachineState): void;
  /** Applies herdr's answer to tab.move / workspace.move (the moved group in
   * its new order) until the next snapshot arrives. */
  setOrder(m: string, patch: { tabs?: Tab[]; workspaces?: Workspace[] }): void;
  selectWorkspace(m: string, ws: string): void;
  selectTab(m: string, ws: string, tab: string): void;
  focusPane(ref: PaneRef | undefined): void;
  toggleSidebar(): void;
  openDock(v: DockView | undefined): void;
  setDockWidth(w: number): void;
  setDockHeight(h: number): void;
  setPalette(p: UIState['palette']): void;
  openSettings(open: boolean): void;
  setRenaming(r: Renaming | undefined): void;
  toast(msg: string): void;
  openAuth(m?: string): void;
  setReadOnly(v: boolean): void;
}

let toastSeq = 0;

const wsKey = (m: string, ws: string) => `${m}|${ws}`;

function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = storage.get(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, v: unknown) {
  storage.set(key, JSON.stringify(v));
}

export const useStore = create<UIState>((set, get) => ({
  connected: false,
  order: [],
  machines: {},
  tabByWorkspace: {},
  sidebarOpen: loadPref('sidebarOpen', true),
  dockWidth: loadPref('dockWidth', 640),
  dockHeight: loadPref('dockHeight', 360),
  settingsOpen: false,
  toasts: [],

  setConnected: (connected) => set({ connected }),
  setMachines: (list) => {
    const machines: Record<string, MachineState> = {};
    for (const m of list) machines[m.id] = m;
    set({ machines, order: list.map((m) => m.id) });
    ensureSelection(set, get);
  },
  upsertMachine: (st) => {
    set((s) => ({
      machines: { ...s.machines, [st.id]: st },
      order: s.order.includes(st.id) ? s.order : [...s.order, st.id],
    }));
    ensureSelection(set, get);
  },
  setOrder: (m, patch) =>
    set((s) => {
      const st = s.machines[m];
      const snap = st?.snapshot;
      if (!snap) return {};
      const next = { ...snap };
      if (patch.tabs) next.tabs = withOrder(snap.tabs, (x) => x.tab_id, patch.tabs);
      if (patch.workspaces) next.workspaces = withOrder(snap.workspaces, (x) => x.workspace_id, patch.workspaces);
      return { machines: { ...s.machines, [m]: { ...st, snapshot: next } } };
    }),
  selectWorkspace: (m, ws) => {
    set({ machineId: m, workspaceId: ws });
    savePref('selection', { m, ws });
  },
  selectTab: (m, ws, tab) => set((s) => ({ machineId: m, workspaceId: ws, tabByWorkspace: { ...s.tabByWorkspace, [wsKey(m, ws)]: tab } })),
  focusPane: (focused) => set({ focused }),
  toggleSidebar: () => {
    const v = !get().sidebarOpen;
    savePref('sidebarOpen', v);
    set({ sidebarOpen: v });
  },
  openDock: (dock) => set({ dock }),
  setDockWidth: (w) => {
    savePref('dockWidth', w);
    set({ dockWidth: w });
  },
  setDockHeight: (h) => {
    savePref('dockHeight', h);
    set({ dockHeight: h });
  },
  setPalette: (palette) => set({ palette }),
  openSettings: (settingsOpen) => set({ settingsOpen }),
  setRenaming: (renaming) => set({ renaming }),
  openAuth: (auth) => set({ auth }),
  readOnly: false,
  setReadOnly: (readOnly) => set({ readOnly }),
  toast: (msg) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, msg }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5000);
  },
}));

type Setter = (p: Partial<UIState>) => void;

// Keep the selection pointing at something that exists.
function ensureSelection(set: Setter, get: () => UIState) {
  const s = get();
  const cur = s.machineId ? s.machines[s.machineId] : undefined;
  if (cur?.snapshot && s.workspaceId && cur.snapshot.workspaces.some((w) => w.workspace_id === s.workspaceId)) return;
  const saved = loadPref<{ m?: string; ws?: string }>('selection', {});
  const candidates = [saved.m, s.machineId, ...s.order].filter(Boolean) as string[];
  for (const id of candidates) {
    const snap = s.machines[id]?.snapshot;
    if (!snap || snap.workspaces.length === 0) continue;
    const ws =
      (id === saved.m && snap.workspaces.find((w) => w.workspace_id === saved.ws)) ||
      snap.workspaces.find((w) => w.workspace_id === snap.focused_workspace_id) ||
      snap.workspaces[0];
    set({ machineId: id, workspaceId: ws.workspace_id });
    return;
  }
}

export function activeTabId(s: UIState, m: string, snap: Snapshot, ws: string): string | undefined {
  const chosen = s.tabByWorkspace[wsKey(m, ws)];
  if (chosen && snap.tabs.some((t) => t.tab_id === chosen)) return chosen;
  const w = snap.workspaces.find((x) => x.workspace_id === ws);
  return w?.active_tab_id ?? snap.tabs.find((t) => t.workspace_id === ws)?.tab_id;
}

export function findPane(s: UIState, ref?: PaneRef): Pane | undefined {
  if (!ref) return undefined;
  return s.machines[ref.m]?.snapshot?.panes.find((p) => p.pane_id === ref.pane);
}
