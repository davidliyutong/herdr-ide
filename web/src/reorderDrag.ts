// Dragging a tab within the tab bar, or a workspace within its machine's list
// in the sidebar, reorders it (tab.move / workspace.move). herdr's
// insert_index is a slot in the current order: 0 before the first item, n
// after the last; the slots on either side of the dragged item change
// nothing, so they show no marker.

import { actions } from './actions';
import { trackDrag, type Box } from './drag';

export interface Slot {
  index: number;
  /** The insertion bar between two items. */
  box: Box;
}

/** The slot nearest to a pointer position among item boxes laid out along a
 * row (x) or column (y), or undefined when dropping there leaves the item at
 * `from` in place. Items may wrap onto more lines, as tabs do: the line is
 * the one under the pointer (else the nearest), the slot is the nearest
 * within that line, and its index counts the whole list. */
export function insertSlot(boxes: Box[], from: number, x: number, y: number, axis: 'x' | 'y'): Slot | undefined {
  if (!boxes.length) return undefined;
  const [along, across] = axis === 'x' ? [x, y] : [y, x];
  const start = (b: Box) => (axis === 'x' ? b.left : b.top);
  const end = (b: Box) => (axis === 'x' ? b.left + b.width : b.top + b.height);
  // A line ends where the next item starts before the previous one.
  const lines: Array<[number, number]> = [];
  for (let i = 1, first = 0; i <= boxes.length; i++) {
    if (i < boxes.length && start(boxes[i]) >= start(boxes[i - 1])) continue;
    lines.push([first, i]);
    first = i;
  }
  const distance = ([a, b]: [number, number]) => {
    const line = boxes.slice(a, b);
    const lo = Math.min(...line.map((l) => (axis === 'x' ? l.top : l.left)));
    const hi = Math.max(...line.map((l) => (axis === 'x' ? l.top + l.height : l.left + l.width)));
    return Math.max(lo - across, across - hi, 0);
  };
  const [a, b] = lines.reduce((best, l) => (distance(l) < distance(best) ? l : best));
  const k = boxes.slice(a, b).findIndex((l) => along < (start(l) + end(l)) / 2);
  const index = k < 0 ? b : a + k;
  if (index === from || index === from + 1) return undefined;
  const edge = index === a ? start(boxes[a]) : index === b ? end(boxes[b - 1]) : (end(boxes[index - 1]) + start(boxes[index])) / 2;
  const ref = boxes[Math.min(index, b - 1)];
  const box =
    axis === 'x'
      ? { left: edge - 1, top: ref.top, width: 2, height: ref.height }
      : { left: ref.left, top: edge - 1, width: ref.width, height: 2 };
  return { index, box };
}

/** Items of a list and their boxes, when the point is near the list. */
export function near(list: Element | null, items: string, idAttr: string, x: number, y: number, axis: 'x' | 'y') {
  if (!list) return undefined;
  const r = list.getBoundingClientRect();
  const slack = 16;
  const outside = (p: number, lo: number, hi: number) => p < lo - slack || p > hi + slack;
  // Across the list the point must be on it. Along a tab bar any position
  // counts (before the first tab, after the last); a machine's workspace
  // list is followed by the next machine's, so there it must be near too.
  if (axis === 'x' ? outside(y, r.top, r.bottom) : outside(x, r.left, r.right) || outside(y, r.top, r.bottom)) return undefined;
  const els = [...list.querySelectorAll<HTMLElement>(items)];
  return { ids: els.map((e) => e.getAttribute(idAttr)!), boxes: els.map((e) => e.getBoundingClientRect()) };
}

function startReorder(
  ev: { clientX: number; clientY: number; pointerId: number },
  // move() reports its own failures.
  o: {
    label: string;
    id: string;
    axis: 'x' | 'y';
    list: () => Element | null;
    items: string;
    idAttr: string;
    move(index: number): Promise<void>;
  },
) {
  trackDrag(ev, {
    label: o.label,
    find: (x, y) => {
      const l = near(o.list(), o.items, o.idAttr, x, y, o.axis);
      return l && insertSlot(l.boxes, l.ids.indexOf(o.id), x, y, o.axis);
    },
    marker: (slot) => ({ box: slot.box, zone: 'slot' }),
    drop: (slot) => o.move(slot.index),
  });
}

/** Starts tracking a possible drag of a tab within its tab bar. */
export function startTabDrag(
  ev: { clientX: number; clientY: number; pointerId: number },
  src: { m: string; ws: string; tab: string; label: string },
) {
  startReorder(ev, {
    label: src.label,
    id: src.tab,
    axis: 'x',
    list: () => document.querySelector(`.tabs[data-m="${CSS.escape(src.m)}"][data-ws="${CSS.escape(src.ws)}"]`),
    items: '.tab[data-tab-id]',
    idAttr: 'data-tab-id',
    move: (index) => actions.moveTab(src.m, src.tab, index),
  });
}

/** Starts tracking a possible drag of a workspace within its machine's list. */
export function startWorkspaceDrag(
  ev: { clientX: number; clientY: number; pointerId: number },
  src: { m: string; ws: string; label: string },
) {
  startReorder(ev, {
    label: src.label,
    id: src.ws,
    axis: 'y',
    list: () => document.querySelector(`.machine-body[data-m="${CSS.escape(src.m)}"]`),
    items: '.ws-item[data-ws-id]',
    idAttr: 'data-ws-id',
    move: (index) => actions.moveWorkspace(src.m, src.ws, index),
  });
}
