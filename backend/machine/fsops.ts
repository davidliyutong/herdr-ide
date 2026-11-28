// The agent's own file operations (fs.stat, fs.list, fs.read, fs.write,
// fs.archive), which the hub's file routes use: a path's state, a
// directory's entries, a range of a file's bytes, an upload written whole
// beside its target and renamed over it, and paths as one zip archive
// (docs/features/06-quick-look-and-files.md).
//
// The node serves every hub on one thread, so nothing here waits for the
// file system on it: every call is asynchronous (a call that does not
// return, on a mount that stopped answering, holds a thread of the pool,
// not the node), and a file is opened to be read without blocking on a
// FIFO (O_NONBLOCK) and read only when it is a regular file.
import { randomBytes } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { posix } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { SLUG } from '#shared/lib/brand.ts';
import { write } from '#shared/lib/streamio.ts';
import { ChunkReader, ChunkWriter, MAX_INLINE, writeLine, type Header, type Reply, type Stat } from '#shared/proto/agentproto/index.ts';
import type { Conn } from './stream.ts';

const { basename, dirname, extname, join } = posix;

/** Bounds a listing. */
const MAX_LIST = 20000;
/** Bounds the paths of one archive. */
const MAX_ARCHIVE_PATHS = 1000;
/** How a file to read is opened: never blocking on a FIFO, never a
 * terminal's controlling one. */
export const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;

/** The file system calls of these ops (tests replace them). */
export interface FsCalls {
  stat(p: string): Promise<Stats>;
  lstat(p: string): Promise<Stats>;
}

export const FS_CALLS: FsCalls = { stat: (p) => fsp.stat(p), lstat: (p) => fsp.lstat(p) };

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function statOf(path: string, fi: Stats, isLink: boolean): Stat {
  return {
    name: basename(path) || path,
    ...(path ? { path } : {}),
    size: fi.size,
    mode: fi.mode & 0o777,
    mtime: Math.floor(fi.mtimeMs),
    is_dir: fi.isDirectory(),
    ...(isLink ? { is_link: true } : {}),
  };
}

/** A failed reply; code not_found, denied or is_dir when the system said so. */
function failFS(e: unknown): Reply {
  const code = errCode(e);
  const rep: Reply = { ok: false, error: message(e) };
  if (code === 'ENOENT' || code === 'ENOTDIR') rep.code = 'not_found';
  else if (code === 'EACCES' || code === 'EPERM') rep.code = 'denied';
  else if (code === 'EISDIR') rep.code = 'is_dir';
  return rep;
}

const fail = (e: unknown): Reply => ({ ok: false, error: message(e) });

/** Opens a regular file to read it: a FIFO, a device or a socket at the
 * path is refused (the open itself does not wait for a FIFO's writer). */
export async function openRegular(path: string): Promise<{ fh: fsp.FileHandle; fi: Stats }> {
  const fh = await fsp.open(path, READ_FLAGS);
  try {
    const fi = await fh.stat();
    if (fi.isDirectory()) {
      const err = new Error(`${path} is a directory`) as NodeJS.ErrnoException;
      err.code = 'EISDIR';
      throw err;
    }
    if (!fi.isFile()) throw new Error(`${path} is not a regular file`);
    return { fh, fi };
  } catch (e) {
    await fh.close();
    throw e;
  }
}

/** Serves fs.stat, fs.list, fs.read and fs.write for path (expanded). */
export async function serveFS(conn: Conn, h: Header, path: string, fs: FsCalls = FS_CALLS): Promise<void> {
  const st = conn.stream;
  switch (h.op) {
    case 'fs.stat': {
      let lfi: Stats;
      try {
        lfi = await fs.lstat(path);
      } catch (e) {
        return writeLine(st, failFS(e));
      }
      let fi = lfi;
      if (lfi.isSymbolicLink()) {
        try {
          fi = await fs.stat(path);
        } catch {
          // a dangling link: its own state
        }
      }
      return writeLine(st, { ok: true, stat: statOf(path, fi, lfi.isSymbolicLink()) });
    }
    case 'fs.list': {
      let ents: Dirent[];
      try {
        ents = await fsp.readdir(path, { withFileTypes: true });
      } catch (e) {
        return writeLine(st, failFS(e));
      }
      const readEntry = async (e: Dirent) => {
        const full = join(path, e.name);
        let fi: Stats;
        try {
          fi = await fs.stat(full);
        } catch {
          try {
            fi = await fs.lstat(full);
          } catch {
            return null;
          }
        }
        const s = statOf('', fi, e.isSymbolicLink());
        s.name = e.name;
        return { stat: s, name: Buffer.from(e.name) };
      };
      const entries = [];
      const count = Math.min(ents.length, MAX_LIST);
      for (let i = 0; i < count; i += 16) {
        if (st.destroyed) return;
        const batch = await Promise.all(ents.slice(i, Math.min(i + 16, count)).map(readEntry));
        for (const entry of batch) if (entry) entries.push(entry);
      }
      entries.sort((a, b) => Number(b.stat.is_dir) - Number(a.stat.is_dir) || Buffer.compare(a.name, b.name));
      const out = entries.map((e) => e.stat);
      const rep: Reply = { ok: true, stat: { name: basename(path) || path, path, size: 0, mode: 0, mtime: 0, is_dir: true } };
      // A directory of thousands of names (an archive just unpacked) is more
      // than the line may hold: the entries follow it.
      const b = Buffer.from(JSON.stringify(out));
      if (b.length <= MAX_INLINE) return writeLine(st, { ...rep, entries: out });
      await writeLine(st, { ...rep, entries_length: b.length });
      return write(st, b);
    }
    case 'fs.read': {
      let f: { fh: fsp.FileHandle; fi: Stats };
      try {
        f = await openRegular(path);
      } catch (e) {
        return writeLine(st, failFS(e));
      }
      const { fh, fi } = f;
      let owned = true;
      try {
        if (h.max_size !== undefined && h.max_size >= 0 && fi.size > h.max_size) {
          return await writeLine(st, { ok: false, code: 'too_large', error: 'file too large', stat: statOf(path, fi, false) });
        }
        const offset = h.offset ?? 0;
        if (offset < 0 || offset > fi.size) return await writeLine(st, fail('offset out of range'));
        let length = h.length ?? 0;
        if (length <= 0 || offset + length > fi.size) length = fi.size - offset;
        await writeLine(st, { ok: true, stat: statOf(path, fi, false) });
        if (length === 0) return;
        owned = false;
        await copyOut(fh.createReadStream({ start: offset, end: offset + length - 1, highWaterMark: 256 << 10 }), st);
      } finally {
        if (owned) await fh.close();
      }
      return;
    }
    case 'fs.write':
      return writeUpload(conn, h, path);
  }
  return writeLine(st, fail(`unknown fs op ${JSON.stringify(h.op)}`));
}

/** Copies r into w until r ends or w fails (then r is destroyed). */
async function copyOut(r: Readable, w: Conn['stream']): Promise<void> {
  try {
    for await (const b of r) await write(w, b as Buffer);
  } finally {
    r.destroy();
  }
}

/** fs.write: the reply, then the file as chunks (ChunkWriter) into a
 * temporary file beside path, renamed over it once complete (with unique,
 * onto the first free name), then a second reply with its state. */
async function writeUpload(conn: Conn, h: Header, path: string): Promise<void> {
  const st = conn.stream;
  const dir = dirname(path);
  if (h.mkdirs) {
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o755 });
    } catch (e) {
      return writeLine(st, fail(e));
    }
  }
  const tmp = join(dir, `.${SLUG}-upload-${randomBytes(6).toString('hex')}`);
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(tmp, 'wx', 0o600);
  } catch (e) {
    return writeLine(st, fail(e));
  }
  let done = false;
  try {
    try {
      await writeLine(st, { ok: true });
    } catch (e) {
      await fh.close();
      throw e;
    }
    let err: unknown;
    try {
      for await (const b of new ChunkReader(conn.reader)) await fh.write(b);
    } catch (e) {
      err = e;
    } finally {
      await fh.close();
    }
    let target = path;
    try {
      if (err) throw err;
      await fsp.chmod(tmp, h.args?.[0] === 'exec' ? 0o755 : 0o644);
      if (h.unique) target = await freeName(path);
      await fsp.rename(tmp, target);
      done = true;
    } catch (e) {
      return writeLine(st, fail(e));
    }
    let fi: Stats;
    try {
      fi = await fsp.stat(target);
    } catch (e) {
      return writeLine(st, fail(e));
    }
    return writeLine(st, { ok: true, stat: statOf(target, fi, false) });
  } finally {
    if (!done) await fsp.rm(tmp, { force: true });
  }
}

/** Claims path, or the first free name with -1, -2… before its extension,
 * by creating it exclusively (a link there counts as taken); the upload is
 * then renamed over the empty file it claimed. */
export async function freeName(path: string): Promise<string> {
  const dir = dirname(path);
  const base = basename(path);
  let ext = extname(base);
  if (ext === base) ext = ''; // .env
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const p = i === 0 ? path : join(dir, `${stem}-${i}${ext}`);
    try {
      await (await fsp.open(p, 'wx', 0o644)).close();
      return p;
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e;
    }
  }
  throw new Error(`no free name for ${base}`);
}

/** The names of roots at the archive's root: their base names, a repeated
 * one with -1, -2… before its extension. */
export function archiveNames(roots: string[]): string[] {
  const taken = new Set<string>();
  return roots.map((r) => {
    let base = basename(r);
    if (base === '' || base === '/' || base === '.') base = 'root';
    let ext = extname(base);
    if (ext === base) ext = '';
    const stem = base.slice(0, base.length - ext.length);
    let name = base;
    for (let n = 1; taken.has(name); n++) name = `${stem}-${n}${ext}`;
    taken.add(name);
    return name;
  });
}

/** fs.archive: the paths as one zip, each at the archive's root under its
 * base name, directories with everything below them. The paths named are
 * followed when they are links; links below them are stored as links.
 * Irregular files and anything unreadable are left out. Nothing is written
 * on the machine; the walk stops when the stream fails (the browser went
 * away). With chunked the archive is framed, and its end marked once it is
 * complete. expand resolves the paths. */
export async function serveArchive(conn: Conn, h: Header, expand: (p: string) => string): Promise<void> {
  const st = conn.stream;
  const paths = h.paths ?? [];
  if (paths.length === 0 || paths.length > MAX_ARCHIVE_PATHS)
    return writeLine(st, fail(`archive: between 1 and ${MAX_ARCHIVE_PATHS} paths`));
  const roots: string[] = [];
  for (const p of paths) {
    try {
      const full = expand(p);
      await fsp.stat(full);
      roots.push(full);
    } catch (e) {
      return writeLine(st, fail(e));
    }
  }
  await writeLine(st, { ok: true });
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const ac = new AbortController();
  const stop = () => {
    ac.abort();
    output.destroy();
  };
  st.once('close', stop);
  output.once('close', () => ac.abort());
  if (st.destroyed) stop();
  let failed: unknown = null;
  const out = (async () => {
    const cw = h.chunked ? new ChunkWriter(st) : null;
    try {
      for await (const b of output) {
        if (cw) await cw.write(b as Buffer);
        else await write(st, b as Buffer);
      }
      if (cw) await cw.finish();
    } catch (e) {
      failed = e;
      output.destroy();
    }
  })();
  zip.on('error', (e: unknown) => {
    failed ??= e;
    output.destroy(e as Error);
  });
  try {
    const names = archiveNames(roots);
    for (let i = 0; i < roots.length && !ac.signal.aborted; i++) await addTree(zip, roots[i], names[i], ac.signal);
    if (!ac.signal.aborted) zip.end();
    await out;
    if (failed) throw failed;
  } finally {
    st.off('close', stop);
    stop();
  }
}

/** Adds root and everything below it under name, until signal ends. */
async function addTree(zip: ZipFile, root: string, name: string, signal: AbortSignal): Promise<void> {
  let walkRoot = root;
  try {
    walkRoot = await fsp.realpath(root);
  } catch {
    // as named
  }
  const visit = async (p: string, entry: string, fi: Stats): Promise<void> => {
    if (signal.aborted) return;
    const mtime = fi.mtime;
    if (fi.isDirectory()) {
      zip.addEmptyDirectory(entry + '/', { mtime, mode: fi.mode });
      let names: string[];
      try {
        names = (await fsp.readdir(p)).sort();
      } catch {
        return; // unreadable: left out
      }
      for (const c of names) {
        if (signal.aborted) return;
        const cp = join(p, c);
        let cfi: Stats;
        try {
          cfi = await fsp.lstat(cp);
        } catch {
          continue;
        }
        await visit(cp, `${entry}/${c}`, cfi);
      }
    } else if (fi.isSymbolicLink()) {
      let target: string;
      try {
        target = await fsp.readlink(p);
      } catch {
        return;
      }
      zip.addBuffer(Buffer.from(target), entry, { mtime, mode: fi.mode, compress: false });
    } else if (fi.isFile()) {
      zip.addReadStreamLazy(entry, { mtime, mode: fi.mode, compressionLevel: 1 }, (cb) => cb(null, readQuietly(p, signal)));
    }
  };
  let fi: Stats;
  try {
    fi = await fsp.lstat(walkRoot);
  } catch {
    return;
  }
  await visit(walkRoot, name, fi);
}

/** A file's bytes; one that cannot be read, or is no longer a regular file
 * (a FIFO swapped in), ends early instead of failing the archive (the
 * entry is cut short). */
function readQuietly(p: string, signal: AbortSignal): Readable {
  const out = new PassThrough();
  if (signal.aborted) return out.end();
  const stop = () => out.destroy();
  signal.addEventListener('abort', stop, { once: true });
  out.once('close', () => signal.removeEventListener('abort', stop));
  openRegular(p).then(
    ({ fh }) => {
      if (signal.aborted || out.destroyed) return void fh.close().catch(() => {});
      const r = fh.createReadStream({ highWaterMark: 256 << 10 });
      out.once('close', () => r.destroy());
      r.on('error', () => out.end());
      r.pipe(out);
    },
    () => out.end(),
  );
  return out;
}
