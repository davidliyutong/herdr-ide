// The file explorer's tree (docs/features/28-file-explorer.md): the
// machine and root it shows, the directories it has listed and expanded,
// the selection, the filter, the clipboard and the name being edited, and
// the rows that come out of them. Directories are listed when expanded
// (/api/m/{id}/list) and listed again when their modification time
// changes; the panel polls the shown ones while it is shown (poll). Only
// the listings of the root and the expanded directories below it are
// kept.

import { create } from 'zustand';
import { listDir, type RemoteStat } from '../../lib/files';
import { loadPref, savePref } from '../../state/store';
import { settingValue, useSettings } from '../../settings';
import { selectAll, selectOnly, selectRange, selectToggle, type NavRow } from '../../components/tree/selection';
import { filesApi, type Entry } from './api';

/** A directory's listing; error is why the last listing failed (the
 * entries listed before are kept), failures how many failed in a row. */
export interface Dir {
  entries?: RemoteStat[];
  error?: string;
  failures?: number;
  loading?: boolean;
}

/** The error the tree shows for a directory: when nothing of it is listed,
 * or when its listing failed again. A listing that fails once (a machine
 * busy unpacking an archive, a request that timed out) keeps the entries
 * without a word, and the next poll lists it again. */
export function shownError(d: Dir | undefined): string | undefined {
  if (!d?.error) return undefined;
  return !d.entries || (d.failures ?? 0) > 1 ? d.error : undefined;
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
  /** The workspace (of machine m) the root was taken for. */
  ws?: string;
  root?: string;
  /** The root follows the focused terminal's directory: this browser's
   * choice, else the setting files.followFocus. */
  follow: boolean;
  /** Hidden files (names starting with a dot) are shown: this browser's
   * choice, else the setting files.showHidden. */
  hidden: boolean;
  /** Patterns of names never shown (the setting files.exclude). */
  exclude?: readonly string[];
  /** How a folder's entries are ordered (the setting files.sortOrder). */
  sort?: SortOrder;
  filter: string;
  /** Expanded directories, by path (also outside the root, so going back
   * shows a directory as it was; at most MAX_EXPANDED). */
  expanded: Record<string, true>;
  /** The listings of the root and the expanded directories below it. */
  dirs: Record<string, Dir>;
  /** Directories' modification times when they were last listed after a
   * poll saw them. */
  mtimes: Record<string, number>;
  selection: string[];
  /** The row the keyboard is on. */
  cursor?: string;
  /** Where a shift-click or shift-arrow selection starts. */
  anchor?: string;
  clipboard?: Clipboard;
  edit?: Edit;
}

/** Orders of a folder's entries, as VS Code's explorer.sortOrder: folders
 * first (default), mixed, files first, by type (extension) or modified
 * (newest first), each by name as people sort (a2 before a10) after. */
export type SortOrder = 'default' | 'mixed' | 'filesFirst' | 'type' | 'modified';
export const SORT_ORDERS: readonly SortOrder[] = ['default', 'mixed', 'filesFirst', 'type', 'modified'];

/** What the settings decide: the switches this browser did not set, the
 * names excluded and the order. */
export function fromSettings(): Pick<TreeState, 'follow' | 'hidden' | 'exclude' | 'sort'> {
  const exclude = settingValue('files.exclude');
  const sort = settingValue('files.sortOrder');
  return {
    follow: loadPref<boolean | null>('files.follow', null) ?? settingValue('files.followFocus') !== false,
    hidden: loadPref<boolean | null>('files.hidden', null) ?? settingValue('files.showHidden') === true,
    exclude: Array.isArray(exclude) ? exclude : [],
    sort: SORT_ORDERS.includes(sort as SortOrder) ? (sort as SortOrder) : 'default',
  };
}

export const useTree = create<TreeState>(() => ({
  ...fromSettings(),
  filter: '',
  expanded: {},
  dirs: {},
  mtimes: {},
  selection: [],
}));

const set = (p: Partial<TreeState> | ((s: TreeState) => Partial<TreeState>)) => useTree.setState(p);

useSettings.subscribe((st, prev) => {
  if (st.values !== prev.values) set(fromSettings());
});

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

const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1) : '';
};

/** A folder's entries in order. */
export function sortEntries(entries: readonly RemoteStat[], order: SortOrder = 'default'): RemoteStat[] {
  return [...entries].sort((a, b) => {
    if (order !== 'mixed' && a.is_dir !== b.is_dir) return (a.is_dir ? -1 : 1) * (order === 'filesFirst' ? -1 : 1);
    if (order === 'type' && !a.is_dir && !b.is_dir) {
      const c = collator.compare(extOf(a.name), extOf(b.name));
      if (c) return c;
    }
    if (order === 'modified' && b.mtime !== a.mtime) return b.mtime - a.mtime;
    return collator.compare(a.name, b.name);
  });
}

/** A glob of a name as a regular expression: * any characters, ? one,
 * [abc] or [!abc] one of them or not; a leading **\/ (VS Code's form)
 * matches a name too. Undefined for an empty pattern. */
function globRe(pattern: string): RegExp | undefined {
  const p = pattern.replace(/^(\*\*\/)+/, '');
  if (!p) return undefined;
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = p.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        let body = p.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (body.startsWith('!')) body = '^' + body.slice(1);
        re += `[${body}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return undefined;
  }
}

const excluders = new WeakMap<readonly string[], (name: string) => boolean>();

/** Whether a name matches one of the patterns (files.exclude). */
export function excluded(patterns: readonly string[] | undefined, name: string): boolean {
  if (!patterns?.length) return false;
  let test = excluders.get(patterns);
  if (!test) {
    const res = patterns.map(globRe).filter((r): r is RegExp => !!r);
    test = (n: string) => res.some((r) => r.test(n));
    excluders.set(patterns, test);
  }
  return test(name);
}

/** The tree's rows: the root's entries and those of the expanded
 * directories below it, in the order set, without hidden files unless
 * shown and without the names excluded. A filter keeps the entries whose
 * names hold it, and the directories (listed before) that lead to one,
 * opened. */
export function treeRows(s: Pick<TreeState, 'root' | 'dirs' | 'expanded' | 'hidden' | 'filter' | 'edit' | 'exclude' | 'sort'>): Row[] {
  if (!s.root) return [];
  const needle = s.filter.trim().toLowerCase();
  const match = (name: string) => name.toLowerCase().includes(needle);
  const walk = (dir: string, depth: number, out: Row[]) => {
    if (s.edit && s.edit.kind !== 'rename' && s.edit.path === dir) {
      out.push({ path: dir, name: '', depth, dir: s.edit.kind === 'folder', expanded: false, creating: s.edit.kind });
    }
    const entries = s.dirs[dir]?.entries;
    if (!entries) return;
    for (const e of sortEntries(entries, s.sort)) {
      if ((!s.hidden && e.name.startsWith('.')) || excluded(s.exclude, e.name)) continue;
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

/** The paths of the rows the keyboard and selection go over (not a name
 * being typed). */
export function rowIds(rows: readonly Row[]): string[] {
  return rows.filter((r) => !r.creating).map((r) => r.path);
}

/** The rows as the keyboard sees them (components/tree/selection.ts): ←
 * goes to the folder, → into a folder, type-ahead by name. */
export function navRows(rows: readonly Row[]): NavRow[] {
  return rows.map((r) => ({
    id: r.path,
    parent: parentOf(r.path),
    expanded: r.dir && !r.creating ? r.expanded : undefined,
    label: r.name,
    skip: !!r.creating,
  }));
}

/** Paths without those below another of them (a folder and its files
 * moved together are the folder moved). */
export function topmost(paths: readonly string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && within(p, q)));
}

// ---- state changes ----

let generation = 0;

/** At most this many expanded directories are remembered; beyond it the
 * oldest outside the root are forgotten when the root moves. */
export const MAX_EXPANDED = 500;

/** The directories the tree shows: the root and the expanded directories
 * below it whose parents are shown too (not those in a collapsed folder,
 * in an excluded one, or, while hidden files are not shown, in a hidden
 * one). */
export function shownDirs(s: Pick<TreeState, 'root' | 'expanded' | 'hidden' | 'exclude'>): string[] {
  const root = s.root;
  if (!root) return [];
  const shown = (p: string) => {
    for (let d = p; d !== root; d = parentOf(d)) {
      const name = baseName(d);
      if (!s.expanded[d] || (!s.hidden && name.startsWith('.')) || excluded(s.exclude, name)) return false;
    }
    return true;
  };
  return [root, ...Object.keys(s.expanded).filter((p) => p !== root && within(p, root) && shown(p))];
}

/** What is kept of the listings, times and expanded directories with root
 * shown: the listings and times of root and the expanded directories
 * below it. */
function pruned(s: TreeState, root: string): Pick<TreeState, 'dirs' | 'mtimes' | 'expanded'> {
  const keep = (p: string) => p === root || (!!s.expanded[p] && within(p, root));
  const dirs = Object.fromEntries(Object.entries(s.dirs).filter(([p]) => keep(p)));
  const mtimes = Object.fromEntries(Object.entries(s.mtimes).filter(([p]) => keep(p)));
  const paths = Object.keys(s.expanded);
  let over = paths.length - MAX_EXPANDED;
  const expanded: Record<string, true> = {};
  for (const p of paths) {
    if (over > 0 && !within(p, root)) over--;
    else expanded[p] = true;
  }
  return { dirs, mtimes, expanded };
}

/** Shows machine m's tree rooted at root, taken for its workspace ws (the
 * one recorded before on the same machine when not given); another machine
 * starts afresh. Another root clears the selection (its rows may be gone,
 * and a key must not act on rows not shown) and keeps only what is below
 * it. */
export function showRoot(m: string, root: string, ws?: string) {
  const s = useTree.getState();
  const place = ws ?? (s.m === m ? s.ws : undefined);
  if (s.m === m && s.root === root) {
    if (s.ws !== place) set({ ws: place });
    return;
  }
  if (s.m !== m) {
    generation++;
    set({ m, ws: place, root, dirs: {}, mtimes: {}, expanded: {}, selection: [], cursor: undefined, anchor: undefined, edit: undefined });
  } else set((st) => ({ ws: place, root, ...pruned(st, root), selection: [], cursor: undefined, anchor: undefined, edit: undefined }));
  const st = useTree.getState();
  for (const p of shownDirs(st)) if (!st.dirs[p]?.entries && !st.dirs[p]?.loading) void loadDir(p);
}

/** Lists a directory (again). A failure keeps the entries listed before,
 * with the error beside them (shownError), and forgets the time recorded
 * for it: the next poll lists it again, whatever started this listing.
 * mtime is the modification time a poll saw, recorded once the listing
 * succeeds. A listing of a directory no longer below the root is dropped. */
export async function loadDir(path: string, mtime?: number) {
  const { m } = useTree.getState();
  if (!m) return;
  const gen = generation;
  set((s) => ({ dirs: { ...s.dirs, [path]: { ...s.dirs[path], loading: true } } }));
  const wanted = (s: TreeState) => gen === generation && !!s.root && within(path, s.root);
  try {
    // An empty directory's entries may come as null.
    const entries = (await listDir(m, path)).entries ?? [];
    set((s) => {
      if (!wanted(s)) return {};
      const dirs = { ...s.dirs, [path]: { entries } };
      return mtime === undefined ? { dirs } : { dirs, mtimes: { ...s.mtimes, [path]: mtime } };
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    set((s) => {
      if (!wanted(s)) return {};
      const was = s.dirs[path];
      const mtimes = { ...s.mtimes };
      delete mtimes[path];
      return { dirs: { ...s.dirs, [path]: { entries: was?.entries, error, failures: (was?.failures ?? 0) + 1 } }, mtimes };
    });
  }
}

/** Lists the directories again whose entries a change touched. */
export function reloadDirs(paths: Iterable<string>) {
  const { dirs } = useTree.getState();
  for (const p of new Set(paths)) if (dirs[p]) void loadDir(p);
}

/** Lists the shown directories again (Refresh). */
export function refresh() {
  for (const p of shownDirs(useTree.getState())) void loadDir(p);
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

/** Collapses every directory (and forgets their listings). */
export function collapseAll() {
  set((s) => (s.root ? pruned({ ...s, expanded: {} }, s.root) : { expanded: {} }));
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
  set((s) => (how === 'toggle' ? selectToggle(s, path) : how === 'range' ? selectRange(s, rowIds(rows), path) : selectOnly(path)));
}

/** Selects every row shown (⌘/Ctrl+A). */
export function selectAllRows(rows: readonly Row[]) {
  set((s) => selectAll(s, rowIds(rows)));
}

export function setEdit(edit: Edit | undefined) {
  set({ edit });
  if (edit && edit.kind !== 'rename') setExpanded(edit.path, true);
}

export function setClipboard(clipboard: Clipboard | undefined) {
  set({ clipboard });
}

/** The directories a poll checks: the shown ones (the root, and the
 * expanded directories below it not in a collapsed folder) that are
 * listed or whose listing failed, at most MAX_POLLED. */
export const MAX_POLLED = 200;
export function polledDirs(s: Pick<TreeState, 'root' | 'expanded' | 'dirs' | 'hidden' | 'exclude'>): string[] {
  return shownDirs(s)
    .filter((p) => p === s.root || s.dirs[p]?.entries || s.dirs[p]?.error)
    .slice(0, MAX_POLLED);
}

/** Checks the shown directories' modification times and lists again those
 * that changed (and, once, those seen the first time: the listing may be
 * older than the time). A directory gone is dropped; one whose state is
 * not known (a mount that does not answer) stays as it is. A failed stat
 * rejects (the poller waits longer); it ends when the listings it started
 * do. */
export async function poll() {
  const s = useTree.getState();
  const paths = polledDirs(s);
  if (!s.m || !paths.length) return;
  const gen = generation;
  const entries: Entry[] = await filesApi.stat(s.m, paths);
  if (gen !== generation) return;
  const { mtimes } = useTree.getState();
  const changed: Array<[string, number]> = [];
  const gone: string[] = [];
  for (const e of entries) {
    if (e.error) continue;
    if (!e.exists || !e.is_dir) gone.push(e.path);
    else if (mtimes[e.path] !== e.mtime) changed.push([e.path, e.mtime]);
  }
  if (gone.length) {
    set((st) => {
      const dirs = { ...st.dirs };
      const expanded = { ...st.expanded };
      const mtimes = { ...st.mtimes };
      for (const p of gone) {
        delete expanded[p];
        delete mtimes[p];
        if (p === st.root) dirs[p] = { error: 'not_found' };
        else delete dirs[p];
      }
      return { mtimes, dirs, expanded };
    });
  }
  await Promise.all(changed.map(([p, mtime]) => loadDir(p, mtime)));
}
