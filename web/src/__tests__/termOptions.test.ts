import { describe, expect, it } from 'vitest';
import type { ITheme } from '@xterm/xterm';
import { termOptions, xtermTheme } from '../terminal/options';
import { loadTermFont, termFontFamily } from '../terminal/fonts';
import { appearanceOf } from '../appearance';
import { getPrefs } from '../prefs';

// WCAG contrast ratio of two #rrggbb colors.
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lo, hi] = [lum(a), lum(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
}

const normal: Array<keyof ITheme> = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];
const bright: Array<keyof ITheme> = ['brightRed', 'brightGreen', 'brightBlue', 'brightMagenta', 'brightCyan'];

describe('terminal themes', () => {
  // The defaults of the terminal.colors.* settings.
  for (const kind of ['dark', 'light'] as const) {
    it(`keeps ${kind} text readable`, () => {
      const th = xtermTheme(getPrefs().colors[kind]);
      const bg = th.background!;
      expect(contrast(th.foreground!, bg)).toBeGreaterThanOrEqual(12);
      // Dim and comment text (bright black) and colored text stay legible
      // (light themes' bright colors are lighter); black must still differ
      // from the background.
      expect(contrast(th.brightBlack!, bg)).toBeGreaterThanOrEqual(4);
      for (const k of normal) expect(contrast(th[k] as string, bg), k).toBeGreaterThanOrEqual(4.5);
      for (const k of bright) expect(contrast(th[k] as string, bg), k).toBeGreaterThanOrEqual(3);
      expect(contrast(th.black!, bg)).toBeGreaterThanOrEqual(kind === 'dark' ? 2 : 10);
    });
  }
  it('maps the palette to xterm.js’s names in order', () => {
    const c = getPrefs().colors.light;
    const th = xtermTheme({ ...c, palette: c.palette.map((_, i) => `#0000${i.toString(16).padStart(2, '0')}`) });
    expect(th.black).toBe('#000000');
    expect(th.white).toBe('#000007');
    expect(th.brightBlack).toBe('#000008');
    expect(th.brightWhite).toBe('#00000f');
    expect(th.cursorAccent).toBe(c.background);
    expect(th.selectionBackground).toBe(c.selection);
  });
});

describe('terminal font', () => {
  it('uses only the fallbacks until the bundled font is loaded', async () => {
    // jsdom has no FontFace, like a browser where the font cannot load.
    expect(await loadTermFont(400)).toBe(false);
    expect(termFontFamily(400)).not.toContain('JetBrains Mono');
    const a = appearanceOf(getPrefs());
    expect(termOptions(a).fontFamily).toBe(termFontFamily(400));
  });
  it('puts the chosen family first', () => {
    expect(termFontFamily(400, 'Fira Code')).toMatch(/^"Fira Code", /);
    expect(termFontFamily(400, '"My Font", monospace')).toMatch(/^"My Font", monospace, /);
    expect(termFontFamily(400, '  ')).toBe(termFontFamily(400));
  });
  it('maps the weight, family and line height settings', () => {
    const prefs = getPrefs();
    expect(appearanceOf(prefs).fontWeight).toBe(400);
    expect(appearanceOf({ ...prefs, termFontWeight: 'medium' }).fontWeight).toBe(500);
    expect(termOptions(appearanceOf(prefs))).toMatchObject({ fontWeight: 400, fontWeightBold: 700, lineHeight: 1.05 });
    const a = appearanceOf({ ...prefs, termLineHeight: 1.3, termFontFamily: 'Menlo', theme: 'light' });
    expect(termOptions(a)).toMatchObject({ lineHeight: 1.3, theme: { background: '#ffffff' } });
    expect(termOptions(a).fontFamily).toMatch(/^"Menlo"/);
  });
});
