// What the Git feature's machine side checks before a value of a request
// reaches git: ref names and revisions never start with "-" and have none
// of the characters git gives a meaning; paths are relative to the top
// level, come after "--" and are literal pathspecs; remotes' URLs reach the
// page without what could be a credential.
import { posix } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';

/** Bounds the entries of a status, the ignored paths it lists besides
 * them and the paths of one change (as many as a status lists). */
export const MAX_STATUS = 20000;
export const MAX_IGNORED = MAX_STATUS;
export const MAX_PATHS = MAX_STATUS;
/** Bounds the paths of one run of git: a change with more runs git several
 * times (the system limits a command line's length). */
export const MAX_ARG_BYTES = 96 << 10;

export const badParams = (message: string): Fail => new Fail('bad_params', 400, message);
export const badRef = (message: string): Fail => new Fail('bad_ref', 400, message);

/** An abbreviated or whole object name. */
export const HEX_REV = /^[0-9a-fA-F]{4,64}$/;
/** An object's whole name (SHA-1 or SHA-256). */
export const FULL_HASH = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/** Characters no ref name or revision the UI sends has. */
const BAD_REF_CHARS = /[ \t\n\r\0\x7f~^:?*[\\]/;

/** Checks the shape of a ref name or revision: not empty, no leading "-",
 * no characters git gives a meaning, no "..", "@{" or "//". */
export function plainName(s: string): void {
  const bad = () => badRef(`bad name ${JSON.stringify(s)}`);
  if (s === '' || Buffer.byteLength(s) > 255) throw bad();
  if (s.startsWith('-')) throw badRef(`${JSON.stringify(s)} starts with -`);
  if (BAD_REF_CHARS.test(s) || s.includes('..') || s.includes('@{') || s.includes('//')) throw bad();
  if (s.startsWith('/') || s.endsWith('/') || s.endsWith('.') || s.endsWith('.lock')) throw bad();
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) throw bad();
}

/** A remote's name as the checks allow it; it must then be one of the
 * repository's remotes. */
export const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/** Checks a path relative to the top level: not empty, not absolute, no
 * "." or ".." elements, no NUL. A trailing "/" (a directory, as the status
 * lists an untracked repository inside this one) is kept. */
export function cleanPath(p: string): string {
  const dir = p.endsWith('/');
  const rel = dir ? p.slice(0, -1) : p;
  const bad = () => badParams(`bad path ${JSON.stringify(p)}`);
  if (rel === '' || rel.includes('\0') || rel.startsWith('/')) throw bad();
  for (const el of rel.split('/')) if (el === '' || el === '.' || el === '..') throw bad();
  const clean = posix.normalize(rel);
  return dir ? clean + '/' : clean;
}

/** Each path checked; at most MAX_PATHS. */
export function cleanPaths(ps: readonly string[] | undefined): string[] {
  const list = ps ?? [];
  if (list.length > MAX_PATHS) throw badParams(`at most ${MAX_PATHS} paths`);
  return list.map(cleanPath);
}

/** A path as a pathspec that matches it only: no wildcards, no other
 * magic. The magic is the path's own, not GIT_LITERAL_PATHSPECS, which
 * hooks would inherit. */
export const literal = (p: string): string => ':(literal)' + p;

/** The argument vectors of runs of git with args, "--" and paths as
 * literal pathspecs, as many paths per run as fit maxBytes. */
export function pathArgs(args: readonly string[], paths: readonly string[], maxBytes = MAX_ARG_BYTES): string[][] {
  const runs: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  const flush = () => {
    runs.push([...args, '--', ...cur]);
    cur = [];
    size = 0;
  };
  for (const p of paths) {
    const lp = literal(p);
    const n = Buffer.byteLength(lp) + 1;
    if (cur.length > 0 && size + n > maxBytes) flush();
    cur.push(lp);
    size += n;
  }
  if (cur.length > 0) flush();
  return runs;
}

/** Each remote's fetch URL of `git remote -v`, redacted. */
export function remoteURLs(out: string): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const l of out.split('\n')) {
    const tab = l.indexOf('\t');
    if (tab < 0) continue;
    const rest = l.slice(tab + 1);
    const paren = rest.indexOf(' (');
    if (paren < 0 || rest.slice(paren + 2) !== 'fetch)') continue;
    urls[l.slice(0, tab)] = redactURL(rest.slice(0, paren));
  }
  return urls;
}

const indexAny = (s: string, chars: string): number => {
  for (let i = 0; i < s.length; i++) if (chars.includes(s[i])) return i;
  return -1;
};

/** A remote's URL without what may hold a token: a URL's user information
 * (https://user:token@host/…, also a password with a raw '/', '?', '#' or
 * '@') and its query and fragment (?access_token=…); of the scp-like form
 * (user@host:path), a user with a password. */
export function redactURL(s: string): string {
  const i = s.indexOf('://');
  if (i > 0) {
    const head = s.slice(0, i + 3);
    let rest = s.slice(i + 3);
    const at = rest.indexOf('@');
    if (at >= 0) {
      // The authority as a URL parser reads it ends at the first of "/?#";
      // an '@' past it is the path's only when what comes before is a
      // host. Otherwise the user information ends at the last '@' before
      // the end of the part the first '@' is in.
      const j = indexAny(rest, '/?#');
      const auth = j >= 0 ? rest.slice(0, j) : rest;
      if (at < auth.length || !hostPort(auth)) {
        const k = indexAny(rest.slice(at), '/?#');
        const end = k >= 0 ? at + k : rest.length;
        rest = rest.slice(rest.slice(0, end).lastIndexOf('@') + 1);
      }
    }
    const q = indexAny(rest, '?#');
    return head + (q >= 0 ? rest.slice(0, q) : rest);
  }
  const slash = s.indexOf('/');
  const host = slash >= 0 ? s.slice(0, slash) : s;
  const at = host.lastIndexOf('@');
  if (at > 0 && s.slice(0, at).includes(':')) return s.slice(at + 1);
  return s;
}

/** Whether s reads as a URL's host with an optional port (empty, as
 * file:/// has, included): letters, digits, '-', '.' and percent escapes,
 * or a bracketed IPv6 literal. */
export function hostPort(s: string): boolean {
  if (s.startsWith('[')) {
    const j = s.indexOf(']');
    if (j < 0) return false;
    s = 'h' + s.slice(j + 1);
  }
  const colon = s.indexOf(':');
  if (colon >= 0 && !/^[0-9]*$/.test(s.slice(colon + 1))) return false;
  for (const c of colon >= 0 ? s.slice(0, colon) : s) {
    if (!(c === '-' || c === '.' || c === '%' || /[0-9a-zA-Z]/.test(c) || c.codePointAt(0)! > 0x7f)) return false;
  }
  return true;
}
