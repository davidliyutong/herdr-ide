// The browser's copy of the surface grid: complete surfaces replace it,
// patches move rows (scrolling) and overwrite spans. Rows that changed are
// marked dirty for the painter, and row moves are kept for it as well: it
// copies the pixels of moved rows instead of painting them again.

import type { Cell, Cursor, Move, SurfaceUpdate } from './protocol';
import { symbolWidth } from './width';

export const blankCell: Cell = Object.freeze({ symbol: ' ', fg: 0, bg: 0, mod: 0, skip: false, link: -1 }) as Cell;

export class Grid {
  w = 0;
  h = 0;
  gen = -1;
  cells: Cell[] = [];
  cursor?: Cursor;
  dirty = new Set<number>();
  /** Row moves since the last paint, in order. Rows outside `dirty` hold
   * their painted pixels at their place before these moves. */
  moves: Move[] = [];
  /** Whether a complete surface arrived for the current generation. */
  ready = false;

  /** Applies an update; false when it belongs to another generation or
   * arrives before the first complete surface. */
  apply(u: SurfaceUpdate): boolean {
    if (u.full) {
      this.gen = u.gen;
      this.w = u.w;
      this.h = u.h;
      this.cells = new Array(u.w * u.h).fill(blankCell);
      this.ready = true;
      this.invalidate();
    } else if (!this.ready || u.gen !== this.gen) {
      return false;
    }
    // Before the moves, which carry the old cursor's pixels along.
    if (this.cursor) this.dirty.add(this.cursor.y);
    for (const m of u.moves) this.move(m);
    for (const s of u.spans) {
      if (s.y >= this.h || s.x + s.cells.length > this.w) continue;
      const at = s.y * this.w + s.x;
      for (let i = 0; i < s.cells.length; i++) this.cells[at + i] = s.cells[i];
      this.dirty.add(s.y);
    }
    this.cursor = u.cursor;
    if (u.cursor) this.dirty.add(u.cursor.y);
    return true;
  }

  /** Moves rows inside a region with herdr's swap order
   * (src/protocol/surface_scroll.rs), so both sides agree. The painter
   * moves the painted rows the same way; rows still to paint take their
   * stale pixels along (both places stay dirty), and the rows the move
   * vacates are dirty. */
  move(m: Move) {
    const { x, y, w, h } = m.rect;
    if (!m.shift || Math.abs(m.shift) >= h || x + w > this.w || y + h > this.h) return;
    const start = (r: number) => (y + r) * this.w + x;
    const swap = (a: number, b: number) => {
      const pa = start(a);
      const pb = start(b);
      for (let i = 0; i < w; i++) {
        const t = this.cells[pa + i];
        this.cells[pa + i] = this.cells[pb + i];
        this.cells[pb + i] = t;
      }
    };
    const d = Math.abs(m.shift);
    if (m.shift > 0) for (let r = 0; r < h - d; r++) swap(r, r + d);
    else for (let r = h - 1; r >= d; r--) swap(r, r - d);
    for (const r of [...this.dirty]) if (r >= y && r < y + h && r - m.shift >= y && r - m.shift < y + h) this.dirty.add(r - m.shift);
    const vacated = m.shift > 0 ? y + h - d : y;
    for (let r = 0; r < d; r++) this.dirty.add(vacated + r);
    this.moves.push(m);
  }

  cell(x: number, y: number): Cell {
    return this.cells[y * this.w + x] ?? blankCell;
  }

  /** Columns the cell at (x, y) takes, as herdr's renderer counts them:
   * its symbol's width, and two when the next cell is the empty spacer
   * that follows a wide character. */
  width(x: number, y: number): number {
    const c = this.cell(x, y);
    const w = symbolWidth(c.symbol || ' ');
    if (w > 1 || !c.symbol || x + 1 >= this.w) return w;
    return this.cell(x + 1, y).symbol === '' ? 2 : w;
  }

  /** The text of columns [x0, x1) of row y, and the column of each UTF-16
   * code unit (plus one past the end). The cells a wide character covers
   * after its first, and skipped cells, contribute nothing. */
  rowText(y: number, x0 = 0, x1 = this.w): { text: string; colOf: number[] } {
    let text = '';
    const colOf: number[] = [];
    let cover = 0;
    for (let x = x0; x < x1; x++) {
      const c = this.cell(x, y);
      if (cover > 0) {
        cover--;
        continue;
      }
      if (c.skip) continue;
      const s = c.symbol || ' ';
      for (let i = 0; i < s.length; i++) colOf.push(x);
      text += s;
      cover = this.width(x, y) - 1;
    }
    colOf.push(x1);
    return { text, colOf };
  }

  /** Every row needs painting (moves are then of no use). */
  invalidate() {
    for (let y = 0; y < this.h; y++) this.dirty.add(y);
    this.moves = [];
  }
}
