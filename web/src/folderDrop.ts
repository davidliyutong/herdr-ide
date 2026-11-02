// Folders dropped from Finder on the desktop app's sidebar become workspaces
// on the local machine, one per folder, as if created in the new workspace
// dialog. The core runs on the same Mac, so a dropped folder's path is valid
// there. Browsers never tell a page where a dropped file is; the desktop
// shell's bridge does (webUtils.getPathForFile), so only the app offers this.

import { actions } from './actions';
import { desktopShell } from './desktop';
import { t } from './i18n';
import type { MachineState } from './lib/herdr';
import { useStore } from './state/store';

/** Whether a drag carries files from outside the page. */
export function carriesFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files');
}

/** The machine dropped folders become workspaces on: the local one, in the
 * desktop app and not in read-only mode. */
export function folderDropTarget(): MachineState | undefined {
  const s = useStore.getState();
  if (!desktopShell?.pathForFile || s.readOnly) return undefined;
  return Object.values(s.machines).find((m) => m.kind === 'local');
}

/** The dropped folders' paths, and how many other items were dropped. It
 * must run during the drop event: the items are empty after it. */
export function droppedFolders(items: ArrayLike<DataTransferItem>, pathOf: (f: File) => string): { folders: string[]; others: number } {
  const folders: string[] = [];
  let others = 0;
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    const path = file ? pathOf(file) : '';
    if (path && item.webkitGetAsEntry?.()?.isDirectory) folders.push(path);
    else others++;
  }
  return { folders, others };
}

/** Creates a workspace on the local machine for each folder dropped. */
export async function dropFolders(dt: DataTransfer) {
  const local = folderDropTarget();
  if (!local || !desktopShell) return;
  const shell = desktopShell;
  const { folders, others } = droppedFolders(dt.items, (f) => shell.pathForFile(f));
  if (others) useStore.getState().toast(t('sidebar.dropFoldersOnly', { n: others }));
  for (const cwd of folders) await actions.newWorkspace(local.id, cwd);
}
