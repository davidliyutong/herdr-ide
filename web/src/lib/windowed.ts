// Windowed lists: only the rows in view (and a few around them) are drawn,
// so a list of thousands of rows scrolls without drawing them all. The
// rows are absolutely placed in a box of the list's full height; the file
// explorer's tree and the pickers lay theirs out with these.

import { useCallback, useEffect, useRef, useState } from 'react';

/** Rows drawn beyond each edge of the view. */
export const OVERSCAN = 8;

/** The tops of rows of these heights; the last entry is the total height. */
export function rowOffsets(heights: readonly number[]): number[] {
  const out = new Array<number>(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i] + heights[i];
  return out;
}

/** The rows [first, last) a view from top, height high, shows of rows
 * placed at offsets (rowOffsets), with overscan rows on each side. */
export function visibleRows(offsets: readonly number[], top: number, height: number, overscan = OVERSCAN): [number, number] {
  const n = offsets.length - 1;
  if (n <= 0) return [0, 0];
  // The last row starting at or above top.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= top) lo = mid;
    else hi = mid - 1;
  }
  let last = lo;
  while (last < n && offsets[last] < top + height) last++;
  return [Math.max(0, lo - overscan), Math.min(n, last + overscan)];
}

/** visibleRows for count rows of one height. */
export function visibleRange(count: number, rowHeight: number, top: number, height: number, overscan = OVERSCAN): [number, number] {
  if (count <= 0 || rowHeight <= 0) return [0, 0];
  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((top + height) / rowHeight) + overscan);
  return [first, last];
}

/** The scroll position that shows the row from top to bottom in a view of
 * an element scrolled to scrollTop, clientHeight high: scrollTop itself
 * when it shows already. */
export function revealTop(scrollTop: number, clientHeight: number, top: number, bottom: number): number {
  if (top < scrollTop) return top;
  if (bottom > scrollTop + clientHeight) return bottom - clientHeight;
  return scrollTop;
}

/** An element's scroll position and height, followed (scrolls, resizes);
 * height is initialHeight (0, or what a caller draws for until then) until
 * it is measured (and in tests without layout). Give the element ref (a
 * callback: the element may come later than the component, or again as
 * another one, which starts at its own scroll position) and onScroll. */
export function useScrollView(initialHeight = 0) {
  const [view, setView] = useState({ top: 0, height: initialHeight });
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = undefined;
    if (!el) return;
    setView((v) => (v.top === el.scrollTop ? v : { ...v, top: el.scrollTop }));
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(() => setView((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight })));
    observer.current.observe(el);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  const onScroll = useCallback(
    (e: React.UIEvent<HTMLElement>) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight }),
    [],
  );
  return { ...view, ref, onScroll };
}
