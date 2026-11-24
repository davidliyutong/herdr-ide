// Files whose lines end in more than one way (LF and CRLF, or a lone CR).
// Monaco gives a model one kind of line ending: text shown in an editor or
// a diff comes back with every line ending alike, so saving it would
// rewrite every ending of such a file, and patches made of it would not
// match the file's lines. The setting git.mixedLineEndings says what the
// file explorer's editor and Git's diffs do with such a file: keep each
// line's own ending (restoreEols: the endings of the text as loaded come
// back after a line diff of it against the edited text; new lines take a
// neighbour's), unify them as Monaco does, or open it read-only.

import { useSettings, settingValue } from './settings';

export type Eol = '\n' | '\r\n' | '\r' | '';

export type MixedLineEndings = 'keep' | 'unify' | 'readOnly';

/** The setting (backend/features/git). */
export const MIXED_LINE_ENDINGS = 'git.mixedLineEndings';

const asMode = (v: unknown): MixedLineEndings => (v === 'unify' || v === 'readOnly' ? v : 'keep');

/** The setting's value now. */
export function mixedLineEndings(): MixedLineEndings {
  return asMode(settingValue(MIXED_LINE_ENDINGS));
}

/** The setting's value, followed. */
export function useMixedLineEndings(): MixedLineEndings {
  return asMode(useSettings((s) => s.values[MIXED_LINE_ENDINGS]?.value));
}

export interface SplitText {
  /** The lines without their endings. */
  lines: string[];
  /** Each line's ending; the last line's is ''. */
  eols: Eol[];
}

/** Lines as Monaco reads them: ended by CRLF, LF or a lone CR. Text that
 * ends with an ending has an empty last line. */
export function splitLines(s: string): SplitText {
  const lines: string[] = [];
  const eols: Eol[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) {
      lines.push(s.slice(start, i));
      eols.push('\n');
      start = i + 1;
    } else if (c === 13) {
      lines.push(s.slice(start, i));
      if (s.charCodeAt(i + 1) === 10) {
        eols.push('\r\n');
        i++;
      } else eols.push('\r');
      start = i + 1;
    }
  }
  lines.push(s.slice(start));
  eols.push('');
  return { lines, eols };
}

/** How many lines end each way. */
export function eolCounts(s: string): { lf: number; crlf: number; cr: number } {
  const n = { lf: 0, crlf: 0, cr: 0 };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) n.lf++;
    else if (c === 13) {
      if (s.charCodeAt(i + 1) === 10) {
        n.crlf++;
        i++;
      } else n.cr++;
    }
  }
  return n;
}

/** Whether lines of s end in more than one way. */
export function isMixed(s: string): boolean {
  const n = eolCounts(s);
  return (n.lf > 0 ? 1 : 0) + (n.crlf > 0 ? 1 : 0) + (n.cr > 0 ? 1 : 0) > 1;
}

/** Whether s has a CR that is not before an LF: a line break for Monaco,
 * none for git, whose lines end with LF. */
export function hasLoneCR(s: string): boolean {
  return eolCounts(s).cr > 0;
}

/** The ending most lines of s have (LF when it has none). */
export function dominantEol(s: string): Eol {
  const n = eolCounts(s);
  if (n.crlf > n.lf && n.crlf >= n.cr) return '\r\n';
  if (n.cr > n.lf && n.cr > n.crlf) return '\r';
  return '\n';
}

/** The ending Monaco gives every line of a model of s: CRLF when more
 * than half the endings have a CR, else LF. */
export function unifiedEol(s: string): '\n' | '\r\n' {
  const n = eolCounts(s);
  return n.cr + n.crlf > (n.cr + n.crlf + n.lf) / 2 ? '\r\n' : '\n';
}

/** An ending's name (LF, CRLF, CR). */
export const eolName = (e: Eol) => (e === '\r\n' ? 'CRLF' : e === '\r' ? 'CR' : 'LF');

/** The most edits a line diff looks for before it takes the rest as one
 * change (its time and memory grow with their square). */
export const MAX_EDITS = 1000;

/** A run of lines that differ: a[a0, a1) became b[b0, b1). */
export type Hunk = [a0: number, a1: number, b0: number, b1: number];

/** The runs of lines that differ between a and b (Myers' diff, after the
 * lines both start and end with); past maxEdits, what is between the
 * common start and end is one run. */
export function diffLines(a: readonly string[], b: readonly string[], maxEdits = MAX_EDITS): Hunk[] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  if (s === ea && s === eb) return [];
  if (s === ea || s === eb) return [[s, ea, s, eb]];
  const matches = myers(a.slice(s, ea), b.slice(s, eb), maxEdits);
  if (!matches) return [[s, ea, s, eb]];
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  for (const [x, y] of [...matches, [ea - s, eb - s] as [number, number]]) {
    if (x > i || y > j) out.push([s + i, s + x, s + j, s + y]);
    i = x + 1;
    j = y + 1;
  }
  return out;
}

/** The pairs of equal lines of Myers' shortest edit script, in order;
 * undefined when it needs more than maxEdits edits. */
function myers(a: readonly string[], b: readonly string[], maxEdits: number): Array<[number, number]> | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d]: v[-d..d] after step d.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) return undefined;
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    // After the edit, the snake to (x, y) is equal lines.
    const sx = down ? px : px + 1;
    const sy = down ? py + 1 : py;
    while (x > sx && y > sy) pairs.push([--x, --y]);
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) pairs.push([--x, --y]);
  return pairs.reverse();
}

/**
 * The edited text (as Monaco gives it back, with one kind of ending) with
 * the endings of the original's lines where they were kept: a line diff
 * of the original against the edited text pairs their equal lines, and a
 * changed line takes the ending of the line it replaced; a new line takes
 * the ending of the line before it (else of the line after the change,
 * else the original's most common). A last line without an ending stays
 * without one. Text that does not mix endings comes back as edited.
 */
export function restoreEols(original: string, edited: string): string {
  if (!isMixed(original)) return edited;
  const o = splitLines(original);
  const e = splitLines(edited);
  const fallback = dominantEol(original);
  const out: Eol[] = new Array(e.lines.length);
  // The ending of an edited line: none for the last one without; else
  // its own from the original, else a neighbour's.
  const pick = (j: number, own: Eol, next: Eol): Eol => {
    if (e.eols[j] === '') return '';
    if (own) return own;
    const before = j > 0 ? out[j - 1] : '';
    return before || next || fallback;
  };
  let i = 0;
  let j = 0;
  for (const [a0, a1, b0, b1] of [
    ...diffLines(o.lines, e.lines),
    [o.lines.length, o.lines.length, e.lines.length, e.lines.length] as Hunk,
  ]) {
    // Equal lines before the change.
    for (; j < b0; i++, j++) out[j] = pick(j, o.eols[i], o.eols[a0] ?? '');
    for (let k = 0; b0 + k < b1; k++) out[b0 + k] = pick(b0 + k, a0 + k < a1 ? o.eols[a0 + k] : '', o.eols[a1] ?? '');
    i = a1;
    j = b1;
  }
  let s = '';
  for (let k = 0; k < e.lines.length; k++) s += e.lines[k] + out[k];
  return s;
}
