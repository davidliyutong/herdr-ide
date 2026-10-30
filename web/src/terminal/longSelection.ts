// Selections longer than the pane: a selection drag held past the top or
// bottom edge of a pane scrolls it.
//
// xterm.js keeps no scrollback (herdr owns it), so its own selection covers
// the visible rows only. When a selection drag leaves the top or bottom of
// the pane and herdr has scrollback in that direction, LongSelection takes
// the drag over from xterm.js, as herdr's own client does: the pane is
// scrolled with pane.scroll (an absolute offset; the reply has the new
// position), the selection is kept in herdr's absolute rows (row 0 is the
// oldest line kept), xterm.js only paints the visible part, and the text is
// read from herdr with pane.selection.read when the button is released.

import type { Terminal } from '@xterm/xterm';

export interface ScrollInfo {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

/** A boundary between cells: a row and a column from 0 to cols. */
export interface Point {
  row: number;
  col: number;
}

/** Absolute row of the first visible row. */
export const viewTop = (s: ScrollInfo) => s.max_offset_from_bottom - s.offset_from_bottom;

/** The cells [start, end) between two points, counted as row * cols + col. */
export function span(a: Point, b: Point, cols: number): [number, number] {
  const p = a.row * cols + a.col;
  const q = b.row * cols + b.col;
  return p <= q ? [p, q] : [q, p];
}

/** The visible part of a selection as xterm.js's select(col, row, length),
 * or undefined when none of it is visible. */
export function visiblePart(a: Point, b: Point, cols: number, rows: number, top: number) {
  const [s, e] = span(a, b, cols);
  const lo = Math.max(s, top * cols);
  const hi = Math.min(e, (top + rows) * cols);
  if (hi <= lo) return undefined;
  const rel = lo - top * cols;
  return { col: rel % cols, row: Math.floor(rel / cols), length: hi - lo };
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

// xterm.js makes Alt-drag a column selection except on macOS, where Option
// forces a normal selection (macOptionClickForcesSelection).
const isMac = typeof navigator !== 'undefined' && /^Mac/.test(navigator.platform);

export interface LongSelectionHost {
  term: Terminal;
  pane: string;
  /** Box of the xterm.js screen. */
  screen(): DOMRect | undefined;
  /** Whether this browser may scroll the pane (it controls the pane). */
  canScroll(): boolean;
  api<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

interface PaneInfoReply {
  pane?: { scroll?: ScrollInfo | null };
}

/** Pause between scroll steps while the pointer stays past an edge. */
export const STEP_MS = 40;
/** Wait after scrolling or typing before the shown selection is moved along. */
const SETTLE_MS = 150;

export class LongSelection {
  /** The drag in progress: its anchor in visible rows, the last pointer
   * position, whether the scroll position was asked for since the pointer
   * left the pane, and whether the drag was taken over. */
  private drag?: { anchor: Point; x: number; y: number; probed: boolean; taken: boolean };
  private info?: ScrollInfo;
  /** A taken-over selection in absolute rows. */
  private sel?: { anchor: Point; cursor: Point; cols: number };
  /** Its text once read; `reading` while the read is in flight. */
  private text?: string;
  private reading?: Promise<string | undefined>;
  private painting = false;
  private stepTimer?: number;
  private settleTimer?: number;

  constructor(private h: LongSelectionHost) {
    // Another selection (a click, a double click, select all) replaces ours.
    h.term.onSelectionChange(() => {
      if (!this.painting && this.sel && !this.drag) this.drop();
    });
  }

  /** Whether a taken-over selection is shown. */
  get active(): boolean {
    return !!this.sel;
  }

  down(ev: MouseEvent) {
    // A right click keeps the selection for the browser's menu (Copy).
    if (ev.button !== 0) return;
    this.drop();
    // Plain drags only: not word or line selections (double, triple click),
    // extending (Shift) or column selections (Alt outside macOS).
    if (ev.detail > 1 || ev.shiftKey || (ev.altKey && !isMac)) return;
    const p = this.cellAt(ev.clientX, ev.clientY);
    if (p) this.drag = { anchor: p, x: ev.clientX, y: ev.clientY, probed: false, taken: false };
  }

  move(ev: MouseEvent) {
    const d = this.drag;
    if (!d) return;
    if (!(ev.buttons & 1)) return this.up();
    d.x = ev.clientX;
    d.y = ev.clientY;
    if (d.taken) return this.track();
    if (!this.edge()) d.probed = false;
    else if (!d.probed && this.h.canScroll()) {
      d.probed = true;
      this.h
        .api<PaneInfoReply>('pane.get', { pane_id: this.h.pane })
        .then((res) => {
          const info = res.pane?.scroll;
          const e = this.edge();
          if (this.drag !== d || d.taken || !info || !e) return;
          this.info = info;
          // Nothing to scroll that way (no scrollback, an alternate screen,
          // already at the end): xterm.js keeps the drag.
          if (e.dir < 0 ? info.offset_from_bottom >= info.max_offset_from_bottom : info.offset_from_bottom <= 0) return;
          this.takeOver();
        })
        .catch(() => {});
    }
  }

  up() {
    const d = this.drag;
    if (!d) return;
    this.drag = undefined;
    window.clearTimeout(this.stepTimer);
    this.stepTimer = undefined;
    if (d.taken) this.read();
  }

  /** Puts the highlight back after a frame redrew the rows under it. */
  repaint = () => {
    if (this.sel) this.paint();
  };

  /** Moves the shown selection along after the view may have moved (wheel
   * scrolling; typing, which returns herdr to the live bottom). */
  moved() {
    if (!this.sel || this.drag) return;
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      const sel = this.sel;
      this.h
        .api<PaneInfoReply>('pane.get', { pane_id: this.h.pane })
        .then((res) => {
          if (this.sel !== sel || !res.pane?.scroll) return;
          this.info = res.pane.scroll;
          this.paint();
        })
        .catch(() => {});
    }, SETTLE_MS);
  }

  /** Copies the whole selection instead of xterm.js's visible part. */
  copy(ev: ClipboardEvent) {
    if (!this.sel || this.drag) return;
    if (this.text !== undefined && ev.clipboardData) {
      ev.clipboardData.setData('text/plain', this.text);
      ev.preventDefault();
      ev.stopImmediatePropagation();
    } else {
      // Copied right after the release: the visible part now, all of it
      // once read.
      this.reading?.then((text) => {
        if (text) navigator.clipboard?.writeText(text).catch(() => {});
      });
    }
  }

  /** Forgets the selection (a new drag, a new stream, a resize). A drag
   * that was taken over ends with it: xterm.js no longer follows it. */
  drop() {
    if (this.drag?.taken) this.drag = undefined;
    window.clearTimeout(this.stepTimer);
    this.stepTimer = undefined;
    this.sel = undefined;
    this.text = undefined;
    this.reading = undefined;
    window.clearTimeout(this.settleTimer);
  }

  dispose() {
    this.drag = undefined;
    this.drop();
  }

  private cellAt(x: number, y: number): Point | undefined {
    const r = this.h.screen();
    const { cols, rows } = this.h.term;
    if (!r || !cols || !rows || x < r.left || x >= r.right || y < r.top || y >= r.bottom) return;
    // Columns are cell boundaries rounded as xterm.js does for selections.
    return {
      row: Math.min(rows - 1, Math.floor(((y - r.top) / r.height) * rows)),
      col: Math.min(cols, Math.max(0, Math.round(((x - r.left) / r.width) * cols))),
    };
  }

  /** The edge the pointer is past (-1 top, 1 bottom) and how far. */
  private edge(): { dir: -1 | 1; px: number } | undefined {
    const r = this.h.screen();
    const d = this.drag;
    if (!r || !d) return;
    if (d.y < r.top) return { dir: -1, px: r.top - d.y };
    if (d.y >= r.bottom) return { dir: 1, px: d.y - r.bottom };
  }

  private takeOver() {
    const d = this.drag!;
    const top = viewTop(this.info!);
    this.sel = {
      anchor: { row: top + d.anchor.row, col: d.anchor.col },
      cursor: { row: top + d.anchor.row, col: d.anchor.col },
      cols: this.h.term.cols,
    };
    d.taken = true;
    this.track();
  }

  /** Follows the pointer: moves the selection's end and keeps scrolling
   * while the pointer is past an edge. */
  private track() {
    const d = this.drag;
    const sel = this.sel;
    const info = this.info;
    const r = this.h.screen();
    if (!d || !sel || !info || !r) return;
    const rows = Math.min(this.h.term.rows, info.viewport_rows);
    const top = viewTop(info);
    const e = this.edge();
    if (e) sel.cursor = e.dir < 0 ? { row: top, col: 0 } : { row: top + rows - 1, col: sel.cols };
    else {
      const p = this.cellAt(Math.min(Math.max(d.x, r.left), r.right - 1), d.y);
      if (p) sel.cursor = { row: top + p.row, col: p.col };
    }
    this.paint();
    if (e && this.stepTimer === undefined) this.stepTimer = window.setTimeout(this.step, STEP_MS);
  }

  private step = () => {
    const info = this.info;
    const e = this.edge();
    const r = this.h.screen();
    if (!this.drag?.taken || !info || !e || !r) {
      this.stepTimer = undefined;
      return;
    }
    const lines = stepLines(e.px, r.height / Math.max(1, this.h.term.rows));
    const offset = Math.min(info.max_offset_from_bottom, Math.max(0, info.offset_from_bottom - e.dir * lines));
    const next = () => {
      this.stepTimer = undefined;
      if (this.drag?.taken) this.track();
    };
    if (offset === info.offset_from_bottom) {
      // At the end of the scrollback: wait for the pointer to move back.
      this.stepTimer = window.setTimeout(next, STEP_MS);
      return;
    }
    this.h
      .api<PaneInfoReply>('pane.scroll', { pane_id: this.h.pane, offset_from_bottom: offset })
      .then((res) => {
        if (res.pane?.scroll) this.info = res.pane.scroll;
      })
      .catch(() => {})
      .finally(() => {
        if (this.drag?.taken) this.stepTimer = window.setTimeout(next, STEP_MS);
        else this.stepTimer = undefined;
      });
  };

  private paint() {
    const sel = this.sel;
    const info = this.info;
    const term = this.h.term;
    if (!sel || !info) return;
    // Columns are what absolute positions are counted in.
    if (term.cols !== sel.cols) return this.drop();
    const part = visiblePart(sel.anchor, sel.cursor, sel.cols, term.rows, viewTop(info));
    this.painting = true;
    try {
      if (part) term.select(part.col, part.row, part.length);
      else term.clearSelection();
    } finally {
      this.painting = false;
    }
  }

  private read() {
    const sel = this.sel;
    const info = this.info;
    if (!sel || !info) return;
    // Rows past the last one are refused; clamp to the text herdr has.
    const last = info.max_offset_from_bottom + info.viewport_rows - 1;
    const clamp = (p: Point): Point => (p.row > last ? { row: last, col: sel.cols } : p);
    const range = readRange(clamp(sel.anchor), clamp(sel.cursor), sel.cols);
    if (!range) return;
    const reading = this.h
      .api<{ text?: string }>('pane.selection.read', { pane_id: this.h.pane, ...range })
      .then((res) => res.text)
      .catch(() => undefined);
    this.reading = reading;
    reading.then((text) => {
      if (this.reading === reading) this.text = text;
    });
  }
}
