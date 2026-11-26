// Writing a file that may be there (an editor's save, an upload that
// replaces a file) as VS Code writes a user's file: the file itself is
// opened and its content rewritten in place (truncated, written, synced).
// The path keeps its file: its inode, hard links, owner, group, mode,
// extended attributes and ACLs stay, and a directory the user may not
// create files in takes the save. Nothing is ever created beside the file
// (no temporary file, no backup), so a directory others may write gives
// them nothing to swap.
//
// The text is received in full before the file is opened, so a transfer
// that breaks off changes nothing. The file opened is the one checked: the
// precondition (the file as the editor loaded it) is checked on the
// descriptor that is then written. A write that fails after the file was
// truncated (a full disk, an I/O error) leaves part of the text in it
// (partial_write). Through a symbolic link the link's target is written
// (the caller resolves it); the link stays.
import { randomBytes } from 'node:crypto';
import { close, constants, fstat, fstatSync, fsync, ftruncate, lstatSync, read, unlinkSync, write, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { Fail } from '#shared/lib/fail.ts';
import { ChunkReader } from '#shared/proto/agentproto/index.ts';
import { openNoLinks } from '#machine/sys/fs.ts';
import type { Entry } from '../protocol.ts';
import { codeOf, entryOf, errCode } from './guard.ts';

const { basename, dirname, join } = posix;
const writeAsync = promisify(write);
const syncAsync = promisify(fsync);
const readAsync = promisify(read);
const fstatAsync = promisify(fstat);
const truncateAsync = promisify(ftruncate);
const closeAsync = promisify(close);
const saving = new Map<string, Promise<unknown>>();

/** A save rechecks the descriptor after earlier writes to the same inode,
 * including writes through another hard link. */
async function withFileWrite<T>(path: string, fd: number, write: () => Promise<T>): Promise<T> {
  const file = await fstatAsync(fd);
  if (!file.isFile()) throw notRegular(path);
  const key = `${file.dev}:${file.ino}`;
  const previous = saving.get(key);
  const run = (previous?.catch(() => {}) ?? Promise.resolve()).then(write);
  saving.set(key, run);
  try {
    return await run;
  } finally {
    if (saving.get(key) === run) saving.delete(key);
  }
}

/** The private directory (0700) of the data directory an upload is
 * received into before it is written to its file. */
export const STAGING_DIR = 'staging';
/** How long an upload broken off by the agent's end leaves the file it
 * was received into. */
export const STAGING_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** What a save writes: bytes received, or an upload's staged file. */
export interface Source {
  readonly size: number;
  /** Reads into buf at position pos; the number of bytes read. */
  read(buf: Buffer, pos: number): Promise<number>;
}

export const bufferSource = (b: Buffer): Source => ({
  size: b.length,
  read: async (buf, pos) => b.copy(buf, 0, pos, Math.min(b.length, pos + buf.length)),
});

const fileSource = (fd: number, size: number): Source => ({
  size,
  read: async (buf, pos) => (await readAsync(fd, buf, 0, Math.min(buf.length, size - pos), pos)).bytesRead,
});

/** Writes what src holds into the descriptor fd from its start. */
export type Fill = (fd: number, src: Source) => Promise<void>;

export const copyInto: Fill = async (fd, src) => {
  const buf = Buffer.allocUnsafe(Math.min(1 << 20, Math.max(src.size, 1)));
  for (let pos = 0; pos < src.size;) {
    const n = await src.read(buf, pos);
    if (n <= 0) throw new Error('the text ended early');
    for (let off = 0; off < n;) off += (await writeAsync(fd, buf, off, n - off, pos + off)).bytesWritten;
    pos += n;
  }
};

/** What a save expects: the file as the editor loaded it (expect; none:
 * the file must not exist), unless force. */
export interface Expect {
  expect?: Entry;
  force?: boolean;
}

/** A write that failed after the file was truncated: the file may hold
 * part of the text. */
export class PartialError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
  }
}

/** The failure of a save as the plugin answers it: partial_write with the
 * cause's code (no_space…) as its message, which the UIs show with it. */
export function saveErr(e: unknown): Fail {
  if (e instanceof PartialError) return new Fail('partial_write', 500, codeOf(e.cause).code);
  return codeOf(e);
}

/** The failure of a save whose file changed (fi null: was removed) since
 * the editor loaded it; the message is the file's state now as JSON. */
export function conflict(p: string, fi: Stats | null): Fail {
  const e: Entry = fi ? entryOf(p, fi) : { path: p, exists: false, size: 0, mtime: 0 };
  return new Fail('conflict', 409, JSON.stringify(e));
}

const lstatOrNull = async (p: string): Promise<Stats | null> => {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
};

const notRegular = (p: string) => new Fail('bad_params', 400, `${p} is not a regular file`);

/** Checks that the file p, which is there as fi, is what a save expects. */
export function expected(p: string, fi: Stats, w: Expect): void {
  if (w.force) return;
  if (!w.expect?.exists) throw conflict(p, fi); // a new file was expected
  if (fi.size !== w.expect.size || Math.floor(fi.mtimeMs) !== w.expect.mtime) throw conflict(p, fi);
}

/** Checks the file at p before the text is received; the save checks it
 * again on the file it opens. */
export async function precondition(p: string, w: Expect): Promise<void> {
  if (w.force) return;
  let fi: Stats;
  try {
    fi = await stat(p);
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw codeOf(e);
    if (w.expect?.exists) throw conflict(p, null);
    return;
  }
  if (fi.isDirectory()) throw new Fail('bad_params', 400, `${p} is a directory`);
  expected(p, fi, w);
}

/** The file a symbolic link at p names (which may not exist yet): p's real
 * path, or p itself when nothing is there. */
export async function target(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (e) {
    if (errCode(e) === 'ENOENT' && !(await lstatOrNull(p))) return p; // a new file
    throw codeOf(e);
  }
}

/** Makes what src holds the content of the file p (its real path: the
 * caller resolved its links), once w holds on the file opened. A file not
 * there is created (createFile), only with mayCreate (else it is a
 * conflict: a file that comes and goes meanwhile ends the save). The file
 * is opened without following a link anywhere on its path (a link swapped
 * in since it was resolved, for the file or a directory above it, is a
 * conflict, also when forced), without blocking (a FIFO) and without
 * becoming a controlling terminal, and must be a regular file. */
export async function writeFile(p: string, src: Source, w: Expect, fill: Fill = copyInto, mayCreate = true): Promise<Entry> {
  const lfi = await lstatOrNull(p);
  // A device or a FIFO is never opened.
  if (lfi && !lfi.isFile() && !lfi.isSymbolicLink()) throw notRegular(p);
  if (!lfi) {
    if (mayCreate) return createFile(p, src, w, fill, true);
    throw conflict(p, null);
  }
  let fd: number;
  try {
    fd = openNoLinks(p, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (e) {
    switch (errCode(e)) {
      case 'ENOENT':
        if (mayCreate) return createFile(p, src, w, fill, true);
        throw conflict(p, null);
      case 'ELOOP':
        // A link since the caller resolved the path: the pane says the
        // file changed.
        throw conflict(p, await lstatOrNull(p));
      case 'EISDIR':
      case 'ENXIO':
        throw notRegular(p);
    }
    throw codeOf(e);
  }
  try {
    return await withFileWrite(p, fd, async () => {
      const fi = await fstatAsync(fd);
      if (!fi.nlink) throw conflict(p, await lstatOrNull(p));
      expected(p, fi, w);
      try {
        await truncateAsync(fd, 0);
      } catch (e) {
        throw codeOf(e); // nothing changed
      }
      await fillSynced(fd, src, fill);
      return entryOf(p, await fstatAsync(fd));
    });
  } finally {
    await closeAsync(fd).catch(() => {});
  }
}

/** Creates the file p for a save or an upload and writes what src holds
 * into it: with what the umask leaves of 0666, in its directory resolved,
 * failing when a file or a link appeared there meanwhile (a conflict; with
 * force and again, a file is written in place). A new file the write
 * failed for is removed (only while its name still names it). */
export async function createFile(p: string, src: Source, w: Expect, fill: Fill = copyInto, again = false): Promise<Entry> {
  if (!w.force && w.expect?.exists) throw conflict(p, null); // removed since it was loaded
  let dir: string;
  try {
    dir = await realpath(dirname(p));
  } catch (e) {
    throw codeOf(e);
  }
  const real = join(dir, basename(p));
  let fd: number;
  try {
    fd = openNoLinks(real, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NOCTTY, 0o666);
  } catch (e) {
    switch (errCode(e)) {
      case 'EEXIST':
        if (w.force && again) {
          const entry = await writeFile(real, src, { force: true }, fill, false);
          return { ...entry, path: p };
        }
        throw conflict(p, await lstatOrNull(real));
      case 'ELOOP':
        throw conflict(p, await lstatOrNull(real)); // a directory became a link
    }
    throw codeOf(e);
  }
  try {
    return await withFileWrite(p, fd, async () => {
      try {
        await fillSynced(fd, src, fill);
      } catch (e) {
        removeOwn(real, fd);
        throw codeOf(e instanceof PartialError ? e.cause : e);
      }
      return entryOf(p, await fstatAsync(fd));
    });
  } finally {
    await closeAsync(fd).catch(() => {});
  }
}

async function fillSynced(fd: number, src: Source, fill: Fill): Promise<void> {
  try {
    await fill(fd, src);
    await syncAsync(fd);
  } catch (e) {
    throw new PartialError(e);
  }
}

/** Removes p while it names the file open as fd. */
function removeOwn(p: string, fd: number): void {
  try {
    const o = fstatSync(fd, { bigint: true });
    const l = lstatSync(p, { bigint: true });
    if (o.dev === l.dev && o.ino === l.ino) unlinkSync(p);
  } catch {
    // gone
  }
}

/** Receives a ChunkWriter body (at most limit bytes) with sink. It reads
 * the body to its end marker whatever happens (a full disk, too much
 * text): the hub sends all of it before it reads the answer. A body that
 * breaks off throws. */
export async function receive(chunks: ChunkReader, limit: number, sink: (b: Buffer) => Promise<void> | void): Promise<void> {
  let n = 0;
  let err: unknown = null;
  for await (const b of chunks) {
    if (err) continue;
    n += b.length;
    if (n > limit) {
      err = new Fail('too_large', 413, `more than ${limit} bytes`);
      continue;
    }
    try {
      await sink(b);
    } catch (e) {
      err = e;
    }
  }
  if (err) throw err;
}

/** Receives an editor's text in full. */
export async function receiveText(chunks: ChunkReader, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  await receive(chunks, limit, (b) => void parts.push(b));
  return Buffer.concat(parts);
}

/** Receives an upload into a new file (0600) of the data directory's
 * private staging directory, runs use with it as the source, and removes
 * it before returning. */
export async function staged<T>(base: string, chunks: ChunkReader, limit: number, use: (src: Source) => Promise<T>): Promise<T> {
  if (!base) throw new Fail('denied', 403, 'no data directory');
  const d = join(base, STAGING_DIR);
  await mkdir(d, { recursive: true, mode: 0o700 });
  const fi = await lstat(d);
  if (!fi.isDirectory()) throw new Fail('failed', 500, `${d} is not a directory`);
  if ((fi.mode & 0o777) !== 0o700) await chmod(d, 0o700);
  let path = '';
  let stagedFile: FileHandle | undefined;
  for (let i = 0; i < 100 && !stagedFile; i++) {
    path = join(d, `upload-${randomBytes(4).toString('hex')}`);
    try {
      stagedFile = await open(path, 'wx+', 0o600);
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw codeOf(e);
    }
  }
  if (!stagedFile) throw new Fail('exists', 409, `no free name in ${d}`);
  const fd = stagedFile.fd;
  try {
    let size = 0;
    await receive(chunks, limit, async (b) => {
      for (let off = 0; off < b.length;) off += (await writeAsync(fd, b, off, b.length - off, size + off)).bytesWritten;
      size += b.length;
    });
    return await use(fileSource(fd, size));
  } finally {
    await stagedFile.close().catch(() => {});
    await unlink(path).catch(() => {});
  }
}

/** Removes the files uploads were received into (in the data directory
 * base) more than retention before now: left only when the agent ended
 * during an upload (a crash, a kill). */
export async function pruneStaged(base: string, now: Date, retention = STAGING_RETENTION_MS): Promise<void> {
  const d = join(base, STAGING_DIR);
  let names: string[];
  try {
    names = await readdir(d);
  } catch {
    return;
  }
  const cutoff = now.getTime() - retention;
  for (const name of names) {
    const p = join(d, name);
    try {
      const fi = await lstat(p);
      if (!fi.isDirectory() && fi.mtimeMs <= cutoff) await unlink(p);
    } catch {
      // gone
    }
  }
}

/** p for i 0, else p with -i before its extension (a name that is all
 * extension, .env, gets it at the end). */
export function numbered(p: string, i: number): string {
  if (i === 0) return p;
  const dir = dirname(p);
  const base = basename(p);
  let ext = posix.extname(base);
  if (ext === base) ext = '';
  return join(dir, `${base.slice(0, base.length - ext.length)}-${i}${ext}`);
}

/** Creates p or, when that is taken, the first free name-1.ext,
 * name-2.ext… (a new file, never one that is there) and writes src into it. */
export async function createFree(p: string, src: Source, fill: Fill = copyInto): Promise<Entry> {
  for (let i = 0; i < 1000; i++) {
    try {
      return await createFile(numbered(p, i), src, {}, fill, false);
    } catch (e) {
      if (e instanceof Fail && e.code === 'conflict') continue; // taken
      throw e;
    }
  }
  throw new Fail('exists', 409, `no free name for ${p}`);
}
