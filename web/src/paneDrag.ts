// Dragging a pane by its header onto another pane swaps the two (centre) or
// places the dragged pane beside the target (edges); dropping it on a tab
// moves it into that tab, anywhere else on the tab bar (the new-tab button,
// the empty part after it) into a new tab, on another
// workspace of its machine in the sidebar into a new tab there. These are
// edits of the machine's layout document (term/layout.ts).

import { trackDrag, type Box, type DragStart } from './drag';
import { terms } from './state/terms';
import * as L from './term/layout';
import { t } from './i18n';

export type DropTarget =
  | { kind: 'pane'; pane: string; zone: Zone; rect: DOMRect }
  | { kind: 'tab'; ws: string; index: number; rect: DOMRect }
  | { kind: 'newTab'; ws: string; rect: DOMRect }
  | { kind: 'workspace'; ws: string; rect: DOMRect };

export interface DragSource {
  m: string;
  /** The pane's key (term/layout.ts paneKey). */
  pane: string;
  ws: string;
  label: string;
}

export type Zone = L.DropZone;

/** Drop zone for a point inside a pane: the middle swaps, the rest moves the
 * pane to the nearest edge. */
export function dropZone(r: Box, x: number, y: number): Zone {
  return L.dropZone((x - r.left) / r.width, (y - r.top) / r.height);
}

function findTarget(src: DragSource, x: number, y: number): DropTarget | undefined {
  return dropTargetAt(src.m, x, y, src);
}

/** Where a pane (or a panel, which becomes one) dropped at x, y on machine
 * m's panes would go: a pane other than skip.pane, a tab not holding it,
 * the new-tab button, or a workspace other than skip.ws in the sidebar. */
export function dropTargetAt(m: string, x: number, y: number, skip: { pane?: string; ws?: string } = {}): DropTarget | undefined {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const pane = el?.closest<HTMLElement>('.pane[data-pane]');
  if (pane && pane.dataset.m === m && pane.dataset.pane !== skip.pane) {
    const rect = pane.getBoundingClientRect();
    return { kind: 'pane', pane: pane.dataset.pane!, zone: dropZone(rect, x, y), rect };
  }
  const tab = el?.closest<HTMLElement>('.tab[data-tab]');
  if (tab) {
    const index = Number(tab.dataset.tab);
    const tabs = tab.dataset.m === m ? terms.layout(m)?.workspaces.find((w) => w.id === tab.dataset.ws)?.tabs : undefined;
    if (tabs?.[index] && !(skip.pane && L.tabPanes(tabs[index]).includes(skip.pane)))
      return { kind: 'tab', ws: tab.dataset.ws!, index, rect: tab.getBoundingClientRect() };
    return undefined;
  }
  // Anywhere else on the tab bar (its empty part, the gaps between tabs,
  // the new-tab button) it gets a tab of its own, which comes where the
  // new-tab button is: the marker shows the button.
  const add = el?.closest('.tabbar')?.querySelector<HTMLElement>('[data-new-tab]');
  if (add && add.dataset.m === m) return { kind: 'newTab', ws: add.dataset.newTab!, rect: add.getBoundingClientRect() };
  // Another workspace of the machine, in the sidebar.
  const row = el?.closest<HTMLElement>('.ws-item[data-ws-id]');
  if (row && row.dataset.m === m && row.dataset.wsId !== skip.ws)
    return { kind: 'workspace', ws: row.dataset.wsId!, rect: row.getBoundingClientRect() };
}

/** The part of the target a drop would fill, for the highlight. */
export function markerRect(tg: DropTarget): Box {
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

/** The layout after dropping the source on a target. */
export function dropped(l: L.Layout, src: DragSource, tg: DropTarget): L.Layout {
  if (tg.kind === 'pane') return L.dropOnPane(l, src.pane, tg.pane, tg.zone);
  if (tg.kind === 'tab') {
    // Beside the tab's focused pane.
    const target = l.workspaces.find((w) => w.id === tg.ws)?.tabs[tg.index]?.focused;
    return target ? L.movePane(l, src.pane, target, 'horizontal') : l;
  }
  // The new-tab button, or another workspace in the sidebar.
  return L.moveToNewTab(l, src.pane, tg.ws);
}

/** Starts tracking a possible drag from a pane header. */
export function startPaneDrag(ev: DragStart, src: DragSource) {
  trackDrag(ev, {
    label: src.label,
    find: (x, y) => findTarget(src, x, y),
    marker: (tg) => ({ box: markerRect(tg), zone: tg.kind === 'pane' ? tg.zone : tg.kind }),
    drop: async (tg) => {
      terms.mutate(src.m, (l) => dropped(l, src, tg));
    },
    failed: (error) => t('pane.moveFailed', { error }),
  });
}
