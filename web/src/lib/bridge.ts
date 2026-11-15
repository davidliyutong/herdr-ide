// The VS Code bridge (extensions/herdr-ide-bridge, docs/features/05): commands
// for the VS Code window of a pane, and where what a window sends (Send to
// Agent) goes. Each VS Code pane's iframe is a window of its own; the page
// names the window when it knows it (codeFrames.ts), asks for a fresh one
// for an iframe it has just made, and the core goes by folder otherwise.

import { useTerms, type MachineTerms } from '../state/terms';
import * as L from '../term/layout';
import { bindWindow, frameKey, frameOfWindow, framesShowing, useFrames, windowFocused } from '../codeFrames';
import { agentOf, agentStatus } from './machine';

export interface BridgeCommand {
  cmd: 'openFile' | 'openDiff' | 'gitGraph' | 'openMedia' | 'reveal';
  path?: string;
  repo?: string;
  line?: number;
  col?: number;
}

async function post(m: string, body: Record<string, unknown>): Promise<{ window?: string }> {
  const r = await fetch(`/api/m/${encodeURIComponent(m)}/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return r.json().catch(() => ({}));
}

/** Resolves with the window frame k shows once the page learns it (the
 * window reports the keyboard), or undefined after ms. */
function windowOf(k: string, ms: number): Promise<string | undefined> {
  const known = useFrames.getState().windows[k];
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(undefined);
    }, ms);
    const off = useFrames.subscribe((s) => {
      if (!s.windows[k]) return;
      clearTimeout(timer);
      off();
      resolve(s.windows[k]);
    });
  });
}

/** How long a command for a VS Code pane waits for the page to learn which
 * window the pane shows, once its iframe has the keyboard. */
export const WINDOW_WAIT_MS = 1500;

export const bridge = {
  /**
   * Runs a command in the VS Code window of a pane (view id of machine m,
   * showing folder). fresh: the pane was just opened, so its window is the
   * first of that folder to connect. Otherwise the pane's window when the
   * page knows it (or learns it once the pane has the keyboard), else the
   * window the core finds for the folder.
   */
  async command(m: string, id: string, folder: string, c: BridgeCommand, fresh: boolean): Promise<void> {
    const k = frameKey(m, id);
    const window = fresh ? undefined : await windowOf(k, WINDOW_WAIT_MS);
    const reply = await post(m, { ...c, folder, ...(window ? { window } : fresh ? { fresh: true } : {}) });
    // The window that took the command is the pane's when the page had to ask.
    if (reply.window && fresh) bindWindow(k, reply.window);
  },
};

/** Whether the page has a frame (an iframe, loaded or loading) for a view. */
export const hasFrame = (m: string, id: string) => !!useFrames.getState().frames[frameKey(m, id)];

/** The terminal of each workspace focused last on this page, by machine and
 * workspace: Send to Agent's choice when the workspace has no agent. */
const lastTerminals = new Map<string, string>();

/** Notes the terminal focused in a machine's selected tab. */
export function noteFocusedTerminal(m: string, layout: L.Layout) {
  const ws = L.selectedWorkspace(layout);
  const terminal = L.focusedTerminal(layout);
  if (ws && terminal) lastTerminals.set(`${m}|${ws.id}`, terminal);
}

/** The agent text goes to among some: one waiting for input (idle or done),
 * else any agent. */
function bestAgent(mt: MachineTerms | undefined, addresses: string[]): string | undefined {
  const agents = addresses.filter((a) => agentOf(mt?.terminals[a]));
  return agents.find((a) => ['idle', 'done'].includes(agentStatus(mt?.terminals[a]) ?? '')) ?? agents[0];
}

/** Where text sent from a VS Code window ("Send to Agent") goes: a
 * terminal, or none (workspace: the workspace of the sending pane, which has
 * no terminal to take it). */
export interface SendTarget {
  terminal?: string;
  workspace?: string;
}

/**
 * The VS Code pane (its frame) a window of machine m that sent something is
 * shown in on this page: the one known to show it; else, when this page has
 * the keyboard, the pane that has it (which then is known to show it), or
 * one showing the window's folders, those on screen first. Undefined when
 * the window is another page's.
 */
export function sendingFrame(m: string, window?: string, folders?: string[]): string | undefined {
  const known = window ? frameOfWindow(m, window) : undefined;
  if (known) return known;
  if (typeof document === 'undefined' || !document.hasFocus()) return undefined;
  if (window) {
    const k = windowFocused(m, window, folders);
    if (k) return k;
  }
  return folders ? framesShowing(m, folders)[0] : undefined;
}

/**
 * The terminal text sent from a VS Code window of machine m goes to, or
 * undefined when another page takes it (the window is not this page's and
 * this page does not have the keyboard). From a VS Code pane of this page:
 * the agents of the pane's tab, else of its workspace (those waiting for
 * input first), else the workspace's terminal focused last on this page;
 * no terminal of another workspace (another project's agent), so without
 * one the workspace is named. From a window of no pane (another page's that
 * this page does not know, or VS Code opened on its own): the focused
 * terminal on m, else m's agent waiting for input.
 */
export function sendTarget(m: string, window?: string, folders?: string[]): SendTarget | undefined {
  const mt = useTerms.getState().machines[m];
  const layout = mt?.layout;
  const k = sendingFrame(m, window, folders);
  const fr = k ? useFrames.getState().frames[k] : undefined;
  const at = fr && layout ? L.locate(layout, L.codeKey(fr.id)) : null;
  if (layout && at) {
    const ws = layout.workspaces[at.workspace];
    const last = lastTerminals.get(`${m}|${ws.id}`);
    const terminal =
      bestAgent(mt, L.tabTerminals(ws.tabs[at.tab])) ??
      bestAgent(mt, L.workspaceTerminals(ws)) ??
      (last && L.workspaceTerminals(ws).includes(last) ? last : undefined);
    return terminal ? { terminal } : { workspace: ws.id };
  }
  if (!k && (typeof document === 'undefined' || !document.hasFocus())) return undefined;
  const focused = layout ? L.focusedTerminal(layout) : undefined;
  const terminal = focused ?? bestAgent(mt, layout ? L.layoutTerminals(layout) : Object.keys(mt?.terminals ?? {}));
  return terminal ? { terminal } : {};
}
