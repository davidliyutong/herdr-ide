// Bounded recursive file & directory finder on a machine:
// - match: "fuzzy" (default, for @ path completion): read-only BFS walk (never
//   follows symlinks), .gitignore-aware, capped at MAX_VISITED entries and
//   FIND_TIMEOUT_MS so huge repositories stay snappy.
// - match: "name" (for the File Explorer's whole-project filename filter):
//   read-only BFS walk (never follows symlinks), honoring the explorer's hidden
//   and exclude settings, optional regular expressions (RE2's syntax, matched
//   in linear time: a pattern from the client cannot stall the node by
//   backtracking, which no deadline between entries would stop), higher
//   visit/time caps,
//   and two-priority traversal so project files are searched before heavy
//   dependency/build directories when not explicitly excluded.
import { constants, statSync, type Dirent } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import { RE2JS } from 're2js';
import { Fail } from '#shared/lib/fail.ts';
import { MAX_FIND_LIMIT, type FindMatch, type FindResult } from '../protocol.ts';
import { DEFAULT_EXCLUDE } from '../settings.ts';

export const DEFAULT_FIND_LIMIT = 50;
export { MAX_FIND_LIMIT };
export const MAX_VISITED = 2000;
export const FIND_TIMEOUT_MS = 2000;
export const EXPLORER_MAX_VISITED = 50_000;
export const EXPLORER_TIMEOUT_MS = 5_000;
const MAX_HITS = 5_000;
const MAX_GITIGNORE = 128 << 10;

const DEFAULT_SKIP = new Set([
  '.git',
  'node_modules',
  '.hg',
  '.svn',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

/** Heavy dependency/cache directories searched only after regular project
 * directories in explorer filename search (unless already excluded). */
const DEFERRED_DIRS = new Set(['node_modules', 'target', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache']);

/** Compiles one files.exclude glob pattern (same syntax as web/src/plugins/files/tree.ts). */
function excludeGlobRe(pattern: string): RegExp | undefined {
  const p = pattern.replace(/^(\*\*\/)+/, '');
  if (!p) return undefined;
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '\\' && i + 1 < p.length) {
      re += p[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (c === '*') {
      re += '.*';
    } else if (c === '?') {
      re += '.';
    } else if (c === '[') {
      const end = p.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        let body = p.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (body.startsWith('!')) body = '^' + body.slice(1);
        re += `[${body}]`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
    }
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return undefined;
  }
}

function compileExclude(patterns: readonly string[]): (name: string) => boolean {
  const res = patterns.map(excludeGlobRe).filter((r): r is RegExp => !!r);
  if (!res.length) return () => false;
  return (name: string) => res.some((r) => r.test(name));
}

interface IgnoreRule {
  base: string;
  re: RegExp;
  dirOnly: boolean;
  anchored: boolean;
}

/** Compiles a single .gitignore line into a rule; null for blank/comment/negation. */
function compileIgnore(raw: string, base: string): IgnoreRule | null {
  const line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith('!')) return null;
  const dirOnly = line.endsWith('/');
  let pat = dirOnly ? line.slice(0, -1) : line;
  if (!pat) return null;
  const anchored = pat.startsWith('/') || pat.includes('/');
  if (pat.startsWith('/')) pat = pat.slice(1);
  // Convert glob syntax (*, **, ?) to RegExp safely.
  let rx = '^';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]!;
    if (ch === '*' && pat[i + 1] === '*') {
      if (pat[i + 2] === '/') {
        rx += '(?:.*/)?';
        i += 2;
      } else {
        rx += '.*';
        i++;
      }
    } else if (ch === '*') {
      rx += '[^/]*';
    } else if (ch === '?') {
      rx += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      rx += '\\' + ch;
    } else {
      rx += ch;
    }
  }
  rx += '$';
  try {
    return { base, re: new RegExp(rx), dirOnly, anchored };
  } catch {
    return null;
  }
}

async function readGitignore(dir: string, relBase: string): Promise<IgnoreRule[]> {
  let text: string;
  const ignorePath = posix.join(dir, '.gitignore');
  try {
    if (!(await lstat(ignorePath)).isFile()) return [];
    const f = await open(ignorePath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await f.stat()).isFile()) return [];
      const buf = Buffer.alloc(MAX_GITIGNORE);
      const { bytesRead } = await f.read(buf, 0, buf.length, 0);
      text = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await f.close();
    }
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const line of text.split('\n')) {
    const r = compileIgnore(line, relBase);
    if (r) rules.push(r);
  }
  return rules;
}

function isIgnored(rel: string, name: string, isDir: boolean, rules: readonly IgnoreRule[]): boolean {
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    let target = rel;
    if (r.base !== '') {
      if (!rel.startsWith(r.base + '/')) continue;
      target = rel.slice(r.base.length + 1);
    }
    if (r.anchored) {
      if (r.re.test(target)) return true;
    } else {
      if (r.re.test(name) || r.re.test(target)) return true;
    }
  }
  return false;
}

/** Scores how well rel/name matches query (lower is better; -1 = no match). */
function scoreMatch(rel: string, name: string, q: string): number {
  if (!q) return 0;
  const lr = rel.toLowerCase();
  const ln = name.toLowerCase();
  if (ln === q) return 0;
  if (ln.startsWith(q)) return 1;
  if (lr.startsWith(q)) return 2;
  const ni = ln.indexOf(q);
  if (ni >= 0) return 3 + Math.min(ni, 50) * 0.01;
  const ri = lr.indexOf(q);
  if (ri >= 0) return 4 + Math.min(ri, 100) * 0.005;
  // Subsequence fuzzy match across rel.
  let qi = 0;
  let gaps = 0;
  let last = -1;
  for (let i = 0; i < lr.length && qi < q.length; i++) {
    if (lr[i] === q[qi]) {
      if (last >= 0 && i > last + 1) gaps++;
      last = i;
      qi++;
    }
  }
  if (qi < q.length) return -1;
  return 5 + Math.min(gaps, 50) * 0.02;
}

export interface FindOptions {
  dir: string;
  query?: string;
  limit?: number;
  match?: 'fuzzy' | 'name';
  regex?: boolean;
  hidden?: boolean;
  exclude?: readonly string[];
  maxVisited?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Scores a filename/path substring match for explorer search (-1 = no match). */
function scoreName(rel: string, name: string, q: string, matchPath: boolean): number {
  const ln = name.toLowerCase();
  if (!matchPath) {
    if (ln === q) return 0;
    if (ln.startsWith(q)) return 1;
    const ni = ln.indexOf(q);
    return ni >= 0 ? 2 + Math.min(ni, 50) * 0.01 : -1;
  }
  const lr = rel.toLowerCase();
  if (lr === q) return 0;
  if (lr.startsWith(q)) return 1;
  const ri = lr.indexOf(q);
  return ri >= 0 ? 2 + Math.min(ri, 100) * 0.005 : -1;
}

/** Scores a regular-expression match against name (or rel when pattern includes /). */
function scoreRegex(rel: string, name: string, re: RE2JS, matchPath: boolean): number {
  const m = re.matcher(name);
  if (m.find()) {
    if (m.start() === 0 && m.end() === name.length) return 0;
    if (m.start() === 0) return 1;
    return 2 + Math.min(m.start(), 50) * 0.01;
  }
  if (!matchPath) return -1;
  const rm = re.matcher(rel);
  if (!rm.find()) return -1;
  return 3 + Math.min(rm.start(), 100) * 0.005;
}

/** Walks dir breadth-first (without following symlinks), returning matching
 * files and directories ranked by relevance to query. */
export async function findFiles(o: FindOptions): Promise<FindResult> {
  if (!o.dir || o.dir.includes('\0')) throw new Fail('bad_params', 400, 'dir required');
  let isDir: boolean;
  try {
    isDir = statSync(o.dir).isDirectory();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const msg = `${o.dir}: ${(e as Error).message}`;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Fail('not_found', 404, msg);
    if (code === 'EACCES' || code === 'EPERM') throw new Fail('denied', 403, msg);
    throw new Fail('failed', 400, msg);
  }
  if (!isDir) throw new Fail('not_dir', 400, `${o.dir} is not a directory`);

  const mode = o.match ?? 'fuzzy';
  const isNameMode = mode === 'name';
  const useRegex = o.regex === true;
  const rawInput = o.query ?? '';
  if (Buffer.byteLength(rawInput) > 256 || /[\0\r\n]/.test(rawInput)) throw new Fail('bad_params', 400, 'invalid query');
  const rawQuery = useRegex ? rawInput : rawInput.trim();
  const q = useRegex ? rawQuery : rawQuery.replace(/^\.\//, '').toLowerCase();

  let regex: RE2JS | undefined;
  if (useRegex && rawQuery !== '') {
    try {
      regex = RE2JS.compile(rawQuery, RE2JS.CASE_INSENSITIVE);
    } catch (e) {
      throw new Fail('bad_regex', 400, (e as Error).message);
    }
  }

  if (isNameMode && !q) return { matches: [] };

  const limit = Math.max(1, Math.min(o.limit ?? DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT));
  const maxVisited = o.maxVisited ?? (isNameMode ? EXPLORER_MAX_VISITED : MAX_VISITED);
  const deadline = Date.now() + (o.timeoutMs ?? (isNameMode ? EXPLORER_TIMEOUT_MS : FIND_TIMEOUT_MS));
  const matchPath = q.includes('/');
  const firstSeg = q.split('/')[0] ?? '';
  const allowHidden = o.hidden ?? (!isNameMode && (q.startsWith('.') || q.includes('/.')));
  const isExcluded = isNameMode ? compileExclude(o.exclude ?? DEFAULT_EXCLUDE) : o.exclude ? compileExclude(o.exclude) : () => false;

  interface QueueItem {
    abs: string;
    rel: string;
    rules: IgnoreRule[];
  }

  const rootRules = isNameMode ? [] : await readGitignore(o.dir, '');
  const queue: QueueItem[] = [{ abs: o.dir, rel: '', rules: rootRules }];
  const deferred: QueueItem[] = [];
  const hits: Array<{ match: FindMatch; score: number }> = [];
  let visited = 0;
  let truncated = false;

  while (queue.length > 0 || deferred.length > 0) {
    if (o.signal?.aborted || Date.now() >= deadline) {
      truncated = true;
      break;
    }
    const cur = queue.length > 0 ? queue.shift()! : deferred.shift()!;
    let entries: Dirent[];
    try {
      entries = await readdir(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const ent of entries) {
      if (o.signal?.aborted || Date.now() >= deadline) {
        truncated = true;
        break;
      }
      const name = ent.name;
      if (!name || name === '.' || name === '..') continue;
      if (ent.isSymbolicLink()) continue;
      const entIsDir = ent.isDirectory();
      if (!entIsDir && !ent.isFile()) continue;
      const rel = cur.rel ? `${cur.rel}/${name}` : name;

      if (isNameMode) {
        if ((!allowHidden && name.startsWith('.')) || isExcluded(name)) continue;
      } else {
        if (entIsDir && DEFAULT_SKIP.has(name) && firstSeg !== name.toLowerCase()) continue;
        if (name.startsWith('.') && !allowHidden && name !== '.env.example') continue;
        if (isExcluded(name)) continue;
        if (isIgnored(rel, name, entIsDir, cur.rules)) continue;
      }

      visited++;
      if (visited > maxVisited) {
        truncated = true;
        break;
      }

      const abs = posix.join(cur.abs, name);
      const score = regex
        ? scoreRegex(rel, name, regex, matchPath)
        : isNameMode
          ? scoreName(rel, name, q, matchPath)
          : scoreMatch(rel, name, q);
      if (score >= 0) {
        hits.push({
          score,
          match: {
            path: abs,
            rel,
            name,
            ...(entIsDir ? { is_dir: true } : {}),
          },
        });
        if (hits.length >= MAX_HITS) {
          truncated = true;
          break;
        }
      }

      if (entIsDir) {
        if (isNameMode) {
          const item: QueueItem = { abs, rel, rules: cur.rules };
          if (DEFERRED_DIRS.has(name)) deferred.push(item);
          else queue.push(item);
        } else {
          const sub = await readGitignore(abs, rel);
          queue.push({ abs, rel, rules: sub.length ? [...cur.rules, ...sub] : cur.rules });
        }
      }

      // Without a query, stop once we have collected enough shallow entries.
      if (!q && hits.length >= limit * 2) break;
    }
    if (truncated || (!q && hits.length >= limit * 2)) break;
  }

  hits.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    // With no query, show directories before files at the same depth.
    if (!q) {
      const da = a.match.rel.split('/').length;
      const db = b.match.rel.split('/').length;
      if (da !== db) return da - db;
      if (!!a.match.is_dir !== !!b.match.is_dir) return a.match.is_dir ? -1 : 1;
    }
    if (a.match.rel.length !== b.match.rel.length) return a.match.rel.length - b.match.rel.length;
    return a.match.rel < b.match.rel ? -1 : a.match.rel > b.match.rel ? 1 : 0;
  });

  const more = truncated || hits.length > limit;
  return {
    matches: hits.slice(0, limit).map((h) => h.match),
    ...(more ? { truncated: true } : {}),
  };
}
