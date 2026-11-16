// Pointer dragging shared by panes, tabs and workspaces: a drag begins after
// the pointer moved a few pixels on the screen (so a click stays a click),
// shows a ghost with a label and a marker where the drop would land, and
// Escape cancels. The distance is measured on the screen, not in the page:
// in macOS full screen the menu bar slides down when the pointer nears the
// top and moves the page under a pointer that stands still. Held near the
// top or bottom edge of the sidebar's list, the pointer scrolls it, so a
// workspace or machine out of view can be reached.

import { useStore } from './state/store';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DragOps<T> {
  /** Text of the ghost that follows the pointer. */
  label: string;
  /** What a drop at this point would do; undefined when nothing. */
  find(x: number, y: number): T | undefined;
  /** Where the marker goes and its data-zone (styling) for a target. */
  marker(target: T): { box: Box; zone: string };
  drop(target: T): Promise<unknown>;
  /** Toast text for a failed drop (default: the error). */
  failed?(error: string): string;
  /** Called once the pointer moved far enough for a drag to begin. */
  begin?(): void;
  /** Called once a drag that began ends, with whether it drops, before
   * the drop. */
  end?(dropped: boolean): void;
}

/** The pointer position a drag starts from. */
export interface DragStart {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  pointerId: number;
}

/** Pixels the pointer must move on the screen before a drag begins. */
export const DRAG_THRESHOLD = 6;

/** Whether the pointer moved far enough from where it was pressed. */
export function dragBegins(start: { screenX: number; screenY: number }, now: { screenX: number; screenY: number }): boolean {
  return Math.hypot(now.screenX - start.screenX, now.screenY - start.screenY) >= DRAG_THRESHOLD;
}

/** Lists a drag scrolls when the pointer is held near their edges. */
const SCROLLERS = '.sidebar-scroll';
/** How near the top or bottom edge (pixels) the pointer scrolls a list. */
export const EDGE = 32;
/** The most a list scrolls per step (every 16 ms). */
export const EDGE_STEP = 18;

/** How far a list in rect scrolls per step for a pointer at x, y: up
 * (negative) near its top, down near its bottom, faster nearer the edge
 * (and just beyond it); 0 elsewhere or beside the list. */
export function edgeScroll(rect: { left: number; right: number; top: number; bottom: number }, x: number, y: number): number {
  if (x < rect.left || x > rect.right || y < rect.top - EDGE || y > rect.bottom + EDGE) return 0;
  const step = (d: number) => Math.ceil(Math.min(1, (EDGE - d) / EDGE) * EDGE_STEP);
  if (y < rect.top + EDGE) return -step(Math.max(0, y - rect.top));
  if (y > rect.bottom - EDGE) return step(Math.max(0, rect.bottom - y));
  return 0;
}

export function trackDrag<T>(ev: DragStart, ops: DragOps<T>) {
  let ghost: HTMLDivElement | undefined;
  let marker: HTMLDivElement | undefined;
  let target: T | undefined;
  let at = { x: ev.clientX, y: ev.clientY };
  let scroller: ReturnType<typeof setInterval> | undefined;

  /** Where a drop at the pointer would land, shown by the marker. */
  const update = () => {
    target = ops.find(at.x, at.y);
    marker!.hidden = !target;
    if (target) {
      const { box, zone } = ops.marker(target);
      Object.assign(marker!.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
      marker!.dataset.zone = zone;
    }
  };
  /** Scrolls the list the pointer is held at the edge of, step by step,
   * the marker following what comes into view. */
  const autoScroll = () => {
    const list = [...document.querySelectorAll<HTMLElement>(SCROLLERS)].find((el) => edgeScroll(el.getBoundingClientRect(), at.x, at.y));
    if (!list) {
      clearInterval(scroller);
      scroller = undefined;
      return;
    }
    if (scroller) return;
    scroller = setInterval(() => {
      const by = ghost ? edgeScroll(list.getBoundingClientRect(), at.x, at.y) : 0;
      if (!by) {
        clearInterval(scroller);
        scroller = undefined;
        return;
      }
      list.scrollTop += by;
      update();
    }, 16);
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== ev.pointerId) return;
    if (!ghost) {
      if (!dragBegins(ev, e)) return;
      document.body.classList.add('dragging');
      ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = ops.label;
      marker = document.createElement('div');
      marker.className = 'drop-marker';
      document.body.append(marker, ghost);
      ops.begin?.();
    }
    at = { x: e.clientX, y: e.clientY };
    ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
    update();
    autoScroll();
  };
  const end = (commit: boolean) => {
    clearInterval(scroller);
    scroller = undefined;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    if (!ghost) return;
    ops.end?.(commit && !!target);
    ghost.remove();
    marker?.remove();
    document.body.classList.remove('dragging');
    // The click that follows pointerup must not count as a click on the source.
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    if (commit && target)
      ops.drop(target).catch((e) => {
        const error = String(e?.message ?? e);
        useStore.getState().toast(ops.failed ? ops.failed(error) : error, undefined, undefined, 'error');
      });
  };
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  const onUp = (e: PointerEvent) => e.pointerId === ev.pointerId && end(true);
  const onCancel = () => end(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    end(false);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
}
