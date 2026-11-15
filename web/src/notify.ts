// Agent attention: sounds, the system's notifications, and the count of
// blocked agents on the app's icon (the Badging API) and in the title; each
// has its setting (notifications.sound, .system, .badge). The silent agents
// play no sound; their notifications and count follow the other settings.

import type { AgentStatusEvent } from './lib/machine';
import { useTerms } from './state/terms';
import { agentStatus } from './lib/machine';
import { useStore } from './state/store';
import { actions, terminalPlace } from './actions';
import { t } from './i18n';
import { APP_NAME } from './brand';
import { getPrefs, usePrefs } from './prefs';
import { terminalOnScreen } from './seen';
import { mutedAgents, playSound, soundFor } from './sound';

let asked = false;

/** Asks for the permission to show notifications, once, when they are on
 * (called from the page's first click: browsers ask only after one). */
export function requestNotifyPermission() {
  if (asked || !getPrefs().notifySystem || typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  asked = true;
  Notification.requestPermission().catch(() => {});
}

/** Whether a status change shows a notification of the system: blocked or
 * done, while the page is in the background, with the setting on and the
 * browser's permission. */
export function showsNotification(
  ev: Pick<AgentStatusEvent, 'agent_status'>,
  c: { enabled: boolean; granted: boolean; visible: boolean },
): boolean {
  return c.enabled && c.granted && !c.visible && (ev.agent_status === 'blocked' || ev.agent_status === 'done');
}

/** sound: the core chose this page to play sounds (see soundClient). */
export function notifyAgent(m: string, ev: AgentStatusEvent, sound: boolean) {
  if (ev.agent_status !== 'blocked' && ev.agent_status !== 'done') return;
  const s = useStore.getState();
  // Where the agent is: its machine, workspace and tab.
  const label = [s.machines[m]?.label ?? m, terminalPlace(m, ev.terminal)].filter(Boolean).join(' · ');
  const who = ev.display_agent || ev.agent || 'agent';
  const title = t(ev.agent_status === 'blocked' ? 'notify.blocked' : 'notify.done', { who });
  const visible = document.visibilityState === 'visible' && document.hasFocus();
  const prefs = getPrefs();
  const kind = soundFor(ev, {
    chosen: sound,
    enabled: prefs.notifySound,
    muted: mutedAgents(prefs.notifySoundMuted),
    onScreen: terminalOnScreen(m, ev.terminal),
    focused: visible,
  });
  if (kind) playSound(kind);
  const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  if (showsNotification(ev, { enabled: prefs.notifySystem, granted, visible })) {
    const n = new Notification(title, { body: ev.title ? `${label}\n${ev.title}` : label, tag: `${m}|${ev.terminal}` });
    n.onclick = () => {
      window.focus();
      actions.focusPane(m, ev.terminal);
      n.close();
    };
  } else if (visible && ev.agent_status === 'blocked') {
    s.toast(`${title} · ${label}`);
  }
}

/** The count shown on the app's icon and in the title: the blocked agents,
 * none when the setting is off. */
export function badgeCount(blocked: number, enabled: boolean): number {
  return enabled ? blocked : 0;
}

type BadgeNavigator = Navigator & { setAppBadge?(n: number): Promise<void>; clearAppBadge?(): Promise<void> };

let shown = -1;

export function updateBadge() {
  const s = useStore.getState();
  let blocked = 0;
  const tm = useTerms.getState().machines;
  for (const id of s.order) for (const r of Object.values(tm[id]?.terminals ?? {})) if (agentStatus(r) === 'blocked') blocked++;
  const n = badgeCount(blocked, getPrefs().notifyBadge);
  document.title = n ? `(${n}) ${APP_NAME}` : APP_NAME;
  if (n === shown) return;
  shown = n;
  const nav = navigator as BadgeNavigator;
  if (n) nav.setAppBadge?.(n).catch(() => {});
  else nav.clearAppBadge?.().catch(() => {});
}

// Turning the badge off clears it at once, turning it on shows the count.
usePrefs.subscribe((st, prev) => {
  if (st.prefs.notifyBadge !== prev.prefs.notifyBadge) updateBadge();
});
