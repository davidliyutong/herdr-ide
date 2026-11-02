// SurfaceController draws the shown tab's surface on a canvas and turns the
// browser's input into herdr pane input.
//
// herdr renders the whole tab (panes, borders, split lines) into one cell
// grid at the size this browser asks for; the controller paints it, measures
// the cell size from the terminal font, and maps keys, text, pastes, mouse
// and wheel events to the pane under them. Selections are local to one pane
// (see selection.ts) unless the pane's program reports the mouse.

import { conn } from '../lib/conn';
import { grid, onPaint, sendFocus, sendInput, useSurface } from './session';
import { palette as makePalette, rgb, type Palette } from './colors';
import { paintRows, type Metrics } from './paint';
import { routeKey } from './keys';
import { pasteText, releaseOf, type InputEvent, type KeyEvent, type MouseEvent as PaneMouse } from './input';
import { Selection, stepLines, viewTop, wordAt, type Point } from './selection';
import type { SurfaceMeta, SurfacePane, SurfaceSplit } from './protocol';
import { findLinks, openLink, linkTitle, safeUrl, type LinkContext } from '../terminal/links';
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
  linkContext(pane: string): LinkContext;
  /** The grid size that fits, in cells, the cell size in device pixels and
   * the device pixel ratio it was measured at. */
  onSize(cols: number, rows: number, cw: number, ch: number, dpr: number): void;
  onSplitDrag?(split: SurfaceSplit, ratio: number | undefined): void;
  setTitle(title: string): void;
}

/** Pause between scroll steps while a selection drag is past an edge. */
const STEP_MS = 40;

export class SurfaceController {
  private ctx: CanvasRenderingContext2D;
  private metrics!: Metrics;
  private palette!: Palette;
  private appearance!: Appearance;
  private meta?: SurfaceMeta;
  private frame?: number;
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
  private stepTimer?: number;
  private wheelAccum = 0;
  private hover?: { y: number; from: number; to: number; link: { kind: 'url' | 'path'; text: string }; pane: string };
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
    this.meta = meta;
    if (this.sel && !this.paneById(this.sel.pane)) this.clearSelection();
    if (prev?.w !== meta?.w || prev?.h !== meta?.h) grid.invalidate();
    // Scroll positions move a selection's rows.
    if (this.sel) grid.invalidate();
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
        highlight: (y) => this.highlight(y),
        hover: this.hover,
      },
      rows,
    );
    this.placeTextarea();
  }

  private highlight(y: number): Array<[number, number]> | undefined {
    const sel = this.sel;
    if (!sel) return;
    const p = this.paneById(sel.pane);
    const c = p && sel.columns(p, y);
    return c ? [c] : undefined;
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
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('keydown', this.onModifier);
    window.addEventListener('keyup', this.onModifier);
  }

  private onKeyDown = (ev: KeyboardEvent) => {
    const pane = this.targetPane();
    const route = routeKey(
      ev,
      (e) => this.o.appKey(e),
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
      void this.o.onPasteFiles(files).then((text) => text && this.send(pane, [{ t: 'text', text }]));
      return;
    }
    const text = dt.getData('text/plain');
    if (text) this.send(pane, [{ t: 'paste', text: pasteText(text) }]);
  };

  private onCopy = (ev: ClipboardEvent) => {
    const sel = this.sel;
    const p = sel && this.paneById(sel.pane);
    if (!sel || !p || sel.empty) return;
    ev.preventDefault();
    const text = sel.text ?? sel.visibleText(p, grid);
    ev.clipboardData?.setData('text/plain', text);
    // Copied right after the release: all of it once herdr's text arrives.
    if (sel.text === undefined)
      void sel.reading?.then((t) => {
        if (t) navigator.clipboard?.writeText(t).catch(() => {});
      });
  };

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
    // The browser's menu (Copy) for selections; programs reporting the mouse
    // get the right button instead.
    const { x, y } = this.cellAt(ev.clientX, ev.clientY);
    const p = this.paneAt(x, y);
    if (p?.mouse && !ev.shiftKey) ev.preventDefault();
  };

  private onMouseDown = (ev: MouseEvent) => {
    // Buttons over the grid (a pane's close button) handle their own clicks;
    // the program under them must not get one.
    if ((ev.target as Element | null)?.closest?.('button')) return;
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
    if (p.mouse && !ev.shiftKey && !this.o.readOnly()) {
      this.clearSelection();
      // herdr's buttons: 0 left, 1 right, 2 middle.
      const button = ev.button === 1 ? 2 : ev.button === 2 ? 1 : 0;
      this.drag = { kind: 'mouse', pane: p.id, button, last: `${c.col},${c.row}` };
      this.send(p.id, [{ t: 'mouse', mouse: { kind: 'down', button, col: c.col, row: c.row, mods: this.mods(ev) } }]);
      return;
    }
    if (ev.button === 2) return; // keeps the selection for the browser's menu
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
    window.clearTimeout(this.stepTimer);
    this.stepTimer = undefined;
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
    if (edge && this.stepTimer === undefined && !this.o.readOnly()) this.stepTimer = window.setTimeout(() => this.step(edge), STEP_MS);
  }

  private step = (dir: number) => {
    const d = this.drag;
    const p = d && d.kind === 'select' ? this.paneById(d.pane) : undefined;
    const s = p?.scroll;
    if (!d || d.kind !== 'select' || !p || !s) {
      this.stepTimer = undefined;
      return;
    }
    const { y } = this.cellAt(d.x, d.y);
    const past = dir < 0 ? p.inner.y - y : y - (p.inner.y + p.inner.h - 1);
    if (past <= 0) {
      this.stepTimer = undefined;
      return;
    }
    const lines = stepLines(past * (this.metrics.ch / this.dpr), this.metrics.ch / this.dpr);
    const offset = Math.min(s.max_offset_from_bottom, Math.max(0, s.offset_from_bottom - dir * lines));
    const next = () => {
      this.stepTimer = undefined;
      if (this.drag === d) this.trackSelection();
    };
    if (offset === s.offset_from_bottom) {
      this.stepTimer = window.setTimeout(next, STEP_MS);
      return;
    }
    void conn
      .api<{ pane?: { scroll?: SurfacePane['scroll'] } }>(this.o.m(), 'pane.scroll', { pane_id: p.id, offset_from_bottom: offset })
      .then((res) => {
        // The surface's metadata follows; use the reply meanwhile.
        if (res.pane?.scroll && this.paneById(p.id)) this.paneById(p.id)!.scroll = res.pane.scroll;
      })
      .catch(() => {})
      .finally(() => {
        this.stepTimer = window.setTimeout(next, STEP_MS);
      });
  };

  private onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
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
  private lastPointer?: { x: number; y: number; meta: boolean };
  private onModifier = (ev: KeyboardEvent) => {
    if (ev.key !== 'Meta' && ev.key !== 'Control') return;
    if (this.lastPointer)
      this.updateHover({ clientX: this.lastPointer.x, clientY: this.lastPointer.y, metaKey: ev.metaKey, ctrlKey: ev.ctrlKey });
  };

  private updateHover(ev: { clientX: number; clientY: number; metaKey: boolean; ctrlKey: boolean }) {
    this.lastPointer = { x: ev.clientX, y: ev.clientY, meta: ev.metaKey || ev.ctrlKey };
    let next: SurfaceController['hover'];
    const { x, y } = this.cellAt(ev.clientX, ev.clientY);
    const p = (ev.metaKey || ev.ctrlKey) && this.paneAt(x, y);
    if (p && y >= p.inner.y && y < p.inner.y + p.inner.h && x >= p.inner.x && x < p.inner.x + p.inner.w) {
      const cell = grid.cell(x, y);
      if (cell.link >= 0 && this.meta?.links[cell.link] && safeUrl(this.meta.links[cell.link])) {
        // OSC 8 hyperlink: the run of cells with the same target.
        let a = x;
        let b = x + 1;
        while (a > p.inner.x && grid.cell(a - 1, y).link === cell.link) a--;
        while (b < p.inner.x + p.inner.w && grid.cell(b, y).link === cell.link) b++;
        next = { y, from: a, to: b, link: { kind: 'url', text: this.meta.links[cell.link] }, pane: p.id };
      } else {
        const { text, colOf } = grid.rowText(y, p.inner.x, p.inner.x + p.inner.w);
        for (const l of findLinks(text)) {
          const from = colOf[l.start];
          const last = colOf[l.end - 1];
          const to = last + grid.width(last, y);
          if (x >= from && x < to) next = { y, from, to, link: l, pane: p.id };
        }
      }
    }
    const same = next?.y === this.hover?.y && next?.from === this.hover?.from && next?.to === this.hover?.to;
    if (same) return;
    if (this.hover) grid.dirty.add(this.hover.y);
    if (next) grid.dirty.add(next.y);
    this.hover = next;
    this.host.style.cursor = next ? 'pointer' : '';
    this.o.setTitle(next ? linkTitle(next.link) : '');
    this.schedule();
  }

  private selectionChanged() {
    const sel = this.sel;
    if (sel) {
      sel.text = undefined;
      sel.reading = undefined;
    }
    grid.invalidate();
    this.schedule();
  }

  /** The view may have moved under a selection (typing returns herdr to
   * the live bottom); the metadata that follows repaints it. */
  private selectionMoved() {
    if (this.sel) grid.invalidate();
  }

  clearSelection() {
    if (!this.sel) return;
    this.sel = undefined;
    grid.invalidate();
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
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    window.clearTimeout(this.stepTimer);
    this.ro.disconnect();
    this.host.removeEventListener('mousedown', this.onMouseDown);
    this.host.removeEventListener('wheel', this.onWheel);
    this.host.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('keydown', this.onModifier);
    window.removeEventListener('keyup', this.onModifier);
  }
}
