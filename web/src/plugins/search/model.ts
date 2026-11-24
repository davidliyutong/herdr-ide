// What Project Search's panel draws of a result, without React: the rows
// (a file, then its matching lines while it is expanded), the names and
// folders of the files, the paths they open at, and the summary line.
import type { SearchFile, SearchMatch, SearchParams, SearchResult } from './api';

export type Row =
  | { kind: 'file'; id: string; file: SearchFile; open: boolean }
  | { kind: 'match'; id: string; file: SearchFile; match: SearchMatch; index: number };

/** The id of a file's row, and of its index-th matching line's. */
export const fileId = (f: SearchFile) => `f:${f.path}`;
export const matchId = (f: SearchFile, index: number) => `m:${index}:${f.path}`;

/** The rows of a result: each file (in the result's order), then its
 * lines unless it is collapsed. */
export function resultRows(r: SearchResult | undefined, collapsed: Readonly<Record<string, boolean>>): Row[] {
  const out: Row[] = [];
  for (const file of r?.files ?? []) {
    const open = !collapsed[file.path];
    out.push({ kind: 'file', id: fileId(file), file, open });
    if (open) file.matches.forEach((match, index) => out.push({ kind: 'match', id: matchId(file, index), file, match, index }));
  }
  return out;
}

/** The matches of a file (several on a line count each). */
export const matchesOf = (f: SearchFile) => f.matches.reduce((n, m) => n + Math.max(1, m.ranges.length), 0);

/** A relative path's name and the folder it is in ("" at the top). */
export function splitPath(rel: string): { name: string; folder: string } {
  const i = rel.lastIndexOf('/');
  return i < 0 ? { name: rel, folder: '' } : { name: rel.slice(i + 1), folder: rel.slice(0, i) };
}

/** The absolute path of a file of the result. */
export const joinPath = (dir: string, rel: string) => (dir.endsWith('/') ? dir + rel : `${dir}/${rel}`);

/** The row the arrows move to from id: step rows on, staying in bounds. */
export function stepRow(rows: readonly Row[], id: string | undefined, step: number): string | undefined {
  if (!rows.length) return undefined;
  const i = id ? rows.findIndex((r) => r.id === id) : -1;
  if (i < 0) return rows[step > 0 ? 0 : rows.length - 1].id;
  return rows[Math.min(rows.length - 1, Math.max(0, i + step))].id;
}

/** A search's identity: the same one is not run again. */
export const paramsKey = (m: string, p: SearchParams) =>
  JSON.stringify([m, p.dir, p.query, !!p.regex, !!p.caseSensitive, !!p.wholeWord, p.include ?? '', p.exclude ?? '']);

/** A directory as the panel shows it: the home directory as "~". */
export function shortDir(dir: string, home: string | undefined): string {
  if (!home || home === '/') return dir;
  if (dir === home) return '~';
  return dir.startsWith(home + '/') ? '~' + dir.slice(home.length) : dir;
}
