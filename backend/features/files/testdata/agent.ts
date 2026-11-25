// An agent for the tests that serves the file ops from the real file
// system as the Go agent does: fs.stat,
// fs.list, fs.read, fs.write (into a private file renamed once the end
// marker came) and fs.archive, whose "archive" is each file's name and
// bytes in a line (the hub passes the chunks on unread). The files
// plugin's actions go to a handler the test gives.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SLUG } from '#shared/lib/brand.ts';
import { write } from '#shared/lib/streamio.ts';
import {
  ChunkReader,
  ChunkWriter,
  MAX_INLINE,
  Op,
  readBody,
  writeLine,
  type Header,
  type Reply,
  type Stat,
} from '#shared/proto/agentproto/index.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';

/** Serves a plugin action after its header (params decoded). */
export type PluginHandler = (action: string, params: Record<string, unknown>, conn: AgentStream) => Promise<void>;

const describe: Record<string, string> = {
  ENOENT: 'no such file or directory',
  ENOTDIR: 'not a directory',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EISDIR: 'is a directory',
};

/** A failed reply as the Go agent writes one: its error's text, not_found
 * or denied as the code of a missing or forbidden path. */
function failure(e: unknown): Reply {
  const err = e as NodeJS.ErrnoException;
  const text = err.syscall ? `${err.syscall} ${err.path}: ${describe[err.code ?? ''] ?? err.message}` : err.message;
  const code = err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'not_found' : err.code === 'EACCES' ? 'denied' : undefined;
  return { ok: false, error: text, ...(code ? { code } : {}) };
}

const statOf = (path: string, fi: Stats, link = false): Stat => ({
  name: basename(path),
  path,
  size: fi.size,
  mode: fi.mode & 0o777,
  mtime: Math.floor(fi.mtimeMs),
  is_dir: fi.isDirectory(),
  ...(link ? { is_link: true } : {}),
});

/** The first free name of path: it, then name-1.ext, name-2.ext… */
async function freeName(path: string): Promise<string> {
  const dir = dirname(path);
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
  for (let i = 0; i < 1000; i++) {
    const p = i === 0 ? path : join(dir, `${stem}-${i}${ext}`);
    try {
      (await open(p, 'wx')).close();
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`no free name for ${base}`);
}

/** The files below root, depth first, with their names in the archive. */
async function* walk(root: string, name: string): AsyncGenerator<{ path: string; name: string }> {
  const fi = await stat(root);
  if (!fi.isDirectory()) {
    yield { path: root, name };
    return;
  }
  for (const e of (await readdir(root)).sort()) yield* walk(join(root, e), `${name}/${e}`);
}

/** Serves the streams of the hub (the fake agent's serve). */
export function fsAgent(plugin?: PluginHandler) {
  return async (h: Header, conn: AgentStream): Promise<void> => {
    const st = conn.stream;
    const reply = (r: Reply) => writeLine(st, r).catch(() => {});
    try {
      switch (h.op) {
        case Op.FsStat: {
          const p = h.path ?? '';
          const l = await lstat(p);
          const fi = l.isSymbolicLink() ? await stat(p).catch(() => l) : l;
          await reply({ ok: true, stat: statOf(p, fi, l.isSymbolicLink()) });
          break;
        }
        case Op.FsList: {
          const p = h.path ?? '';
          const entries: Stat[] = [];
          for (const name of await readdir(p)) {
            const s = statOf(name, await stat(join(p, name)));
            delete s.path;
            entries.push(s);
          }
          entries.sort((a, b) => (a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : a.name < b.name ? -1 : 1));
          const dir: Stat = { name: basename(p), path: p, size: 0, mode: 0, mtime: 0, is_dir: true };
          const json = JSON.stringify(entries);
          if (json.length <= MAX_INLINE) await reply({ ok: true, stat: dir, entries });
          else {
            await reply({ ok: true, stat: dir, entries_length: Buffer.byteLength(json) });
            await write(st, json);
          }
          break;
        }
        case Op.FsRead: {
          const p = h.path ?? '';
          const f = await open(p);
          try {
            const fi = await f.stat();
            if (fi.isDirectory()) throw new Error(`${p} is a directory`);
            const offset = h.offset ?? 0;
            let left = h.length && h.length > 0 && offset + h.length <= fi.size ? h.length : fi.size - offset;
            await reply({ ok: true, stat: statOf(p, fi) });
            const buf = Buffer.alloc(256 << 10);
            for (let at = offset; left > 0;) {
              const { bytesRead } = await f.read(buf, 0, Math.min(buf.length, left), at);
              if (bytesRead === 0) break;
              await write(st, Buffer.from(buf.subarray(0, bytesRead)));
              at += bytesRead;
              left -= bytesRead;
            }
          } finally {
            await f.close();
          }
          break;
        }
        case Op.FsWrite: {
          const p = h.path ?? '';
          if (h.mkdirs) await mkdir(dirname(p), { recursive: true });
          const tmp = join(dirname(p), `.${SLUG}-upload-${randomBytes(4).toString('hex')}`);
          const f = await open(tmp, 'wx');
          await reply({ ok: true });
          try {
            const cr = new ChunkReader(conn.reader);
            for (let b = await cr.read(); b !== null; b = await cr.read()) await f.write(b);
          } catch (e) {
            await f.close();
            await rm(tmp, { force: true });
            await reply(failure(e));
            break;
          }
          await f.close();
          const to = h.unique ? await freeName(p) : p;
          await rename(tmp, to);
          await reply({ ok: true, stat: statOf(to, await stat(to)) });
          break;
        }
        case Op.FsArchive: {
          for (const p of h.paths ?? []) await stat(p);
          await reply({ ok: true });
          const cw = new ChunkWriter(st);
          for (const root of h.paths ?? [])
            for await (const f of walk(root, basename(root))) {
              await cw.write(Buffer.from(`${f.name}\n`));
              const fh = await open(f.path);
              try {
                const buf = Buffer.alloc(256 << 10);
                for (;;) {
                  const { bytesRead } = await fh.read(buf, 0, buf.length, null);
                  if (bytesRead === 0) break;
                  await cw.write(Buffer.from(buf.subarray(0, bytesRead)));
                }
              } finally {
                await fh.close();
              }
            }
          await cw.finish();
          break;
        }
        case Op.Plugin: {
          if (h.plugin !== 'files' || !plugin) {
            await reply({ ok: false, error: 'unknown plugin', code: 'bad_params' });
            break;
          }
          const params = (h.params_length ? await readBody(conn.reader, h.params_length) : (h.params ?? {})) as Record<string, unknown>;
          await plugin(h.action ?? '', params, conn);
          break;
        }
        default:
          await reply({ ok: false, error: `unsupported op ${h.op}` });
      }
    } catch (e) {
      await reply(failure(e));
    }
    conn.reader.release();
    closeStream(st);
  };
}
