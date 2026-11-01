// Text selections in a pane, kept in herdr's absolute rows (row 0 is the
// oldest line kept), so a selection survives scrolling and can be longer than
// the pane: a drag held past the top or bottom edge scrolls the pane with
// pane.scroll, as herdr's own client does, and the text is read from herdr
// with pane.selection.read on release. A selection never leaves its pane.

import type { Grid } from './grid';
import type { ScrollInfo, SurfacePane } from './protocol';

/** A boundary between cells: a row and a column from 0 to cols. */
export interface Point {
  row: number;
  col: number;
}

/** Absolute row of the first visible row. */
export const viewTop = (s: ScrollInfo | undefined) => (s ? s.max_offset_from_bottom - s.offset_from_bottom : 0);

/** The cells [start, end) between two points, counted as row * cols + col. */
export function span(a: Point, b: Point, cols: number): [number, number] {
  const p = a.row * cols + a.col;
  const q = b.row * cols + b.col;
  return p <= q ? [p, q] : [q, p];
}

/** pane.selection.read's anchor and cursor (both cells included) for a
 * selection, or undefined when it is empty. */
export function readRange(a: Point, b: Point, cols: number) {
  const [s, e] = span(a, b, cols);
  if (e <= s) return undefined;
  const cell = (p: number) => ({ row: Math.floor(p / cols), col: p % cols });
  return { anchor: cell(s), cursor: cell(e - 1) };
}

/** Lines per scroll step with the pointer `px` pixels past the edge: one at
 * the edge, faster further away. */
export function stepLines(px: number, cellHeight: number): number {
  return Math.min(15, 1 + Math.floor(px / Math.max(1, cellHeight)));
}

export class Selection {
  anchor: Point;
  cursor: Point;
  /** Its text once read; `reading` while the read is in flight. */
  text?: string;
  reading?: Promise<string | undefined>;

  constructor(
    readonly pane: string,
    readonly cols: number,
    at: Point,
  ) {
    this.anchor = { ...at };
    this.cursor = { ...at };
  }

  get empty(): boolean {
    const [s, e] = span(this.anchor, this.cursor, this.cols);
    return e <= s;
  }

  /** Surface columns [from, to) highlighted in surface row y. */
  columns(p: SurfacePane, y: number): [number, number] | undefined {
    if (p.id !== this.pane || p.inner.w !== this.cols || y < p.inner.y || y >= p.inner.y + p.inner.h) return;
    const abs = viewTop(p.scroll) + (y - p.inner.y);
    const [s, e] = span(this.anchor, this.cursor, this.cols);
    const row = abs * this.cols;
    const lo = Math.max(s, row);
    const hi = Math.min(e, row + this.cols);
    if (hi <= lo) return;
    return [p.inner.x + lo - row, p.inner.x + hi - row];
  }

  /** The visible part's text from the grid (rows trimmed, joined with
   * newlines): the copy before herdr's text arrived, or without it. */
  visibleText(p: SurfacePane, g: Grid): string {
    const lines: string[] = [];
    for (let y = p.inner.y; y < p.inner.y + p.inner.h; y++) {
      const c = this.columns(p, y);
      if (!c) continue;
      lines.push(g.rowText(y, c[0], c[1]).text.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }

  /** Reads the whole text from herdr. */
  read(p: SurfacePane, api: <T>(method: string, params: Record<string, unknown>) => Promise<T>) {
    const s = p.scroll;
    const last = s ? s.max_offset_from_bottom + s.viewport_rows - 1 : p.inner.h - 1;
    // Rows past the last one are refused; clamp to the text herdr has.
    const clamp = (q: Point): Point => (q.row > last ? { row: last, col: this.cols } : q);
    const range = readRange(clamp(this.anchor), clamp(this.cursor), this.cols);
    if (!range) return;
    const reading = api<{ text?: string }>('pane.selection.read', { pane_id: this.pane, ...range })
      .then((res) => res.text)
      .catch(() => undefined);
    this.reading = reading;
    void reading.then((text) => {
      if (this.reading === reading) this.text = text;
    });
  }
}

/** Word boundaries around column col of a row's text: [start, end) columns. */
export function wordAt(g: Grid, y: number, x0: number, x1: number, col: number): [number, number] {
  const isWord = (x: number) => {
    const s = g.cell(x, y).symbol;
    return !!s && s !== ' ' && !/^[\s"'`()[\]{}<>|,;]$/.test(s);
  };
  if (!isWord(col)) return [col, col + 1];
  let a = col;
  let b = col + 1;
  while (a > x0 && isWord(a - 1)) a--;
  while (b < x1 && isWord(b)) b++;
  return [a, b];
}
