// Whether a terminal is on screen: in the shown machine's selected
// workspace and tab. A turn an agent ended in a terminal on screen is not
// news; the terminal core marks it seen when the terminal has the focus
// (vt/pane.ts sends focus on its stream). A plugin's pane with an agent
// status (a chat; plugins/api.ts ViewStatusDef) is marked seen here: its
// plugin is told when the user looks at it while its status is done.

import { useStore } from './state/store';
import { useTerms } from './state/terms';
import * as L from './term/layout';
import { onViewStatus, viewSeen, viewStatus } from './plugins/registry';

export function terminalOnScreen(m: string, terminal: string): boolean {
  if (useStore.getState().machineId !== m) return false;
  const layout = useTerms.getState().machines[m]?.layout;
  const tab = layout && L.selectedTab(layout);
  return !!tab && L.tabTerminals(tab).includes(terminal);
}

/** Whether a pane is on screen: in the shown machine's selected workspace
 * and tab, and not behind another pane of the tab that is zoomed. */
export function paneOnScreen(m: string, pane: string): boolean {
  const s = useStore.getState();
  if (s.machineId !== m) return false;
  const layout = useTerms.getState().machines[m]?.layout;
  const tab = layout && L.selectedTab(layout);
  const panes = tab ? L.tabPanes(tab) : [];
  if (!panes.includes(pane)) return false;
  const z = s.zoomed;
  return !z || z.m !== m || z.pane === pane || !panes.includes(z.pane);
}

/** Whether a pane is on screen and the focused pane of its tab. */
export function paneFocused(m: string, pane: string): boolean {
  const layout = useTerms.getState().machines[m]?.layout;
  return !!layout && L.focusedPane(layout) === pane && paneOnScreen(m, pane);
}

/** Whether the page is visible and has the focus. */
export function pageFocused(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
}

/** The plugin's pane the user looks at while its status is done: the
 * focused pane of the tab shown, while the page is visible and has the
 * focus. None on a read-only page: seen changes what every client shows. */
function doneLookedAt(): { m: string; view: L.PluginView; key: string } | undefined {
  const s = useStore.getState();
  const m = s.machineId;
  const layout = m ? useTerms.getState().machines[m]?.layout : undefined;
  const pane = layout && L.focusedPane(layout);
  const leaf = layout && pane ? L.findLeaf(layout, pane) : null;
  if (!m || !pane || !leaf || !L.isPluginLeaf(leaf) || s.readOnly || !pageFocused() || !paneOnScreen(m, pane)) return undefined;
  return viewStatus(m, leaf.view) === 'done' ? { m, view: leaf.view, key: `${m}\n${pane}` } : undefined;
}

/** The pane noteViewSeen last found looked at while done (machine and key). */
let looked: string | undefined;

/** Tells the plugin of the pane the user looks at while it is done that it
 * was seen (ViewStatusDef.seen); once each time that starts (the status
 * becomes done, the pane gets the focus, the page comes back). */
export function noteViewSeen() {
  const at = doneLookedAt();
  const was = looked;
  looked = at?.key;
  if (at && at.key !== was) viewSeen(at.m, at.view);
}

/** Follows what noteViewSeen depends on (the plugins' statuses, the
 * machine shown, the layouts, the zoomed pane, the page's visibility and
 * focus) and checks again, once per burst of changes; returns the stop. */
export function followViewsSeen(): () => void {
  let queued = false;
  const check = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      noteViewSeen();
    });
  };
  const offs = [
    onViewStatus(check),
    useStore.subscribe((st, prev) => {
      if (st.machineId !== prev.machineId || st.zoomed !== prev.zoomed || st.readOnly !== prev.readOnly) check();
    }),
    useTerms.subscribe((st, prev) => {
      if (st.machines !== prev.machines) check();
    }),
  ];
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', check);
    window.addEventListener('blur', check);
    document.addEventListener('visibilitychange', check);
    offs.push(() => {
      window.removeEventListener('focus', check);
      window.removeEventListener('blur', check);
      document.removeEventListener('visibilitychange', check);
    });
  }
  check();
  return () => {
    for (const off of offs) off();
    looked = undefined;
  };
}
