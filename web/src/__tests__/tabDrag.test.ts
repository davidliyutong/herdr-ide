import { describe, expect, it } from 'vitest';
import { edgeBox, nearestEdge, otherTab } from '../tabDrag';

describe('dragging a tab onto a pane', () => {
  it('takes the edge nearest to the pointer, also in the middle', () => {
    expect(nearestEdge(0.1, 0.5)).toBe('left');
    expect(nearestEdge(0.9, 0.5)).toBe('right');
    expect(nearestEdge(0.5, 0.05)).toBe('top');
    expect(nearestEdge(0.5, 0.95)).toBe('bottom');
    expect(nearestEdge(0.45, 0.5)).toBe('left');
    expect(nearestEdge(0.55, 0.52)).toBe('right');
  });

  it('marks the half of the pane the tab would fill', () => {
    const r = { left: 100, top: 50, width: 400, height: 200 };
    expect(edgeBox(r, 'left')).toEqual({ left: 100, top: 50, width: 200, height: 200 });
    expect(edgeBox(r, 'right')).toEqual({ left: 300, top: 50, width: 200, height: 200 });
    expect(edgeBox(r, 'top')).toEqual({ left: 100, top: 50, width: 400, height: 100 });
    expect(edgeBox(r, 'bottom')).toEqual({ left: 100, top: 150, width: 400, height: 100 });
  });

  // While a tab is dragged, the tab shown before the press comes back; when
  // that was the dragged one, its neighbor is shown.
  it('shows another tab to drop beside', () => {
    expect(otherTab(1, 0, 3)).toBe(0);
    expect(otherTab(0, 0, 3)).toBe(1);
    expect(otherTab(2, 2, 3)).toBe(1);
    expect(otherTab(0, 0, 1)).toBeUndefined();
    expect(otherTab(1, 5, 2)).toBe(0);
  });
});
