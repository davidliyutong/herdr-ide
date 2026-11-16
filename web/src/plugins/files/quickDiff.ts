// The editor's quick diff, as VS Code's: bars in the gutter where the text
// differs from what version control has (lines added, changed, removed).
// A plugin (Git) provides the text a file is compared with; the editor
// diffs it with its own text, unsaved changes included, by lines.

import { refreshDecorations } from './decorations';

export interface QuickDiffProvider {
  /** Follows the file's repository while an editor shows it; returns the
   * function that stops. Changes are announced by refreshDecorations. */
  follow(m: string, path: string): () => void;
  /** The text the file is compared with (the index's), or undefined when
   * there is none (not under version control, not known yet). */
  original(m: string, path: string): Promise<string | undefined>;
  /** Opens the file's changes in a diff. */
  openChanges?(m: string, path: string): void;
}

let provider: QuickDiffProvider | undefined;

/** Sets the provider; returns the function that removes it. */
export function registerQuickDiff(p: QuickDiffProvider): () => void {
  provider = p;
  refreshDecorations();
  return () => {
    if (provider === p) provider = undefined;
    refreshDecorations();
  };
}

export const quickDiff = () => provider;

/** Lines of the current text that differ: added or changed lines (1-based,
 * start to end inclusive), or removed ones, marked on the line after which
 * they were (0: before the first). */
export type LineChange = { kind: 'added' | 'modified'; start: number; end: number } | { kind: 'deleted'; after: number };

/** The most edits the diff looks for; beyond, the lines between the first
 * and the last difference are one change. */
export const MAX_EDITS = 2000;

const splitLines = (s: string) => (s === '' ? [] : s.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n'));

/** For each line of b, the index of the equal line of a it is matched with,
 * or -1 (Myers' algorithm); undefined beyond maxD edits. */
export function matchLines(a: readonly string[], b: readonly string[], maxD = MAX_EDITS): Int32Array | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // The state before each step d: v over k in [-d-1, d+1].
  const trace: Int32Array[] = [];
  let done = -1;
  for (let d = 0; d <= Math.min(max, maxD) && done < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        done = d;
        break;
      }
    }
  }
  if (done < 0) return undefined;
  const match = new Int32Array(m).fill(-1);
  let x = n;
  let y = m;
  for (let d = done; d > 0; d--) {
    const w = trace[d];
    const at = (k: number) => w[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(prevK);
    const py = px - prevK;
    // The snake after the step, then the step itself.
    const sx = prevK === k + 1 ? px : px + 1;
    while (x > sx && y > sx - k) match[--y] = --x;
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) match[--y] = --x;
  return match;
}

/** The changes of text against base, for the gutter. */
export function lineChanges(base: string, text: string): LineChange[] {
  const a = splitLines(base);
  const b = splitLines(text);
  // The common start and end need no search.
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const am = a.slice(p, a.length - q);
  const bm = b.slice(p, b.length - q);
  const out: LineChange[] = [];
  const hunk = (deleted: number, from: number, to: number) => {
    // from..to: 0-based lines of b, exclusive end.
    if (to > from) out.push({ kind: deleted ? 'modified' : 'added', start: from + 1, end: to });
    else if (deleted) out.push({ kind: 'deleted', after: from });
  };
  const match = matchLines(am, bm);
  if (!match) {
    hunk(am.length, p, p + bm.length);
    return out;
  }
  let i = 0;
  let start = 0;
  for (let j = 0; j <= bm.length; j++) {
    const mi = j < bm.length ? match[j] : am.length;
    if (mi < 0) continue;
    hunk(mi - i, p + start, p + j);
    i = mi + 1;
    start = j + 1;
  }
  return out;
}
