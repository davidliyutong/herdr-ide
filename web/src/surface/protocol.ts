// Messages of the core's surface stream (internal/server/surface.go).
//
// The core keeps the cell grid herdr renders for the shown tab (herdr's
// endpoint protocol) and sends it as binary messages:
//
//   kind u8 (1 full, 2 patch) | gen u32 | width u16 | height u16 |
//   cursor: flags u8 (bit0 present, bit1 visible), x u16, y u16, shape u8 |
//   moves u16, each x,y,w,h u16 + shift i16 |
//   spans u32, each x u16, y u16, n u16, then n cells
//
// A cell is: symbol length u8 + UTF-8 bytes, fg u32, bg u32, modifier u16,
// flags u8 (bit0 skip, bit1 link) and, with a link, its index u16.
// Everything is little endian.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScrollInfo {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

export interface SurfacePane {
  id: string;
  rect: Rect;
  inner: Rect;
  scrollbar?: Rect;
  scroll?: ScrollInfo;
  focused: boolean;
  /** The pane's program asked for mouse reports. */
  mouse: boolean;
  /** The pane shows its alternate screen. */
  alt: boolean;
}

export interface SurfaceSplit {
  vertical: boolean;
  pos: number;
  area: Rect;
  hit: Rect;
  path: boolean[];
}

/** surf.meta: geometry and modes of the shown tab. */
export interface SurfaceMeta {
  m: string;
  gen: number;
  w: number;
  h: number;
  panes: SurfacePane[];
  splits: SurfaceSplit[];
  links: string[];
  popup?: string;
}

export interface Cursor {
  x: number;
  y: number;
  visible: boolean;
  shape: number;
}

export interface Move {
  rect: Rect;
  /** Positive moves content up. */
  shift: number;
}

export interface Cell {
  symbol: string;
  fg: number;
  bg: number;
  mod: number;
  skip: boolean;
  /** Index into SurfaceMeta.links, or -1. */
  link: number;
}

export interface Span {
  x: number;
  y: number;
  cells: Cell[];
}

export interface SurfaceUpdate {
  full: boolean;
  gen: number;
  w: number;
  h: number;
  cursor?: Cursor;
  moves: Move[];
  spans: Span[];
}

const utf8 = new TextDecoder();

export function decodeUpdate(buf: ArrayBuffer): SurfaceUpdate {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;
  const u8 = () => dv.getUint8(o++);
  const u16 = () => {
    const v = dv.getUint16(o, true);
    o += 2;
    return v;
  };
  const u32 = () => {
    const v = dv.getUint32(o, true);
    o += 4;
    return v;
  };
  const kind = u8();
  const gen = u32();
  const w = u16();
  const h = u16();
  const cf = u8();
  const cx = u16();
  const cy = u16();
  const shape = u8();
  const cursor = cf & 1 ? { x: cx, y: cy, visible: (cf & 2) !== 0, shape } : undefined;
  const moves: Move[] = [];
  for (let n = u16(); n > 0; n--) {
    const x = u16();
    const y = u16();
    const mw = u16();
    const mh = u16();
    const shift = dv.getInt16(o, true);
    o += 2;
    moves.push({ rect: { x, y, w: mw, h: mh }, shift });
  }
  const spans: Span[] = [];
  for (let n = u32(); n > 0; n--) {
    const x = u16();
    const y = u16();
    const count = u16();
    const cells: Cell[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const len = u8();
      // Most symbols are one ASCII byte.
      const symbol = len === 1 && bytes[o] < 0x80 ? String.fromCharCode(bytes[o]) : utf8.decode(bytes.subarray(o, o + len));
      o += len;
      const fg = u32();
      const bg = u32();
      const mod = u16();
      const f = u8();
      const link = f & 2 ? u16() : -1;
      cells[i] = { symbol, fg, bg, mod, skip: (f & 1) !== 0, link };
    }
    spans.push({ x, y, cells });
  }
  return { full: kind === 1, gen, w, h, cursor, moves, spans };
}
