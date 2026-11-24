// Serving a file of a machine over HTTP (GET /api/m/:id/file, a download
// of one file): ranges, so a video seeks without downloading everything;
// validators, so the editor and the browser's cache know a file that did
// not change; a content type that never makes a file an active document
// of the UI's origin.
import { getMimeType } from 'hono/utils/mime';
import { Op, type Stat } from '#shared/proto/agentproto/index.ts';
import { Fail } from '#kernel/fail.ts';
import { breakableResponse } from '#kernel/http/breakable.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { agentBody, type Transfer } from './body.ts';
import { baseName } from './names.ts';

/** Keeps a file opened as a document from running script on the origin. */
export const FILE_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

const TEXT = 'text/plain; charset=utf-8';

/** Types for files the common table does not know, or knows otherwise
 * (.ts is TypeScript here, not an MPEG stream). */
const EXTRA_TYPES: Record<string, string> = {
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  avif: 'image/avif',
  webp: 'image/webp',
  heic: 'image/heic',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  md: 'text/markdown; charset=utf-8',
  log: TEXT,
  py: TEXT,
  ts: TEXT,
  go: TEXT,
  rs: TEXT,
  toml: TEXT,
  yaml: TEXT,
  yml: TEXT,
  sh: TEXT,
  svg: 'image/svg+xml',
};

/** The content type a file named name is served with. HTML, scripts and
 * XHTML are plain text: opened from the UI's origin, they would run there. */
export function contentType(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > name.lastIndexOf('/') ? name.slice(dot + 1).toLowerCase() : '';
  if (ext in EXTRA_TYPES) return EXTRA_TYPES[ext];
  const t = ext ? getMimeType(`x.${ext}`) : undefined;
  if (!t) return 'application/octet-stream';
  if (t.startsWith('text/html') || t.includes('javascript') || t.includes('xhtml')) return TEXT;
  return t;
}

/** An integer as Go's strconv.ParseInt reads it (a sign, digits). */
const INT = /^[+-]?\d+$/;

/** The one range of a Range header within a file of size bytes: its start
 * and length, the end clamped to the file; null for anything else (several
 * ranges, another unit, a start past the end). */
export function parseRange(h: string, size: number): { start: number; length: number } | null {
  if (!h.startsWith('bytes=') || h.includes(',')) return null;
  const spec = h.slice(6);
  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const a = spec.slice(0, dash);
  const b = spec.slice(dash + 1);
  if (a === '') {
    if (!INT.test(b)) return null;
    const n = Math.min(Number(b), size);
    return Number(b) > 0 ? { start: size - n, length: n } : null;
  }
  if (!INT.test(a)) return null;
  const start = Number(a);
  if (start < 0 || start >= size) return null;
  let end = size - 1;
  if (b !== '') {
    if (!INT.test(b) || Number(b) < start) return null;
    end = Math.min(end, Number(b));
  }
  return { start, length: end - start + 1 };
}

/** RFC 2045's tspecials. */
const TSPECIALS = '()<>@,;:\\"/[]?=';
const isToken = (s: string) => s !== '' && [...s].every((c) => c > ' ' && c < '\x7f' && !TSPECIALS.includes(c));

/** A Content-Disposition that saves the answer as name, as Go's
 * mime.FormatMediaType writes it: a token as it is, other ASCII quoted,
 * anything else in RFC 2231's encoding. */
export function attachment(name: string): string {
  if ([...name].some((c) => (c < ' ' || c > '~') && c !== '\t')) {
    let enc = '';
    for (const b of Buffer.from(name, 'utf8')) {
      const c = String.fromCharCode(b);
      enc +=
        b <= 0x20 || b >= 0x7f || c === '*' || c === "'" || c === '%' || TSPECIALS.includes(c)
          ? `%${b.toString(16).toUpperCase().padStart(2, '0')}`
          : c;
    }
    return `attachment; filename*=utf-8''${enc}`;
  }
  if (isToken(name)) return `attachment; filename=${name}`;
  return `attachment; filename="${name.replace(/["\\]/g, '\\$&')}"`;
}

/** Go's %x of an integer. */
const hex = (n: number) => (n < 0 ? `-${(-n).toString(16)}` : n.toString(16));

/** A failure of a transfer, with the code the downloads panel shows for
 * it. Its answer is plain text (plainErrors): the editor shows it. */
export class TransferFail extends Fail {
  constructor(status: number, message: string, code: string) {
    super(code, status, message);
  }
}

/** The download code of a refusal of the agent: the machine is not
 * connected, or the path is not there. */
export const failCode = (e: unknown): string => (e instanceof Fail && e.code === 'offline' ? 'unavailable' : 'not_found');

/** Answers req with the file of machine m that st describes (its path and
 * size), or the range asked for, as an attachment when download. The body
 * comes from the agent (fs.read) as the client takes it; t follows how it
 * goes. Throws a TransferFail when the file cannot be read. */
export async function serveFile(m: Machine, req: Request, st: Stat, download: boolean, t: Transfer): Promise<Response> {
  const path = st.path ?? '';
  const etag = `W/"${hex(st.size)}-${hex(st.mtime)}"`;
  const h = new Headers({
    ETag: etag,
    'Last-Modified': new Date(st.mtime).toUTCString(),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  const ctype = contentType(path);
  h.set('Content-Type', ctype);
  // The browser's PDF viewer refuses sandboxed documents.
  if (ctype !== 'application/pdf') h.set('Content-Security-Policy', FILE_CSP);
  if (download) h.set('Content-Disposition', attachment(baseName(path)));
  const answer = (status: number, how: 'complete' | 'broken' = 'complete', body: string | null = null) => {
    t.ended?.(how);
    return new Response(body, { status, headers: h });
  };
  if (req.headers.get('If-None-Match') === etag) return answer(304);

  let start = 0;
  let length = st.size;
  let partial = false;
  const range = req.headers.get('Range');
  if (range) {
    const r = parseRange(range, st.size);
    if (r) ({ start, length, partial } = { ...r, partial: true });
    else if (st.size > 0) {
      // A resumed download of a file that shrank since.
      h.delete('Content-Disposition');
      h.set('Content-Range', `bytes */${st.size}`);
      h.set('Content-Type', TEXT);
      t.fail?.('changed');
      return answer(416, 'broken', 'invalid range\n');
    }
  }
  h.set('Content-Length', String(length));
  if (partial) h.set('Content-Range', `bytes ${start}-${start + length - 1}/${st.size}`);
  const status = partial ? 206 : 200;
  if (req.method === 'HEAD' || length === 0) return answer(status);

  // Opened before the status goes out: a file removed since its stat is
  // still answered as not found.
  const signal = t.cancelled ? AbortSignal.any([t.request, t.cancelled]) : t.request;
  let conn;
  try {
    ({ conn } = await m.open({ op: Op.FsRead, path, offset: start, length }, { signal }));
  } catch (e) {
    const code = failCode(e);
    t.fail?.(code);
    throw new TransferFail(code === 'unavailable' ? 502 : 404, (e as Error).message, code);
  }
  return breakableResponse(agentBody(conn, { length }, t), { status, headers: h });
}
