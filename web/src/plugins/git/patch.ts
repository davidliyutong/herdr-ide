// Patches of selected ranges (the diff pane's Stage, Unstage and Discard
// Selected Ranges): a unified diff that git apply takes, made from the
// diff editor's line changes that the selection touches.
//
// A diff shows `original` (left) and `modified` (right). Forward, the
// patch turns the original into the original with the selected changes
// made (staging: the original is the index, the patch goes into it with
// --cached). Backward, the patch turns the modified side into the
// modified side with the selected changes undone (unstaging: the modified
// side is the index; discarding: it is the working tree). The context
// lines come from the side the patch applies to, so it applies however
// the rest of the file differs.
//
// The selection is in lines of one side. Forward from the modified side,
// a change is cut to the selected lines of it (as VS Code does: all its
// original lines go, the selected new lines come); otherwise a change the
// selection touches is taken whole.

/** A change of Monaco's diff editor (ILineChange): line numbers from 1;
 * an end of 0 is an empty range after the start line. */
export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

/** Lines startLine…endLine (from 1, inclusive) of one side. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

export type Side = 'original' | 'modified';
export type Direction = 'forward' | 'backward';

/** The context lines around a hunk, as git diff writes. */
export const CONTEXT = 3;

interface Line {
  text: string;
  /** False for a last line without a newline. */
  nl: boolean;
}

function lines(s: string): Line[] {
  if (s === '') return [];
  const parts = s.split('\n');
  const out: Line[] = parts.map((text) => ({ text, nl: true }));
  if (parts[parts.length - 1] === '') out.pop();
  else out[out.length - 1].nl = false;
  return out;
}

/** A change as half-open ranges of lines from 0. */
interface Span {
  o: [number, number];
  m: [number, number];
}

function spanOf(c: LineChange): Span {
  const o: [number, number] =
    c.originalEndLineNumber === 0
      ? [c.originalStartLineNumber, c.originalStartLineNumber]
      : [c.originalStartLineNumber - 1, c.originalEndLineNumber];
  const m: [number, number] =
    c.modifiedEndLineNumber === 0
      ? [c.modifiedStartLineNumber, c.modifiedStartLineNumber]
      : [c.modifiedStartLineNumber - 1, c.modifiedEndLineNumber];
  return { o, m };
}

/** Whether lines [s, e) (from 0) touch a selected range; an empty range
 * (a place between lines) touches the lines on both sides of it. */
function touches([s, e]: [number, number], r: LineRange): boolean {
  const a = r.startLine - 1;
  const b = r.endLine; // exclusive
  if (s === e) return a <= s && b >= s;
  return a < e && b > s;
}

/** The changes the selection touches, cut to it when it is forward from
 * the modified side. */
export function selectChanges(changes: LineChange[], ranges: LineRange[], side: Side, direction: Direction): Span[] {
  const out: Span[] = [];
  for (const c of changes) {
    const sp = spanOf(c);
    const own = side === 'original' ? sp.o : sp.m;
    const hit = ranges.filter((r) => touches(own, r));
    if (!hit.length) continue;
    if (side === 'modified' && direction === 'forward' && sp.m[0] < sp.m[1]) {
      // The selected new lines of it; the original lines all go.
      let s = Infinity;
      let e = -Infinity;
      for (const r of hit) {
        s = Math.min(s, Math.max(sp.m[0], r.startLine - 1));
        e = Math.max(e, Math.min(sp.m[1], r.endLine));
      }
      if (s < e) out.push({ o: sp.o, m: [s, e] });
      else if (sp.o[0] < sp.o[1]) out.push({ o: sp.o, m: [sp.m[0], sp.m[0]] });
      continue;
    }
    out.push(sp);
  }
  return out;
}

/** Quotes a path for a patch's header as git does when it has to. */
export function quotePath(p: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/["\\\x00-\x1f\x7f]/.test(p)) return p;
  const esc: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\t': '\\t', '\r': '\\r' };
  return (
    '"' +
    [...p]
      .map((ch) => {
        if (esc[ch]) return esc[ch];
        const c = ch.charCodeAt(0);
        return c < 0x20 || c === 0x7f ? '\\' + c.toString(8).padStart(3, '0') : ch;
      })
      .join('') +
    '"'
  );
}

/** An edit of the base: lines [s, e) become `put`. */
interface Edit {
  s: number;
  e: number;
  put: Line[];
  /** Whether the file ends with a newline after an edit at its end. */
  end?: boolean;
}

/**
 * The patch for the changes the ranges select, undefined when they
 * select none (see the file's comment).
 */
export function rangePatch(
  path: string,
  original: string,
  modified: string,
  changes: LineChange[],
  ranges: LineRange[],
  side: Side,
  direction: Direction,
): string | undefined {
  const spans = selectChanges(changes, ranges, side, direction);
  if (!spans.length) return undefined;
  const o = lines(original);
  const m = lines(modified);
  const forward = direction === 'forward';
  const base = forward ? o : m;
  const other = forward ? m : o;
  const n = base.length;
  const edits: Edit[] = spans
    .map((sp) => {
      // Monaco counts a line after a final newline: ranges may reach one
      // past the lines here.
      const [s, e] = (forward ? sp.o : sp.m).map((x) => Math.min(x, n));
      const [ps, pe] = (forward ? sp.m : sp.o).map((x) => Math.min(x, other.length));
      const put = other.slice(ps, pe).map((l) => ({ ...l }));
      // An edit that reaches the end of both sides ends the file as the
      // other side does (with or without a newline).
      const end = e === n && pe === other.length ? (other.length ? other[other.length - 1].nl : true) : undefined;
      return { s, e, put, end };
    })
    .sort((a, b) => a.s - b.s);
  return buildPatch(path, base, edits);
}

function buildPatch(path: string, base: Line[], edits: Edit[]): string | undefined {
  const n = base.length;
  for (const ed of edits) {
    // Lines put before the end of the file end with a newline; at the end
    // the last one keeps its own (from the other side).
    for (let i = 0; i < ed.put.length; i++) if (ed.e < n || i < ed.put.length - 1) ed.put[i].nl = true;
    // Lines added after a last line without a newline: that line gets one,
    // so it is replaced too.
    if (ed.s === n && n > 0 && !base[n - 1].nl && ed.put.length) {
      ed.s = n - 1;
      ed.put.unshift({ text: base[n - 1].text, nl: true });
    }
    // Nothing put at the end: the line before the edit becomes the last
    // one; it is replaced when its newline must change.
    if (ed.end !== undefined && !ed.put.length && ed.s > 0 && base[ed.s - 1].nl !== ed.end) {
      ed.s--;
      ed.put = [{ text: base[ed.s].text, nl: ed.end }];
    }
  }
  const real = edits.filter((ed) => ed.e > ed.s || ed.put.length);
  if (!real.length) return undefined;
  // Hunks: edits whose context overlaps go together.
  const groups: Edit[][] = [];
  for (const ed of real) {
    const g = groups[groups.length - 1];
    if (g && ed.s - g[g.length - 1].e <= 2 * CONTEXT) g.push(ed);
    else groups.push([ed]);
  }
  const q = quotePath(path);
  const aName = q.startsWith('"') ? `"a/${q.slice(1)}` : `a/${q}`;
  const bName = q.startsWith('"') ? `"b/${q.slice(1)}` : `b/${q}`;
  let out = `diff --git ${aName} ${bName}\n--- ${aName}\n+++ ${bName}\n`;
  let delta = 0;
  for (const g of groups) {
    const start = Math.max(0, g[0].s - CONTEXT);
    const end = Math.min(n, g[g.length - 1].e + CONTEXT);
    const body: string[] = [];
    const emit = (prefix: string, l: Line) => {
      body.push(prefix + l.text + '\n');
      if (!l.nl) body.push('\\ No newline at end of file\n');
    };
    let at = start;
    let oldCount = 0;
    let newCount = 0;
    for (const ed of g) {
      for (; at < ed.s; at++, oldCount++, newCount++) emit(' ', base[at]);
      for (; at < ed.e; at++, oldCount++) emit('-', base[at]);
      for (const l of ed.put) {
        emit('+', l);
        newCount++;
      }
    }
    for (; at < end; at++, oldCount++, newCount++) emit(' ', base[at]);
    const oldStart = oldCount ? start + 1 : start;
    const newStart = newCount ? start + delta + 1 : start + delta;
    out += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n` + body.join('');
    delta += newCount - oldCount;
  }
  return out;
}
