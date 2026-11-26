// Files on the hub's side, in two features:
//
//   - the transfers (fileTransfersFeature), always on, which the previews,
//     the editor, dropped files and pasted images, VS Code's downloads and
//     the explorer use: GET /api/m/:id/file (a file, with ranges),
//     /download (one file as itself, anything else as a zip the agent makes
//     while it is downloaded, followed by the page's downloads panel over
//     /ws), /list (a directory) and POST /upload (into the machine's upload
//     directory or a directory chosen there);
//   - the file explorer (filesFeature, docs/features/28-file-explorer.md),
//     a feature the user can switch off: below /api/m/:id/p/files the
//     changes it makes, the stat it polls, saving an editor's text,
//     uploads into its folders and Reveal in Finder, each an action of its
//     machine side (protocol.ts), and its settings.
//
// What a file is answered with is the Go hub's: the editor and the
// previews read these answers as they were, with their errors (a listing's
// and an upload's error is the agent's text, which the UI shows and
// matches; a file's is plain text).
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { Op, type Reply, type Stat } from '#shared/proto/agentproto/index.ts';
import type { ParamsOf } from '#shared/proto/protocol.ts';
import { agentFail, open } from '#kernel/agent.ts';
import type { AuditFields } from '#kernel/audit.ts';
import { defineFeature, type FeatureContext } from '#kernel/feature.ts';
import { Fail, failOf } from '#kernel/fail.ts';
import { jsonBody, readBody } from '#kernel/http/app.ts';
import { breakableResponse } from '#kernel/http/breakable.ts';
import type { Ctx, Env } from '#kernel/http/env.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { AgentError } from '#kernel/machines/transport/session.ts';
import { agentBody, sendChunks, type Transfer } from './body.ts';
import { Downloads, DownloadCode, type Download } from './downloads.ts';
import { archiveName, baseName, downloadPaths, uploadTarget } from './names.ts';
import {
  CHANGES,
  MAX_STAT,
  MAX_UPLOAD,
  MAX_WRITE,
  entry,
  filesProtocol,
  result,
  type Change,
  type Entry,
  type Result,
} from './protocol.ts';
import { FILE_CSP, TransferFail, attachment, failCode, serveFile, serveFileDirect } from './serve.ts';
import { settings } from './settings.ts';

/** How long a stat or a listing may take (a machine that does not answer). */
const STAT_MS = 20_000;
/** Bounds the JSON of a change. */
const MAX_BODY = 1 << 20;
/** Bounds a save, its text sent and its answer. */
const WRITE_MS = 2 * 60_000;

const noStore = (c: Ctx) => c.header('Cache-Control', 'no-store');
const queryOf = (c: Ctx) => new URL(c.req.url).searchParams;

/** A request's declared length, -1 when not known. */
function contentLength(req: Request): number {
  const h = req.headers.get('Content-Length');
  if (h !== null && /^\d+$/.test(h)) return Number(h);
  return req.body ? -1 : 0;
}

/** A failure whose error is the agent's text (a listing's, an upload's):
 * the UI shows it and matches it (dialog.ts folderProblem). */
const prose = (status: number, e: unknown) => {
  const text = e instanceof Error ? e.message : String(e);
  return new Fail(text, status, text);
};

/** Answers the failures of a route as plain text, as the Go hub's
 * http.Error did: the editor shows that text (EditorPane readFailure). */
const plainErrors = createMiddleware<Env>(async (c, next) => {
  await next();
  if (!c.error) return;
  const f = failOf(c.error);
  c.res = new Response(`${f.message}\n`, {
    status: f.status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  });
});

/** The stat of path on m (fs.stat), within STAT_MS. */
async function statOf(m: Machine, path: string, signal: AbortSignal): Promise<Stat> {
  const rep = await m.request({ op: Op.FsStat, path }, { signal, timeoutMs: STAT_MS });
  if (!rep.stat) throw new Error('missing stat');
  return rep.stat;
}

/** The status of a failed stat of a file: 404 only when it is not there
 * (the editor offers to create a file that is not there), 403 without
 * permission, 502 when the machine did not answer or failed otherwise. */
export function statStatus(e: unknown): number {
  if (!(e instanceof AgentError) || !e.reply || e.reply.ok) return 502;
  let code = e.reply.code ?? '';
  if (!code) {
    // An agent from before the codes.
    const text = e.reply.error ?? '';
    if (text.includes('no such file or directory') || text.includes('not a directory')) code = 'not_found';
    else if (text.includes('permission denied')) code = 'denied';
  }
  return code === 'not_found' ? 404 : code === 'denied' ? 403 : 502;
}

export interface FileTransfersOptions {
  /** The time uploads are named with. */
  now?: () => Date;
  /** The downloads pages follow (a new one by default). */
  downloads?: Downloads;
}

export const fileTransfersFeature = (o: FileTransfersOptions = {}) =>
  defineFeature({
    id: 'transfers',
    toggle: false,
    audit: 'file',
    setup(ctx) {
      const downloads = o.downloads ?? new Downloads();
      const now = o.now ?? (() => new Date());

      // The downloads a page follows; also in read-only mode, where it may
      // download.
      ctx.pages.onOpen((p) => () => downloads.forget(p));
      ctx.pages.on('download.watch', (p, m) => {
        if (Array.isArray(m.ids))
          downloads.watch(
            p,
            m.ids.filter((id): id is string => typeof id === 'string'),
          );
      });
      ctx.pages.on('download.cancel', (p, m) => {
        if (typeof m.id === 'string' && downloads.cancel(p, m.id)) ctx.audit.log(p.who, 'file.download.cancel', { id: m.id });
      });

      const one = ctx.route('/api/m/:id');

      // A file, with ranges so that videos seek without downloading
      // everything; as an attachment with download=1. Plain GET requests
      // without Range/If-None-Match open Op.FsRead directly in a single
      // remote round-trip (the reply carries stat before the body).
      one.get('/file', plainErrors, async (c) => {
        const q = queryOf(c);
        const path = q.get('path') ?? '';
        if (!path) throw new Fail('bad_request', 400, 'path required');
        const signal = c.req.raw.signal;
        const maxRaw = q.get('max_size');
        const maxNum = maxRaw !== null && /^\d+$/.test(maxRaw) ? Number(maxRaw) : undefined;
        const maxSize = maxNum !== undefined && Number.isSafeInteger(maxNum) && maxNum < Number.MAX_SAFE_INTEGER ? maxNum : undefined;
        const dl = q.get('download') === '1';
        if (c.req.method === 'GET' && !c.req.raw.headers.get('Range') && !c.req.raw.headers.get('If-None-Match')) {
          return serveFileDirect(c.var.machine, path, dl, maxSize, { request: signal }, statStatus);
        }
        let st: Stat;
        try {
          st = await statOf(c.var.machine, path, signal);
        } catch (e) {
          throw new Fail('stat', statStatus(e), (e as Error).message);
        }
        if (st.is_dir) throw new Fail('is_dir', 400, 'is a directory');
        if (maxSize !== undefined && st.size > maxSize) throw new Fail('too_large', 413, 'file too large');
        return serveFile(c.var.machine, c.req.raw, st, dl, { request: signal });
      });

      // A directory: its stat and entries (an empty list for an empty one).
      one.get('/list', async (c) => {
        const path = queryOf(c).get('path') ?? '';
        let rep: Reply;
        try {
          rep = await c.var.machine.request({ op: Op.FsList, ...(path ? { path } : {}) }, { signal: c.req.raw.signal, timeoutMs: STAT_MS });
          if (!rep.stat) throw new Error('missing stat');
        } catch (e) {
          throw prose(e instanceof Fail ? e.status : statStatus(e), e);
        }
        noStore(c);
        return c.json({ dir: rep.stat, entries: rep.entries ?? [] });
      });

      // Writes the body to a file on the machine: dropped files and pasted
      // images handed to agents (names.ts uploadTarget). The agent writes
      // into a private file and renames it once the end marker came: an
      // upload cut short leaves nothing.
      one.post('/upload', ctx.writable, async (c) => {
        const m = c.var.machine;
        const uploadDir = m.state().info?.upload_dir;
        if (!uploadDir) throw prose(503, 'machine not connected');
        const q = queryOf(c);
        let target;
        try {
          target = uploadTarget({ name: q.get('name') ?? '', dir: q.get('dir') ?? '' }, uploadDir, now());
        } catch (e) {
          throw prose(400, e);
        }
        ctx.audit.log(c.var.who, 'file.upload', { machine: m.id, path: target.path, size: contentLength(c.req.raw) });
        let rep: Reply;
        try {
          const { conn } = await m.open({ op: Op.FsWrite, ...target }, { signal: c.req.raw.signal });
          rep = await sendChunks(conn, c.req.raw, MAX_UPLOAD);
        } catch (e) {
          throw prose(502, e);
        }
        if (!rep.ok) throw prose(502, rep.error ?? '');
        noStore(c);
        return c.json(rep.stat ?? null);
      });

      // Saves files and directories of a machine in the browser: one file
      // as itself, anything else as a zip the agent makes while it is
      // downloaded (fs.archive). Followed before its machine is known, so
      // that the page hears of an unknown one as a failed download.
      ctx.route('/api/m').get('/:id/download', plainErrors, async (c) => {
        const tracked = downloads.track(queryOf(c).get('dl') ?? undefined, c.req.method, c.req.raw.signal);
        if (tracked === 'refused') throw new TransferFail(410, 'download cancelled', 'cancelled');
        const t: Followed = tracked ?? { request: c.req.raw.signal, signal: c.req.raw.signal };
        try {
          return await download(ctx, c, t);
        } catch (e) {
          t.fail?.(e instanceof TransferFail ? e.code : failCode(e));
          t.ended?.('broken');
          throw e;
        }
      });
    },
  });

/** A download as the handler serves it: its transfer, and what it asks of
 * the machine ends with signal. */
type Followed = Transfer & { readonly signal: AbortSignal; describe?: Download['describe'] };

async function download(ctx: FeatureContext, c: Ctx, t: Followed): Promise<Response> {
  const m = ctx.machines.get(c.req.param('id') ?? '');
  if (!m) throw new TransferFail(404, 'unknown machine', DownloadCode.NotFound);
  let paths: string[];
  try {
    paths = downloadPaths(queryOf(c).getAll('path'));
  } catch (e) {
    throw new TransferFail(400, (e as Error).message, DownloadCode.Invalid);
  }
  const head = c.req.method === 'HEAD'; // the page's check before a download
  if (!head) ctx.audit.log(c.var.who, 'file.download', { machine: m.id, paths });
  if (paths.length === 1) {
    let st: Stat;
    try {
      st = await statOf(m, paths[0], t.signal);
    } catch (e) {
      throw new TransferFail(404, (e as Error).message, failCode(e));
    }
    if (!st.is_dir) {
      t.describe?.(baseName(st.path ?? paths[0]), st.size);
      return serveFile(m, c.req.raw, st, true, t);
    }
  }
  const name = archiveName(paths);
  const headers = {
    'Content-Type': 'application/zip',
    'Content-Disposition': attachment(name),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': FILE_CSP,
  };
  if (head) {
    t.ended?.('complete');
    return new Response(null, { headers });
  }
  let body;
  try {
    const { conn } = await m.open({ op: Op.FsArchive, paths, chunked: true }, { signal: t.signal });
    body = agentBody(conn, 'chunked', t);
  } catch (e) {
    throw new TransferFail(404, (e as Error).message, failCode(e));
  }
  t.describe?.(name, -1);
  // The archive is complete only with the chunks' end marker: one that
  // breaks off fails in the browser too, never saved short.
  return breakableResponse(body, { headers });
}

/** Bounds the paths an audit record lists; it counts them all. */
const MAX_AUDIT_PATHS = 50;

/** Adds the paths a change acts on to its audit record. */
export function auditTargets(fields: AuditFields, p: { path?: string; paths?: string[]; to?: string; dir?: string }): void {
  if (p.path) fields.path = p.path;
  if (p.paths?.length) {
    fields.paths = p.paths.slice(0, MAX_AUDIT_PATHS);
    fields.count = p.paths.length;
  }
  if (p.to) fields.to = p.to;
  if (p.dir) fields.dir = p.dir;
}

/** A whole number as Go's strconv.ParseInt reads it; undefined otherwise. */
const goInt = (s: string | null) => (s !== null && /^[+-]?\d+$/.test(s) ? Number(s) : undefined);

/** A save's query: path, and the state the editor loaded the file in
 * (mtime and size), or new=1 for a file that must not exist, or force=1. */
export function writeParams(q: URLSearchParams): { path: string; expect?: Entry; force?: true } {
  const path = q.get('path') ?? '';
  if (!path) throw new Fail('bad_request', 400, 'path required');
  if (q.get('force') === '1') return { path, force: true };
  if (q.get('new') === '1') return { path };
  const mtime = goInt(q.get('mtime'));
  const size = goInt(q.get('size'));
  if (mtime === undefined || size === undefined) throw new Fail('bad_request', 400, 'mtime and size, new=1 or force=1 required');
  return { path, expect: { path, exists: true, size, mtime } };
}

/** An upload's query: path, and replace=1 to write the file there instead
 * of taking a free name. */
export function uploadParams(q: URLSearchParams): { path: string; replace?: true } {
  const path = q.get('path') ?? '';
  if (!path) throw new Fail('bad_request', 400, 'path required');
  return q.get('replace') === '1' ? { path, replace: true } : { path };
}

/** The status of a failure the agent answered with code, as for every
 * action (offline 409, transport 502, not_found 404, others 400). */
/** A save refused because the file changed since the editor loaded it:
 * 409 with the file's state now (current), which the editor offers to
 * reload or overwrite. */
export class Conflict extends Fail {
  readonly current: Entry;

  constructor(current: Entry) {
    super('conflict', 409, 'file changed');
    this.current = current;
  }

  override body() {
    return { ...super.body(), current: this.current };
  }
}

/** The file's state in a conflict's message ("conflict: " and its JSON). */
export function conflictOf(message: string): Entry {
  let raw: unknown;
  try {
    raw = JSON.parse(message.replace(/^conflict: /, ''));
  } catch {
    // none
  }
  const r = entry.safeParse(raw);
  return r.success ? r.data : { path: '', exists: false, size: 0, mtime: 0 };
}

/** Runs an action that takes a body (write, upload): its reply, the body as
 * chunks, then the line with the result. */
async function send(
  m: Machine,
  action: 'write' | 'upload',
  params: { path: string },
  body: Uint8Array | Request,
  limit: number,
  signal: AbortSignal,
): Promise<Result> {
  const { conn } = await open(m, filesProtocol, action, params, { signal });
  let rep: Reply;
  try {
    rep = await sendChunks(conn, body, limit);
  } catch (e) {
    throw new Fail('transport', 502, (e as Error).message);
  }
  if (!rep.ok) throw agentFail(rep.code || 'failed', rep.error ?? '');
  const r = result.safeParse(rep.plugin ?? {});
  if (!r.success) throw new Fail('invalid_result', 502, `files.${action}: ${r.error.message}`);
  return r.data;
}

export interface FilesOptions {
  /** The platform of the hub's host, whose file manager Reveal opens. */
  platform?: string;
}

export const filesFeature = (o: FilesOptions = {}) =>
  defineFeature({
    id: 'files',
    settings,
    setup(ctx) {
      const api = ctx.machineApi;
      const platform = o.platform ?? process.platform;

      // The state of paths (1 to MAX_STAT), which the explorer polls for the
      // directories it shows. A POST for the length of its paths (more than
      // proxies take in a URL) that changes nothing: read-only mode polls.
      api.post('/stat', jsonBody(z.object({ paths: z.array(z.string()).optional() }), { limit: MAX_BODY }), async (c) => {
        const { paths = [] } = c.req.valid('json');
        if (paths.length === 0 || paths.length > MAX_STAT) throw new Fail('bad_request', 400, `between 1 and ${MAX_STAT} paths`);
        const entries = await ctx.call(c.var.machine, filesProtocol, 'stat', { paths }, { signal: c.req.raw.signal });
        noStore(c);
        return c.json({ entries });
      });

      // The changes: their JSON is the action's parameters.
      const change = <K extends Change>(action: K) =>
        api.post(`/${action}`, ctx.mutating(action), jsonBody(filesProtocol.actions[action].params, { limit: MAX_BODY }), async (c) => {
          // The parameters have no transforms: what is validated is what goes.
          const p = c.req.valid('json') as ParamsOf<(typeof filesProtocol.actions)[K]>;
          auditTargets(c.var.audit, p);
          const r = await ctx.call(c.var.machine, filesProtocol, action, p, { signal: c.req.raw.signal });
          noStore(c);
          return c.json(r);
        });
      for (const action of CHANGES) change(action);

      // Saves an editor's text (the body, at most MAX_WRITE bytes). A file
      // that changed since the editor loaded it is a Conflict.
      api.post('/write', ctx.mutating('write'), async (c) => {
        const p = writeParams(queryOf(c));
        auditTargets(c.var.audit, p);
        if (p.force) c.var.audit.force = true;
        const text = await readBody(c.req.raw, MAX_WRITE);
        let r: Result;
        try {
          r = await send(c.var.machine, 'write', p, text, MAX_WRITE, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(WRITE_MS)]));
        } catch (e) {
          if (e instanceof Fail && e.code === 'conflict') throw new Conflict(conflictOf(e.message));
          throw e;
        }
        noStore(c);
        return c.json(r);
      });

      // Uploads a file from the browser (the body, at most MAX_UPLOAD bytes)
      // into a folder: under a free name, or over the file there with
      // replace=1. The body streams to the machine, which writes nothing
      // there until all of it came.
      api.post('/upload', ctx.mutating('upload'), async (c) => {
        const p = uploadParams(queryOf(c));
        const size = contentLength(c.req.raw);
        auditTargets(c.var.audit, p);
        c.var.audit.size = size;
        if (p.replace) c.var.audit.replace = true;
        if (size > MAX_UPLOAD) throw new Fail('too_large', 413, 'more than 4 GiB');
        // One byte over the limit reaches the agent, which refuses it.
        const r = await send(c.var.machine, 'upload', p, c.req.raw, MAX_UPLOAD + 1, c.req.raw.signal);
        noStore(c);
        return c.json(r);
      });

      // Reveal in Finder: only for the hub's own machine (its agent runs on
      // the hub's host) and a client on that host, whose screen the window
      // opens on.
      const unrevealable = (c: Ctx): string =>
        !c.var.machine.local
          ? 'remote_machine'
          : !c.var.sameHost
            ? 'local_only'
            : platform !== 'darwin' && platform !== 'linux'
              ? 'reveal_unavailable'
              : '';
      api.get('/reveal', (c) => {
        noStore(c);
        return c.json({ available: unrevealable(c) === '' });
      });
      // It runs a program on the hub's host: refused in read-only mode and
      // audited, as the changes are.
      api.post(
        '/reveal',
        ctx.mutating('reveal'),
        jsonBody(z.object({ path: z.string().optional().default('') }), { limit: MAX_BODY }),
        async (c) => {
          const { path } = c.req.valid('json');
          c.var.audit.path = path;
          const why = unrevealable(c);
          if (why) throw new Fail(why, why === 'local_only' ? 403 : 400, "only the hub's own machine, from its host's screen");
          const r = await ctx.call(c.var.machine, filesProtocol, 'reveal', { path }, { signal: c.req.raw.signal });
          noStore(c);
          return c.json(r);
        },
      );
    },
  });
