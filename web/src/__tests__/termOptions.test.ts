import { describe, expect, it } from 'vitest';
import { loadTermFont, termFontFamily } from '../terminal/fonts';
import { appearanceOf } from '../appearance';
import { getPrefs } from '../prefs';
import { lookOf } from '../vt/renderer';

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

// Palette indexes of the ANSI colors.
const normal = { red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6 };
const bright = { brightRed: 9, brightGreen: 10, brightBlue: 12, brightMagenta: 13, brightCyan: 14 };

describe('terminal themes', () => {
  // The defaults of the terminal.colors.* settings.
  for (const kind of ['dark', 'light'] as const) {
    it(`keeps ${kind} text readable`, () => {
      const c = getPrefs().colors[kind];
      const bg = c.background;
      expect(contrast(c.foreground, bg)).toBeGreaterThanOrEqual(12);
      // Dim and comment text (bright black) and colored text stay legible
      // (light themes' bright colors are lighter); black must still differ
      // from the background.
      expect(contrast(c.palette[8], bg)).toBeGreaterThanOrEqual(4);
      for (const [k, i] of Object.entries(normal)) expect(contrast(c.palette[i], bg), k).toBeGreaterThanOrEqual(4.5);
      for (const [k, i] of Object.entries(bright)) expect(contrast(c.palette[i], bg), k).toBeGreaterThanOrEqual(3);
      expect(contrast(c.palette[0], bg)).toBeGreaterThanOrEqual(kind === 'dark' ? 2 : 10);
    });
  }
  it('takes the selection from the settings and dims matches on dark backgrounds', () => {
    const dark = lookOf('#3b4a6b', '#0a0a0a');
    const light = lookOf('#b6d4fe', '#ffffff');
    expect(dark.selection).toBe(0x3b4a6b);
    expect(light.selection).toBe(0xb6d4fe);
    expect(dark.match).toBeLessThan(light.match);
  });
});

describe('terminal font', () => {
  it('uses only the fallbacks until the bundled font is loaded', async () => {
    // jsdom has no FontFace, like a browser where the font cannot load.
    expect(await loadTermFont(400)).toBe(false);
    expect(termFontFamily(400)).not.toContain('JetBrains Mono');
  });
  it('puts the chosen family first', () => {
    expect(termFontFamily(400, 'Fira Code')).toMatch(/^"Fira Code", /);
    expect(termFontFamily(400, '"My Font", monospace')).toMatch(/^"My Font", monospace, /);
    expect(termFontFamily(400, '  ')).toBe(termFontFamily(400));
  });
  it('maps the terminal settings', () => {
    const prefs = getPrefs();
    expect(appearanceOf(prefs)).toMatchObject({
      fontWeight: 400,
      lineHeight: 1.05,
      cursorStyle: 'bar',
      cursorWidth: 1,
      cursorBlink: true,
      boldIsBright: false,
    });
    expect(appearanceOf({ ...prefs, termFontWeight: 'medium' }).fontWeight).toBe(500);
    const a = appearanceOf({
      ...prefs,
      termLineHeight: 1.3,
      termFontFamily: 'Menlo',
      theme: 'light',
      cursorStyle: 'underline',
      cursorWidth: 2,
      boldIsBright: true,
    });
    expect(a).toMatchObject({
      lineHeight: 1.3,
      fontFamily: 'Menlo',
      cursorStyle: 'underline',
      cursorWidth: 2,
      boldIsBright: true,
      colors: { background: '#ffffff' },
    });
  });
});
