import { describe, expect, it } from 'vitest';
import { decodeUpdate, type SurfacePane, type SurfaceUpdate } from '../surface/protocol';
import { Grid } from '../surface/grid';
import { symbolWidth } from '../surface/width';
import { color, palette } from '../surface/colors';
import { Selection, readRange, scrollRate, span, viewTop, wordAt } from '../surface/selection';
import { keyEvent, pasteText, releaseOf } from '../surface/input';
import { findLinks, safeUrl } from '../terminal/links';
import vectorData from './testdata/surface.json';
import { themes } from '../terminal/options';
import { moveRanges, paintRows, sameRanges } from '../surface/paint';

/** The messages internal/server's TestSurfaceBinaryVector pins. */
function vectors(): ArrayBuffer[] {
  return [vectorData.full, vectorData.patch].map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer as ArrayBuffer);
}

const cell = (symbol: string) => ({ symbol, fg: 0, bg: 0, mod: 0, skip: false, link: -1 });

function full(w: number, h: number, rows: string[], gen = 1): SurfaceUpdate {
  return {
    full: true,
    gen,
    w,
    h,
    moves: [],
    spans: rows.map((r, y) => ({ x: 0, y, cells: [...r.padEnd(w)].map(cell) })),
  };
}

const text = (g: Grid) => Array.from({ length: g.h }, (_, y) => g.rowText(y).text.trimEnd());

describe('surface protocol (Go encoder vectors)', () => {
  it('decodes complete surfaces and patches', () => {
    const [f, p] = vectors().map(decodeUpdate);
    expect(f.full).toBe(true);
    expect([f.gen, f.w, f.h]).toEqual([7, 3, 2]);
    expect(f.cursor).toEqual({ x: 2, y: 1, visible: true, shape: 6 });
    expect(f.spans).toHaveLength(2);
    expect(f.spans[0].cells.map((c) => c.symbol)).toEqual(['a', '宽', ' ']);
    expect(f.spans[0].cells[0]).toMatchObject({ fg: 2, bg: 0x01000010, mod: 1, skip: false, link: -1 });
    expect(f.spans[0].cells[1].fg).toBe(0x02123456);
    expect(f.spans[0].cells[2].skip).toBe(true);
    expect(f.spans[1].cells.map((c) => c.symbol)).toEqual(['─', 'é', '']);
    expect(f.spans[1].cells[1].link).toBe(0);
    expect(f.spans[1].cells[2].mod).toBe(0x40 | (3 << 12));
    expect(p.full).toBe(false);
    expect(p.moves).toEqual([{ rect: { x: 0, y: 0, w: 3, h: 2 }, shift: 1 }]);
    expect(p.spans).toEqual([{ x: 1, y: 1, cells: [{ ...cell('z'), fg: 9 }] }]);
    expect(p.cursor).toBeUndefined();
  });
});

describe('Grid', () => {
  it('applies surfaces, patches and row moves in herdr order', () => {
    const g = new Grid();
    expect(g.apply({ ...full(2, 1, ['x']), full: false })).toBe(false);
    g.apply(full(3, 5, ['a', 'b', 'c', 'd', 'e']));
    g.dirty.clear();
    // Shift 2 moves content up two rows; the vacated rows rotate in.
    g.apply({
      full: false,
      gen: 1,
      w: 0,
      h: 0,
      moves: [{ rect: { x: 0, y: 0, w: 3, h: 5 }, shift: 2 }],
      spans: [{ x: 0, y: 4, cells: [cell('f')] }],
    });
    expect(text(g).slice(0, 3)).toEqual(['c', 'd', 'e']);
    expect(text(g)[4]).toBe('f');
    // The painter copies the moved rows; only the vacated ones are painted.
    expect([...g.dirty].sort()).toEqual([3, 4]);
    expect(g.moves).toEqual([{ rect: { x: 0, y: 0, w: 3, h: 5 }, shift: 2 }]);
    g.apply({ full: false, gen: 1, w: 0, h: 0, moves: [{ rect: { x: 0, y: 0, w: 3, h: 5 }, shift: -1 }], spans: [] });
    expect(text(g).slice(1, 3)).toEqual(['c', 'd']);
    // Rows not yet painted take their stale pixels along: 3 and 4 moved to
    // 4 (and off the region), and row 0 is vacated.
    expect([...g.dirty].sort()).toEqual([0, 3, 4]);
    expect(g.moves).toHaveLength(2);
    g.invalidate();
    expect(g.moves).toEqual([]);
    // Patches of an older generation are dropped.
    expect(g.apply({ full: false, gen: 0, w: 0, h: 0, moves: [], spans: [{ x: 0, y: 0, cells: [cell('z')] }] })).toBe(false);
  });

  it('marks the old cursor row where its pixels moved', () => {
    const g = new Grid();
    g.apply({ ...full(3, 4, ['a', 'b', 'c', 'd']), cursor: { x: 0, y: 3, visible: true, shape: 0 } });
    g.dirty.clear();
    g.apply({ full: false, gen: 1, w: 0, h: 0, moves: [{ rect: { x: 0, y: 0, w: 3, h: 4 }, shift: 1 }], spans: [] });
    // Row 3 is vacated; the cursor's pixels moved up to row 2.
    expect([...g.dirty].sort()).toEqual([2, 3]);
  });

  it('reads text without the cells wide characters cover', () => {
    const g = new Grid();
    g.apply(full(4, 1, ['宽 x']));
    expect(g.rowText(0).text).toBe('宽x ');
    expect(g.rowText(0).colOf).toEqual([0, 2, 3, 4]);
  });
});

describe('paintRows', () => {
  it('gives a wide character its background over every cell it covers', () => {
    const p = palette(themes.light);
    const fills: Array<{ style: string; x: number; w: number }> = [];
    const ctx = {
      fillStyle: '',
      fillRect(x: number, _y: number, w: number) {
        fills.push({ style: this.fillStyle, x, w });
      },
      fillText() {},
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
    };
    const g = new Grid();
    const band = 0x023c3c3c;
    // herdr leaves the covered cell with the default style.
    g.apply({
      full: true,
      gen: 1,
      w: 4,
      h: 1,
      moves: [],
      spans: [{ x: 0, y: 0, cells: [{ ...cell('宽'), bg: band }, cell(' '), { ...cell('x'), bg: band }, cell(' ')] }],
    });
    const metrics = { cw: 10, ch: 20, fontPx: 16, family: 'mono', weight: 400, baseline: 15 };
    paintRows(ctx as unknown as CanvasRenderingContext2D, g, { palette: p, metrics, focused: false }, [0]);
    // After the row's base fill, column 1 is painted only with the band.
    const bgs = fills.slice(1).filter((f) => f.x < 40 && f.w === 10);
    expect(bgs.filter((f) => f.x === 10).map((f) => f.style)).toEqual(['#3c3c3c']);
    expect(bgs.map((f) => f.x)).toEqual([0, 10, 20]);
  });

  it('clips text to its row, and only glyphs that may overflow to their cells', () => {
    const p = palette(themes.light);
    const clips: Array<[number, number]> = [];
    const fonts: string[] = [];
    let depth = 0;
    const ctx = {
      fillStyle: '',
      set font(f: string) {
        fonts.push(f);
      },
      fillRect() {},
      fillText() {},
      save() {
        depth++;
      },
      restore() {
        depth--;
      },
      beginPath() {},
      rect(x: number, _y: number, w: number) {
        clips.push([x, w]);
      },
      clip() {},
    };
    const g = new Grid();
    g.apply({
      full: true,
      gen: 1,
      w: 5,
      h: 1,
      moves: [],
      spans: [{ x: 0, y: 0, cells: [cell('a'), cell('b'), cell('宽'), cell(''), { ...cell('c'), mod: 4 }] }],
    });
    const metrics = { cw: 10, ch: 20, fontPx: 16, family: 'mono', weight: 400, baseline: 15 };
    paintRows(ctx as unknown as CanvasRenderingContext2D, g, { palette: p, metrics, focused: false }, [0]);
    // The row, the wide character (two cells) and the italic one.
    expect(clips).toEqual([
      [0, 50],
      [20, 20],
      [40, 10],
    ]);
    expect(depth).toBe(0);
    // Set once per style, not per glyph.
    expect(fonts).toEqual(['400 16px mono', 'italic 400 16px mono']);
  });
});

describe('painted highlights', () => {
  it('compares ranges', () => {
    expect(sameRanges(undefined, [])).toBe(true);
    expect(sameRanges([[1, 3]], [[1, 3]])).toBe(true);
    expect(sameRanges([[1, 3]], [[1, 4]])).toBe(false);
    expect(sameRanges([[1, 3]], undefined)).toBe(false);
  });
  it('move with the rows copied, inside the moved columns only', () => {
    // A pane in columns 0-4 scrolled up one row; another pane in 5-9 kept
    // its highlight on row 1.
    const painted = [
      [[0, 5]],
      [
        [2, 5],
        [6, 8],
      ],
      undefined,
      undefined,
    ] as Array<Array<[number, number]> | undefined>;
    const r = moveRanges(painted, { rect: { x: 0, y: 0, w: 5, h: 3 }, shift: 1 });
    expect(r.painted).toEqual([[[2, 5]], [[6, 8]], undefined, undefined]);
    expect(r.repaint).toEqual([]);
    // A range across the moved columns cannot be kept.
    expect(moveRanges([[[3, 7]], undefined], { rect: { x: 0, y: 0, w: 5, h: 2 }, shift: -1 }).repaint).toEqual([0, 1]);
  });
});

describe('symbolWidth', () => {
  it('counts wide and emoji symbols as two columns', () => {
    expect(symbolWidth('a')).toBe(1);
    expect(symbolWidth('宽')).toBe(2);
    expect(symbolWidth('한')).toBe(2);
    expect(symbolWidth('😀')).toBe(2);
    expect(symbolWidth('❤️')).toBe(2);
    expect(symbolWidth('─')).toBe(1);
    expect(symbolWidth('é')).toBe(1);
    // A flag, a lone regional indicator, text presentation, a blanked wide cell.
    expect(symbolWidth('\u{1f1e8}\u{1f1f3}')).toBe(2);
    expect(symbolWidth('\u{1f1e8}')).toBe(1);
    expect(symbolWidth('\u231a\ufe0e')).toBe(1);
    expect(symbolWidth('  ')).toBe(2);
    // Ranges unicode-width counts as wide: Yijing, Khitan, Kana Extended-B, folk-religion symbols.
    for (const cp of [0x268a, 0x2630, 0x18b00, 0x1aff0, 0x1f260]) expect(symbolWidth(String.fromCodePoint(cp))).toBe(2);
  });
});

describe('Grid.width', () => {
  it('counts a cell before a wide spacer as two columns', () => {
    const g = new Grid();
    // herdr pane content: a wide cell is followed by an empty spacer.
    g.apply(full(5, 1, []));
    const sym = String.fromCodePoint(0x16ff0);
    g.apply({ full: false, gen: 1, w: 0, h: 0, moves: [], spans: [{ x: 0, y: 0, cells: [sym, '', 'a', '', ' '].map(cell) }] });
    expect([0, 2, 4].map((x) => g.width(x, 0))).toEqual([2, 2, 1]);
    expect(g.rowText(0).text).toBe(`${sym}a `);
  });
});

describe('colors', () => {
  const p = palette(themes.dark);
  it('resolves herdr packed colors', () => {
    expect(color(p, 0)).toBeUndefined();
    expect(color(p, 2)).toBe(themes.dark.red);
    expect(color(p, 9)).toBe(themes.dark.brightBlack);
    expect(color(p, 0x10)).toBe(themes.dark.brightWhite);
    expect(color(p, 0x01000010)).toBe('#000000');
    expect(color(p, 0x010000e8)).toBe('#080808');
    expect(color(p, 0x02123456)).toBe('#123456');
  });
});

describe('selection', () => {
  const pane: SurfacePane = {
    id: 'p',
    rect: { x: 0, y: 0, w: 12, h: 5 },
    inner: { x: 1, y: 1, w: 10, h: 3 },
    scroll: { offset_from_bottom: 5, max_offset_from_bottom: 20, viewport_rows: 3 },
    focused: true,
    mouse: false,
    alt: false,
  };
  it('keeps absolute rows and highlights only the visible part', () => {
    expect(viewTop(pane.scroll)).toBe(15);
    const s = new Selection('p', 10, { row: 14, col: 4 });
    s.cursor = { row: 16, col: 2 };
    expect(s.columns(pane, 0)).toBeUndefined(); // the border row
    expect(s.columns(pane, 1)).toEqual([1, 11]); // row 15, inside the selection
    expect(s.columns(pane, 2)).toEqual([1, 3]); // row 16 up to column 2
    expect(s.columns(pane, 3)).toBeUndefined();
    expect(s.columns({ ...pane, id: 'other' }, 1)).toBeUndefined();
  });
  it('reads inclusive cell ranges', () => {
    expect(span({ row: 2, col: 3 }, { row: 1, col: 0 }, 10)).toEqual([10, 23]);
    expect(readRange({ row: 1, col: 0 }, { row: 2, col: 3 }, 10)).toEqual({ anchor: { row: 1, col: 0 }, cursor: { row: 2, col: 2 } });
    expect(readRange({ row: 1, col: 4 }, { row: 1, col: 4 }, 10)).toBeUndefined();
    // Lines per second past an edge: by distance and by time held.
    expect(scrollRate(0, 16, 0)).toBe(20);
    expect(scrollRate(32, 16, 0)).toBe(60);
    expect(scrollRate(0, 16, 2000)).toBe(40);
    expect(scrollRate(0, 16, 60000)).toBe(80);
    expect(scrollRate(100000, 16, 60000)).toBe(2000);
  });
  it('asks herdr for the text, clamped to the lines it has', async () => {
    const s = new Selection('p', 10, { row: 3, col: 0 });
    s.cursor = { row: 40, col: 0 };
    const calls: unknown[] = [];
    s.read(pane, async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { text: 'all of it' } as T;
    });
    expect(await s.reading).toBe('all of it');
    expect(calls).toEqual([
      { method: 'pane.selection.read', params: { pane_id: 'p', anchor: { row: 3, col: 0 }, cursor: { row: 22, col: 9 } } },
    ]);
  });
  it('finds words', () => {
    const g = new Grid();
    g.apply(full(16, 1, ['ls foo/bar.txt x']));
    expect(wordAt(g, 0, 0, 16, 5)).toEqual([3, 14]);
    expect(wordAt(g, 0, 0, 16, 2)).toEqual([2, 3]);
  });
});

describe('keyEvent', () => {
  const k = (init: Partial<KeyboardEvent>) =>
    ({
      key: '',
      code: '',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      keyCode: 0,
      ...init,
    }) as KeyboardEvent;
  it('maps keys to herdr key events', () => {
    expect(keyEvent(k({ key: 'ArrowUp', repeat: true }))).toEqual({ t: 'key', key: { code: 'Up', mods: 0, kind: 1, tracksRelease: true } });
    expect(keyEvent(k({ key: 'F12' }))).toEqual({ t: 'key', key: { code: 'F', f: 12, mods: 0, kind: 0, tracksRelease: true } });
    // Ctrl on a Cyrillic layout means the physical Latin key.
    expect(keyEvent(k({ key: 'с', code: 'KeyC', ctrlKey: true }))).toMatchObject({ key: { code: 'Char', char: 'c', mods: 2 } });
    // AltGr types text on Windows and Linux layouts.
    expect(keyEvent(k({ key: '€', code: 'KeyE', ctrlKey: true, altKey: true }), { mac: false })).toMatchObject({
      key: { char: '€', mods: 0, text: '€' },
    });
    // macOS Option types characters unless it acts as Meta.
    expect(keyEvent(k({ key: 'å', code: 'KeyA', altKey: true }), { mac: true })).toMatchObject({ key: { char: 'å', mods: 0, text: 'å' } });
    expect(keyEvent(k({ key: 'b', code: 'KeyB', altKey: true }), { mac: true, optionIsMeta: true })).toMatchObject({
      key: { char: 'b', mods: 4 },
    });
    expect(keyEvent(k({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeUndefined();
    expect(keyEvent(k({ key: 'Dead', code: 'Quote' }))).toBeUndefined();
  });
  it('releases without text', () => {
    expect(releaseOf({ code: 'Char', char: 'a', mods: 2, kind: 0, tracksRelease: true })).toMatchObject({ kind: 2, text: undefined });
  });
  it('strips paste markers and every escape', () => {
    expect(pasteText('a\x1b[200~b\nc')).toBe('a[200~b\rc');
    for (const evil of ['\x1b[201~id\n', '\x1b[20\x1b[201~1~\nid', '\u009b201~id']) expect(pasteText(evil)).not.toMatch(/[\x1b\u009b]/);
    expect(pasteText('x\ty é')).toBe('x\ty é');
  });
});

describe('safeUrl', () => {
  it('opens only web links from pane output', () => {
    expect(safeUrl('https://x.dev/a')).toBe(true);
    expect(safeUrl('mailto:a@b.c')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x', 'ssh://h', 'not a url']) expect(safeUrl(bad)).toBe(false);
  });
});

describe('findLinks', () => {
  it('finds URLs before paths and never overlaps', () => {
    const l = findLinks('see https://x.dev/a/b and ./src/main.go:12 now');
    expect(l.map((x) => [x.kind, x.text])).toEqual([
      ['url', 'https://x.dev/a/b'],
      ['path', './src/main.go:12'],
    ]);
  });
});
