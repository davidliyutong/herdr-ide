import { describe, expect, it } from 'vitest';
import { isCjkText, loadTermFont, monoCssFontFamily, termCjkFontFamily, termFontFamily, uiCssFontFamily } from '../terminal/fonts';
import { appearanceOf } from '../appearance';
import { getPrefs } from '../prefs';
import { Atlas, measureCell } from '../vt/atlas';
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
  it('keeps custom CJK font separate behind Latin fonts and routes CJK glyphs in the atlas', () => {
    const stack = termFontFamily(400, 'Fira Code', 'LXGW WenKai Mono');
    expect(stack).toMatch(/^"Fira Code", /);
    expect(stack.indexOf('"Fira Code"')).toBeLessThan(stack.indexOf('"LXGW WenKai Mono"'));
    expect(stack.indexOf('"LXGW WenKai Mono"')).toBeLessThan(stack.indexOf('"Noto Sans Mono CJK SC"'));
    expect(termFontFamily(400, '', 'PingFang SC')).toMatch(/^"SF Mono", .*"PingFang SC", "Noto Sans Mono CJK SC"/);

    expect(termCjkFontFamily(400, 'Fira Code', '')).toBeUndefined();
    const cjkStack = termCjkFontFamily(400, 'Fira Code', 'Songti SC')!;
    expect(cjkStack).toMatch(/^"Songti SC", "Fira Code", /);

    expect(isCjkText('A')).toBe(false);
    expect(isCjkText('hello 123')).toBe(false);
    expect(isCjkText('中')).toBe(true);
    expect(isCjkText('あ')).toBe(true);
    expect(isCjkText('한')).toBe(true);
    expect(isCjkText('，')).toBe(true);

    // UI font stack: Latin-only defaults precede custom CJK so macOS -apple-system cannot shadow it.
    expect(uiCssFontFamily('', '')).toBe('');
    expect(uiCssFontFamily('Inter', '')).toMatch(/^"Inter", -apple-system/);
    const uiBoth = uiCssFontFamily('Inter', 'LXGW WenKai');
    expect(uiBoth.indexOf('"Inter"')).toBeLessThan(uiBoth.indexOf('"LXGW WenKai"'));
    expect(uiBoth.indexOf('"LXGW WenKai"')).toBeLessThan(uiBoth.indexOf('-apple-system'));
    const uiCjkOnly = uiCssFontFamily('', 'Songti SC');
    expect(uiCjkOnly.indexOf("'Helvetica Neue'")).toBeLessThan(uiCjkOnly.indexOf('"Songti SC"'));
    expect(uiCjkOnly.indexOf('"Songti SC"')).toBeLessThan(uiCjkOnly.indexOf('-apple-system'));

    expect(monoCssFontFamily('', '')).toBe('');
    const monoBoth = monoCssFontFamily('Iosevka', 'Sarasa Mono SC');
    expect(monoBoth.indexOf('"Iosevka"')).toBeLessThan(monoBoth.indexOf('"Sarasa Mono SC"'));
    expect(monoBoth.indexOf('"Sarasa Mono SC"')).toBeLessThan(monoBoth.indexOf("'PingFang SC'"));
  });
  it('measures terminal cells from the Latin font and draws CJK glyphs with cjkFamily in Atlas', () => {
    const fontsUsed: Array<{ font: string; text: string }> = [];
    const fakeCtx = {
      font: '',
      fillStyle: '',
      textBaseline: '',
      measureText: (text: string) => {
        fontsUsed.push({ font: fakeCtx.font, text });
        return { width: 8, fontBoundingBoxAscent: 11, fontBoundingBoxDescent: 3 };
      },
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      rect: () => {},
      clip: () => {},
      fillText: (text: string) => {
        fontsUsed.push({ font: fakeCtx.font, text });
      },
      getImageData: () => ({ data: new Uint8ClampedArray(16) }),
    } as unknown as CanvasRenderingContext2D;

    const metrics = measureCell(
      fakeCtx,
      { fontFamily: 'Fira Code', cjkFontFamily: 'LXGW WenKai', fontSize: 14, fontWeight: 400, lineHeight: 1.1 },
      1,
    );
    expect(fontsUsed[0]).toEqual({ font: `400 14px ${metrics.family}`, text: 'W' });
    expect(metrics.cjkFamily).toMatch(/^"LXGW WenKai", "Fira Code", /);

    // Exercise Atlas glyph font selection with a mocked 2D context.
    const origOffscreen = globalThis.OffscreenCanvas;
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return fakeCtx;
      }
    };
    try {
      const atlas = new Atlas(256);
      atlas.setMetrics(metrics);
      fontsUsed.length = 0;
      atlas.get({ kind: 'text', text: 'A', bold: false, italic: false }, 1);
      atlas.get({ kind: 'text', text: '中', bold: false, italic: false }, 2);
      expect(fontsUsed[0].font).toBe(`400 14px ${metrics.family}`);
      expect(fontsUsed[1].font).toBe(`400 14px ${metrics.cjkFamily}`);
    } finally {
      (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = origOffscreen;
    }
  });
  it('maps the terminal settings', () => {
    const prefs = getPrefs();
    expect(appearanceOf(prefs)).toMatchObject({
      fontWeight: 400,
      lineHeight: 1.05,
      cjkFontFamily: '',
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
      termCjkFontFamily: 'PingFang SC',
      theme: 'light',
      cursorStyle: 'underline',
      cursorWidth: 2,
      boldIsBright: true,
    });
    expect(a).toMatchObject({
      lineHeight: 1.3,
      fontFamily: 'Menlo',
      cjkFontFamily: 'PingFang SC',
      cursorStyle: 'underline',
      cursorWidth: 2,
      boldIsBright: true,
      colors: { background: '#ffffff' },
    });
  });
});
