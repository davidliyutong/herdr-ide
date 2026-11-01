// herdr shows an agent that finished out of its sight as "done" until its pane
// is focused in herdr. Selection in the web UI is local, so when the pane
// focused here is done (opened by hand, or finishing while looked at) and the
// page is visible, it is focused in herdr too, as opening it from the inbox
// does. Only done panes move herdr's focus.

import { conn } from './lib/conn';
import { activeTabId, findPane, useStore } from './state/store';

/** Whether a pane is on screen: in the selected workspace and tab. */
export function paneOnScreen(s: ReturnType<typeof useStore.getState>, m: string, pane: string): boolean {
  const p = findPane(s, { m, pane });
  const snap = s.machines[m]?.snapshot;
  if (!p || !snap || s.machineId !== m || s.workspaceId !== p.workspace_id) return false;
  return activeTabId(s, m, snap, p.workspace_id) === p.tab_id;
}

/** Whether the pane focused in the UI is on screen. */
function onScreen(s: ReturnType<typeof useStore.getState>): boolean {
  return !!s.focused && paneOnScreen(s, s.focused.m, s.focused.pane);
}

export function initSeen() {
  let sent = '';
  const check = () => {
    const s = useStore.getState();
    const f = s.focused;
    const p = findPane(s, f);
    if (!f || p?.agent_status !== 'done') {
      sent = '';
      return;
    }
    const key = `${f.m}|${f.pane}`;
    if (key === sent || s.readOnly || document.visibilityState !== 'visible' || !onScreen(s)) return;
    sent = key;
    conn.api(f.m, 'pane.focus', { pane_id: f.pane }).catch(() => {
      sent = '';
    });
  };
  useStore.subscribe(check);
  document.addEventListener('visibilitychange', check);
}
