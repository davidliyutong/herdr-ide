// A repository the Git feature's actions run in: its top level, how git
// runs there, and the checks of revisions, ref names and remotes that need
// the repository.
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import { HEX_REV, REMOTE_NAME, badParams, badRef, plainName } from './check.ts';
import type { Result, Run } from './run.ts';

/** What an action runs git with: in a directory, as a read or a change,
 * and how paths of a request are made absolute. */
export interface GitContext {
  run(dir: string, read: boolean, rn: Run): Promise<Result>;
  expand(p: string): string;
}

/** The text of a run's output. */
export const text = (b: Buffer): string => b.toString('utf8');

export class Repo {
  readonly ctx: GitContext;
  /** The top level. */
  readonly root: string;
  /** The actions that change nothing run as reads. */
  readonly read: boolean;

  constructor(ctx: GitContext, root: string, read: boolean) {
    this.ctx = ctx;
    this.root = root;
    this.read = read;
  }

  git(rn: Run): Promise<Result> {
    return this.ctx.run(this.root, this.read, rn);
  }

  /** The output of a run whose exit code is 0, trimmed; null for one of
   * its allowed other codes. */
  async line(args: string[], ok: number[]): Promise<string | null> {
    try {
      const res = await this.git({ args, ok });
      return res.code === 0 ? text(res.out).trim() : null;
    } catch {
      return null;
    }
  }

  /** Checks a revision: a commit's hash, or a name git resolves to a commit
   * (a branch, a remote branch, a tag, HEAD); the name as given. */
  async rev(s: string | undefined): Promise<string> {
    const name = s ?? '';
    plainName(name);
    if (HEX_REV.test(name)) return name;
    try {
      await this.git({ args: ['rev-parse', '--verify', '--quiet', `${name}^{commit}`] });
    } catch {
      throw badRef(`${JSON.stringify(name)} is not a commit`);
    }
    return name;
  }

  /** Checks that full (refs/heads/<name>, refs/tags/<name>) exists. */
  async refExists(full: string): Promise<void> {
    try {
      await this.git({ args: ['show-ref', '--verify', '--quiet', full] });
    } catch {
      throw new Fail('not_found', 404, `no ${full}`);
    }
  }

  /** Checks the name of a new branch or tag (kind heads or tags) with
   * git's rules. */
  async newName(kind: 'heads' | 'tags', name: string | undefined): Promise<string> {
    const n = name ?? '';
    plainName(n);
    try {
      await this.git({ args: ['check-ref-format', '--allow-onelevel', `refs/${kind}/${n}`] });
    } catch {
      throw badRef(`${JSON.stringify(n)} is not a valid name`);
    }
    return n;
  }

  /** Checks that name is one of the repository's remotes. */
  async remote(name: string): Promise<string> {
    if (!REMOTE_NAME.test(name) || name.includes('..')) throw badRef(`bad remote ${JSON.stringify(name)}`);
    const res = await this.git({ args: ['remote'] });
    if (
      text(res.out)
        .split('\n')
        .some((l) => l.trim() === name)
    )
      return name;
    throw new Fail('not_found', 404, `no remote ${JSON.stringify(name)}`);
  }

  /** Whether HEAD names a commit (not before the first one). */
  async hasHead(): Promise<boolean> {
    return (await this.line(['rev-parse', '-q', '--verify', 'HEAD'], [1, 128])) !== null;
  }
}

/** The repository whose top level is dir (not any directory of one: the
 * actions' paths are relative to the top level). */
export function openRepo(ctx: GitContext, dir: string | undefined, read: boolean): Repo {
  if (!dir || dir.includes('\0')) throw badParams('no repository');
  let abs: string;
  try {
    abs = posix.normalize(ctx.expand(dir));
  } catch (e) {
    throw badParams((e as Error).message);
  }
  let ok = false;
  try {
    const st = statSync(posix.join(abs, '.git'));
    ok = st.isDirectory() || st.isFile();
  } catch {
    // not there
  }
  if (!ok) throw new Fail('not_a_repo', 400, `${abs} is not the top level of a repository`);
  return new Repo(ctx, abs, read);
}

/** A regular file, at most limit bytes of it, opened without blocking on a
 * FIFO; null when it is not one. */
export function readSmall(p: string, limit: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(limit);
    let n = 0;
    for (let r; n < limit && (r = readSync(fd, buf, n, limit - n, null)) > 0;) n += r;
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** A repository's git directory and common directory, found without
 * running git: .git is the directory, or a file "gitdir: <dir>" (a linked
 * worktree, a submodule) whose directory may name the common one in its
 * file commondir. Empty when root has none. */
export function gitDirs(root: string): { gitDir: string; common: string } {
  const dot = posix.join(root, '.git');
  let gitDir = dot;
  try {
    if (!statSync(dot).isDirectory()) {
      const b = readSmall(dot, 64 << 10);
      if (!b) return { gitDir: '', common: '' };
      const line = text(b).split('\n')[0].trim();
      if (!line.startsWith('gitdir:')) return { gitDir: '', common: '' };
      let d = line.slice('gitdir:'.length).trim();
      if (!d.startsWith('/')) d = posix.join(root, d);
      gitDir = posix.normalize(d);
    }
  } catch {
    return { gitDir: '', common: '' };
  }
  let common = gitDir;
  const c = readSmall(posix.join(gitDir, 'commondir'), 64 << 10);
  if (c) {
    let d = text(c).trim();
    if (!d.startsWith('/')) d = posix.join(gitDir, d);
    common = posix.normalize(d);
  }
  return { gitDir, common };
}

/** The operation in progress in a git directory: merge, rebase, cherryPick
 * or revert, "" for none. */
export function progress(gitDir: string): string {
  if (gitDir === '') return '';
  const has = (name: string) => {
    try {
      statSync(posix.join(gitDir, name));
      return true;
    } catch {
      return false;
    }
  };
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherryPick';
  if (has('REVERT_HEAD')) return 'revert';
  return '';
}
