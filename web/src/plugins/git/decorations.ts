// The file explorer's colors for files of the repositories the Git plugin
// follows (state.ts): modified, added, untracked, deleted and conflicted
// files with their letter, and their folders in the color of the most
// pressing change inside, as VS Code's explorer shows them.

import type { FileDecoration } from '../files/decorations';
import { t, type MessageKey } from '../../i18n';
import type { StatusFile } from './api';
import { useGit } from './state';

export type Mark = 'conflict' | 'deleted' | 'modified' | 'added' | 'untracked' | 'renamed';

/** The more pressing marks first. */
const ORDER: Mark[] = ['conflict', 'deleted', 'modified', 'renamed', 'added', 'untracked'];

export const MARK_COLOR: Record<Mark, string> = {
  conflict: 'var(--blocked)',
  deleted: 'var(--error)',
  modified: 'var(--working)',
  renamed: 'var(--working)',
  added: 'var(--done)',
  untracked: 'var(--done)',
};

const LETTER: Record<Mark, string> = { conflict: '!', deleted: 'D', modified: 'M', renamed: 'R', added: 'A', untracked: 'U' };

/** How a file of the status shows in the explorer (both sides counted). */
export function markOf(f: StatusFile): Mark | undefined {
  if (f.kind === 'unmerged') return 'conflict';
  if (f.kind === 'untracked') return 'untracked';
  if (f.kind === 'ignored') return undefined;
  if (f.x === 'D' || f.y === 'D') return 'deleted';
  if (f.y === 'M' || f.y === 'T' || f.x === 'M' || f.x === 'T') return 'modified';
  if (f.kind === 'renamed') return 'renamed';
  if (f.x === 'A') return 'added';
  return 'modified';
}

const more = (a: Mark | undefined, b: Mark) => (a === undefined || ORDER.indexOf(b) < ORDER.indexOf(a) ? b : a);

/** The decorations of dir's entries from statuses of repositories of
 * machine m (roots and their files). */
export function decorate(repos: { root: string; files: StatusFile[] }[], dir: string): Record<string, FileDecoration> {
  const out: Record<string, FileDecoration> = {};
  const marks: Record<string, { mark: Mark; file: boolean }> = {};
  const d = dir.replace(/\/+$/, '') || '/';
  for (const { root, files } of repos) {
    const r = root.replace(/\/+$/, '');
    if (!(d === r || d.startsWith(r + '/') || r.startsWith(d === '/' ? '/' : d + '/'))) continue;
    for (const f of files) {
      const mark = markOf(f);
      if (!mark) continue;
      const abs = `${r}/${f.path}`;
      if (!abs.startsWith(d === '/' ? '/' : d + '/')) continue;
      const rest = abs.slice(d === '/' ? 1 : d.length + 1);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      const prev = marks[name];
      marks[name] = { mark: more(prev?.mark, mark), file: slash < 0 };
    }
  }
  for (const [name, { mark, file }] of Object.entries(marks)) {
    out[name] = { color: MARK_COLOR[mark], badge: file ? LETTER[mark] : undefined, tooltip: t(`git.mark.${mark}` as MessageKey) };
    if (!file) out[name].badge = '•';
  }
  return out;
}

/** The provider the plugin registers with the explorer. */
export function gitDecorations(m: string, dir: string): Record<string, FileDecoration> | undefined {
  const repos: { root: string; files: StatusFile[] }[] = [];
  for (const [k, s] of Object.entries(useGit.getState().repos)) {
    const [mm, root] = k.split('\u0000');
    if (mm !== m || !s.status) continue;
    repos.push({ root, files: s.status.files });
  }
  return repos.length ? decorate(repos, dir) : undefined;
}
