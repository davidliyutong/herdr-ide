// Files dragged onto the page from outside it (Finder, the desktop).
//
// - On a pane, their paths are pasted into it, shell-quoted, as a terminal
//   does. Files of the pane's own machine are pasted where they are: in the
//   desktop app, those on the local machine, since the core runs on the same
//   Mac. Other files are uploaded into the pane's working directory on its
//   machine first (lib/files.ts), keeping files already there; folders cannot
//   be uploaded and are skipped with a note.
// - On the desktop app's sidebar, folders become workspaces on the local
//   machine, one per folder, as if created in the new workspace dialog. So
//   do folders dropped on the app's Dock icon, which the shell reports.
//
// Browsers never tell a page where a dropped file is; the desktop shell's
// bridge does (webUtils.getPathForFile). Drops of files nothing on the page
// takes are refused, so a file dropped beside a target does not replace the
// page.

import { actions } from './actions';
import { desktopShell } from './desktop';
import { t } from './i18n';
import { shellQuote, uploadAs } from './lib/files';
import { shortPath, type MachineState } from './lib/herdr';
import { useStore } from './state/store';

/** Whether a drag carries files from outside the page. */
export function carriesFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files');
}

/** A dropped file or folder, and where it is on disk when the desktop app
 * can tell (empty otherwise). */
export interface Dropped {
  file: File;
  path: string;
  folder: boolean;
}

const pathOnDisk = (f: File) => desktopShell?.pathForFile(f) ?? '';

/** The dropped files and folders. It must run during the drop event: the
 * items are empty after it. */
export function droppedItems(items: ArrayLike<DataTransferItem>, pathOf: (f: File) => string = pathOnDisk): Dropped[] {
  const out: Dropped[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) out.push({ file, path: pathOf(file), folder: !!item.webkitGetAsEntry?.()?.isDirectory });
  }
  return out;
}

/** Refuses drags of files that nothing under the pointer takes; a browser
 * would otherwise open the file in place of the page. */
export function refuseStrayFileDrops() {
  const refuse = (ev: DragEvent) => {
    if (ev.defaultPrevented || !carriesFiles(ev.dataTransfer)) return;
    ev.preventDefault();
    ev.dataTransfer!.dropEffect = 'none';
  };
  window.addEventListener('dragover', refuse);
  window.addEventListener('drop', refuse);
}

// ---- sidebar ----

/** The machine dropped folders become workspaces on: the local one, in the
 * desktop app and not in read-only mode. */
export function folderDropTarget(): MachineState | undefined {
  const s = useStore.getState();
  if (!desktopShell?.pathForFile || s.readOnly) return undefined;
  return Object.values(s.machines).find((m) => m.kind === 'local');
}

/** Creates a workspace on the local machine for each folder dropped. */
export async function dropFolders(dt: DataTransfer) {
  const local = folderDropTarget();
  if (!local) return;
  const items = droppedItems(dt.items);
  const folders = items.filter((i) => i.folder && i.path).map((i) => i.path);
  if (items.length > folders.length) useStore.getState().toast(t('sidebar.dropFoldersOnly', { n: items.length - folders.length }));
  for (const cwd of folders) await actions.newWorkspace(local.id, cwd);
}

// ---- the Dock icon ----

/** How long folders dropped on the Dock icon wait for the local machine,
 * which connects after the app starts. */
export const OPEN_WAIT_MS = 30_000;

const opened: string[] = [];
let opening = false;

/** The local machine once it takes requests; undefined when it does not
 * within ms, or cannot (disabled, read-only mode, a browser). */
function readyLocal(ms = OPEN_WAIT_MS): Promise<MachineState | undefined> {
  // undefined: not yet; null: never.
  const check = (): MachineState | null | undefined => {
    const s = useStore.getState();
    if (!desktopShell || s.readOnly) return null;
    const m = folderDropTarget();
    if (m?.status === 'disabled') return null;
    return m?.status === 'ready' || m?.status === 'degraded' ? m : undefined;
  };
  const now = check();
  if (now !== undefined) return Promise.resolve(now ?? undefined);
  return new Promise((resolve) => {
    const done = (m: MachineState | undefined) => {
      clearTimeout(timer);
      off();
      resolve(m);
    };
    const timer = setTimeout(() => done(undefined), ms);
    const off = useStore.subscribe(() => {
      const m = check();
      if (m !== undefined) done(m ?? undefined);
    });
  });
}

/** Creates a workspace on the local machine for a folder dropped on the
 * app's Dock icon, as for one dropped on the sidebar; the last one is
 * selected. When the app was launched by the drop, it waits for the local
 * machine to connect. */
export function openFolder(path: string) {
  opened.push(path);
  if (!opening) void openWaiting();
}

async function openWaiting() {
  opening = true;
  try {
    while (opened.length) {
      const local = await readyLocal();
      if (!local) {
        useStore.getState().toast(t('sidebar.openFoldersFailed', { n: opened.length }));
        opened.length = 0;
        return;
      }
      await actions.newWorkspace(local.id, opened.shift()!);
    }
  } finally {
    opening = false;
  }
}

/** Takes the folders the desktop shell reports; returns a function that
 * stops it. */
export function takeOpenedFolders(): () => void {
  return desktopShell?.onOpenFolder(openFolder) ?? (() => {});
}

// ---- panes ----

/** Whether files dropped on a pane of machine m are already on that machine:
 * in the desktop app, for the local machine. */
export function filesAreOn(m: string): boolean {
  return !!desktopShell?.pathForFile && useStore.getState().machines[m]?.kind === 'local';
}

/** The text to paste for files dropped on a pane of machine m: their paths
 * on that machine, shell-quoted, uploading the files that are not there
 * into dir (the pane's working directory), else into the upload directory.
 * Undefined when there is none. */
export async function droppedPaths(m: string, items: Dropped[], dir?: string): Promise<string | undefined> {
  const here = filesAreOn(m);
  const s = useStore.getState();
  const machine = s.machines[m]?.label ?? m;
  const there = (i: Dropped) => here && !!i.path;
  const folders = items.filter((i) => i.folder && !there(i)).length;
  if (folders) s.toast(t('surface.dropNoFolders', { n: folders }));
  const uploads = items.filter((i) => !i.folder && !there(i)).length;
  if (uploads)
    s.toast(
      dir
        ? t('surface.uploadingInto', { n: uploads, machine, dir: shortPath(dir, s.machines[m]?.info?.home) })
        : t('surface.uploading', { n: uploads, machine }),
    );
  const paths: string[] = [];
  for (const i of items) {
    if (there(i)) paths.push(i.path);
    else if (!i.folder) {
      const p = await uploadAs(m, i.file, dir);
      if (p) paths.push(p);
    }
  }
  return paths.length ? paths.map(shellQuote).join(' ') + ' ' : undefined;
}
