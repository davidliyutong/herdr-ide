// LaTeX formulas in pane text, for the formula shown when the pointer rests
// on one (surface/controller.ts, components/MathPopover.tsx).
//
// Agents write markdown math: $…$ and $$…$$ (Claude), \(…\) and \[…\]
// (GPT models). Their terminal markdown renderers print it as text, and drop
// the backslash before punctuation as markdown escapes: \[ … \] arrives as a
// line holding only "[" … a line holding only "]", \( … \) as ( … ), \, as
// a comma. Both spellings are found. Text that is not a formula but looks
// like one is weeded out by KaTeX, which must parse it before it is shown.

import { reachesEnd, type Cells, type RowText } from './links';

export interface FoundMath {
  start: number;
  end: number;
  /** The formula without its delimiters. */
  tex: string;
  display: boolean;
}

/** Longest formula looked at. */
const MAX_TEX = 4000;
/** Longest ( … ) taken for a formula. */
const MAX_PAREN = 400;
/** What makes $…$ a formula rather than prices or shell variables. */
const TEXISH = /[\\^_{}=]/;
/** A TeX command, which makes ( … ) and [ … ] formulas. */
const COMMAND = /\\[A-Za-z]+/;
const BLANK_LINE = /\n[ \t]*\n/;
const WORD = /[A-Za-z0-9_]/;

/** Formulas in text, in no particular order. A formula does not span an
 * empty line. */
export function findMath(text: string): FoundMath[] {
  const out: FoundMath[] = [];
  const add = (start: number, end: number, tex: string, display: boolean) => {
    const t = tex.trim();
    if (!t || t.length > MAX_TEX || BLANK_LINE.test(tex)) return false;
    if (out.some((m) => start < m.end && end > m.start)) return false;
    out.push({ start, end, tex: t, display });
    return true;
  };
  const escaped = (i: number) => i > 0 && text[i - 1] === '\\';

  // Display formulas first: their delimiters contain the inline ones'.
  for (const m of text.matchAll(/\$\$([\s\S]+?)\$\$/g)) if (!escaped(m.index)) add(m.index, m.index + m[0].length, m[1], true);
  for (const m of text.matchAll(/\\\[([\s\S]+?)\\\]/g)) add(m.index, m.index + m[0].length, m[1], true);
  // \[ and \] that lost their backslashes, each alone on its line.
  for (const m of text.matchAll(/(?<=^|\n)[ \t]*\[[ \t]*\n([\s\S]+?)\n[ \t]*\][ \t]*(?=\n|$)/g))
    if (COMMAND.test(m[1])) add(m.index, m.index + m[0].length, m[1], true);
  for (const m of text.matchAll(/\\\(([\s\S]+?)\\\)/g)) add(m.index, m.index + m[0].length, m[1], false);

  // $…$: the $ opening it is followed by a non-space, the one closing it
  // follows a non-space and is not followed by a digit (pandoc's rule).
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '$' || escaped(i) || text[i + 1] === '$' || text[i - 1] === '$' || !text[i + 1]?.trim()) continue;
    for (let j = i + 2; j < text.length && j - i <= MAX_TEX; j++) {
      if (text[j] !== '$' || escaped(j)) continue;
      if (text[j + 1] === '$' || !text[j - 1].trim() || /\d/.test(text[j + 1] ?? '')) break;
      const tex = text.slice(i + 1, j);
      if (TEXISH.test(tex) && add(i, j + 1, tex, false)) i = j;
      break;
    }
  }

  // \( … \) that lost its backslashes: parentheses not after a word (a call)
  // around a TeX command.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '(' || WORD.test(text[i - 1] ?? '')) continue;
    let depth = 0;
    for (let j = i; j < text.length && j - i <= MAX_PAREN; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')' && --depth === 0) {
        const tex = text.slice(i + 1, j);
        if (COMMAND.test(tex)) add(i, j + 1, tex, false);
        break;
      }
    }
  }
  return out;
}

export interface WrappedMath {
  tex: string;
  display: boolean;
  /** Per row, in order, without the spaces around the text. */
  cells: Cells[];
}

/** Rows looked at above and below the row searched. */
const AROUND_ROWS = 40;

/** Formulas on row y of a pane whose rows are top to bottom (exclusive),
 * with the cells they cover. The rows searched are the paragraph around y:
 * the rows between empty ones, so a $$ is never paired with one of another
 * paragraph. Rows whose text reaches the last column go on in the next row
 * after its indentation, as for links; other rows are separate lines. */
export function mathAround(y: number, top: number, bottom: number, row: (y: number) => RowText): WrappedMath[] {
  const rows = new Map<number, RowText>();
  const at = (r: number) => {
    let v = rows.get(r);
    if (!v) rows.set(r, (v = row(r)));
    return v;
  };
  const blank = (r: number) => !at(r).text.trim();
  if (blank(y)) return [];
  let a = y;
  while (a > top && y - a < AROUND_ROWS && !blank(a - 1)) a--;
  let b = y;
  while (b + 1 < bottom && b - y < AROUND_ROWS && !blank(b + 1)) b++;
  let text = '';
  // The cell of each character of text; undefined for the line breaks.
  const cellOf: Array<Cells | undefined> = [];
  for (let r = a; r <= b; r++) {
    const { text: t, colOf } = at(r);
    let start = 0;
    if (r > a) {
      if (reachesEnd(at(r - 1))) start = t.length - t.trimStart().length;
      else {
        text += '\n';
        cellOf.push(undefined);
      }
    }
    const end = t.trimEnd().length;
    for (let i = start; i < end; i++) cellOf.push({ y: r, from: colOf[i], to: colOf[i + 1] });
    text += t.slice(start, end);
  }
  const out: WrappedMath[] = [];
  for (const m of findMath(text)) {
    const cells: Cells[] = [];
    for (let i = m.start; i < m.end; i++) {
      const c = cellOf[i];
      if (!c || !text[i].trim()) continue;
      const last = cells[cells.length - 1];
      if (last?.y === c.y) last.to = Math.max(last.to, c.to);
      else cells.push({ ...c });
    }
    if (cells.some((c) => c.y === y)) out.push({ tex: m.tex, display: m.display, cells });
  }
  return out;
}

/** The formula of a pane under cell (x, y). */
export function mathAt(x: number, y: number, top: number, bottom: number, row: (y: number) => RowText): WrappedMath | undefined {
  return mathAround(y, top, bottom, row).find((m) => m.cells.some((c) => c.y === y && x >= c.from && x < c.to));
}
