// How the coding agents' files are read (sessions.ts): every call is
// asynchronous (the node's one thread never waits for the file system),
// a file is opened without blocking (a FIFO or a device put at a name
// fails at once instead of waiting) and taken only when it is a regular
// file of the agent's user's own with one name, and a transcript is
// opened with no link followed anywhere on its path, checked on the
// descriptor to be the file found.
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import type { BigIntStats, Dirent } from 'node:fs';
import { posix } from 'node:path';
import { openAtAsync, openNoLinksAsync } from '#machine/sys/fs.ts';

/** How files are opened: read-only, without blocking, never as the
 * controlling terminal (Node's opens are close-on-exec). */
const FILE_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;

/** A file as the system knows it: its device and inode. */
export interface FileId {
  dev: bigint;
  ino: bigint;
}

export const sameFile = (a: FileId, b: FileId): boolean => a.dev === b.dev && a.ino === b.ino;

/** Why a file is not one to read (gone() takes it as gone). */
export class FileRefused extends Error {
  readonly code: 'not_regular' | 'not_own' | 'too_large' | 'not_clean';
  constructor(code: FileRefused['code']) {
    super(`sessions: ${code.replace('_', ' ')}`);
    this.code = code;
  }
}

/** Whether a failed open says the path does not name the file that was
 * there: missing, a link on the way (ELOOP; ENOTDIR or EMLINK where a
 * system says so), or not a regular file of the user's own. */
export function gone(e: unknown): boolean {
  if (e instanceof FileRefused) return true;
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR' || code === 'EMLINK';
}

export interface FilesOptions {
  /** The user and primary group whose files are trusted (tests give
   * others); this process's by default. */
  uid?: number;
  gid?: number;
  /** Called with every path opened, before it is (tests). */
  onOpen?: (path: string) => void;
}

/** The files of the agent's user. */
export class Files {
  readonly uid: number;
  readonly gid: number;
  private readonly onOpen: (path: string) => void;

  constructor(o: FilesOptions = {}) {
    this.uid = o.uid ?? process.getuid?.() ?? -1;
    this.gid = o.gid ?? process.getgid?.() ?? -1;
    this.onOpen = o.onOpen ?? (() => {});
  }

  /** A regular file of the user's own with one name (a hard link inside a
   * session root to a file elsewhere has two). */
  own(st: BigIntStats): boolean {
    return st.isFile() && Number(st.uid) === this.uid && st.nlink === 1n;
  }

  /** A directory the user's alone to write: no other user may, and no
   * group either, but on Linux the user's own primary group (user private
   * groups: the group a umask of 002 leaves writable). On macOS every
   * user's primary group is staff, so a directory that group may write is
   * not private. What protects a record or a transcript is above all its
   * own check, a regular file the user owns (own, readRecord); the
   * directory's check keeps others from choosing which of the user's
   * files a name holds. */
  private(st: BigIntStats): boolean {
    if (!st.isDirectory() || (st.mode & 0o002n) !== 0n) return false;
    return (st.mode & 0o020n) === 0n || (process.platform === 'linux' && Number(st.gid) === this.gid);
  }

  /** At most max entries of a directory, in no particular order; none
   * when it cannot be read (opened as a directory: a FIFO at the name
   * fails at once). */
  async readDir(dir: string, max: number): Promise<Dirent[]> {
    this.onOpen(dir);
    const out: Dirent[] = [];
    let d;
    try {
      d = await opendir(dir);
    } catch {
      return out;
    }
    try {
      for (let e = await d.read(); e && out.length < max; e = await d.read()) out.push(e);
    } catch {
      // what was read
    } finally {
      await d.close().catch(() => {});
    }
    return out;
  }

  /** What lstat says of p; null when it cannot. */
  async lstat(p: string): Promise<BigIntStats | null> {
    try {
      return await lstat(p, { bigint: true });
    } catch {
      return null;
    }
  }

  /** What lstat says of p when it is a regular file of the user's own
   * with one name; null otherwise. */
  async lstatOwn(p: string): Promise<BigIntStats | null> {
    const st = await this.lstat(p);
    return st && this.own(st) ? st : null;
  }

  /** p resolved through links; null when it cannot be. */
  async realpath(p: string): Promise<string | null> {
    try {
      return await realpath(p);
    } catch {
      return null;
    }
  }

  /** Opens p refusing a link at its last name only, for paths made from
   * directories not held to be free of links (a linked ~/.claude is
   * common), whose files are checked once open: a regular file, read
   * whole or the reader's way. */
  async openNoFollow(p: string): Promise<FileHandle> {
    this.onOpen(p);
    const fh = await open(p, FILE_FLAGS | constants.O_NOFOLLOW);
    try {
      if (!(await fh.stat()).isFile()) throw new FileRefused('not_regular');
    } catch (e) {
      await fh.close().catch(() => {});
      throw e;
    }
    return fh;
  }

  /** A regular file of at most max bytes (openNoFollow). */
  async readSmall(p: string, max: number): Promise<Buffer> {
    const fh = await this.openNoFollow(p);
    try {
      return await readMax(fh, max);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  /** Opens p, an absolute clean path, with no link followed anywhere on it
   * (openNoLinksAsync), as a regular file of the user's own with one name;
   * what fstat says of it too. */
  async openStrict(p: string): Promise<{ fh: FileHandle; st: BigIntStats }> {
    if (!posix.isAbsolute(p) || posix.normalize(p) !== p || (p.length > 1 && p.endsWith('/'))) throw new FileRefused('not_clean');
    this.onOpen(p);
    const fh = await openNoLinksAsync(p, FILE_FLAGS | constants.O_NOFOLLOW);
    try {
      const st = await fh.stat({ bigint: true });
      if (!st.isFile()) throw new FileRefused('not_regular');
      if (!this.own(st)) throw new FileRefused('not_own');
      return { fh, st };
    } catch (e) {
      await fh.close().catch(() => {});
      throw e;
    }
  }

  /** Opens a located file, p, with no link followed and checks that it is
   * the file found there (want): null when it is not (gone, a link on the
   * way, another file, not the user's own); other failures (permissions,
   * no descriptors left) throw the system's error, which names no path
   * once the caller reports its code. */
  async openAs(p: string, want: FileId): Promise<FileHandle | null> {
    if (want.dev === 0n && want.ino === 0n) return null;
    let o;
    try {
      o = await this.openStrict(p);
    } catch (e) {
      if (gone(e)) return null;
      throw e;
    }
    if (!sameFile(o.st, want)) {
      await o.fh.close().catch(() => {});
      return null;
    }
    return o.fh;
  }

  /** Reads Claude Code's record dir/name, at most max bytes: dir must be
   * the user's alone to write (private), checked on the directory open,
   * and the record a regular file the user owns, opened in that directory
   * without following a link at its name. */
  async readRecord(dir: string, name: string, max: number): Promise<Buffer> {
    this.onOpen(dir);
    const dh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK);
    try {
      const dst = await dh.stat({ bigint: true });
      if (!this.private(dst)) throw new FileRefused('not_own');
      let openDir = dir;
      if (process.platform !== 'linux') {
        const real = await this.realpath(dir);
        if (real) {
          const rst = await this.lstat(real);
          if (!rst || !sameFile(dst, rst)) throw new FileRefused('not_own');
          openDir = real;
        }
      }
      this.onOpen(posix.join(dir, name));
      const fh = await openAtAsync(dh, openDir, name, FILE_FLAGS);
      try {
        const st = await fh.stat({ bigint: true });
        if (!st.isFile() || Number(st.uid) !== this.uid) throw new FileRefused('not_own');
        return await readMax(fh, max);
      } finally {
        await fh.close().catch(() => {});
      }
    } finally {
      await dh.close().catch(() => {});
    }
  }
}

/** All of fh, at most max bytes (too_large beyond). */
export async function readMax(fh: FileHandle, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let got = 0;
  for (;;) {
    const b = Buffer.allocUnsafe(Math.min(64 << 10, max + 1 - got));
    const { bytesRead } = await fh.read(b, 0, b.length, null);
    if (bytesRead === 0) break;
    parts.push(b.subarray(0, bytesRead));
    got += bytesRead;
    if (got > max) throw new FileRefused('too_large');
  }
  return Buffer.concat(parts, got);
}

/** At most n bytes of fh from its start. */
export async function readHead(fh: FileHandle, n: number): Promise<Buffer> {
  const b = Buffer.allocUnsafe(n);
  let got = 0;
  while (got < n) {
    const { bytesRead } = await fh.read(b, got, n - got, got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return b.subarray(0, got);
}

/** Reads the first line in growing prefixes until its leading metadata is
 * available. The last prefix is bounded even for a very large first line. */
export async function readMetadata<T>(fh: FileHandle, max: number, decode: (head: Buffer) => T | null): Promise<T | null> {
  let data = Buffer.allocUnsafe(Math.min(max, 16 << 10));
  let got = 0;
  for (;;) {
    const from = got;
    while (got < data.length) {
      const { bytesRead } = await fh.read(data, got, data.length - got, got);
      if (!bytesRead) break;
      got += bytesRead;
      const newline = data.subarray(from, got).indexOf(10);
      if (newline >= 0) return decode(data.subarray(0, from + newline));
    }
    const found = decode(data.subarray(0, got));
    if (found || got < data.length || data.length === max) return found;
    const more = Buffer.allocUnsafe(Math.min(max, data.length * 2));
    data.copy(more);
    data = more;
  }
}
