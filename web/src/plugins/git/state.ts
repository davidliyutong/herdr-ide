// The repositories the Git plugin follows: their state (branch, status),
// read again when the machine's watch token changes (polled every
// POLL_MS while a panel or pane shows the repository) or after a change
// the UI made, and at least every REFRESH_MS. The file explorer's
// decorations come from these statuses.

import { useEffect } from 'react';
import { create } from 'zustand';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import { refreshDecorations } from '../files/decorations';
import { errorText, gitApi, GitError, type RepoInfo, type Status } from './api';

/** How often a shown repository's watch token is read. */
export const POLL_MS = 2000;
/** The longest a shown repository's status goes unread (changes of the
 * working tree do not move the token). */
export const REFRESH_MS = 10000;

export interface RepoState {
  info?: RepoInfo;
  status?: Status;
  error?: string;
  token?: string;
  /** Bumped when the repository changed: the graph reads its log again. */
  version: number;
  /** Unix milliseconds of the last read of the status. */
  readAt: number;
  /** A change running. */
  busy?: string;
}

export const useGit = create<{ repos: Record<string, RepoState> }>(() => ({ repos: {} }));

export const repoKey = (m: string, root: string) => `${m}\u0000${root}`;

function patch(m: string, root: string, f: (s: RepoState) => Partial<RepoState>) {
  const k = repoKey(m, root);
  useGit.setState((st) => {
    const cur = st.repos[k] ?? { version: 0, readAt: 0 };
    return { repos: { ...st.repos, [k]: { ...cur, ...f(cur) } } };
  });
}

const inflight = new Map<string, Promise<void>>();

/** Reads a repository's state again (its info and status). */
export function refresh(m: string, root: string): Promise<void> {
  const k = repoKey(m, root);
  const running = inflight.get(k);
  if (running) return running;
  const p = (async () => {
    try {
      const [info, status] = await Promise.all([gitApi.repo(m, root), gitApi.status(m, root)]);
      patch(m, root, (s) => {
        const changed =
          s.status?.head !== status.head ||
          s.info?.branch !== info.branch ||
          JSON.stringify(s.status?.files) !== JSON.stringify(status.files);
        return { info, status, error: undefined, readAt: Date.now(), version: changed ? s.version + 1 : s.version };
      });
      refreshDecorations();
    } catch (e) {
      patch(m, root, () => ({ error: errorText(e), readAt: Date.now() }));
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

/** Marks a repository changed (its log is read again) and reads it. */
export function changed(m: string, root: string) {
  patch(m, root, (s) => ({ version: s.version + 1 }));
  return refresh(m, root);
}

async function poll(m: string, root: string) {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  const s = useGit.getState().repos[repoKey(m, root)];
  if (s?.busy) return;
  let token: string | undefined;
  try {
    token = (await gitApi.watch(m, root)).token;
  } catch {
    token = undefined;
  }
  const moved = token !== s?.token;
  if (moved) patch(m, root, (cur) => ({ token, version: cur.version + 1 }));
  if (moved || !s || Date.now() - s.readAt >= REFRESH_MS) await refresh(m, root);
}

const watchers = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();

/** Follows a repository while a component shows it. */
export function watchRepo(m: string, root: string): () => void {
  const k = repoKey(m, root);
  let w = watchers.get(k);
  if (!w) {
    w = { count: 0, timer: setInterval(() => void poll(m, root), POLL_MS) };
    watchers.set(k, w);
    void refresh(m, root);
  }
  w.count++;
  return () => {
    w!.count--;
    if (w!.count === 0) {
      clearInterval(w!.timer);
      watchers.delete(k);
    }
  };
}

/** The state of a repository, followed while the component is mounted. */
export function useRepo(m: string | undefined, root: string | undefined): RepoState | undefined {
  useEffect(() => {
    if (!m || !root) return;
    return watchRepo(m, root);
  }, [m, root]);
  return useGit((s) => (m && root ? s.repos[repoKey(m, root)] : undefined));
}

/**
 * Runs a change and reads the repository again; a failure is a toast
 * (auth_required suggests a terminal). Resolves with whether it worked.
 */
export async function runGit(m: string, root: string, action: string, params: Record<string, unknown> = {}): Promise<boolean> {
  if (useStore.getState().readOnly) {
    useStore.getState().toast(t('git.readOnly'));
    return false;
  }
  patch(m, root, () => ({ busy: action }));
  try {
    await gitApi.run(m, root, action, params);
    return true;
  } catch (e) {
    const code = e instanceof GitError ? e.code : '';
    useStore
      .getState()
      .toast(
        errorText(e),
        undefined,
        code === 'auth_required' || code === 'conflicts' || code === 'git_failed' ? 12000 : undefined,
        'error',
      );
    return false;
  } finally {
    patch(m, root, () => ({ busy: undefined }));
    await changed(m, root);
  }
}

/** The repository roots dir is in (innermost first), cached per
 * directory; undefined while unknown, [] outside repositories. */
const repoOfDir = create<{ dirs: Record<string, string[] | null> }>(() => ({ dirs: {} }));

export function useReposOf(m: string | undefined, dir: string | undefined): { roots?: string[]; error?: string } {
  const k = m && dir ? `${m}\u0000${dir}` : '';
  const roots = repoOfDir((s) => (k ? s.dirs[k] : undefined));
  useEffect(() => {
    if (!m || !dir || roots !== undefined) return;
    let gone = false;
    gitApi
      .repo(m, dir)
      .then((info) => {
        if (gone) return;
        repoOfDir.setState((s) => ({ dirs: { ...s.dirs, [k]: [info.root, ...(info.parents ?? [])] } }));
        patch(m, info.root, () => ({ info }));
      })
      .catch((e) => {
        if (gone) return;
        const code = e instanceof GitError ? e.code : '';
        repoOfDir.setState((s) => ({ dirs: { ...s.dirs, [k]: code === 'not_a_repo' || code === 'not_found' ? [] : null } }));
        if (code !== 'not_a_repo' && code !== 'not_found') errorOf.set(k, errorText(e));
      });
    return () => {
      gone = true;
    };
  }, [m, dir, k, roots]);
  if (roots === null) return { roots: [], error: errorOf.get(k) };
  return { roots: roots ?? undefined };
}

const errorOf = new Map<string, string>();

/** Forgets the repositories found for directories (to look again). */
export function forgetRepos() {
  repoOfDir.setState({ dirs: {} });
  errorOf.clear();
}
