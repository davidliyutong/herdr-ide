// What the file explorer does with files: changes through the core
// (api.ts) with the tree listed again after them, opening files (Quick
// Look, the editor pane, VS Code, a terminal), the clipboard, downloads and
// uploads, and the context menu that offers them. Nothing that changes
// files is offered in read-only mode.

import { FilePlus, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { createElement } from 'react';
import { actions, current } from '../../actions';
import { confirmDialog } from '../../dialog';
import { canDownload, startDownload } from '../../download';
import { droppedItems, filesAreOn } from '../../drop';
import { t } from '../../i18n';
import { isMac, keyLabel } from '../../keys';
import * as L from '../../term/layout';
import { terms } from '../../state/terms';
import { unsavedPanes, withView } from '../../state/panes';
import { useStore, type ToastKind } from '../../state/store';
import { uploadFiles } from '../../transfers';
import type { MenuEntry } from '../../contextMenu';
import { errorText, filesApi, type Result } from './api';
import { isPluginOn } from '../registry';
import {
  baseName,
  join,
  parentOf,
  relativePath,
  reloadDirs,
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
} from './tree';

const toast = (msg: string, kind: ToastKind = 'error') => useStore.getState().toast(msg, undefined, undefined, kind);
const mod = isMac ? 'cmd' : 'ctrl';
/** The keys the tree takes, as menus show them. */
export const treeKeys = {
  cut: () => keyLabel(`${mod}+x`),
  copy: () => keyLabel(`${mod}+c`),
  paste: () => keyLabel(`${mod}+v`),
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

/** Opens a file in the editor pane (one per file). */
/** The file editors of the shown workspace of m. */
function editors(m: string): L.PluginView[] {
  const l = terms.layout(m);
  const ws = l && L.selectedWorkspace(l);
  return ws ? L.pluginViews(ws, 'files', 'editor').map((v) => v.view) : [];
}

/** Opens a file in the editor, as VS Code does: a preview (a single click)
 * shows it in the workspace's preview editor, which the next preview
 * replaces unless it has unsaved changes; otherwise (a double click, Enter)
 * it stays open. An editor that shows the file already is focused, and
 * kept (no longer a preview) unless this is a preview too. Media files
 * show in the same editor, as Quick Look shows them. */
export function openEditor(m: string, path: string, o: { preview?: boolean } = {}) {
  const preview = !!o.preview;
  const view = { plugin: 'files', kind: 'editor', path };
  if (editors(m).some((v) => v.path === path))
    return actions.openView(m, preview ? view : { ...view, preview: false }, { reuse: (v) => v.path === path });
  const replaceable = (v: L.PluginView) => preview && v.preview === true && !unsavedPanes(m, [L.viewKey(v.id)]).length;
  return actions.openView(m, { ...view, preview }, { reuse: replaceable });
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

/** Shows path in the tree: its directories expanded, it selected; outside
 * the root, the tree stops following panes and shows its directory. */
export function reveal(m: string, path: string) {
  const s = useTree.getState();
  useStore.getState().setPanel('files');
  if (s.m !== m || !s.root || !within(path, s.root) || path === s.root) {
    setFollow(false);
    showRoot(m, parentOf(path));
  }
  const root = useTree.getState().root!;
  for (let d = parentOf(path); within(d, root) && d !== root; d = parentOf(d)) setExpanded(d, true);
  select(path);
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
  await loadDir(parentOf(path));
  select(to);
}

/** Moves paths into the trash; what no trash takes may be deleted for good
 * after asking. */
export async function trash(m: string, paths: string[]) {
  paths = topmost(paths);
  if (!paths.length) return;
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
}

/** Moves paths into dir (a drop in the tree). */
export async function moveInto(m: string, paths: string[], dir: string) {
  paths = topmost(paths).filter((p) => parentOf(p) !== dir && !within(dir, p));
  if (!paths.length) return;
  const r = await attempt(() => filesApi.move(m, paths, dir));
  reloadDirs([dir, ...paths.map(parentOf)]);
  if (r?.paths?.length) select(r.paths[r.paths.length - 1]);
}

export async function copyInto(m: string, paths: string[], dir: string) {
  paths = topmost(paths);
  if (!paths.length) return;
  const r = await attempt(() => filesApi.copy(m, paths, dir));
  reloadDirs([dir]);
  if (r?.paths?.length) select(r.paths[r.paths.length - 1]);
}

/** Pastes the clipboard's paths into dir: moved after a cut, copied
 * otherwise. */
export async function paste(m: string, dir: string) {
  const c = useTree.getState().clipboard;
  if (!c || c.m !== m) return;
  if (c.cut) {
    setClipboard(undefined);
    await moveInto(m, c.paths, dir);
  } else await copyInto(m, c.paths, dir);
}

/** Uploads files dropped from outside the page into dir; in the desktop
 * app files of its own machine are copied where they are. Folders from
 * another computer cannot be uploaded. */
export async function dropFiles(m: string, dir: string, items: DataTransferItemList | ArrayLike<DataTransferItem>) {
  const dropped = droppedItems(items);
  if (filesAreOn(m)) {
    const here = dropped.filter((d) => d.path).map((d) => d.path);
    if (here.length) await copyInto(m, here, dir);
    return;
  }
  const folders = dropped.filter((d) => d.folder).length;
  if (folders) toast(t('surface.dropNoFolders', { n: folders }), 'info');
  const files = dropped.filter((d) => !d.folder).map((d) => d.file);
  if (!files.length) return;
  await uploadFiles(m, files, dir);
  reloadDirs([dir]);
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

/** The context menu for paths (the selection, with the row pointed at
 * first) or, with none, for the tree's root. */
export function menuFor(m: string, paths: string[], isDir: (p: string) => boolean, el?: HTMLElement | null): MenuEntry[] {
  const s = useTree.getState();
  const root = s.root!;
  const ro = readOnly();
  const target = paths[0];
  const one = paths.length === 1;
  const dir = target ? dirOf(target, isDir(target)) : root;
  const out: MenuEntry[] = [];
  if (target && one) {
    if (!isDir(target)) {
      out.push({ label: t('files.open'), hint: '↵', run: () => void openPath(m, target, false) });
      out.push({ label: t('files.quickLook'), hint: keyLabel('space'), run: () => void quickLook(m, target, el) });
    }
    if (isPluginOn('vscode'))
      out.push({
        label: t('files.openInCode'),
        run: () => void (isDir(target) ? actions.openCode(m, target) : actions.openInCode(m, target)),
      });
    out.push({ label: t('files.openInTerminal'), run: () => void openTerminal(m, dir) });
    out.push('sep');
  } else if (!target) {
    out.push({ label: t('files.openInTerminal'), run: () => void openTerminal(m, root) });
    out.push('sep');
  }
  if (!ro && (one || !target)) {
    out.push({ label: t('files.newFile'), icon: createElement(FilePlus), run: () => setEdit({ kind: 'file', path: dir }) });
    out.push({ label: t('files.newFolder'), icon: createElement(FolderPlus), run: () => setEdit({ kind: 'folder', path: dir }) });
    out.push('sep');
  }
  if (target && !ro) {
    out.push({ label: t('files.cut'), hint: treeKeys.cut(), run: () => setClipboard({ m, paths, cut: true }) });
    out.push({ label: t('files.copy'), hint: treeKeys.copy(), run: () => setClipboard({ m, paths, cut: false }) });
  }
  if (!ro && s.clipboard?.m === m && (one || !target)) {
    out.push({ label: t('files.paste'), hint: treeKeys.paste(), run: () => void paste(m, dir) });
  }
  out.push('sep');
  if (target) {
    out.push({ label: t('files.copyPath'), run: () => void copyText(paths.join('\n')) });
    out.push({ label: t('files.copyRelativePath'), run: () => void copyText(paths.map((p) => relativePath(root, p)).join('\n')) });
    if (canDownload(m)) {
      out.push('sep');
      out.push({ label: t('files.download'), run: () => void startDownload(m, paths) });
    }
  }
  if (target && !ro) {
    out.push('sep');
    if (one)
      out.push({ label: t('files.rename'), hint: 'F2', icon: createElement(Pencil), run: () => setEdit({ kind: 'rename', path: target }) });
    out.push({ label: t('files.trash'), hint: treeKeys.trash(), icon: createElement(Trash2), run: () => void trash(m, paths) });
    out.push({ label: t('files.deletePermanently'), hint: treeKeys.remove(), danger: true, run: () => void remove(m, paths) });
  }
  if (!target) {
    out.push({ label: t('files.refresh'), run: () => reloadDirs(Object.keys(useTree.getState().dirs)) });
    out.push({ label: t('files.collapseAll'), run: collapseAll });
  }
  return out;
}
