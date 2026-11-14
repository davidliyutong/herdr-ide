// Agent attention: desktop notifications, sounds, title and app badge.

import type { AgentStatusEvent } from './lib/machine';
import { useTerms } from './state/terms';
import { agentStatus } from './lib/machine';
import { useStore } from './state/store';
import { actions } from './actions';
import { t } from './i18n';
import { APP_NAME } from './brand';
import { getPrefs } from './prefs';
import { terminalOnScreen } from './seen';
import { mutedAgents, playSound, soundFor } from './sound';

let asked = false;

export function requestNotifyPermission() {
  if (asked || typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  asked = true;
  Notification.requestPermission().catch(() => {});
}

/** sound: the core chose this page to play sounds (see soundClient). */
export function notifyAgent(m: string, ev: AgentStatusEvent, sound: boolean) {
  if (ev.agent_status !== 'blocked' && ev.agent_status !== 'done') return;
  const s = useStore.getState();
  const label = s.machines[m]?.label ?? m;
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
  if (!visible && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const n = new Notification(title, { body: `${label}${ev.title ? ' · ' + ev.title : ''}`, tag: `${m}|${ev.terminal}` });
    n.onclick = () => {
      window.focus();
      actions.focusTerminal(m, ev.terminal);
      n.close();
    };
  } else if (visible && ev.agent_status === 'blocked') {
    s.toast(`${title} · ${label}`);
  }
}

export function updateBadge() {
  const s = useStore.getState();
  let blocked = 0;
  const tm = useTerms.getState().machines;
  for (const id of s.order) for (const r of Object.values(tm[id]?.terminals ?? {})) if (agentStatus(r) === 'blocked') blocked++;
  document.title = blocked ? `(${blocked}) ${APP_NAME}` : APP_NAME;
  const nav = navigator as Navigator & { setAppBadge?(n: number): Promise<void>; clearAppBadge?(): Promise<void> };
  if (blocked) nav.setAppBadge?.(blocked).catch(() => {});
  else nav.clearAppBadge?.().catch(() => {});
}
