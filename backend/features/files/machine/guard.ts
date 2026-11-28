// What the explorer may change: every path goes through the agent's
// expansion, and nothing touches the root, a directory holding the home
// directory (the home directory itself included) or the agent's own data
// directory, compared by file identity (device and inode), so a link or a
// name in another case (a case-insensitive volume) does not reach them.
import { lstatSync, realpathSync, statSync, type BigIntStats, type Stats } from 'node:fs';
import { posix } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import type { Entry } from '../protocol.ts';

const { basename, dirname, join } = posix;

/** A file's identity. */
type ID = string;
const idOf = (st: BigIntStats): ID => `${st.dev}:${st.ino}`;

function identity(p: string, follow: boolean): ID | null {
  try {
    return idOf(follow ? statSync(p, { bigint: true }) : lstatSync(p, { bigint: true }));
  } catch {
    return null;
  }
}

/** A Node or system call's error code (ENOENT…). */
export const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/** An error of the file system as the explorer's code: not_found, exists,
 * denied, no_space, read_only_fs; a Fail as it is; anything else failed, with
 * its message. */
export function codeOf(e: unknown): Fail {
  if (e instanceof Fail) return e;
  const msg = e instanceof Error ? e.message : String(e);
  switch (errCode(e)) {
    case 'ENOENT':
      return new Fail('not_found', 404, msg);
    case 'EEXIST':
    case 'ENOTEMPTY':
      return new Fail('exists', 409, msg);
    case 'EACCES':
    case 'EPERM':
      return new Fail('denied', 403, msg);
    case 'ENOSPC':
    case 'EDQUOT':
      return new Fail('no_space', 507, msg);
    case 'EROFS':
      return new Fail('read_only_fs', 403, msg);
  }
  return new Fail('failed', 500, msg);
}

/** The entry of the file p as fi has it. */
export const entryOf = (p: string, fi: Stats): Entry => ({
  path: p,
  exists: true,
  ...(fi.isDirectory() ? { is_dir: true } : {}),
  size: fi.size,
  mtime: Math.floor(fi.mtimeMs),
});

/** Whether p is dir or below it, by name. */
export const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.replace(/\/+$/, '') + '/');

/** d with the links of its directories resolved as far as it exists; the
 * part not there yet stays as it is. */
function realDir(d: string): string {
  try {
    return realpathSync(d);
  } catch {
    if (d === '/' || d === '.') return d;
    return join(realDir(dirname(d)), basename(d));
  }
}

/** p with the links of its directories resolved (the object a rename or
 * removal of p acts on). */
export function realPath(p: string): string {
  if (p === '/' || p === '.') return p;
  return join(realDir(dirname(p)), basename(p));
}

/** The identities the explorer must not change: the home directory and
 * every directory holding it, along its path as configured and along its
 * real path, and the data directory. */
export class Protection {
  private readonly above = new Set<ID>();
  private readonly base: ID | null;

  constructor(home: string, base: string) {
    const add = (p: string) => {
      for (let q = posix.normalize(p); ; q = dirname(q)) {
        const id = identity(q, true);
        if (id) this.above.add(id);
        if (q === '/' || q === '.') return;
      }
    };
    if (home) {
      add(home);
      try {
        add(realpathSync(home));
      } catch {
        // not there
      }
    }
    this.base = base ? identity(base, true) : null;
  }

  /** Whether p (absolute, clean) names the home directory or one above it,
   * or the data directory or something in it. p's last name is not
   * followed (a rename or removal acts on a link, not on what it names);
   * the links of its directories are. */
  refuses(p: string): boolean {
    const rp = realPath(p);
    const own = identity(rp, false);
    if (own && this.above.has(own)) return true;
    if (!this.base) return false;
    for (let q = rp; ; q = dirname(q)) {
      if (identity(q, q !== rp) === this.base) return true;
      if (q === '/' || q === '.') return false;
    }
  }
}

/** Expands and refuses the paths of the explorer's actions. */
export class Guard {
  private prot?: Protection;
  readonly home: string;
  readonly base: string;
  private readonly expandPath: (p: string) => string;

  constructor(o: { home: string; base: string; expand: (p: string) => string }) {
    this.home = o.home;
    this.base = o.base;
    this.expandPath = o.expand;
  }

  /** p absolute and clean; alone, for the directory a move or copy puts
   * paths into, which is not changed itself (each path landing in it is
   * resolved). */
  expand(p: string): string {
    if (!p || p.includes('\0')) throw new Fail('bad_params', 400, 'no path');
    try {
      return posix.normalize(this.expandPath(p)).replace(/(.)\/+$/, '$1');
    } catch (e) {
      throw new Fail('bad_params', 400, (e as Error).message);
    }
  }

  /** p expanded; refused when it is the root, holds the home directory or
   * is in the data directory, by its name and by the identity of what it
   * names once the links of its directories are followed. */
  resolve(p: string): string {
    const abs = this.expand(p);
    this.prot ??= new Protection(this.home, this.base);
    if (refusedByName(abs, this.home, this.base) || this.prot.refuses(abs)) throw new Fail('refused', 403, `${abs} is protected`);
    return abs;
  }
}

/** Whether p is the root, holds home (or is it), or is base or below it,
 * by name. */
export function refusedByName(p: string, home: string, base: string): boolean {
  if (p === '/') return true;
  if (home && within(posix.normalize(home), p)) return true;
  return !!base && within(p, posix.normalize(base));
}

/** Whether dir is src or below it, following links: a copy or move of src
 * into dir would put src inside itself. A link src is copied as a link,
 * which holds nothing. */
export function holds(src: string, dir: string): boolean {
  if (within(dir, src)) return true;
  let sid: ID;
  try {
    const st = lstatSync(src, { bigint: true });
    if (!st.isDirectory()) return false;
    sid = idOf(st);
  } catch {
    return false;
  }
  let rd: string;
  try {
    rd = realpathSync(dir);
  } catch {
    return false;
  }
  for (let q = rd; ; q = dirname(q)) {
    if (identity(q, true) === sid) return true;
    if (q === '/' || q === '.') return false;
  }
}
