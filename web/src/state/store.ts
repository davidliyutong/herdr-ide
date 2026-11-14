import { create } from 'zustand';
import { withOrder, type MachineState, type Pane, type Snapshot, type Tab, type Workspace } from '../lib/herdr';
import { storage } from '../brand';

export interface PaneRef {
  m: string;
  pane: string;
}

/** Something being renamed in place (pane title, tab, workspace or one of
 * herdr's saved machines, whose id is the machine's). */
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

export interface Toast {
  id: number;
  msg: string;
  action?: ToastAction;
}

export type DockView =
  { kind: 'preview'; m: string; path: string } | { kind: 'code'; m: string; folder?: string } | { kind: 'agent'; m: string; pane: string };

export type CodeView = Extract<DockView, { kind: 'code' }>;

/** What one workspace shows in the dock beside its panes: each workspace
 * has its own, so several VS Code windows (machines or folders) stay open
 * and switching workspace switches the panel (docs/features/05). */
export interface WorkspaceDock {
  m: string;
  ws: string;
  view?: DockView;
  /** The VS Code panel this workspace showed last, which toggling the panel
   * shows again. */
  lastCode?: CodeView;
}

export interface UIState {
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
  /** Each workspace's dock by dockKey; read the selected workspace's with
   * currentDock and currentLastCode. */
  docks: Record<string, WorkspaceDock>;
  dockWidth: number;
  /** Height of the dock when it sits below the panes. */
  dockHeight: number;
  palette?: 'commands' | 'workspaces' | 'help';
  settingsOpen: boolean;
  renaming?: Renaming;
  toasts: Toast[];
  auth?: string;
  /** SSH machine whose herdr the remote update terminal updates. */
  remoteHerdr?: string;
  /** The terminal adding a machine with herdr machine add is open. */
  addMachine: boolean;
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
  /** Shows v (or nothing) in the selected workspace's dock. */
  openDock(v: DockView | undefined): void;
  /** Closes every workspace's VS Code panel of machine m (its code-server
   * was stopped). */
  closeCode(m: string): void;
  setDockWidth(w: number): void;
  setDockHeight(h: number): void;
  setPalette(p: UIState['palette']): void;
  openSettings(open: boolean): void;
  setRenaming(r: Renaming | undefined): void;
  /** Shows a toast for ttl ms (default: 5 s, 15 s with an action, or the
   * action's own) and returns its id. */
  toast(msg: string, action?: ToastAction, ttl?: number): number;
  openAuth(m?: string): void;
  openRemoteHerdr(m?: string): void;
  openAddMachine(open: boolean): void;
  setReadOnly(v: boolean): void;
}

let toastSeq = 0;

const wsKey = (m: string, ws: string) => `${m}|${ws}`;

/** The key of the selected workspace's dock; "" before one is selected. */
export function dockKey(s: Pick<UIState, 'machineId' | 'workspaceId'>): string {
  return s.machineId && s.workspaceId ? wsKey(s.machineId, s.workspaceId) : '';
}

/** What the selected workspace's dock shows. VS Code is not available in
 * read-only mode, so a VS Code panel kept from before shows nothing. */
export function currentDock(s: UIState): DockView | undefined {
  const v = s.docks[dockKey(s)]?.view;
  return v?.kind === 'code' && s.readOnly ? undefined : v;
}

/** The VS Code panel the selected workspace showed last. */
export function currentLastCode(s: UIState): CodeView | undefined {
  return s.docks[dockKey(s)]?.lastCode;
}

/** A workspace folder without a trailing slash, so one folder is one VS Code
 * window. */
export function normFolder(folder?: string): string | undefined {
  if (!folder) return undefined;
  return folder.length > 1 ? folder.replace(/\/+$/, '') || '/' : folder;
}

/** Docks that still have something to show, without the views and
 * workspaces that are gone: workspaces of machines that are not in machines
 * (when all is set: the list is complete) or not in their machine's
 * snapshot, and views of machines that are not there. */
function pruneDocks(docks: Record<string, WorkspaceDock>, machines: Record<string, MachineState>, all: boolean) {
  const out: Record<string, WorkspaceDock> = {};
  let changed = false;
  const gone = (m: string) => all && !machines[m];
  for (const [k, d] of Object.entries(docks)) {
    const snap = machines[d.m]?.snapshot;
    if (k && (gone(d.m) || (snap && !snap.workspaces.some((w) => w.workspace_id === d.ws)))) {
      changed = true;
      continue;
    }
    const view = d.view && gone(d.view.m) ? undefined : d.view;
    const lastCode = d.lastCode && gone(d.lastCode.m) ? undefined : d.lastCode;
    if (view === d.view && lastCode === d.lastCode) {
      out[k] = d;
      continue;
    }
    changed = true;
    if (view || lastCode) out[k] = { ...d, view, lastCode };
  }
  return changed ? out : docks;
}

/** Workspace docks persist per browser; the one of no workspace does not. */
function saveDocks(docks: Record<string, WorkspaceDock>) {
  const keep: Record<string, WorkspaceDock> = {};
  for (const [k, d] of Object.entries(docks)) if (k) keep[k] = d;
  savePref('docks', keep);
}

function loadDocks(): Record<string, WorkspaceDock> {
  const raw = loadPref<Record<string, WorkspaceDock>>('docks', {});
  const out: Record<string, WorkspaceDock> = {};
  if (!raw || typeof raw !== 'object') return out;
  const kinds = ['code', 'preview'];
  const valid = (v?: DockView) => !v || (typeof v === 'object' && kinds.includes(v.kind) && typeof v.m === 'string');
  for (const [k, d] of Object.entries(raw)) {
    if (!d || typeof d.m !== 'string' || typeof d.ws !== 'string' || k !== wsKey(d.m, d.ws)) continue;
    if (!valid(d.view) || (d.lastCode && d.lastCode.kind !== 'code') || !valid(d.lastCode)) continue;
    out[k] = d;
  }
  return out;
}

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
  docks: loadDocks(),
  dockWidth: loadPref('dockWidth', 640),
  dockHeight: loadPref('dockHeight', 360),
  settingsOpen: false,
  toasts: [],

  setConnected: (connected) => set({ connected }),
  setMachines: (list) => {
    const machines: Record<string, MachineState> = {};
    for (const m of list) machines[m.id] = m;
    // A machine removed from herdr's catalog takes what showed it along.
    const { docks, focused } = get();
    const nextDocks = pruneDocks(docks, machines, true);
    if (nextDocks !== docks) saveDocks(nextDocks);
    set({
      machines,
      order: list.map((m) => m.id),
      docks: nextDocks,
      ...(focused && !machines[focused.m] ? { focused: undefined } : {}),
    });
    ensureSelection(set, get);
  },
  upsertMachine: (st) => {
    set((s) => {
      const machines = { ...s.machines, [st.id]: st };
      // A workspace closed in herdr takes its dock along.
      const docks = pruneDocks(s.docks, { [st.id]: st }, false);
      if (docks !== s.docks) saveDocks(docks);
      return { machines, docks, order: s.order.includes(st.id) ? s.order : [...s.order, st.id] };
    });
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
  openDock: (v) =>
    set((s) => {
      const k = dockKey(s);
      const view: DockView | undefined = v?.kind === 'code' ? { kind: 'code', m: v.m, folder: normFolder(v.folder) } : v;
      const prev = s.docks[k];
      const d: WorkspaceDock = {
        m: prev?.m ?? s.machineId ?? '',
        ws: prev?.ws ?? s.workspaceId ?? '',
        view,
        lastCode: view?.kind === 'code' ? view : prev?.lastCode,
      };
      const docks = { ...s.docks };
      if (d.view || d.lastCode) docks[k] = d;
      else delete docks[k];
      saveDocks(docks);
      return { docks };
    }),
  closeCode: (m) =>
    set((s) => {
      let changed = false;
      const docks: Record<string, WorkspaceDock> = {};
      for (const [k, d] of Object.entries(s.docks)) {
        if (d.view?.kind === 'code' && d.view.m === m) {
          changed = true;
          docks[k] = { ...d, view: undefined };
        } else docks[k] = d;
      }
      if (!changed) return {};
      saveDocks(docks);
      return { docks };
    }),
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
  openRemoteHerdr: (remoteHerdr) => set({ remoteHerdr }),
  addMachine: false,
  openAddMachine: (addMachine) => set({ addMachine }),
  readOnly: false,
  setReadOnly: (readOnly) => set({ readOnly }),
  toast: (msg, action, ttl) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, msg, action }] }));
    // A toast with an action waits longer for the click.
    if (!action?.sticky)
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), action?.ttl ?? ttl ?? (action ? 15000 : 5000));
    return id;
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
