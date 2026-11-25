// The Git feature's actions on a machine (docs/features/31-git.md), as the
// machine side serves them (features/git/machine): the state of a
// repository (its branch, status, history, refs, the contents of files at a
// revision) and the changes the panel and the graph make. Every action
// takes the same parameters (params), each reading its own members; the
// agent checks them (bad_params, bad_ref, not_a_repo) and runs git with an
// argument vector of its own, under its own timeouts (reads 15 s, changes
// 120 s).
//
// The hub passes results on to the page as the agent wrote them, so the
// results are loose objects: they are typed, and a member a later agent
// adds still reaches the page. A Go slice without omitempty may be null.
import { z } from 'zod';
import { defineProtocol, type Action } from '#shared/proto/protocol.ts';

/** How long a read and a change may take: longer than the agent's own
 * timeouts, which end git before them. */
export const READ_MS = 40_000;
export const WRITE_MS = 5 * 60_000;

const str = z.string().optional();
const flag = z.boolean().optional();
const int = z.int().optional();
const strings = z.array(z.string()).optional();

/** The parameters of every action (the agent's Params). */
export const params = z.object({
  /** The repository's top level; path a directory (repo) or a file of the
   * repository (blob). */
  repo: str,
  path: str,
  paths: strings,
  /** Paths a discard removes. */
  untracked: strings,
  /** A stage of all changes leaves untracked files out. */
  tracked: flag,
  /** A commit or ref, the other side of a compare, and the parent
   * (1-based) a commit is shown, cherry-picked or reverted against. */
  rev: str,
  rev2: str,
  parent: int,
  /** A blob's side: worktree, index, head or a revision. */
  source: str,
  /** The log's page, branches (all when empty) and remote branches. */
  skip: int,
  limit: int,
  branches: strings,
  remotes: flag,
  // applyPatch
  patch: str,
  cached: flag,
  reverse: flag,
  // commit, tagCreate, stashPush
  message: str,
  amend: flag,
  signoff: flag,
  // branches and tags
  name: str,
  to: str,
  at: str,
  checkout: flag,
  force: flag,
  // merge, rebase, abort, continue, reset
  ref: str,
  noFF: flag,
  onto: str,
  op: str,
  mode: str,
  // stashes: the entry's index and the commit stash@{index} must name
  index: int,
  hash: str,
  includeUntracked: flag,
  // fetch, pull, push
  remote: str,
  branch: str,
  tag: str,
  prune: flag,
  rebase: flag,
  setUpstream: flag,
  forceWithLease: flag,
  all: flag,
});
export type Params = z.input<typeof params>;

const list = <T extends z.ZodType>(t: T) => z.array(t).nullable();

/** The repository a directory is in. */
export const repoResult = z.looseObject({
  root: z.string(),
  gitDir: z.string(),
  commonDir: z.string(),
  branch: str,
  head: str,
  detached: flag,
  upstream: str,
  ahead: z.number(),
  behind: z.number(),
  /** An operation in progress: merge, rebase, cherryPick or revert. */
  state: str,
  remotes: list(z.string()),
  remoteUrls: z.record(z.string(), z.string()).optional(),
  parents: strings,
  nested: strings,
});

/** A file of the status. */
const file = z.looseObject({
  path: z.string(),
  orig: str,
  x: z.string(),
  y: z.string(),
  kind: z.string(),
  submodule: flag,
  mtime: int,
  size: int,
});

export const statusResult = z.looseObject({
  branch: str,
  head: str,
  upstream: str,
  ahead: z.number(),
  behind: z.number(),
  state: str,
  files: list(file),
  truncated: flag,
  ignored: strings,
  ignoredTruncated: flag,
});

const commit = z.looseObject({
  hash: z.string(),
  parents: list(z.string()),
  author: z.string(),
  email: z.string(),
  /** Unix seconds. */
  date: z.number(),
  subject: z.string(),
});

const stash = z.looseObject({ index: z.number(), hash: z.string(), base: z.string(), date: z.number(), message: z.string() });

export const logResult = z.looseObject({
  commits: list(commit),
  more: z.boolean(),
  refs: z.array(z.looseObject({ name: z.string(), hash: z.string() })).optional(),
  stashes: z.array(stash).optional(),
  head: str,
  branch: str,
});

export const showResult = z.looseObject({
  commit: commit.extend({ committer: z.string(), committerEmail: z.string(), commitDate: z.number(), message: z.string() }).optional(),
  base: z.string(),
  target: z.string(),
  files: list(z.looseObject({ path: z.string(), orig: str, status: z.string(), added: z.number(), deleted: z.number(), binary: flag })),
});

export const blobResult = z.looseObject({
  exists: z.boolean(),
  binary: flag,
  tooLarge: flag,
  text: z.string(),
  size: z.number(),
  mtime: int,
});

const branch = z.looseObject({
  name: z.string(),
  full: z.string(),
  hash: z.string(),
  remote: flag,
  current: flag,
  upstream: str,
  ahead: int,
  behind: int,
  gone: flag,
  date: z.number(),
  subject: z.string(),
});

const tag = z.looseObject({ name: z.string(), hash: z.string(), annotated: flag, date: z.number(), subject: str });

const counts = z.record(z.string(), z.tuple([z.number(), z.number()])).nullable();

/** What a change printed. */
export const done = z.looseObject({ output: str });

/** The actions that change nothing. */
export const READS = ['repo', 'status', 'log', 'show', 'blob', 'branches', 'tags', 'stashes', 'diffStat', 'watch'] as const;
/** The changes. */
export const WRITES = [
  'stage',
  'unstage',
  'applyPatch',
  'discard',
  'commit',
  'checkout',
  'branchCreate',
  'branchDelete',
  'branchRename',
  'merge',
  'rebase',
  'abort',
  'continue',
  'cherryPick',
  'revert',
  'reset',
  'tagCreate',
  'tagDelete',
  'stashPush',
  'stashApply',
  'stashPop',
  'stashDrop',
  'fetch',
  'pull',
  'push',
] as const;
export type Read = (typeof READS)[number];
export type Write = (typeof WRITES)[number];

const read = <R extends z.ZodType>(result: R) => ({ params, result, timeoutMs: READ_MS }) satisfies Action;
const write = { params, result: done, timeoutMs: WRITE_MS } satisfies Action;

export const gitProtocol = defineProtocol('git', {
  repo: read(repoResult),
  status: read(statusResult),
  log: read(logResult),
  show: read(showResult),
  blob: read(blobResult),
  branches: read(list(branch)),
  tags: read(list(tag)),
  stashes: read(list(stash)),
  /** Lines added and deleted per path, in the working tree and the index. */
  diffStat: read(z.looseObject({ worktree: counts, staged: counts })),
  /** A token that changes with the index, HEAD, refs, configuration or an
   * operation in progress; the panel polls it. */
  watch: read(z.looseObject({ token: z.string(), refs: z.string(), config: z.string() })),
  ...(Object.fromEntries(WRITES.map((w) => [w, write])) as Record<Write, typeof write>),
});
