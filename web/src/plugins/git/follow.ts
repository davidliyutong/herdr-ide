// What the Git plugin follows besides its own panel and panes: the
// repositories of the directories the file explorer shows (so its rows are
// colored by their changes, as in VS Code, with the Git panel closed) and of
// the files editors show, whose gutters compare the text with the index's
// (the editor's quick diff).

import { isPluginOn } from '../registry';
import { useShownDirs } from '../files/decorations';
import { registerQuickDiff } from '../files/quickDiff';
import { gitApi, type RepoInfo } from './api';
import { openDiff } from './ops';
import { repoKey, useGit, watchRepo } from './state';

/** How long a directory known not to be in a repository is not asked again. */
export const NOT_REPO_MS = 60_000;
/** The most texts of the index kept for editors. */
const MAX_ORIGINALS = 32;

const dirname = (p: string) => (p.lastIndexOf('/') > 0 ? p.slice(0, p.lastIndexOf('/')) : '/');
const inside = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : root + '/');

const known = new Map<string, { root?: string; at: number; pending?: Promise<string | undefined> }>();

/** The root of the repository a directory of m is in, if any; cached, a
 * directory found in none for NOT_REPO_MS. */
export function repoOf(m: string, dir: string): Promise<string | undefined> {
  const key = `${m}\u0000${dir}`;
  const c = known.get(key);
  if (c?.pending) return c.pending;
  if (c && (c.root || Date.now() - c.at < NOT_REPO_MS)) return Promise.resolve(c.root);
  const pending = gitApi
    .repo(m, dir)
    .then((info: RepoInfo) => info.root as string | undefined)
    .catch(() => undefined)
    .then((root) => {
      known.set(key, { root, at: Date.now() });
      return root;
    });
  known.set(key, { at: Date.now(), pending });
  return pending;
}

/** Watches a repository while leases on it are held. */
function lease(m: string, dir: string): () => void {
  let stop: (() => void) | undefined;
  let done = false;
  void repoOf(m, dir).then((root) => {
    if (!done && root) stop = watchRepo(m, root);
  });
  return () => {
    done = true;
    stop?.();
  };
}

// The explorer's directories: a lease per directory shown.
const shown = new Map<string, () => void>();
useShownDirs.subscribe(({ m, dirs }) => {
  const want = new Set(m && isPluginOn('git') ? dirs.map((d) => `${m}\u0000${d}`) : []);
  for (const [k, stop] of shown) if (!want.has(k)) (stop(), shown.delete(k));
  for (const k of want) {
    if (shown.has(k)) continue;
    const [mm, d] = k.split('\u0000');
    shown.set(k, lease(mm, d));
  }
});

const originals = new Map<string, Promise<string | undefined>>();

/** The index's text of a file, for the editor's quick diff; read again when
 * its repository changed (its version). */
async function original(m: string, path: string): Promise<string | undefined> {
  if (!isPluginOn('git')) return undefined;
  const root = await repoOf(m, dirname(path));
  if (!root || !inside(path, root) || path === root) return undefined;
  const rel = path.slice(root === '/' ? 1 : root.length + 1);
  const version = useGit.getState().repos[repoKey(m, root)]?.version ?? 0;
  const key = `${m}\u0000${root}\u0000${rel}\u0000${version}`;
  let p = originals.get(key);
  if (!p) {
    p = gitApi
      .blob(m, root, rel, 'index')
      .then((b) => (b.exists && !b.binary && !b.tooLarge ? b.text : undefined))
      .catch(() => undefined);
    originals.set(key, p);
    while (originals.size > MAX_ORIGINALS) originals.delete(originals.keys().next().value!);
  }
  return p;
}

registerQuickDiff({
  follow: (m, path) => (isPluginOn('git') ? lease(m, dirname(path)) : () => {}),
  original,
  openChanges: (m, path) => {
    void repoOf(m, dirname(path)).then((root) => {
      if (root && inside(path, root))
        void openDiff(m, { repo: root, path: path.slice(root === '/' ? 1 : root.length + 1), mode: 'worktree' });
    });
  },
});
