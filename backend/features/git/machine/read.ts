// The Git feature's reads: the repository a directory is in (with the
// repositories it is nested in and those inside it), the status, the log,
// a commit's or a compare's changes, a file's contents at a side, the
// branches, tags and stashes, the lines changed per path, and the token the
// panel polls. Results are written as the Go agent wrote them, which the
// core passes on to the page: a member Go wrote with omitempty is left out
// when empty, a list it always wrote is a list.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { posix } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import { MAX_IGNORED, MAX_STATUS, badParams, cleanPath, remoteURLs } from './check.ts';
import { MAX_OUTPUT } from './run.ts';
import { Repo, gitDirs, progress, readSmall, text, type GitContext } from './repo.ts';

/** Bounds a file's contents the diff pane gets. */
export const MAX_BLOB = 8 << 20;
/** The commits of a page of the log by default, and at most. */
export const PAGE_SIZE = 300;
export const MAX_PAGE = 1000;
/** Bounds the branches with an upstream whose ahead and behind branches
 * reads: each takes a walk of history. */
export const MAX_TRACKED = 300;
/** Bounds the search for repositories inside one. */
export const MAX_NESTED_DEPTH = 8;
const MAX_SCAN_DIRS = 2000;
const MAX_NESTED_REPOS = 64;
/** Bounds the entries of refs/ a watch looks at. */
const MAX_WATCHED = 4000;

type Obj = Record<string, unknown>;

/** v without the members of keys that are empty (Go's omitempty: "", 0,
 * false, an empty list or map, none). */
export function omitEmpty<T extends Obj>(v: T, keys: readonly (keyof T)[]): T {
  for (const k of keys) {
    const x = v[k];
    if (
      x === undefined ||
      x === null ||
      x === '' ||
      x === 0 ||
      x === false ||
      (Array.isArray(x) && x.length === 0) ||
      (typeof x === 'object' && !Array.isArray(x) && Object.keys(x as Obj).length === 0)
    )
      delete v[k];
  }
  return v;
}

const int = (s: string | undefined): number => {
  const n = Number.parseInt(s ?? '', 10);
  return Number.isFinite(n) ? n : 0;
};
const fields = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const millis = (ms: number): number => Math.floor(ms);

// ---- the repository ----

/** The top level of the repository dir is in, "" for none, as dir spells
 * it: git answers the physical path, the explorer and editors show the
 * path through a link to a directory (logical). */
export async function toplevel(ctx: GitContext, dir: string): Promise<string> {
  const res = await ctx.run(dir, true, { args: ['rev-parse', '--show-toplevel', '--show-prefix'], ok: [128] });
  if (res.code !== 0) return '';
  const lines = text(res.out).split('\n');
  return logical(dir, lines[0], lines[1] ?? '');
}

/** The top level top as dir spells it: dir without prefix (its path below
 * the top level, as git gave it) when that is the same directory as top;
 * else top. */
export function logical(dir: string, top: string, prefix: string): string {
  let cand = posix.normalize(dir);
  prefix = prefix.replace(/\/$/, '');
  if (prefix !== '') {
    const below = '/' + prefix;
    if (!cand.endsWith(below)) return top;
    cand = cand.slice(0, -below.length) || '/';
  }
  if (cand === top) return top;
  try {
    return realpathSync(cand) === realpathSync(top) ? cand : top;
  } catch {
    return top;
  }
}

/** The repository dir is in. */
export async function repoInfo(ctx: GitContext, dir: string | undefined): Promise<Obj> {
  if (!dir || dir.includes('\0')) throw badParams('no directory');
  let abs: string;
  try {
    abs = ctx.expand(dir);
  } catch (e) {
    throw badParams((e as Error).message);
  }
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    // not there
  }
  if (!isDir) throw new Fail('not_found', 404, `${abs} is not a directory`);
  let root = await toplevel(ctx, abs);
  if (root === '') throw new Fail('not_a_repo', 400, `${abs} is not in a repository`);
  const info = await infoOf(new Repo(ctx, root, true));
  const parents: string[] = [];
  for (let up = posix.dirname(root), i = 0; up !== root && i < 8; i++) {
    let outer: string;
    try {
      outer = await toplevel(ctx, up);
    } catch {
      break;
    }
    if (outer === '') break;
    parents.push(outer);
    root = outer;
    up = posix.dirname(outer);
  }
  info.parents = parents;
  info.nested = nestedRepos(info.root as string);
  return omitEmpty(info, ['parents', 'nested']);
}

/** The repository's branch, HEAD, upstream, operation in progress and
 * remotes. */
async function infoOf(r: Repo): Promise<Obj> {
  const res = await r.git({ args: ['rev-parse', '--absolute-git-dir', '--git-common-dir'] });
  const lines = text(res.out).trim().split('\n');
  let gitDir = '';
  let commonDir = '';
  if (lines.length >= 2) {
    gitDir = lines[0];
    commonDir = lines[1].startsWith('/') ? lines[1] : posix.join(r.root, lines[1]);
  }
  const sym = await r.line(['symbolic-ref', '-q', 'HEAD'], [1]);
  const branch = sym === null ? '' : sym.replace(/^refs\/heads\//, '');
  const head = (await r.line(['rev-parse', '-q', '--verify', 'HEAD'], [1, 128])) ?? '';
  let upstream = '';
  if (branch && head) upstream = (await r.line(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], [128])) ?? '';
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await r.line(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], [128]);
    if (counts !== null) [ahead, behind] = fields(counts).map(int);
  }
  const remotes: string[] = [];
  try {
    for (const l of text((await r.git({ args: ['remote'] })).out).split('\n')) if (l.trim()) remotes.push(l.trim());
  } catch {
    // none listed
  }
  let remoteUrls: Record<string, string> | undefined;
  if (remotes.length > 0) {
    try {
      remoteUrls = remoteURLs(text((await r.git({ args: ['remote', '-v'] })).out));
    } catch {
      // none
    }
  }
  return omitEmpty(
    {
      root: r.root,
      gitDir,
      commonDir,
      branch,
      head,
      detached: sym === null,
      upstream,
      ahead: ahead || 0,
      behind: behind || 0,
      state: progress(gitDir),
      remotes,
      remoteUrls,
    },
    ['branch', 'head', 'detached', 'upstream', 'state', 'remoteUrls'],
  );
}

/** The repositories inside root (submodules and nested .git directories or
 * files), found breadth first within bounds and never through a link, so
 * deep or huge trees and link loops neither hang the search nor leave
 * root; in lexical order. */
export function nestedRepos(root: string): string[] {
  const out = new Set<string>();
  const add = (p: string) => {
    if (out.size < MAX_NESTED_REPOS) out.add(p);
  };
  for (const p of gitmodulesPaths(root)) {
    const cand = posix.join(root, p);
    if (noLinkOnPath(root, p) && isGitRoot(cand)) add(cand);
  }
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_SCAN_DIRS && out.size < MAX_NESTED_REPOS) {
    const cur = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(cur.dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (scanned >= MAX_SCAN_DIRS || out.size >= MAX_NESTED_REPOS) break;
      if (e.isSymbolicLink() || !e.isDirectory()) continue;
      if (e.name === '.git' || e.name === 'node_modules') continue;
      scanned++;
      const sub = posix.join(cur.dir, e.name);
      if (isGitRoot(sub)) add(sub);
      if (cur.depth + 1 < MAX_NESTED_DEPTH) queue.push({ dir: sub, depth: cur.depth + 1 });
    }
  }
  return [...out].sort();
}

/** The submodules' paths of root/.gitmodules, read without following a
 * link or running git. */
function gitmodulesPaths(root: string): string[] {
  const gm = posix.join(root, '.gitmodules');
  try {
    if (!lstatSync(gm).isFile()) return [];
  } catch {
    return [];
  }
  const b = readSmall(gm, 256 << 10);
  if (!b) return [];
  const paths: string[] = [];
  for (let line of text(b).split('\n')) {
    line = line.trim();
    if (!line.startsWith('path')) continue;
    const rest = line.slice(4).trim();
    if (!rest.startsWith('=')) continue;
    let val = rest.slice(1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      try {
        val = JSON.parse(val) as string;
      } catch {
        val = val.slice(1, -1);
      }
    }
    try {
      paths.push(cleanPath(val.replace(/\/$/, '')));
    } catch {
      // not a path inside the repository
    }
  }
  return paths;
}

/** Whether every element of rel below root is a directory, none a link. */
function noLinkOnPath(root: string, rel: string): boolean {
  let cur = root;
  for (const part of rel.split('/')) {
    cur = posix.join(cur, part);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Whether dir has a .git directory, not a link, with HEAD, or a gitdir
 * file naming a git directory with HEAD. */
function isGitRoot(dir: string): boolean {
  const dot = posix.join(dir, '.git');
  let st;
  try {
    st = lstatSync(dot);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) return false;
  const exists = (p: string, follow: boolean) => {
    try {
      if (follow) statSync(p);
      else lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  if (st.isDirectory()) return exists(posix.join(dot, 'HEAD'), false);
  if (!st.isFile()) return false;
  const { gitDir } = gitDirs(dir);
  return gitDir !== '' && exists(posix.join(gitDir, 'HEAD'), true);
}

// ---- status ----

/** The status's arguments: what changed, then what git ignores (matching:
 * an ignored directory is not walked). */
const STATUS_ARGS = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignored=matching'];

/** What the reads of a machine learned of its git. */
export interface GitState {
  /** git refused --ignored=matching (before git 2.16): statuses are read
   * without what it ignores. */
  noIgnoredMode: boolean;
}

/** Whether git's error refuses --ignored=matching: before 2.16 --ignored
 * took no value; a git that knows modes but not this one says "Invalid
 * ignored mode". */
const refusesIgnoredMode = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes("ignored' takes no value") || m.includes('ignored mode');
};

export async function status(r: Repo, state: GitState): Promise<Obj> {
  const args = state.noIgnoredMode ? STATUS_ARGS.slice(0, -1) : STATUS_ARGS;
  let res;
  try {
    // git prints what it ignores last: output over the limit there keeps
    // the changes whole and cuts the ignored paths.
    res = await r.git({ args, keep: true });
  } catch (e) {
    if (!state.noIgnoredMode && refusesIgnoredMode(e)) {
      state.noIgnoredMode = true;
      return status(r, state);
    }
    throw e;
  }
  const { st, whole } = parseStatus(res.out, res.cut);
  if (!whole) throw new Fail('too_large', 400, `git status printed more than ${MAX_OUTPUT} bytes`);
  const { gitDir } = gitDirs(r.root);
  if (gitDir !== '') st.state = progress(gitDir);
  stamp(r.root, st.files as Obj[]);
  return omitEmpty(st, ['branch', 'head', 'upstream', 'state', 'truncated', 'ignored', 'ignoredTruncated']);
}

/** Gives the files whose working tree side differs from the index the
 * modification time and size of that side (no contents are read). */
function stamp(root: string, files: Obj[]): void {
  for (const f of files) {
    if (f.y === '.' || f.y === 'D') continue;
    try {
      const st = lstatSync(posix.join(root, (f.path as string).replace(/\/$/, '')));
      f.mtime = millis(st.mtimeMs);
      f.size = st.isDirectory() ? 0 : st.size;
    } catch {
      continue;
    }
    omitEmpty(f, ['mtime', 'size']);
  }
}

const file = (v: Obj): Obj => omitEmpty(v, ['orig', 'submodule']);

/** Reads git status --porcelain=v2 -z --branch [--ignored]. cut: the output
 * stopped at its limit (its last record may be partial); whole: every
 * change is there (cut only among the ignored paths, which git prints
 * last). */
export function parseStatus(out: Buffer, cut: boolean): { st: Obj & { files: Obj[]; ignored: string[] }; whole: boolean } {
  const st = { ahead: 0, behind: 0, files: [] as Obj[], ignored: [] as string[] } as Obj & { files: Obj[]; ignored: string[] };
  // Up to the last whole record.
  const buf = cut ? out.subarray(0, out.lastIndexOf(0) + 1) : out;
  const recs = text(buf).split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec === '') continue;
    if (rec[0] === '!') {
      if (st.ignored.length >= MAX_IGNORED) {
        st.ignoredTruncated = true;
        break;
      }
      st.ignored.push(rec.slice(2));
      continue;
    }
    if (st.files.length >= MAX_STATUS) {
      st.truncated = true;
      break;
    }
    const sub = (f: string) => f.length > 0 && f[0] === 'S';
    switch (rec[0]) {
      case '#': {
        const f = fields(rec);
        if (f.length < 3) break;
        if (f[1] === 'branch.oid' && f[2] !== '(initial)') st.head = f[2];
        else if (f[1] === 'branch.head' && f[2] !== '(detached)') st.branch = f[2];
        else if (f[1] === 'branch.upstream') st.upstream = f[2];
        else if (f[1] === 'branch.ab' && f.length >= 4) {
          st.ahead = int(f[2].replace(/^\+/, ''));
          st.behind = int(f[3].replace(/^-/, ''));
        }
        break;
      }
      case '1': {
        // 1 XY sub mH mI mW hH hI path
        const f = splitN(rec, ' ', 9);
        if (f.length === 9)
          st.files.push(file({ path: f[8], x: f[1].slice(0, 1), y: f[1].slice(1), kind: 'changed', submodule: sub(f[2]) }));
        break;
      }
      case '2': {
        // 2 XY sub mH mI mW hH hI Xscore path, then the original path
        const f = splitN(rec, ' ', 10);
        if (f.length === 10 && i + 1 < recs.length) {
          i++;
          st.files.push(file({ path: f[9], orig: recs[i], x: f[1].slice(0, 1), y: f[1].slice(1), kind: 'renamed', submodule: sub(f[2]) }));
        }
        break;
      }
      case 'u': {
        // u XY sub m1 m2 m3 mW h1 h2 h3 path
        const f = splitN(rec, ' ', 11);
        if (f.length === 11)
          st.files.push(file({ path: f[10], x: f[1].slice(0, 1), y: f[1].slice(1), kind: 'unmerged', submodule: sub(f[2]) }));
        break;
      }
      case '?':
        st.files.push({ path: rec.slice(2), x: '?', y: '?', kind: 'untracked' });
        break;
    }
  }
  if (!cut) return { st, whole: true };
  // Cut among the ignored paths (or after the changes were cut short
  // anyway): the changes are whole.
  if (st.truncated || st.ignored.length > 0) {
    st.ignoredTruncated = true;
    return { st, whole: true };
  }
  return { st, whole: false };
}

/** s split at sep into at most n parts, the last with the rest (Go's
 * strings.SplitN). */
function splitN(s: string, sep: string, n: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (out.length < n - 1) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  out.push(rest);
  return out;
}

// ---- log ----

const LOG_FORMAT = '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e';

interface LogParams {
  skip?: number;
  limit?: number;
  branches?: string[];
  remotes?: boolean;
}

export async function log(r: Repo, p: LogParams): Promise<Obj> {
  let limit = p.limit ?? 0;
  if (limit <= 0) limit = PAGE_SIZE;
  limit = Math.min(limit, MAX_PAGE);
  const skip = p.skip ?? 0;
  if (skip < 0) throw badParams('negative skip');
  const head = (await r.line(['rev-parse', '-q', '--verify', 'HEAD'], [1, 128])) ?? '';
  const args = ['log', '--date-order', LOG_FORMAT, `--skip=${skip}`, `--max-count=${limit + 1}`];
  const branches = p.branches ?? [];
  if (branches.length > 0) {
    if (branches.length > 100) throw badParams('at most 100 branches');
    for (const b of branches) args.push(await r.rev(b));
  } else {
    args.push('--branches', '--tags');
    if (p.remotes) args.push('--remotes');
    if (head !== '') args.push('HEAD');
  }
  args.push('--');
  // On a branch without commits yet (HEAD names none) the other branches
  // still have theirs; with no refs at all the log is empty.
  let commits = parseLog(text((await r.git({ args })).out));
  let more = false;
  if (commits.length > limit) {
    commits = commits.slice(0, limit);
    more = true;
  }
  const out: Obj = { commits, more, head };
  if (skip === 0) {
    out.refs = await refs(r);
    out.stashes = await stashes(r);
    out.branch = (await r.line(['symbolic-ref', '-q', '--short', 'HEAD'], [1])) ?? '';
  }
  return omitEmpty(out, ['refs', 'stashes', 'head', 'branch']);
}

function parseLog(out: string): Obj[] {
  const cs: Obj[] = [];
  for (let rec of out.split('\x1e')) {
    rec = rec.replace(/^\n+/, '');
    if (rec === '') continue;
    const f = splitN(rec, '\x1f', 6);
    if (f.length < 6) continue;
    cs.push({ hash: f[0], parents: fields(f[1]), author: f[2], email: f[3], date: int(f[4]), subject: f[5] });
  }
  return cs;
}

/** The branches, remote branches and tags (peeled to their commits),
 * without the remotes' symbolic HEADs. */
async function refs(r: Repo): Promise<Obj[]> {
  const res = await r.git({
    args: ['for-each-ref', '--format=%(objectname)%00%(*objectname)%00%(refname)%00%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags'],
  });
  const out: Obj[] = [];
  for (const l of text(res.out).split('\n')) {
    const f = l.split('\0');
    if (f.length < 4 || f[3] !== '') continue;
    out.push({ name: f[2], hash: f[1] !== '' ? f[1] : f[0] });
  }
  return out;
}

export async function stashes(r: Repo): Promise<Obj[]> {
  const res = await r.git({ args: ['stash', 'list', '--format=%H%x1f%P%x1f%at%x1f%gs%x1e'] });
  const out: Obj[] = [];
  for (let rec of text(res.out).split('\x1e')) {
    rec = rec.replace(/^\n+/, '');
    const f = splitN(rec, '\x1f', 4);
    if (f.length < 4) continue;
    out.push({ index: out.length, hash: f[0], base: fields(f[1])[0] ?? '', date: int(f[2]), message: f[3] });
  }
  return out;
}

// ---- show ----

interface ShowParams {
  rev?: string;
  rev2?: string;
  parent?: number;
}

/** A commit's changes against one of its parents, or the changes between
 * two commits. */
export async function show(r: Repo, p: ShowParams): Promise<Obj> {
  const rev = await r.rev(p.rev);
  const out: Obj = { base: '', target: rev, files: [] };
  if (p.rev2) {
    out.base = rev;
    out.target = await r.rev(p.rev2);
  } else {
    const res = await r.git({ args: ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B', rev, '--'] });
    const f = splitN(text(res.out), '\x1f', 9);
    if (f.length < 9) throw new Fail('failed', 500, 'unexpected output of git show');
    const message = f[8].replace(/\n+$/, '');
    const parents = fields(f[1]);
    out.commit = {
      hash: f[0],
      parents,
      author: f[2],
      email: f[3],
      date: int(f[4]),
      subject: message.split('\n')[0],
      committer: f[5],
      committerEmail: f[6],
      commitDate: int(f[7]),
      message,
    };
    out.target = f[0];
    const n = Math.max(p.parent ?? 0, 1);
    if (parents.length === 0) out.base = await emptyTree(r);
    else if (n > parents.length) throw badParams(`no parent ${n}`);
    else out.base = parents[n - 1];
  }
  out.files = await changes(r, out.base as string, out.target as string);
  return out;
}

/** The hash of the empty tree in the repository's object format. */
async function emptyTree(r: Repo): Promise<string> {
  return text((await r.git({ args: ['hash-object', '-t', 'tree', '/dev/null'] })).out).trim();
}

/** The files that differ between two commits (or trees). */
async function changes(r: Repo, base: string, target: string): Promise<Obj[]> {
  const diff = ['diff', '--no-ext-diff', '--no-textconv', '-z', '-M'];
  const ns = await r.git({ args: [...diff, '--name-status', base, target, '--'] });
  const num = await r.git({ args: [...diff, '--numstat', base, target, '--'] });
  const counts = parseNumstat(text(num.out));
  return parseNameStatus(text(ns.out)).map((c) => {
    const n = counts.get(c.path as string);
    if (n) Object.assign(c, { added: n.added, deleted: n.deleted, binary: n.binary });
    return omitEmpty(c, ['orig', 'binary']);
  });
}

/** Reads diff --name-status -z: "M\0path\0" and "R100\0orig\0path\0". */
function parseNameStatus(out: string): Obj[] {
  const f = out.split('\0');
  const files: Obj[] = [];
  for (let i = 0; i + 1 < f.length; i++) {
    const st = f[i];
    if (st === '') continue;
    const c: Obj = { path: '', orig: '', status: st.slice(0, 1), added: 0, deleted: 0, binary: false };
    if ((c.status === 'R' || c.status === 'C') && i + 2 < f.length) {
      c.orig = f[i + 1];
      c.path = f[i + 2];
      i += 2;
    } else {
      c.path = f[i + 1];
      i++;
    }
    files.push(c);
  }
  return files;
}

/** Reads diff --numstat -z: "a\td\tpath\0", "a\td\t\0orig\0path\0", and
 * "-\t-\t" for binary files. */
function parseNumstat(out: string): Map<string, { added: number; deleted: number; binary: boolean }> {
  const f = out.split('\0');
  const m = new Map<string, { added: number; deleted: number; binary: boolean }>();
  for (let i = 0; i < f.length; i++) {
    const rec = f[i];
    if (rec === '') continue;
    const parts = splitN(rec, '\t', 3);
    if (parts.length < 3) continue;
    let p = parts[2];
    if (p === '' && i + 2 < f.length) {
      p = f[i + 2];
      i += 2;
    }
    m.set(p, parts[0] === '-' ? { added: 0, deleted: 0, binary: true } : { added: int(parts[0]), deleted: int(parts[1]), binary: false });
  }
  return m;
}

// ---- blob ----

interface BlobParams {
  path?: string;
  source?: string;
  parent?: number;
}

const blob = (v: Obj): Obj => omitEmpty<Obj>({ exists: false, text: '', size: 0, ...v }, ['binary', 'tooLarge', 'mtime']);

/** A file's contents in the working tree, the index or a commit. */
export async function readBlob(r: Repo, p: BlobParams): Promise<Obj> {
  const rel = cleanPath(p.path ?? '');
  // A directory (an untracked repository inside this one).
  if (rel.endsWith('/')) return blob({});
  let obj: string;
  switch (p.source ?? '') {
    case 'worktree':
      return worktreeBlob(r.root, rel);
    case 'index':
      obj = `:0:${rel}`;
      break;
    case 'head':
    case '':
      obj = `HEAD:${rel}`;
      break;
    default: {
      let rev = await r.rev(p.source);
      if ((p.parent ?? 0) > 0) rev += `^${p.parent}`;
      obj = `${rev}:${rel}`;
    }
  }
  let res = await r.git({ args: ['cat-file', '-s', obj], ok: [128] });
  if (res.code !== 0) return blob({});
  const size = int(text(res.out).trim());
  if (size > MAX_BLOB) return blob({ exists: true, tooLarge: true, size });
  res = await r.git({ args: ['cat-file', 'blob', obj], limit: MAX_BLOB + 1, ok: [128] });
  if (res.code !== 0) return blob({});
  return blobOf(res.out, size, 0);
}

/** A file of the working tree. A link is shown as its target; a directory
 * on the way that is a link must lead into the repository, so a link to
 * "/" does not make the rest of the machine a part of it. The file is
 * opened without following a link put there meanwhile, without blocking on
 * a FIFO, and read up to MAX_BLOB. */
function worktreeBlob(top: string, rel: string): Obj {
  let root: string;
  let dir: string;
  try {
    root = realpathSync(top);
    dir = realpathSync(posix.dirname(posix.join(top, rel)));
  } catch {
    return blob({});
  }
  if (dir !== root && !dir.startsWith(root + '/')) return blob({});
  const full = posix.join(dir, posix.basename(rel));
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return blob({});
  }
  if (st.isDirectory()) return blob({});
  if (st.isSymbolicLink()) {
    try {
      const target = readlinkSync(full);
      return blobOf(Buffer.from(target), Buffer.byteLength(target), millis(st.mtimeMs));
    } catch {
      return blob({});
    }
  }
  if (!st.isFile()) return blob({});
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return blob({});
    throw new Fail('denied', 403, (e as Error).message);
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) return blob({});
    const mtime = millis(fst.mtimeMs);
    if (fst.size > MAX_BLOB) return blob({ exists: true, tooLarge: true, size: fst.size, mtime });
    // Up to MAX_BLOB and one byte more: the file may grow while it is read.
    const parts: Buffer[] = [];
    let n = 0;
    try {
      for (let k = 1; k > 0 && n <= MAX_BLOB;) {
        const chunk = Buffer.allocUnsafe(Math.min(256 << 10, MAX_BLOB + 1 - n));
        k = readSync(fd, chunk, 0, chunk.length, null);
        if (k > 0) parts.push(chunk.subarray(0, k));
        n += k;
      }
    } catch (e) {
      throw new Fail('denied', 403, (e as Error).message);
    }
    if (n > MAX_BLOB) return blob({ exists: true, tooLarge: true, size: n, mtime });
    return blobOf(Buffer.concat(parts, n), n, mtime);
  } finally {
    closeSync(fd);
  }
}

/** A blob of b: text unless it has a NUL in its first 8000 bytes or is not
 * UTF-8. */
function blobOf(b: Buffer, size: number, mtime: number): Obj {
  if (b.subarray(0, 8000).includes(0) || !isUtf8(b)) return blob({ exists: true, binary: true, size, mtime });
  return blob({ exists: true, text: text(b), size, mtime });
}

// ---- refs ----

export async function branches(r: Repo): Promise<Obj[]> {
  const res = await r.git({
    args: [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(committerdate:raw)%00%(symref)%00%(contents:subject)',
      'refs/heads',
      'refs/remotes',
    ],
  });
  const out: Obj[] = [];
  let tracked = 0;
  for (const l of text(res.out).split('\n')) {
    const f = l.split('\0');
    if (f.length < 7 || f[5] !== '') continue;
    const remote = f[0].startsWith('refs/remotes/');
    const b: Obj = {
      name: remote ? f[0].slice('refs/remotes/'.length) : f[0].replace(/^refs\/heads\//, ''),
      full: f[0],
      hash: f[1],
      remote,
      current: f[3] === '*',
      upstream: f[2],
      ahead: 0,
      behind: 0,
      gone: false,
      date: int(fields(f[4] + ' 0')[0]),
      subject: f[6],
    };
    if (!remote && f[2] !== '') tracked++;
    out.push(b);
  }
  if (tracked > 0 && tracked <= MAX_TRACKED) {
    // Ahead, behind and gone upstreams of the local branches.
    const t = await r.git({ args: ['for-each-ref', '--format=%(refname)%00%(upstream:track,nobracket)', 'refs/heads'] });
    const track = new Map<string, string>();
    for (const l of text(t.out).split('\n')) {
      const i = l.indexOf('\0');
      if (i >= 0) track.set(l.slice(0, i), l.slice(i + 1));
    }
    for (const b of out) {
      if (b.remote || b.upstream === '') continue;
      for (let part of (track.get(b.full as string) ?? '').split(',')) {
        part = part.trim();
        if (part === 'gone') b.gone = true;
        else if (part.startsWith('ahead ')) b.ahead = int(part.slice(6));
        else if (part.startsWith('behind ')) b.behind = int(part.slice(7));
      }
    }
  }
  return out.map((b) => omitEmpty(b, ['remote', 'current', 'upstream', 'ahead', 'behind', 'gone']));
}

export async function tags(r: Repo): Promise<Obj[]> {
  const res = await r.git({
    args: [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(creatordate:raw)%00%(contents:subject)',
      'refs/tags',
    ],
  });
  const out: Obj[] = [];
  for (const l of text(res.out).split('\n')) {
    const f = l.split('\0');
    if (f.length < 6) continue;
    const annotated = f[3] === 'tag';
    out.push(
      omitEmpty(
        {
          name: f[0].replace(/^refs\/tags\//, ''),
          hash: f[2] !== '' ? f[2] : f[1],
          annotated,
          date: int(fields(f[4] + ' 0')[0]),
          subject: annotated ? f[5] : '',
        },
        ['annotated', 'subject'],
      ),
    );
  }
  return out;
}

/** The lines added and deleted per path in the working tree (against the
 * index) and in the index (against HEAD). */
export async function diffStat(r: Repo): Promise<Obj> {
  const side = async (cached: boolean) => {
    const res = await r.git({ args: ['diff', '--no-ext-diff', '--no-textconv', '-z', '--numstat', ...(cached ? ['--cached'] : []), '--'] });
    const m: Record<string, [number, number]> = {};
    for (const [p, c] of parseNumstat(text(res.out))) m[p] = [c.added, c.deleted];
    return m;
  };
  const worktree = await side(false);
  return { worktree, staged: await side(true) };
}

// ---- watch ----

/** A token that changes when the repository's index, HEAD, refs,
 * configuration or an operation in progress change; the panel polls it and
 * reads the status again when it changed. refs changes only with HEAD, the
 * refs (also in reftable) and the stashes: what the history shows; config
 * with the configuration (remotes). */
export function watch(root: string): Obj {
  const { gitDir, common } = gitDirs(root);
  if (gitDir === '') throw new Fail('not_a_repo', 400, `${root} has no git directory`);
  type Hash = ReturnType<typeof createHash>;
  const add = (h: Hash, p: string) => {
    try {
      const st = statSync(p, { bigint: true });
      h.update(`${p} ${st.mtimeNs} ${st.size}\n`);
    } catch {
      h.update(`${p} -\n`);
    }
  };
  const refsHash = createHash('sha256');
  for (const name of ['HEAD', 'logs/HEAD']) add(refsHash, posix.join(gitDir, name));
  for (const name of ['packed-refs', 'logs/refs/stash']) add(refsHash, posix.join(common, name));
  // Refs in reftable: every update writes a table and names it in
  // tables.list.
  for (const d of gitDir === common ? [gitDir] : [gitDir, common]) {
    const b = readSmall(posix.join(d, 'reftable', 'tables.list'), 64 << 10);
    if (b) refsHash.update(`${d} ${createHash('sha256').update(b).digest('hex')}\n`);
  }
  let n = 0;
  const walk = (p: string): boolean => {
    if (++n > MAX_WATCHED) return false;
    add(refsHash, p);
    let names: string[];
    try {
      if (!lstatSync(p).isDirectory()) return true;
      names = readdirSync(p).sort();
    } catch {
      return true;
    }
    for (const name of names) if (!walk(posix.join(p, name))) return false;
    return true;
  };
  try {
    lstatSync(posix.join(common, 'refs'));
    walk(posix.join(common, 'refs'));
  } catch {
    // no refs directory (reftable)
  }
  const refsSum = refsHash.digest();
  const configHash = createHash('sha256');
  add(configHash, posix.join(common, 'config'));
  add(configHash, posix.join(gitDir, 'config.worktree'));
  const configSum = configHash.digest();
  const all = createHash('sha256').update(refsSum).update(configSum);
  for (const name of ['index', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'])
    add(all, posix.join(gitDir, name));
  add(all, posix.join(common, 'FETCH_HEAD'));
  const hex12 = (b: Buffer) => b.subarray(0, 12).toString('hex');
  return { token: hex12(all.digest()), refs: hex12(refsSum), config: hex12(configSum) };
}
