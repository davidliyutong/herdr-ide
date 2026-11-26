// The file explorer's colors for files of the repositories the Git plugin
// follows (state.ts): modified, added, untracked, deleted and conflicted
// files with their letter, and their folders in the color of the most
// pressing change inside, as VS Code's explorer shows them; what git
// ignores (and the git directory) in the muted text color, without a
// letter, everything inside an ignored folder too.

import type { FileDecoration } from '../files/decorations';
import { useTree } from '../files/tree';
import { t, type MessageKey } from '../../i18n';
import type { StatusFile } from './api';
import { useGit } from './state';

export type Mark = 'conflict' | 'deleted' | 'modified' | 'added' | 'untracked' | 'renamed';

/** The more pressing marks first. */
const ORDER: Mark[] = ['conflict', 'deleted', 'modified', 'renamed', 'added', 'untracked'];

/** VS Code's Git decoration colors (design tokens `git.*`). */
export const MARK_COLOR: Record<Mark, string> = {
  conflict: 'var(--ds-git-conflict)',
  deleted: 'var(--ds-git-deleted)',
  modified: 'var(--ds-git-modified)',
  renamed: 'var(--ds-git-renamed)',
  added: 'var(--ds-git-added)',
  untracked: 'var(--ds-git-untracked)',
};

/** What git ignores: the muted text color (design token color.muted). */
export const IGNORED_COLOR = 'var(--ds-color-muted)';

const LETTER: Record<Mark, string> = { conflict: '!', deleted: 'D', modified: 'M', renamed: 'R', added: 'A', untracked: 'U' };

/** How a file of the status shows in the explorer (both sides counted). */
export function markOf(f: StatusFile): Mark | undefined {
  if (f.kind === 'unmerged') return 'conflict';
  if (f.kind === 'untracked') return 'untracked';
  if (f.kind === 'ignored') return undefined;
  if (f.x === 'D' || f.y === 'D') return 'deleted';
  if (f.y === 'M' || f.y === 'T' || f.x === 'M' || f.x === 'T') return 'modified';
  if (f.kind === 'renamed') return 'renamed';
  if (f.x === 'A') return 'added';
  return 'modified';
}

const more = (a: Mark | undefined, b: Mark) => (a === undefined || ORDER.indexOf(b) < ORDER.indexOf(a) ? b : a);

/** A repository's status as the decorations read it. */
export interface DecoratedRepo {
  root: string;
  files: readonly StatusFile[];
  /** Paths git ignores (a directory with a trailing "/"). */
  ignored?: readonly string[];
}

/** A status's marks by folder (relative to the top level, '' for it):
 * each entry's most pressing mark and whether it is a file; all: the
 * repository's most pressing one. Built once per status. */
interface MarkIndex {
  dirs: Map<string, Map<string, { mark: Mark; file: boolean }>>;
  all?: Mark;
}
const markIndexes = new WeakMap<readonly StatusFile[], MarkIndex>();

function markIndex(files: readonly StatusFile[]): MarkIndex {
  let ix = markIndexes.get(files);
  if (ix) return ix;
  ix = { dirs: new Map() };
  for (const f of files) {
    const mark = markOf(f);
    if (!mark) continue;
    ix.all = more(ix.all, mark);
    // An untracked repository inside this one is listed as dir/.
    const parts = f.path.replace(/\/+$/, '').split('/');
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      let names = ix.dirs.get(dir);
      if (!names) ix.dirs.set(dir, (names = new Map()));
      const prev = names.get(parts[i]);
      names.set(parts[i], { mark: more(prev?.mark, mark), file: i === parts.length - 1 && !f.path.endsWith('/') && !f.submodule });
    }
  }
  markIndexes.set(files, ix);
  return ix;
}

/** A status's ignored paths: names by folder, and the ignored folders. */
interface IgnoredIndex {
  dirs: Map<string, Set<string>>;
  folders: Set<string>;
}
const ignoredIndexes = new WeakMap<readonly string[], IgnoredIndex>();

function ignoredIndex(paths: readonly string[]): IgnoredIndex {
  let ix = ignoredIndexes.get(paths);
  if (ix) return ix;
  ix = { dirs: new Map(), folders: new Set() };
  for (const p of paths) {
    const rel = p.replace(/\/+$/, '');
    if (!rel) continue;
    if (p.endsWith('/')) ix.folders.add(rel);
    const slash = rel.lastIndexOf('/');
    const dir = slash < 0 ? '' : rel.slice(0, slash);
    let names = ix.dirs.get(dir);
    if (!names) ix.dirs.set(dir, (names = new Set()));
    names.add(rel.slice(slash + 1));
  }
  ignoredIndexes.set(paths, ix);
  return ix;
}

const trim = (p: string) => p.replace(/\/+$/, '') || '/';
/** Whether p is dir or inside it. */
const within = (p: string, dir: string) => p === dir || p.startsWith(dir === '/' ? '/' : dir + '/');
/** p relative to dir (p within dir; '' for dir itself). */
const below = (p: string, dir: string) => (p === dir ? '' : p.slice(dir === '/' ? 1 : dir.length + 1));

/** Whether rel (relative to a top level) is inside a folder git ignores.
 * The git directory is none: git never lists it as ignored, and it has no
 * color, as in VS Code. */
function ignoredWhole(rel: string, ix: IgnoredIndex | undefined): boolean {
  if (!ix) return false;
  for (let p = rel; p; p = p.slice(0, Math.max(0, p.lastIndexOf('/')))) if (ix.folders.has(p)) return true;
  return false;
}

/**
 * The decorations of dir's entries from statuses of repositories of
 * machine m. Changes come from every repository dir is in or that is
 * below it; what is ignored from the innermost repository dir is in (a
 * repository inside another rules its own files). names gives the
 * entries of dir, for a dir whose every entry is ignored (a folder git
 * ignores, whose contents git does not list).
 */
export function decorate(repos: readonly DecoratedRepo[], dir: string, names?: () => readonly string[]): Record<string, FileDecoration> {
  const d = trim(dir);
  const marks = new Map<string, { mark: Mark; file: boolean }>();
  const merge = (name: string, mark: Mark, file: boolean) => {
    const prev = marks.get(name);
    marks.set(name, { mark: more(prev?.mark, mark), file });
  };
  let inner: { root: string; repo: DecoratedRepo } | undefined;
  for (const repo of repos) {
    const r = trim(repo.root);
    if (within(d, r)) {
      for (const [name, v] of markIndex(repo.files).dirs.get(below(d, r)) ?? []) merge(name, v.mark, v.file);
      if (!inner || r.length > inner.root.length) inner = { root: r, repo };
    } else if (within(r, d)) {
      // A repository below dir: the entry that leads to it.
      const all = markIndex(repo.files).all;
      if (all) merge(below(r, d).split('/')[0], all, false);
    }
  }
  const out: Record<string, FileDecoration> = {};
  for (const [name, { mark, file }] of marks) {
    out[name] = { color: MARK_COLOR[mark], badge: file ? LETTER[mark] : '•', tooltip: t(`git.mark.${mark}` as MessageKey) };
  }
  if (!inner) return out;
  // What is ignored, unless a change marks it.
  const dim = (name: string) => {
    if (!out[name]) out[name] = { color: IGNORED_COLOR, tooltip: t('git.mark.ignored') };
  };
  const rel = below(d, inner.root);
  const ix = inner.repo.ignored ? ignoredIndex(inner.repo.ignored) : undefined;
  if (ignoredWhole(rel, ix)) {
    for (const name of names?.() ?? []) dim(name);
    return out;
  }
  for (const name of ix?.dirs.get(rel) ?? []) dim(name);
  return out;
}

/** The names the explorer lists in a directory of machine m. */
function listed(m: string, dir: string): readonly string[] {
  const tree = useTree.getState();
  if (tree.m !== m) return [];
  return (tree.dirs[dir]?.entries ?? []).map((e) => e.name);
}

/** The provider the plugin registers with the explorer. */
export function gitDecorations(m: string, dir: string): Record<string, FileDecoration> | undefined {
  const repos: DecoratedRepo[] = [];
  for (const [k, s] of Object.entries(useGit.getState().repos)) {
    const [mm, root] = k.split('\u0000');
    if (mm !== m || !s.status) continue;
    repos.push({ root, files: s.status.files, ignored: s.status.ignored });
  }
  return repos.length ? decorate(repos, dir, () => listed(m, dir)) : undefined;
}
