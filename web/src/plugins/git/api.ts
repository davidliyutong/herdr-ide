// The Git plugin's requests to the core (internal/plugins/git): reads are
// GETs with their parameters in the query, changes POSTs with a JSON body.
// The types are those of the machine side (internal/agent/plugin/git).
import { hasMessage, t } from '../../i18n';

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
  /** Repositories this one is nested in, innermost first. */
  parents?: string[];
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

/** A failure with the code the core or the machine gave. */
export class GitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** A failure as the user reads it: the code's text, with what git said. */
export function errorText(e: unknown): string {
  if (e instanceof GitError) {
    const k = `git.error.${e.code}`;
    if (hasMessage(k)) {
      const detail = e.code === 'git_failed' || e.code === 'conflicts' ? e.message.replace(/^[a-z_]+: /, '') : '';
      return detail ? `${t(k)} ${detail}` : t(k);
    }
    return e.message || e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

const base = (m: string) => `/api/m/${encodeURIComponent(m)}/p/git`;

async function answer<T>(r: Response): Promise<T> {
  let j: { error?: string; message?: string } = {};
  try {
    j = await r.json();
  } catch {
    /* the status says it */
  }
  if (!r.ok) throw new GitError(j.error ?? `http_${r.status}`, j.message ?? r.statusText);
  return j as T;
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

async function get<T>(m: string, action: string, q: Query): Promise<T> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === false || v === '') continue;
    if (Array.isArray(v)) for (const x of v) p.append(k, x);
    else p.set(k, v === true ? '1' : String(v));
  }
  return answer<T>(await fetch(`${base(m)}/${action}?${p}`, { cache: 'no-store' }));
}

async function post<T = { output?: string }>(m: string, action: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${base(m)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return answer<T>(r);
}

/** Where a blob comes from: the working tree, the index, HEAD or a
 * revision (with parent: its parent's). */
export type Source = 'worktree' | 'index' | 'head' | string;

export const gitApi = {
  repo: (m: string, path: string) => get<RepoInfo>(m, 'repo', { path }),
  status: (m: string, repo: string) => get<Status>(m, 'status', { repo }),
  log: (m: string, repo: string, o: { skip?: number; limit?: number; branches?: string[]; remotes?: boolean } = {}) =>
    get<LogPage>(m, 'log', { repo, skip: o.skip, limit: o.limit, branch: o.branches, remotes: o.remotes }),
  show: (m: string, repo: string, rev: string, o: { parent?: number; rev2?: string } = {}) =>
    get<Shown>(m, 'show', { repo, rev, parent: o.parent, rev2: o.rev2 }),
  blob: (m: string, repo: string, path: string, source: Source, parent?: number) => get<Blob>(m, 'blob', { repo, path, source, parent }),
  branches: (m: string, repo: string) => get<Branch[]>(m, 'branches', { repo }),
  tags: (m: string, repo: string) => get<Tag[]>(m, 'tags', { repo }),
  stashes: (m: string, repo: string) => get<Stash[]>(m, 'stashes', { repo }),
  watch: (m: string, repo: string) => get<{ token: string }>(m, 'watch', { repo }),
  /** A change (internal/agent/plugin/git's Params). */
  run: (m: string, repo: string, action: string, params: Record<string, unknown> = {}) => post(m, action, { ...params, repo }),
};
