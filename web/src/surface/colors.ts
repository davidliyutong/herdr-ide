// herdr's packed cell colors (src/protocol/wire.rs): 0x000000NN is a named
// color (0 = the default foreground or background), 0x010000II a palette
// index, 0x02RRGGBB a true color.

import type { ITheme } from '@xterm/xterm';

export interface Palette {
  fg: string;
  bg: string;
  cursor: string;
  cursorAccent: string;
  selection: string;
  /** 256 colors: the theme's 16, the 6x6x6 cube and the grey ramp. */
  colors: string[];
}

const hex = (n: number) => n.toString(16).padStart(2, '0');
const rgbHex = (r: number, g: number, b: number) => `#${hex(r)}${hex(g)}${hex(b)}`;

export function palette(t: ITheme): Palette {
  const ansi = [
    t.black,
    t.red,
    t.green,
    t.yellow,
    t.blue,
    t.magenta,
    t.cyan,
    t.white,
    t.brightBlack,
    t.brightRed,
    t.brightGreen,
    t.brightYellow,
    t.brightBlue,
    t.brightMagenta,
    t.brightCyan,
    t.brightWhite,
  ].map((c) => c ?? '#888888');
  const colors = [...ansi];
  const level = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) colors.push(rgbHex(level[r], level[g], level[b]));
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    colors.push(rgbHex(v, v, v));
  }
  const fg = t.foreground ?? '#ffffff';
  const bg = t.background ?? '#000000';
  return { fg, bg, cursor: t.cursor ?? fg, cursorAccent: t.cursorAccent ?? bg, selection: t.selectionBackground ?? '#3b4a6b', colors };
}

// Named colors 1..16 in ratatui order: Black, Red, Green, Yellow, Blue,
// Magenta, Cyan, Gray (SGR 37), DarkGray (90), LightRed … LightCyan, White (97).
const named = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** CSS color of a packed color; undefined for the default. */
export function color(p: Palette, c: number): string | undefined {
  const kind = c >>> 24;
  if (kind === 2) return rgbHex((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  if (kind === 1) return p.colors[c & 0xff];
  if (kind === 0 && c >= 1 && c <= 16) return p.colors[named[c - 1]];
  return undefined;
}

/** Parses #rrggbb into its components. */
export function rgb(css: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(css);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
