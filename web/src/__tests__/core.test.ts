import { describe, expect, it, vi } from 'vitest';
import { linksAround, mediaExt, resolvePath, selectedLink, type RowText } from '../terminal/links';
import { pasteText } from '../surface/input';
import { routeKey } from '../surface/keys';
import { paneRects } from '../actions';
import type { LayoutNode } from '../lib/herdr';

describe('resolvePath', () => {
  const ctx = { m: 'x', cwd: '/home/u/proj', home: '/home/u' };
  it('resolves relative paths against the pane cwd', () => {
    expect(resolvePath('out/plot.png', ctx)).toEqual({ path: '/home/u/proj/out/plot.png', line: undefined, col: undefined });
    expect(resolvePath('./a.mp4', ctx).path).toBe('/home/u/proj/a.mp4');
    expect(resolvePath('../b.gif', ctx).path).toBe('/home/u/b.gif');
  });
  it('expands ~ and parses :line:col', () => {
    expect(resolvePath('~/x/y.ts:12:4', ctx)).toEqual({ path: '/home/u/x/y.ts', line: 12, col: 4 });
    expect(resolvePath('/abs/z.go:7', ctx)).toEqual({ path: '/abs/z.go', line: 7, col: undefined });
  });
  it('recognizes media extensions', () => {
    expect(mediaExt.test('/a/b.MP4')).toBe(true);
    expect(mediaExt.test('/a/b.gif')).toBe(true);
    expect(mediaExt.test('/a/b.ts')).toBe(false);
  });
});

describe('linksAround', () => {
  // Rows of a pane 20 columns wide starting at column 5, as Grid.rowText
  // returns them (one column per character here).
  const W = 20;
  const rows = (...lines: string[]) => {
    const out = lines.map((l): RowText => {
      const text = l.padEnd(W);
      return { text, colOf: [...Array(W + 1).keys()].map((i) => 5 + i) };
    });
    return (y: number) => out[y];
  };
  const found = (y: number, r: (y: number) => RowText, top = 0, bottom = 3) =>
    linksAround(y, top, bottom, r).map((l) => ({ text: l.text, cells: l.cells.map((c) => [c.y, c.from, c.to]) }));

  it('joins a path that reaches the last column with the next row', () => {
    const r = rows('see /tmp/abc/defghij', 'kl/out.png and more', 'next');
    const want = [
      {
        text: '/tmp/abc/defghijkl/out.png',
        cells: [
          [0, 9, 25],
          [1, 5, 15],
        ],
      },
    ];
    expect(found(0, r)).toEqual(want);
    expect(found(1, r)).toEqual(want);
    expect(found(2, r)).toEqual([]);
  });
  it('skips the indentation of the continued row', () => {
    const r = rows('  ⎿ /tmp/abc/defghij', '    kl/out.png', '');
    expect(found(1, r)).toEqual([
      {
        text: '/tmp/abc/defghijkl/out.png',
        cells: [
          [0, 9, 25],
          [1, 9, 19],
        ],
      },
    ]);
  });
  it('keeps rows apart when the text stops before the last column', () => {
    const r = rows('see /tmp/abc/def', 'ghi.png', '');
    expect(found(0, r).map((l) => l.text)).toEqual(['/tmp/abc/def']);
    expect(found(1, r).map((l) => l.text)).toEqual(['ghi.png']);
  });
  it('stays inside the pane', () => {
    const r = rows('see /tmp/abc/defghij', 'kl/out.png', '');
    expect(found(1, r, 1).map((l) => l.text)).toEqual(['kl/out.png']);
    expect(found(0, r, 0, 1).map((l) => l.text)).toEqual(['/tmp/abc/defghij']);
  });
});

describe('selectedLink', () => {
  it('joins the rows of a wrapped path', () => {
    expect(selectedLink('/tmp/claude/932adc89\n-d9ae/shots/3_pose.png')).toEqual({
      kind: 'path',
      text: '/tmp/claude/932adc89-d9ae/shots/3_pose.png',
    });
    expect(selectedLink('https://example.com/a\n  b')).toEqual({ kind: 'url', text: 'https://example.com/ab' });
  });
  it('ignores quotes and punctuation around it', () => {
    expect(selectedLink(' "~/x/y.ts:12", ')).toEqual({ kind: 'path', text: '~/x/y.ts:12' });
  });
  it('is nothing when the selection holds other text', () => {
    expect(selectedLink('see /tmp/x')).toBeUndefined();
    expect(selectedLink('hello')).toBeUndefined();
  });
});

describe('pasteText', () => {
  it('converts newlines and strips escapes', () => {
    expect(pasteText('a\nb\r\nc')).toBe('a\rb\rc');
    expect(pasteText('x\x1b[201~rm -rf')).toBe('x[201~rm -rf');
  });
});

describe('paneRects', () => {
  it('lays out herdr split trees', () => {
    const root: LayoutNode = {
      type: 'split',
      direction: 'right',
      ratio: 0.5,
      first: { type: 'pane', pane_id: 'p1' },
      second: {
        type: 'split',
        direction: 'down',
        ratio: 0.25,
        first: { type: 'pane', pane_id: 'p2' },
        second: { type: 'pane', pane_id: 'p3' },
      },
    };
    const r = paneRects(root);
    expect(r.get('p1')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(r.get('p2')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.25 });
    expect(r.get('p3')).toEqual({ x: 0.5, y: 0.25, w: 0.5, h: 0.75 });
  });
});

describe('routeKey', () => {
  const key = (init: Partial<KeyboardEvent>) =>
    ({
      type: 'keydown',
      key: 'Enter',
      code: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      keyCode: 13,
      preventDefault: vi.fn(),
      ...init,
    }) as unknown as KeyboardEvent;
  const none = () => false;
  it('cancels every event it handles, and leaves browser shortcuts alone', () => {
    const send = vi.fn();
    const shiftEnter = key({ shiftKey: true });
    expect(routeKey(shiftEnter, none, send)).toBe('pane');
    expect(send).toHaveBeenCalledWith({ t: 'key', key: { code: 'Enter', mods: 1, kind: 0, tracksRelease: true } });
    expect(shiftEnter.preventDefault).toHaveBeenCalled();
    const prefix = key({ key: 'b', code: 'KeyB', ctrlKey: true });
    expect(routeKey(prefix, () => true, send)).toBe('app');
    expect(prefix.preventDefault).toHaveBeenCalled();
    const copy = key({ key: 'c', code: 'KeyC', metaKey: true });
    expect(routeKey(copy, none, send)).toBe('browser');
    expect(copy.preventDefault).not.toHaveBeenCalled();
    const composing = key({ isComposing: true, keyCode: 229 });
    expect(routeKey(composing, none, send)).toBe('browser');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
