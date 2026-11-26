// What the file explorer does with files: changes through the hub
// (api.ts) with the tree listed again after them, opening files (Quick
// Look, the editor pane, VS Code, a terminal), the clipboard, downloads and
// uploads, and the context menu that offers them. Nothing that changes
// files is offered in read-only mode.

import { Download, FilePlus, FolderOpen, FolderPlus, FolderUp, Pencil, Trash2, Upload } from 'lucide-react';
import { showPanel } from '../../panelPanes';
import { createElement } from 'react';
import { create as createStore } from 'zustand';
import { actions, current } from '../../actions';
import { confirmDialog } from '../../dialog';
import { canDownload, startDownload, useDownloads } from '../../download';
import { droppedItems, filesAreOn } from '../../drop';
import { t } from '../../i18n';
import { isMac, keyLabel } from '../../keys';
import { renameKeyHint } from '../../rowKeys';
import * as L from '../../term/layout';
import { terms } from '../../state/terms';
import { withView } from '../../state/panes';
import { useStore, type ToastKind } from '../../state/store';
import { useTransfers } from '../../transfers';
import type { MenuEntry } from '../../contextMenu';
import { errorText, filesApi, type Result } from './api';
import { decorationsOf } from './decorations';
import { recheckGone } from './gone';
import { quickDiff } from './quickDiff';
import { isPluginOn } from '../registry';
import { settingValue } from '../../settings';
import {
  chooseFiles,
  clipboardLocalPaths,
  clipboardRoots,
  droppedEntries,
  localPaths,
  pickedFiles,
  readEntries,
  uploadInto,
} from './upload';
import {
  baseName,
  join,
  parentOf,
  relativePath,
  reloadDirs,
  revealVisiblePath,
  select,
  setClipboard,
  setEdit,
  setExpanded,
  setFollow,
  showRoot,
  topmost,
  useTree,
  within,
  collapseAll,
  loadDir,
  refresh,
} from './tree';

const toast = (msg: string, kind: ToastKind = 'error') => useStore.getState().toast(msg, undefined, undefined, kind);
const mod = isMac ? 'cmd' : 'ctrl';
/** The keys the tree takes, as menus show them. */
export const treeKeys = {
  cut: () => keyLabel(`${mod}+x`),
  copy: () => keyLabel(`${mod}+c`),
  paste: () => keyLabel(`${mod}+v`),
  open: () => (isMac ? keyLabel('cmd+o') : '↵'),
  rename: () => renameKeyHint(),
  trash: () => keyLabel(isMac ? 'cmd+backspace' : 'delete'),
  remove: () => keyLabel(isMac ? 'cmd+shift+backspace' : 'shift+delete'),
};
const readOnly = () => useStore.getState().readOnly;

/** Runs a change and shows its failure. */
async function attempt(f: () => Promise<Result>): Promise<Result | undefined> {
  try {
    const r = await f();
    const failed = Object.entries(r.failed ?? {});
    if (failed.length) toast(t('files.someFailed', { n: failed.length, first: baseName(failed[0][0]) }));
    return r;
  } catch (e) {
    toast(errorText(e));
    return undefined;
  }
}

/** Why a name typed for a file cannot be one, if it cannot. */
export function badName(name: string): string | undefined {
  if (!name) return t('files.name.empty');
  if (name.includes('/') || name.includes('\0')) return t('files.name.slash');
  if (name === '.' || name === '..') return t('files.name.dots');
  return undefined;
}

// ---- opening ----

/** Opens a file in the editor, as VS Code does, in a tab of the workspace
 * as terminals open: a preview (a single click) shows it in the
 * workspace's preview editor, which the next preview replaces unless it
 * has unsaved changes; otherwise (a double click, Enter) it stays open. An
 * editor that shows the file already is shown, and kept (no longer a
 * preview) unless this is a preview too. With side, the editor opens
 * split beside the focused pane instead (Open to the Side), unless that
 * pane's tab shows the file already. Media files show in the same editor,
 * as Quick Look shows them. With line (1-based), col and optional endLine /
 * endCol, the editor shows that place with the cursor/selection there. */
export function openEditor(
  m: string,
  path: string,
  o: { preview?: boolean; side?: boolean; line?: number; col?: number; endLine?: number; endCol?: number; from?: string } = {},
) {
  return actions.openEditor(m, path, o);
}

/** Opens files in editors to keep, one after the other (a selection's). */
export async function openFiles(m: string, paths: readonly string[]) {
  for (const p of paths) await openEditor(m, p);
}

/** Open to the Side: the file in an editor to keep, split beside the
 * focused pane, as VS Code's; an editor of that tab that shows it already
 * is focused instead. */
export function openToSide(m: string, path: string) {
  return openEditor(m, path, { side: true });
}

/** Keeps a preview editor open: the next preview opens beside it. */
export function keepEditor(m: string, pane: string) {
  terms.mutate(m, (l) => L.setViewFields(l, pane, { preview: false }));
}

/** Opens a file in the editor (preview, else to keep); a directory is
 * expanded or collapsed. */
export function openPath(m: string, path: string, dir: boolean, preview = false) {
  if (dir) return setExpanded(path, !useTree.getState().expanded[path]);
  return openEditor(m, path, { preview });
}

/** Shows a file in the preview editor and gives the keyboard back to el. */
export async function quickLook(m: string, path: string, el?: HTMLElement | null) {
  await openEditor(m, path, { preview: true });
  el?.focus();
}

/** A new terminal in dir, beside the focused pane (else in a new tab). */
export async function openTerminal(m: string, dir: string) {
  const layout = terms.layout(m);
  const from = layout && current()?.m === m ? L.focusedPane(layout) : undefined;
  try {
    const address = await terms.run(m, { split: true, cwd: dir }, (l, a) => {
      const next = from ? L.splitPane(l, from, 'horizontal', { terminal: a }) : l;
      return next === l ? L.openTerminal(l, a) : next;
    });
    if (address) {
      terms.mutate(m, (l) => L.focusPane(l, address));
      withView(m, address, (h) => h.focus());
    }
  } catch (e) {
    toast(errorText(e));
  }
}

/** Reveal in Explorer: shows the explorer's panel (its pane in the tab
 * shown, else the sidebar's) with path in the tree,
 * its folders expanded, it selected and scrolled to; outside the root,
 * the tree stops following panes and shows its folder. Nothing while the
 * explorer is off. */
export function revealInExplorer(m: string, path: string) {
  if (!isPluginOn('files')) return;
  const s = useTree.getState();
  showPanel('files');
  if (s.m !== m || !s.root || !within(path, s.root) || path === s.root) {
    setFollow(false);
    showRoot(m, parentOf(path));
  }
  revealVisiblePath(path);
}

/** Show in Explorer of the editor pane. */
export const reveal = revealInExplorer;

/** Whether Reveal in Finder is offered for each machine's paths here, as
 * the hub said: only for its own machine, to a page on its computer
 * (backend/features/files revealable). Unknown until asked (loadRevealable). */
export const useRevealable = createStore<Record<string, boolean>>(() => ({}));
const askingRevealable = new Set<string>();

/** Asks the hub, once per page, whether machine m's paths can be shown in
 * the system's file manager; another machine than the hub's own cannot. */
export function loadRevealable(m: string | undefined) {
  if (!m || m in useRevealable.getState() || askingRevealable.has(m)) return;
  if (useStore.getState().machines[m]?.kind !== 'local') return useRevealable.setState({ [m]: false });
  askingRevealable.add(m);
  filesApi
    .revealAvailable(m)
    .then((ok) => useRevealable.setState({ [m]: ok }))
    .catch(() => {})
    .finally(() => askingRevealable.delete(m));
}

/** Reveal in Finder (Reveal in File Manager elsewhere) for path, when the
 * hub offers it for m: the system's file manager of the hub's computer
 * shows it. It runs a program there, so read-only mode has none. */
export function revealEntries(m: string, path: string): MenuEntry[] {
  loadRevealable(m);
  if (readOnly() || !useRevealable.getState()[m]) return [];
  const finder = useStore.getState().machines[m]?.info?.os === 'darwin';
  return [
    {
      label: t(finder ? 'files.revealInFinder' : 'files.revealInFileManager'),
      icon: createElement(FolderOpen),
      run: () => void revealInSystem(m, path),
    },
  ];
}

export async function revealInSystem(m: string, path: string) {
  try {
    await filesApi.reveal(m, path);
  } catch (e) {
    toast(errorText(e));
  }
}

// ---- changes ----

/** Creates a file or folder named name in dir; a file opens in the editor. */
export async function create(m: string, dir: string, name: string, kind: 'file' | 'folder') {
  const bad = badName(name);
  if (bad) return toast(bad);
  const path = join(dir, name);
  const r = await attempt(() => (kind === 'folder' ? filesApi.mkdir(m, path) : filesApi.create(m, path)));
  if (!r) return;
  await loadDir(dir);
  select(path);
  if (kind === 'file') void openEditor(m, path);
}

export async function rename(m: string, path: string, name: string) {
  if (name === baseName(path)) return;
  const bad = badName(name);
  if (bad) return toast(bad);
  const to = join(parentOf(path), name);
  if (!(await attempt(() => filesApi.rename(m, path, to)))) return;
  void recheckGone().catch(() => {});
  await loadDir(parentOf(path));
  select(to);
}

/** Moves paths into the trash, after asking when the setting
 * files.confirmTrash says so; what no trash takes may be deleted for good
 * after asking. */
export async function trash(m: string, paths: string[]) {
  paths = topmost(paths);
  if (!paths.length) return;
  if (settingValue('files.confirmTrash') === true) {
    const what = paths.length === 1 ? baseName(paths[0]) : t('files.items', { n: paths.length });
    const ok = await confirmDialog({
      title: t('files.confirm.trashTitle'),
      message: t('files.confirm.trash', { what }),
      confirm: t('files.trash'),
    });
    if (!ok) return;
  }
  let r: Result;
  try {
    r = await filesApi.trash(m, paths);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'trash_unavailable') return remove(m, paths, t('files.confirm.noTrash'));
    return toast(errorText(e));
  }
  const failed = Object.entries(r.failed ?? {});
  reloadDirs(paths.map(parentOf));
  void recheckGone().catch(() => {});
  const noTrash = failed.filter(([, c]) => c === 'trash_unavailable').map(([p]) => p);
  if (noTrash.length) return remove(m, noTrash, t('files.confirm.noTrash'));
  if (failed.length) toast(t('files.someFailed', { n: failed.length, first: baseName(failed[0][0]) }));
}

/** Deletes paths for good, after asking. */
export async function remove(m: string, paths: string[], why?: string) {
  paths = topmost(paths);
  if (!paths.length) return;
  const what = paths.length === 1 ? baseName(paths[0]) : t('files.items', { n: paths.length });
  const ok = await confirmDialog({
    title: t('files.confirm.deleteTitle'),
    message: (why ? why + ' ' : '') + t('files.confirm.delete', { what }),
    confirm: t('files.delete'),
    danger: true,
  });
  if (!ok) return;
  await attempt(() => filesApi.remove(m, paths));
  reloadDirs(paths.map(parentOf));
  void recheckGone().catch(() => {});
}

/** Moves paths into dir (a drop in the tree): what it did, undefined when
 * it failed. The machine refuses a folder moved into itself, also through
 * a link; the names here only spare it the obvious. */
export async function moveInto(m: string, paths: string[], dir: string): Promise<Result | undefined> {
  paths = topmost(paths).filter((p) => parentOf(p) !== dir && !within(dir, p));
  if (!paths.length) return {};
  const r = await attempt(() => filesApi.move(m, paths, dir));
  reloadDirs([dir, ...paths.map(parentOf)]);
  void recheckGone().catch(() => {});
  if (r?.paths?.length) select(r.paths[r.paths.length - 1]);
  return r;
}

export async function copyInto(m: string, paths: string[], dir: string) {
  paths = topmost(paths);
  if (!paths.length) return;
  const r = await attempt(() => filesApi.copy(m, paths, dir));
  reloadDirs([dir]);
  if (r?.paths?.length) select(r.paths[r.paths.length - 1]);
}

/** Pastes the clipboard's paths into dir: moved after a cut, copied
 * otherwise. A cut leaves the clipboard once moved: what failed to move
 * stays in it, and all of it when the move failed. */
export async function paste(m: string, dir: string) {
  const c = useTree.getState().clipboard;
  if (!c || c.m !== m) return;
  if (!c.cut) return copyInto(m, c.paths, dir);
  const r = await moveInto(m, c.paths, dir);
  if (!r || useTree.getState().clipboard !== c) return;
  const failed = c.paths.filter((p) => r.failed?.[p]);
  setClipboard(failed.length ? { ...c, paths: failed } : undefined);
}

/** Uploads files and folders dropped from outside the page into dir, the
 * folders with everything in them (upload.ts); in the desktop app files
 * of its own machine are copied where they are. It must start during the
 * drop event, which takes the entries. */
export async function dropFiles(m: string, dir: string, items: DataTransferItemList | ArrayLike<DataTransferItem>) {
  if (filesAreOn(m)) {
    const here = droppedItems(items)
      .filter((d) => d.path)
      .map((d) => d.path);
    if (here.length) await copyInto(m, here, dir);
    return;
  }
  const { picked, unreadable } = await droppedEntries(items);
  if (unreadable) toast(t('files.upload.unreadable', { n: unreadable }), 'info');
  await uploadInto(m, dir, picked);
}

async function uploadRoots(m: string, dir: string, roots: Array<FileSystemEntry | File>) {
  try {
    const { picked, unreadable } = await readEntries(roots);
    if (unreadable) toast(t('files.paste.unreadable', { n: unreadable }), picked.length ? 'info' : 'error');
    if (!picked.length) return;
    if (dir !== useTree.getState().root) setExpanded(dir, true);
    await uploadInto(m, dir, picked);
  } catch (e) {
    toast(errorText(e));
  }
}

/** Pastes locally copied files or clipboard items onto dir of machine m:
 * copies in place on the desktop app's own machine when local paths exist,
 * and uploads onto remote machines (or for non-file clipboard blobs). Must
 * be called synchronously during the paste event so clipboardData entries are
 * captured before the browser clears them. */
export async function pasteFiles(m: string, dir: string, data: Pick<DataTransfer, 'items' | 'files'>) {
  if (filesAreOn(m)) {
    const { paths, fallback } = clipboardLocalPaths(data);
    if (paths.length) {
      if (dir !== useTree.getState().root) setExpanded(dir, true);
      await copyInto(m, paths, dir);
    }
    if (fallback.length) await uploadRoots(m, dir, fallback);
    return;
  }
  const roots = clipboardRoots(data);
  if (roots.length) await uploadRoots(m, dir, roots);
}

/** Upload Files… and Upload Folder…: the browser's dialog, then the
 * upload into dir (in the desktop app, copies of its own machine's files
 * where they are). */
export async function uploadChosen(m: string, dir: string, folder: boolean) {
  const files = await chooseFiles(folder);
  if (!files.length) return;
  const here = filesAreOn(m) ? localPaths(files) : [];
  if (here.length) return copyInto(m, here, dir);
  await uploadInto(m, dir, pickedFiles(files));
}

/** Opens the uploads or the downloads panel of the status bar. */
export function showTransfers(which: 'uploads' | 'downloads') {
  (which === 'uploads' ? useTransfers : useDownloads).getState().setPanel(true);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast(t('files.copyFailed'));
  }
}

// ---- the context menu ----

/** The directory new entries and pastes go into for a target row. */
export const dirOf = (path: string, dir: boolean) => (dir ? path : parentOf(path));

/** How fileMenuEntries treats paths. */
export interface FileMenuOptions {
  /** Whether a path is a folder: Open and Open Preview leave folders out,
   * Open in VS Code opens a folder as one, Open in Terminal starts in it
   * (a file's folder otherwise). Every path is a file by default. */
  isDir?(p: string): boolean;
  /** What Copy Relative Path is relative to: the explorer's root by
   * default. */
  root?: string;
  /** Where the keyboard goes back to after Open Preview (the list). */
  el?: HTMLElement | null;
  /** Leave out Reveal in Explorer (the explorer's own menu). */
  reveal?: boolean;
}

/** The entries that open paths: Open (the files among them, several at
 * once), Open to the Side, Open Preview (one file), Open in VS Code and
 * Open in Terminal (one path). */
function openEntries(m: string, paths: readonly string[], o: FileMenuOptions): MenuEntry[] {
  const isDir = o.isDir ?? (() => false);
  const files = paths.filter((p) => !isDir(p));
  const one = paths.length === 1 ? paths[0] : undefined;
  const out: MenuEntry[] = [];
  if (files.length) {
    out.push({ label: t('files.open'), hint: treeKeys.open(), run: () => void openFiles(m, files) });
    out.push({
      label: t('files.openToSide'),
      run: () => void files.reduce((p, f) => p.then(() => openToSide(m, f)), Promise.resolve<unknown>(undefined)),
    });
  }
  if (one && files.length) out.push({ label: t('files.quickLook'), hint: keyLabel('space'), run: () => void quickLook(m, one, o.el) });
  if (one && isPluginOn('vscode'))
    out.push({ label: t('files.openInCode'), run: () => void (isDir(one) ? actions.openCode(m, one) : actions.openInCode(m, one)) });
  if (one) out.push({ label: t('files.openInTerminal'), run: () => void openTerminal(m, dirOf(one, isDir(one))) });
  return out;
}

/** Copy Path, Copy Relative Path and Download (a zip for folders and
 * several paths; not for the desktop app's own machine). */
function pathEntries(m: string, paths: readonly string[], o: FileMenuOptions): MenuEntry[] {
  const root = o.root ?? useTree.getState().root;
  const out: MenuEntry[] = [
    { label: t('files.copyPath'), run: () => void copyText(paths.join('\n')) },
    { label: t('files.copyRelativePath'), run: () => void copyText(paths.map((p) => relativePath(root, p)).join('\n')) },
  ];
  if (canDownload(m))
    out.push('sep', { label: t('files.download'), icon: createElement(Download), run: () => void startDownload(m, [...paths]) });
  return out;
}

/** The entries every list of a machine's files offers for paths (a
 * selection, the row pointed at first), as the explorer's menu has them:
 * Open, Open to the Side, Open Preview, Open in VS Code, Open in Terminal,
 * Copy Path, Copy Relative Path, Download and Reveal in Explorer (one
 * path). The Git panel's rows offer them too. They change nothing, so
 * read-only mode keeps them. */
export function fileMenuEntries(m: string, paths: readonly string[], o: FileMenuOptions = {}): MenuEntry[] {
  if (!paths.length) return [];
  const out: MenuEntry[] = [...openEntries(m, paths, o), 'sep', ...pathEntries(m, paths, o)];
  if (o.reveal !== false && paths.length === 1 && isPluginOn('files'))
    out.push('sep', { label: t('files.revealInExplorer'), run: () => revealInExplorer(m, paths[0]) });
  return out;
}

/** Whether a version control provider marks the file at path as changed
 * (a decoration with a letter on its row), so its changes can be opened. */
function changed(m: string, path: string): boolean {
  const d = decorationsOf(m, parentOf(path))[baseName(path)];
  return !!d?.badge && !!quickDiff()?.openChanges;
}

/** The context menu for paths (the selection, with the row pointed at
 * first) or, with none, for the tree's root. Folders, files and several of
 * both take what applies to them: several files open at once, are cut,
 * copied, downloaded, trashed or deleted together; a paste or a new
 * entry goes into the folder of the row pointed at. */
export function menuFor(m: string, paths: string[], isDir: (p: string) => boolean, el?: HTMLElement | null): MenuEntry[] {
  const s = useTree.getState();
  const root = s.root!;
  const ro = readOnly();
  const target = paths[0];
  const dir = target ? dirOf(target, isDir(target)) : root;
  const out: MenuEntry[] = [];
  if (target) {
    out.push(...openEntries(m, paths, { isDir, el }));
    if (paths.length === 1) out.push(...revealEntries(m, target));
    if (paths.length === 1 && !isDir(target) && changed(m, target))
      out.push({ label: t('files.openChangesItem'), run: () => quickDiff()?.openChanges?.(m, target) });
  } else out.push({ label: t('files.openInTerminal'), run: () => void openTerminal(m, root) }, ...revealEntries(m, root));
  out.push('sep');
  if (!ro) {
    out.push({ label: t('files.newFile'), icon: createElement(FilePlus), run: () => setEdit({ kind: 'file', path: dir }) });
    out.push({ label: t('files.newFolder'), icon: createElement(FolderPlus), run: () => setEdit({ kind: 'folder', path: dir }) });
    if (!target || isDir(target)) out.push(...uploadEntries(m, dir));
    out.push('sep');
  }
  if (target && !ro) {
    out.push({ label: t('files.cut'), hint: treeKeys.cut(), run: () => setClipboard({ m, paths, cut: true }) });
    out.push({ label: t('files.copy'), hint: treeKeys.copy(), run: () => setClipboard({ m, paths, cut: false }) });
  }
  if (!ro && s.clipboard?.m === m) {
    out.push({ label: t('files.paste'), hint: treeKeys.paste(), run: () => void paste(m, dir) });
  }
  out.push('sep');
  if (target) out.push(...pathEntries(m, paths, { root }));
  if (target && !ro) {
    out.push('sep');
    if (paths.length === 1)
      out.push({
        label: t('files.rename'),
        hint: treeKeys.rename(),
        icon: createElement(Pencil),
        run: () => setEdit({ kind: 'rename', path: target }),
      });
    out.push({ label: t('files.trash'), hint: treeKeys.trash(), icon: createElement(Trash2), run: () => void trash(m, paths) });
    out.push({ label: t('files.deletePermanently'), hint: treeKeys.remove(), danger: true, run: () => void remove(m, paths) });
  }
  if (!target) {
    out.push({ label: t('files.refresh'), run: refresh });
    out.push({ label: t('files.collapseAll'), run: collapseAll });
    out.push('sep', ...transferEntries());
  }
  return out;
}

/** Upload Files… and Upload Folder… into dir; none in read-only mode. */
function uploadEntries(m: string, dir: string): MenuEntry[] {
  if (readOnly()) return [];
  return [
    { label: t('files.uploadFiles'), icon: createElement(Upload), run: () => void uploadChosen(m, dir, false) },
    { label: t('files.uploadFolder'), icon: createElement(FolderUp), run: () => void uploadChosen(m, dir, true) },
  ];
}

const transferEntries = (): MenuEntry[] => [
  { label: t('files.showUploads'), run: () => showTransfers('uploads') },
  { label: t('files.showDownloads'), run: () => showTransfers('downloads') },
];

/** The panel's menu (its … button): new entries and uploads into the
 * selected folder (the selected file's, else the root), the selection's
 * download, Refresh, Collapse Folders and the transfers. */
export function panelMenu(m: string, isDir: (p: string) => boolean): MenuEntry[] {
  const s = useTree.getState();
  const root = s.root!;
  const cur = s.cursor;
  const dir = cur ? dirOf(cur, isDir(cur)) : root;
  const out: MenuEntry[] = [];
  if (!readOnly()) {
    out.push({ label: t('files.newFile'), icon: createElement(FilePlus), run: () => setEdit({ kind: 'file', path: dir }) });
    out.push({ label: t('files.newFolder'), icon: createElement(FolderPlus), run: () => setEdit({ kind: 'folder', path: dir }) });
    out.push(...uploadEntries(m, dir), 'sep');
  }
  if (s.selection.length && canDownload(m)) {
    const paths = [...s.selection];
    out.push({ label: t('files.download'), icon: createElement(Download), run: () => void startDownload(m, paths) }, 'sep');
  }
  out.push({ label: t('files.refresh'), run: refresh });
  out.push({ label: t('files.collapseAll'), run: collapseAll });
  out.push('sep', ...transferEntries());
  return out;
}
