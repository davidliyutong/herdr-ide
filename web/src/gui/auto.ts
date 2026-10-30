// A new program window opens in its own browser window when its pane is on
// screen; otherwise it stays marked on its pane until opened. Browsers block
// pop-ups without a click unless the site is allowed to open them; then a
// toast offers to open it.

import { activeTabId, useStore } from '../state/store';
import { t } from '../i18n';
import { guiKey, openGuiWindow, useGui } from './state';

/** Whether a pane is shown: in the selected workspace's active tab. */
export function paneShown(m: string, pane?: string): boolean {
  if (!pane) return false;
  const s = useStore.getState();
  const snap = s.machines[m]?.snapshot;
  const p = snap?.panes.find((x) => x.pane_id === pane);
  if (!snap || !p || s.machineId !== m || s.workspaceId !== p.workspace_id) return false;
  return activeTabId(s, m, snap, p.workspace_id) === p.tab_id;
}

export function initGuiAuto() {
  const tried = new Set<string>();
  useGui.subscribe((g) => {
    for (const st of Object.values(g.machines)) {
      for (const w of st.windows) {
        const k = guiKey(st.m, w.id);
        if (!g.unseen[k] || tried.has(k)) continue;
        tried.add(k);
        // Dialogs are opened by the browser window of their parent.
        if (w.transient && st.windows.some((x) => x.id === w.transient)) continue;
        if (document.visibilityState !== 'visible' || !paneShown(st.m, w.pane)) continue;
        if (!openGuiWindow(st.m, w)) {
          useStore.getState().toast(t('gui.blocked', { title: w.title || t('gui.untitled') }), {
            label: t('gui.open'),
            run: () => openGuiWindow(st.m, w),
          });
        }
      }
    }
  });
}
