// Reads and writes the hand-editable JSON files of the hub host
// (settings, keybindings, machines, the vault): atomic, durable
// replacement with private permissions, and a signature that tells whether
// someone else changed the file since it was last read or written.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** The version of a file: its modification time (nanoseconds since the
 * epoch) and size, or that it does not exist. */
export interface Sig {
  exists: boolean;
  mtimeNs: bigint;
  size: number;
}

const missing: Sig = { exists: false, mtimeNs: 0n, size: 0 };

/** Whether a and b are the same version of a file. */
export function sameSig(a: Sig, b: Sig): boolean {
  return a.exists === b.exists && a.mtimeNs === b.mtimeNs && a.size === b.size;
}

/** The file's signature; a file that cannot be read counts as missing. */
export function stat(path: string): Sig {
  try {
    const st = fs.statSync(path, { bigint: true });
    return { exists: true, mtimeNs: st.mtimeNs, size: Number(st.size) };
  } catch {
    return { ...missing };
  }
}

/** The file's content and signature; a missing file is null content
 * without an error. */
export function read(path: string): { data: Buffer | null; sig: Sig } {
  const sig = stat(path);
  try {
    return { data: fs.readFileSync(path), sig };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { data: null, sig: { ...missing } };
    throw e;
  }
}

/** How a file's content and a directory's entries are flushed to disk
 * (tests replace them). */
export const hooks = {
  syncFile(fd: number, _path: string): void {
    fs.fsyncSync(fd);
  },
  syncDir,
};

/** Replaces the file atomically (mode 0600) and returns its new
 * signature. The new content is flushed to disk before it replaces the
 * old file (a failure leaves the old file), and the directory after, so a
 * crash or a power loss leaves the old file or the new one, never an empty
 * or partial one (the vault's file holds the only copy of its values). Its
 * directory is created with 0700; one that exists, is a directory (not a
 * link) and belongs to this user is made 0700 when others may access it.
 * The directory is the namespace's data directory (~/.veldr[-<instance>]),
 * which holds nothing for other users. */
export function write(path: string, data: string | Uint8Array): Sig {
  const dir = dirname(path);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  makePrivate(dir);
  const { fd, tmp } = createTemp(dir, '.' + basename(path) + '-');
  try {
    try {
      fs.writeFileSync(fd, data);
      hooks.syncFile(fd, tmp);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // renamed, or never written
    }
  }
  // The file is replaced: a failure to flush its directory's entry is not
  // one of the write (callers would take the old content for the current
  // one), only of its durability.
  try {
    hooks.syncDir(dir);
  } catch {
    // only durability
  }
  return stat(path);
}

/** A new file of this user only (0600) in dir, named prefix and a random
 * suffix, as Go's os.CreateTemp. */
function createTemp(dir: string, prefix: string): { fd: number; tmp: string } {
  for (let i = 0; ; i++) {
    const tmp = join(dir, prefix + randomBytes(6).toString('hex'));
    try {
      return { fd: fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600), tmp };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i >= 100) throw e;
    }
  }
}

/** Takes group and other access away from dir when it is a directory of
 * this user; a link or another user's directory is left as it is. On
 * Windows it leaves dir as it is: the data directory in the user's profile
 * is the user's own by its access control list, and Windows has no group
 * and other mode bits. */
function makePrivate(dir: string): void {
  if (process.platform === 'win32') return;
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077) === 0) return;
  fs.chmodSync(dir, st.mode & 0o700);
}

/** Makes a rename in dir durable: the directory's entry is flushed to disk
 * as the file's content was. Nothing on Windows, whose directories cannot
 * be flushed through a handle; NTFS journals the rename itself. */
function syncDir(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Calls check every everyMs until signal aborts; resolves then. Stores use
 * it to notice edits made by hand: check compares the file's Sig with the
 * one it last read or wrote, and reloads when they differ. */
export function poll(signal: AbortSignal, everyMs: number, check: () => void): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setInterval(check, everyMs);
    signal.addEventListener(
      'abort',
      () => {
        clearInterval(t);
        resolve();
      },
      { once: true },
    );
  });
}
