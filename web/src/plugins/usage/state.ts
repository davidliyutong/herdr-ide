// The AI usage plugin's state in the page: the core's snapshot (GET
// /api/p/usage, then its /ws messages), the cost report, the panel's view
// options (kept per browser) and the alerts the snapshots carry, each shown
// once per browser.
import { create } from 'zustand';
import { loadPref, savePref, useStore } from '../../state/store';
import { getPrefs } from '../../prefs';
import { settingValue } from '../../settings';
import { storage } from '../../brand';
import { alertText, type CostReport, type UsageAlert, type UsageSnapshot } from './model';

/** The panel shows the overview or one service (its id). */
export type UsageTab = string;

interface UsageState {
  snapshot?: UsageSnapshot;
  cost?: CostReport;
  costLoading: boolean;
  costError?: string;
  /** Show what is left instead of what is used. */
  remaining: boolean;
  tab: UsageTab;
  costDays: 7 | 30 | 90;
}

const VIEW = 'usage.view';

interface View {
  remaining?: boolean;
  tab?: UsageTab;
  costDays?: 7 | 30 | 90;
}

const view = loadPref<View>(VIEW, {});

export const useUsage = create<UsageState>(() => ({
  costLoading: false,
  remaining: !!view.remaining,
  tab: typeof view.tab === 'string' && view.tab !== 'limits' && view.tab !== 'cost' ? view.tab : 'overview',
  costDays: view.costDays === 7 || view.costDays === 90 ? view.costDays : 30,
}));

/** Changes the panel's view options and keeps them. */
export function setView(v: View) {
  useUsage.setState(v);
  const s = useUsage.getState();
  savePref(VIEW, { remaining: s.remaining, tab: s.tab, costDays: s.costDays });
}

/** The alerts shown in this browser, by id, with when they fired. */
const SHOWN = 'usage.alerts';

/** How long the core keeps an alert in its snapshot. */
const ALERT_KEEP = 3600;

/** A page in the background waits this long before it takes an alert, so
 * that a page in front shows it. */
const BACKGROUND_DELAY = 1500;

function loadShown(): Record<string, number> {
  try {
    const v = JSON.parse(storage.get(SHOWN) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Takes a snapshot of the core and shows the alerts it carries that this
 * browser has not shown. */
export function applySnapshot(s: UsageSnapshot) {
  if (!s || !Array.isArray(s.accounts)) return;
  const prev = useUsage.getState().snapshot;
  // An answer that started before a newer message arrived.
  if (prev && s.updatedAt < prev.updatedAt) return;
  useUsage.setState({ snapshot: s });
  if (Array.isArray(s.alerts) && s.alerts.length) showAlerts(s.alerts);
}

/** Shows each alert once per browser: what was shown is kept in storage,
 * which the browser's pages share; they take it in turn (a lock), the page
 * in front first. */
function showAlerts(list: UsageAlert[]) {
  const take = () => {
    const shown = loadShown();
    const now = Date.now() / 1000;
    for (const [id, at] of Object.entries(shown)) if (typeof at !== 'number' || at < now - ALERT_KEEP) delete shown[id];
    const fresh = list.filter((a) => shown[a.id] === undefined && a.at >= now - ALERT_KEEP);
    for (const a of fresh) shown[a.id] = a.at;
    storage.set(SHOWN, JSON.stringify(shown));
    for (const a of fresh) notify(alertText(a), a.id);
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) {
    take();
    return;
  }
  const front = typeof document !== 'undefined' && document.visibilityState === 'visible';
  // take does not throw (storage is guarded): a rejection is the lock's.
  setTimeout(() => void locks.request('usage-alerts', take).catch(take), front ? 0 : BACKGROUND_DELAY);
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
  useStore.getState().toast(text, undefined, undefined, 'warning');
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

/** How long a cost report is shown before the open panel reads it again
 * (usage.costRefresh, minutes), in seconds. */
function costFresh(): number {
  const m = Number(settingValue('usage.costRefresh'));
  return (Number.isFinite(m) && m >= 1 ? m : 15) * 60;
}

/** Whether the cost report is missing or older than usage.costRefresh. */
export function costStale(now = Date.now() / 1000): boolean {
  const s = useUsage.getState();
  return !s.costLoading && (!s.cost || now - s.cost.generatedAt > costFresh());
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
