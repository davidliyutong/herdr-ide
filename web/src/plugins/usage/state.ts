// The AI usage plugin's state in the page: the hub's snapshot (GET
// /api/p/usage, then its /ws messages), the cost report, the panel's view
// options (kept per browser), the alerts the snapshots carry, each shown
// once per browser, and the numbers of the coding agents' sessions the
// status bar showed (session.ts).
import { create } from 'zustand';
import { loadPref, savePref } from '../../state/store';
import { dispatchNotification } from '../../notify';
import { settingValue } from '../../settings';
import { storage } from '../../brand';
import { failureCode, jsonBody } from '../../lib/pluginApi';
import { alertText, type CostReport, type SessionUsage, type UsageAlert, type UsageSnapshot } from './model';

/** The panel shows the overview or one service (its id). */
export type UsageTab = string;

export type Metric = 'spend' | 'tokens';

/** Why the hub has no numbers of a session: no transcript yet
 * (not_found), its provider turned off (provider_off), an agent whose
 * sessions are not priced (bad_request). */
export type SessionCode = 'not_found' | 'provider_off' | 'bad_request';

/** What the page knows of a coding agent's session. */
export interface SessionEntry {
  /** The last numbers the hub gave; none while code is set. */
  usage?: SessionUsage;
  code?: SessionCode;
  /** The agent's status when code came. */
  status?: string;
  /** When the entry was written (ms). */
  at: number;
}

interface UsageState {
  snapshot?: UsageSnapshot;
  cost?: CostReport;
  costLoading: boolean;
  costError?: string;
  /** Show what is left instead of what is used. */
  remaining: boolean;
  /** The spend section shows money or tokens. */
  metric: Metric;
  tab: UsageTab;
  costDays: 7 | 30 | 90;
  /** Sessions by sessionKey (machine, agent kind, session id). */
  sessions: Record<string, SessionEntry>;
}

const VIEW = 'usage.view';

interface View {
  remaining?: boolean;
  metric?: Metric;
  tab?: UsageTab;
  costDays?: 7 | 30 | 90;
}

const view = loadPref<View>(VIEW, {});

export const useUsage = create<UsageState>(() => ({
  costLoading: false,
  remaining: !!view.remaining,
  metric: view.metric === 'tokens' ? 'tokens' : 'spend',
  tab: typeof view.tab === 'string' ? view.tab : 'overview',
  costDays: view.costDays === 7 || view.costDays === 90 ? view.costDays : 30,
  sessions: {},
}));

/** Changes the panel's view options and keeps them. */
export function setView(v: View) {
  useUsage.setState(v);
  const s = useUsage.getState();
  savePref(VIEW, { remaining: s.remaining, metric: s.metric, tab: s.tab, costDays: s.costDays });
}

/** Collapsed/expanded account cards in provider detail views, persisted per
 * browser via the brand-namespaced storage wrapper. */
export const COLLAPSED_ACCOUNTS_KEY = 'usage.collapsedAccounts';

/** Stable key per provider + account for persisted collapse state. */
export function accountCollapseKey(provider: string, accountKey: string): string {
  return accountKey.startsWith(`${provider}:`) ? accountKey : `${provider}:${accountKey}`;
}

/** Reads the persisted collapsed state map from localStorage. */
export function loadCollapsedAccounts(): Record<string, boolean> {
  try {
    const raw = storage.get(COLLAPSED_ACCOUNTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persists the collapsed state map to localStorage via brand storage. */
export function saveCollapsedAccounts(map: Record<string, boolean>): void {
  storage.set(COLLAPSED_ACCOUNTS_KEY, JSON.stringify(map));
}

/** The alerts shown in this browser, by id, with when they fired. */
const SHOWN = 'usage.alerts';

/** How long the hub keeps an alert in its snapshot. */
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

/** Takes a snapshot of the hub and shows the alerts it carries that this
 * browser has not shown. */
export function applySnapshot(s: UsageSnapshot, etag?: string) {
  if (!s || !Array.isArray(s.accounts)) return;
  const prev = useUsage.getState().snapshot;
  // An answer that started before a newer message arrived.
  if (prev && s.updatedAt < prev.updatedAt) return;
  snapshotEtag = etag;
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
  void dispatchNotification({
    title: text,
    tag: `usage|${tag}`,
    target: { kind: 'panel', panel: 'usage' },
    urgency: 'normal',
    visibleToast: text,
    visibleToastKind: 'warning',
    toastFallback: true,
  });
}

let snapshotEtag: string | undefined;
let costEtag: string | undefined;
let costEtagTZ: number | undefined;

/** Fetches the snapshot; watch tells the hub the panel is open. Sends
 * If-None-Match when a snapshot is already loaded so unchanged watch
 * heartbeats return 304 Not Modified. */
export async function fetchSnapshot(watch = false): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (snapshotEtag && useUsage.getState().snapshot) headers['If-None-Match'] = snapshotEtag;
    const r = await fetch(`/api/p/usage${watch ? '?watch=1' : ''}`, Object.keys(headers).length ? { headers } : undefined);
    if (r.status === 304) return;
    if (r.ok) {
      applySnapshot((await r.json()) as UsageSnapshot, r.headers?.get('ETag') ?? undefined);
    }
  } catch {
    /* the hub is unreachable: the next message brings it */
  }
}

/** Asks the hub to poll now; an error code when it refuses. */
export async function refreshNow(): Promise<string | undefined> {
  try {
    const r = await fetch('/api/p/usage/refresh', { method: 'POST' });
    if (r.ok) return undefined;
    return failureCode(r, await jsonBody(r));
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

/** Fetches the cost of the last 90 days (the user's days). Sends
 * If-None-Match so unchanged reports return 304 Not Modified without
 * re-transferring 90 days of rows. */
export async function fetchCost(): Promise<void> {
  useUsage.setState({ costLoading: true, costError: undefined });
  try {
    const tz = -new Date().getTimezoneOffset();
    const cur = useUsage.getState().cost;
    const headers: Record<string, string> = {};
    if (costEtag && costEtagTZ === tz && cur) headers['If-None-Match'] = costEtag;
    const r = await fetch(`/api/p/usage/cost?days=90&tz=${tz}`, Object.keys(headers).length ? { headers } : undefined);
    if (r.status === 304 && cur) {
      useUsage.setState({ cost: { ...cur, generatedAt: Math.floor(Date.now() / 1000) }, costLoading: false });
      return;
    }
    if (!r.ok) throw new Error(`http_${r.status}`);
    costEtag = r.headers?.get('ETag') ?? undefined;
    costEtagTZ = tz;
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
    return failureCode(r, await jsonBody(r));
  } catch {
    return 'network';
  }
}
