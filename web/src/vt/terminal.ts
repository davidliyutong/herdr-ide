// One terminal emulated by libghostty-vt (module.ts): the program's output
// goes in with write, the screen comes out as rows of cells (update fills a
// Frame with the rows that changed), and the browser's keys, mouse, pastes
// and focus come out as the bytes the program asked for. Selections, find
// and hyperlinks are the library's too.

import { NO_VALUE, OUT_OF_SPACE, SUCCESS, type Vt } from './module';

/** Style flags of a cell, as the renderer reads them. */
export const F_BOLD = 1;
export const F_ITALIC = 2;
export const F_FAINT = 4;
export const F_BLINK = 8;
export const F_INVERSE = 16;
export const F_INVISIBLE = 32;
export const F_STRIKE = 64;
export const F_OVERLINE = 128;
/** Underline style in bits 8-10: 0 none, 1 single, 2 double, 3 curly, 4 dotted, 5 dashed. */
export const UNDERLINE_SHIFT = 8;

export const WIDE_NARROW = 0;
export const WIDE_WIDE = 1;
/** The cell after a wide character, covered by it. */
export const WIDE_TAIL = 2;
/** A wide character that did not fit at a row's end wrapped; this cell is empty. */
export const WIDE_HEAD = 3;

/** One row of the screen. Colors are 0xRRGGBB, -1 for the terminal's default. */
export interface Row {
  /** The first codepoint of each cell, 0 for none. */
  codes: Uint32Array;
  /** The whole grapheme cluster where a cell has more than one codepoint. */
  text: Array<string | undefined>;
  wide: Uint8Array;
  fg: Int32Array;
  bg: Int32Array;
  /** Underline color, -1 for the text's. */
  ul: Int32Array;
  flags: Uint16Array;
  /** The cell is part of an OSC 8 hyperlink. */
  link: Uint8Array;
  /** Selected columns, both included. */
  sel: [number, number] | null;
  /** The row's text goes on in the next row (soft wrap). */
  wrap: boolean;
}

export type CursorStyle = 'block' | 'bar' | 'underline' | 'hollow';

export interface Cursor {
  x: number;
  y: number;
  /** Shown at all (the program may hide it), and in the viewport. */
  visible: boolean;
  blinking: boolean;
  style: CursorStyle;
  /** On the second cell of a wide character. */
  wideTail: boolean;
}

export interface FrameColors {
  fg: number;
  bg: number;
  /** The cursor's color, -1 for the foreground. */
  cursor: number;
  palette: number[];
}

/** The screen as the renderer draws it, updated in place. */
export interface Frame {
  cols: number;
  rows: number;
  lines: Row[];
  /** Rows changed since the renderer last drew them. */
  dirty: Set<number>;
  cursor: Cursor;
  colors: FrameColors;
}

export function newRow(cols: number): Row {
  return {
    codes: new Uint32Array(cols),
    text: new Array(cols),
    wide: new Uint8Array(cols),
    fg: new Int32Array(cols).fill(-1),
    bg: new Int32Array(cols).fill(-1),
    ul: new Int32Array(cols).fill(-1),
    flags: new Uint16Array(cols),
    link: new Uint8Array(cols),
    sel: null,
    wrap: false,
  };
}

export function newFrame(cols: number, rows: number): Frame {
  return {
    cols,
    rows,
    lines: Array.from({ length: rows }, () => newRow(cols)),
    dirty: new Set(Array.from({ length: rows }, (_, i) => i)),
    cursor: { x: 0, y: 0, visible: false, blinking: false, style: 'block', wideTail: false },
    colors: { fg: 0xffffff, bg: 0, cursor: -1, palette: [] },
  };
}

/** The text of a row's cells [from, to), wide characters once. */
export function rowText(r: Row, from = 0, to = r.codes.length): string {
  let s = '';
  for (let x = from; x < to; x++) {
    if (r.wide[x] === WIDE_TAIL || r.wide[x] === WIDE_HEAD) continue;
    s += r.text[x] ?? (r.codes[x] ? String.fromCodePoint(r.codes[x]) : ' ');
  }
  return s;
}

/** A key as the encoder takes it (vt/input.ts makes it from a KeyboardEvent). */
export interface KeyInput {
  action: 'press' | 'repeat' | 'release';
  /** KeyboardEvent.code. */
  code: string;
  /** MODS_* bits. */
  mods: number;
  /** Modifiers the layout used to produce the text (Shift for "A"). */
  consumed?: number;
  /** The text the key types without Ctrl or Alt, "" for none. */
  text?: string;
  /** The key's character without Shift, 0 for none. */
  unshifted?: number;
  /** macOS: Option acts as Alt. */
  optionAsAlt?: boolean;
}

export const MODS_SHIFT = 1;
export const MODS_CTRL = 2;
export const MODS_ALT = 4;
export const MODS_SUPER = 8;

export type MouseAction = 'press' | 'release' | 'motion';

export interface MouseInput {
  action: MouseAction;
  /** 1 left, 2 right, 3 middle, 4/5 wheel up/down, 6/7 wheel left/right; 0 none (motion). */
  button: number;
  mods: number;
  /** Position in surface pixels (device pixels). */
  x: number;
  y: number;
  /** A button is held during the motion. */
  held?: boolean;
}

export interface TerminalColors {
  fg: number;
  bg: number;
  cursor: number;
  /** The 16 ANSI colors; the rest of the 256 are the standard cube and grays. */
  palette: number[];
}

export interface TerminalCallbacks {
  /** The terminal's own answers to the program (device attributes, cursor
   * position, colors, modes). */
  reply?(data: Uint8Array): void;
  bell?(): void;
  title?(title: string): void;
  /** A program writes the clipboard (OSC 52). True accepts it. */
  clipboard?(text: string): boolean;
  /** Whether the UI is dark, for CSI ? 996 n. */
  dark?(): boolean;
  /** Synchronized output began or ended. */
  hold?(held: boolean): void;
}

/** The 256 colors from 16: the 6x6x6 cube and 24 grays, as xterm has them. */
export function palette256(ansi: number[]): number[] {
  const out = ansi.slice(0, 16);
  const level = (v: number) => (v ? 55 + v * 40 : 0);
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) out.push((level(r) << 16) | (level(g) << 8) | level(b));
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    out.push((v << 16) | (v << 8) | v);
  }
  return out;
}

const cursorStyles: CursorStyle[] = ['bar', 'block', 'underline', 'hollow'];

/** GhosttyKey's name for a KeyboardEvent.code ("ArrowUp" → "ARROW_UP"). */
export function keyName(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  if (code === 'OSLeft') return 'META_LEFT';
  if (code === 'OSRight') return 'META_RIGHT';
  return code.replace(/([a-z])([A-Z0-9])/g, '$1_$2').toUpperCase();
}

interface StyleInfo {
  fg: number;
  bg: number;
  ul: number;
  flags: number;
  fgIndex: number;
}

/** Bits of a packed 64-bit value held as two 32-bit halves. */
function bitsOf(lo: number, hi: number, lsb: number, width: number): number {
  let v: number;
  if (lsb >= 32) v = hi >>> (lsb - 32);
  else if (lsb + width <= 32) v = lo >>> lsb;
  else v = (lo >>> lsb) | (hi << (32 - lsb));
  return width >= 32 ? v >>> 0 : v & ((1 << width) - 1);
}

export class Terminal {
  cols: number;
  rows: number;
  private readonly t: number;
  private readonly rs: number;
  private readonly iter: number;
  private readonly cells: number;
  private keyEncoder = 0;
  private keyEvent = 0;
  private mouseEncoder = 0;
  private mouseEvent = 0;
  private search = 0;
  private gesture = 0;
  private readonly gestureEvents: Record<string, number> = {};
  /** Scratch memory for out-values (one block, reused). */
  private readonly scratch: number;
  private static readonly SCRATCH = 4096;
  /** Text of the last key, kept alive until the next (the event borrows it). */
  private keyText = 0;
  private keyTextLen = 0;
  private cellW = 1;
  private cellH = 1;
  private boldIsBright = false;
  private disposed = false;
  private readonly bits: Record<string, { lsb: number; width: number }>;
  private readonly flagBits: Array<[number, { lsb: number; width: number }]>;
  private readonly ulBits: { lsb: number; width: number };
  private titleText = '';

  constructor(
    private readonly vt: Vt,
    cols: number,
    rows: number,
    private readonly cb: TerminalCallbacks = {},
  ) {
    this.cols = cols;
    this.rows = rows;
    const f = (n: string) => vt.fn(n);
    this.t = vt.handle((slot) => f('ghostty_terminal_new')(0, slot, cols, rows));
    this.rs = vt.handle((slot) => f('ghostty_render_state_new')(0, slot));
    this.iter = vt.handle((slot) => f('ghostty_render_state_row_iterator_new')(0, slot));
    this.cells = vt.handle((slot) => f('ghostty_render_state_row_cells_new')(0, slot));
    this.scratch = vt.alloc(Terminal.SCRATCH);
    this.bits = {
      tag: vt.bits('GhosttyCell', 'content_tag'),
      content: vt.bits('GhosttyCell', 'content'),
      style: vt.bits('GhosttyCell', 'style_id'),
      wide: vt.bits('GhosttyCell', 'wide'),
      link: vt.bits('GhosttyCell', 'hyperlink'),
    };
    const fb = (name: string) => vt.bits('GhosttyStyleFlags', name);
    this.flagBits = [
      [F_BOLD, fb('bold')],
      [F_ITALIC, fb('italic')],
      [F_FAINT, fb('faint')],
      [F_BLINK, fb('blink')],
      [F_INVERSE, fb('inverse')],
      [F_INVISIBLE, fb('invisible')],
      [F_STRIKE, fb('strikethrough')],
      [F_OVERLINE, fb('overline')],
    ];
    this.ulBits = fb('underline');
    vt.register(this.t, {
      writePty: (data) => this.cb.reply?.(data),
      bell: () => this.cb.bell?.(),
      titleChanged: () => {
        this.titleText = this.readString('TITLE');
        this.cb.title?.(this.titleText);
      },
      clipboardWrite: (req) => this.clipboardWrite(req),
      colorScheme: () => this.cb.dark?.(),
      size: (out) => this.sizeReport(out),
      renderHold: (held) => this.cb.hold?.(held),
    });
    for (const opt of ['WRITE_PTY', 'BELL', 'TITLE_CHANGED', 'CLIPBOARD_WRITE', 'COLOR_SCHEME', 'SIZE', 'RENDER_HOLD'])
      this.setOpt(opt, vt.callbackIndex[opt]);
    // Grapheme clusters take the width Unicode gives them (mode 2027), as
    // in Ghostty's application.
    const M = 'GhosttyTerminalModeConfig';
    this.setWith('MODE_DEFAULT', vt.size(M), (dv, p) => {
      dv.setUint16(p + vt.off(M, 'mode'), 2027, true);
      dv.setUint8(p + vt.off(M, 'value'), 1);
    });
  }

  private x(name: string) {
    return this.vt.fn(name);
  }

  /** ghostty_terminal_set with a callback index or a pointer. */
  private setOpt(name: string, value: number) {
    const r = this.x('ghostty_terminal_set')(this.t, this.vt.enumValue('GhosttyTerminalOption', name), value);
    if (r !== SUCCESS) throw new Error(`libghostty-vt: terminal option ${name}: ${r}`);
  }

  /** Sets an option from a value written into scratch memory. */
  private setWith(name: string, size: number, write: (dv: DataView, p: number) => void) {
    const p = this.scratch;
    this.vt.u8().fill(0, p, p + size);
    write(this.vt.dv(), p);
    this.setOpt(name, p);
  }

  private get(data: string, out: number): number {
    return this.x('ghostty_terminal_get')(this.t, this.vt.enumValue('GhosttyTerminalData', data), out);
  }

  private readString(data: string): string {
    const p = this.scratch;
    return this.get(data, p) === SUCCESS ? this.vt.string(p) : '';
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const vt = this.vt;
    vt.unregister(this.t);
    if (this.search) this.x('ghostty_search_free')(this.search);
    if (this.gesture) this.x('ghostty_selection_gesture_free')(this.gesture, this.t);
    for (const e of Object.values(this.gestureEvents)) this.x('ghostty_selection_gesture_event_free')(e);
    if (this.keyEvent) this.x('ghostty_key_event_free')(this.keyEvent);
    if (this.keyEncoder) this.x('ghostty_key_encoder_free')(this.keyEncoder);
    if (this.mouseEvent) this.x('ghostty_mouse_event_free')(this.mouseEvent);
    if (this.mouseEncoder) this.x('ghostty_mouse_encoder_free')(this.mouseEncoder);
    vt.free(this.keyText, this.keyTextLen);
    this.x('ghostty_render_state_row_cells_free')(this.cells);
    this.x('ghostty_render_state_row_iterator_free')(this.iter);
    this.x('ghostty_render_state_free')(this.rs);
    this.x('ghostty_terminal_free')(this.t);
    vt.free(this.scratch, Terminal.SCRATCH);
    if (this.inBuf) vt.free(this.inBuf, this.inCap);
    this.inBuf = 0;
    this.inCap = 0;
  }

  // ---- output and configuration ----

  private inBuf = 0;
  private inCap = 0;

  /** Feeds the program's output. Callbacks run during the call. */
  write(data: Uint8Array) {
    if (!data.length || this.disposed) return;
    if (data.length > this.inCap) {
      this.vt.free(this.inBuf, this.inCap);
      this.inCap = Math.max(data.length, 64 * 1024);
      this.inBuf = this.vt.alloc(this.inCap);
    }
    this.vt.u8().set(data, this.inBuf);
    this.x('ghostty_terminal_vt_write')(this.t, this.inBuf, data.length);
  }

  /** Feeds text (tests). */
  writeText(text: string) {
    this.write(this.vt.encode(text));
  }

  /** Changes the grid; the cell size answers size reports and places the mouse. */
  resize(cols: number, rows: number, cellW = this.cellW, cellH = this.cellH) {
    this.cellW = Math.max(1, Math.round(cellW));
    this.cellH = Math.max(1, Math.round(cellH));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.x('ghostty_terminal_resize')(this.t, cols, rows, this.cellW, this.cellH);
    this.mouseSize();
  }

  /** The colors programs see and use by default (OSC 10/11/4 answer them). */
  setColors(c: TerminalColors) {
    const rgb = (dv: DataView, p: number, v: number) => {
      dv.setUint8(p, (v >> 16) & 0xff);
      dv.setUint8(p + 1, (v >> 8) & 0xff);
      dv.setUint8(p + 2, v & 0xff);
    };
    this.setWith('COLOR_FOREGROUND', 3, (dv, p) => rgb(dv, p, c.fg));
    this.setWith('COLOR_BACKGROUND', 3, (dv, p) => rgb(dv, p, c.bg));
    this.setWith('COLOR_CURSOR', 3, (dv, p) => rgb(dv, p, c.cursor));
    const pal = palette256(c.palette);
    this.setWith('COLOR_PALETTE', 256 * 3, (dv, p) => pal.forEach((v, i) => rgb(dv, p + i * 3, v)));
  }

  setBoldIsBright(on: boolean) {
    this.boldIsBright = on;
  }

  /** Lines kept above the screen; the library bounds history by bytes too. */
  setScrollback(lines: number) {
    const n = Math.max(0, Math.floor(lines));
    this.setWith('SCROLLBACK_MAX_LINES', 4, (dv, p) => dv.setUint32(p, n, true));
    // About 2 KiB a line.
    this.setWith('SCROLLBACK_MAX_BYTES', 4, (dv, p) => dv.setUint32(p, Math.min(0xffffffff, Math.max(1, n) * 2048), true));
  }

  /** The cursor a program's reset (CSI 0 q) returns to. */
  setCursorDefaults(style: 'block' | 'bar' | 'underline', blink: boolean) {
    const v = this.vt.enumValue('GhosttyCursorStyle', style === 'bar' ? 'BAR' : style === 'underline' ? 'UNDERLINE' : 'BLOCK');
    this.setWith('DEFAULT_CURSOR_STYLE', 4, (dv, p) => dv.setInt32(p, v, true));
    this.setWith('DEFAULT_CURSOR_BLINK', 1, (dv, p) => dv.setUint8(p, blink ? 1 : 0));
  }

  get title(): string {
    return this.titleText;
  }

  private sizeReport(out: number): boolean {
    const vt = this.vt;
    const dv = vt.dv();
    const t = 'GhosttySizeReportSize';
    dv.setUint16(out + vt.off(t, 'rows'), this.rows, true);
    dv.setUint16(out + vt.off(t, 'columns'), this.cols, true);
    dv.setUint32(out + vt.off(t, 'cell_width'), this.cellW, true);
    dv.setUint32(out + vt.off(t, 'cell_height'), this.cellH, true);
    return true;
  }

  private clipboardWrite(req: number) {
    const vt = this.vt;
    const dv = vt.dv();
    const W = 'GhosttyClipboardWrite';
    const contents = dv.getUint32(req + vt.off(W, 'contents'), true);
    const count = dv.getUint32(req + vt.off(W, 'contents_len'), true);
    const C = 'GhosttyClipboardContent';
    let text: string | undefined;
    for (let i = 0; i < count; i++) {
      const c = contents + i * vt.size(C);
      const mime = vt.string(c + vt.off(C, 'mime'));
      if (!mime || mime.startsWith('text/plain')) {
        text = vt.string(c + vt.off(C, 'data'));
        break;
      }
    }
    const ok = text !== undefined && !!this.cb.clipboard?.(text);
    const R = 'GhosttyClipboardWriteReply';
    const reply = this.scratch;
    vt.u8().fill(0, reply, reply + vt.size(R));
    dv.setUint32(reply + vt.off(R, 'size'), vt.size(R), true);
    dv.setInt32(reply + vt.off(R, 'result'), vt.enumValue('GhosttyClipboardWriteResult', ok ? 'SUCCESS' : 'DENIED'), true);
    vt.call(dv.getUint32(req + vt.off(W, 'reply'), true), req, reply);
  }

  // ---- state ----

  /** A terminal mode (DEC private unless ansi). */
  mode(value: number, ansi = false): boolean {
    const vt = this.vt;
    const p = this.scratch;
    const T = 'GhosttyTerminalModeConfig';
    vt.u8().fill(0, p, p + vt.size(T));
    vt.dv().setUint16(p + vt.off(T, 'mode'), (value & 0x7fff) | (ansi ? 0x8000 : 0), true);
    if (this.get('MODE', p) !== SUCCESS) return false;
    return vt.dv().getUint8(p + vt.off(T, 'value')) !== 0;
  }

  /** The program asked for mouse events. */
  get mouseTracking(): boolean {
    return this.get('MOUSE_TRACKING', this.scratch) === SUCCESS && this.vt.dv().getUint8(this.scratch) !== 0;
  }

  get altScreen(): boolean {
    return (
      this.get('ACTIVE_SCREEN', this.scratch) === SUCCESS &&
      this.vt.dv().getInt32(this.scratch, true) === this.vt.enumValue('GhosttyTerminalScreen', 'ALTERNATE')
    );
  }

  /** Scrollback position: total rows, the first row shown, rows shown. */
  scrollbar(): { total: number; offset: number; len: number } {
    const vt = this.vt;
    const p = this.scratch;
    if (this.get('SCROLLBAR', p) !== SUCCESS) return { total: this.rows, offset: 0, len: this.rows };
    const dv = vt.dv();
    const T = 'GhosttyTerminalScrollbar';
    const n = (f: string) => Number(dv.getBigUint64(p + vt.off(T, f), true));
    return { total: n('total'), offset: n('offset'), len: n('len') };
  }

  /** Scrolls the view by rows (negative is up), or to the top or bottom. */
  scroll(by: number | 'top' | 'bottom') {
    const vt = this.vt;
    const T = 'GhosttyTerminalScrollViewport';
    const p = this.scratch;
    vt.u8().fill(0, p, p + vt.size(T));
    const dv = vt.dv();
    const tag = by === 'top' ? 'TOP' : by === 'bottom' ? 'BOTTOM' : 'DELTA';
    dv.setInt32(p + vt.off(T, 'tag'), vt.enumValue('GhosttyTerminalScrollViewportTag', tag), true);
    if (typeof by === 'number') dv.setInt32(p + vt.off(T, 'value'), Math.trunc(by), true);
    this.x('ghostty_terminal_scroll_viewport')(this.t, p);
  }

  /** The view shows the newest rows. */
  get atBottom(): boolean {
    const s = this.scrollbar();
    return s.offset + s.len >= s.total;
  }

  // ---- render state ----

  /** Brings a frame up to date: the rows that changed, the cursor, the colors.
   * Returns whether anything changed. */
  update(frame: Frame): boolean {
    const vt = this.vt;
    const x = (n: string) => vt.fn(n);
    x('ghostty_render_state_update')(this.rs, this.t);
    const p = this.scratch;
    const dv = () => vt.dv();
    const RD = (n: string) => vt.enumValue('GhosttyRenderStateData', n);
    x('ghostty_render_state_get')(this.rs, RD('DIRTY'), p);
    const dirty = dv().getInt32(p, true);
    let changed = dirty !== vt.enumValue('GhosttyRenderStateDirty', 'FALSE');
    if (frame.cols !== this.cols || frame.rows !== this.rows) {
      frame.cols = this.cols;
      frame.rows = this.rows;
      frame.lines = Array.from({ length: this.rows }, () => newRow(this.cols));
      changed = true;
    }
    // Colors.
    const C = 'GhosttyRenderStateColors';
    vt.u8().fill(0, p, p + vt.size(C));
    dv().setUint32(p + vt.off(C, 'size'), vt.size(C), true);
    x('ghostty_render_state_get')(this.rs, RD('COLORS'), p);
    const rgbAt = (q: number) => {
      const u = vt.u8();
      return (u[q] << 16) | (u[q + 1] << 8) | u[q + 2];
    };
    const colors = frame.colors;
    const bg = rgbAt(p + vt.off(C, 'background'));
    const fg = rgbAt(p + vt.off(C, 'foreground'));
    const cursor = dv().getUint8(p + vt.off(C, 'cursor_has_value')) ? rgbAt(p + vt.off(C, 'cursor')) : -1;
    const palOff = p + vt.off(C, 'palette');
    let paletteChanged = colors.palette.length !== 256;
    const pal = colors.palette.length === 256 ? colors.palette : new Array<number>(256);
    for (let i = 0; i < 256; i++) {
      const v = rgbAt(palOff + i * 3);
      if (pal[i] !== v) {
        pal[i] = v;
        paletteChanged = true;
      }
    }
    if (paletteChanged || colors.fg !== fg || colors.bg !== bg || colors.cursor !== cursor) {
      frame.colors = { fg, bg, cursor, palette: pal };
      changed = true;
    }
    // Cursor.
    const K = 'GhosttyRenderStateCursor';
    vt.u8().fill(0, p, p + vt.size(K));
    dv().setUint32(p + vt.off(K, 'size'), vt.size(K), true);
    x('ghostty_render_state_get')(this.rs, RD('CURSOR'), p);
    const d = dv();
    const inView = d.getUint8(p + vt.off(K, 'viewport_has_value')) !== 0;
    const next: Cursor = {
      x: inView ? d.getUint16(p + vt.off(K, 'viewport_x'), true) : 0,
      y: inView ? d.getUint16(p + vt.off(K, 'viewport_y'), true) : 0,
      visible: inView && d.getUint8(p + vt.off(K, 'visible')) !== 0,
      blinking: d.getUint8(p + vt.off(K, 'blinking')) !== 0,
      style: cursorStyles[d.getInt32(p + vt.off(K, 'visual_style'), true)] ?? 'block',
      wideTail: inView && d.getUint8(p + vt.off(K, 'wide_tail')) !== 0,
    };
    const c = frame.cursor;
    if (c.x !== next.x || c.y !== next.y || c.visible !== next.visible || c.blinking !== next.blinking || c.style !== next.style) {
      if (c.y < frame.rows) frame.dirty.add(c.y);
      if (next.y < frame.rows) frame.dirty.add(next.y);
      frame.cursor = next;
      changed = true;
    }
    if (!changed) return false;
    // Rows.
    const slot = this.scratch + 64;
    dv().setUint32(slot, this.iter, true);
    x('ghostty_render_state_get')(this.rs, RD('ROW_ITERATOR'), slot);
    const ypos = this.scratch + 72;
    const nextDirty = x('ghostty_render_state_row_iterator_next_dirty');
    while (nextDirty(this.iter, ypos)) {
      const y = dv().getUint16(ypos, true);
      if (y >= frame.rows) continue;
      this.readRow(frame.lines[y], frame.colors.palette);
      frame.dirty.add(y);
    }
    x('ghostty_render_state_clean')(this.rs);
    return true;
  }

  private readRow(row: Row, pal: number[]) {
    const vt = this.vt;
    const x = (n: string) => vt.fn(n);
    const RR = (n: string) => vt.enumValue('GhosttyRenderStateRowData', n);
    const base = this.scratch + 128;
    // Selection.
    const S = 'GhosttyRenderStateRowSelection';
    vt.u8().fill(0, base, base + vt.size(S));
    vt.dv().setUint32(base + vt.off(S, 'size'), vt.size(S), true);
    if (x('ghostty_render_state_row_get')(this.iter, RR('SELECTION'), base) === SUCCESS) {
      const d = vt.dv();
      row.sel = [d.getUint16(base + vt.off(S, 'start_x'), true), d.getUint16(base + vt.off(S, 'end_x'), true)];
    } else row.sel = null;
    // Soft wrap.
    row.wrap = false;
    if (x('ghostty_render_state_row_get')(this.iter, RR('RAW'), base) === SUCCESS) {
      const raw = vt.dv().getBigUint64(base, true);
      if (vt.fn64('ghostty_row_get')(raw, vt.enumValue('GhosttyRowData', 'WRAP'), base + 8) === SUCCESS)
        row.wrap = vt.dv().getUint8(base + 8) !== 0;
    }
    // Cells.
    if (x('ghostty_render_state_row_get')(this.iter, RR('CELLS_RAW'), base) !== SUCCESS) return;
    const ptr = vt.dv().getUint32(base, true);
    const len = Math.min(vt.dv().getUint32(base + 4, true), row.codes.length);
    const cellsSlot = base + 16;
    vt.dv().setUint32(cellsSlot, this.cells, true);
    let cellsReady = false;
    const b = this.bits;
    const tagCp = vt.enumValue('GhosttyCellContentTag', 'CODEPOINT');
    const tagGrapheme = vt.enumValue('GhosttyCellContentTag', 'CODEPOINT_GRAPHEME');
    const tagBgPal = vt.enumValue('GhosttyCellContentTag', 'BG_COLOR_PALETTE');
    const styles = new Map<number, StyleInfo>();
    const select = (col: number) => {
      if (!cellsReady) {
        x('ghostty_render_state_row_get')(this.iter, RR('CELLS'), cellsSlot);
        cellsReady = true;
      }
      x('ghostty_render_state_row_cells_select')(this.cells, col);
    };
    for (let i = 0; i < len; i++) {
      const d = vt.dv();
      const lo = d.getUint32(ptr + i * 8, true);
      const hi = d.getUint32(ptr + i * 8 + 4, true);
      const tag = bitsOf(lo, hi, b.tag.lsb, b.tag.width);
      const content = bitsOf(lo, hi, b.content.lsb, b.content.width);
      const styleId = bitsOf(lo, hi, b.style.lsb, b.style.width);
      row.wide[i] = bitsOf(lo, hi, b.wide.lsb, b.wide.width);
      row.link[i] = bitsOf(lo, hi, b.link.lsb, b.link.width);
      row.text[i] = undefined;
      row.codes[i] = 0;
      if (tag === tagCp || tag === tagGrapheme) {
        row.codes[i] = content & 0x1fffff;
        if (tag === tagGrapheme) {
          select(i);
          row.text[i] = this.graphemes();
        }
      }
      let st: StyleInfo | undefined;
      if (styleId) {
        st = styles.get(styleId);
        if (!st) {
          select(i);
          st = this.style(pal);
          styles.set(styleId, st);
        }
      }
      let fg = st ? st.fg : -1;
      if (st && this.boldIsBright && st.flags & F_BOLD && st.fgIndex >= 0 && st.fgIndex < 8) fg = pal[st.fgIndex + 8];
      row.fg[i] = fg;
      row.ul[i] = st ? st.ul : -1;
      row.flags[i] = st ? st.flags : 0;
      if (tag === tagBgPal) row.bg[i] = pal[content & 0xff];
      else if (tag !== tagCp && tag !== tagGrapheme)
        row.bg[i] = ((content & 0xff) << 16) | (((content >> 8) & 0xff) << 8) | ((content >> 16) & 0xff);
      else row.bg[i] = st ? st.bg : -1;
    }
    for (let i = len; i < row.codes.length; i++) {
      row.codes[i] = 0;
      row.text[i] = undefined;
      row.wide[i] = 0;
      row.fg[i] = row.bg[i] = row.ul[i] = -1;
      row.flags[i] = 0;
      row.link[i] = 0;
    }
  }

  /** The grapheme cluster of the selected cell. */
  private graphemes(): string {
    const vt = this.vt;
    const buf = this.scratch + 1024;
    const B = 'GhosttyBuffer';
    const data = buf + 16;
    const cap = 256;
    const d = vt.dv();
    d.setUint32(buf + vt.off(B, 'ptr'), data, true);
    d.setUint32(buf + vt.off(B, 'cap'), cap, true);
    d.setUint32(buf + vt.off(B, 'len'), 0, true);
    const r = vt.fn('ghostty_render_state_row_cells_get')(
      this.cells,
      vt.enumValue('GhosttyRenderStateRowCellsData', 'GRAPHEMES_UTF8'),
      buf,
    );
    if (r !== SUCCESS) return '';
    return vt.decode(data, vt.dv().getUint32(buf + vt.off(B, 'len'), true));
  }

  /** The selected cell's style, its colors resolved through the palette. */
  private style(pal: number[]): StyleInfo {
    const vt = this.vt;
    const p = this.scratch + 1536;
    const T = 'GhosttyStyle';
    vt.u8().fill(0, p, p + vt.size(T));
    vt.fn('ghostty_render_state_row_cells_get')(this.cells, vt.enumValue('GhosttyRenderStateRowCellsData', 'STYLE'), p);
    const d = vt.dv();
    const tagPal = vt.enumValue('GhosttyStyleColorTag', 'PALETTE');
    const tagRgb = vt.enumValue('GhosttyStyleColorTag', 'RGB');
    const color = (field: string): [number, number] => {
      const q = p + vt.off(T, field);
      const tag = d.getUint8(q);
      if (tag === tagPal) {
        const idx = d.getUint8(q + 1);
        return [pal[idx], idx];
      }
      if (tag === tagRgb) return [(d.getUint8(q + 1) << 16) | (d.getUint8(q + 2) << 8) | d.getUint8(q + 3), -1];
      return [-1, -1];
    };
    const raw = d.getUint16(p + vt.off(T, 'flags'), true);
    let flags = 0;
    for (const [bit, at] of this.flagBits) if (bitsOf(raw, 0, at.lsb, at.width)) flags |= bit;
    flags |= bitsOf(raw, 0, this.ulBits.lsb, this.ulBits.width) << UNDERLINE_SHIFT;
    const [fg, fgIndex] = color('fg_color');
    return { fg, fgIndex, bg: color('bg_color')[0], ul: color('underline_color')[0], flags };
  }

  // ---- input ----

  /** The bytes a key sends, empty for none. */
  encodeKey(k: KeyInput): Uint8Array {
    const vt = this.vt;
    const x = (n: string) => vt.fn(n);
    if (!this.keyEncoder) {
      this.keyEncoder = vt.handle((s) => x('ghostty_key_encoder_new')(0, s));
      this.keyEvent = vt.handle((s) => x('ghostty_key_event_new')(0, s));
    }
    const enc = this.keyEncoder;
    const ev = this.keyEvent;
    x('ghostty_key_encoder_set_from_terminal')(enc, this.t);
    // set_from_terminal resets Option-as-Alt: set it again.
    const opt = this.scratch;
    vt.dv().setInt32(opt, vt.enumValue('GhosttyOptionAsAlt', k.optionAsAlt ? 'TRUE' : 'FALSE'), true);
    x('ghostty_key_encoder_set')(enc, vt.enumValue('GhosttyKeyEncoderOption', 'MACOS_OPTION_AS_ALT'), opt);
    x('ghostty_key_event_set_action')(ev, vt.enumValue('GhosttyKeyAction', k.action.toUpperCase()));
    const keys = vt.enumValues('GhosttyKey');
    x('ghostty_key_event_set_key')(ev, keys[keyName(k.code)] ?? 0);
    x('ghostty_key_event_set_mods')(ev, k.mods);
    x('ghostty_key_event_set_consumed_mods')(ev, k.consumed ?? 0);
    x('ghostty_key_event_set_composing')(ev, 0);
    x('ghostty_key_event_set_unshifted_codepoint')(ev, k.unshifted ?? 0);
    // The event borrows the text until it is set again.
    vt.free(this.keyText, this.keyTextLen);
    this.keyText = 0;
    this.keyTextLen = 0;
    const text = k.text ? vt.encode(k.text) : new Uint8Array();
    if (text.length) {
      this.keyText = vt.copyIn(text);
      this.keyTextLen = Math.max(1, text.length);
    }
    const S = 'GhosttyString';
    const str = this.scratch + 16;
    vt.dv().setUint32(str + vt.off(S, 'ptr'), this.keyText, true);
    vt.dv().setUint32(str + vt.off(S, 'len'), text.length, true);
    x('ghostty_key_event_set_utf8')(ev, str);
    return this.encodeInto((buf, cap, out) => x('ghostty_key_encoder_encode')(enc, ev, buf, cap, out));
  }

  /** Runs an encoder writing into scratch memory; its bytes. */
  private encodeInto(encode: (buf: number, cap: number, out: number) => number): Uint8Array {
    const vt = this.vt;
    const out = this.scratch + 32;
    const buf = this.scratch + 64;
    const cap = 1024;
    let r = encode(buf, cap, out);
    if (r === OUT_OF_SPACE) {
      const need = vt.dv().getUint32(out, true);
      const big = vt.alloc(need);
      try {
        r = encode(big, need, out);
        return r === SUCCESS ? vt.u8().slice(big, big + vt.dv().getUint32(out, true)) : new Uint8Array();
      } finally {
        vt.free(big, need);
      }
    }
    return r === SUCCESS ? vt.u8().slice(buf, buf + vt.dv().getUint32(out, true)) : new Uint8Array();
  }

  private mouseSize() {
    if (!this.mouseEncoder) return;
    const vt = this.vt;
    const T = 'GhosttyMouseEncoderSize';
    const p = this.scratch;
    vt.u8().fill(0, p, p + vt.size(T));
    const d = vt.dv();
    d.setUint32(p + vt.off(T, 'size'), vt.size(T), true);
    d.setUint32(p + vt.off(T, 'screen_width'), this.cols * this.cellW, true);
    d.setUint32(p + vt.off(T, 'screen_height'), this.rows * this.cellH, true);
    d.setUint32(p + vt.off(T, 'cell_width'), this.cellW, true);
    d.setUint32(p + vt.off(T, 'cell_height'), this.cellH, true);
    vt.fn('ghostty_mouse_encoder_set')(this.mouseEncoder, vt.enumValue('GhosttyMouseEncoderOption', 'SIZE'), p);
  }

  /** The bytes a mouse event sends to a program that asked for them. */
  encodeMouse(m: MouseInput): Uint8Array {
    const vt = this.vt;
    const x = (n: string) => vt.fn(n);
    if (!this.mouseEncoder) {
      this.mouseEncoder = vt.handle((s) => x('ghostty_mouse_encoder_new')(0, s));
      this.mouseEvent = vt.handle((s) => x('ghostty_mouse_event_new')(0, s));
      this.mouseSize();
    }
    const enc = this.mouseEncoder;
    const ev = this.mouseEvent;
    x('ghostty_mouse_encoder_set_from_terminal')(enc, this.t);
    const flag = this.scratch;
    vt.dv().setUint8(flag, m.held ? 1 : 0);
    x('ghostty_mouse_encoder_set')(enc, vt.enumValue('GhosttyMouseEncoderOption', 'ANY_BUTTON_PRESSED'), flag);
    vt.dv().setUint8(flag, 1);
    x('ghostty_mouse_encoder_set')(enc, vt.enumValue('GhosttyMouseEncoderOption', 'TRACK_LAST_CELL'), flag);
    x('ghostty_mouse_event_set_action')(ev, vt.enumValue('GhosttyMouseAction', m.action.toUpperCase()));
    if (m.button) x('ghostty_mouse_event_set_button')(ev, m.button);
    else x('ghostty_mouse_event_clear_button')(ev);
    x('ghostty_mouse_event_set_mods')(ev, m.mods);
    const pos = this.scratch + 8;
    const P = 'GhosttyMousePosition';
    vt.dv().setFloat32(pos + vt.off(P, 'x'), m.x, true);
    vt.dv().setFloat32(pos + vt.off(P, 'y'), m.y, true);
    x('ghostty_mouse_event_set_position')(ev, pos);
    return this.encodeInto((buf, cap, out) => x('ghostty_mouse_encoder_encode')(enc, ev, buf, cap, out));
  }

  /** Pasted text as the program should get it: bracketed when it asked,
   * unsafe control characters replaced, newlines as returns otherwise. */
  encodePaste(text: string): Uint8Array {
    const vt = this.vt;
    const data = vt.encode(text);
    if (!data.length) return data;
    const p = vt.copyIn(data);
    try {
      const bracketed = this.mode(2004) ? 1 : 0;
      return this.encodeInto((buf, cap, out) => vt.fn('ghostty_paste_encode')(p, data.length, bracketed, buf, cap, out));
    } finally {
      vt.free(p, Math.max(1, data.length));
    }
  }

  /** The focus report a program that asked for one gets, else nothing. */
  encodeFocus(focused: boolean): Uint8Array {
    if (!this.mode(1004)) return new Uint8Array();
    const v = this.vt.enumValue('GhosttyFocusEvent', focused ? 'GAINED' : 'LOST');
    return this.encodeInto((buf, cap, out) => this.vt.fn('ghostty_focus_encode')(v, buf, cap, out));
  }

  // ---- grid references ----

  /** Writes the grid reference of a viewport cell at out; false outside. */
  private refAt(col: number, row: number, out: number): boolean {
    const vt = this.vt;
    const P = 'GhosttyPoint';
    const pt = this.scratch + 256;
    vt.u8().fill(0, pt, pt + vt.size(P));
    const d = vt.dv();
    d.setInt32(pt + vt.off(P, 'tag'), vt.enumValue('GhosttyPointTag', 'VIEWPORT'), true);
    const v = pt + vt.off(P, 'value');
    d.setUint16(v + vt.off('GhosttyPointCoordinate', 'x'), Math.max(0, Math.min(col, this.cols - 1)), true);
    d.setUint32(v + vt.off('GhosttyPointCoordinate', 'y'), Math.max(0, Math.min(row, this.rows - 1)), true);
    return vt.fn('ghostty_terminal_grid_ref')(this.t, pt, out) === SUCCESS;
  }

  /** The viewport cell of a grid reference, or null when it is not shown. */
  private viewportOf(ref: number): { x: number; y: number } | null {
    const vt = this.vt;
    const pt = this.scratch + 320;
    const C = 'GhosttyPointCoordinate';
    vt.u8().fill(0, pt, pt + vt.size(C));
    const r = vt.fn('ghostty_terminal_point_from_grid_ref')(this.t, ref, vt.enumValue('GhosttyPointTag', 'VIEWPORT'), pt);
    if (r !== SUCCESS) return null;
    const d = vt.dv();
    return { x: d.getUint16(pt + vt.off(C, 'x'), true), y: d.getUint32(pt + vt.off(C, 'y'), true) };
  }

  /** The OSC 8 hyperlink of a viewport cell. */
  hyperlinkAt(col: number, row: number): string | undefined {
    const vt = this.vt;
    const ref = this.scratch + 384;
    if (!this.refAt(col, row, ref)) return undefined;
    const buf = this.scratch + 2048;
    const out = this.scratch + 400;
    const r = vt.fn('ghostty_grid_ref_hyperlink_uri')(ref, buf, 2048, out);
    if (r !== SUCCESS) return undefined;
    const n = vt.dv().getUint32(out, true);
    return n ? vt.decode(buf, n) : undefined;
  }

  // ---- selection ----

  private gestureEvent(type: 'PRESS' | 'RELEASE' | 'DRAG' | 'AUTOSCROLL_TICK'): number {
    const vt = this.vt;
    if (!this.gesture) this.gesture = vt.handle((s) => vt.fn('ghostty_selection_gesture_new')(0, s));
    let e = this.gestureEvents[type];
    if (!e) {
      e = vt.handle((s) => vt.fn('ghostty_selection_gesture_event_new')(0, s, vt.enumValue('GhosttySelectionGestureEventType', type)));
      this.gestureEvents[type] = e;
    }
    return e;
  }

  private gestureSet(ev: number, opt: string, size: number, write: (d: DataView, p: number) => void) {
    const vt = this.vt;
    const p = this.scratch + 512;
    vt.u8().fill(0, p, p + size);
    write(vt.dv(), p);
    vt.fn('ghostty_selection_gesture_event_set')(ev, vt.enumValue('GhosttySelectionGestureEventOption', opt), p);
  }

  private geometry(ev: number) {
    const vt = this.vt;
    const G = 'GhosttySelectionGestureGeometry';
    this.gestureSet(ev, 'GEOMETRY', vt.size(G), (d, p) => {
      d.setUint32(p + vt.off(G, 'columns'), this.cols, true);
      d.setUint32(p + vt.off(G, 'cell_width'), this.cellW, true);
      d.setUint32(p + vt.off(G, 'padding_left'), 0, true);
      d.setUint32(p + vt.off(G, 'screen_height'), this.rows * this.cellH, true);
    });
  }

  private position(ev: number, px: number, py: number) {
    const vt = this.vt;
    const S = 'GhosttySurfacePosition';
    this.gestureSet(ev, 'POSITION', vt.size(S), (d, p) => {
      d.setFloat64(p + vt.off(S, 'x'), px, true);
      d.setFloat64(p + vt.off(S, 'y'), py, true);
    });
  }

  private ref(ev: number, col: number, row: number): boolean {
    const vt = this.vt;
    const ref = this.scratch + 448;
    if (!this.refAt(col, row, ref)) return false;
    const G = 'GhosttyGridRef';
    const bytes = vt.u8().slice(ref, ref + vt.size(G));
    this.gestureSet(ev, 'REF', vt.size(G), (_d, p) => vt.u8().set(bytes, p));
    return true;
  }

  /** Applies a gesture event; installs the selection it gives. */
  private applyGesture(ev: number): boolean {
    const vt = this.vt;
    const sel = this.scratch + 576;
    const S = 'GhosttySelection';
    vt.u8().fill(0, sel, sel + vt.size(S));
    const r = vt.fn('ghostty_selection_gesture_event')(this.gesture, this.t, ev, sel);
    if (r !== SUCCESS) return false;
    this.setOpt('SELECTION', sel);
    return true;
  }

  /** A press of the left button at a cell (pixel position within the
   * surface for click counting); double and triple clicks select words and
   * lines. timeMs is the event's time. */
  selectPress(col: number, row: number, px: number, py: number, timeMs: number) {
    const ev = this.gestureEvent('PRESS');
    if (!this.ref(ev, col, row)) return;
    this.position(ev, px, py);
    this.gestureSet(ev, 'TIME_NS', 8, (d, p) => d.setBigUint64(p, BigInt(Math.round(timeMs * 1e6)), true));
    this.gestureSet(ev, 'REPEAT_INTERVAL_NS', 8, (d, p) => d.setBigUint64(p, 500_000_000n, true));
    this.gestureSet(ev, 'REPEAT_DISTANCE', 8, (d, p) => d.setFloat64(p, Math.max(4, this.cellW / 2), true));
    // A single press only anchors; it ends the previous selection.
    if (!this.applyGesture(ev)) this.setOpt('SELECTION', 0);
  }

  selectDrag(col: number, row: number, px: number, py: number) {
    const ev = this.gestureEvent('DRAG');
    if (!this.ref(ev, col, row)) return;
    this.position(ev, px, py);
    this.geometry(ev);
    this.applyGesture(ev);
  }

  selectRelease(col: number, row: number) {
    const ev = this.gestureEvent('RELEASE');
    this.ref(ev, col, row);
    this.vt.fn('ghostty_selection_gesture_event')(this.gesture, this.t, ev, 0);
  }

  /** The drag wants the view scrolled: -1 up, 1 down, 0 not. */
  get autoscroll(): number {
    if (!this.gesture) return 0;
    const vt = this.vt;
    const p = this.scratch;
    if (
      vt.fn('ghostty_selection_gesture_get')(this.gesture, this.t, vt.enumValue('GhosttySelectionGestureData', 'AUTOSCROLL'), p) !== SUCCESS
    )
      return 0;
    const v = vt.dv().getInt32(p, true);
    return v === vt.enumValue('GhosttySelectionGestureAutoscroll', 'UP')
      ? -1
      : v === vt.enumValue('GhosttySelectionGestureAutoscroll', 'DOWN')
        ? 1
        : 0;
  }

  /** One autoscroll step of a drag past an edge, continuing at the cell. */
  selectAutoscroll(col: number, row: number, px: number, py: number) {
    const vt = this.vt;
    const ev = this.gestureEvent('AUTOSCROLL_TICK');
    this.position(ev, px, py);
    this.geometry(ev);
    const C = 'GhosttyPointCoordinate';
    this.gestureSet(ev, 'VIEWPORT', vt.size(C), (d, p) => {
      d.setUint16(p + vt.off(C, 'x'), Math.max(0, Math.min(col, this.cols - 1)), true);
      d.setUint32(p + vt.off(C, 'y'), Math.max(0, Math.min(row, this.rows - 1)), true);
    });
    this.applyGesture(ev);
  }

  selectAll() {
    const vt = this.vt;
    const sel = this.scratch + 576;
    vt.u8().fill(0, sel, sel + vt.size('GhosttySelection'));
    if (vt.fn('ghostty_terminal_select_all')(this.t, sel) === SUCCESS) this.setOpt('SELECTION', sel);
  }

  clearSelection() {
    this.setOpt('SELECTION', 0);
    if (this.gesture) this.vt.fn('ghostty_selection_gesture_reset')(this.gesture, this.t);
  }

  get hasSelection(): boolean {
    const p = this.scratch + 576;
    return this.get('SELECTION', p) === SUCCESS;
  }

  /** The selected text, soft-wrapped lines joined; undefined without a selection. */
  selectionText(): string | undefined {
    const vt = this.vt;
    const sel = this.scratch + 576;
    if (this.get('SELECTION', sel) !== SUCCESS) return undefined;
    const x = (n: string) => vt.fn(n);
    const fmt = vt.handle((s) => x('ghostty_formatter_terminal_new')(0, s, this.t));
    try {
      const opt = (name: string) => vt.enumValue('GhosttyFormatterOption', name);
      const v = this.scratch + 640;
      vt.dv().setInt32(v, vt.enumValue('GhosttyFormatterFormat', 'PLAIN'), true);
      x('ghostty_formatter_set')(fmt, opt('EMIT'), v);
      vt.dv().setUint8(v, 1);
      x('ghostty_formatter_set')(fmt, opt('UNWRAP'), v);
      x('ghostty_formatter_set')(fmt, opt('TRIM'), v);
      x('ghostty_formatter_set')(fmt, opt('SELECTION'), sel);
      const outPtr = this.scratch + 656;
      const outLen = this.scratch + 660;
      if (x('ghostty_formatter_format_alloc')(fmt, 0, outPtr, outLen) !== SUCCESS) return undefined;
      const p = vt.dv().getUint32(outPtr, true);
      const n = vt.dv().getUint32(outLen, true);
      const text = vt.decode(p, n);
      x('ghostty_free')(0, p, n);
      return text;
    } finally {
      x('ghostty_formatter_free')(fmt);
    }
  }

  // ---- find ----

  /** Looks for text (ASCII letters ignore case) in the screen and the
   * scrollback; an empty needle ends the search. */
  find(needle: string) {
    const vt = this.vt;
    const x = (n: string) => vt.fn(n);
    if (!needle) {
      if (this.search) x('ghostty_search_free')(this.search);
      this.search = 0;
      return;
    }
    if (!this.search) {
      this.search = vt.handle((s) => x('ghostty_search_new')(0, s, this.t));
      const sc = this.scratch;
      vt.dv().setInt32(sc, vt.enumValue('GhosttySearchScroll', 'IF_NEEDED'), true);
      x('ghostty_search_set')(this.search, vt.enumValue('GhosttySearchOption', 'SELECT_SCROLL'), sc);
    }
    const bytes = vt.encode(needle);
    const p = vt.copyIn(bytes);
    try {
      const S = this.scratch + 16;
      vt.dv().setUint32(S + vt.off('GhosttyString', 'ptr'), p, true);
      vt.dv().setUint32(S + vt.off('GhosttyString', 'len'), bytes.length, true);
      x('ghostty_search_set')(this.search, vt.enumValue('GhosttySearchOption', 'NEEDLE'), S);
    } finally {
      vt.free(p, Math.max(1, bytes.length));
    }
    x('ghostty_search_run')(this.search);
  }

  /** Brings the search up to date with new output. */
  findRefresh() {
    if (this.search) this.vt.fn('ghostty_search_run')(this.search);
  }

  /** Selects the next older (1) or newer (-1) match, scrolling to it. */
  findStep(dir: 1 | -1): boolean {
    if (!this.search) return false;
    const r = this.vt.fn(dir > 0 ? 'ghostty_search_select_next' : 'ghostty_search_select_prev')(this.search);
    return r === SUCCESS;
  }

  /** How many matches there are and which one is selected (0 is the newest). */
  findState(): { total: number; selected: number | undefined } {
    if (!this.search) return { total: 0, selected: undefined };
    const vt = this.vt;
    const p = this.scratch;
    const data = (n: string) => vt.enumValue('GhosttySearchData', n);
    vt.fn('ghostty_search_get')(this.search, data('TOTAL_MATCHES'), p);
    const total = vt.dv().getUint32(p, true);
    const r = vt.fn('ghostty_search_get')(this.search, data('SELECTED_INDEX'), p);
    return { total, selected: r === SUCCESS ? vt.dv().getUint32(p, true) : undefined };
  }

  /** The matches on the screen as cells per row, and which is the selected one. */
  findMatches(): Array<{ y: number; from: number; to: number; current: boolean }> {
    if (!this.search) return [];
    const vt = this.vt;
    const x = (n: string) => vt.fn(n);
    const data = (n: string) => vt.enumValue('GhosttySearchData', n);
    const B = 'GhosttySelectionBuffer';
    const S = 'GhosttySelection';
    const buf = this.scratch + 704;
    vt.u8().fill(0, buf, buf + vt.size(B));
    if (x('ghostty_search_get')(this.search, data('VIEWPORT_MATCHES'), buf) !== OUT_OF_SPACE) return [];
    const n = vt.dv().getUint32(buf + vt.off(B, 'len'), true);
    if (!n) return [];
    const size = n * vt.size(S);
    const arr = vt.alloc(size);
    const out: Array<{ y: number; from: number; to: number; current: boolean }> = [];
    try {
      const d = vt.dv();
      d.setUint32(buf + vt.off(B, 'ptr'), arr, true);
      d.setUint32(buf + vt.off(B, 'cap'), n, true);
      if (x('ghostty_search_get')(this.search, data('VIEWPORT_MATCHES'), buf) !== SUCCESS) return [];
      const cur = this.scratch + 768;
      const hasCur = x('ghostty_search_get')(this.search, data('SELECTED_MATCH'), cur) === SUCCESS;
      const curStart = hasCur ? this.viewportOf(cur + vt.off(S, 'start')) : null;
      const count = vt.dv().getUint32(buf + vt.off(B, 'len'), true);
      for (let i = 0; i < count; i++) {
        const s = arr + i * vt.size(S);
        const a = this.viewportOf(s + vt.off(S, 'start'));
        const b = this.viewportOf(s + vt.off(S, 'end'));
        if (!a && !b) continue;
        const start = a ?? { x: 0, y: 0 };
        const end = b ?? { x: this.cols - 1, y: this.rows - 1 };
        const current = !!curStart && !!a && curStart.x === a.x && curStart.y === a.y;
        for (let y = start.y; y <= end.y && y < this.rows; y++)
          out.push({ y, from: y === start.y ? start.x : 0, to: (y === end.y ? end.x : this.cols - 1) + 1, current });
      }
    } finally {
      vt.free(arr, size);
    }
    return out;
  }
}

export { NO_VALUE };
