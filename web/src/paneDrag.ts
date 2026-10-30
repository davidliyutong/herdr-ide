// Dragging a pane by its header onto another pane swaps the two (centre) or
// moves the dragged pane next to the target (edges); dropping it on a tab
// moves it into that tab, on the new-tab button into a new tab. herdr does
// the rearranging (pane.swap / pane.move); the layout comes back as events.
//
// herdr 0.9.5 refuses pane.move within a tab ("same_tab"), so a move next to
// a pane of the same tab goes through a new tab, which herdr closes again
// when the pane leaves it.

import { conn } from './lib/conn';
import { useStore } from './state/store';
import { t } from './i18n';

export type Zone = 'center' | 'left' | 'right' | 'top' | 'bottom';

export type DropTarget =
  | { kind: 'pane'; pane: string; tab: string; zone: Zone; rect: DOMRect }
  | { kind: 'tab'; tab: string; rect: DOMRect }
  | { kind: 'newTab'; ws: string; rect: DOMRect };

export interface DragSource {
  m: string;
  pane: string;
  tab: string;
  ws: string;
  label: string;
}

/** Drop zone for a point inside a pane: the middle swaps, the rest moves the
 * pane to the nearest edge. */
export function dropZone(r: { left: number; top: number; width: number; height: number }, x: number, y: number): Zone {
  const fx = (x - r.left) / r.width;
  const fy = (y - r.top) / r.height;
  if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return 'center';
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  return (Object.keys(d) as (keyof typeof d)[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}

function findTarget(src: DragSource, x: number, y: number): DropTarget | undefined {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const pane = el?.closest<HTMLElement>('[data-pane-id]');
  if (pane && pane.dataset.m === src.m && pane.dataset.paneId !== src.pane) {
    const rect = pane.getBoundingClientRect();
    return { kind: 'pane', pane: pane.dataset.paneId!, tab: pane.dataset.tabId!, zone: dropZone(rect, x, y), rect };
  }
  const tab = el?.closest<HTMLElement>('.tab[data-tab-id]');
  if (tab && tab.dataset.m === src.m && tab.dataset.tabId !== src.tab)
    return { kind: 'tab', tab: tab.dataset.tabId!, rect: tab.getBoundingClientRect() };
  const add = el?.closest<HTMLElement>('[data-new-tab]');
  if (add && add.dataset.m === src.m) return { kind: 'newTab', ws: add.dataset.newTab!, rect: add.getBoundingClientRect() };
}

/** The part of the target a drop would fill, for the highlight. */
function markerRect(tg: DropTarget): { left: number; top: number; width: number; height: number } {
  const r = tg.rect;
  if (tg.kind !== 'pane') return r;
  switch (tg.zone) {
    case 'left':
      return { left: r.left, top: r.top, width: r.width / 2, height: r.height };
    case 'right':
      return { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height };
    case 'top':
      return { left: r.left, top: r.top, width: r.width, height: r.height / 2 };
    case 'bottom':
      return { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 };
    default:
      return r;
  }
}

/** Tab a pane.move result left the pane in. */
function movedTo(res: any): string | undefined {
  return res?.move_result?.pane?.tab_id;
}

async function drop(src: DragSource, tg: DropTarget) {
  const { m, pane } = src;
  const s = useStore.getState();
  if (tg.kind === 'pane') {
    if (tg.zone === 'center') {
      await conn.api(m, 'pane.swap', { source_pane_id: pane, target_pane_id: tg.pane });
    } else {
      if (tg.tab === src.tab) await conn.api(m, 'pane.move', { pane_id: pane, destination: { type: 'new_tab', workspace_id: src.ws } });
      // herdr splits only to the right or down; left/top is that plus a swap.
      const split = tg.zone === 'left' || tg.zone === 'right' ? 'right' : 'down';
      await conn.api(m, 'pane.move', { pane_id: pane, destination: { type: 'tab', tab_id: tg.tab, split, target_pane_id: tg.pane } });
      if (tg.zone === 'left' || tg.zone === 'top') await conn.api(m, 'pane.swap', { source_pane_id: pane, target_pane_id: tg.pane });
    }
  } else if (tg.kind === 'tab') {
    await conn.api(m, 'pane.move', { pane_id: pane, destination: { type: 'tab', tab_id: tg.tab, split: 'right' } });
    s.selectTab(m, src.ws, tg.tab);
  } else {
    const tab = movedTo(await conn.api(m, 'pane.move', { pane_id: pane, destination: { type: 'new_tab', workspace_id: tg.ws } }));
    if (tab) s.selectTab(m, tg.ws, tab);
  }
  s.focusPane({ m, pane });
}

/** Starts tracking a possible drag from a pane header; a drag begins after
 * the pointer moved a few pixels, so a plain click stays a click. */
export function startPaneDrag(ev: { clientX: number; clientY: number; pointerId: number }, src: DragSource) {
  const x0 = ev.clientX;
  const y0 = ev.clientY;
  let ghost: HTMLDivElement | undefined;
  let marker: HTMLDivElement | undefined;
  let target: DropTarget | undefined;

  const move = (e: PointerEvent) => {
    if (e.pointerId !== ev.pointerId) return;
    if (!ghost) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
      document.body.classList.add('pane-dragging');
      ghost = document.createElement('div');
      ghost.className = 'pane-drag-ghost';
      ghost.textContent = src.label;
      marker = document.createElement('div');
      marker.className = 'pane-drop-marker';
      document.body.append(marker, ghost);
    }
    ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
    target = findTarget(src, e.clientX, e.clientY);
    marker!.hidden = !target;
    if (target) {
      const r = markerRect(target);
      Object.assign(marker!.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      marker!.dataset.zone = target.kind === 'pane' ? target.zone : target.kind;
    }
  };
  const end = (commit: boolean) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    if (!ghost) return;
    ghost.remove();
    marker?.remove();
    document.body.classList.remove('pane-dragging');
    // The click that follows pointerup must not count as a click on the header.
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    if (commit && target)
      drop(src, target).catch((e) => useStore.getState().toast(t('pane.moveFailed', { error: String(e?.message ?? e) })));
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
