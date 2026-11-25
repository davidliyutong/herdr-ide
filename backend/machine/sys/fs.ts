// File system calls Node lacks: opening a path with no symbolic link
// anywhere on it, a directory relative to another, renaming without
// replacing, removing relative to a directory, and taking a file's lock.
import { closeSync, constants, lstatSync, openSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ptr } from 'bun:ffi';
import { E, SysError, cstr, darwin, errno, libc, linux } from './libc.ts';

const AT_FDCWD = -100;
/** unlinkat's flag for a directory. */
export const AT_REMOVEDIR = linux ? 0x200 : 0x80;
/** Linux: O_CLOEXEC (02000000 on x86-64 and arm64); Node's own opens add it. */
const O_CLOEXEC = 0o2000000;
/** macOS 11: refuse a symbolic link anywhere on the path. */
const O_NOFOLLOW_ANY = 0x20000000;
const RESOLVE_NO_SYMLINKS = 0x04;

/** The numbers of Linux's system calls this module makes. */
const NR =
  process.arch === 'x64'
    ? { openat: 257n, openat2: 437n, renameat2: 316n }
    : process.arch === 'arm64'
      ? { openat: 56n, openat2: 437n, renameat2: 276n }
      : null;

function sys(name: keyof NonNullable<typeof NR>, ...args: bigint[]): bigint {
  if (!NR) throw new SysError(E('ENOSYS'), name);
  while (args.length < 5) args.push(0n);
  return libc().syscall(NR[name], args[0], args[1], args[2], args[3], args[4]) as bigint;
}

const addr = (b: Buffer): bigint => BigInt(ptr(b));

/** Whether openNoLinks refuses links in every directory of a path on this
 * machine; false once the system lacked the means (Linux before 5.6, a
 * container that filters openat2, macOS before 11). */
export const linkGuard = { refusedEverywhere: linux || darwin };

/** Opens path as fs.openSync does, failing with ELOOP when a symbolic link
 * is anywhere on it, so a link swapped in for a directory of a path
 * resolved before does not redirect the open: openat2 with
 * RESOLVE_NO_SYMLINKS (Linux 5.6), O_NOFOLLOW_ANY (macOS 11). Where the
 * system lacks it (ENOSYS, or EPERM from a seccomp filter; EINVAL on an
 * older macOS) only flags' own O_NOFOLLOW applies. Returns the descriptor. */
export function openNoLinks(path: string, flags: number, mode = 0o666): number {
  if (darwin) {
    try {
      // O_NOFOLLOW_ANY covers the last name too; macOS refuses it with
      // O_NOFOLLOW (EINVAL).
      return openSync(path, (flags & ~constants.O_NOFOLLOW) | O_NOFOLLOW_ANY, mode);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EINVAL') throw e;
      linkGuard.refusedEverywhere = false;
      return openSync(path, flags, mode);
    }
  }
  if (!linux) return openSync(path, flags, mode);
  const how = Buffer.alloc(24);
  how.writeBigUInt64LE(BigInt(flags | O_CLOEXEC), 0);
  if (flags & constants.O_CREAT) how.writeBigUInt64LE(BigInt(mode & 0o7777), 8);
  how.writeBigUInt64LE(BigInt(RESOLVE_NO_SYMLINKS), 16);
  const p = cstr(path);
  for (;;) {
    const fd = sys('openat2', BigInt(AT_FDCWD), addr(p), addr(how), 24n);
    if (fd >= 0n) return Number(fd);
    const e = errno();
    if (e === E('EINTR')) continue;
    if (e === E('ENOSYS') || e === E('EPERM')) {
      // Missing, or filtered (seccomp answers either); a real EPERM fails
      // the plain open too.
      const fd = openSync(path, flags, mode);
      linkGuard.refusedEverywhere = false;
      return fd;
    }
    throw new SysError(e, 'openat2', path);
  }
}

/** A directory below another one, opened without following a link: dir is
 * a descriptor of the parent (Linux: openat relative to it), dirPath its
 * path with no link on it (macOS: opened again by path, refusing links
 * anywhere). */
export function openDirAt(dir: number, dirPath: string, name: string): number {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  if (!linux) return openNoLinks(join(dirPath, name), flags);
  const p = cstr(name);
  for (;;) {
    const fd = sys('openat', BigInt(dir), addr(p), BigInt(flags | O_CLOEXEC), 0n);
    if (fd >= 0n) return Number(fd);
    const e = errno();
    if (e !== E('EINTR')) throw new SysError(e, 'openat', join(dirPath, name));
  }
}

/** The names in the directory open as fd, whose path is dirPath (Linux:
 * read through the descriptor, /proc/self/fd, so a directory swapped in
 * at the path is not the one listed). */
export function readDirAt(fd: number, dirPath: string): string[] {
  if (linux) {
    try {
      return readdirSync(`/proc/self/fd/${fd}`);
    } catch {
      // no /proc
    }
  }
  return readdirSync(dirPath);
}

/** Removes name in the directory open as dir (flags: AT_REMOVEDIR for a
 * directory). */
export function unlinkAt(dir: number, name: string, flags: number, path = name): void {
  const p = cstr(name);
  if (libc().unlinkat(dir, p, flags) === 0) return;
  throw new SysError(errno(), 'unlinkat', path);
}

/** Renames from to to, failing with EEXIST when to exists (renameat2
 * RENAME_NOREPLACE on Linux, renamex_np RENAME_EXCL on macOS; a file
 * system or kernel without it gets a check first). */
export function renameNoReplace(from: string, to: string): void {
  const a = cstr(from);
  const b = cstr(to);
  let e: number;
  if (linux) {
    if (sys('renameat2', BigInt(AT_FDCWD), addr(a), BigInt(AT_FDCWD), addr(b), 1n) === 0n) return;
    e = errno();
    if (e !== E('EINVAL') && e !== E('ENOSYS') && e !== E('ENOTSUP') && e !== E('EOPNOTSUPP')) throw new SysError(e, 'rename', to);
  } else if (darwin) {
    if (libc().renamex_np(a, b, 0x4) === 0) return;
    e = errno();
    if (e !== E('ENOTSUP') && e !== E('EINVAL')) throw new SysError(e, 'rename', to);
  }
  renameChecked(from, to);
}

/** Renames after checking that to is free, for file systems that cannot
 * refuse to replace in the rename itself. */
export function renameChecked(from: string, to: string): void {
  try {
    lstatSync(to);
    throw new SysError(E('EEXIST'), 'rename', to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  renameSync(from, to);
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** Takes fd's exclusive lock without waiting (flock); false when another
 * open file description holds it. */
export function tryLock(fd: number): boolean {
  for (;;) {
    if (libc().flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
    const e = errno();
    if (e === E('EINTR')) continue;
    if (e === E('EWOULDBLOCK') || e === E('EAGAIN')) return false;
    throw new SysError(e, 'flock');
  }
}

/** Releases fd's lock. */
export function unlock(fd: number): void {
  libc().flock(fd, LOCK_UN);
}

/** Closes fd, ignoring a descriptor already closed. */
export function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // closed
  }
}
