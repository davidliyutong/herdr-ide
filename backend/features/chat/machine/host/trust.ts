// Which directories may be trusted (Op.Trust): an agent started in a
// trusted folder loads the project's own settings (hooks, MCP servers,
// instructions), which run programs, so only a directory that nobody else
// can change, and that is not the home (which holds every project of the
// user's) or above it, may be.
import { realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import * as chat from '#shared/proto/chatproto/index.ts';

/** A file's device and inode: what tells that a path still is the
 * directory that was trusted. */
export interface FileID {
  dev: bigint;
  ino: bigint;
}

export const sameID = (a: FileID, b: FileID): boolean => a.dev === b.dev && a.ino === b.ino;

/** The directory above an absolute, clean path; "/" for "/". */
export function parentDir(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** Whether dir is a directory above p: p is below it. */
export function within(dir: string, p: string): boolean {
  if (dir === '/') return p !== '/';
  return p.startsWith(dir + '/');
}

/** Whether p is a clean absolute path. */
export const cleanAbs = (p: string): boolean =>
  p !== '' && posix.isAbsolute(p) && posix.normalize(p) === p && (p === '/' || !p.endsWith('/'));

/** The device and inode of the directory dir is, when it may be trusted;
 * throws a ChatProtoError (unsafe_folder, or bad_request for no directory)
 * when it may not. It may not be "/", the user's home directory or a
 * directory above it, a directory that is not the user's, or that its group
 * or others may write, nor one below a directory others may write that has
 * no sticky bit (anyone could put another directory in its place). Links are
 * followed: what is checked is the directory they lead to, and the
 * directories above that one. home is the user's home directory, "" for
 * none. */
export async function trustable(dir: string, home: string, uid: number = process.getuid!()): Promise<FileID> {
  const unsafe = (why: string) => new chat.ChatProtoError({ code: chat.Code.UnsafeFolder, message: `${dir} may not be trusted: ${why}` });
  const notDir = () => new chat.ChatProtoError({ code: chat.Code.BadRequest, message: 'cwd is not a directory' });
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    throw notDir();
  }
  if (!posix.isAbsolute(real)) throw notDir();
  if (dir === '/' || real === '/') throw unsafe('the root directory');
  if (home !== '' && posix.isAbsolute(home)) {
    const homes = [posix.normalize(home)];
    try {
      homes.push(await realpath(home));
    } catch {
      // the home as written
    }
    for (const h of homes)
      for (const d of [dir, real]) if (d === h || within(d, h)) throw unsafe('the home directory or a directory above it');
  }
  let st;
  try {
    st = await stat(real, { bigint: true });
  } catch {
    throw notDir();
  }
  if (!st.isDirectory()) throw notDir();
  if (Number(st.uid) !== uid) throw unsafe("another user's directory");
  if ((Number(st.mode) & 0o022) !== 0) throw unsafe('its group or others may write it');
  for (let p = parentDir(real); ; p = parentDir(p)) {
    let pst;
    try {
      pst = await stat(p);
    } catch {
      throw unsafe('a directory above it cannot be read');
    }
    if ((pst.mode & 0o002) !== 0 && (pst.mode & 0o1000) === 0) throw unsafe(`it is below ${p}, which others may write`);
    if (p === '/') break;
  }
  return { dev: st.dev, ino: st.ino };
}
