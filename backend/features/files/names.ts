// Names and paths of transfers: the names uploads get on a machine, the
// paths of a download and the name of its archive. Paths on machines are
// POSIX (node:path's posix), cleaned as Go's path.Clean does.
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';

/** p cleaned as Go's path.Clean: no ".", "..", repeated or trailing "/";
 * "." for an empty path. */
export function cleanPath(p: string): string {
  if (p === '') return '.';
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

/** The last element of p as Go's path.Base names it: "." for an empty
 * path, "/" for the root. */
export function baseName(p: string): string {
  if (p === '') return '.';
  const t = p.replace(/\/+$/, '');
  return t === '' ? '/' : t.slice(t.lastIndexOf('/') + 1);
}

/** Bounds the paths of one download (the agent's limit). */
export const MAX_DOWNLOAD_PATHS = 1000;

/** The paths of a download: absolute, without NUL, cleaned and without
 * repeats, 1 to MAX_DOWNLOAD_PATHS of them; throws an Error saying why not. */
export function downloadPaths(raw: readonly string[]): string[] {
  if (raw.length === 0 || raw.length > MAX_DOWNLOAD_PATHS) throw new Error(`between 1 and ${MAX_DOWNLOAD_PATHS} paths`);
  const out = new Set<string>();
  for (const p of raw) {
    if (!p.startsWith('/') || p.includes('\0')) throw new Error(`not an absolute path: ${JSON.stringify(p)}`);
    out.add(cleanPath(p));
  }
  return [...out];
}

/** The file name of a zip of paths: the one path's name, or the name of the
 * directory holding them all; download.zip for the root. */
export function archiveName(paths: readonly string[]): string {
  let dir = paths[0];
  if (paths.length > 1) {
    dir = posix.dirname(paths[0]);
    for (const p of paths.slice(1)) while (dir !== '/' && !p.startsWith(dir + '/')) dir = posix.dirname(dir);
  }
  const base = baseName(dir);
  return base !== '/' && base !== '.' ? `${base}.zip` : 'download.zip';
}

/** The local time as Go writes "20060102-150405". */
function stamp(t: Date): string {
  const d2 = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}${d2(t.getMonth() + 1)}${d2(t.getDate())}-${d2(t.getHours())}${d2(t.getMinutes())}${d2(t.getSeconds())}`;
}

/** A unique, shell-friendly name for an upload into the machine's upload
 * directory: several clipboard images are all called "image.png", so a
 * time alone would let one overwrite another. */
export function uploadName(original: string, now: Date): string {
  let base = baseName(original)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  if (base === '') base = 'upload';
  if (base.length > 80) base = base.slice(-80);
  return `${stamp(now)}-${randomBytes(4).toString('hex')}-${base}`;
}

/** Control characters (Go's unicode.IsControl): C0, DEL and C1. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** White space at either end (Go's strings.TrimSpace). */
const EDGE_SPACE =
  /^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
/** Bounds a name kept in a directory the user chose. */
const MAX_KEPT = 200;

/** The name of an upload into a directory the user chose: its own base name
 * without control characters (at most MAX_KEPT bytes, keeping the end), or
 * "upload". */
export function keptName(original: string): string {
  let base = baseName(original).replace(CONTROL, '').replace(EDGE_SPACE, '');
  if (base === '.' || base === '..' || base === '/' || base === '') base = 'upload';
  let chars = [...base];
  while (Buffer.byteLength(base) > MAX_KEPT) {
    chars = chars.slice(1);
    base = chars.join('');
  }
  return base;
}

/** Where an upload named name goes (the agent's fs.write): into the upload
 * directory under a unique name, the folders leading there made; or with
 * dir (absolute, ~ or below ~/) into that existing directory under its own
 * name, which the agent makes unique, never replacing a file. Throws an
 * Error for a relative dir. */
export function uploadTarget(
  q: { name: string; dir: string },
  uploadDir: string,
  now: Date,
): { path: string; mkdirs?: true; unique?: true } {
  if (q.dir === '') return { path: cleanPath(posix.join(uploadDir, uploadName(q.name, now))), mkdirs: true };
  if (!q.dir.startsWith('/') && q.dir !== '~' && !q.dir.startsWith('~/')) throw new Error('dir must be absolute');
  return { path: cleanPath(posix.join(q.dir, keptName(q.name))), unique: true };
}
