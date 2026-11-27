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
import { filesApi, FilesError, type Entry, type FindMatch } from './api';

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

/** Result of the whole-project recursive filename search for the active filter. */
export interface FilterSearch {
  key: string;
  matches?: FindMatch[];
  truncated?: boolean;
  loading?: boolean;
  error?: string;
  errorCode?: string;
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
  /** Interpret filter as a case-insensitive regular expression. */
  filterRegex: boolean;
  /** Whole-project recursive matches for the current filter, fetched from the machine. */
  filterSearch?: FilterSearch;
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
  filterRegex: false,
  expanded: {},
  dirs: {},
  mtimes: {},
  selection: [],
}));

const set = (p: Partial<TreeState> | ((s: TreeState) => Partial<TreeState>)) => useTree.setState(p);

useSettings.subscribe((st, prev) => {
  if (st.values !== prev.values) {
    set(fromSettings());
    const cur = useTree.getState();
    if (compileFilter(cur.filter, cur.filterRegex).active) scheduleFilterSearch(false);
  }
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

/** Compiled form of the explorer's filename filter (plain substring or JS RegExp). */
export interface CompiledFilter {
  active: boolean;
  query: string;
  needle: string;
  re?: RegExp;
  matchPath: boolean;
  error?: string;
}

export function compileFilter(filter: string, regex = false): CompiledFilter {
  const query = regex ? filter : filter.trim();
  if (!query) return { active: false, query: '', needle: '', matchPath: false };
  const matchPath = query.includes('/');
  if (!regex) {
    const needle = query.replace(/^\.\//, '').toLowerCase();
    return { active: needle !== '', query, needle, matchPath: needle.includes('/') };
  }
  try {
    return { active: true, query, needle: '', re: new RegExp(query, 'i'), matchPath };
  } catch (e) {
    return { active: true, query, needle: '', matchPath, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Whether a single file/folder matches the compiled filter. */
function filterMatches(c: CompiledFilter, name: string, rel: string): boolean {
  if (!c.active) return true;
  if (c.error) return false;
  if (c.re) return c.re.test(name) || (c.matchPath && c.re.test(rel));
  if (c.matchPath) return rel.toLowerCase().includes(c.needle);
  return name.toLowerCase().includes(c.needle);
}

/** Character ranges in name matched by the active filter (for highlighting). */
export function filterHighlight(name: string, filter: string, regex = false): Array<[number, number]> | undefined {
  const c = compileFilter(filter, regex);
  if (!c.active || c.error) return undefined;
  if (!regex) {
    const lower = name.toLowerCase();
    const target = c.matchPath ? (c.needle.split('/').filter(Boolean).pop() ?? '') : c.needle;
    if (!target) return undefined;
    const at = lower.indexOf(target);
    return at < 0 ? undefined : [[at, at + target.length]];
  }
  const ranges: Array<[number, number]> = [];
  let g: RegExp;
  try {
    g = new RegExp(c.query, 'gi');
  } catch {
    return undefined;
  }
  let m: RegExpExecArray | null;
  while ((m = g.exec(name)) !== null && ranges.length < 64) {
    if (m[0].length === 0) {
      if (g.lastIndex >= name.length) break;
      g.lastIndex++;
      continue;
    }
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges.length ? ranges : undefined;
}

/** Stable cache key for whole-project recursive filter results. */
export function filterSearchKey(
  s: Pick<TreeState, 'root' | 'filter' | 'hidden' | 'exclude'> & Partial<Pick<TreeState, 'm' | 'filterRegex'>>,
): string {
  return `${s.m ?? ''}\0${s.root ?? ''}\0${s.filterRegex ? '1' : '0'}\0${s.hidden ? '1' : '0'}\0${(s.exclude ?? []).join('\x1f')}\0${s.filter}`;
}

/** The tree's rows: the root's entries and those of the expanded
 * directories below it, in the order set, without hidden files unless
 * shown and without the names excluded. A filter searches across the whole
 * project (when recursive matches are loaded) or falls back to listed
 * folders, keeping matching files/folders and auto-expanding their ancestors. */
export function treeRows(
  s: Pick<TreeState, 'root' | 'dirs' | 'expanded' | 'hidden' | 'filter' | 'edit' | 'exclude' | 'sort'> &
    Partial<Pick<TreeState, 'm' | 'filterRegex' | 'filterSearch'>>,
): Row[] {
  if (!s.root) return [];
  const root = s.root;
  const compiled = compileFilter(s.filter, !!s.filterRegex);
  if (compiled.error) return [];

  // When whole-project recursive search results are available for the active
  // filter, build a virtual tree containing all matched paths and their
  // ancestor directories auto-expanded.
  const searchKey = compiled.active ? filterSearchKey(s) : '';
  if (compiled.active && s.filterSearch?.key === searchKey && s.filterSearch.matches) {
    const children = new Map<string, Map<string, RemoteStat>>();
    const ensure = (parent: string, name: string, isDir: boolean) => {
      let map = children.get(parent);
      if (!map) {
        map = new Map();
        children.set(parent, map);
      }
      const existing = map.get(name);
      if (existing) {
        if (isDir && !existing.is_dir) existing.is_dir = true;
        return;
      }
      const loaded = s.dirs[parent]?.entries?.find((e) => e.name === name);
      map.set(name, loaded ? { ...loaded, is_dir: loaded.is_dir || isDir } : { name, is_dir: isDir, size: 0, mode: 0, mtime: 0 });
    };
    const hasMatchDescendant = new Set<string>();
    for (const m of s.filterSearch.matches) {
      if (!within(m.path, root) || m.path === root) continue;
      const rel = relativePath(root, m.path);
      const segs = rel.split('/').filter(Boolean);
      if (!segs.length) continue;
      if (segs.some((seg) => (!s.hidden && seg.startsWith('.')) || excluded(s.exclude, seg))) continue;
      let dir = root;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const isLast = i === segs.length - 1;
        const isDir = isLast ? !!m.is_dir : true;
        ensure(dir, seg, isDir);
        const next = join(dir, seg);
        if (!isLast) hasMatchDescendant.add(next);
        dir = next;
      }
    }
    const walkSearch = (dir: string, depth: number, out: Row[]) => {
      if (s.edit && s.edit.kind !== 'rename' && s.edit.path === dir) {
        out.push({ path: dir, name: '', depth, dir: s.edit.kind === 'folder', expanded: false, creating: s.edit.kind });
      }
      const map = children.get(dir);
      if (!map) return;
      for (const e of sortEntries([...map.values()], s.sort)) {
        const path = join(dir, e.name);
        const expanded = e.is_dir && (hasMatchDescendant.has(path) || !!s.expanded[path]);
        const row: Row = {
          path,
          name: e.name,
          depth,
          dir: e.is_dir,
          expanded,
          link: (e as { is_link?: boolean }).is_link,
        };
        out.push(row);
        if (e.is_dir && expanded) walkSearch(path, depth + 1, out);
      }
    };
    const out: Row[] = [];
    walkSearch(root, 0, out);
    return out;
  }

  const walk = (dir: string, depth: number, out: Row[]) => {
    if (s.edit && s.edit.kind !== 'rename' && s.edit.path === dir) {
      out.push({ path: dir, name: '', depth, dir: s.edit.kind === 'folder', expanded: false, creating: s.edit.kind });
    }
    const entries = s.dirs[dir]?.entries;
    if (!entries) return;
    for (const e of sortEntries(entries, s.sort)) {
      if ((!s.hidden && e.name.startsWith('.')) || excluded(s.exclude, e.name)) continue;
      const path = join(dir, e.name);
      const rel = relativePath(root, path);
      const row: Row = {
        path,
        name: e.name,
        depth,
        dir: e.is_dir,
        expanded: !!s.expanded[path],
        link: (e as { is_link?: boolean }).is_link,
      };
      if (!e.is_dir) {
        if (!compiled.active || filterMatches(compiled, e.name, rel)) out.push(row);
        continue;
      }
      if (!compiled.active) {
        out.push(row);
        if (row.expanded) walk(path, depth + 1, out);
        continue;
      }
      const kids: Row[] = [];
      walk(path, depth + 1, kids);
      if (kids.length || filterMatches(compiled, e.name, rel)) {
        row.expanded = kids.length > 0;
        out.push(row, ...kids);
      }
    }
  };
  const out: Row[] = [];
  walk(root, 0, out);
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
/** At most this many (machine, root) UI states are remembered across tab/root switches. */
export const MAX_TREE_MEMORY = 32;

export interface TreeMemory {
  expanded: Record<string, true>;
  selection: string[];
  cursor?: string;
  anchor?: string;
  filter: string;
  filterRegex?: boolean;
  scrollTop: number;
}

const treeMemory = new Map<string, TreeMemory>();
const memKey = (m: string, root: string) => `${m}\u0000${root}`;
let lastAutoRevealed: string | undefined;

export const getLastAutoRevealed = () => lastAutoRevealed;
export const setLastAutoRevealed = (key: string | undefined) => {
  lastAutoRevealed = key;
};

/** Reveal requests (auto-reveal or explicit Reveal in Explorer) for FilesPanel to scroll into view. */
export const useReveal = create<{ path?: string; seq: number }>(() => ({ seq: 0 }));

export function requestReveal(path: string) {
  useReveal.setState((r) => ({ path, seq: r.seq + 1 }));
}

function putMemory(m: string, root: string, mem: TreeMemory) {
  const k = memKey(m, root);
  treeMemory.delete(k);
  treeMemory.set(k, mem);
  while (treeMemory.size > MAX_TREE_MEMORY) treeMemory.delete(treeMemory.keys().next().value!);
}

function saveTreeMemory(s: TreeState) {
  if (!s.m || !s.root) return;
  const prevScroll = treeMemory.get(memKey(s.m, s.root))?.scrollTop ?? 0;
  putMemory(s.m, s.root, {
    expanded: Object.fromEntries(Object.entries(s.expanded).filter(([p]) => within(p, s.root!))),
    selection: [...s.selection],
    cursor: s.cursor,
    anchor: s.anchor,
    filter: s.filter,
    filterRegex: s.filterRegex,
    scrollTop: prevScroll,
  });
}

export function getScrollMemory(m: string, root: string): number {
  return treeMemory.get(memKey(m, root))?.scrollTop ?? 0;
}

export function setScrollMemory(m: string, root: string, scrollTop: number) {
  const s = useTree.getState();
  const same = s.m === m && s.root === root;
  const prev = treeMemory.get(memKey(m, root));
  putMemory(m, root, {
    expanded: same ? Object.fromEntries(Object.entries(s.expanded).filter(([p]) => within(p, root))) : (prev?.expanded ?? {}),
    selection: same ? [...s.selection] : (prev?.selection ?? []),
    cursor: same ? s.cursor : prev?.cursor,
    anchor: same ? s.anchor : prev?.anchor,
    filter: same ? s.filter : (prev?.filter ?? ''),
    filterRegex: same ? s.filterRegex : prev?.filterRegex,
    scrollTop,
  });
}

/** Debounce delay before querying the machine for whole-project filename matches. */
export const FILTER_SEARCH_MS = 150;
/** Maximum matches fetched for the explorer's whole-project filename filter. */
export const FILTER_FIND_LIMIT = 500;

let filterTimer: ReturnType<typeof setTimeout> | undefined;
let filterAbort: AbortController | undefined;

function cancelFilterSearch() {
  if (filterTimer !== undefined) {
    clearTimeout(filterTimer);
    filterTimer = undefined;
  }
  if (filterAbort) {
    filterAbort.abort();
    filterAbort = undefined;
  }
}

/** Queries the machine recursively for files and directories matching the
 * active explorer filter across the whole project. */
export function scheduleFilterSearch(debounced = true) {
  cancelFilterSearch();
  const s = useTree.getState();
  const compiled = compileFilter(s.filter, s.filterRegex);
  if (!s.m || !s.root || !compiled.active) {
    if (s.filterSearch !== undefined) set({ filterSearch: undefined });
    return;
  }
  const key = filterSearchKey(s);
  if (compiled.error) {
    set({ filterSearch: { key, error: compiled.error, errorCode: 'bad_regex' } });
    return;
  }
  const prev = s.filterSearch;
  set({
    filterSearch: prev && prev.key === key ? { ...prev, loading: true, error: undefined, errorCode: undefined } : { key, loading: true },
  });
  const m = s.m;
  const root = s.root;
  const gen = generation;
  const run = async () => {
    filterTimer = undefined;
    const ac = new AbortController();
    filterAbort = ac;
    try {
      const res = await filesApi.find(
        m,
        {
          dir: root,
          query: compiled.query,
          match: 'name',
          regex: s.filterRegex,
          hidden: s.hidden,
          exclude: s.exclude,
          limit: FILTER_FIND_LIMIT,
        },
        ac.signal,
      );
      if (ac.signal.aborted || gen !== generation) return;
      if (filterSearchKey(useTree.getState()) !== key) return;
      set({ filterSearch: { key, matches: res.matches, truncated: res.truncated, loading: false } });
    } catch (e) {
      if (ac.signal.aborted || gen !== generation) return;
      if (filterSearchKey(useTree.getState()) !== key) return;
      if (e instanceof FilesError) {
        // Older agents without /find fall back silently to already-listed folders.
        if (e.code === 'unknown_plugin' || e.code === 'plugin_disabled' || e.code === 'http_404') {
          set({ filterSearch: undefined });
          return;
        }
        set({ filterSearch: { key, error: e.message, errorCode: e.code, loading: false } });
        return;
      }
      set({ filterSearch: { key, error: e instanceof Error ? e.message : String(e), loading: false } });
    } finally {
      if (filterAbort === ac) filterAbort = undefined;
    }
  };
  if (debounced) filterTimer = setTimeout(() => void run(), FILTER_SEARCH_MS);
  else void run();
}

export function resetTreeMemory() {
  cancelFilterSearch();
  treeMemory.clear();
  lastAutoRevealed = undefined;
  useReveal.setState({ path: undefined, seq: 0 });
}

useTree.subscribe((st, prev) => {
  if (st.m === undefined && st.root === undefined && (prev.m !== undefined || prev.root !== undefined)) {
    resetTreeMemory();
  }
});

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
 * starts afresh unless visited before. UI state (expanded directories,
 * selection, cursor, anchor, filter, scroll) is persisted per (m, root)
 * across switches. */
export function showRoot(m: string, root: string, ws?: string) {
  const s = useTree.getState();
  const place = ws ?? (s.m === m ? s.ws : undefined);
  if (s.m === m && s.root === root) {
    if (s.ws !== place) set({ ws: place });
    return;
  }
  saveTreeMemory(s);
  const mem = treeMemory.get(memKey(m, root));
  if (mem) {
    // Refresh LRU order.
    treeMemory.delete(memKey(m, root));
    treeMemory.set(memKey(m, root), mem);
  }
  if (s.m !== m) {
    generation++;
    set({
      m,
      ws: place,
      root,
      dirs: {},
      mtimes: {},
      expanded: mem ? { ...mem.expanded } : {},
      selection: mem ? [...mem.selection] : [],
      cursor: mem?.cursor,
      anchor: mem?.anchor,
      filter: mem?.filter ?? '',
      filterRegex: mem?.filterRegex ?? false,
      filterSearch: undefined,
      edit: undefined,
    });
  } else {
    set((st) => {
      const p = pruned(st, root);
      const merged = mem ? { ...p.expanded, ...mem.expanded } : p.expanded;
      const expanded = Object.keys(merged).length > MAX_EXPANDED ? pruned({ ...st, expanded: merged }, root).expanded : merged;
      return {
        ws: place,
        root,
        ...p,
        expanded,
        selection: mem ? [...mem.selection] : [],
        cursor: mem?.cursor,
        anchor: mem?.anchor,
        filter: mem ? mem.filter : '',
        filterRegex: mem?.filterRegex ?? false,
        filterSearch: undefined,
        edit: undefined,
      };
    });
  }
  const st = useTree.getState();
  for (const p of shownDirs(st)) if (!st.dirs[p]?.entries && !st.dirs[p]?.loading) void loadDir(p);
  if (compileFilter(st.filter, st.filterRegex).active) scheduleFilterSearch(false);
  else cancelFilterSearch();
}

/** Expands all ancestor folders of path within the current root, loads any
 * unlisted directories along the way, selects path and requests scrolling it
 * into view. Returns false if path is not strictly inside the current root. */
export function revealVisiblePath(path: string): boolean {
  const s = useTree.getState();
  if (!s.root || !within(path, s.root) || path === s.root) return false;
  const toExpand: string[] = [];
  for (let d = parentOf(path); within(d, s.root) && d !== s.root; d = parentOf(d)) {
    if (!s.expanded[d]) toExpand.push(d);
  }
  if (toExpand.length) {
    set((st) => {
      const expanded = { ...st.expanded };
      for (const d of toExpand) expanded[d] = true;
      return { expanded };
    });
  }
  const st = useTree.getState();
  for (const d of shownDirs(st)) if (!st.dirs[d]?.entries && !st.dirs[d]?.loading) void loadDir(d);
  select(path);
  requestReveal(path);
  return true;
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
  const s = useTree.getState();
  for (const p of new Set(paths)) if (s.dirs[p]) void loadDir(p);
  if (compileFilter(s.filter, s.filterRegex).active) scheduleFilterSearch(false);
}

/** Lists the shown directories again (Refresh). */
export function refresh() {
  const s = useTree.getState();
  for (const p of shownDirs(s)) void loadDir(p);
  if (compileFilter(s.filter, s.filterRegex).active) scheduleFilterSearch(false);
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
  const s = useTree.getState();
  if (compileFilter(s.filter, s.filterRegex).active) scheduleFilterSearch(false);
}

export function setFilter(filter: string) {
  set({ filter });
  scheduleFilterSearch(true);
}

export function setFilterRegex(filterRegex: boolean) {
  set({ filterRegex });
  scheduleFilterSearch(false);
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
