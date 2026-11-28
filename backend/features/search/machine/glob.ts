// The include and exclude patterns of a search, as VS Code's "files to
// include" and "files to exclude" read them: comma-separated globs, a
// pattern without "/" matching names, one with "/" paths below the
// directory searched. ripgrep gets them as --glob values; the walker
// matches them itself.
import { RE2JS } from 're2js';

/** Bounds the include or exclude patterns of a search. */
const MAX_PATTERNS = 100;

/** The folders no search looks in: version control's data, and
 * node_modules (as VS Code's search.exclude has it). */
export const SKIPPED = ['.git', '.hg', '.svn', '.bzr', '.jj', 'CVS', 'node_modules'];

/** Splits comma-separated patterns (commas inside braces are alternatives
 * of a pattern), dropping blanks, a leading "./" and a trailing "/". */
export function splitGlobs(s = ''): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    p = p.trim();
    if (p.startsWith('./')) p = p.slice(2);
    p = p.replace(/\/+$/, '');
    if (p !== '' && p !== '/' && out.length < MAX_PATTERNS) out.push(p);
  };
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}' && depth > 0) depth--;
    else if (c === ',' && depth === 0) {
      add(s.slice(start, i));
      start = i + 1;
    }
  }
  add(s.slice(start));
  return out;
}

/** Whether pattern p is matched against paths below the directory searched
 * (it has a "/"), else against names. */
export const anchored = (p: string): boolean => p.includes('/');

/** ripgrep's --glob values for the include and exclude patterns, with the
 * skipped folders first: an include names files and what is in the folders
 * it names; an exclude, files and folders, which ripgrep then does not
 * enter. A later glob wins over an earlier one. */
export function rgGlobs(includes: string[], excludes: string[]): string[] {
  const out = SKIPPED.map((s) => `--glob=!${s}`);
  for (let p of includes) {
    if (anchored(p)) {
      p = '/' + p.replace(/^\//, '');
      out.push(`--glob=${p}`, `--glob=${p}/**`);
    } else out.push(`--glob=${p}`, `--glob=**/${p}/**`);
  }
  for (let p of excludes) {
    if (anchored(p)) p = '/' + p.replace(/^\//, '');
    out.push(`--glob=!${p}`);
  }
  return out;
}

const SPECIAL = /[\\^$.*+?()[\]{}|/]/;

/** The regular expression (source) of a glob, matching whole strings:
 * `**` any folders, `*` any characters but "/", `?` one, `[...]` a class
 * (`[!...]` its complement), `{a,b}` alternatives. */
export function globRegexp(g: string): string {
  let out = '^';
  let depth = 0;
  const chars = [...g];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '*' && chars[i + 1] === '*') {
      // "**/" any folders, else anything (also "/**" at the end).
      if (chars[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i++;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = chars.indexOf(']', i + 1);
      if (end < 0) {
        out += '\\[';
        continue;
      }
      let cls = chars.slice(i + 1, end).join('');
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      out += '[' + cls.replaceAll('\\', '\\\\') + ']';
      i = end;
    } else if (c === '{') {
      depth++;
      out += '(?:';
    } else if (c === '}' && depth > 0) {
      depth--;
      out += ')';
    } else if (c === ',' && depth > 0) out += '|';
    else out += SPECIAL.test(c) ? '\\' + c : c;
  }
  for (; depth > 0; depth--) out += ')';
  return out + '$';
}

/** Matches paths below the directory searched ("/" between names) against
 * patterns: one without "/" the name of the file or of a folder it is in,
 * one with "/" (a leading one dropped) the path or a folder's path on it. A
 * pattern that is not a valid expression is left out. The expressions are
 * RE2's (re2js): a glob such as "*a*a*a*b" takes time linear in the path,
 * where a backtracking engine takes time exponential in its stars. */
export class Matcher {
  private readonly names: RE2JS[] = [];
  private readonly paths: RE2JS[] = [];

  constructor(patterns: string[]) {
    for (const p of patterns) {
      let re: RE2JS;
      try {
        re = RE2JS.compile(globRegexp(p.replace(/^\//, '')));
      } catch {
        continue;
      }
      (anchored(p) ? this.paths : this.names).push(re);
    }
  }

  get empty(): boolean {
    return this.names.length === 0 && this.paths.length === 0;
  }

  /** Whether the path itself (its name, or its whole path) matches: a
   * folder that does is not entered. */
  self(rel: string): boolean {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    return this.names.some((re) => re.matcher(name).matches()) || this.paths.some((re) => re.matcher(rel).matches());
  }

  /** Whether the path or a folder it is in matches. */
  any(rel: string): boolean {
    for (let i = 0; i <= rel.length; i++) if ((i === rel.length || rel[i] === '/') && this.self(rel.slice(0, i))) return true;
    return false;
  }
}
