import { create } from 'zustand';
import type { MachineState } from '../lib/machine';
import { storage } from '../brand';

/** A terminal of a machine's terminal core. */
export interface TermRef {
  m: string;
  terminal: string;
}

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

export interface Toast {
  id: number;
  msg: string;
  action?: ToastAction;
}

export type DockView =
  | { kind: 'preview'; m: string; path: string }
  | { kind: 'code'; m: string; folder?: string }
  | { kind: 'agent'; m: string; terminal: string };

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

export interface SettingsView {
  page?: string;
  machine?: string;
}

/** The sidebar's default width and the range it can be dragged in. */
export const SIDEBAR_WIDTH = { def: 260, min: 180, max: 520 };

export interface UIState {
  connected: boolean;
  order: string[];
  machines: Record<string, MachineState>;

  /** The machine shown. Its workspaces, tabs and focus are in its layout
   * document, shared with every client (state/terms.ts). */
  machineId?: string;
  /** The workspace the machine's layout selects, kept here for the docks. */
  workspaceId?: string;
  /** A terminal shown alone in its tab, per browser. */
  zoomed?: TermRef;

  sidebarOpen: boolean;
  /** Each workspace's dock by dockKey; read the selected workspace's with
   * currentDock and currentLastCode. */
  docks: Record<string, WorkspaceDock>;
  dockWidth: number;
  /** Height of the dock when it sits below the panes. */
  dockHeight: number;
  palette?: 'commands' | 'workspaces';
  /** The settings dialog when open: its page and scope (a machine's id, or
   * none for the user's settings). */
  settings?: SettingsView;
  /** The sidebar's width in pixels. */
  sidebarWidth: number;
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
  /** The core can hold an interactive ssh login (not on Windows, whose ssh
   * shares no connections): the sidebar offers Sign in. */
  sshLogin: boolean;

  setConnected(c: boolean): void;
  setMachines(list: MachineState[]): void;
  upsertMachine(st: MachineState): void;
  selectMachine(m: string): void;
  setWorkspace(ws: string | undefined): void;
  setZoomed(z: TermRef | undefined): void;
  toggleSidebar(): void;
  /** Shows v (or nothing) in the selected workspace's dock. */
  openDock(v: DockView | undefined): void;
  /** Closes every workspace's VS Code panel of machine m (its code-server
   * was stopped). */
  closeCode(m: string): void;
  /** Drops the docks of a machine's workspaces that are gone. */
  pruneDocks(m: string, workspaces: string[]): void;
  setDockWidth(w: number): void;
  setDockHeight(h: number): void;
  setPalette(p: UIState['palette']): void;
  /** Opens the settings dialog (on a page, in a scope), or closes it (false). */
  openSettings(view: SettingsView | false): void;
  setSidebarWidth(w: number): void;
  setRenaming(r: Renaming | undefined): void;
  /** Shows a toast for ttl ms (default: 5 s, 15 s with an action, or the
   * action's own) and returns its id. */
  toast(msg: string, action?: ToastAction, ttl?: number): number;
  openAuth(m?: string): void;
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

/** Docks without the views of machines that gone() says were removed. */
function withoutGone(docks: Record<string, WorkspaceDock>, gone: (m: string) => boolean) {
  const out: Record<string, WorkspaceDock> = {};
  let changed = false;
  for (const [k, d] of Object.entries(docks)) {
    if (k && gone(d.m)) {
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

export const useStore = create<UIState>((set, get) => ({
  connected: false,
  order: [],
  machines: {},
  sidebarOpen: loadPref('sidebarOpen', true),
  docks: loadDocks(),
  dockWidth: loadPref('dockWidth', 640),
  dockHeight: loadPref('dockHeight', 360),
  sidebarWidth: loadPref('sidebarWidth', SIDEBAR_WIDTH.def),
  toasts: [],

  setConnected: (connected) => set({ connected }),
  setMachines: (list) => {
    const machines: Record<string, MachineState> = {};
    for (const m of list) machines[m.id] = m;
    // A machine removed from the core takes what showed it along. Only one
    // this page saw go: a core started with fewer machines (as with
    // --local-only) leaves the others' docks for when they are back.
    const { docks, machines: prev } = get();
    const nextDocks = withoutGone(docks, (m) => !!prev[m] && !machines[m]);
    if (nextDocks !== docks) saveDocks(nextDocks);
    set({ machines, order: list.map((m) => m.id), docks: nextDocks });
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
  pruneDocks: (m, workspaces) =>
    set((s) => {
      const keep = new Set(workspaces);
      const gone = Object.entries(s.docks).filter(([k, d]) => k && d.m === m && !keep.has(d.ws));
      if (!gone.length) return {};
      const docks = { ...s.docks };
      for (const [k] of gone) delete docks[k];
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
  openSettings: (view) => set({ settings: view === false ? undefined : view }),
  setSidebarWidth: (w) => {
    const width = Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, w)));
    savePref('sidebarWidth', width);
    set({ sidebarWidth: width });
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
  sshLogin: true,
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

/** Keeps the shown machine one that exists: the one shown last, else the
 * local machine, else the first. */
function ensureSelection(set: Setter, get: () => UIState) {
  const s = get();
  if (s.machineId && s.machines[s.machineId]) return;
  const saved = loadPref<string | undefined>('machine', undefined);
  const id = [saved, ...s.order.filter((m) => s.machines[m]?.kind === 'local'), ...s.order].find((m) => m && s.machines[m]);
  if (id) set({ machineId: id, workspaceId: undefined });
}
