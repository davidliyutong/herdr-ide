import { describe, expect, it } from 'vitest';
import { findLinks, linksAround, mediaExt, resolvePath, selectedLink, type RowText } from '../terminal/links';
import { paneRects } from '../actions';
import type { Node } from '../term/layout';

describe('resolvePath', () => {
  const ctx = { m: 'x', cwd: '/home/u/proj', home: '/home/u' };
  it('resolves relative paths against the pane cwd', () => {
    expect(resolvePath('out/plot.png', ctx)).toEqual({ path: '/home/u/proj/out/plot.png', line: undefined, col: undefined });
    expect(resolvePath('./a.mp4', ctx).path).toBe('/home/u/proj/a.mp4');
    expect(resolvePath('../b.gif', ctx).path).toBe('/home/u/b.gif');
  });
  it('expands ~ and parses :line, :line:col, line ranges, #L ranges, and (line,col)', () => {
    expect(resolvePath('~/x/y.ts:12:4', ctx)).toEqual({ path: '/home/u/x/y.ts', line: 12, col: 4 });
    expect(resolvePath('/abs/z.go:7', ctx)).toEqual({ path: '/abs/z.go', line: 7, col: undefined });
    expect(resolvePath('configs/simple_plane/hardware/local/mvtrack.yaml:17-20', ctx)).toEqual({
      path: '/home/u/proj/configs/simple_plane/hardware/local/mvtrack.yaml',
      line: 17,
      col: undefined,
      endLine: 20,
    });
    expect(resolvePath('path/to/file.ts:10:5-20:12', ctx)).toEqual({
      path: '/home/u/proj/path/to/file.ts',
      line: 10,
      col: 5,
      endLine: 20,
      endCol: 12,
    });
    expect(resolvePath('path/to/file.ts:10:5-18', ctx)).toEqual({
      path: '/home/u/proj/path/to/file.ts',
      line: 10,
      col: 5,
      endLine: 10,
      endCol: 18,
    });
    expect(resolvePath('docs/guide.md#L17-L20', ctx)).toEqual({
      path: '/home/u/proj/docs/guide.md',
      line: 17,
      col: undefined,
      endLine: 20,
    });
    expect(resolvePath('docs/guide.md:L17-L20', ctx)).toEqual({
      path: '/home/u/proj/docs/guide.md',
      line: 17,
      col: undefined,
      endLine: 20,
    });
    expect(resolvePath('src/app.ts(17,5)', ctx)).toEqual({
      path: '/home/u/proj/src/app.ts',
      line: 17,
      col: 5,
    });
    expect(resolvePath('src/app.ts(17, 5)', ctx)).toEqual({
      path: '/home/u/proj/src/app.ts',
      line: 17,
      col: 5,
    });
    expect(resolvePath('src/app.ts(17-20)', ctx)).toEqual({
      path: '/home/u/proj/src/app.ts',
      line: 17,
      col: undefined,
      endLine: 20,
    });
  });
  it('recognizes media extensions', () => {
    expect(mediaExt.test('/a/b.MP4')).toBe(true);
    expect(mediaExt.test('/a/b.gif')).toBe(true);
    expect(mediaExt.test('/a/b.ts')).toBe(false);
  });
});

describe('findLinks with line ranges and Chinese characters/punctuation', () => {
  const texts = (s: string) => findLinks(s).map((l) => [l.kind, l.text]);

  it('recognizes exact user path examples with line ranges and Chinese quotes/punctuation', () => {
    expect(texts('"configs/simple_plane/hardware/local/mvtrack.yaml:17-20"')).toEqual([
      ['path', 'configs/simple_plane/hardware/local/mvtrack.yaml:17-20'],
    ]);
    expect(texts('“configs/simple_plane/hardware/local/mvtrack.yaml。”')).toEqual([
      ['path', 'configs/simple_plane/hardware/local/mvtrack.yaml'],
    ]);
    expect(texts('configs/simple_plane/hardware/local/mvtrack.yaml，查看')).toEqual([
      ['path', 'configs/simple_plane/hardware/local/mvtrack.yaml'],
    ]);
    expect(texts('（path/to/file.ts:10-20）')).toEqual([['path', 'path/to/file.ts:10-20']]);
  });

  it('never swallows Chinese punctuation or adjacent CJK characters into paths or URLs', () => {
    expect(texts('请查看【configs/a.yaml:17-20】、《docs/guide.mdx》、‘src/main.ts:3:4’；路径：/etc/hosts。')).toEqual([
      ['path', 'configs/a.yaml:17-20'],
      ['path', 'docs/guide.mdx'],
      ['path', 'src/main.ts:3:4'],
      ['path', '/etc/hosts'],
    ]);
    expect(texts('修改了configs/simple_plane/hardware/local/mvtrack.yaml:17-20的内容')).toEqual([
      ['path', 'configs/simple_plane/hardware/local/mvtrack.yaml:17-20'],
    ]);
    expect(texts('See configs/simple_plane/hardware/local/mvtrack.yaml. Next sentence.')).toEqual([
      ['path', 'configs/simple_plane/hardware/local/mvtrack.yaml'],
    ]);
    expect(texts('打开README.markdown:L17-L20和app.ts(17,5)查看')).toEqual([
      ['path', 'README.markdown:L17-L20'],
      ['path', 'app.ts(17,5)'],
    ]);
    expect(texts('“https://example.com/docs。” 以及 https://example.com/a，查看 （https://en.wikipedia.org/wiki/Foo_(bar)）')).toEqual([
      ['url', 'https://example.com/docs'],
      ['url', 'https://example.com/a'],
      ['url', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ]);
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
  it('joins a wrapped path with a line range and stops before Chinese punctuation', () => {
    const r = rows('“configs/simple_plan', 'e/mvtrack.yaml:17-20', '。” 查看');
    expect(found(0, r).map((l) => l.text)).toEqual(['configs/simple_plane/mvtrack.yaml:17-20']);
    expect(found(1, r).map((l) => l.text)).toEqual(['configs/simple_plane/mvtrack.yaml:17-20']);
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
  it('ignores ASCII and Chinese quotes/punctuation around selections and preserves line ranges', () => {
    expect(selectedLink(' "~/x/y.ts:12", ')).toEqual({ kind: 'path', text: '~/x/y.ts:12' });
    expect(selectedLink('"configs/simple_plane/hardware/local/mvtrack.yaml:17-20"')).toEqual({
      kind: 'path',
      text: 'configs/simple_plane/hardware/local/mvtrack.yaml:17-20',
    });
    expect(selectedLink('“configs/simple_plane/hardware/local/mvtrack.yaml。”')).toEqual({
      kind: 'path',
      text: 'configs/simple_plane/hardware/local/mvtrack.yaml',
    });
    expect(selectedLink('（path/to/file.ts:10-20）')).toEqual({
      kind: 'path',
      text: 'path/to/file.ts:10-20',
    });
    expect(selectedLink('《docs/guide.md》，')).toEqual({
      kind: 'path',
      text: 'docs/guide.md',
    });
  });
  it('is nothing when the selection holds other text', () => {
    expect(selectedLink('see /tmp/x')).toBeUndefined();
    expect(selectedLink('hello')).toBeUndefined();
  });
});

describe('paneRects', () => {
  it('lays out split trees', () => {
    const root: Node = {
      split: 'horizontal',
      ratio: 0.5,
      children: [{ terminal: 'p1' }, { split: 'vertical', ratio: 0.25, children: [{ terminal: 'p2' }, { terminal: 'p3' }] }],
    };
    const r = paneRects(root);
    expect(r.get('p1')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(r.get('p2')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.25 });
    expect(r.get('p3')).toEqual({ x: 0.5, y: 0.25, w: 0.5, h: 0.75 });
  });
});
