// The file explorer's tree (docs/features/28-file-explorer.md): the
// machine and root it shows, the directories it has listed and expanded,
// the selection, the filter, the clipboard and the name being edited, and
// the rows that come out of them. Directories are listed when expanded
// (/api/m/{id}/list) and listed again when their modification time
// changes; the panel polls the expanded ones while it is shown (poll).

import { create } from 'zustand';
import { listDir, type RemoteStat } from '../../lib/files';
import { loadPref, savePref } from '../../state/store';
import { filesApi, type Entry } from './api';

export interface Dir {
  entries?: RemoteStat[];
  error?: string;
  loading?: boolean;
}

/** A name being typed in the tree: a rename of path, or a new file or
 * folder in the directory path. */
export interface Edit {
  kind: 'rename' | 'file' | 'folder';
  path: string;
}

export interface Clipboard {
  m: string;
  paths: string[];
  cut: boolean;
}

export interface TreeState {
  m?: string;
  root?: string;
  /** The root follows the focused terminal's directory (per browser). */
  follow: boolean;
  /** Hidden files (names starting with a dot) are shown (per browser). */
  hidden: boolean;
  filter: string;
  /** Expanded directories, by path. */
  expanded: Record<string, true>;
  dirs: Record<string, Dir>;
  /** Directories' modification times as the last poll saw them. */
  mtimes: Record<string, number>;
  selection: string[];
  /** The row the keyboard is on. */
  cursor?: string;
  /** Where a shift-click or shift-arrow selection starts. */
  anchor?: string;
  clipboard?: Clipboard;
  edit?: Edit;
}

export const useTree = create<TreeState>(() => ({
  follow: loadPref('files.follow', true),
  hidden: loadPref('files.hidden', false),
  filter: '',
  expanded: {},
  dirs: {},
  mtimes: {},
  selection: [],
}));

const set = (p: Partial<TreeState> | ((s: TreeState) => Partial<TreeState>)) => useTree.setState(p);

// ---- paths (POSIX, as on machines) ----

export function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '/';
}

export function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1) || p;
}

/** p relative to root ("." for root itself), p itself outside it. */
export function relativePath(root: string | undefined, p: string): string {
  if (!root) return p;
  if (p === root) return '.';
  const pre = root === '/' ? '/' : root + '/';
  return p.startsWith(pre) ? p.slice(pre.length) : p;
}

/** Whether p is dir or below it. */
export const within = (p: string, dir: string) => p === dir || p.startsWith(dir === '/' ? '/' : dir + '/');

/** The directories from / to p, for the breadcrumb: [path, name]. */
export function crumbs(p: string, home?: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = 0;
  if (home && within(p, home) && home !== '/') {
    out.push([home, '~']);
    start = home.length;
  } else out.push(['/', '/']);
  for (const part of p.slice(start).split('/')) {
    if (!part) continue;
    const prev = out[out.length - 1][0];
    out.push([join(prev, part), part]);
  }
  return out;
}

// ---- rows ----

export interface Row {
  path: string;
  name: string;
  depth: number;
  dir: boolean;
  expanded: boolean;
  link?: boolean;
  /** A new file's or folder's name being typed: path is its directory. */
  creating?: 'file' | 'folder';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then files, each by name as people sort (a2 before a10). */
export function sortEntries(entries: readonly RemoteStat[]): RemoteStat[] {
  return [...entries].sort((a, b) => (a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : collator.compare(a.name, b.name)));
}

/** The tree's rows: the root's entries and those of the expanded
 * directories below it, without hidden files unless shown. A filter keeps
 * the entries whose names hold it, and the directories (listed before)
 * that lead to one, opened. */
export function treeRows(s: Pick<TreeState, 'root' | 'dirs' | 'expanded' | 'hidden' | 'filter' | 'edit'>): Row[] {
  if (!s.root) return [];
  const needle = s.filter.trim().toLowerCase();
  const match = (name: string) => name.toLowerCase().includes(needle);
  const walk = (dir: string, depth: number, out: Row[]) => {
    if (s.edit && s.edit.kind !== 'rename' && s.edit.path === dir) {
      out.push({ path: dir, name: '', depth, dir: s.edit.kind === 'folder', expanded: false, creating: s.edit.kind });
    }
    const entries = s.dirs[dir]?.entries;
    if (!entries) return;
    for (const e of sortEntries(entries)) {
      if (!s.hidden && e.name.startsWith('.')) continue;
      const path = join(dir, e.name);
      const row: Row = {
        path,
        name: e.name,
        depth,
        dir: e.is_dir,
        expanded: !!s.expanded[path],
        link: (e as { is_link?: boolean }).is_link,
      };
      if (!e.is_dir) {
        if (!needle || match(e.name)) out.push(row);
        continue;
      }
      if (!needle) {
        out.push(row);
        if (row.expanded) walk(path, depth + 1, out);
        continue;
      }
      const kids: Row[] = [];
      walk(path, depth + 1, kids);
      if (kids.length || match(e.name)) {
        row.expanded = kids.length > 0;
        out.push(row, ...kids);
      }
    }
  };
  const out: Row[] = [];
  walk(s.root, 0, out);
  return out;
}

/** The path delta rows from cursor (the first or last row without one). */
export function stepRow(rows: readonly Row[], cursor: string | undefined, delta: number): string | undefined {
  const real = rows.filter((r) => !r.creating);
  if (!real.length) return undefined;
  const i = cursor ? real.findIndex((r) => r.path === cursor) : -1;
  if (i < 0) return (delta > 0 ? real[0] : real[real.length - 1]).path;
  return real[Math.max(0, Math.min(real.length - 1, i + delta))].path;
}

/** The rows from a to b, in order. */
export function rangeOf(rows: readonly Row[], a: string, b: string): string[] {
  const i = rows.findIndex((r) => r.path === a);
  const j = rows.findIndex((r) => r.path === b);
  if (i < 0 || j < 0) return [b];
  const [lo, hi] = i < j ? [i, j] : [j, i];
  return rows
    .slice(lo, hi + 1)
    .filter((r) => !r.creating)
    .map((r) => r.path);
}

/** Paths without those below another of them (a folder and its files
 * moved together are the folder moved). */
export function topmost(paths: readonly string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && within(p, q)));
}

// ---- state changes ----

let generation = 0;

/** Shows machine m's tree rooted at root; another machine starts afresh. */
export function showRoot(m: string, root: string) {
  const s = useTree.getState();
  if (s.m === m && s.root === root) return;
  if (s.m !== m) {
    generation++;
    set({ m, root, dirs: {}, mtimes: {}, expanded: {}, selection: [], cursor: undefined, anchor: undefined, edit: undefined });
  } else set({ root, edit: undefined });
  if (!useTree.getState().dirs[root]?.entries) void loadDir(root);
}

/** Lists a directory (again). */
export async function loadDir(path: string) {
  const { m } = useTree.getState();
  if (!m) return;
  const gen = generation;
  set((s) => ({ dirs: { ...s.dirs, [path]: { ...s.dirs[path], loading: true } } }));
  try {
    const { entries } = await listDir(m, path);
    if (gen !== generation) return;
    set((s) => ({ dirs: { ...s.dirs, [path]: { entries } } }));
  } catch (e) {
    if (gen !== generation) return;
    set((s) => ({ dirs: { ...s.dirs, [path]: { error: e instanceof Error ? e.message : String(e) } } }));
  }
}

/** Lists the directories again whose entries a change touched. */
export function reloadDirs(paths: Iterable<string>) {
  const { dirs } = useTree.getState();
  for (const p of new Set(paths)) if (dirs[p]) void loadDir(p);
}

export function setExpanded(path: string, open: boolean) {
  set((s) => {
    const expanded = { ...s.expanded };
    if (open) expanded[path] = true;
    else delete expanded[path];
    return { expanded };
  });
  if (open && !useTree.getState().dirs[path]?.entries) void loadDir(path);
}

/** Collapses every directory. */
export function collapseAll() {
  set({ expanded: {} });
}

export function setFollow(follow: boolean) {
  savePref('files.follow', follow);
  set({ follow });
}

export function setHidden(hidden: boolean) {
  savePref('files.hidden', hidden);
  set({ hidden });
}

export function setFilter(filter: string) {
  set({ filter });
}

/** Selects path alone (or adds it, or a range from the anchor). */
export function select(path: string, how: 'only' | 'toggle' | 'range' = 'only', rows: readonly Row[] = []) {
  set((s) => {
    if (how === 'toggle') {
      const has = s.selection.includes(path);
      return { selection: has ? s.selection.filter((p) => p !== path) : [...s.selection, path], cursor: path, anchor: path };
    }
    if (how === 'range' && s.anchor) return { selection: rangeOf(rows, s.anchor, path), cursor: path };
    return { selection: [path], cursor: path, anchor: path };
  });
}

export function setEdit(edit: Edit | undefined) {
  set({ edit });
  if (edit && edit.kind !== 'rename') setExpanded(edit.path, true);
}

export function setClipboard(clipboard: Clipboard | undefined) {
  set({ clipboard });
}

/** The directories a poll checks: the root and the expanded directories
 * below it that are listed, at most MAX_POLLED. */
export const MAX_POLLED = 200;
export function polledDirs(s: Pick<TreeState, 'root' | 'expanded' | 'dirs'>): string[] {
  if (!s.root) return [];
  const out = [s.root];
  for (const p of Object.keys(s.expanded)) {
    if (out.length >= MAX_POLLED) break;
    if (p !== s.root && within(p, s.root) && s.dirs[p]?.entries) out.push(p);
  }
  return out;
}

/** Checks the shown directories' modification times and lists again those
 * that changed (and, once, those seen the first time: the listing may be
 * older than the time). A directory gone is dropped. */
export async function poll() {
  const s = useTree.getState();
  const paths = polledDirs(s);
  if (!s.m || !paths.length) return;
  const gen = generation;
  let entries: Entry[];
  try {
    entries = await filesApi.stat(s.m, paths);
  } catch {
    return; // offline: the next poll tries again
  }
  if (gen !== generation) return;
  const mtimes = { ...useTree.getState().mtimes };
  const changed: string[] = [];
  const gone: string[] = [];
  for (const e of entries) {
    if (!e.exists || !e.is_dir) {
      gone.push(e.path);
      continue;
    }
    if (mtimes[e.path] !== e.mtime) {
      mtimes[e.path] = e.mtime;
      changed.push(e.path);
    }
  }
  set((st) => {
    if (!gone.length) return { mtimes };
    const dirs = { ...st.dirs };
    const expanded = { ...st.expanded };
    for (const p of gone) {
      delete expanded[p];
      delete mtimes[p];
      if (p === st.root) dirs[p] = { error: 'not_found' };
      else delete dirs[p];
    }
    return { mtimes, dirs, expanded };
  });
  reloadDirs(changed);
}
