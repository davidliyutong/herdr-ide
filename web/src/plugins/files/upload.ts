// Uploads into the file explorer (docs/features/28-file-explorer.md):
// files and folders dropped from the computer or chosen with Upload Files…
// and Upload Folder…, into a folder of the machine, with the folders'
// structure. Names already taken there are asked about (replace, keep
// both, skip when other names go too, the answer for all of them with a
// box; cancel stops the whole upload); each file or folder
// dropped is one upload of the uploads panel (transfers.ts), with its
// progress and Cancel. In the desktop app, files of its own machine are
// copied where they are instead.

import { choiceDialog } from '../../dialog';
import { desktopShell } from '../../shell';
import { filesAreOn } from '../../drop';
import { t } from '../../i18n';
import { shortPath } from '../../lib/machine';
import { useStore } from '../../state/store';
import { uploadPlaced, useTransfers, type PlacedUpload } from '../../transfers';
import { errorText, filesApi } from './api';
import { join, reloadDirs, select } from './tree';

/** A file to upload, or a folder (no file): its path relative to the
 * folder it goes into ("photos/2024/a.jpg"). */
export interface Picked {
  rel: string;
  file?: File;
}

/** What to do with a name taken in the folder uploaded into. */
export type Conflict = 'replace' | 'keep' | 'skip';

/** The most files and folders one drop or choice uploads. */
export const MAX_PICKED = 10_000;

const toast = (msg: string, kind: 'error' | 'info' = 'error') => useStore.getState().toast(msg, undefined, undefined, kind);

// ---- what was dropped or chosen ----

/** What a drop from the computer holds: its files, and its folders with
 * everything in them. The entries are taken during the drop event (they
 * are gone after it), the folders read after; items that could not be
 * read are counted. */
export function droppedEntries(items: ArrayLike<DataTransferItem>): Promise<{ picked: Picked[]; unreadable: number }> {
  const roots: Array<FileSystemEntry | File> = [];
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    const file = entry ? undefined : item.getAsFile();
    if (entry) roots.push(entry);
    else if (file) roots.push(file);
  }
  return readEntries(roots);
}

/** Reads entries (files, folders with their contents) into Picked, at
 * most MAX_PICKED + 1 (the caller says when there were too many). */
export async function readEntries(roots: Array<FileSystemEntry | File>): Promise<{ picked: Picked[]; unreadable: number }> {
  const picked: Picked[] = [];
  let unreadable = 0;
  const walk = async (e: FileSystemEntry, rel: string): Promise<void> => {
    if (picked.length > MAX_PICKED) return;
    if (e.isFile) {
      try {
        picked.push({ rel, file: await new Promise<File>((resolve, reject) => (e as FileSystemFileEntry).file(resolve, reject)) });
      } catch {
        unreadable++;
      }
      return;
    }
    if (!e.isDirectory) return;
    picked.push({ rel });
    let children: FileSystemEntry[];
    try {
      children = await readAll((e as FileSystemDirectoryEntry).createReader());
    } catch {
      unreadable++;
      return;
    }
    for (const c of children) await walk(c, `${rel}/${c.name}`);
  };
  for (const r of roots) {
    if (r instanceof File) picked.push({ rel: r.name, file: r });
    else await walk(r, r.name);
  }
  return { picked, unreadable };
}

/** A folder's entries: a reader answers in batches until an empty one. */
async function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const out: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return out;
    out.push(...batch);
  }
}

/** Files chosen in the browser's dialog: a folder's carry their path in it
 * (webkitRelativePath, "photos/2024/a.jpg"); its empty folders are not
 * told. */
export function pickedFiles(files: readonly File[]): Picked[] {
  return files.map((file) => ({ rel: file.webkitRelativePath || file.name, file }));
}

/** Asks the browser for files, or for a folder with everything in it;
 * resolves with none when the dialog is cancelled. */
export function chooseFiles(folder: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) input.webkitdirectory = true;
    input.style.display = 'none';
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}

// ---- uploading ----

/** The first name of a relative path. */
const topOf = (rel: string) => rel.split('/')[0];

/** The folders below the top folder that hold the picked entries, as
 * paths relative to it: only the deepest ones (making them makes those
 * above). */
export function innerFolders(parts: readonly Picked[]): string[] {
  const dirs = new Set<string>();
  for (const p of parts) {
    const rest = p.rel.split('/').slice(1);
    const dir = p.file ? rest.slice(0, -1) : rest;
    if (dir.length) dirs.add(dir.join('/'));
  }
  const all = [...dirs];
  return all.filter((d) => !all.some((o) => o.startsWith(d + '/'))).sort();
}

/** Asks what to do with each name taken; with the box ticked, the answer
 * holds for the rest. Cancel (Escape) stops the whole upload: undefined.
 * Skip is offered when the upload holds other names (others). */
export async function askConflicts(
  names: readonly string[],
  folder: (n: string) => boolean,
  dir: string,
  others = names.length > 1,
): Promise<Map<string, Conflict> | undefined> {
  const out = new Map<string, Conflict>();
  let all: Conflict | undefined;
  for (let k = 0; k < names.length; k++) {
    const n = names[k];
    if (all) {
      out.set(n, all);
      continue;
    }
    const left = names.length - k - 1;
    const r = await choiceDialog({
      title: t('files.upload.conflictTitle'),
      message: t(folder(n) ? 'files.upload.folderExists' : 'files.upload.fileExists', { name: n, dir }),
      confirm: t('files.upload.replace'),
      alt: t('files.upload.keepBoth'),
      extra: others ? t('files.upload.skip') : undefined,
      check: left ? t('files.upload.applyAll', { n: left }) : undefined,
    });
    if (r.answer === 'cancel') return undefined;
    const c: Conflict = r.answer === 'confirm' ? 'replace' : r.answer === 'alt' ? 'keep' : 'skip';
    out.set(n, c);
    if (r.checked) all = c;
  }
  return out;
}

/** Uploads picked files and folders into dir of machine m. A name taken
 * by an entry of the same kind is asked about: replaced (a file written
 * over as a save writes it; a folder merged, its files replacing those
 * of the same names), kept beside (a new name, name-1…) or skipped, or
 * the whole upload cancelled; one
 * taken by the other kind is kept beside. A folder's folders are made
 * first, then its files go one after the other as one upload. */
export async function uploadInto(m: string, dir: string, picked: readonly Picked[]) {
  if (picked.length > MAX_PICKED) return toast(t('files.upload.tooMany', { max: MAX_PICKED }));
  const tops = new Map<string, Picked[]>();
  for (const p of picked) {
    const top = topOf(p.rel);
    if (!top) continue;
    tops.set(top, [...(tops.get(top) ?? []), p]);
  }
  const names = [...tops.keys()];
  if (!names.length) return;
  const folder = (n: string) => tops.get(n)!.some((p) => p.rel !== n || !p.file);
  // What is there already.
  const there = new Map<string, boolean>();
  try {
    for (let i = 0; i < names.length; i += 200) {
      const chunk = names.slice(i, i + 200);
      const es = await filesApi.stat(
        m,
        chunk.map((n) => join(dir, n)),
      );
      es.forEach((e, k) => e.exists && there.set(chunk[k], !!e.is_dir));
    }
  } catch (e) {
    return toast(errorText(e));
  }
  const home = useStore.getState().machines[m]?.info?.home;
  const decision = await askConflicts(
    names.filter((n) => there.has(n) && there.get(n) === folder(n)),
    folder,
    shortPath(dir, home),
    names.length > 1,
  );
  if (!decision) return; // cancelled: nothing goes

  const items: PlacedUpload[] = [];
  for (const n of names) {
    const how = decision.get(n);
    if (how === 'skip') continue;
    const replace = how === 'replace';
    const parts = tops.get(n)!;
    if (!folder(n)) {
      const f = parts[0].file!;
      const path = join(dir, n);
      // A replaced file is where it was (the agent answers a link's target).
      items.push({
        name: n,
        dir,
        files: [f],
        path: replace ? path : undefined,
        send: (_k, o) => filesApi.upload(m, path, f, { ...o, replace }),
      });
      continue;
    }
    // A folder: made (under a free name unless merged), with its folders.
    let root = join(dir, n);
    try {
      if (!replace) root = (await filesApi.mkdir(m, root, { unique: true })).paths?.[0] ?? root;
      const inner = innerFolders(parts);
      for (let i = 0; i < inner.length; i += 1000)
        await filesApi.mkdirs(
          m,
          inner.slice(i, i + 1000).map((d) => join(root, d)),
        );
    } catch (e) {
      toast(errorText(e));
      continue;
    }
    const files = parts.filter((p) => p.file);
    const pathOf = (p: Picked) => join(root, p.rel.slice(n.length + 1));
    items.push({
      name: n,
      dir,
      files: files.map((p) => p.file!),
      path: root,
      send: (k, o) => filesApi.upload(m, pathOf(files[k]), files[k].file!, { ...o, replace }),
    });
  }
  if (!items.length) return;
  const s = useStore.getState();
  const count = items.reduce((c, it) => c + it.files.length, 0);
  s.toast(t('surface.uploadingInto', { n: count, machine: s.machines[m]?.label ?? m, dir: shortPath(dir, home) }), {
    label: t('transfers.show'),
    run: () => useTransfers.getState().setPanel(true),
    ttl: 5000,
  });
  reloadDirs([dir]); // the folders made show at once
  const out = await uploadPlaced(m, items);
  reloadDirs([dir]);
  const last = out.filter((p): p is string => !!p).pop();
  if (last) select(last);
}

/** The paths on this computer of files chosen in the desktop app: a
 * folder's (one per folder chosen), else each file's; empty when the app
 * cannot tell. */
export function localPaths(files: readonly File[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const p = desktopShell?.pathForFile(f) ?? '';
    if (!p) return [];
    const rel = f.webkitRelativePath;
    // photos/2024/a.jpg at /Users/me/photos/2024/a.jpg: /Users/me/photos.
    out.add(rel ? p.slice(0, p.length - rel.length) + topOf(rel) : p);
  }
  return [...out];
}

/** Whether uploads to m are copies on this computer (the desktop app's
 * own machine). */
export const copiesInPlace = filesAreOn;
