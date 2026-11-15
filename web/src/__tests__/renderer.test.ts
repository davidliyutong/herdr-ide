// @vitest-environment jsdom
// The renderer's helpers: the background rows that go up to the GPU in one
// upload, and the canvas a pane draws on with Canvas 2D after its WebGL
// context was lost.
import { describe, expect, it } from 'vitest';
import { replaceCanvas, rowRuns } from '../vt/renderer';

describe('renderer', () => {
  it('uploads rows side by side together', () => {
    expect(rowRuns([])).toEqual([]);
    expect(rowRuns([3])).toEqual([[3, 1]]);
    expect(rowRuns([5, 0, 1, 2, 7, 6, 9])).toEqual([
      [0, 3],
      [5, 3],
      [9, 1],
    ]);
  });

  it('draws on a new canvas in the old one’s place, which keeps its look', () => {
    const host = document.createElement('div');
    const old = Object.assign(document.createElement('canvas'), { className: 'term-canvas' });
    old.style.width = '100px';
    host.append(old);
    const fresh = replaceCanvas(old);
    expect(fresh).not.toBe(old);
    expect(host.firstElementChild).toBe(fresh);
    expect(old.isConnected).toBe(false);
    expect(fresh.className).toBe('term-canvas');
    expect(fresh.style.width).toBe('100px');
  });
});
