// Agent attention & unified notification dispatcher:
// - Routes OS notifications through Electron's native Notification bridge when
//   running in the desktop app, or the browser Web Notification API otherwise.
// - Suppresses duplicate OS/Web notifications via tags and focus checks
//   (never spamming when the window or target pane is already focused).
// - Counts blocked agents (terminals, plugin panes, and unopened chats) on the
//   app's icon (the Badging API) and in the window title.

import type { AgentStatusEvent } from './lib/machine';
import { useTerms } from './state/terms';
import { agentStatus } from './lib/machine';
import { useStore, type ToastKind } from './state/store';
import { actions, terminalPlace } from './actions';
import { t } from './i18n';
import { APP_NAME } from './brand';
import { getPrefs, usePrefs } from './prefs';
import { followViewsSeen, paneFocused, terminalOnScreen } from './seen';
import { mutedAgents, playSound, soundFor } from './sound';
import { onViewStatus, viewOpenTarget, viewPaneOf, viewStatus, viewUnopened } from './plugins/registry';
import { showPanel } from './panelPanes';
import { desktopShell, type NotificationTarget } from './shell';
import * as L from './term/layout';

export type { NotificationTarget };

export interface NotifyOptions {
  /** Notification title. */
  title: string;
  /** Optional body text. */
  body?: string;
  /** Deduplication tag: a new notification with the same tag replaces the previous one. */
  tag?: string;
  /** Target to focus or open when clicked. */
  target?: NotificationTarget;
  /** Native OS urgency hint (Linux/Electron). */
  urgency?: 'normal' | 'critical' | 'low';
  /** Whether the OS notification should be silent (defaults to true when app audio handles sound). */
  silent?: boolean;
  /** Fallback in-app toast message when the window is visible and focused (suppressed if focused on target). */
  visibleToast?: string;
  visibleToastKind?: ToastKind;
  /** Also show visibleToast when an OS/Web notification could not be displayed in the background. */
  toastFallback?: boolean;
  /** Default true: suppresses OS/Web notification while the window is visible and focused. */
  suppressWhenFocused?: boolean;
}

let asked = false;
const activeWeb = new Map<string, Notification>();
const activeDesktopTags = new Set<string>();
const permListeners = new Set<() => void>();

function notifyPermListeners() {
  for (const fn of [...permListeners]) fn();
}

/** Subscribes to notification permission changes initiated by this app. */
export function onPermissionChange(fn: () => void): () => void {
  permListeners.add(fn);
  return () => {
    permListeners.delete(fn);
  };
}

/** Whether notifications run through the Electron desktop native bridge. */
export function isDesktopNotifications(): boolean {
  return !!desktopShell?.notifications;
}

/** Current notification permission state for UI feedback. */
export function notificationPermission(): NotificationPermission | 'desktop' | 'unsupported' {
  if (desktopShell?.notifications) return 'desktop';
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** Asks for browser Notification permission when notifications.system is on
 * (once per session on first pointer gesture, or immediately when force=true
 * from an explicit user action in Settings). Never prompts in Electron desktop. */
export async function requestNotifyPermission(opts?: { force?: boolean }): Promise<NotificationPermission | 'unsupported'> {
  if (desktopShell?.notifications) return 'granted';
  if (typeof Notification === 'undefined') return 'unsupported';
  if (!getPrefs().notifySystem) return Notification.permission;
  if (Notification.permission !== 'default') return Notification.permission;
  if (asked && !opts?.force) return Notification.permission;
  asked = true;
  try {
    const res = await Notification.requestPermission();
    notifyPermListeners();
    return res;
  } catch {
    notifyPermListeners();
    return Notification.permission;
  }
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

/** The pane an agent notification is about: its terminal, else the
 * plugin's pane it points to (ViewStatusDef.paneOf) while that is in the
 * machine's layout; undefined when no pane shows it. */
export function notifiedPane(m: string, ev: AgentStatusEvent): string | undefined {
  if (ev.terminal) return ev.terminal;
  const pane = viewPaneOf(m, ev);
  const layout = useTerms.getState().machines[m]?.layout;
  const leaf = pane && layout ? L.findLeaf(layout, pane) : null;
  return leaf && L.isPluginLeaf(leaf) ? pane : undefined;
}

/** Routes focus to a notification's target (pane, chat without/with an open pane, or sidebar panel). */
export function focusNotificationTarget(target: NotificationTarget) {
  if (typeof window !== 'undefined') window.focus?.();
  switch (target.kind) {
    case 'pane':
      actions.focusPane(target.machine, target.pane);
      break;
    case 'chat': {
      const pane = viewPaneOf(target.machine, { chat: target.chat });
      if (pane) actions.focusPane(target.machine, pane);
      else viewOpenTarget(target);
      break;
    }
    case 'panel':
      showPanel(target.panel);
      break;
  }
}

/** Closes an active OS/Web notification by tag, if tracked. */
export function closeNotification(tag: string) {
  if (!tag) return;
  if (desktopShell?.notifications) {
    activeDesktopTags.delete(tag);
    desktopShell.notifications.close(tag);
  }
  const existing = activeWeb.get(tag);
  if (existing) {
    activeWeb.delete(tag);
    try {
      existing.close();
    } catch {}
  }
}

function isPageVisible(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
}

function isTargetFocused(target: NotificationTarget | undefined): boolean {
  if (!target) return false;
  if (target.kind === 'pane') return paneFocused(target.machine, target.pane);
  if (target.kind === 'chat') {
    const pane = viewPaneOf(target.machine, { chat: target.chat });
    return !!pane && paneFocused(target.machine, pane);
  }
  if (target.kind === 'panel') return useStore.getState().panel === target.panel;
  return false;
}

function showWebNotification(opts: NotifyOptions): boolean {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  if (opts.tag) {
    const prev = activeWeb.get(opts.tag);
    if (prev) {
      activeWeb.delete(opts.tag);
      try {
        prev.close();
      } catch {}
    }
  }
  const init: NotificationOptions = {
    body: opts.body,
    tag: opts.tag,
    ...(opts.silent !== undefined ? { silent: opts.silent } : {}),
  };
  const n = new Notification(opts.title, init);
  if (opts.tag) {
    activeWeb.set(opts.tag, n);
    n.onclose = () => {
      if (activeWeb.get(opts.tag!) === n) activeWeb.delete(opts.tag!);
    };
  }
  n.onclick = () => {
    window.focus();
    if (opts.target) focusNotificationTarget(opts.target);
    if (opts.tag && activeWeb.get(opts.tag) === n) activeWeb.delete(opts.tag);
    n.close();
  };
  return true;
}

function showFallbackToast(opts: NotifyOptions, visible: boolean, targetFocused: boolean, suppress: boolean) {
  if (!opts.visibleToast) return;
  if (visible && suppress && targetFocused) return;
  if (!visible && !opts.toastFallback) return;
  const s = useStore.getState();
  if (opts.visibleToastKind) s.toast(opts.visibleToast, undefined, undefined, opts.visibleToastKind);
  else s.toast(opts.visibleToast);
}

/** Unified notification dispatcher: chooses Electron native notifications in the
 * desktop app and Web Notifications in browsers, suppresses OS notifications when
 * focused (per settings), and falls back cleanly when unavailable or denied. */
export async function dispatchNotification(opts: NotifyOptions): Promise<boolean> {
  const prefs = getPrefs();
  const visible = isPageVisible();
  const targetFocused = visible && isTargetFocused(opts.target);
  const suppress = opts.suppressWhenFocused ?? true;

  if (prefs.notifySystem && !(suppress && visible)) {
    const native = desktopShell?.notifications;
    if (native) {
      const shown = await native
        .show({
          title: opts.title,
          ...(opts.body !== undefined ? { body: opts.body } : {}),
          ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
          ...(opts.silent !== undefined ? { silent: opts.silent } : {}),
          ...(opts.urgency !== undefined ? { urgency: opts.urgency } : {}),
          ...(opts.target !== undefined ? { target: opts.target } : {}),
        })
        .catch(() => false);
      if (shown) {
        if (opts.tag) activeDesktopTags.add(opts.tag);
        return true;
      }
      // Fall back to Web Notification if Electron native failed or is unsupported.
      if (showWebNotification(opts)) return true;
      showFallbackToast(opts, visible, targetFocused, suppress);
      return false;
    }
    if (showWebNotification(opts)) return true;
  }

  showFallbackToast(opts, visible, targetFocused, suppress);
  return false;
}

/** sound: the core chose this page to play sounds (see soundClient). */
export function notifyAgent(m: string, ev: AgentStatusEvent, sound: boolean) {
  if (ev.agent_status !== 'blocked' && ev.agent_status !== 'done') return;
  const s = useStore.getState();
  const pane = notifiedPane(m, ev);
  const chatId = !ev.terminal && typeof ev.chat === 'string' && ev.chat ? ev.chat : undefined;
  // Where the agent is: its machine, workspace and tab.
  const label = [s.machines[m]?.label ?? m, pane && terminalPlace(m, pane)].filter(Boolean).join(' · ');
  const who = ev.display_agent || ev.agent || 'agent';
  const title = t(ev.agent_status === 'blocked' ? 'notify.blocked' : 'notify.done', { who });
  const visible = isPageVisible();
  const prefs = getPrefs();
  const kind = soundFor(ev, {
    chosen: sound,
    enabled: prefs.notifySound,
    muted: mutedAgents(prefs.notifySoundMuted),
    // A plugin's pane is on screen when the user looks at it: it is shown
    // and focused (seen.ts marks it seen then).
    onScreen: ev.terminal ? terminalOnScreen(m, ev.terminal) : !!pane && paneFocused(m, pane),
    focused: visible,
  });
  if (kind) playSound(kind);

  const agent = typeof ev.agent === 'string' && ev.agent ? ev.agent : undefined;
  const target: NotificationTarget | undefined = pane
    ? { kind: 'pane', machine: m, pane }
    : chatId
      ? { kind: 'chat', machine: m, chat: chatId, ...(agent ? { agent } : {}) }
      : undefined;
  const tag = pane ? `${m}|${pane}` : chatId ? `${m}|chat:${chatId}` : undefined;

  void dispatchNotification({
    title,
    body: ev.title ? `${label}\n${ev.title}` : label,
    tag,
    target,
    urgency: ev.agent_status === 'blocked' ? 'critical' : 'normal',
    // App audio handles sound via soundFor/playSound; avoid double or unmuted OS chimes.
    silent: true,
    visibleToast: ev.agent_status === 'blocked' ? `${title} · ${label}` : undefined,
  });
}

/** Wires desktop native notification click routing and clears stale notifications
 * for the pane currently focused by the user. */
export function initNotifications(): () => void {
  const offs: Array<() => void> = [];
  if (desktopShell?.notifications) {
    offs.push(desktopShell.notifications.onClick((target) => focusNotificationTarget(target)));
  }
  const clearFocused = () => {
    if (!isPageVisible()) return;
    const m = useStore.getState().machineId;
    const layout = m ? useTerms.getState().machines[m]?.layout : undefined;
    const pane = layout ? L.focusedPane(layout) : undefined;
    if (!m || !pane || !paneFocused(m, pane)) return;
    const tag = `${m}|${pane}`;
    if (activeWeb.has(tag) || activeDesktopTags.has(tag)) closeNotification(tag);
  };
  offs.push(
    useTerms.subscribe(clearFocused),
    useStore.subscribe((st, prev) => {
      if (st.machineId !== prev.machineId || st.zoomed !== prev.zoomed) clearFocused();
    }),
  );
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', clearFocused);
    document.addEventListener('visibilitychange', clearFocused);
    offs.push(() => {
      window.removeEventListener('focus', clearFocused);
      document.removeEventListener('visibilitychange', clearFocused);
    });
  }
  return () => {
    for (const off of offs) off();
  };
}

/** The count shown on the app's icon and in the title: the blocked agents
 * (terminals', plugins' panes', and unopened chats'), none when the setting is off. */
export function badgeCount(blocked: number, enabled: boolean): number {
  return enabled ? blocked : 0;
}

type BadgeNavigator = Navigator & { setAppBadge?(n: number): Promise<void>; clearAppBadge?(): Promise<void> };

let shown = -1;

export function updateBadge() {
  const s = useStore.getState();
  let blocked = 0;
  const tm = useTerms.getState().machines;
  for (const id of s.order) {
    for (const r of Object.values(tm[id]?.terminals ?? {})) if (agentStatus(r) === 'blocked') blocked++;
    const layout = tm[id]?.layout;
    for (const { view } of layout ? L.layoutViews(layout) : []) if (viewStatus(id, view) === 'blocked') blocked++;
    for (const item of viewUnopened(id)) if (item.status === 'blocked') blocked++;
  }
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

// The plugins' panes change the count as terminals do (App.tsx updates it
// on theirs), and those the user looks at while done are seen (seen.ts).
onViewStatus(() => typeof document !== 'undefined' && updateBadge());
followViewsSeen();

/** Resets internal notification state (tests). */
export function resetNotifyForTests() {
  asked = false;
  shown = -1;
  activeDesktopTags.clear();
  for (const n of activeWeb.values()) {
    try {
      n.close();
    } catch {}
  }
  activeWeb.clear();
  permListeners.clear();
}
