// Panels of the right sidebar as panes: a panel (the file explorer, Source
// Control, AI usage, the vault) can also be a pane of the layout
// (`{view: {plugin, kind: 'panel', panel}}`), where it splits, moves, takes
// a tab and closes as any pane does, while its rail button still shows it
// in the sidebar. It becomes one by a drag of its rail button or of its
// title onto the panes (a pane's edge: split there; a tab: beside its
// focused pane; the rest of the tab bar or another workspace: a tab of
// its own), or by Open in Pane in its header (split beside the focused pane);
// Move to Sidebar in the pane's header closes the pane and shows the panel
// in the sidebar.

import { trackDrag, type Box, type DragStart } from './drag';
import { dropTargetAt, markerRect, dropped, type DropTarget } from './paneDrag';
import { insertSlot, near } from './reorderDrag';
import { actions, current } from './actions';
import { moveRailId, orderRailItems, useStore } from './state/store';
import { terms } from './state/terms';
import * as L from './term/layout';
import { activePanels, findPanel, panelPlugin, PANEL_VIEW } from './plugins/registry';
import type { PanelDef } from './plugins/api';
import { t } from './i18n';

/** Whether a pane shows a panel, and which. */
export function panelOfView(view: L.PluginView): PanelDef | undefined {
  return view.kind === PANEL_VIEW ? findPanel(view.plugin, view.panel) : undefined;
}

/** The pane showing panel id in the shown machine's selected tab, if any. */
function panelPaneHere(id: string): string | undefined {
  const tab = current()?.tab;
  if (!tab) return undefined;
  const leaf = L.leavesOf(tab.root).find((l) => L.isPluginLeaf(l) && l.view.kind === PANEL_VIEW && l.view.panel === id);
  return leaf && L.paneKey(leaf);
}

/** The sidebar no longer shows panel id (it went to a pane). */
function leaveSidebar(id: string) {
  const s = useStore.getState();
  if (s.panel === id) s.setPanel(undefined);
}

/** Shows a panel where the user has it: its pane in the tab shown, else the
 * sidebar. */
export function showPanel(id: string) {
  const c = current();
  const pane = panelPaneHere(id);
  if (c && pane) actions.focusPane(c.m, pane);
  else useStore.getState().setPanel(id);
}

/** Open in Pane: the panel in a pane split beside the focused pane of the
 * machine shown (its pane in that tab, if it has one, is focused). */
export async function openPanelInPane(panel: PanelDef) {
  const m = useStore.getState().machineId;
  const plugin = panelPlugin(panel);
  if (!m || !plugin) return;
  leaveSidebar(panel.id);
  await actions.openView(m, { plugin: plugin.id, kind: PANEL_VIEW, panel: panel.id }, { reuse: (v) => v.panel === panel.id });
}

/** Move to Sidebar: closes a panel's pane and shows the panel in the sidebar. */
export async function moveToSidebar(m: string, pane: string, view: L.PluginView) {
  const panel = panelOfView(view);
  await actions.closePane(m, pane);
  if (panel) useStore.getState().setPanel(panel.id);
}

/** A panel has no pane to swap with: a pane's middle splits it, the
 * panel on the right. */
const sided = (tg: DropTarget): DropTarget => (tg.kind === 'pane' && tg.zone === 'center' ? { ...tg, zone: 'right' } : tg);

/** The layout after dropping a panel on a target: its pane in the tab
 * shown moves there, else a new pane opens there, focused. */
export function droppedPanel(l: L.Layout, leaf: L.PluginLeaf, tg: DropTarget, existing?: string): L.Layout {
  const target = sided(tg);
  if (existing) return dropped(l, { m: '', pane: existing, ws: '', label: '' }, target);
  const key = L.paneKey(leaf)!;
  let next = l;
  if (target.kind === 'pane') {
    const axis: L.Axis = target.zone === 'left' || target.zone === 'right' ? 'horizontal' : 'vertical';
    next = L.splitPane(l, target.pane, axis, leaf, target.zone === 'left' || target.zone === 'top');
  } else if (target.kind === 'tab') {
    const focused = l.workspaces.find((w) => w.id === target.ws)?.tabs[target.index]?.focused;
    next = focused ? L.splitPane(l, focused, 'horizontal', leaf) : l;
  } else next = L.openPane(l, leaf, target.ws);
  return L.focusPane(next, key);
}

type PanelDragHit = { kind: 'rail'; index: number; box: Box; visibleIds: string[] } | { kind: 'workspace'; target: DropTarget };

/** Starts tracking a possible drag of a panel (its rail button or title)
 * onto the panes of the machine shown, or along the right rail to reorder it. */
export function startPanelDrag(ev: DragStart, panel: PanelDef, o: { fromRail?: boolean } = {}) {
  const s = useStore.getState();
  const m = s.machineId;
  const plugin = panelPlugin(panel);
  const canOpenPane = !!m && !!plugin && !s.readOnly;
  if (!o.fromRail && !canOpenPane) return;
  const existing = canOpenPane ? panelPaneHere(panel.id) : undefined;
  trackDrag<PanelDragHit>(ev, {
    label: t(panel.title),
    find: (x, y) => {
      if (o.fromRail) {
        const rail = near(document.querySelector('.panel-rail'), '.rail-button[data-panel]', 'data-panel', x, y, 'y');
        if (rail) {
          const slot = insertSlot(rail.boxes, rail.ids.indexOf(panel.id), x, y, 'y');
          return slot ? { kind: 'rail', index: slot.index, box: slot.box, visibleIds: rail.ids } : undefined;
        }
      }
      if (!canOpenPane || !m) return undefined;
      const tg = dropTargetAt(m, x, y, { pane: existing });
      return tg ? { kind: 'workspace', target: tg } : undefined;
    },
    marker: (hit) => {
      if (hit.kind === 'rail') return { box: hit.box, zone: 'slot' };
      const sd = sided(hit.target);
      return { box: markerRect(sd), zone: sd.kind === 'pane' ? sd.zone : sd.kind };
    },
    drop: async (hit) => {
      if (hit.kind === 'rail') {
        const cur = useStore.getState();
        const fullIds = orderRailItems(activePanels(), cur.railOrder).map((p) => p.id);
        cur.setRailOrder(moveRailId(fullIds, hit.visibleIds, panel.id, hit.index));
        return;
      }
      if (!m || !plugin) return;
      const leaf: L.PluginLeaf = { view: { id: L.newId(), plugin: plugin.id, kind: PANEL_VIEW, panel: panel.id } };
      terms.mutate(m, (l) => droppedPanel(l, leaf, hit.target, existing));
      leaveSidebar(panel.id);
    },
    failed: (error) => t('pane.moveFailed', { error }),
  });
}
