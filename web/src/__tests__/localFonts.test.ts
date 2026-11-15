// The font picker's list: only families that are really fixed-pitch and
// draw Latin letters themselves, with names that print, each once, sorted.
// The metrics are those Chromium (the desktop app) measured on macOS at
// 40 px.
import { describe, expect, it } from 'vitest';
import { fixedPitch, pickMonospace, printableName, uniqueNames, type Measure, type TextBox } from '../terminal/localFonts';

interface FontMetrics {
  /** Advance of each character (ten of them are ten times as wide). */
  advance: Record<string, number>;
  x: [number, number];
  p: [number, number];
  H: [number, number];
  /** The family is not drawn by itself: its fallback decides. */
  fallsBack?: boolean;
}

const mono = (w: number, x: [number, number], p: [number, number], H: [number, number]): FontMetrics => ({
  advance: Object.fromEntries(['i', 'm', 'W', ' ', '0', '.', '_', '@'].map((c) => [c, w])),
  x,
  p,
  H,
});

const fonts: Record<string, FontMetrics> = {
  Menlo: mono(24.08, [21.9, 0], [16, 8.3], [29.2, 0]),
  'BIZ UDGothic': mono(20, [22.6, 1], [17, 4.8], [31.4, 0]),
  'CMU Typewriter Text': mono(21, [17.2, 0], [12, 8.9], [24.4, 0]),
  // Its space is narrower than its letters.
  Ayuthaya: { ...mono(24, [21.8, 0], [16, 8.5], [30.3, 0]), advance: { ...mono(24, [0, 0], [0, 0], [0, 0]).advance, ' ': 23.75 } },
  // Pictures at the letters' code points: no descender, x as tall as H.
  'Wingdings 2': { ...mono(35.66, [28.9, 0], [28, 0], [30.4, 0]) },
  // A name that did not decode, drawn as symbols of equal width.
  '???®™??-': mono(20, [22, -0.6], [18, 5.6], [24.7, 0]),
  Helvetica: {
    advance: { i: 8.9, m: 33.3, W: 37.8, ' ': 11.1, '0': 22.2, '.': 11.1, _: 22.2, '@': 40.6 },
    x: [21, 0],
    p: [21, 8],
    H: [28.7, 0],
  },
  'Not Installed Mono': { ...mono(24, [21, 0], [16, 8], [29, 0]), fallsBack: true },
};

/** A stand-in for the canvas: the family named first in the font, its
 * fallback for a family that is not drawn by itself. */
const measure: Measure = (font, text): TextBox => {
  const family = /"([^"]*)"/.exec(font)![1];
  const f = fonts[family];
  const fallback = font.endsWith('monospace') ? 1.1 : 1;
  if (!f || f.fallsBack) return { width: text.length * 20 * fallback, ascent: 20, descent: 5 };
  const width = [...text].reduce((sum, c) => sum + (f.advance[c] ?? f.advance.m), 0);
  const box = text === 'x' ? f.x : text === 'p' ? f.p : text === 'H' ? f.H : [20, 0];
  return { width, ascent: box[0], descent: box[1] };
};

describe('fixed-pitch fonts', () => {
  it('takes families whose characters are equally wide and whose letters are letters', () => {
    expect(fixedPitch('Menlo', measure)).toBe(true);
    expect(fixedPitch('BIZ UDGothic', measure)).toBe(true);
    expect(fixedPitch('CMU Typewriter Text', measure)).toBe(true);
  });

  it('drops proportional families, a narrower space, symbol fonts and families drawn by a fallback', () => {
    expect(fixedPitch('Helvetica', measure)).toBe(false);
    expect(fixedPitch('Ayuthaya', measure)).toBe(false);
    expect(fixedPitch('Wingdings 2', measure)).toBe(false);
    expect(fixedPitch('???®™??-', measure)).toBe(false);
    expect(fixedPitch('Not Installed Mono', measure)).toBe(false);
  });
});

describe('the list', () => {
  it('keeps names that print, once each, the first spelling', () => {
    for (const ok of ['Menlo', 'JetBrains Mono NL', '楷体', '3270 Condensed', 'Sarasa Mono SC']) expect(printableName(ok), ok).toBe(true);
    for (const bad of ['???®™??-', '', '  ', '-Mono', '.SF NS Mono', 'A\u0007B', 'Mono�', 'Private', 'x'.repeat(101)])
      expect(printableName(bad), JSON.stringify(bad)).toBe(false);
    expect(uniqueNames(['Menlo', ' menlo ', 'MENLO', 'Monaco', '???®™??-'])).toEqual(['Menlo', 'Monaco']);
  });

  it('lists the fixed-pitch families sorted, from a list with duplicates and garbage', () => {
    const families = ['Wingdings 2', 'Menlo', 'Helvetica', '???®™??-', 'Ayuthaya', 'BIZ UDGothic', 'menlo', 'CMU Typewriter Text'];
    expect(pickMonospace(families, (f) => fixedPitch(f, measure))).toEqual(['BIZ UDGothic', 'CMU Typewriter Text', 'Menlo']);
  });
});
