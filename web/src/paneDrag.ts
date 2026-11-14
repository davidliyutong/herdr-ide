// Dragging a pane by its header onto another pane swaps the two (centre) or
// places the dragged pane beside the target (edges); dropping it on a tab
// moves it into that tab, on the new-tab button into a new tab. These are
// edits of the machine's layout document (term/layout.ts).

import { trackDrag, type Box, type DragStart } from './drag';
import { terms } from './state/terms';
import * as L from './term/layout';
import { t } from './i18n';

export type DropTarget =
  | { kind: 'pane'; terminal: string; zone: Zone; rect: DOMRect }
  | { kind: 'tab'; ws: string; index: number; rect: DOMRect }
  | { kind: 'newTab'; ws: string; rect: DOMRect };

export interface DragSource {
  m: string;
  terminal: string;
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
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const pane = el?.closest<HTMLElement>('.pane[data-terminal]');
  if (pane && pane.dataset.m === src.m && pane.dataset.terminal !== src.terminal) {
    const rect = pane.getBoundingClientRect();
    return { kind: 'pane', terminal: pane.dataset.terminal!, zone: dropZone(rect, x, y), rect };
  }
  const tab = el?.closest<HTMLElement>('.tab[data-tab]');
  if (tab && tab.dataset.m === src.m) {
    const index = Number(tab.dataset.tab);
    const tabs = terms.layout(src.m)?.workspaces.find((w) => w.id === tab.dataset.ws)?.tabs;
    if (tabs?.[index] && !L.tabTerminals(tabs[index]).includes(src.terminal))
      return { kind: 'tab', ws: tab.dataset.ws!, index, rect: tab.getBoundingClientRect() };
  }
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

/** The layout after dropping the source on a target. */
export function dropped(l: L.Layout, src: DragSource, tg: DropTarget): L.Layout {
  if (tg.kind === 'pane') return L.dropOnPane(l, src.terminal, tg.terminal, tg.zone);
  if (tg.kind === 'tab') {
    // Beside the tab's focused terminal.
    const target = l.workspaces.find((w) => w.id === tg.ws)?.tabs[tg.index]?.focused;
    return target ? L.moveTerminal(l, src.terminal, target, 'horizontal') : l;
  }
  return L.moveToNewTab(l, src.terminal, tg.ws);
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
