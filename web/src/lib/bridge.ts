// Commands for the VS Code bridge extension running inside code-server on a
// machine. The core routes them to a code-server window showing the folder.

import { currentDock, dockKey, normFolder, useStore, type DockView, type UIState } from '../state/store';
import type { Pane } from './herdr';

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
      const f = s.focused;
      const p = f && f.m === m ? s.machines[m]?.snapshot?.panes.find((x) => x.pane_id === f.pane) : undefined;
      const cwd = p?.foreground_cwd || p?.cwd || undefined;
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

function bestAgent(panes: Pane[]): string | undefined {
  const agents = panes.filter((p) => p.agent);
  return agents.find((p) => p.agent_status === 'idle' || p.agent_status === 'done')?.pane_id ?? agents[0]?.pane_id;
}

/** The pane that text sent from a VS Code window of machine m ("Send to
 * agent") goes to. With the window's folders known, the workspace whose
 * panel shows that window decides: the focused pane when it is the selected
 * workspace and the pane is on m, else that workspace's most
 * attention-worthy agent pane. Otherwise the focused pane on m, else m's most
 * attention-worthy agent pane anywhere. */
export function sendTarget(s: UIState, m: string, folders?: string[]): string | undefined {
  const panes = s.machines[m]?.snapshot?.panes ?? [];
  const focused = s.focused?.m === m ? s.focused.pane : undefined;
  if (folders) {
    const here = showsWindow(s.docks[dockKey(s)]?.view, m, folders);
    const other = here ? undefined : Object.entries(s.docks).find(([k, d]) => k && d.m === m && showsWindow(d.view, m, folders))?.[1];
    const ws = here ? (s.machineId === m ? s.workspaceId : undefined) : other?.ws;
    if (here && focused) return focused;
    const inWs = ws ? bestAgent(panes.filter((p) => p.workspace_id === ws)) : undefined;
    if (inWs) return inWs;
  }
  return focused ?? bestAgent(panes);
}
