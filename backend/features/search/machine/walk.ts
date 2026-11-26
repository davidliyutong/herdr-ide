// The walker: a search without ripgrep. It reads the regular files of at
// most MAX_FILE_SIZE bytes below the directory that are not binary, not in
// the skipped folders or those the top-level .gitignore names, that match
// the includes and not the excludes; links are not followed. It reads at
// most MAX_FILES files, and only reads.
import { isUtf8 } from 'node:buffer';
import { constants, type Dirent } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import { Collector, type Result } from './collector.ts';
import type { Span } from './excerpt.ts';
import { Matcher, SKIPPED } from './glob.ts';
import { MAX_FILE_SIZE, MAX_FILES, type Query, type Stop } from './query.ts';
import { decodeMapped } from './utf8.ts';

/** How much of a file is looked at for a NUL byte, which makes it binary
 * (as git and ripgrep tell). */
const BINARY_SNIFF = 8 << 10;
/** Bounds the top-level .gitignore read. */
const MAX_GITIGNORE = 256 << 10;

/** The regular expression of a query: its text quoted unless it is a
 * regular expression, case-insensitive unless asked otherwise. The walker
 * reads expressions as JavaScript's (with Unicode), ripgrep as its own. */
export function compile(q: Pick<Query, 'query' | 'regex' | 'caseSensitive'>): RegExp {
  const expr = q.regex ? q.query : q.query.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  try {
    return new RegExp(expr, q.caseSensitive ? 'gu' : 'giu');
  } catch (e) {
    throw new Fail('bad_regex', 400, (e as Error).message);
  }
}

const WORD = /[\p{L}\p{Nd}_]/u;

/** Whether the match [s, e) of text stands as a whole word: no word
 * character right before or after it. */
function wordAt(text: string, s: number, e: number): boolean {
  if (s > 0) {
    const lo = s >= 2 && /[\udc00-\udfff]/.test(text[s - 1]) && /[\ud800-\udbff]/.test(text[s - 2]) ? s - 2 : s - 1;
    if (WORD.test(String.fromCodePoint(text.codePointAt(lo)!))) return false;
  }
  if (e < text.length && WORD.test(String.fromCodePoint(text.codePointAt(e)!))) return false;
  return true;
}

/** The matches in a line of text (UTF-16 indices); empty matches find
 * nothing to show. */
export function lineMatches(re: RegExp, text: string, whole: boolean): Span[] {
  const out: Span[] = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const s = m.index;
    const e = s + m[0].length;
    if (e === s || (whole && !wordAt(text, s, e))) continue;
    out.push([s, e]);
  }
  return out;
}

/** The patterns of the top-level .gitignore of dir (the walker's
 * approximation of ripgrep's ignore rules): blank lines, comments and
 * negations are left out. */
export async function gitignore(dir: string): Promise<string[]> {
  let text: string;
  try {
    const f = await open(posix.join(dir, '.gitignore'), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const buf = Buffer.alloc(MAX_GITIGNORE);
      const { bytesRead } = await f.read(buf, 0, buf.length, 0);
      text = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await f.close();
    }
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l === '' || l.startsWith('#') || l.startsWith('!')) continue;
    const p = l.replace(/\/+$/, '');
    if (p !== '') out.push(p);
  }
  return out;
}

/** A file of at most MAX_FILE_SIZE bytes read into buf; null for a larger,
 * binary or unreadable one. It is opened without blocking and must still
 * be a regular file (not a FIFO put there since). */
async function readText(p: string, buf: Buffer): Promise<Buffer | null> {
  let f;
  try {
    f = await open(p, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = await f.stat();
    if (!st.isFile() || st.size > MAX_FILE_SIZE) return null;
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await f.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n === buf.length) {
      // Grew past the limit since the stat.
      const { bytesRead } = await f.read(Buffer.alloc(1), 0, 1, n);
      if (bytesRead > 0) return null;
    }
    const data = buf.subarray(0, n);
    if (data.subarray(0, BINARY_SNIFF).includes(0)) return null;
    return data;
  } catch {
    return null;
  } finally {
    await f.close().catch(() => {});
  }
}

/** Adds the matches of each line of data to c; false once c is full. */
export function searchText(c: Collector, re: RegExp, whole: boolean, rel: string, data: Buffer): boolean {
  if (isUtf8(data)) {
    const text = data.toString('utf8');
    // Most files have no match: one look at the whole text first.
    const any = new RegExp(re.source, re.flags.replace('g', '') + 'm');
    if (!any.test(text)) return true;
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
      const found = lineMatches(re, line, whole);
      if (!found.length) continue;
      const bytes = (k: number) => Buffer.byteLength(line.slice(0, k));
      if (
        !c.add(
          rel,
          i + 1,
          Buffer.from(line, 'utf8'),
          found.map(([s, e]) => [bytes(s), bytes(e)]),
        )
      )
        return false;
    }
    return true;
  }
  // Not UTF-8: each line as the Go agent decoded it, a byte that is not
  // UTF-8 one replacement character.
  for (let no = 1, at = 0; at < data.length; no++) {
    const nl = data.indexOf(0x0a, at);
    let line = data.subarray(at, nl < 0 ? data.length : nl);
    at = nl < 0 ? data.length : nl + 1;
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    const { text, byteAt } = decodeMapped(line);
    const found = lineMatches(re, text, whole);
    if (
      found.length &&
      !c.add(
        rel,
        no,
        line,
        found.map(([s, e]) => [byteAt[s], byteAt[e]]),
      )
    )
      return false;
  }
  return true;
}

/** Names compared as the Go agent's walk orders them: by their bytes. */
const byBytes = (a: Dirent, b: Dirent) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name));

/** Searches the files below q.dir. */
export async function walk(q: Query, stop: Stop): Promise<Result> {
  const re = compile(q);
  const include = new Matcher(q.includes);
  const exclude = new Matcher([...SKIPPED, ...(await gitignore(q.dir)), ...q.excludes]);
  const c = new Collector('builtin', q.limit);
  const buf = Buffer.alloc(MAX_FILE_SIZE);
  let files = 0;
  let done = false;
  const visit = async (dir: string, rel: string): Promise<void> => {
    let ents: Dirent[];
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // a folder that cannot be read is left out
    }
    ents.sort(byBytes);
    for (const d of ents) {
      if (done || stop.signal.aborted || stop.timedOut()) {
        done = true;
        return;
      }
      const r = rel ? `${rel}/${d.name}` : d.name;
      const p = posix.join(dir, d.name);
      if (d.isDirectory()) {
        if (!exclude.self(r)) await visit(p, r);
        continue;
      }
      if (!d.isFile() || exclude.self(r) || (!include.empty && !include.any(r))) continue;
      if (files >= MAX_FILES) {
        c.stop('max_files');
        done = true;
        return;
      }
      files++;
      const data = await readText(p, buf);
      if (data && !searchText(c, re, !!q.wholeWord, r, data)) {
        done = true;
        return;
      }
    }
  };
  await visit(q.dir, '');
  c.finish(stop.timedOut());
  return c.res;
}
