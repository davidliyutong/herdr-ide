// Commands for the VS Code bridge extension running inside code-server on a
// machine. The core routes them to a code-server window showing the folder.

import { currentDock, dockKey, normFolder, useStore, type DockView, type UIState } from '../state/store';
import { useTerms, type MachineTerms } from '../state/terms';
import * as L from '../term/layout';
import { agentOf, agentStatus } from './machine';

export interface BridgeCommand {
  cmd: 'openFile' | 'openDiff' | 'gitGraph' | 'openMedia' | 'reveal';
  path?: string;
  repo?: string;
  line?: number;
  col?: number;
}

async function post(m: string, folder: string | undefined, c: BridgeCommand): Promise<void> {
  const r = await fetch(`/api/m/${encodeURIComponent(m)}/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...c, folder }),
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
}

function dirname(p: string) {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '/';
}

export const bridge = {
  command: (m: string, folder: string | undefined, c: BridgeCommand) => post(m, folder, c),

  /** Open a file in the selected workspace's VS Code panel: its folder when
   * the file lives below it, else the focused pane's cwd when it does, else
   * the file's directory. The core sends the command to the window showing
   * that folder. */
  openFile(m: string, path: string, line?: number, col?: number) {
    const s = useStore.getState();
    const dock = currentDock(s);
    let folder = dock?.kind === 'code' && dock.m === m ? dock.folder : undefined;
    if (!folder || !path.startsWith(folder.replace(/\/$/, '') + '/')) {
      const layout = useTerms.getState().machines[m]?.layout;
      const focused = s.machineId === m && layout ? L.focusedTerminal(layout) : undefined;
      const cwd = focused ? directory(useTerms.getState().machines[m], focused) : undefined;
      folder = cwd && path.startsWith(cwd.replace(/\/$/, '') + '/') ? cwd : dirname(path);
    }
    s.openDock({ kind: 'code', m, folder });
    return post(m, folder, { cmd: 'openFile', path, line, col });
  },
};

/** Whether a dock view shows the VS Code window of machine m that has these
 * workspace folders. A panel opened without a folder shows whatever folder
 * code-server opened, so it matches any window of the machine. */
function showsWindow(v: DockView | undefined, m: string, folders: string[]) {
  if (v?.kind !== 'code' || v.m !== m) return false;
  return !v.folder || folders.some((f) => normFolder(f) === v.folder);
}

/** A terminal's directory: its foreground program's, else where it started. */
function directory(mt: MachineTerms | undefined, address: string): string | undefined {
  const r = mt?.terminals[address];
  const fg = r?.foreground as { cwd?: unknown } | undefined;
  const cwd = typeof fg?.cwd === 'string' && fg.cwd ? fg.cwd : r?.cwd;
  return typeof cwd === 'string' && cwd ? cwd : undefined;
}

/** The agent terminal text goes to among some: one waiting for input
 * (idle or done), else any agent. */
function bestAgent(mt: MachineTerms | undefined, addresses: string[]): string | undefined {
  const agents = addresses.filter((a) => agentOf(mt?.terminals[a]));
  return agents.find((a) => ['idle', 'done'].includes(agentStatus(mt?.terminals[a]) ?? '')) ?? agents[0];
}

/** Where text sent from a VS Code window of machine m ("Send to agent")
 * goes: a terminal, or none (workspace: the workspace showing the window,
 * which has no agent). */
export interface SendTarget {
  terminal?: string;
  workspace?: string;
}

/** The terminal that text sent from a VS Code window of machine m goes to.
 * With the window's folders known, the workspace whose panel shows that
 * window decides: the focused terminal when it is the selected workspace,
 * else that workspace's agent waiting for input, and no terminal of another
 * workspace (another project's agent) when it has none. Without such a
 * workspace (the window is unknown, or no panel shows it): the focused
 * terminal on m, else m's agent waiting for input. */
export function sendTarget(s: UIState, m: string, folders?: string[]): SendTarget {
  const mt = useTerms.getState().machines[m];
  const layout = mt?.layout;
  const focused = s.machineId === m && layout ? L.focusedTerminal(layout) : undefined;
  if (folders) {
    const here = showsWindow(s.docks[dockKey(s)]?.view, m, folders);
    const other = here ? undefined : Object.entries(s.docks).find(([k, d]) => k && d.m === m && showsWindow(d.view, m, folders))?.[1];
    const ws = here ? (s.machineId === m ? s.workspaceId : undefined) : other?.ws;
    if (here && focused) return { terminal: focused };
    if (ws) {
      const w = layout?.workspaces.find((x) => x.id === ws);
      const inWs = bestAgent(mt, w ? L.workspaceTerminals(w) : []);
      return inWs ? { terminal: inWs } : { workspace: ws };
    }
  }
  const terminal = focused ?? bestAgent(mt, layout ? L.layoutTerminals(layout) : Object.keys(mt?.terminals ?? {}));
  return terminal ? { terminal } : {};
}
