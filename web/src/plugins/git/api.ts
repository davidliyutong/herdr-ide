// The Git plugin's requests to the hub (backend/features/git): reads are
// GETs with their parameters in the query, changes POSTs with a JSON body.
// The types are those of the machine side (backend/features/git/protocol.ts).
import { answer, failureOf, jsonInit, makeErrorText, PluginError } from '../../lib/pluginApi';

export interface RepoInfo {
  root: string;
  gitDir: string;
  commonDir: string;
  branch?: string;
  head?: string;
  detached?: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /** An operation in progress. */
  state?: 'merge' | 'rebase' | 'cherryPick' | 'revert';
  remotes: string[];
  /** The remotes' fetch URLs, without what could be a credential. */
  remoteUrls?: Record<string, string>;
  /** Repositories this one is nested in, innermost first. */
  parents?: string[];
  /** Repositories nested inside this one (submodules and nested repos). */
  nested?: string[];
}

export interface StatusFile {
  path: string;
  orig?: string;
  /** The index's letter, the working tree's ("." unchanged, "?"
   * untracked, "!" ignored). */
  x: string;
  y: string;
  kind: 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';
  submodule?: boolean;
  /** The working tree's file when it differs from the index: its
   * modification time (unix milliseconds) and size, which move when it is
   * edited again. */
  mtime?: number;
  size?: number;
}

export interface Status {
  branch?: string;
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  state?: RepoInfo['state'];
  files: StatusFile[];
  truncated?: boolean;
  /** What git ignores, relative to the top level (git status
   * --ignored=matching): a directory an ignore pattern matches with a
   * trailing "/" (its contents are not listed), else each file; cut at
   * 20 000 paths (ignoredTruncated). */
  ignored?: string[];
  ignoredTruncated?: boolean;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  /** Unix seconds. */
  date: number;
  subject: string;
}

export interface Ref {
  name: string;
  hash: string;
}

export interface Stash {
  index: number;
  hash: string;
  base: string;
  date: number;
  message: string;
}

export interface LogPage {
  commits: Commit[];
  more: boolean;
  refs?: Ref[];
  stashes?: Stash[];
  head?: string;
  branch?: string;
}

export interface Detail extends Commit {
  committer: string;
  committerEmail: string;
  commitDate: number;
  message: string;
}

export interface Change {
  path: string;
  orig?: string;
  status: string;
  added: number;
  deleted: number;
  binary?: boolean;
}

export interface Shown {
  commit?: Detail;
  base: string;
  target: string;
  files: Change[];
}

export interface Blob {
  exists: boolean;
  binary?: boolean;
  tooLarge?: boolean;
  text: string;
  size: number;
  mtime?: number;
}

export interface Branch {
  name: string;
  full: string;
  hash: string;
  remote?: boolean;
  current?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  gone?: boolean;
  date: number;
  subject: string;
}

export interface Tag {
  name: string;
  hash: string;
  annotated?: boolean;
  date: number;
  subject?: string;
}

/** Tokens of a repository's files: token moves with the index, HEAD, the
 * refs, the configuration and an operation in progress; refs only with
 * HEAD, the refs and the stashes; config with the configuration. */
export interface Watch {
  token: string;
  refs?: string;
  config?: string;
}

/** A failure with the code the hub or the machine gave. */
export class GitError extends PluginError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'GitError';
  }
}

/** Whether a failure of repo says the directory is in no repository (or
 * is gone). Others (offline, busy, timeout…) say nothing about it: a later
 * request may succeed, so they are not remembered as answers. */
export function noRepo(e: unknown): boolean {
  return e instanceof GitError && (e.code === 'not_a_repo' || e.code === 'not_found');
}

/** A failure as the user reads it: the code's text, with what git said. */
export const errorText = makeErrorText(GitError, 'git.error', {
  detail: (e, text) => {
    const detail = e.code === 'git_failed' || e.code === 'conflicts' ? e.message.replace(/^[a-z_]+: /, '') : '';
    return detail ? `${text} ${detail}` : text;
  },
});

const base = (m: string) => `/api/m/${encodeURIComponent(m)}/p/git`;

const failure = failureOf((code, message) => new GitError(code, message));

/** Whether e is a fetch AbortError from a cancelled request. */
export const isAbortError = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

/** Maximum concurrent background git reads per machine (half of the machine's
 * MAX_RUNS = 8 so interactive diffs, logs and writes retain headroom). */
export const MAX_CONCURRENT_GIT_READS = 4;

interface MachineGate {
  active: number;
  queue: Array<() => void>;
}
const machineGates = new Map<string, MachineGate>();

/** Runs fn within machine m's client-side read concurrency cap, cancelling
 * cleanly if signal aborts while queued. */
export async function limitGitRead<T>(m: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  let gate = machineGates.get(m);
  if (!gate) {
    gate = { active: 0, queue: [] };
    machineGates.set(m, gate);
  }
  if (gate.active < MAX_CONCURRENT_GIT_READS) {
    gate.active++;
  } else {
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = gate!.queue.indexOf(wake);
        if (i >= 0) gate!.queue.splice(i, 1);
        reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      gate!.queue.push(wake);
    });
  }
  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return await fn();
  } finally {
    const next = gate.queue.shift();
    if (next) next();
    else {
      gate.active--;
      if (gate.active === 0 && machineGates.get(m) === gate) machineGates.delete(m);
    }
  }
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

async function get<T>(m: string, action: string, q: Query, signal?: AbortSignal): Promise<T> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === false || v === '') continue;
    if (Array.isArray(v)) for (const x of v) p.append(k, x);
    else p.set(k, v === true ? '1' : String(v));
  }
  return answer<T>(await fetch(`${base(m)}/${action}?${p}`, signal ? { cache: 'no-store', signal } : { cache: 'no-store' }), failure);
}

async function post<T = { output?: string }>(m: string, action: string, body: Record<string, unknown>): Promise<T> {
  return answer<T>(await fetch(`${base(m)}/${action}`, jsonInit('POST', body)), failure);
}

/** Where a blob comes from: the working tree, the index, HEAD or a
 * revision (with parent: its parent's). */
export type Source = 'worktree' | 'index' | 'head' | string;

export const gitApi = {
  repo: (m: string, path: string, signal?: AbortSignal) => get<RepoInfo>(m, 'repo', { path }, signal),
  status: (m: string, repo: string, signal?: AbortSignal) => get<Status>(m, 'status', { repo }, signal),
  log: (m: string, repo: string, o: { skip?: number; limit?: number; branches?: string[]; remotes?: boolean; signal?: AbortSignal } = {}) =>
    get<LogPage>(m, 'log', { repo, skip: o.skip, limit: o.limit, branch: o.branches, remotes: o.remotes }, o.signal),
  show: (m: string, repo: string, rev: string, o: { parent?: number; rev2?: string; noFiles?: boolean; signal?: AbortSignal } = {}) =>
    get<Shown>(m, 'show', { repo, rev, parent: o.parent, rev2: o.rev2, noFiles: o.noFiles }, o.signal),
  blob: (m: string, repo: string, path: string, source: Source, parent?: number, signal?: AbortSignal) =>
    get<Blob>(m, 'blob', { repo, path, source, parent }, signal),
  branches: (m: string, repo: string, signal?: AbortSignal) => get<Branch[]>(m, 'branches', { repo }, signal),
  tags: (m: string, repo: string, signal?: AbortSignal) => get<Tag[]>(m, 'tags', { repo }, signal),
  stashes: (m: string, repo: string, signal?: AbortSignal) => get<Stash[]>(m, 'stashes', { repo }, signal),
  watch: (m: string, repo: string, signal?: AbortSignal) => get<Watch>(m, 'watch', { repo }, signal),
  /** A change (Params of backend/features/git/protocol.ts). */
  run: (m: string, repo: string, action: string, params: Record<string, unknown> = {}) => post(m, action, { ...params, repo }),
};
