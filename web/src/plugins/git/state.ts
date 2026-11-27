// The repositories the Git plugin follows: their state (branch, status),
// read while a panel, pane, the file explorer or an editor shows the
// repository and the page is visible. The machine's watch token (the index,
// HEAD, the refs) is asked every POLL_MS (ACTIVE_POLL_MS while the
// repository is active) and the status read when it moved, at least every
// REFRESH_MS (ACTIVE_REFRESH_MS while active: changes of the working tree
// do not move the token), at once after a change the UI made, when a
// command or an agent's turn ended in a terminal there, and when the page
// is shown or focused again; never more than a fifth of the time (slow
// reads and timeouts keep the reads further apart). The file explorer's
// decorations come from these statuses.

import { useEffect } from 'react';
import { create } from 'zustand';
import { useStore } from '../../state/store';
import { useTerms } from '../../state/terms';
import { directoryOf, type TerminalRecord } from '../../term/protocol';
import { t } from '../../i18n';
import { refreshDecorations } from '../files/decorations';
import {
  errorText,
  gitApi,
  GitError,
  isAbortError,
  limitGitRead,
  noRepo,
  type RepoInfo,
  type Status,
  type StatusFile,
  type Watch,
} from './api';

/** How often a shown repository's watch token is read; ACTIVE_POLL_MS
 * while the repository is active. */
export const POLL_MS = 2000;
export const ACTIVE_POLL_MS = 1000;
/** The longest a shown repository's status goes unread (changes of the
 * working tree do not move the token); ACTIVE_REFRESH_MS while the
 * repository is active. */
export const REFRESH_MS = 10000;
export const ACTIVE_REFRESH_MS = 2000;
/** A repository is active for ACTIVE_MS after a change was seen in it (its
 * status or its token moved), the UI changed it, a command or an agent's
 * turn ended in a terminal there, the page was shown or focused, or keys
 * or the pointer were used in the page. */
export const ACTIVE_MS = 30_000;
/** A read keeps the polls' next one away for SLOW_FACTOR times as long as
 * it took (a slow status is not read most of the time). */
export const SLOW_FACTOR = 5;
/** How long after a terminal's command ended (or the page was focused) the
 * repository is looked at: what happens at once comes together. */
export const NUDGE_MS = 250;
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

/** Seeds a repository's already-fetched info so an immediate watchRepo/refresh
 * does not issue a redundant gitApi.repo call for the same root. */
export function seedRepoInfo(m: string, info: RepoInfo) {
  patch(m, info.root, (s) => (s.info ? {} : { info }));
}

/** What the polls keep per repository: a read due (the token moved, a
 * terminal's command ended), with the repository's info (the
 * configuration moved), the pace after slow reads and timeouts, and when
 * something last happened there. */
interface Track {
  due: boolean;
  info: boolean;
  failures: number;
  /** No automatic read before (unix milliseconds). */
  nextAt: number;
  /** When a change was last seen or made (unix milliseconds). */
  activeAt: number;
  /** The status last read, to see whether the next one differs. */
  seen?: string;
  /** Monotonic counter bumped when a UI mutation starts, so an earlier
   * in-flight status read never overwrites an optimistic update. */
  gen: number;
  /** Number of UI mutations currently queued or running for this repo. */
  pending: number;
  /** Serializes mutations on the same repository so consecutive stage/unstage
   * clicks never race on .git/index.lock. */
  queue: Promise<void>;
}
const tracks = new Map<string, Track>();
const track = (k: string): Track => {
  let tr = tracks.get(k);
  if (!tr)
    tracks.set(k, (tr = { due: false, info: false, failures: 0, nextAt: 0, activeAt: 0, gen: 0, pending: 0, queue: Promise.resolve() }));
  return tr;
};

/** Fast working-tree/index actions applied optimistically in place without
 * toggling the panel's busy banner or disabling unrelated controls. */
const INLINE_ACTIONS = new Set(['stage', 'unstage', 'discard']);

/** Applies an optimistic stage, unstage or discard to status so rows move
 * immediately while the machine runs git; the follow-up status read reconciles
 * any nuance (renames, filters, failures). */
export function applyOptimisticStatus(status: Status, action: string, params: Record<string, unknown>): Status {
  if (action === 'stage') {
    const all = !!params.all;
    const tracked = !!params.tracked;
    const paths = new Set(Array.isArray(params.paths) ? params.paths.map(String) : []);
    if (!all && !paths.size) return status;
    const files: StatusFile[] = [];
    for (const f of status.files) {
      if (f.kind === 'ignored') {
        files.push(f);
        continue;
      }
      const hit = all ? !tracked || f.kind !== 'untracked' : paths.has(f.path);
      if (!hit) {
        files.push(f);
        continue;
      }
      if (f.kind === 'untracked') {
        files.push({ path: f.path, x: 'A', y: '.', kind: 'changed', ...(f.submodule ? { submodule: true } : {}) });
      } else if (f.kind === 'unmerged') {
        if (!(f.x === 'D' && f.y === 'D')) {
          files.push({ path: f.path, x: 'M', y: '.', kind: 'changed', ...(f.submodule ? { submodule: true } : {}) });
        }
      } else if (f.y === '.') {
        files.push(f);
      } else if (f.x === 'A' && f.y === 'D') {
        // Added in the index and deleted in the working tree: staging removes it.
      } else {
        const nextX = f.x === '.' ? f.y : f.y === 'D' ? 'D' : f.x;
        files.push({
          path: f.path,
          ...(f.orig ? { orig: f.orig } : {}),
          x: nextX,
          y: '.',
          kind: f.kind,
          ...(f.submodule ? { submodule: true } : {}),
        });
      }
    }
    return { ...status, files };
  }
  if (action === 'unstage') {
    const all = !!params.all;
    const paths = new Set(Array.isArray(params.paths) ? params.paths.map(String) : []);
    if (!all && !paths.size) return status;
    const raw: StatusFile[] = [];
    for (const f of status.files) {
      if (f.kind === 'ignored' || f.kind === 'untracked') {
        raw.push(f);
        continue;
      }
      const hit = all ? f.x !== '.' || f.kind === 'unmerged' : paths.has(f.path) || (!!f.orig && paths.has(f.orig));
      if (!hit || f.kind === 'unmerged' || f.x === '.') {
        raw.push(f);
        continue;
      }
      if (f.kind === 'renamed') {
        if (f.y !== 'D') {
          raw.push({ path: f.path, x: '?', y: '?', kind: 'untracked', ...(f.submodule ? { submodule: true } : {}) });
        }
        if (f.orig) raw.push({ path: f.orig, x: '.', y: 'D', kind: 'changed' });
      } else if (f.x === 'A') {
        if (f.y !== 'D') {
          raw.push({ path: f.path, x: '?', y: '?', kind: 'untracked', ...(f.submodule ? { submodule: true } : {}) });
        }
      } else {
        const nextY = f.y === '.' ? f.x : f.y;
        raw.push({
          path: f.path,
          x: '.',
          y: nextY,
          kind: 'changed',
          ...(f.submodule ? { submodule: true } : {}),
          ...(f.mtime !== undefined ? { mtime: f.mtime } : {}),
          ...(f.size !== undefined ? { size: f.size } : {}),
        });
      }
    }
    const seen = new Set<string>();
    const files: StatusFile[] = [];
    for (const f of raw) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      files.push(f);
    }
    return { ...status, files };
  }
  if (action === 'discard') {
    const tracked = new Set(Array.isArray(params.paths) ? params.paths.map(String) : []);
    const untracked = new Set(Array.isArray(params.untracked) ? params.untracked.map(String) : []);
    if (!tracked.size && !untracked.size) return status;
    const files: StatusFile[] = [];
    for (const f of status.files) {
      if (f.kind === 'untracked') {
        if (!untracked.has(f.path)) files.push(f);
      } else if (f.kind === 'ignored') {
        files.push(f);
      } else if (tracked.has(f.path) && f.kind !== 'unmerged') {
        if (f.x !== '.') {
          files.push({
            path: f.path,
            ...(f.orig ? { orig: f.orig } : {}),
            x: f.x,
            y: '.',
            kind: f.kind,
            ...(f.submodule ? { submodule: true } : {}),
          });
        }
      } else {
        files.push(f);
      }
    }
    return { ...status, files };
  }
  return status;
}

/** When keys or the pointer were last used in the page. */
let inputAt = 0;

/** Forgets when the page was last used (tests). */
export function forgetInput() {
  inputAt = 0;
}

/** Whether something happened in the repository (or the page) lately. */
const active = (tr: Track) => Date.now() - Math.max(tr.activeAt, inputAt) < ACTIVE_MS;

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
  const tr = track(k);
  const gen = tr.gen;
  const t0 = Date.now();
  const needInfo = withInfo || !useGit.getState().repos[k]?.info;
  try {
    const [info, status] = await limitGitRead(m, async () => {
      // Run info (when needed) and status sequentially within one per-machine
      // read slot so expanding many submodules or focusing the window never
      // exceeds the machine's MAX_RUNS semaphore.
      const i = needInfo ? await gitApi.repo(m, root).catch(() => undefined) : undefined;
      const s = await gitApi.status(m, root);
      return [i, s] as const;
    });
    paced(k, Date.now() - t0);
    // A status read that raced with a newer UI mutation must not overwrite
    // the optimistic state with pre-mutation data.
    if (tr.pending > 0 || tr.gen !== gen) {
      if (info) patch(m, root, () => ({ info }));
      return;
    }
    const seen = JSON.stringify(status);
    if (tr.seen !== undefined && tr.seen !== seen) tr.activeAt = Date.now();
    tr.seen = seen;
    let kept = false;
    patch(m, root, (s) => {
      // Without a watch (it failed), HEAD's move is seen here.
      const moved = !!s.status && (s.status.head !== status.head || s.status.branch !== status.branch);
      // The same status keeps its object: what is drawn of it stays. Compare
      // against s.status so a matching optimistic update avoids a redraw while
      // a failed optimistic update always reconciles back to git's status.
      kept = !!s.status && JSON.stringify(s.status) === seen;
      return {
        ...(info ? { info } : {}),
        status: kept ? s.status : status,
        error: undefined,
        readAt: Date.now(),
        version: moved ? s.version + 1 : s.version,
        refs: moved ? s.refs + 1 : s.refs,
      };
    });
    if (!kept) refreshDecorations();
  } catch (e) {
    failed(k, e);
    patch(m, root, () => ({ error: errorText(e), readAt: Date.now() }));
  }
}

/** A read keeps the polls away for SLOW_FACTOR times as long as it took. */
function paced(k: string, took: number) {
  const tr = track(k);
  tr.failures = 0;
  tr.nextAt = took > 0 ? Date.now() + Math.min(MAX_BACKOFF_MS, took * SLOW_FACTOR) : 0;
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
export async function changed(m: string, root: string, o: { all?: boolean; indexOnly?: boolean } = {}) {
  let w: Watch | undefined;
  try {
    w = await gitApi.watch(m, root);
  } catch {
    // Without a token everything may have moved.
  }
  let info = !o.indexOnly;
  track(repoKey(m, root)).activeAt = Date.now();
  patch(m, root, (s) => {
    if (!w) return { version: s.version + 1, refs: o.indexOnly ? s.refs : s.refs + 1 };
    const tk = tokensOf(w);
    const refsMoved = !!o.all || (!(o.indexOnly && s.refsToken === undefined) && tk.refsToken !== s.refsToken);
    info = !!o.all || (!(o.indexOnly && s.configToken === undefined) && tk.configToken !== s.configToken);
    return { ...tk, version: s.version + 1, refs: refsMoved ? s.refs + 1 : s.refs };
  });
  return refresh(m, root, { fresh: true, info });
}

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

async function poll(m: string, root: string) {
  if (!visible()) return;
  const k = repoKey(m, root);
  if (useGit.getState().repos[k]?.busy || track(k).pending > 0) return;
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
      if (moved) {
        patch(m, root, (c) => ({ ...tk, version: c.version + 1, refs: refsMoved ? c.refs + 1 : c.refs }));
        tr.activeAt = Date.now();
      }
      tr.due ||= moved;
      tr.info ||= tk.configToken !== s.configToken;
    }
  }
  if (Date.now() < tr.nextAt) return;
  if (tr.due || !s || Date.now() - s.readAt >= (active(tr) ? ACTIVE_REFRESH_MS : REFRESH_MS)) {
    // A move needs a read that starts after it.
    const want = { info: tr.info, fresh: tr.due };
    tr.due = tr.info = false;
    await refresh(m, root, want);
  }
}

/** A repository followed: by how many, its next poll, a poll running. */
interface Watcher {
  m: string;
  root: string;
  count: number;
  timer?: ReturnType<typeof setTimeout>;
  /** When the next poll is planned (unix milliseconds). */
  at: number;
  polling: boolean;
}
const watchers = new Map<string, Watcher>();

/** Plans w's next poll in ms (by default as its pace says). */
function plan(w: Watcher, ms?: number) {
  const tr = track(repoKey(w.m, w.root));
  if (ms === undefined) {
    ms = active(tr) ? ACTIVE_POLL_MS : POLL_MS;
    // A read due waits only for the pace of slow reads (and the page).
    if (tr.due && visible()) ms = Math.min(ms, Math.max(NUDGE_MS, tr.nextAt - Date.now()));
  }
  clearTimeout(w.timer);
  w.at = Date.now() + ms;
  w.timer = setTimeout(() => void tick(w), ms);
}

async function tick(w: Watcher) {
  w.timer = undefined;
  w.polling = true;
  try {
    await poll(w.m, w.root);
  } finally {
    w.polling = false;
    if (watchers.get(repoKey(w.m, w.root)) === w) plan(w);
  }
}

/** Something may have changed in a followed repository (a terminal's
 * command ended there, the page came back): it is active, and its watch
 * and status are read soon. */
export function nudge(m: string, root: string) {
  const k = repoKey(m, root);
  const w = watchers.get(k);
  if (!w) return;
  const tr = track(k);
  tr.due = true;
  tr.activeAt = Date.now();
  // A poll running plans the next one when it ends.
  if (!w.polling && w.at > Date.now() + NUDGE_MS) plan(w, Math.max(NUDGE_MS, tr.nextAt - Date.now()));
}

/** Follows a repository while a component shows it. */
export function watchRepo(m: string, root: string): () => void {
  const k = repoKey(m, root);
  let w = watchers.get(k);
  if (!w) {
    w = { m, root, count: 0, at: 0, polling: false };
    watchers.set(k, w);
    // Shown just now: looked at.
    track(k).activeAt = Date.now();
    plan(w);
    void refresh(m, root);
  }
  w.count++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    w!.count--;
    if (w!.count === 0) {
      clearTimeout(w!.timer);
      watchers.delete(k);
    }
  };
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir === '/' ? '/' : dir + '/');

// The page shown again or focused: every repository followed is looked at
// (files may have changed in another program meanwhile); keys and the
// pointer used in the page keep the repositories active.
if (typeof window !== 'undefined') {
  const back = () => {
    if (visible()) for (const w of watchers.values()) nudge(w.m, w.root);
  };
  document.addEventListener('visibilitychange', back);
  window.addEventListener('focus', back);
  const input = () => void (inputAt = Date.now());
  window.addEventListener('keydown', input, { capture: true, passive: true });
  window.addEventListener('pointerdown', input, { capture: true, passive: true });
}

/** What of a terminal's record says a command or an agent's turn began or
 * ended: its foreground program, its state, the agent's status and turn,
 * the program's own status. */
function moment(r: TerminalRecord): string {
  const fg = r.foreground as { pid?: unknown; name?: unknown } | null | undefined;
  const st = r.status as { state?: unknown } | null | undefined;
  return JSON.stringify([fg?.pid, fg?.name, r.state, r.agent_status, r.turn, st?.state]);
}

// A terminal's command ending (its foreground program changed), or an
// agent's turn, in a directory of a repository followed: it is looked at.
let moments = new Map<string, string>();
useTerms.subscribe((s, prev) => {
  if (s.machines === prev.machines) return;
  const next = new Map<string, string>();
  for (const [m, mt] of Object.entries(s.machines)) {
    for (const r of Object.values(mt.terminals ?? {})) {
      const key = `${m}\u0000${r.address}`;
      const now = moment(r);
      next.set(key, now);
      const was = moments.get(key);
      if (was === undefined || was === now) continue;
      const dir = directoryOf(r);
      if (!dir) continue;
      for (const w of watchers.values()) if (w.m === m && within(dir, w.root)) nudge(m, w.root);
    }
  }
  moments = next;
});

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
 * Fast index/working-tree actions (stage, unstage, discard) apply
 * optimistically right away, serialize per repository so rapid clicks never
 * race on git's index lock, and reconcile once the batch settles.
 */
export async function runGit(m: string, root: string, action: string, params: Record<string, unknown> = {}): Promise<boolean> {
  if (useStore.getState().readOnly) {
    useStore.getState().toast(t('git.readOnly'));
    return false;
  }
  const k = repoKey(m, root);
  const tr = track(k);
  const inline = INLINE_ACTIONS.has(action);
  tr.gen++;
  tr.pending++;
  if (inline) {
    tr.seen = undefined;
    let applied = false;
    patch(m, root, (s) => {
      if (!s.status) return {};
      const next = applyOptimisticStatus(s.status, action, params);
      if (next === s.status) return {};
      applied = true;
      return { status: next };
    });
    if (applied) refreshDecorations();
  }
  const prev = tr.queue;
  let release!: () => void;
  tr.queue = new Promise<void>((r) => (release = r));
  await prev;
  if (!inline) patch(m, root, () => ({ busy: action }));
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
    tr.pending--;
    if (!inline) patch(m, root, () => ({ busy: undefined }));
    const moreQueued = tr.pending > 0;
    release();
    if (!moreQueued || !inline) {
      await changed(m, root, inline ? { indexOnly: true } : {});
    }
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
export function rootsOf(info: RepoInfo): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [info.root, ...(info.parents ?? []), ...(info.nested ?? [])]) {
    if (r && !seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

export function useReposOf(m: string | undefined, dir: string | undefined): { roots?: string[]; error?: string } {
  const k = m && dir ? `${m}\u0000${dir}` : '';
  const found = repoOfDir((s) => (k ? s.dirs[k] : undefined));
  useEffect(() => {
    if (!m || !dir || (found && 'roots' in found)) return;
    let gone = false;
    const ac = new AbortController();
    const ask = () =>
      limitGitRead(m, () => gitApi.repo(m, dir, ac.signal), ac.signal)
        .then((info) => {
          if (gone) return;
          repoOfDir.setState((s) => ({ dirs: { ...s.dirs, [k]: { roots: rootsOf(info) } } }));
          patch(m, info.root, () => ({ info }));
        })
        .catch((e) => {
          if (gone || isAbortError(e)) return;
          repoOfDir.setState((s) => ({ dirs: { ...s.dirs, [k]: noRepo(e) ? { roots: [] } : { error: errorText(e) } } }));
        });
    const timer = found ? setTimeout(() => void ask(), RETRY_MS) : undefined;
    if (!found) void ask();
    return () => {
      gone = true;
      ac.abort();
      clearTimeout(timer);
    };
  }, [m, dir, k, found]);
  if (!found) return {};
  return 'roots' in found ? { roots: found.roots } : { roots: [], error: found.error };
}

const forgetListeners = new Set<() => void>();

/** Registers a callback run when forgetRepos clears cached repositories. */
export function onForgetRepos(fn: () => void): () => void {
  forgetListeners.add(fn);
  return () => forgetListeners.delete(fn);
}

/** Forgets the repositories found for directories (to look again). */
export function forgetRepos() {
  repoOfDir.setState({ dirs: {} });
  for (const fn of forgetListeners) fn();
}
