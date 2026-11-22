// The changes of an agent's edit, as the conversation view draws them: a
// unified diff of a file's text before and after (an ACP v1 diff), by the
// longest common subsequence of their lines, or a patch's lines (v2, and a
// diff that has only a patch) by their first character. The comparison
// takes time and memory of the product of the lines compared: a tool call's
// row counts the lines added and removed only within a budget (diffStat),
// the diff itself is made when the call is opened.

export type DiffOp = ' ' | '+' | '-';

export interface DiffLine {
  op: DiffOp;
  text: string;
}

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** The lines were compared one by one; false when what differs was too
   * long (MAX_DIFF_LINES), and the diff is its lines before, removed, and
   * after, added. */
  exact: boolean;
}

/** The most lines of each side the diff compares (after the lines both
 * sides start and end with): the comparison takes time and memory of the
 * product of the two. */
export const MAX_DIFF_LINES = 2000;

/** A text's lines, without the empty one after a final newline. */
export function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The lines of a and b as removed, added and kept, by the longest common
 * subsequence (a table of its lengths from each pair of positions on). */
function lcs(a: readonly string[], b: readonly string[], out: DiffLine[]) {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const len = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * w + j] = a[i] === b[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] });
      i++;
      j++;
    } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
}

/** The lines of a text before (none: a new file) and after, and how many
 * lines both start and end with. */
function sides(oldText: string | null | undefined, newText: string) {
  const a = splitLines(oldText ?? '');
  const b = splitLines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { a, b, pre, suf };
}

/** The diff of a text before (none: a new file) and after. */
export function lineDiff(oldText: string | null | undefined, newText: string): LineDiff {
  const { a, b, pre, suf } = sides(oldText, newText);
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const lines: DiffLine[] = [];
  for (let i = 0; i < pre; i++) lines.push({ op: ' ', text: a[i] });
  const exact = am.length <= MAX_DIFF_LINES && bm.length <= MAX_DIFF_LINES;
  if (exact) lcs(am, bm, lines);
  else {
    for (const text of am) lines.push({ op: '-', text });
    for (const text of bm) lines.push({ op: '+', text });
  }
  for (let i = a.length - suf; i < a.length; i++) lines.push({ op: ' ', text: a[i] });
  return { lines, added: count(lines, '+'), removed: count(lines, '-'), exact };
}

function count(lines: readonly DiffLine[], op: DiffOp): number {
  let n = 0;
  for (const l of lines) if (l.op === op) n++;
  return n;
}

/** The length of the longest common subsequence of a[from, a.length - to)
 * and b[from, b.length - to), a row of the table at a time. */
function lcsLength(a: readonly string[], b: readonly string[], from: number, to: number): number {
  const n = a.length - from - to;
  const m = b.length - from - to;
  let prev = new Uint16Array(m + 1);
  let row = new Uint16Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    const x = a[from + i];
    for (let j = m - 1; j >= 0; j--) row[j] = x === b[from + j] ? prev[j + 1] + 1 : Math.max(prev[j], row[j + 1]);
    [prev, row] = [row, prev];
  }
  return prev[0];
}

/** The lines a diff of the texts adds and removes, as lineDiff counts
 * them, when comparing what differs takes at most cells pairs of lines;
 * undefined when it would take more. */
export function diffStat(
  oldText: string | null | undefined,
  newText: string,
  cells: number,
): { added: number; removed: number } | undefined {
  const { a, b, pre, suf } = sides(oldText, newText);
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  // Nothing to compare, or too long to (lineDiff takes what differs as
  // removed, then added).
  if (!n || !m || n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) return { added: m, removed: n };
  if (n * m > cells) return undefined;
  const same = lcsLength(a, b, pre, suf);
  return { added: m - same, removed: n - same };
}

/** A line of a diff as drawn, or a run of unchanged lines left out. */
export type DiffRow = DiffLine | { op: 'skip'; count: number };

/** The changed lines with up to context unchanged lines around each run of
 * them; the other unchanged lines are runs left out. */
export function hunks(lines: readonly DiffLine[], context = 3): DiffRow[] {
  const keep = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].op === ' ') continue;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = 1;
  }
  const out: DiffRow[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (skipped) out.push({ op: 'skip', count: skipped });
      skipped = 0;
      out.push(lines[i]);
    } else skipped++;
  }
  if (skipped && out.length) out.push({ op: 'skip', count: skipped });
  return out;
}

/** What a line of a patch is: added, removed, a hunk's header, a file's
 * header (or other lines about the patch) or context. */
export type PatchKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

export interface PatchLine {
  kind: PatchKind;
  text: string;
  /** The line's first character marks it (+, - or a space) rather than
   * being its text: a line of a hunk, or one apply_patch adds outside one. */
  marked: boolean;
}

export interface Patch {
  lines: PatchLine[];
  added: number;
  removed: number;
  /** The files it changes, in order. */
  paths: string[];
}

// A file's header in git's format ("diff --git", "--- a/x", "+++ b/x",
// "index", modes, renames) or in the agents' apply_patch format ("*** Begin
// Patch", "*** Update File: x").
const HEADER =
  /^(?:diff |index |--- |\+\+\+ |\*\*\* |new file|deleted file|old mode|new mode|similarity|dissimilarity|rename |copy |Binary files)/;
const FILE = /^(?:\+\+\+ (?:b\/)?|\*\*\* (?:Update|Add|Delete) File: |\*\*\* Move to: )(.+)$/;

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** A patch's lines by what they are. In a hunk (after "@@", for as many
 * lines as its header counts, or up to a header when it counts none) a line
 * is what its first character says; outside one, a header line is the
 * file's, and lines starting with + or - are a file's (apply_patch adds
 * files so). */
export function patchLines(text: string): Patch {
  const lines: PatchLine[] = [];
  const paths: string[] = [];
  let added = 0;
  let removed = 0;
  let inHunk = false;
  // The lines of each side the hunk has still; -1 when it does not say.
  let oldLeft = -1;
  let newLeft = -1;
  for (const line of splitLines(text)) {
    let kind: PatchKind;
    let marked = false;
    if (line.startsWith('@@')) {
      kind = 'hunk';
      inHunk = true;
      const m = HUNK.exec(line);
      oldLeft = m ? Number(m[1] ?? 1) : -1;
      newLeft = m ? Number(m[2] ?? 1) : -1;
    } else if (inHunk && (line[0] === '+' || line[0] === '-' || line[0] === ' ' || line === '')) {
      kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
      marked = true;
      if (oldLeft >= 0) {
        if (kind !== 'add') oldLeft--;
        if (kind !== 'del') newLeft--;
        if (oldLeft <= 0 && newLeft <= 0) inHunk = false;
      }
    } else if (line.startsWith('\\')) {
      kind = 'meta';
    } else if (HEADER.test(line)) {
      kind = 'meta';
      inHunk = false;
      const file = FILE.exec(line)?.[1]?.trim();
      if (file && file !== '/dev/null' && !paths.includes(file)) paths.push(file);
    } else if (line[0] === '+' || line[0] === '-') {
      kind = line[0] === '+' ? 'add' : 'del';
      marked = true;
    } else kind = 'ctx';
    if (kind === 'add') added++;
    else if (kind === 'del') removed++;
    lines.push({ kind, text: line, marked });
  }
  return { lines, added, removed, paths };
}
