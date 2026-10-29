// Commands for the VS Code bridge extension running inside code-server on a
// machine. The core routes them to a code-server window showing the folder.

import { useStore } from '../state/store';

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

  /** Open a file in the VS Code panel, choosing the focused pane's cwd as the
   * workspace folder when the file lives below it. */
  openFile(m: string, path: string, line?: number, col?: number) {
    const s = useStore.getState();
    const dock = s.dock;
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
