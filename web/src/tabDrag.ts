// Dragging a tab: along the tab bar it reorders the tabs (reorderDrag.ts);
// over a pane of the tab shown it moves the whole tab beside that pane, as
// a split on the side of the pane the pointer is nearest (Edge's split
// screen, for any pane: terminals, VS Code, plugin views). A press shows
// the tab, as in browsers; once the drag begins the tab shown before it
// (or, when it was this one, its neighbor) comes back, so the tab can be
// dropped beside it. Resting on another tab of the bar for a moment shows
// that one instead. A drag that does not merge the tab ends with it shown.

import { actions } from './actions';
import { trackDrag, type Box, type DragStart } from './drag';
import { insertSlot, near, type Slot } from './reorderDrag';
import { terms } from './state/terms';
import * as L from './term/layout';
import { t } from './i18n';

type Edge = Exclude<L.DropZone, 'center'>;

export type TabTarget = ({ kind: 'slot' } & Slot) | { kind: 'pane'; pane: string; zone: Edge; rect: DOMRect };

export interface TabSource {
  m: string;
  ws: string;
  index: number;
  label: string;
  /** The tab shown before the press. */
  shown: number;
}

/** The tab to show while a tab is dragged: the one shown before the press,
 * else the next one, else the one before; none when it is alone. */
export function otherTab(index: number, shown: number, count: number): number | undefined {
  if (shown !== index && shown >= 0 && shown < count) return shown;
  if (index + 1 < count) return index + 1;
  return index > 0 ? index - 1 : undefined;
}

/** How long the pointer rests on another tab before it is shown. */
export const SPRING_MS = 500;

/** The edge of a pane nearest to a point given as shares (0 to 1) of its
 * width and height. */
export function nearestEdge(fx: number, fy: number): Edge {
  const d: Record<Edge, number> = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  return (Object.keys(d) as Edge[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}

/** The half of a pane a tab dropped on an edge would fill. */
export function edgeBox(r: Box, zone: Edge): Box {
  switch (zone) {
    case 'left':
      return { left: r.left, top: r.top, width: r.width / 2, height: r.height };
    case 'right':
      return { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height };
    case 'top':
      return { left: r.left, top: r.top, width: r.width, height: r.height / 2 };
    case 'bottom':
      return { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 };
  }
}

const tabsList = (src: TabSource) => document.querySelector(`.tabs[data-m="${CSS.escape(src.m)}"][data-ws="${CSS.escape(src.ws)}"]`);

/** The pane under a point that the dragged tab can be dropped beside: one
 * of the machine's panes that is not in the dragged tab. */
function paneTarget(src: TabSource, x: number, y: number): TabTarget | undefined {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const pane = el?.closest<HTMLElement>('.pane[data-pane]');
  if (!pane || pane.dataset.m !== src.m) return undefined;
  const tab = terms.layout(src.m)?.workspaces.find((w) => w.id === src.ws)?.tabs[src.index];
  if (!tab || L.tabPanes(tab).includes(pane.dataset.pane!)) return undefined;
  const rect = pane.getBoundingClientRect();
  return { kind: 'pane', pane: pane.dataset.pane!, zone: nearestEdge((x - rect.left) / rect.width, (y - rect.top) / rect.height), rect };
}

/** Starts tracking a possible drag of a tab. */
export function startTabDrag(ev: DragStart, src: TabSource) {
  const ws = () => terms.layout(src.m)?.workspaces.find((w) => w.id === src.ws);
  // The dragged tab, known by its focused pane: its index changes when it moves.
  const key = ws()?.tabs[src.index]?.focused;
  let last: TabTarget | undefined;
  // The tab the pointer rests on, shown after SPRING_MS.
  let spring: { index: number; timer: number } | undefined;
  const rest = (x: number, y: number) => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('.tab[data-tab]');
    const index = el && el.dataset.m === src.m && el.dataset.ws === src.ws ? Number(el.dataset.tab) : undefined;
    const shown = ws()?.selected;
    if (index === spring?.index) return;
    if (spring) window.clearTimeout(spring.timer);
    spring = undefined;
    if (index === undefined || index === shown) return;
    spring = { index, timer: window.setTimeout(() => actions.selectTab(src.m, src.ws, index), SPRING_MS) };
  };
  trackDrag<TabTarget>(ev, {
    label: src.label,
    find: (x, y) => {
      rest(x, y);
      const l = near(tabsList(src), '.tab[data-tab]', 'data-tab', x, y, 'x');
      if (l) {
        const slot = insertSlot(l.boxes, l.ids.indexOf(String(src.index)), x, y, 'x');
        last = slot && { kind: 'slot', ...slot };
      } else last = paneTarget(src, x, y);
      return last;
    },
    marker: (tg) => (tg.kind === 'slot' ? { box: tg.box, zone: 'slot' } : { box: edgeBox(tg.rect, tg.zone), zone: tg.zone }),
    begin: () => {
      const other = otherTab(src.index, src.shown, ws()?.tabs.length ?? 0);
      if (other !== undefined) actions.selectTab(src.m, src.ws, other);
    },
    drop: async (tg) => {
      if (tg.kind === 'slot') return actions.moveTab(src.m, src.ws, src.index, tg.index);
      terms.mutate(src.m, (l) => L.dropTabOnPane(l, src.ws, src.index, tg.pane, tg.zone));
    },
    // Before the drop: a tab that will not be merged is shown again (a
    // reorder keeps it shown where it goes).
    end: (dropped) => {
      if (spring) window.clearTimeout(spring.timer);
      if (key && !(dropped && last?.kind === 'pane')) terms.mutate(src.m, (l) => L.focusPane(l, key));
    },
    failed: (error) => t('pane.moveFailed', { error }),
  });
}
