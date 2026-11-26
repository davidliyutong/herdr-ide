// Glyphs drawn once into a canvas and reused: text in the terminal font (the
// browser falls back for characters the font lacks), box-drawing and block
// characters as shapes so borders join at any cell size, and the lines of
// underlines, strikethrough, overline and cursors. Both renderers use it:
// WebGL tints white glyphs in its shader; the Canvas 2D one keeps a glyph per
// color.

import { isCjkText, termCjkFontFamily, termFontFamily, type TermFontWeight } from '../terminal/fonts';

/** Cell geometry in device pixels and the font it comes from. */
export interface Metrics {
  cw: number;
  ch: number;
  fontPx: number;
  family: string;
  /** Font stack prioritizing the configured CJK font for CJK glyphs, when set. */
  cjkFamily?: string;
  weight: TermFontWeight;
  /** Baseline offset from a cell's top. */
  baseline: number;
  dpr: number;
}

/** Measures the cell of a font: the width of "W", the font's line height
 * times lineHeight, in whole device pixels. */
export function measureCell(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  o: { fontFamily: string; cjkFontFamily?: string; fontSize: number; fontWeight: TermFontWeight; lineHeight: number },
  dpr: number,
): Metrics {
  const family = termFontFamily(o.fontWeight, o.fontFamily, o.cjkFontFamily);
  const cjkFamily = termCjkFontFamily(o.fontWeight, o.fontFamily, o.cjkFontFamily);
  const fontPx = Math.round(o.fontSize * dpr);
  ctx.font = `${o.fontWeight} ${fontPx}px ${family}`;
  const m = ctx.measureText('W');
  const ascent = m.fontBoundingBoxAscent || fontPx * 0.95;
  const descent = m.fontBoundingBoxDescent || fontPx * 0.3;
  const cw = Math.max(1, Math.round(m.width || fontPx * 0.6));
  const ch = Math.max(1, Math.round((ascent + descent) * o.lineHeight));
  const baseline = Math.round((ch - (ascent + descent)) / 2 + ascent);
  return { cw, ch, fontPx, family, ...(cjkFamily ? { cjkFamily } : {}), weight: o.fontWeight, baseline, dpr };
}

/** What a glyph is. */
export type GlyphSpec =
  | { kind: 'text'; text: string; bold: boolean; italic: boolean }
  /** A box-drawing or block character. */
  | { kind: 'shape'; text: string }
  /** Underline styles 1-5, 'strike', 'overline'. */
  | { kind: 'line'; style: number | 'strike' | 'overline' }
  /** width: the bar's, underline's and hollow box's lines, CSS pixels. */
  | { kind: 'cursor'; style: 'bar' | 'underline' | 'hollow' | 'block'; width: number };

export function glyphKey(g: GlyphSpec, span: number): string {
  switch (g.kind) {
    case 'text':
      return `t${g.bold ? 1 : 0}${g.italic ? 1 : 0}${span}${g.text}`;
    case 'shape':
      return `s${span}${g.text}`;
    case 'line':
      return `l${span}${g.style}`;
    case 'cursor':
      return `c${span}${g.style}${g.width}`;
  }
}

/** Where a glyph is in the atlas, in pixels, and whether it has colors of its own (emoji). */
export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
  colored: boolean;
}

// Line weights per box-drawing character: up, right, down, left.
// 1 light, 2 heavy, 3 double.
const box: Record<string, [number, number, number, number]> = {
  '─': [0, 1, 0, 1],
  '━': [0, 2, 0, 2],
  '│': [1, 0, 1, 0],
  '┃': [2, 0, 2, 0],
  '┌': [0, 1, 1, 0],
  '┐': [0, 0, 1, 1],
  '└': [1, 1, 0, 0],
  '┘': [1, 0, 0, 1],
  '├': [1, 1, 1, 0],
  '┤': [1, 0, 1, 1],
  '┬': [0, 1, 1, 1],
  '┴': [1, 1, 0, 1],
  '┼': [1, 1, 1, 1],
  '┏': [0, 2, 2, 0],
  '┓': [0, 0, 2, 2],
  '┗': [2, 2, 0, 0],
  '┛': [2, 0, 0, 2],
  '┣': [2, 2, 2, 0],
  '┫': [2, 0, 2, 2],
  '┳': [0, 2, 2, 2],
  '┻': [2, 2, 0, 2],
  '╋': [2, 2, 2, 2],
  '═': [0, 3, 0, 3],
  '║': [3, 0, 3, 0],
  '╔': [0, 3, 3, 0],
  '╗': [0, 0, 3, 3],
  '╚': [3, 3, 0, 0],
  '╝': [3, 0, 0, 3],
  '╠': [3, 3, 3, 0],
  '╣': [3, 0, 3, 3],
  '╦': [0, 3, 3, 3],
  '╩': [3, 3, 0, 3],
  '╬': [3, 3, 3, 3],
  '╴': [0, 0, 0, 1],
  '╵': [1, 0, 0, 0],
  '╶': [0, 1, 0, 0],
  '╷': [0, 0, 1, 0],
  '╸': [0, 0, 0, 2],
  '╹': [2, 0, 0, 0],
  '╺': [0, 2, 0, 0],
  '╻': [0, 0, 2, 0],
  '╼': [0, 2, 0, 1],
  '╽': [1, 0, 2, 0],
  '╾': [0, 1, 0, 2],
  '╿': [2, 0, 1, 0],
};
const rounded: Record<string, [number, number]> = { '╭': [1, 1], '╮': [-1, 1], '╯': [-1, -1], '╰': [1, -1] };
const quads: Record<string, number> = {
  '▖': 4,
  '▗': 8,
  '▘': 1,
  '▙': 13,
  '▚': 9,
  '▛': 7,
  '▜': 11,
  '▝': 2,
  '▞': 6,
  '▟': 14,
  '▌': 5,
  '▄': 12,
};

/** Whether a character is drawn as a shape rather than from the font. */
export function isShape(ch: string): boolean {
  if (box[ch] || rounded[ch] || quads[ch] !== undefined) return true;
  const code = ch.codePointAt(0)!;
  return ch.length === 1 && code >= 0x2580 && code <= 0x259f;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Draws a box-drawing or block character; false if it is not one. */
export function drawShape(ctx: Ctx2D, ch: string, x: number, y: number, w: number, h: number): boolean {
  const cx = x + Math.floor(w / 2);
  const cy = y + Math.floor(h / 2);
  const light = Math.max(1, Math.round(w / 9));
  const heavy = light * 2;
  const seg = box[ch];
  if (seg) {
    const [u, r, d, l] = seg;
    const line = (wt: number, horizontal: boolean, from: number, to: number) => {
      if (!wt) return;
      if (wt === 3) {
        const gap = light;
        if (horizontal) {
          ctx.fillRect(from, cy - gap - light + Math.ceil(light / 2), to - from, light);
          ctx.fillRect(from, cy + gap - Math.floor(light / 2), to - from, light);
        } else {
          ctx.fillRect(cx - gap - light + Math.ceil(light / 2), from, light, to - from);
          ctx.fillRect(cx + gap - Math.floor(light / 2), from, light, to - from);
        }
        return;
      }
      const t = wt === 2 ? heavy : light;
      if (horizontal) ctx.fillRect(from, cy - Math.floor(t / 2), to - from, t);
      else ctx.fillRect(cx - Math.floor(t / 2), from, t, to - from);
    };
    // Each half reaches past the center by half a line so joints close.
    const pad = Math.ceil(heavy / 2) + light;
    line(u, false, y, cy + (u === 3 ? pad : Math.ceil(light / 2)));
    line(d, false, cy - (d === 3 ? pad : Math.floor(light / 2)), y + h);
    line(l, true, x, cx + (l === 3 ? pad : Math.ceil(light / 2)));
    line(r, true, cx - (r === 3 ? pad : Math.floor(light / 2)), x + w);
    return true;
  }
  const rc = rounded[ch];
  if (rc) {
    const [dx, dy] = rc;
    const rad = Math.min(w, h) / 2;
    ctx.save();
    ctx.lineWidth = light;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.beginPath();
    const ox = cx + (light % 2 ? 0.5 : 0);
    const oy = cy + (light % 2 ? 0.5 : 0);
    ctx.moveTo(ox, dy > 0 ? y + h : y);
    ctx.lineTo(ox, oy + dy * rad);
    ctx.arcTo(ox, oy, ox + dx * rad, oy, rad);
    ctx.lineTo(dx > 0 ? x + w : x, oy);
    ctx.stroke();
    ctx.restore();
    return true;
  }
  const code = ch.codePointAt(0)!;
  if (ch.length > 2 || code < 0x2580 || code > 0x259f) return false;
  const eighthW = (n: number) => Math.round((w * n) / 8);
  const eighthH = (n: number) => Math.round((h * n) / 8);
  switch (ch) {
    case '█':
      ctx.fillRect(x, y, w, h);
      return true;
    case '▀':
      ctx.fillRect(x, y, w, eighthH(4));
      return true;
    case '▔':
      ctx.fillRect(x, y, w, eighthH(1));
      return true;
    case '▕':
      ctx.fillRect(x + w - eighthW(1), y, eighthW(1), h);
      return true;
    case '▐':
      ctx.fillRect(x + eighthW(4), y, w - eighthW(4), h);
      return true;
    case '░':
    case '▒':
    case '▓': {
      ctx.save();
      ctx.globalAlpha = ch === '░' ? 0.25 : ch === '▒' ? 0.5 : 0.75;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
      return true;
    }
  }
  // Lower eighths ▁..▇ (U+2581..U+2587) and left eighths ▉..▏ (U+2589..U+258F).
  if (code >= 0x2581 && code <= 0x2587) {
    const n = code - 0x2580;
    ctx.fillRect(x, y + h - eighthH(n), w, eighthH(n));
    return true;
  }
  if (code >= 0x2589 && code <= 0x258f) {
    const n = 0x2590 - code;
    ctx.fillRect(x, y, eighthW(n), h);
    return true;
  }
  const q = quads[ch];
  if (q !== undefined) {
    const hw = eighthW(4);
    const hh = eighthH(4);
    if (q & 1) ctx.fillRect(x, y, hw, hh);
    if (q & 2) ctx.fillRect(x + hw, y, w - hw, hh);
    if (q & 4) ctx.fillRect(x, y + hh, hw, h - hh);
    if (q & 8) ctx.fillRect(x + hw, y + hh, w - hw, h - hh);
    return true;
  }
  return false;
}

/** Draws an underline style, strikethrough, overline or cursor shape over a cell span. */
function drawLine(ctx: Ctx2D, g: Extract<GlyphSpec, { kind: 'line' | 'cursor' }>, x: number, y: number, w: number, m: Metrics) {
  const { ch, cw, baseline } = m;
  const thin = Math.max(1, Math.round(ch / 16));
  if (g.kind === 'cursor') {
    const thick = Math.max(1, Math.min(Math.round(g.width * m.dpr), Math.round(cw / 2)));
    if (g.style === 'block') ctx.fillRect(x, y, w, ch);
    else if (g.style === 'underline') ctx.fillRect(x, y + ch - thick, w, thick);
    else if (g.style === 'bar') ctx.fillRect(x, y, thick, ch);
    else {
      ctx.fillRect(x, y, w, thick);
      ctx.fillRect(x, y + ch - thick, w, thick);
      ctx.fillRect(x, y, thick, ch);
      ctx.fillRect(x + w - thick, y, thick, ch);
    }
    return;
  }
  if (g.style === 'strike') return ctx.fillRect(x, y + Math.round(ch / 2), w, thin);
  if (g.style === 'overline') return ctx.fillRect(x, y, w, thin);
  const uy = y + Math.min(baseline + thin, ch - thin);
  switch (g.style) {
    case 2:
      ctx.fillRect(x, uy, w, thin);
      ctx.fillRect(x, Math.min(uy + thin * 2, y + ch - thin), w, thin);
      return;
    case 3: {
      ctx.save();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = thin;
      ctx.beginPath();
      for (let i = 0; i <= w; i += 1) ctx.lineTo(x + i, uy + Math.sin((i / (cw / 2)) * Math.PI) * thin);
      ctx.stroke();
      ctx.restore();
      return;
    }
    case 4:
    case 5: {
      const dash = g.style === 4 ? thin : thin * 3;
      for (let i = 0; i < w; i += dash * 2) ctx.fillRect(x + i, uy, Math.min(dash, w - i), thin);
      return;
    }
    default:
      ctx.fillRect(x, uy, w, thin);
  }
}

/** Extra width a text glyph's slot gets on its right, for italic and
 * glyphs a little wider than their cells. */
export function textPad(m: Metrics): number {
  return Math.ceil(m.cw / 3);
}

/** A canvas of glyphs packed in rows of cell height. */
export class Atlas {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly ctx: Ctx2D;
  private slots = new Map<string, Slot>();
  private shelfX = 0;
  private shelfY = 0;
  /** Part of the canvas drawn since the last take, [x0, y0, x1, y1]. */
  dirty: [number, number, number, number] | null = null;
  /** Counts resets: everything drawn from the atlas before is stale. */
  generation = 0;
  m!: Metrics;

  constructor(size = 1024) {
    this.canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(size, size)
        : Object.assign(document.createElement('canvas'), { width: size, height: size });
    // Drawn on the CPU on purpose: its pixels are read back after each
    // change (whether a glyph has color, the WebGL texture's upload), which
    // a canvas on the GPU would answer with a readback each time.
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as Ctx2D;
  }

  get size(): number {
    return this.canvas.width;
  }

  /** New metrics (font, size, pixel ratio): every glyph is drawn again. */
  setMetrics(m: Metrics) {
    this.m = m;
    this.reset();
  }

  reset() {
    this.slots.clear();
    this.shelfX = 0;
    this.shelfY = 0;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.dirty = null;
    this.generation++;
  }

  /** The slot of a glyph spanning span cells, drawn in color (CSS) for the
   * Canvas 2D renderer or in white for tinting. */
  get(g: GlyphSpec, span: number, color = '#fff'): Slot {
    const key = color === '#fff' ? glyphKey(g, span) : `${color}|${glyphKey(g, span)}`;
    let s = this.slots.get(key);
    if (s) return s;
    const m = this.m;
    const w = span * m.cw + (g.kind === 'text' ? textPad(m) : 0);
    const h = m.ch;
    if (this.shelfX + w > this.canvas.width) {
      this.shelfX = 0;
      this.shelfY += h;
    }
    if (this.shelfY + h > this.canvas.height) {
      // Full: twice the size once, then start over.
      if (this.canvas.width < 4096) {
        const size = this.canvas.width * 2;
        this.canvas.width = size;
        this.canvas.height = size;
      }
      this.reset();
      return this.get(g, span, color);
    }
    const x = this.shelfX;
    const y = this.shelfY;
    this.shelfX += w;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = color;
    let colored = false;
    if (g.kind === 'shape') drawShape(ctx, g.text, x, y, span * m.cw, h);
    else if (g.kind === 'line' || g.kind === 'cursor') drawLine(ctx, g, x, y, span * m.cw, m);
    else {
      const fontFamily = m.cjkFamily && isCjkText(g.text) ? m.cjkFamily : m.family;
      ctx.font = `${g.italic ? 'italic ' : ''}${g.bold ? 700 : m.weight} ${m.fontPx}px ${fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(g.text, x, y + m.baseline);
      // Emoji keep their own colors: any pixel that is not gray.
      if (color === '#fff' && !/^[\x20-\x7e]$/.test(g.text)) colored = hasColor(ctx, x, y, w, h);
    }
    ctx.restore();
    s = { x, y, w, h, colored };
    this.slots.set(key, s);
    const d = this.dirty;
    this.dirty = d ? [Math.min(d[0], x), Math.min(d[1], y), Math.max(d[2], x + w), Math.max(d[3], y + h)] : [x, y, x + w, y + h];
    return s;
  }
}

function hasColor(ctx: Ctx2D, x: number, y: number, w: number, h: number): boolean {
  const px = ctx.getImageData(x, y, w, h).data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 32) continue;
    if (Math.abs(px[i] - px[i + 1]) > 24 || Math.abs(px[i + 1] - px[i + 2]) > 24) return true;
  }
  return false;
}
