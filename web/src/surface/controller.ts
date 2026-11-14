// SurfaceController draws the shown tab's surface on a canvas and turns the
// browser's input into herdr pane input.
//
// herdr renders the whole tab (panes, borders, split lines) into one cell
// grid at the size this browser asks for; the controller paints it, measures
// the cell size from the terminal font, and maps keys, text, pastes, mouse
// and wheel events to the pane under them. Selections are local to one pane
// (see selection.ts) unless the pane's program reports the mouse.
//
// Painting is incremental: rows herdr changed, rows whose selection
// highlight changed, and the rows a scroll uncovers; rows herdr moved are
// copied on the canvas.
//
// A right click opens the pane's menu (copy, paste, and opening the path or
// URL under the pointer or selected) unless the pane's program reports the
// mouse; Shift+right click opens it there.
//
// Files pasted, or dragged from outside the page onto a pane, are pasted as
// their paths (see drop.ts); the drag shows which pane takes them.

import { conn } from '../lib/conn';
import { carriesFiles } from '../drop';
import {
  forgetProgramClipboard,
  grid,
  onPaint,
  programClipboard,
  programClipboardCopied,
  sendFocus,
  sendInput,
  useSurface,
} from './session';
import { palette as makePalette, rgb, type Palette } from './colors';
import { moveRanges, paintRows, sameRanges, type Metrics, type Ranges } from './paint';
import { routeKey } from './keys';
import { isFindKey, matchRows, useFind } from './find';
import { isMac, pasteText, releaseOf, type InputEvent, type KeyEvent, type MouseEvent as PaneMouse } from './input';
import { Selection, scrollRate, viewTop, wordAt, type Point } from './selection';
import type { ScrollInfo, SurfaceMeta, SurfacePane, SurfaceSplit } from './protocol';
import { linksAround, openLink, linkTitle, safeUrl, selectedLink, type Cells, type LinkContext } from '../terminal/links';
import { mathAt } from '../terminal/math';
import { renderMath } from '../terminal/mathRender';
import { openMenu } from '../contextMenu';
import { surfaceMenu } from '../menus';
import { themes } from '../terminal/options';
import { termFontFamily } from '../terminal/fonts';
import type { Appearance } from '../appearance';

export interface ControllerOptions {
  m(): string;
  /** The pane keys go to. */
  focusedPane(): string | undefined;
  focusPane(pane: string): void;
  appKey(ev: KeyboardEvent): boolean;
  readOnly(): boolean;
  onPasteFiles?(files: File[]): Promise<string | undefined>;
  /** Files from outside the page dropped on a pane: the text to paste. The
   * items are read before anything is awaited; they are empty after the
   * drop event. */
  onDropFiles?(pane: string, items: DataTransferItemList): Promise<string | undefined>;
  /** The pane files dragged over the surface would be dropped on, or none. */
  onDropTarget?(pane: string | undefined): void;
  linkContext(pane: string): LinkContext;
  /** The grid size that fits, in cells, the cell size in device pixels and
   * the device pixel ratio it was measured at. */
  onSize(cols: number, rows: number, cw: number, ch: number, dpr: number): void;
  onSplitDrag?(split: SurfaceSplit, ratio: number | undefined): void;
  setTitle(title: string): void;
  /** The formula under the pointer, rendered, or none any more. */
  onMath?(math: ShownMath | undefined): void;
  /** Whether formulas under the pointer are shown. */
  mathHover?(): boolean;
  /** Opens find in a pane, with the selected text as the query if any. */
  onFind?(pane: string, text?: string): void;
}

/** A formula in a pane and the cells it covers, one range per row. */
export interface PaneMath {
  pane: string;
  cells: Cells[];
  tex: string;
  display: boolean;
}

/** A formula shown rendered: KaTeX's HTML. */
export interface ShownMath extends PaneMath {
  html: string;
}

/** How long the pointer rests on a formula before it is shown, and how long
 * the formula stays after the pointer left it, so that it can reach the
 * popover (whose element has the class math-popover). */
export const MATH_SHOW_MS = 300;
export const MATH_LEAVE_MS = 250;
/** How long the formula stays while the pointer is on its way to the
 * popover but has stopped. */
export const MATH_APPROACH_MS = 800;

const mathKey = (m: PaneMath | undefined) => (m ? `${m.pane} ${m.cells.map((c) => `${c.y}:${c.from}-${c.to}`).join(' ')} ${m.tex}` : '');

/** Whether (px, py) lies in the triangle a, b, c. */
function inTriangle(px: number, py: number, a: [number, number], b: [number, number], c: [number, number]) {
  const side = (p: [number, number], q: [number, number]) => (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0]);
  const d1 = side(a, b);
  const d2 = side(b, c);
  const d3 = side(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

const overPopover = (target: EventTarget | null | undefined) => !!(target as Element | null)?.closest?.('.math-popover');

/** Least pause between scroll requests while a selection drag is past an
 * edge; one request is in flight at a time. */
const STEP_MS = 40;

/** A link in a pane and the cells it covers, one range per row. */
interface PaneLink {
  cells: Cells[];
  link: { kind: 'url' | 'path'; text: string };
  pane: string;
}

const linkKey = (l: PaneLink | undefined) => (l ? `${l.pane} ${l.cells.map((c) => `${c.y}:${c.from}-${c.to}`).join(' ')}` : '');

export class SurfaceController {
  private ctx: CanvasRenderingContext2D;
  private metrics!: Metrics;
  private palette!: Palette;
  private appearance!: Appearance;
  private meta?: SurfaceMeta;
  /** Counts metadata received, to tell whether a scroll reply is newer. */
  private metaCount = 0;
  private unsubscribe: () => void;
  private frame?: number;
  /** The highlight each canvas row was painted with. */
  private painted: Array<Ranges | undefined> = [];
  private ro: ResizeObserver;
  /** The device pixel ratio the metrics were measured at. */
  private dpr = 1;
  /** Matches while the device pixel ratio is still `dpr`. */
  private dprQuery?: MediaQueryList;
  private pressed = new Map<string, { pane: string; key: KeyEvent }>();
  private composing = false;
  /** The input method's text being composed, shown at the cursor. */
  private preedit: HTMLDivElement;
  private focused = false;
  private sel?: Selection;
  /** The drag in progress. */
  private drag?:
    | { kind: 'mouse'; pane: string; button: number; last: string }
    | { kind: 'select'; pane: string; x: number; y: number; mode: 1 | 2 | 3; origin: [Point, Point] }
    | { kind: 'split'; split: SurfaceSplit };
  /** Scrolling while a selection drag is past the pane's top (-1) or
   * bottom (1) edge: lines are owed at scrollRate since `since`. */
  private auto?: { pane: string; dir: number; since: number; last: number; owed: number; timer?: number };
  /** A pane.scroll request is in flight. */
  private scrolling = false;
  /** herdr's answer to the last one, and the metadata count then. */
  private scrollReply?: { pane: string; scroll: ScrollInfo; meta: number };
  private wheelAccum = 0;
  /** The link under the pointer while Cmd/Ctrl is held, with its cells. */
  private hover?: PaneLink;
  /** The formula shown rendered, the one the pointer is on (shown after
   * MATH_SHOW_MS), and the timer showing or hiding one. */
  private math?: ShownMath;
  private mathWant?: PaneMath;
  private mathTimer?: number;
  /** Where the pointer was at the last move over the panes. */
  private mathFrom?: { x: number; y: number };
  /** Find's matches in a pane of this machine: columns per absolute row. */
  private found?: { pane: string; cols: number; rows: Map<number, Ranges> };
  private unsubscribeFind: () => void;
  private disposed = false;

  constructor(
    private host: HTMLElement,
    private canvas: HTMLCanvasElement,
    private textarea: HTMLTextAreaElement,
    private o: ControllerOptions,
    appearance: Appearance,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.preedit = document.createElement('div');
    this.preedit.className = 'surface-compose';
    host.appendChild(this.preedit);
    this.setAppearance(appearance);
    onPaint(() => this.schedule());
    // Metadata comes right before the surface patch it belongs to; taking it
    // at once (not after React renders) paints both together.
    this.unsubscribe = useSurface.subscribe((st, prev) => {
      if (st.meta !== prev.meta) this.setMeta(st.meta && st.meta.m === this.o.m() ? st.meta : undefined);
    });
    this.unsubscribeFind = useFind.subscribe((st, prev) => {
      if (st.matches !== prev.matches || st.current !== prev.current || st.open !== prev.open) this.findChanged();
    });
    this.ro = new ResizeObserver(() => this.measureSize());
    this.ro.observe(host);
    this.install();
  }

  // ---- appearance and size ----

  setAppearance(a: Appearance) {
    this.appearance = a;
    this.palette = makePalette(themes[a.theme]);
    this.measureCell();
    grid.invalidate();
    this.measureSize();
    this.schedule();
  }

  /** Cell size from the terminal font, in whole device pixels. */
  private measureCell() {
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.dpr || !this.dprQuery) {
      this.dpr = dpr;
      this.watchDpr();
    }
    const a = this.appearance;
    const family = termFontFamily(a.fontWeight);
    const fontPx = Math.round(a.fontSize * dpr);
    const ctx = this.ctx;
    ctx.font = `${a.fontWeight} ${fontPx}px ${family}`;
    const m = ctx.measureText('W');
    const ascent = m.fontBoundingBoxAscent || fontPx * 0.95;
    const descent = m.fontBoundingBoxDescent || fontPx * 0.3;
    const cw = Math.max(1, Math.round(m.width || fontPx * 0.6));
    // 5% more than the font's line height, as the dialogs' terminals do.
    const ch = Math.max(1, Math.round((ascent + descent) * 1.05));
    const baseline = Math.round((ch - (ascent + descent)) / 2 + ascent);
    this.metrics = { cw, ch, fontPx, family, weight: a.fontWeight, baseline };
  }

  /** Font faces finished loading: measure again. */
  fontChanged() {
    this.setAppearance(this.appearance);
  }

  /** The window moved to a display with another pixel density, or the page
   * was zoomed: the same font size is another number of device pixels, so
   * the cell is measured again. Otherwise the canvas, sized in the old
   * device pixels, would be shown scaled by the ratio of the two densities
   * (text twice as large on a 1x display after a 2x one). */
  private watchDpr() {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = undefined;
    if (this.disposed || typeof window.matchMedia !== 'function') return;
    this.dprQuery = window.matchMedia(`(resolution: ${this.dpr}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private onDprChange = () => {
    if ((window.devicePixelRatio || 1) !== this.dpr) this.setAppearance(this.appearance);
  };

  private measureSize() {
    if (this.disposed) return;
    const dpr = this.dpr;
    const w = this.host.clientWidth * dpr;
    const h = this.host.clientHeight * dpr;
    if (w <= 0 || h <= 0) return;
    const { cw, ch } = this.metrics;
    const cols = Math.max(2, Math.floor(w / cw));
    const rows = Math.max(1, Math.floor(h / ch));
    this.o.onSize(cols, rows, cw, ch, dpr);
  }

  setMeta(meta: SurfaceMeta | undefined) {
    const prev = this.meta;
    if (meta === prev) return;
    this.meta = meta;
    this.metaCount++;
    if (this.sel && !this.paneById(this.sel.pane)) this.clearSelection();
    // Find's pane may have arrived, or gone.
    if (useFind.getState().open && (!this.found || !this.paneById(this.found.pane))) this.findChanged();
    if (prev?.w !== meta?.w || prev?.h !== meta?.h) grid.invalidate();
    // A scroll moved the rows past the edge a selection drag is held at.
    if (this.drag?.kind === 'select') this.trackSelection();
    // Scroll positions move a selection's rows (paint compares them).
    this.schedule();
  }

  // ---- painting ----

  private schedule() {
    if (this.frame !== undefined || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.paint();
    });
  }

  private paint() {
    const g = grid;
    if (!g.ready) return;
    const { cw, ch } = this.metrics;
    const dpr = this.dpr;
    const W = g.w * cw;
    const H = g.h * ch;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      this.canvas.style.width = `${W / dpr}px`;
      this.canvas.style.height = `${H / dpr}px`;
      g.invalidate();
    }
    this.copyMoves();
    // Rows whose selection highlight changed.
    for (let y = 0; y < g.h; y++) if (!sameRanges(this.painted[y], this.highlight(y))) g.dirty.add(y);
    if (!g.dirty.size) return;
    const rows = [...g.dirty];
    g.dirty.clear();
    paintRows(
      this.ctx,
      g,
      {
        palette: this.palette,
        metrics: this.metrics,
        focused: this.focused,
        highlight: (y) => (this.painted[y] = this.highlight(y)),
        hover: this.hover?.cells,
        math: this.math?.cells,
      },
      rows,
    );
    // The text under a shown formula changed: look again at the pointer.
    const shown = this.math;
    if (shown && this.lastPointer && !this.lastPointer.popover && shown.cells.some((c) => rows.includes(c.y)))
      queueMicrotask(() => this.lastPointer && this.updateMath({ clientX: this.lastPointer.x, clientY: this.lastPointer.y }));
    this.placeTextarea();
  }

  /** Copies the rows herdr moved (scrolling) on the canvas, with what was
   * painted on them; Grid.move marked the rows that still need painting. */
  private copyMoves() {
    const g = grid;
    const moves = g.moves;
    if (!moves.length) return;
    g.moves = [];
    const { cw, ch } = this.metrics;
    for (const m of moves) {
      const { x, y, w, h } = m.rect;
      const d = Math.abs(m.shift);
      const [from, to] = m.shift > 0 ? [y + d, y] : [y, y + d];
      // A canvas drawn on itself is copied first, so the areas may overlap.
      this.ctx.drawImage(this.canvas, x * cw, from * ch, w * cw, (h - d) * ch, x * cw, to * ch, w * cw, (h - d) * ch);
      const r = moveRanges(this.painted, m);
      this.painted = r.painted;
      for (const row of r.repaint) g.dirty.add(row);
      // A hovered link's underline moved with its rows: drop it.
      const hv = this.hover;
      if (hv?.cells.some((c) => c.y >= y && c.y < y + h && c.to > x && c.from < x + w)) {
        for (const c of hv.cells) {
          g.dirty.add(c.y);
          if (c.y - m.shift >= y && c.y - m.shift < y + h) g.dirty.add(c.y - m.shift);
        }
        this.hover = undefined;
        this.host.style.cursor = '';
        this.o.setTitle('');
      }
      if (this.math?.cells.some((c) => c.y >= y && c.y < y + h && c.to > x && c.from < x + w)) this.hideMath();
    }
  }

  /** A row's highlights: find's matches in it and the selection. */
  private highlight(y: number): Ranges | undefined {
    const sel = this.sel;
    const sp = sel && this.paneById(sel.pane);
    const c = sp && sel.columns(sp, y);
    const found = this.foundIn(y);
    if (!found) return c ? [c] : undefined;
    return c ? [...found, c] : found;
  }

  /** Find's matches in surface row y, if it shows a row of the pane find
   * searched. */
  private foundIn(y: number): Ranges | undefined {
    const f = this.found;
    const p = f && this.paneById(f.pane);
    if (!f || !p || y < p.inner.y || y >= p.inner.y + p.inner.h) return;
    if (f.cols !== p.inner.w) this.findChanged();
    const row = this.found?.rows.get(viewTop(p.scroll) + (y - p.inner.y));
    return row?.map(([a, b, k]) => [p.inner.x + a, p.inner.x + b, k]);
  }

  /** Find's matches changed: rows get their highlights at the next paint. */
  private findChanged() {
    const st = useFind.getState();
    const p = st.open && st.m === this.o.m() && st.pane ? this.paneById(st.pane) : undefined;
    this.found = p && st.matches.length ? { pane: p.id, cols: p.inner.w, rows: matchRows(st.matches, st.current, p.inner.w) } : undefined;
    this.schedule();
  }

  /** Opens find in the pane (keys go to the focused one), with the
   * selection's text as the query when it is one short line. */
  openFind(pane = this.targetPane()) {
    if (!pane) return;
    const text = this.sel?.pane === pane && !this.sel.empty ? this.selectionText()?.trim() : undefined;
    this.o.onFind?.(pane, text && !text.includes('\n') && text.length <= 200 ? text : undefined);
  }

  /** Keeps the hidden textarea at the cursor, where input methods show
   * their candidates. */
  private placeTextarea() {
    const c = grid.cursor;
    if (!c) return;
    const dpr = this.dpr;
    const { cw, ch } = this.metrics;
    this.textarea.style.left = `${(c.x * cw) / dpr}px`;
    this.textarea.style.top = `${(c.y * ch) / dpr}px`;
    this.textarea.style.height = `${ch / dpr}px`;
  }

  /** Terminal colors for herdr's answers to color queries. */
  hostColors() {
    const p = this.palette;
    return { fg: rgb(p.fg), bg: rgb(p.bg), palette: p.colors.slice(0, 16).map(rgb), dark: this.appearance.theme === 'dark' };
  }

  // ---- geometry ----

  private paneById(id: string): SurfacePane | undefined {
    return this.meta?.panes.find((p) => p.id === id);
  }

  /** The surface cell under a client position (may be outside the grid). */
  private cellAt(clientX: number, clientY: number): { x: number; y: number; fx: number } {
    const r = this.canvas.getBoundingClientRect();
    const { cw, ch } = this.metrics;
    const dpr = this.dpr;
    const fx = ((clientX - r.left) * dpr) / cw;
    return { x: Math.floor(fx), y: Math.floor(((clientY - r.top) * dpr) / ch), fx };
  }

  private paneAt(x: number, y: number): SurfacePane | undefined {
    const inside = (r: { x: number; y: number; w: number; h: number }) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    const ps = this.meta?.panes ?? [];
    return ps.find((p) => inside(p.inner)) ?? ps.find((p) => inside(p.rect));
  }

  private splitAt(x: number, y: number): SurfaceSplit | undefined {
    return this.meta?.splits.find((s) => x >= s.hit.x && x < s.hit.x + s.hit.w && y >= s.hit.y && y < s.hit.y + s.hit.h);
  }

  /** Cell relative to a pane's inner rectangle, clamped into it. */
  private inner(p: SurfacePane, x: number, y: number): { col: number; row: number } {
    return {
      col: Math.min(Math.max(x - p.inner.x, 0), p.inner.w - 1),
      row: Math.min(Math.max(y - p.inner.y, 0), p.inner.h - 1),
    };
  }

  // ---- input ----

  private targetPane(): string | undefined {
    const want = this.o.focusedPane();
    if (want && this.paneById(want)) return want;
    return this.meta?.panes.find((p) => p.focused)?.id;
  }

  private send(pane: string | undefined, ev: InputEvent[]) {
    if (!pane || this.o.readOnly()) return;
    sendInput(this.o.m(), pane, ev);
  }

  focus() {
    this.textarea.focus({ preventScroll: true });
  }

  private install() {
    const ta = this.textarea;
    ta.addEventListener('keydown', this.onKeyDown);
    ta.addEventListener('keyup', this.onKeyUp);
    ta.addEventListener('compositionstart', this.onComposition);
    ta.addEventListener('compositionupdate', this.onComposition);
    ta.addEventListener('compositionend', this.onCompositionEnd);
    ta.addEventListener('input', this.onInput);
    ta.addEventListener('paste', this.onPaste);
    ta.addEventListener('copy', this.onCopy);
    ta.addEventListener('focus', this.onFocusChange);
    ta.addEventListener('blur', this.onFocusChange);
    this.host.addEventListener('mousedown', this.onMouseDown);
    this.host.addEventListener('wheel', this.onWheel, { passive: false });
    this.host.addEventListener('contextmenu', this.onContextMenu);
    this.host.addEventListener('dragover', this.onDragOver);
    this.host.addEventListener('dragleave', this.onDragLeave);
    this.host.addEventListener('drop', this.onDrop);
    this.host.addEventListener('mouseleave', this.onMouseLeave);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('keydown', this.onModifier);
    window.addEventListener('keyup', this.onModifier);
  }

  private onKeyDown = (ev: KeyboardEvent) => {
    this.hideMath();
    const pane = this.targetPane();
    const route = routeKey(
      ev,
      (e) => {
        if (e.type === 'keydown' && isFindKey(e) && this.o.onFind) {
          this.openFind(pane);
          return true;
        }
        return this.o.appKey(e);
      },
      (e) => {
        if (e.t === 'key' && e.key.tracksRelease) this.pressed.set(ev.code || ev.key, { pane: pane!, key: e.key });
        this.send(pane, [e]);
      },
      { optionIsMeta: this.appearance.optionIsMeta },
    );
    if (route === 'pane') this.selectionMoved();
  };

  private onKeyUp = (ev: KeyboardEvent) => {
    const k = ev.code || ev.key;
    const p = this.pressed.get(k);
    if (!p) return;
    this.pressed.delete(k);
    this.send(p.pane, [{ t: 'key', key: releaseOf(p.key) }]);
  };

  private onComposition = (ev: CompositionEvent) => {
    this.composing = true;
    this.showPreedit(ev.data ?? '');
  };

  /** Shows the composed text over the cells at the cursor, in the
   * terminal's font and colors; herdr receives only the committed text. */
  private showPreedit(text: string) {
    const el = this.preedit;
    // Without a cursor, the start of the focused pane.
    const inner = this.paneById(this.targetPane() ?? '')?.inner;
    const c = grid.cursor ?? (inner && { x: inner.x, y: inner.y });
    if (!text || !c) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    const dpr = this.dpr;
    const { cw, ch, fontPx, family, weight } = this.metrics;
    el.textContent = text;
    Object.assign(el.style, {
      display: 'block',
      top: `${(c.y * ch) / dpr}px`,
      height: `${ch / dpr}px`,
      font: `${weight} ${fontPx / dpr}px ${family}`,
      lineHeight: `${ch / dpr}px`,
      color: this.palette.fg,
      background: this.palette.bg,
    });
    // Keep it inside the surface near the right edge.
    const left = (c.x * cw) / dpr;
    el.style.left = `${Math.max(0, Math.min(left, this.host.clientWidth - el.offsetWidth))}px`;
  }

  private onCompositionEnd = (ev: CompositionEvent) => {
    this.composing = false;
    this.showPreedit('');
    if (ev.data) this.send(this.targetPane(), [{ t: 'text', text: ev.data }]);
    this.textarea.value = '';
  };

  /** Text the keydown handler did not send (dead keys, mobile keyboards). */
  private onInput = (ev: Event) => {
    const ie = ev as unknown as { data?: string | null; inputType?: string; isComposing?: boolean };
    if (this.composing || ie.isComposing) return;
    if (ie.inputType === 'insertText' && ie.data) this.send(this.targetPane(), [{ t: 'text', text: ie.data }]);
    this.textarea.value = '';
  };

  private onPaste = (ev: ClipboardEvent) => {
    ev.preventDefault();
    const pane = this.targetPane();
    const dt = ev.clipboardData;
    if (!dt || !pane) return;
    const files = Array.from(dt.files);
    if (files.length && this.o.onPasteFiles) {
      this.pasteWhenReady(pane, this.o.onPasteFiles(files));
      return;
    }
    const text = dt.getData('text/plain');
    if (text) this.send(pane, [{ t: 'paste', text: pasteText(text) }]);
  };

  /** Pastes files' paths once known (uploads take a while), as a paste: the
   * way a terminal delivers dropped files. */
  private pasteWhenReady(pane: string, text: Promise<string | undefined>) {
    void text.then((t) => t && this.send(pane, [{ t: 'paste', text: pasteText(t) }]));
  }

  /** The pane under a drag of files from outside the page, when it may take
   * them: not in read-only mode, and while this page uses the session. */
  private dropPane(ev: DragEvent): SurfacePane | undefined {
    if (!this.o.onDropFiles || this.o.readOnly() || useSurface.getState().ownership !== 'owner') return;
    if (!carriesFiles(ev.dataTransfer)) return;
    const { x, y } = this.cellAt(ev.clientX, ev.clientY);
    return this.paneAt(x, y);
  }

  private onDragOver = (ev: DragEvent) => {
    const p = this.dropPane(ev);
    this.o.onDropTarget?.(p?.id);
    if (!p) return;
    ev.preventDefault();
    ev.dataTransfer!.dropEffect = 'copy';
  };

  private onDragLeave = (ev: DragEvent) => {
    if (!this.host.contains(ev.relatedTarget as Node | null)) this.o.onDropTarget?.(undefined);
  };

  private onDrop = (ev: DragEvent) => {
    this.o.onDropTarget?.(undefined);
    const p = this.dropPane(ev);
    if (!p) return;
    ev.preventDefault();
    this.o.focusPane(p.id);
    this.focus();
    this.pasteWhenReady(p.id, this.o.onDropFiles!(p.id, ev.dataTransfer!.items));
  };

  private onCopy = (ev: ClipboardEvent) => {
    const sel = this.sel;
    const p = sel && this.paneById(sel.pane);
    if (!sel || !p || sel.empty) {
      const program = programClipboard(this.o.m());
      if (program) {
        ev.preventDefault();
        ev.clipboardData?.setData('text/plain', program);
        programClipboardCopied(program);
      }
      return;
    }
    ev.preventDefault();
    ev.clipboardData?.setData('text/plain', sel.text ?? sel.visibleText(p, grid));
    copyWhenRead(sel);
  };

  /** Copies the selection (the menu's Copy). */
  copySelection() {
    const sel = this.sel;
    const p = sel && this.paneById(sel.pane);
    if (!sel || !p || sel.empty) return;
    writeClipboard(sel.text ?? sel.visibleText(p, grid));
    copyWhenRead(sel);
  }

  /** Pastes the clipboard's text into a pane (the menu's Paste). */
  pasteClipboard(pane: string) {
    void navigator.clipboard
      ?.readText()
      .then((text) => {
        if (text) this.send(pane, [{ t: 'paste', text: pasteText(text) }]);
      })
      .catch(() => {});
  }

  private onFocusChange = () => {
    const f = document.activeElement === this.textarea;
    if (f === this.focused) return;
    this.focused = f;
    if (!f) this.showPreedit('');
    if (!this.o.readOnly()) sendFocus(this.o.m(), f);
    if (grid.cursor) grid.dirty.add(grid.cursor.y);
    this.schedule();
  };

  private mods(ev: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean }): number {
    return (ev.shiftKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.altKey ? 4 : 0);
  }

  private onContextMenu = (ev: MouseEvent) => {
    if ((ev.target as Element | null)?.closest?.('button, .find-bar') || !this.meta) return;
    const { x, y } = this.cellAt(ev.clientX, ev.clientY);
    const p = this.paneAt(x, y);
    if (!p) return;
    const readOnly = this.o.readOnly();
    // The right button opens the menu in every pane, also where the program
    // reports the mouse (it never gets right clicks). On macOS Ctrl+click is
    // also a right click, which opened the link under it.
    if (ev.ctrlKey && ev.button === 0 && this.hover) {
      ev.preventDefault();
      return;
    }
    const sel = this.sel?.pane === p.id && !this.sel.empty ? this.sel : undefined;
    // Without a selection of the page, Copy copies what the pane's program
    // copied from its own selection (OSC 52).
    const program = sel ? undefined : programClipboard(this.o.m());
    const fromSel = sel && selectedLink(sel.text ?? sel.visibleText(p, grid));
    const atPointer = this.linkAt(p, x, y)?.link;
    // Over the selection, a selected path wins over a part of it detected
    // under the pointer (a path wrapped in a way detection does not join).
    const c = sel?.columns(p, y);
    const inSel = !!c && x >= c[0] && x < c[1];
    const link = inSel ? (fromSel ?? atPointer) : (atPointer ?? fromSel);
    openMenu(
      ev,
      surfaceMenu({
        ctx: this.o.linkContext(p.id),
        link,
        copy: sel
          ? () => this.copySelection()
          : program
            ? () => {
                writeClipboard(program);
                programClipboardCopied(program);
              }
            : undefined,
        paste: readOnly || !navigator.clipboard?.readText ? undefined : () => this.pasteClipboard(p.id),
        find: this.o.onFind ? () => this.openFind(p.id) : undefined,
      }),
    );
  };

  private onMouseDown = (ev: MouseEvent) => {
    // Buttons over the grid (a pane's close button) and the find bar handle
    // their own clicks; the program under them must not get one.
    if ((ev.target as Element | null)?.closest?.('button, .math-popover, .find-bar')) return;
    this.hideMath();
    if (useSurface.getState().ownership !== 'owner' || !this.meta) return;
    const { x, y } = this.cellAt(ev.clientX, ev.clientY);
    // Keep keyboard focus in the textarea.
    ev.preventDefault();
    this.focus();
    const split = !this.o.readOnly() && ev.button === 0 ? this.splitAt(x, y) : undefined;
    if (split) {
      this.drag = { kind: 'split', split };
      return;
    }
    const p = this.paneAt(x, y);
    if (!p) return;
    this.o.focusPane(p.id);
    // Cmd/Ctrl+click opens links.
    if (this.hover && this.hover.pane === p.id && (ev.metaKey || ev.ctrlKey) && ev.button === 0) {
      openLink(this.hover.link, this.o.linkContext(p.id));
      return;
    }
    const c = this.inner(p, x, y);
    // The right button, and Ctrl+click on macOS, is for the pane's menu
    // (onContextMenu); the press keeps the selection, the page's or the
    // program's.
    if (ev.button === 2 || (isMac && ev.ctrlKey && ev.button === 0)) return;
    // Any other press ends the program's selection, also where the page
    // selects instead.
    forgetProgramClipboard();
    if (p.mouse && !ev.shiftKey && !this.o.readOnly()) {
      this.clearSelection();
      // herdr's buttons: 0 left, 2 middle.
      const button = ev.button === 1 ? 2 : 0;
      this.drag = { kind: 'mouse', pane: p.id, button, last: `${c.col},${c.row}` };
      this.send(p.id, [{ t: 'mouse', mouse: { kind: 'down', button, col: c.col, row: c.row, mods: this.mods(ev) } }]);
      return;
    }
    if (ev.button !== 0) return;
    const top = viewTop(p.scroll);
    const fx = this.cellAt(ev.clientX, ev.clientY).fx - p.inner.x;
    const col = Math.min(p.inner.w, Math.max(0, Math.round(fx)));
    const at: Point = { row: top + c.row, col };
    const mode = Math.min(3, ev.detail || 1) as 1 | 2 | 3;
    if (mode === 1 && ev.shiftKey && this.sel?.pane === p.id) {
      this.sel.cursor = at;
      this.drag = { kind: 'select', pane: p.id, x: ev.clientX, y: ev.clientY, mode, origin: [this.sel.anchor, this.sel.anchor] };
      this.selectionChanged();
      return;
    }
    const sel = new Selection(p.id, p.inner.w, at);
    let origin: [Point, Point] = [at, at];
    if (mode === 2) {
      const [a, b] = wordAt(grid, y, p.inner.x, p.inner.x + p.inner.w, Math.min(x, p.inner.x + p.inner.w - 1));
      origin = [
        { row: at.row, col: a - p.inner.x },
        { row: at.row, col: b - p.inner.x },
      ];
    } else if (mode === 3) {
      origin = [
        { row: at.row, col: 0 },
        { row: at.row, col: p.inner.w },
      ];
    }
    sel.anchor = origin[0];
    sel.cursor = origin[1];
    this.sel = sel;
    this.drag = { kind: 'select', pane: p.id, x: ev.clientX, y: ev.clientY, mode, origin };
    this.selectionChanged();
  };

  private onMouseMove = (ev: MouseEvent) => {
    const d = this.drag;
    if (!d) {
      this.updateHover(ev);
      this.updateMath(ev);
      return;
    }
    const { x, y, fx } = this.cellAt(ev.clientX, ev.clientY);
    if (d.kind === 'split') {
      const a = d.split.area;
      const ratio = d.split.vertical ? (y + 0.5 - a.y) / a.h : (fx - a.x) / a.w;
      this.o.onSplitDrag?.(d.split, Math.min(0.95, Math.max(0.05, ratio)));
      return;
    }
    const p = this.paneById(d.pane);
    if (!p) return;
    if (d.kind === 'mouse') {
      const c = this.inner(p, x, y);
      const key = `${c.col},${c.row}`;
      if (key === d.last) return;
      d.last = key;
      this.send(p.id, [{ t: 'mouse', mouse: { kind: 'drag', button: d.button, col: c.col, row: c.row, mods: this.mods(ev) } }]);
      return;
    }
    if (!(ev.buttons & 1)) return this.onMouseUp(ev);
    d.x = ev.clientX;
    d.y = ev.clientY;
    this.trackSelection();
  };

  private onMouseUp = (ev: MouseEvent) => {
    const d = this.drag;
    if (!d) return;
    this.drag = undefined;
    this.stopAutoScroll();
    if (d.kind === 'split') {
      const { y, fx } = this.cellAt(ev.clientX, ev.clientY);
      const a = d.split.area;
      const ratio = Math.min(0.95, Math.max(0.05, d.split.vertical ? (y + 0.5 - a.y) / a.h : (fx - a.x) / a.w));
      this.o.onSplitDrag?.(d.split, undefined);
      const tab = useSurface.getState().shown?.tab;
      if (tab) void conn.api(this.o.m(), 'layout.set_split_ratio', { tab_id: tab, path: d.split.path, ratio }).catch(() => {});
      return;
    }
    const p = this.paneById(d.pane);
    if (!p) return;
    if (d.kind === 'mouse') {
      const { x, y } = this.cellAt(ev.clientX, ev.clientY);
      const c = this.inner(p, x, y);
      this.send(p.id, [{ t: 'mouse', mouse: { kind: 'up', button: d.button, col: c.col, row: c.row, mods: this.mods(ev) } }]);
      return;
    }
    const sel = this.sel;
    if (!sel) return;
    if (sel.empty) {
      this.clearSelection();
      return;
    }
    sel.read(p, (method, params) => conn.api(this.o.m(), method, params));
  };

  /** Moves the selection's end to the pointer and scrolls while it is past
   * the pane's top or bottom edge. */
  private trackSelection() {
    const d = this.drag;
    const sel = this.sel;
    if (!d || d.kind !== 'select' || !sel) return;
    const p = this.paneById(d.pane);
    if (!p) return;
    const { y, fx } = this.cellAt(d.x, d.y);
    const top = viewTop(p.scroll);
    const row = Math.min(Math.max(y - p.inner.y, 0), p.inner.h - 1);
    let at: Point = { row: top + row, col: Math.min(p.inner.w, Math.max(0, Math.round(fx - p.inner.x))) };
    const edge = y < p.inner.y ? -1 : y >= p.inner.y + p.inner.h ? 1 : 0;
    if (edge < 0) at = { row: top, col: 0 };
    if (edge > 0) at = { row: top + p.inner.h - 1, col: p.inner.w };
    const [o1, o2] = d.origin;
    if (d.mode === 1) {
      sel.cursor = at;
    } else {
      // Word and line selections grow in whole words or lines.
      const before = at.row < o1.row || (at.row === o1.row && at.col < o1.col);
      let end = at;
      if (d.mode === 3) end = before ? { row: at.row, col: 0 } : { row: at.row, col: p.inner.w };
      else if (!edge && at.row >= top && at.row < top + p.inner.h) {
        const gy = p.inner.y + (at.row - top);
        const [a, b] = wordAt(
          grid,
          gy,
          p.inner.x,
          p.inner.x + p.inner.w,
          Math.min(p.inner.x + Math.max(at.col - (before ? 0 : 1), 0), p.inner.x + p.inner.w - 1),
        );
        end = before ? { row: at.row, col: a - p.inner.x } : { row: at.row, col: b - p.inner.x };
      }
      sel.anchor = before ? o2 : o1;
      sel.cursor = end;
    }
    this.selectionChanged();
    if (edge && p.scroll && !this.o.readOnly()) this.startAutoScroll(p.id, edge);
    else this.stopAutoScroll();
  }

  private startAutoScroll(pane: string, dir: number) {
    if (this.auto?.pane === pane && this.auto.dir === dir) return;
    this.stopAutoScroll();
    const now = performance.now();
    // One line owed: the first step scrolls at once.
    this.auto = { pane, dir, since: now, last: now, owed: 1 };
    this.auto.timer = window.setTimeout(this.autoScroll, STEP_MS);
  }

  private stopAutoScroll() {
    if (!this.auto) return;
    window.clearTimeout(this.auto.timer);
    this.auto = undefined;
  }

  /** Pixels from the pane's top (dir -1) or bottom (1) edge to a client
   * position past it; negative inside the pane. */
  private pastEdge(p: SurfacePane, clientY: number, dir: number): number {
    const top = this.canvas.getBoundingClientRect().top;
    const ch = this.metrics.ch / this.dpr;
    return dir < 0 ? top + p.inner.y * ch - clientY : clientY - (top + (p.inner.y + p.inner.h) * ch);
  }

  /** One step of scrolling while a selection drag is past an edge: the lines
   * owed since the last step go in one pane.scroll request, from the latest
   * position herdr reported. The selection follows when the scrolled
   * surface arrives (setMeta). */
  private autoScroll = () => {
    const a = this.auto;
    if (!a) return;
    a.timer = undefined;
    const d = this.drag;
    const p = this.paneById(a.pane);
    const px = d?.kind === 'select' && p ? this.pastEdge(p, d.y, a.dir) : -1;
    if (!p?.scroll || px < 0) return this.stopAutoScroll();
    const now = performance.now();
    const rate = scrollRate(px, this.metrics.ch / this.dpr, now - a.since);
    // At most half a second's worth, should herdr be slow to answer.
    a.owed = Math.min(a.owed + (rate * (now - a.last)) / 1000, Math.max(1, rate / 2));
    a.last = now;
    const lines = Math.floor(a.owed);
    if (lines > 0 && !this.scrolling) {
      const r = this.scrollReply;
      const s = r && r.pane === p.id && r.meta === this.metaCount ? r.scroll : p.scroll;
      const offset = Math.min(s.max_offset_from_bottom, Math.max(0, s.offset_from_bottom - a.dir * lines));
      if (offset === s.offset_from_bottom) {
        // At the end of the scrollback.
        a.owed = 0;
      } else {
        a.owed -= lines;
        this.scrollTo(p.id, offset);
      }
    }
    a.timer = window.setTimeout(this.autoScroll, STEP_MS);
  };

  private scrollTo(pane: string, offset: number) {
    this.scrolling = true;
    const sent = performance.now();
    void conn
      .api<{ pane?: { scroll?: ScrollInfo } }>(this.o.m(), 'pane.scroll', { pane_id: pane, offset_from_bottom: offset })
      .then((res) => {
        if (res.pane?.scroll) this.scrollReply = { pane, scroll: res.pane.scroll, meta: this.metaCount };
      })
      .catch(() => {})
      .finally(() => {
        this.scrolling = false;
        // After a slow answer the next step need not wait for the timer.
        const a = this.auto;
        if (a && performance.now() - sent >= STEP_MS) {
          window.clearTimeout(a.timer);
          this.autoScroll();
        }
      });
  }

  private onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    this.hideMath();
    if (useSurface.getState().ownership !== 'owner' || this.o.readOnly()) return;
    const { x, y } = this.cellAt(ev.clientX, ev.clientY);
    const p = this.paneAt(x, y);
    if (!p) return;
    const ch = this.metrics.ch / this.dpr;
    let delta = ev.deltaY;
    if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= ch;
    else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= ch * p.inner.h;
    this.wheelAccum += delta;
    const lines = Math.trunc(this.wheelAccum / ch);
    if (!lines) return;
    this.wheelAccum -= lines * ch;
    const c = this.inner(p, x, y);
    const mouse: PaneMouse = {
      kind: lines < 0 ? 'scrollUp' : 'scrollDown',
      col: c.col,
      row: c.row,
      mods: this.mods(ev),
      lines: Math.min(Math.abs(lines), 50),
    };
    this.send(p.id, [{ t: 'mouse', mouse }]);
    this.selectionMoved();
  };

  /** Shows links under the pointer while Cmd/Ctrl is held. */
  private lastPointer?: { x: number; y: number; meta: boolean; popover?: boolean };
  private onModifier = (ev: KeyboardEvent) => {
    if (ev.key !== 'Meta' && ev.key !== 'Control') return;
    if (this.lastPointer) {
      const at = { clientX: this.lastPointer.x, clientY: this.lastPointer.y, metaKey: ev.metaKey, ctrlKey: ev.ctrlKey };
      this.updateHover(at);
      if (!this.lastPointer.popover) this.updateMath(at);
    }
  };

  /** The link at cell (x, y) of a pane: an OSC 8 hyperlink, or a URL or
   * path in the text, also one wrapped over several rows. */
  private linkAt(p: SurfacePane, x: number, y: number): PaneLink | undefined {
    const x0 = p.inner.x;
    const x1 = p.inner.x + p.inner.w;
    if (y < p.inner.y || y >= p.inner.y + p.inner.h || x < x0 || x >= x1) return;
    const cell = grid.cell(x, y);
    const target = cell.link >= 0 ? this.meta?.links[cell.link] : undefined;
    if (target && safeUrl(target)) {
      // OSC 8 hyperlink: the run of cells with the same target.
      let a = x;
      let b = x + 1;
      while (a > x0 && grid.cell(a - 1, y).link === cell.link) a--;
      while (b < x1 && grid.cell(b, y).link === cell.link) b++;
      return { cells: [{ y, from: a, to: b }], link: { kind: 'url', text: target }, pane: p.id };
    }
    for (const l of linksAround(y, p.inner.y, p.inner.y + p.inner.h, (r) => grid.rowText(r, x0, x1)))
      if (l.cells.some((c) => c.y === y && x >= c.from && x < c.to))
        return { cells: l.cells, link: { kind: l.kind, text: l.text }, pane: p.id };
  }

  private updateHover(ev: { clientX: number; clientY: number; metaKey: boolean; ctrlKey: boolean; target?: EventTarget | null }) {
    this.lastPointer = { x: ev.clientX, y: ev.clientY, meta: ev.metaKey || ev.ctrlKey, popover: overPopover(ev.target) };
    const { x, y } = this.cellAt(ev.clientX, ev.clientY);
    const p = (ev.metaKey || ev.ctrlKey) && this.paneAt(x, y);
    const next = p ? this.linkAt(p, x, y) : undefined;
    if (linkKey(next) === linkKey(this.hover)) return;
    for (const c of this.hover?.cells ?? []) grid.dirty.add(c.y);
    for (const c of next?.cells ?? []) grid.dirty.add(c.y);
    this.hover = next;
    this.host.style.cursor = next ? 'pointer' : '';
    this.o.setTitle(next ? linkTitle(next.link) : '');
    this.schedule();
  }

  /** Shows the formula under the pointer, rendered, once the pointer rests
   * on it; not while Cmd/Ctrl shows links. Over the popover the formula
   * stays; moving off it hides it after MATH_LEAVE_MS. */
  private updateMath(ev: { clientX: number; clientY: number; metaKey?: boolean; ctrlKey?: boolean; target?: EventTarget | null }) {
    if (!this.o.onMath) return;
    const from = this.mathFrom;
    this.mathFrom = { x: ev.clientX, y: ev.clientY };
    if (overPopover(ev.target)) {
      window.clearTimeout(this.mathTimer);
      this.mathWant = this.math;
      return;
    }
    // On the way to the popover the pointer crosses rows of other formulas
    // (consecutive display formulas): the one shown stays, as long as the
    // pointer keeps heading for the popover.
    if (this.math && from && this.towardPopover(from, ev.clientX, ev.clientY)) {
      window.clearTimeout(this.mathTimer);
      this.mathWant = this.math;
      this.mathTimer = window.setTimeout(() => this.hideMath(), MATH_APPROACH_MS);
      return;
    }
    const { x, y } = this.cellAt(ev.clientX, ev.clientY);
    const p = !ev.metaKey && !ev.ctrlKey && this.o.mathHover?.() !== false && this.paneAt(x, y);
    const next = p ? this.formulaAt(p, x, y) : undefined;
    if (mathKey(next) === mathKey(this.mathWant)) return;
    if (!next) return this.leaveMath();
    this.mathWant = next;
    window.clearTimeout(this.mathTimer);
    if (mathKey(next) === mathKey(this.math)) return;
    // From one formula to the next at once; the first after a pause.
    this.mathTimer = window.setTimeout(() => void this.showMath(next), this.math ? 0 : MATH_SHOW_MS);
  }

  /** Whether a move from `from` to (x, y) stays within the triangle between
   * `from` and the edge of the popover that faces it. */
  private towardPopover(from: { x: number; y: number }, x: number, y: number): boolean {
    const el = this.host.parentElement?.querySelector('.math-popover');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    let a: [number, number];
    let b: [number, number];
    if (from.y < r.top)
      [a, b] = [
        [r.left, r.top],
        [r.right, r.top],
      ];
    else if (from.y > r.bottom)
      [a, b] = [
        [r.left, r.bottom],
        [r.right, r.bottom],
      ];
    else if (from.x < r.left)
      [a, b] = [
        [r.left, r.top],
        [r.left, r.bottom],
      ];
    else
      [a, b] = [
        [r.right, r.top],
        [r.right, r.bottom],
      ];
    return inTriangle(x, y, [from.x, from.y], a, b);
  }

  /** The pointer left the formula: it goes after MATH_LEAVE_MS. */
  private leaveMath() {
    this.mathWant = undefined;
    window.clearTimeout(this.mathTimer);
    if (this.math) this.mathTimer = window.setTimeout(() => this.setMath(undefined), MATH_LEAVE_MS);
  }

  private formulaAt(p: SurfacePane, x: number, y: number): PaneMath | undefined {
    const x0 = p.inner.x;
    const x1 = p.inner.x + p.inner.w;
    if (y < p.inner.y || y >= p.inner.y + p.inner.h || x < x0 || x >= x1) return;
    const m = mathAt(x, y, p.inner.y, p.inner.y + p.inner.h, (r) => grid.rowText(r, x0, x1));
    return m && { pane: p.id, cells: m.cells, tex: m.tex, display: m.display };
  }

  private async showMath(want: PaneMath) {
    const html = await renderMath(want.tex, want.display);
    if (this.disposed || mathKey(this.mathWant) !== mathKey(want)) return;
    // Not a formula after all (KaTeX cannot read it): nothing is shown.
    this.setMath(html ? { ...want, html } : undefined);
  }

  private setMath(m: ShownMath | undefined) {
    if (mathKey(m) === mathKey(this.math)) return;
    for (const c of this.math?.cells ?? []) grid.dirty.add(c.y);
    for (const c of m?.cells ?? []) grid.dirty.add(c.y);
    this.math = m;
    this.o.onMath?.(m);
    this.schedule();
  }

  /** Hides the formula shown: typing, clicking and scrolling move on. */
  private hideMath() {
    window.clearTimeout(this.mathTimer);
    this.mathWant = undefined;
    this.setMath(undefined);
  }

  private onMouseLeave = (ev: MouseEvent) => {
    if (!overPopover(ev.relatedTarget)) this.leaveMath();
  };

  /** Paint compares the rows' highlights with what they were painted with. */
  private selectionChanged() {
    const sel = this.sel;
    if (sel) {
      sel.text = undefined;
      sel.reading = undefined;
    }
    this.schedule();
  }

  /** The view may have moved under a selection (typing returns herdr to
   * the live bottom); the metadata that follows repaints it. */
  private selectionMoved() {
    if (this.sel) this.schedule();
  }

  clearSelection() {
    if (!this.sel) return;
    this.sel = undefined;
    this.schedule();
  }

  /** The selected text (for tests and the debug handle). */
  selectionText(): string | undefined {
    const sel = this.sel;
    const p = sel && this.paneById(sel.pane);
    return sel && p ? (sel.text ?? sel.visibleText(p, grid)) : undefined;
  }

  dispose() {
    this.disposed = true;
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = undefined;
    this.preedit.remove();
    onPaint(undefined);
    this.unsubscribe();
    this.unsubscribeFind();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.stopAutoScroll();
    this.ro.disconnect();
    this.host.removeEventListener('mousedown', this.onMouseDown);
    this.host.removeEventListener('wheel', this.onWheel);
    this.host.removeEventListener('contextmenu', this.onContextMenu);
    this.host.removeEventListener('dragover', this.onDragOver);
    this.host.removeEventListener('dragleave', this.onDragLeave);
    this.host.removeEventListener('drop', this.onDrop);
    this.host.removeEventListener('mouseleave', this.onMouseLeave);
    window.clearTimeout(this.mathTimer);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('keydown', this.onModifier);
    window.removeEventListener('keyup', this.onModifier);
  }
}

function writeClipboard(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

/** A copy right after the release copied the visible part: all of it goes
 * on the clipboard once herdr's text arrives. */
function copyWhenRead(sel: Selection) {
  if (sel.text === undefined)
    void sel.reading?.then((t) => {
      if (t) writeClipboard(t);
    });
}
