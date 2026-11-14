// Windows of programs on machines (docs/features/14-gui-windows.md). The
// core sends each machine's display state; a window that appeared while
// this page was open is "unseen" until it is opened, and marked on its pane.

import { create } from 'zustand';
import { APP_SLUG } from '../brand';

export interface GuiWindow {
  id: number;
  title: string;
  w: number;
  h: number;
  pid?: number;
  /** herdr pane the program runs in, when it is in this machine's session. */
  pane?: string;
  /** The window this one is a dialog of. */
  transient?: number;
}

export type GuiPhase =
  'off' | 'local' | 'unsupported' | 'unavailable' | 'installing' | 'starting' | 'ready' | 'error' | 'not_running' | 'disconnected';

export interface GuiState {
  m: string;
  phase: GuiPhase;
  error?: string;
  gpu?: boolean;
  windows: GuiWindow[];
}

export const guiKey = (m: string, id: number) => `${m}|${id}`;

interface GuiStore {
  machines: Record<string, GuiState>;
  unseen: Record<string, true>;
  /** Machines whose display error the user dismissed; it shows again once
   * the display left the error phase and failed again. */
  dismissed: Record<string, true>;
  setState(st: GuiState): void;
  markSeen(m: string, id: number): void;
  dismiss(m: string): void;
}

export const useGui = create<GuiStore>((set) => ({
  machines: {},
  unseen: {},
  dismissed: {},
  setState: (st) =>
    set((s) => {
      const prev = s.machines[st.m];
      const unseen = { ...s.unseen };
      const ids = new Set(st.windows.map((w) => w.id));
      for (const k of Object.keys(unseen)) {
        const [m, id] = k.split('|');
        if (m === st.m && !ids.has(Number(id))) delete unseen[k];
      }
      // Windows present when the page loaded are not new.
      if (prev) {
        const before = new Set(prev.windows.map((w) => w.id));
        for (const w of st.windows) if (!before.has(w.id)) unseen[guiKey(st.m, w.id)] = true;
      }
      let dismissed = s.dismissed;
      if (st.phase !== 'error' && dismissed[st.m]) {
        dismissed = { ...dismissed };
        delete dismissed[st.m];
      }
      return { machines: { ...s.machines, [st.m]: st }, unseen, dismissed };
    }),
  dismiss: (m) => set((s) => ({ dismissed: { ...s.dismissed, [m]: true } })),
  markSeen: (m, id) =>
    set((s) => {
      const k = guiKey(m, id);
      if (!s.unseen[k]) return s;
      const unseen = { ...s.unseen };
      delete unseen[k];
      return { unseen };
    }),
}));

/** Windows of a pane, in the order they appeared. */
export function paneWindows(g: GuiStore, m: string, pane: string): GuiWindow[] {
  return (g.machines[m]?.windows ?? []).filter((w) => w.pane === pane);
}

export function guiUrl(m: string, id: number): string {
  return `/m/${encodeURIComponent(m)}/gui/${id}`;
}

/** Opens (or brings forward) the browser window showing a program window.
 * Returns false when the browser blocked the pop-up. */
export function openGuiWindow(m: string, w: GuiWindow): boolean {
  const win = window.open(
    guiUrl(m, w.id),
    `${APP_SLUG}-gui-${m}-${w.id}`,
    `popup,width=${Math.max(w.w, 240)},height=${Math.max(w.h, 160)}`,
  );
  if (!win) return false;
  win.focus();
  useGui.getState().markSeen(m, w.id);
  return true;
}

/** Parses a GUI window page path: /m/{machine}/gui/{window}. */
export function parseGuiPath(path: string): { m: string; id: number } | undefined {
  const r = /^\/m\/([^/]+)\/gui\/(\d+)\/?$/.exec(path);
  return r ? { m: decodeURIComponent(r[1]), id: Number(r[2]) } : undefined;
}
