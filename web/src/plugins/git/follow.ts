// What the Git plugin follows besides its own panel and panes: the
// repositories of the directories the file explorer shows (so its rows are
// colored by their changes, as in VS Code, with the Git panel closed) and of
// the files editors show, whose gutters compare the text with the index's
// (the editor's quick diff). Leases watch only while the plugin is on.

import { useSettings } from '../../settings';
import { isPluginOn, usePluginList } from '../registry';
import { useShownDirs } from '../files/decorations';
import { registerQuickDiff } from '../files/quickDiff';
import { gitApi, isAbortError, limitGitRead, noRepo } from './api';
import { openDiff } from './ops';
import { onForgetRepos, repoKey, RETRY_MS, seedRepoInfo, useGit, watchRepo } from './state';

/** How long a directory known not to be in a repository is not asked again. */
export const NOT_REPO_MS = 60_000;
/** The most texts of the index kept for editors. */
const MAX_ORIGINALS = 32;

const dirname = (p: string) => (p.lastIndexOf('/') > 0 ? p.slice(0, p.lastIndexOf('/')) : '/');
const inside = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : root + '/');

interface PendingRepo {
  promise: Promise<string | undefined>;
  waiters: number;
  ac: AbortController;
}

const known = new Map<string, { root?: string; nested?: string[]; at: number; pending?: PendingRepo }>();
onForgetRepos(() => {
  for (const c of known.values()) c.pending?.ac.abort();
  known.clear();
});

function awaitRepo(key: string, pending: PendingRepo, signal?: AbortSignal): Promise<string | undefined> {
  if (!signal) return pending.promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  pending.waiters++;
  let done = false;
  const drop = () => {
    if (done) return;
    done = true;
    pending.waiters--;
    if (pending.waiters <= 0) {
      if (known.get(key)?.pending === pending) known.delete(key);
      pending.ac.abort();
    }
  };
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      drop();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        done = true;
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        done = true;
        reject(e);
      },
    );
  });
}

/** The root of the repository a directory of m is in, undefined when it
 * is in none (remembered for NOT_REPO_MS). A failure that says nothing
 * about the directory (offline, busy, timeout) rejects and is not
 * remembered. */
export function repoOf(m: string, dir: string, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  const key = `${m}\u0000${dir}`;
  const c = known.get(key);
  if (c?.pending) return awaitRepo(key, c.pending, signal);
  if (c && (c.root || Date.now() - c.at < NOT_REPO_MS)) return Promise.resolve(c.root);
  const ac = new AbortController();
  const pending: PendingRepo = {
    promise: undefined as unknown as Promise<string | undefined>,
    waiters: signal ? 0 : 1,
    ac,
  };
  pending.promise = limitGitRead(m, () => gitApi.repo(m, dir, ac.signal), ac.signal).then(
    (info) => {
      known.set(key, { root: info.root, nested: info.nested, at: Date.now() });
      seedRepoInfo(m, info);
      return info.root as string | undefined;
    },
    (e: unknown) => {
      if (!noRepo(e)) {
        if (known.get(key)?.pending === pending) known.delete(key);
        throw e;
      }
      known.set(key, { at: Date.now() });
      return undefined;
    },
  );
  pending.promise.catch(() => {});
  known.set(key, { at: Date.now(), pending });
  return awaitRepo(key, pending, signal);
}

/** A lease on a directory's repository: watched while the lease is held
 * and the plugin is on; a directory that could not be asked is asked
 * again after RETRY_MS. */
interface Lease {
  m: string;
  dir: string;
  /** Bumped when the lease starts or stops: answers for an earlier start
   * are dropped. */
  gen: number;
  ac?: AbortController;
  stop?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}
const leases = new Set<Lease>();
/** Whether the plugin is on, as the leases last saw it (sync). */
let on = false;

function begin(l: Lease) {
  const gen = ++l.gen;
  l.ac?.abort();
  const ac = new AbortController();
  l.ac = ac;
  repoOf(l.m, l.dir, ac.signal).then(
    (root) => {
      if (l.gen !== gen || !root) return;
      const c = known.get(`${l.m}\u0000${l.dir}`);
      const roots = [root, ...(c?.nested ?? [])];
      const stops = [...new Set(roots)].map((r) => watchRepo(l.m, r));
      l.stop = () => stops.forEach((s) => s());
    },
    (e) => {
      if (l.gen === gen && !isAbortError(e)) l.timer = setTimeout(() => l.gen === gen && begin(l), RETRY_MS);
    },
  );
}

function end(l: Lease) {
  l.gen++;
  l.ac?.abort();
  l.ac = undefined;
  clearTimeout(l.timer);
  l.stop?.();
  l.stop = undefined;
}

function lease(m: string, dir: string): () => void {
  const l: Lease = { m, dir, gen: 0 };
  leases.add(l);
  if (on) begin(l);
  return () => {
    if (!leases.delete(l)) return;
    end(l);
  };
}

/** Turning the plugin off stops the leases' watches, on starts them
 * again. */
function sync() {
  const now = isPluginOn('git');
  if (now === on) return;
  on = now;
  for (const l of leases) {
    if (on) begin(l);
    else end(l);
  }
}
useSettings.subscribe(sync);
usePluginList.subscribe(sync);
sync();

/** The number of leases and of those watching (tests). */
export function leaseCount(): { held: number; watching: number } {
  let watching = 0;
  for (const l of leases) if (l.stop) watching++;
  return { held: leases.size, watching };
}

// The explorer's directories: a lease per directory shown.
const shown = new Map<string, () => void>();
useShownDirs.subscribe(({ m, dirs }) => {
  const want = new Set(m ? dirs.map((d) => `${m}\u0000${d}`) : []);
  for (const [k, stop] of shown) if (!want.has(k)) (stop(), shown.delete(k));
  for (const k of want) {
    if (shown.has(k)) continue;
    const [mm, d] = k.split('\u0000');
    shown.set(k, lease(mm, d));
  }
});

const originals = new Map<string, Promise<string | undefined>>();

/** The index's text of a file, for the editor's quick diff; read again when
 * its repository's index or HEAD changed (its version). */
async function original(m: string, path: string): Promise<string | undefined> {
  if (!isPluginOn('git')) return undefined;
  const root = await repoOf(m, dirname(path)).catch(() => undefined);
  if (!root || !inside(path, root) || path === root) return undefined;
  const rel = path.slice(root === '/' ? 1 : root.length + 1);
  const version = useGit.getState().repos[repoKey(m, root)]?.version ?? 0;
  const key = `${m}\u0000${root}\u0000${rel}\u0000${version}`;
  let p = originals.get(key);
  if (!p) {
    p = gitApi
      .blob(m, root, rel, 'index')
      .then((b) => (b.exists && !b.binary && !b.tooLarge ? b.text : undefined))
      .catch(() => {
        // Not remembered: asked again next time.
        originals.delete(key);
        return undefined;
      });
    originals.set(key, p);
    while (originals.size > MAX_ORIGINALS) originals.delete(originals.keys().next().value!);
  }
  return p;
}

registerQuickDiff({
  follow: (m, path) => lease(m, dirname(path)),
  original,
  openChanges: (m, path) => {
    void repoOf(m, dirname(path))
      .catch(() => undefined)
      .then((root) => {
        if (root && inside(path, root))
          void openDiff(m, { repo: root, path: path.slice(root === '/' ? 1 : root.length + 1), mode: 'worktree' });
      });
  },
});
