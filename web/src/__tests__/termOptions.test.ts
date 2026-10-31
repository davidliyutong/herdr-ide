import { describe, expect, it } from 'vitest';
import type { ITheme } from '@xterm/xterm';
import { termOptions, themes } from '../terminal/options';
import { loadTermFont, termFontFamily } from '../terminal/fonts';
import { appearanceOf } from '../appearance';
import { parsePref, prefDefs, type Prefs } from '../prefs';

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
  for (const [kind, th] of Object.entries(themes)) {
    it(`keeps ${kind} text readable`, () => {
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
});

describe('terminal font', () => {
  it('uses only the fallbacks until the bundled font is loaded', async () => {
    // jsdom has no FontFace, like a browser where the font cannot load.
    expect(await loadTermFont(400)).toBe(false);
    expect(termFontFamily(400)).not.toContain('JetBrains Mono');
    expect(termOptions({ theme: 'dark', fontSize: 13, fontWeight: 400 }).fontFamily).toBe(termFontFamily(400));
  });
  it('maps the weight setting', () => {
    const prefs = Object.fromEntries(Object.keys(prefDefs).map((k) => [k, parsePref(k as keyof Prefs, null)])) as Prefs;
    expect(appearanceOf(prefs).fontWeight).toBe(400);
    expect(appearanceOf({ ...prefs, termFontWeight: 'medium' }).fontWeight).toBe(500);
    expect(termOptions(appearanceOf(prefs))).toMatchObject({ fontWeight: 400, fontWeightBold: 700, lineHeight: 1.05 });
  });
});
