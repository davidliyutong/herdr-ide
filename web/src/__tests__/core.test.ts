import { describe, expect, it, vi } from 'vitest';
import { resolvePath, mediaExt } from '../terminal/links';
import { bracketedPaste } from '../terminal/paste';
import { routeKey } from '../terminal/keys';
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

describe('bracketedPaste', () => {
  it('wraps, converts newlines and strips embedded markers', () => {
    expect(bracketedPaste('a\nb\r\nc')).toBe('\x1b[200~a\rb\rc\x1b[201~');
    expect(bracketedPaste('x\x1b[201~rm -rf')).toBe('\x1b[200~xrm -rf\x1b[201~');
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
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      keyCode: 13,
      preventDefault: vi.fn(),
      ...init,
    }) as unknown as KeyboardEvent;
  const none = () => false;
  it('cancels every event it keeps from xterm.js, except browser shortcuts', () => {
    const send = vi.fn();
    const shiftEnter = key({ shiftKey: true });
    expect(routeKey(shiftEnter, none, send)).toBe(false);
    expect(send).toHaveBeenCalledWith('\x1b\r');
    expect(shiftEnter.preventDefault).toHaveBeenCalled();
    const prefix = key({ key: 'b', ctrlKey: true });
    expect(routeKey(prefix, () => true, send)).toBe(false);
    expect(prefix.preventDefault).toHaveBeenCalled();
    const copy = key({ key: 'c', metaKey: true });
    expect(routeKey(copy, none, send)).toBe(false);
    expect(copy.preventDefault).not.toHaveBeenCalled();
  });
  it('leaves other keys, keypress events and IME composition to xterm.js', () => {
    for (const ev of [
      key({}),
      key({ shiftKey: true, type: 'keypress' }),
      key({ shiftKey: true, isComposing: true }),
      key({ shiftKey: true, keyCode: 229 }),
    ]) {
      expect(routeKey(ev, none, () => {})).toBe(true);
      expect(ev.preventDefault).not.toHaveBeenCalled();
    }
  });
});
