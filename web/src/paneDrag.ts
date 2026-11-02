// Dragging a pane by its header onto another pane swaps the two (centre) or
// moves the dragged pane next to the target (edges); dropping it on a tab
// moves it into that tab, on the new-tab button into a new tab. herdr does
// the rearranging (pane.swap / pane.move); the layout comes back as events.
//
// herdr 0.9.5 refuses pane.move within a tab ("same_tab"), so a move next to
// a pane of the same tab goes through a new tab, which herdr closes again
// when the pane leaves it.

import { conn } from './lib/conn';
import { trackDrag, type Box, type DragStart } from './drag';
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
export function dropZone(r: Box, x: number, y: number): Zone {
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
function markerRect(tg: DropTarget): Box {
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

/** Starts tracking a possible drag from a pane header. */
export function startPaneDrag(ev: DragStart, src: DragSource) {
  trackDrag(ev, {
    label: src.label,
    find: (x, y) => findTarget(src, x, y),
    marker: (tg) => ({ box: markerRect(tg), zone: tg.kind === 'pane' ? tg.zone : tg.kind }),
    drop: (tg) => drop(src, tg),
    failed: (error) => t('pane.moveFailed', { error }),
  });
}
