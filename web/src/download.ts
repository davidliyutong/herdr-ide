// Downloading files and directories of a machine into the browser
// (docs/features/06-quick-look-and-files.md): from a pane's menu (a path
// under the pointer, or entries chosen in the pane's directory) and from
// VS Code's explorer through the bridge. The core streams one file as
// itself and anything else as a zip the agent makes on the fly.

import { desktopShell } from './desktop';
import { downloadUrl } from './lib/files';
import { useStore } from './state/store';
import { t } from './i18n';

/** Whether files of machine m can be downloaded from this page: not the
 * desktop app's own machine, whose files are already on this computer. */
export function canDownload(m: string): boolean {
  return !(desktopShell && useStore.getState().machines[m]?.kind === 'local');
}

/** Starts the browser's download of paths of machine m. The response names
 * the file; a same-origin link keeps the transfer in the browser's own
 * downloads (and the desktop app's save dialog), with no copy in memory. */
export function startDownload(m: string, paths: string[]) {
  if (paths.length === 0) return;
  const a = document.createElement('a');
  a.href = downloadUrl(m, paths);
  a.download = '';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Downloads a path found in a pane's text, which may name nothing on the
 * machine: it is checked first, so a typo becomes a note instead of a failed
 * download. */
export async function downloadPath(m: string, path: string) {
  const name = path.split('/').pop() || path;
  try {
    const r = await fetch(downloadUrl(m, [path]), { method: 'HEAD' });
    if (!r.ok) throw new Error(r.status === 404 ? 'not found' : r.statusText || `HTTP ${r.status}`);
  } catch (e) {
    useStore.getState().toast(t('download.failed', { name, error: (e as Error).message }));
    return;
  }
  startDownload(m, [path]);
}

/** VS Code's explorer asked for a download (bridge.download). Every page
 * hears it; the one embedding that VS Code has the focus. */
export function bridgeDownload(m: string, paths: string[]) {
  if (!Array.isArray(paths) || !document.hasFocus()) return;
  startDownload(
    m,
    paths.filter((p) => typeof p === 'string'),
  );
}
