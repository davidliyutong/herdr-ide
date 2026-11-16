// The repositories the Git plugin follows: their state (branch, status),
// read again when the machine's watch token changes (polled every
// POLL_MS while a panel or pane shows the repository) or after a change
// the UI made, and at least every REFRESH_MS (less often after slow reads
// or timeouts). The file explorer's decorations come from these statuses.

import { useEffect } from 'react';
import { create } from 'zustand';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import { refreshDecorations } from '../files/decorations';
import { errorText, gitApi, GitError, noRepo, type RepoInfo, type Status, type Watch } from './api';

/** How often a shown repository's watch token is read. */
export const POLL_MS = 2000;
/** The longest a shown repository's status goes unread (changes of the
 * working tree do not move the token). */
export const REFRESH_MS = 10000;
/** A status read that took longer is not repeated by the polls before
 * SLOW_FACTOR times as long has passed. */
export const SLOW_MS = 2000;
export const SLOW_FACTOR = 5;
/** The longest the polls wait after slow reads or timeouts. */
export const MAX_BACKOFF_MS = 5 * 60_000;
/** How long a directory whose repository could not be asked (offline,
 * busy, timeout) waits before it is asked again. */
export const RETRY_MS = REFRESH_MS;

export interface RepoState {
  info?: RepoInfo;
  status?: Status;
  error?: string;
  /** The watch's tokens last seen: of everything, of the refs, of the
   * configuration. */
  token?: string;
  refsToken?: string;
  configToken?: string;
  /** Bumped when the index, HEAD or the refs changed (the watch's token
   * moved) and after a change the UI made: diffs and the editor's quick
   * diff read their sides again. */
  version: number;
  /** Bumped when HEAD, the refs or the stashes changed and after a change
   * the UI made: the history, the graph and the stashes read again. */
  refs: number;
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
    const cur = st.repos[k] ?? { version: 0, refs: 0, readAt: 0 };
    return { repos: { ...st.repos, [k]: { ...cur, ...f(cur) } } };
  });
}

/** What the polls keep per repository: a read due (the token moved), with
 * the repository's info (the configuration moved), and the pace after
 * slow reads and timeouts. */
interface Track {
  due: boolean;
  info: boolean;
  failures: number;
  /** No automatic read before (unix milliseconds). */
  nextAt: number;
}
const tracks = new Map<string, Track>();
const track = (k: string): Track => {
  let tr = tracks.get(k);
  if (!tr) tracks.set(k, (tr = { due: false, info: false, failures: 0, nextAt: 0 }));
  return tr;
};

const running = new Map<string, Promise<void>>();
const queued = new Map<string, { info: boolean; p: Promise<void> }>();

/**
 * Reads a repository's status again (with info: its info too, which a
 * first read always fetches). A read in progress is shared, unless fresh
 * asks for one that starts after this call (after a change): it is queued
 * behind the running one, and calls meanwhile share it.
 */
export function refresh(m: string, root: string, want: { info?: boolean; fresh?: boolean } = {}): Promise<void> {
  const k = repoKey(m, root);
  const cur = running.get(k);
  if (!cur) return start(m, root, !!want.info);
  if (!want.fresh && !want.info) return cur;
  const q = queued.get(k);
  if (q) {
    q.info ||= !!want.info;
    return q.p;
  }
  const next = { info: !!want.info, p: Promise.resolve() };
  next.p = cur.then(() => {
    queued.delete(k);
    const again = running.get(k);
    return again && !next.info ? again : start(m, root, next.info);
  });
  queued.set(k, next);
  return next.p;
}

function start(m: string, root: string, info: boolean): Promise<void> {
  const k = repoKey(m, root);
  const p = read(m, root, info).finally(() => {
    if (running.get(k) === p) running.delete(k);
  });
  running.set(k, p);
  return p;
}

async function read(m: string, root: string, withInfo: boolean) {
  const k = repoKey(m, root);
  const t0 = Date.now();
  const needInfo = withInfo || !useGit.getState().repos[k]?.info;
  try {
    const [info, status] = await Promise.all([
      // The branch, upstream and ahead/behind come with the status; the
      // info (remotes, git directories) only when it may have changed.
      needInfo ? gitApi.repo(m, root).catch(() => undefined) : undefined,
      gitApi.status(m, root),
    ]);
    paced(k, Date.now() - t0);
    patch(m, root, (s) => {
      // Without a watch (it failed), HEAD's move is seen here.
      const moved = !!s.status && (s.status.head !== status.head || s.status.branch !== status.branch);
      return {
        ...(info ? { info } : {}),
        status,
        error: undefined,
        readAt: Date.now(),
        version: moved ? s.version + 1 : s.version,
        refs: moved ? s.refs + 1 : s.refs,
      };
    });
    refreshDecorations();
  } catch (e) {
    failed(k, e);
    patch(m, root, () => ({ error: errorText(e), readAt: Date.now() }));
  }
}

/** A read that took long keeps the polls away for a while. */
function paced(k: string, took: number) {
  const tr = track(k);
  tr.failures = 0;
  tr.nextAt = took >= SLOW_MS ? Date.now() + Math.min(MAX_BACKOFF_MS, took * SLOW_FACTOR) : 0;
}

/** A read that timed out (or found git busy) is retried later and later. */
function failed(k: string, e: unknown) {
  const code = e instanceof GitError ? e.code : '';
  if (code !== 'timeout' && code !== 'busy') return;
  const tr = track(k);
  tr.failures++;
  tr.nextAt = Date.now() + Math.min(MAX_BACKOFF_MS, REFRESH_MS * 2 ** tr.failures);
}

/** The tokens of a watch's answer (an agent without refs and config
 * tokens moves them with the whole one). */
const tokensOf = (w: Watch) => ({ token: w.token, refsToken: w.refs ?? w.token, configToken: w.config ?? w.token });

/**
 * After a change: marks the repository changed and reads it with a read
 * that starts now. Diffs read their sides again; the history and graph
 * only when the watch's refs token moved, the repository's info when its
 * configuration did (or both with all, as Refresh asks). The tokens seen
 * become the polls' own, so they do not count the change again.
 */
export async function changed(m: string, root: string, o: { all?: boolean } = {}) {
  let w: Watch | undefined;
  try {
    w = await gitApi.watch(m, root);
  } catch {
    // Without a token everything may have moved.
  }
  let info = true;
  patch(m, root, (s) => {
    if (!w) return { version: s.version + 1, refs: s.refs + 1 };
    const tk = tokensOf(w);
    const refsMoved = !!o.all || tk.refsToken !== s.refsToken;
    info = !!o.all || tk.configToken !== s.configToken;
    return { ...tk, version: s.version + 1, refs: refsMoved ? s.refs + 1 : s.refs };
  });
  return refresh(m, root, { fresh: true, info });
}

async function poll(m: string, root: string) {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  const k = repoKey(m, root);
  if (useGit.getState().repos[k]?.busy) return;
  let w: Watch | undefined;
  try {
    w = await gitApi.watch(m, root);
  } catch {
    // Says nothing; the periodic read shows what is wrong.
  }
  const s = useGit.getState().repos[k];
  const tr = track(k);
  if (w) {
    const tk = tokensOf(w);
    if (s?.token === undefined) {
      // The first token: what the first read saw.
      patch(m, root, () => tk);
    } else {
      const moved = tk.token !== s.token;
      const refsMoved = tk.refsToken !== s.refsToken;
      if (moved) patch(m, root, (c) => ({ ...tk, version: c.version + 1, refs: refsMoved ? c.refs + 1 : c.refs }));
      tr.due ||= moved;
      tr.info ||= tk.configToken !== s.configToken;
    }
  }
  if (Date.now() < tr.nextAt) return;
  if (tr.due || !s || Date.now() - s.readAt >= REFRESH_MS) {
    // A move needs a read that starts after it.
    const want = { info: tr.info, fresh: tr.due };
    tr.due = tr.info = false;
    await refresh(m, root, want);
  }
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
  let done = false;
  return () => {
    if (done) return;
    done = true;
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
        code === 'auth_required' || code === 'conflicts' || code === 'git_failed' || code === 'diverged' ? 12000 : undefined,
        'error',
      );
    return false;
  } finally {
    patch(m, root, () => ({ busy: undefined }));
    await changed(m, root);
  }
}

/** The repository roots of directories (innermost first), or the failure
 * that kept a directory's from being known (asked again after RETRY_MS). */
type Found = { roots: string[] } | { error: string };
const repoOfDir = create<{ dirs: Record<string, Found> }>(() => ({ dirs: {} }));

/** The repository roots dir is in (innermost first), cached per directory:
 * undefined while unknown, [] outside repositories; a failure that says
 * nothing about the directory (offline, busy, timeout) is shown with []
 * and asked again later. */
export function useReposOf(m: string | undefined, dir: string | undefined): { roots?: string[]; error?: string } {
  const k = m && dir ? `${m}\u0000${dir}` : '';
  const found = repoOfDir((s) => (k ? s.dirs[k] : undefined));
  useEffect(() => {
    if (!m || !dir || (found && 'roots' in found)) return;
    let gone = false;
    const ask = () =>
      gitApi
        .repo(m, dir)
        .then((info) => {
          if (gone) return;
          repoOfDir.setState((s) => ({ dirs: { ...s.dirs, [k]: { roots: [info.root, ...(info.parents ?? [])] } } }));
          patch(m, info.root, () => ({ info }));
        })
        .catch((e) => {
          if (gone) return;
          repoOfDir.setState((s) => ({ dirs: { ...s.dirs, [k]: noRepo(e) ? { roots: [] } : { error: errorText(e) } } }));
        });
    const timer = found ? setTimeout(() => void ask(), RETRY_MS) : undefined;
    if (!found) void ask();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [m, dir, k, found]);
  if (!found) return {};
  return 'roots' in found ? { roots: found.roots } : { roots: [], error: found.error };
}

/** Forgets the repositories found for directories (to look again). */
export function forgetRepos() {
  repoOfDir.setState({ dirs: {} });
}
