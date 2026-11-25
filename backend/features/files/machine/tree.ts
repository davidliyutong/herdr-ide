// Copies, moves and removals of trees. A removal never follows a link:
// each directory is opened relative to its parent without following one
// (machine/sys openDirAt), links are removed as links, so a link swapped
// in meanwhile leads nowhere outside the tree. Copies and removals check
// their signal before each entry and chunk: one the core gave up on stops.
import { constants, closeSync, lstatSync, openSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, symlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { AT_REMOVEDIR, closeQuietly, openDirAt, readDirAt, renameNoReplace, unlinkAt } from '#machine/sys/fs.ts';
import { errCode } from './guard.ts';

const { basename, dirname, join } = posix;

/** Throws signal's reason once it ended. */
function check(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
}

/** Lets the event loop run every so many entries of a large tree. */
const yieldEvery = (n: number) => (n % 256 === 0 ? new Promise((r) => setImmediate(r)) : undefined);

/** Copies the file src to dst (which must not exist) with mode, checking
 * signal between chunks. */
export async function copyFile(signal: AbortSignal, src: string, dst: string, mode: number): Promise<void> {
  check(signal);
  // Not waiting on a FIFO swapped in for the file, and only a regular file
  // is copied (sockets, devices and pipes are left out).
  const input = await open(src, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  try {
    if (!(await input.stat()).isFile()) throw Object.assign(new Error(`${src} is not a regular file`), { code: 'EINVAL' });
    const output = await open(dst, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (;;) {
        check(signal);
        const { bytesRead } = await input.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        for (let off = 0; off < bytesRead;) off += (await output.write(buf, off, bytesRead - off)).bytesWritten;
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/** Copies src to dst (which must not exist): files with their mode,
 * directories with their contents, links as links; sockets, devices and
 * pipes are left out. made tells whether it created dst. */
export async function copyTree(signal: AbortSignal, src: string, dst: string): Promise<{ made: boolean; error?: unknown }> {
  let made = false;
  let n = 0;
  const visit = async (p: string, to: string, fi: Stats): Promise<void> => {
    check(signal);
    await yieldEvery(++n);
    if (fi.isSymbolicLink()) await symlink(await readlink(p), to);
    else if (fi.isDirectory()) {
      await mkdir(to, (fi.mode & 0o777) | 0o700);
      if (p === src) made = true;
      for (const name of (await readdir(p)).sort()) {
        const c = join(p, name);
        await visit(c, join(to, name), await lstat(c));
      }
      return;
    } else if (fi.isFile()) await copyFile(signal, p, to, fi.mode & 0o777);
    else return;
    if (p === src) made = true;
  };
  try {
    await visit(src, dst, await lstat(src));
    return { made };
  } catch (error) {
    return { made, error };
  }
}

/** Renames src to dst, failing when dst exists. A rename across file
 * systems (EXDEV) copies src (never over something at dst) and removes it
 * once copied; a copy that fails leaves src as it was and removes what it
 * made. */
export async function moveNoReplace(signal: AbortSignal, src: string, dst: string, rename = renameNoReplace): Promise<void> {
  try {
    rename(src, dst);
    return;
  } catch (e) {
    if (errCode(e) !== 'EXDEV') throw e;
  }
  const { made, error } = await copyTree(signal, src, dst);
  if (error) {
    if (made) rmSync(dst, { recursive: true, force: true });
    throw error;
  }
  // Copied: the source goes whole, whatever the core does meanwhile.
  await removeTree(new AbortController().signal, src);
}

/** Removes p and, for a directory, everything below it. */
export async function removeTree(signal: AbortSignal, p: string): Promise<void> {
  // The parent's links resolved: below it, nothing is followed (macOS
  // opens by this path, refusing a link anywhere on it).
  const dir = realpathSync(dirname(p));
  const parent = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await removeAt(signal, parent, dir, basename(p), { n: 0 });
  } finally {
    closeSync(parent);
  }
}

/** Removes name in the directory parent, whose path (with no link on it)
 * is parentPath. */
async function removeAt(signal: AbortSignal, parent: number, parentPath: string, name: string, count: { n: number }): Promise<void> {
  check(signal);
  await yieldEvery(++count.n);
  const path = join(parentPath, name);
  let unlinkErr: unknown;
  try {
    unlinkAt(parent, name, 0, path);
    return;
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT') return;
    // A directory: EISDIR on Linux, EPERM on macOS; EACCES when the parent
    // is not writable, which removing the directory reports below.
    if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'EACCES') throw e;
    unlinkErr = e;
  }
  for (;;) {
    let fd: number;
    try {
      fd = openDirAt(parent, parentPath, name);
    } catch (e) {
      const code = errCode(e);
      if (code === 'ENOENT') return;
      // Not a directory (a link): the unlink's error stands.
      if (code === 'ENOTDIR' || code === 'ELOOP') throw unlinkErr;
      throw e;
    }
    let names: string[];
    try {
      names = readDirAt(fd, path);
      for (const n of names) await removeAt(signal, fd, path, n, count);
    } finally {
      closeQuietly(fd);
    }
    // Entries made meanwhile are read again.
    if (names.length === 0) break;
  }
  check(signal);
  try {
    unlinkAt(parent, name, AT_REMOVEDIR, path);
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw e;
  }
}

/** Whether something is at p, not following a link. */
export function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
