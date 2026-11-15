// The AI usage plugin's state in the page: the core's snapshot (GET
// /api/p/usage, then its /ws messages), the cost report, the panel's view
// options (kept per browser) and the alerts the snapshots bring.
import { create } from 'zustand';
import { loadPref, savePref, useStore } from '../../state/store';
import { getPrefs } from '../../prefs';
import { settingValue } from '../../settings';
import { storage } from '../../brand';
import { alerts, alertText, parseThresholds, type CostReport, type UsageSnapshot } from './model';

export type UsageTab = 'limits' | 'cost';

interface UsageState {
  snapshot?: UsageSnapshot;
  cost?: CostReport;
  costLoading: boolean;
  costError?: string;
  /** Show what is left instead of what is used. */
  remaining: boolean;
  compact: boolean;
  tab: UsageTab;
  costDays: 7 | 30 | 90;
}

const VIEW = 'usage.view';

interface View {
  remaining?: boolean;
  compact?: boolean;
  tab?: UsageTab;
  costDays?: 7 | 30 | 90;
}

const view = loadPref<View>(VIEW, {});

export const useUsage = create<UsageState>(() => ({
  costLoading: false,
  remaining: !!view.remaining,
  compact: !!view.compact,
  tab: view.tab === 'cost' ? 'cost' : 'limits',
  costDays: view.costDays === 7 || view.costDays === 90 ? view.costDays : 30,
}));

/** Changes the panel's view options and keeps them. */
export function setView(v: View) {
  useUsage.setState(v);
  const s = useUsage.getState();
  savePref(VIEW, { remaining: s.remaining, compact: s.compact, tab: s.tab, costDays: s.costDays });
}

const FIRED = 'usage.alerts';

function loadFired(): Record<string, number> {
  try {
    return JSON.parse(storage.get(FIRED) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

/** Takes a snapshot of the core and tells the user what crossed a
 * threshold, started over or runs out before its reset. */
export function applySnapshot(s: UsageSnapshot) {
  if (!s || !Array.isArray(s.accounts)) return;
  const prev = useUsage.getState().snapshot;
  useUsage.setState({ snapshot: s });
  // The first snapshot of a page only arms the thresholds already passed:
  // what was said in another page or before a reload is in storage.
  const fired = loadFired();
  const list = alerts(prev, s, parseThresholds(settingValue('usage.thresholds')), fired);
  storage.set(FIRED, JSON.stringify(fired));
  for (const a of list) notify(alertText(a), a.id);
}

function notify(text: string, tag: string) {
  const visible = typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
  const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  if (!visible && granted && getPrefs().notifySystem) {
    const n = new Notification(text, { tag: `usage|${tag}` });
    n.onclick = () => {
      window.focus();
      useStore.getState().setPanel('usage');
      n.close();
    };
    return;
  }
  useStore.getState().toast(text);
}

/** Fetches the snapshot; watch tells the core the panel is open. */
export async function fetchSnapshot(watch = false): Promise<void> {
  try {
    const r = await fetch(`/api/p/usage${watch ? '?watch=1' : ''}`);
    if (r.ok) applySnapshot((await r.json()) as UsageSnapshot);
  } catch {
    /* the core is unreachable: the next message brings it */
  }
}

/** Asks the core to poll now; an error code when it refuses. */
export async function refreshNow(): Promise<string | undefined> {
  try {
    const r = await fetch('/api/p/usage/refresh', { method: 'POST' });
    if (r.ok) return undefined;
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    return j.error ?? `http_${r.status}`;
  } catch {
    return 'network';
  }
}

/** Fetches the cost of the last 90 days (the user's days). */
export async function fetchCost(): Promise<void> {
  useUsage.setState({ costLoading: true, costError: undefined });
  try {
    const tz = -new Date().getTimezoneOffset();
    const r = await fetch(`/api/p/usage/cost?days=90&tz=${tz}`);
    if (!r.ok) throw new Error(`http_${r.status}`);
    useUsage.setState({ cost: (await r.json()) as CostReport, costLoading: false });
  } catch (e) {
    useUsage.setState({ costLoading: false, costError: e instanceof Error ? e.message : 'failed' });
  }
}

/** Writes the DeepSeek key file on machine m ("" removes it); an error
 * code when it fails. */
export async function setDeepseekKey(m: string, key: string): Promise<string | undefined> {
  try {
    const r = await fetch(`/api/m/${encodeURIComponent(m)}/p/usage/deepseek-key`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (r.ok) return undefined;
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    return j.error ?? `http_${r.status}`;
  } catch {
    return 'network';
  }
}
