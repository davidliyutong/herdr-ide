// Agent attention: desktop notifications, title and app badge.

import type { AgentStatusEvent } from './lib/herdr';
import { useStore } from './state/store';
import { actions } from './actions';
import { t } from './i18n';
import { APP_NAME } from './brand';

let asked = false;

export function requestNotifyPermission() {
  if (asked || typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  asked = true;
  Notification.requestPermission().catch(() => {});
}

export function notifyAgent(m: string, ev: AgentStatusEvent) {
  if (ev.agent_status !== 'blocked' && ev.agent_status !== 'done') return;
  const s = useStore.getState();
  const label = s.machines[m]?.label ?? m;
  const who = ev.display_agent || ev.agent || 'agent';
  const title = t(ev.agent_status === 'blocked' ? 'notify.blocked' : 'notify.done', { who });
  const visible = document.visibilityState === 'visible' && document.hasFocus();
  if (!visible && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const n = new Notification(title, { body: `${label}${ev.title ? ' · ' + ev.title : ''}`, tag: `${m}|${ev.pane_id}` });
    n.onclick = () => {
      window.focus();
      actions.focusAgent(m, ev.pane_id);
      n.close();
    };
  } else if (visible && ev.agent_status === 'blocked') {
    s.toast(`${title} · ${label}`);
  }
}

export function updateBadge() {
  const s = useStore.getState();
  let blocked = 0;
  for (const id of s.order) for (const p of s.machines[id]?.snapshot?.panes ?? []) if (p.agent && p.agent_status === 'blocked') blocked++;
  document.title = blocked ? `(${blocked}) ${APP_NAME}` : APP_NAME;
  const nav = navigator as Navigator & { setAppBadge?(n: number): Promise<void>; clearAppBadge?(): Promise<void> };
  if (blocked) nav.setAppBadge?.(blocked).catch(() => {});
  else nav.clearAppBadge?.().catch(() => {});
}
