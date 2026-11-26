// The user's trash: on macOS ~/.Trash, elsewhere the freedesktop.org
// trash (the home trash, or the trash at the top of the path's mount when
// it is on another file system). A path no trash can take fails with
// trash_unavailable, and the explorer offers to delete it for good instead.
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { posix } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import { renameNoReplace } from '#machine/sys/fs.ts';
import { errCode, realPath } from './guard.ts';

const { basename, dirname, extname, join, relative } = posix;

const mkdirOwn = (d: string) => {
  try {
    mkdirSync(d, 0o700);
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
  }
};

const split = (base: string) => {
  let ext = extname(base);
  if (ext === base) ext = '';
  return { stem: base.slice(0, base.length - ext.length), ext };
};

/** Moves p into the user's trash; where it went. */
export function trash(p: string, home: string, o: { platform?: string; dataHome?: string; now?: Date } = {}): string {
  const now = o.now ?? new Date();
  if ((o.platform ?? process.platform) === 'darwin') return trashMac(join(home, '.Trash'), p);
  const data = o.dataHome?.startsWith('/') ? o.dataHome : join(home, '.local', 'share');
  // The data directory may be missing on an account no desktop used (a
  // server's): made as gio makes it, 0700 as the specification asks.
  mkdirSync(data, { recursive: true, mode: 0o700 });
  try {
    return trashFreedesktop(join(data, 'Trash'), '', p, now);
  } catch (e) {
    if (errCode(e) !== 'EXDEV') throw e;
  }
  // Another file system: the trash at the top of its mount, which holds
  // paths relative to that top (of p's real path).
  const rp = realPath(p);
  try {
    const top = mountTop(rp);
    return trashFreedesktop(mountTrash(top, process.getuid!()), top, rp, now);
  } catch (e) {
    throw new Fail('trash_unavailable', 409, `no trash for ${p}: ${(e as Error).message}`);
  }
}

/** uid's trash at the top of a mount, as the freedesktop.org trash
 * specification and gio choose it: $top/.Trash/$uid when $top/.Trash is a
 * directory with the sticky bit that is not a link (an administrator's),
 * else $top/.Trash-$uid. Other users may write at the top of a mount
 * (/tmp): a trash directory and its files and info are used only when each
 * is a directory of uid, not a link, without access for anyone else (made
 * so when missing); another user's could read what is trashed into it. */
export function mountTrash(top: string, uid: number): string {
  const shared = join(top, '.Trash');
  try {
    const fi = lstatSync(shared);
    if (fi.isDirectory() && (fi.mode & 0o1000) !== 0) {
      const dir = join(shared, String(uid));
      try {
        privateDirs(dir, uid);
        return dir;
      } catch {
        // the user's own below
      }
    }
  } catch {
    // none
  }
  const dir = join(top, `.Trash-${uid}`);
  privateDirs(dir, uid);
  return dir;
}

/** Makes dir and its files and info directories (0700) where they are
 * missing, and checks that each is a directory of uid (not a link) that
 * nobody else can enter. */
export function privateDirs(dir: string, uid: number): void {
  for (const d of [dir, join(dir, 'files'), join(dir, 'info')]) {
    mkdirOwn(d);
    const fi = lstatSync(d);
    if (!fi.isDirectory()) throw new Error(`${d} is not a directory`);
    if (fi.uid !== uid) throw new Error(`${d} belongs to another user`);
    if ((fi.mode & 0o077) !== 0) throw new Error(`${d} is open to others (${(fi.mode & 0o777).toString(8)})`);
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const localTime = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** A path's name escaped as Go's url.PathEscape escapes a path segment:
 * what is not a letter, a digit, - _ . ~ $ & + : = @ as %XX of its UTF-8
 * bytes. */
function escapeSegment(s: string): string {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9\-_.~$&+:=@]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** A path for a trash info file: as a URL path, keeping the slashes. */
export const escapePath = (p: string): string => p.split('/').map(escapeSegment).join('/');

/** Moves p into the trash dir as the freedesktop.org trash specification
 * describes: a unique name claimed by its info file (info/<name>.trashinfo,
 * with the original path and the time), then the file itself in
 * files/<name>. top is the mount the trash belongs to, whose info files
 * hold paths relative to it; "" for the home trash. */
export function trashFreedesktop(dir: string, top: string, p: string, now: Date): string {
  const files = join(dir, 'files');
  const info = join(dir, 'info');
  for (const d of [dir, files, info]) mkdirOwn(d);
  const orig = top ? relative(top, p) : p;
  const body = `[Trash Info]\nPath=${escapePath(orig)}\nDeletionDate=${localTime(now)}\n`;
  const base = basename(p);
  const { stem, ext } = split(base);
  for (let i = 1; i < 10000; i++) {
    const name = i > 1 ? `${stem}.${i}${ext}` : base;
    const ip = join(info, `${name}.trashinfo`);
    let fd: number;
    try {
      fd = openSync(ip, 'wx', 0o600);
    } catch (e) {
      if (errCode(e) === 'EEXIST') continue;
      throw e;
    }
    const dst = join(files, name);
    try {
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      renameNoReplace(p, dst);
      return dst;
    } catch (e) {
      rmSync(ip, { force: true });
      if (errCode(e) === 'EEXIST') continue; // a file without its info file
      throw e;
    }
  }
  throw new Fail('trash_unavailable', 409, `no free name in ${dir}`);
}

/** Moves p into the trash dir (~/.Trash) under its own name, or "stem
 * 2.ext", "stem 3.ext"… when that is taken. */
export function trashMac(dir: string, p: string): string {
  mkdirOwn(dir);
  const base = basename(p);
  const { stem, ext } = split(base);
  for (let i = 1; i < 10000; i++) {
    const dst = join(dir, i > 1 ? `${stem} ${i}${ext}` : base);
    try {
      renameNoReplace(p, dst);
      return dst;
    } catch (e) {
      const code = errCode(e);
      if (code === 'EEXIST') continue;
      if (code === 'EXDEV') throw new Fail('trash_unavailable', 409, `${p} is on another volume than the trash`);
      throw e;
    }
  }
  throw new Fail('trash_unavailable', 409, `no free name in ${dir}`);
}

/** The top directory of the mount p is on: the highest directory above p
 * on the same device, along p's directory with its links resolved. */
export function mountTop(p: string): string {
  const dev = lstatSync(p, { bigint: true }).dev;
  let top = realpathSync(dirname(p));
  while (top !== '/') {
    const up = dirname(top);
    try {
      if (lstatSync(up, { bigint: true }).dev !== dev) break;
    } catch {
      break;
    }
    top = up;
  }
  return top;
}
