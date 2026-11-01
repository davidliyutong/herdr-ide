// Draws a Grid on a canvas. Rows marked dirty are repainted completely
// (backgrounds, text, decorations, selection and cursor), one animation
// frame at a time. Box-drawing and block characters are drawn as shapes so
// that borders join without gaps at any cell size.

import type { Grid } from './grid';
import type { Cell } from './protocol';
import { color, type Palette } from './colors';
import { symbolWidth } from './width';

// Modifier bits (ratatui) and herdr's underline style in bits 12-15.
export const MOD = {
  bold: 1,
  dim: 2,
  italic: 4,
  underline: 8,
  slowBlink: 0x10,
  rapidBlink: 0x20,
  reversed: 0x40,
  hidden: 0x80,
  crossed: 0x100,
} as const;

export interface Metrics {
  /** Cell size in device pixels. */
  cw: number;
  ch: number;
  /** Font size in device pixels and the font families. */
  fontPx: number;
  family: string;
  weight: number;
  /** Baseline offset from the top of a cell, in device pixels. */
  baseline: number;
}

/** A highlighted range per row: columns [from, to). */
export type Highlight = (y: number) => Array<[number, number]> | undefined;

export interface PaintState {
  palette: Palette;
  metrics: Metrics;
  focused: boolean;
  highlight?: Highlight;
  /** Cells under the hovered link, underlined. */
  hover?: { y: number; from: number; to: number };
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

/** Draws a box-drawing or block character; false if it is not one. */
export function drawShape(ctx: CanvasRenderingContext2D, ch: string, x: number, y: number, w: number, h: number): boolean {
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
  // Quadrants ▖..▟: bits upper-left, upper-right, lower-left, lower-right.
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

/** Columns a cell's symbol takes (herdr's cell_width). */
function cellWidth(c: Cell): number {
  return symbolWidth(c.symbol || ' ');
}

/** Paints the dirty rows of g. */
export function paintRows(ctx: CanvasRenderingContext2D, g: Grid, st: PaintState, rows: Iterable<number>) {
  const { cw, ch, fontPx, family, weight, baseline } = st.metrics;
  const p = st.palette;
  ctx.textBaseline = 'alphabetic';
  for (const y of rows) {
    if (y < 0 || y >= g.h) continue;
    const top = y * ch;
    const hl = st.highlight?.(y);
    const inHl = (x: number) => !!hl?.some(([a, b]) => x >= a && x < b);
    // Backgrounds.
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, top, g.w * cw, ch);
    // A wide character's style covers the cells it spans: herdr leaves
    // those cells in the grid with their own (default) style, and its
    // renderer never draws them, so neither does this one.
    let cover = 0;
    for (let x = 0; x < g.w; x++) {
      if (cover > 0) {
        cover--;
        continue;
      }
      const c = g.cell(x, y);
      if (c.skip) continue;
      const wdt = cellWidth(c);
      cover = wdt - 1;
      const bg = c.mod & MOD.reversed ? (color(p, c.fg) ?? p.fg) : color(p, c.bg);
      for (let i = 0; i < wdt && x + i < g.w; i++) {
        const fill = inHl(x + i) ? p.selection : bg;
        if (!fill) continue;
        ctx.fillStyle = fill;
        ctx.fillRect((x + i) * cw, top, cw, ch);
      }
    }
    // Text and decorations.
    cover = 0;
    for (let x = 0; x < g.w; x++) {
      if (cover > 0) {
        cover--;
        continue;
      }
      const c = g.cell(x, y);
      if (c.skip) continue;
      const sym = c.symbol;
      const wdt = cellWidth(c);
      cover = wdt - 1;
      let fg = c.mod & MOD.reversed ? (color(p, c.bg) ?? p.bg) : (color(p, c.fg) ?? p.fg);
      const cur = g.cursor;
      const onCursor = cur && cur.visible && cur.y === y && cur.x === x && st.focused && (cur.shape === 0 || cur.shape <= 2);
      if (onCursor) fg = p.cursorAccent;
      const left = x * cw;
      ctx.fillStyle = fg;
      ctx.globalAlpha = c.mod & MOD.dim ? 0.55 : 1;
      if (onCursor) {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = p.cursor;
        ctx.fillRect(left, top, cw * wdt, ch);
        ctx.restore();
        ctx.fillStyle = fg;
      }
      if (sym && sym !== ' ' && !(c.mod & MOD.hidden)) {
        if (!drawShape(ctx, sym, left, top, cw, ch)) {
          const bold = c.mod & MOD.bold ? 700 : weight;
          const italic = c.mod & MOD.italic ? 'italic ' : '';
          ctx.font = `${italic}${bold} ${fontPx}px ${family}`;
          ctx.save();
          ctx.beginPath();
          ctx.rect(left, top, cw * wdt, ch);
          ctx.clip();
          ctx.fillText(sym, left, top + baseline);
          ctx.restore();
        }
      }
      const thin = Math.max(1, Math.round(ch / 16));
      const linked = st.hover && st.hover.y === y && x >= st.hover.from && x < st.hover.to;
      if (c.mod & MOD.underline || linked) {
        const style = (c.mod >> 12) & 0xf;
        const uy = top + baseline + thin;
        if (style === 2) {
          ctx.fillRect(left, uy, cw * wdt, thin);
          ctx.fillRect(left, uy + thin * 2, cw * wdt, thin);
        } else if (style === 3) {
          ctx.save();
          ctx.strokeStyle = fg;
          ctx.lineWidth = thin;
          ctx.beginPath();
          const amp = thin;
          for (let i = 0; i <= cw * wdt; i += 2) ctx.lineTo(left + i, uy + Math.sin((i / (cw / 2)) * Math.PI) * amp);
          ctx.stroke();
          ctx.restore();
        } else if (style === 4 || style === 5) {
          const dash = style === 4 ? thin : thin * 3;
          for (let i = 0; i < cw * wdt; i += dash * 2) ctx.fillRect(left + i, uy, Math.min(dash, cw * wdt - i), thin);
        } else ctx.fillRect(left, uy, cw * wdt, thin);
      }
      if (c.mod & MOD.crossed) ctx.fillRect(left, top + Math.round(ch / 2), cw * wdt, thin);
      ctx.globalAlpha = 1;
    }
    // Cursor shapes other than a focused block.
    const cur = g.cursor;
    if (cur && cur.visible && cur.y === y) {
      const left = cur.x * cw;
      const wdt = cellWidth(g.cell(cur.x, y));
      const thick = Math.max(1, Math.round(cw / 8));
      ctx.fillStyle = p.cursor;
      ctx.strokeStyle = p.cursor;
      if (cur.shape === 3 || cur.shape === 4) ctx.fillRect(left, top + ch - thick, cw * wdt, thick);
      else if (cur.shape === 5 || cur.shape === 6) ctx.fillRect(left, top, thick, ch);
      else if (!st.focused) {
        ctx.lineWidth = thick;
        ctx.strokeRect(left + thick / 2, top + thick / 2, cw * wdt - thick, ch - thick);
      }
    }
  }
}
