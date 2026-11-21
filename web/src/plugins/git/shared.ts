// What the Git plugin's panel, history, graph pane and pickers share: the
// marks and colors of status letters, the parts of a path, the badges of
// refs, short ages and dates. Nothing here imports a component, so the
// components can each import it.

import type { Ref } from './api';
import { MARK_COLOR, type Mark } from './decorations';

/** The explorer's mark of a status letter. */
export function letterMark(letter: string): Mark {
  switch (letter) {
    case '!':
      return 'conflict';
    case 'U':
      return 'untracked';
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'modified';
  }
}

/** The color of a status letter: the explorer's Git marks'. */
export const letterColor = (letter: string): string => MARK_COLOR[letterMark(letter)];

/** A path's last name (a directory, listed with its trailing /, keeps it). */
export function leafName(p: string): string {
  const dir = p.endsWith('/');
  const q = dir ? p.slice(0, -1) : p;
  return q.slice(q.lastIndexOf('/') + 1) + (dir ? '/' : '');
}

/** The folder a path is in ('' at the top). */
export function folderOf(p: string): string {
  const q = p.endsWith('/') ? p.slice(0, -1) : p;
  return q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : '';
}

/** A badge of a ref. */
export interface Badge {
  kind: 'head' | 'branch' | 'remote' | 'tag';
  /** Short name (main, origin/main, v1). */
  name: string;
  /** The current branch. */
  current?: boolean;
}

/** The badges of each commit: branches (the current one first), remote
 * branches (when shown) and tags. */
export function badgesOf(refs: Ref[], branch: string | undefined, head: string | undefined, remotes: boolean): Map<string, Badge[]> {
  const out = new Map<string, Badge[]>();
  const add = (h: string, b: Badge) => {
    const l = out.get(h) ?? [];
    l.push(b);
    out.set(h, l);
  };
  if (head && !branch) add(head, { kind: 'head', name: 'HEAD', current: true });
  for (const r of refs) {
    if (r.name.startsWith('refs/heads/')) {
      const name = r.name.slice(11);
      add(r.hash, { kind: 'branch', name, current: name === branch });
    } else if (r.name.startsWith('refs/remotes/')) {
      if (remotes) add(r.hash, { kind: 'remote', name: r.name.slice(13) });
    } else if (r.name.startsWith('refs/tags/')) add(r.hash, { kind: 'tag', name: r.name.slice(10) });
  }
  const order = { head: 0, branch: 1, remote: 2, tag: 3 };
  for (const l of out.values()) l.sort((a, b) => Number(!!b.current) - Number(!!a.current) || order[a.kind] - order[b.kind]);
  return out;
}

/** How long ago a time was, short (5m, 3h, 2d, 4w, 2y). */
export function ago(secs: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - secs);
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  if (d < 86400 * 14) return `${Math.round(d / 86400)}d`;
  if (d < 86400 * 365) return `${Math.round(d / (86400 * 7))}w`;
  return `${Math.round(d / (86400 * 365))}y`;
}

/** A time as a date and the time of day (2026-01-31 09:05), local. */
export const fmtDate = (secs: number) => {
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
