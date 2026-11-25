// The agent's own file operations (fs.stat, fs.list, fs.read, fs.write,
// fs.archive), which the core's file routes use: a path's state, a
// directory's entries, a range of a file's bytes, an upload written whole
// beside its target and renamed over it, and paths as one zip archive
// (docs/features/06-quick-look-and-files.md).
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createReadStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type Dirent,
  type Stats,
} from 'node:fs';
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

/** A failed reply; code not_found or denied when the system said so. */
function failFS(e: unknown): Reply {
  const code = errCode(e);
  const rep: Reply = { ok: false, error: message(e) };
  if (code === 'ENOENT' || code === 'ENOTDIR') rep.code = 'not_found';
  else if (code === 'EACCES' || code === 'EPERM') rep.code = 'denied';
  return rep;
}

const fail = (e: unknown): Reply => ({ ok: false, error: message(e) });

/** Serves fs.stat, fs.list, fs.read and fs.write for path (expanded). */
export async function serveFS(conn: Conn, h: Header, path: string): Promise<void> {
  const st = conn.stream;
  switch (h.op) {
    case 'fs.stat': {
      let lfi: Stats;
      try {
        lfi = lstatSync(path);
      } catch (e) {
        return writeLine(st, failFS(e));
      }
      let fi = lfi;
      if (lfi.isSymbolicLink()) {
        try {
          fi = statSync(path);
        } catch {
          // a dangling link: its own state
        }
      }
      return writeLine(st, { ok: true, stat: statOf(path, fi, lfi.isSymbolicLink()) });
    }
    case 'fs.list': {
      let ents: Dirent[];
      try {
        ents = readdirSync(path, { withFileTypes: true });
      } catch (e) {
        return writeLine(st, fail(e));
      }
      const out: Stat[] = [];
      for (const e of ents.slice(0, MAX_LIST)) {
        const full = join(path, e.name);
        let fi: Stats;
        try {
          fi = statSync(full);
        } catch {
          try {
            fi = lstatSync(full);
          } catch {
            continue;
          }
        }
        const s = statOf('', fi, e.isSymbolicLink());
        s.name = e.name;
        out.push(s);
      }
      out.sort((a, b) => (a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))));
      const rep: Reply = { ok: true, stat: { name: basename(path) || path, path, size: 0, mode: 0, mtime: 0, is_dir: true } };
      // A directory of thousands of names (an archive just unpacked) is more
      // than the line may hold: the entries follow it.
      const b = Buffer.from(JSON.stringify(out));
      if (b.length <= MAX_INLINE) return writeLine(st, { ...rep, entries: out });
      await writeLine(st, { ...rep, entries_length: b.length });
      return write(st, b);
    }
    case 'fs.read': {
      let fd: number;
      try {
        fd = openSync(path, 'r');
      } catch (e) {
        return writeLine(st, fail(e));
      }
      let owned = true;
      try {
        const fi = fstatSync(fd);
        if (fi.isDirectory()) return await writeLine(st, fail(`${path} is a directory`));
        const offset = h.offset ?? 0;
        if (offset < 0 || offset > fi.size) return await writeLine(st, fail('offset out of range'));
        let length = h.length ?? 0;
        if (length <= 0 || offset + length > fi.size) length = fi.size - offset;
        await writeLine(st, { ok: true, stat: statOf(path, fi, false) });
        if (length === 0) return;
        owned = false;
        await copyOut(createReadStream('', { fd, start: offset, end: offset + length - 1, highWaterMark: 256 << 10 }), st);
      } finally {
        if (owned) closeSync(fd);
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
      mkdirSync(dir, { recursive: true, mode: 0o755 });
    } catch (e) {
      return writeLine(st, fail(e));
    }
  }
  const tmp = join(dir, `.${SLUG}-upload-${randomBytes(6).toString('hex')}`);
  let fd: number;
  try {
    fd = openSync(tmp, 'wx', 0o600);
  } catch (e) {
    return writeLine(st, fail(e));
  }
  let done = false;
  try {
    try {
      await writeLine(st, { ok: true });
    } catch (e) {
      closeSync(fd);
      throw e;
    }
    let err: unknown;
    try {
      for await (const b of new ChunkReader(conn.reader)) for (let off = 0; off < b.length;) off += writeSync(fd, b, off);
    } catch (e) {
      err = e;
    } finally {
      closeSync(fd);
    }
    let target = path;
    try {
      if (err) throw err;
      chmodSync(tmp, h.args?.[0] === 'exec' ? 0o755 : 0o644);
      if (h.unique) target = freeName(path);
      renameSync(tmp, target);
      done = true;
    } catch (e) {
      return writeLine(st, fail(e));
    }
    let fi: Stats;
    try {
      fi = statSync(target);
    } catch (e) {
      return writeLine(st, fail(e));
    }
    return writeLine(st, { ok: true, stat: statOf(target, fi, false) });
  } finally {
    if (!done) rmSync(tmp, { force: true });
  }
}

/** Claims path, or the first free name with -1, -2… before its extension,
 * by creating it exclusively (a link there counts as taken); the upload is
 * then renamed over the empty file it claimed. */
export function freeName(path: string): string {
  const dir = dirname(path);
  const base = basename(path);
  let ext = extname(base);
  if (ext === base) ext = ''; // .env
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const p = i === 0 ? path : join(dir, `${stem}-${i}${ext}`);
    try {
      closeSync(openSync(p, 'wx', 0o644));
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
      statSync(full);
      roots.push(full);
    } catch (e) {
      return writeLine(st, fail(e));
    }
  }
  await writeLine(st, { ok: true });
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
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
  const names = archiveNames(roots);
  for (let i = 0; i < roots.length && !failed; i++) await addTree(zip, roots[i], names[i], () => !!failed);
  zip.end();
  await out;
  if (failed) throw failed;
}

/** Adds root and everything below it under name, until stopped(). */
async function addTree(zip: ZipFile, root: string, name: string, stopped: () => boolean): Promise<void> {
  let walkRoot = root;
  try {
    walkRoot = realpathSync(root);
  } catch {
    // as named
  }
  const visit = async (p: string, entry: string, fi: Stats, n: number): Promise<void> => {
    if (stopped()) return;
    const mtime = fi.mtime;
    if (fi.isDirectory()) {
      zip.addEmptyDirectory(entry + '/', { mtime, mode: fi.mode });
      let names: string[];
      try {
        names = readdirSync(p).sort();
      } catch {
        return; // unreadable: left out
      }
      for (const c of names) {
        const cp = join(p, c);
        let cfi: Stats;
        try {
          cfi = lstatSync(cp);
        } catch {
          continue;
        }
        await visit(cp, `${entry}/${c}`, cfi, n + 1);
        // Let the archive go out while a large tree is walked.
        if ((n + 1) % 256 === 0) await new Promise((r) => setImmediate(r));
      }
    } else if (fi.isSymbolicLink()) {
      let target: string;
      try {
        target = readlinkSync(p);
      } catch {
        return;
      }
      zip.addBuffer(Buffer.from(target), entry, { mtime, mode: fi.mode, compress: false });
    } else if (fi.isFile()) {
      zip.addReadStreamLazy(entry, { mtime, mode: fi.mode, compressionLevel: 1 }, (cb) => cb(null, readQuietly(p)));
    }
  };
  let fi: Stats;
  try {
    fi = lstatSync(walkRoot);
  } catch {
    return;
  }
  await visit(walkRoot, name, fi, 0);
}

/** A file's bytes; one that cannot be read ends early instead of failing
 * the archive (the entry is cut short). */
function readQuietly(p: string): Readable {
  const out = new PassThrough();
  const r = createReadStream(p, { highWaterMark: 256 << 10 });
  r.on('error', () => out.end());
  r.pipe(out);
  return out;
}
