// The AI usage plugin's data (internal/plugins/usage) and what the panel and
// the status bar compute from it: the tightest window, durations, alerts on
// thresholds and resets, and the cost report's totals and rankings.
import { t } from '../../i18n';

export type WindowKind = 'session' | 'weekly' | 'monthly' | 'model';

export interface UsagePace {
  expectedPct: number;
  exhaustsAt?: number;
  beforeReset?: boolean;
}

export interface UsageWindow {
  /** Tells an account's windows apart: kind|label, with the length where
   * two share them. */
  id?: string;
  kind: WindowKind;
  label?: string;
  usedPct: number;
  resetsAt?: number;
  windowSec?: number;
  pace?: UsagePace;
  history?: [number, number][];
}

export interface UsageCredits {
  balance?: number;
  used?: number;
  limit?: number;
  unlimited?: boolean;
  enabled?: boolean;
  unit?: string;
}

export interface UsageBalance {
  currency: string;
  total: number;
  granted?: number;
  toppedUp?: number;
}

export interface UsageAccount {
  key: string;
  provider: string;
  id?: string;
  email?: string;
  plan?: string;
  windows: UsageWindow[];
  credits?: UsageCredits;
  balances?: UsageBalance[];
  available?: boolean;
  status: 'ok' | 'stale' | 'unauth' | 'error' | 'missing' | 'skipped';
  code?: string;
  source?: string;
  asOf?: number;
  home?: string;
  machines: string[];
  fetchedAt?: number;
  seenAt: number;
}

export interface StatusPage {
  indicator?: string;
  description?: string;
  url: string;
}

export interface UsageSnapshot {
  updatedAt: number;
  refresh: string;
  interval: number;
  nextAt?: number;
  polling: boolean;
  accounts: UsageAccount[];
  machines: Record<string, { status: string; code?: string; at: number }>;
  status: Record<string, StatusPage>;
}

export interface CostRow {
  day: string;
  provider: string;
  model: string;
  project?: string;
  machine: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  requests: number;
  cost: number;
  priced: boolean;
}

export interface CostReport {
  generatedAt: number;
  days: number;
  weekHours: number;
  monthHours: number;
  machines: Record<string, { error?: string; files: number; unpriced?: string[] }>;
  rows: CostRow[];
}

export const PROVIDERS = ['claude', 'codex', 'grok', 'antigravity', 'kimi', 'deepseek'] as const;

/** A window whose reset has passed since it was read: its use is of the
 * period before, until the next poll reads the new one. */
export function pastReset(w: UsageWindow, now = Date.now() / 1000): boolean {
  return !!w.resetsAt && w.resetsAt <= now;
}

/** The window an account is closest to running out of, of those still in
 * the period they were read in. */
export function tightestWindow(a: UsageAccount, now = Date.now() / 1000): UsageWindow | undefined {
  let best: UsageWindow | undefined;
  for (const w of a.windows ?? []) if (!pastReset(w, now) && (!best || w.usedPct > best.usedPct)) best = w;
  return best;
}

/** Accounts, the tightest first; those without windows last. */
export function sortAccounts(list: UsageAccount[]): UsageAccount[] {
  return [...list].sort((a, b) => {
    const wa = tightestWindow(a)?.usedPct ?? -1;
    const wb = tightestWindow(b)?.usedPct ?? -1;
    if (wa !== wb) return wb - wa;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** The tightest window of all accounts, for the status bar. */
export function tightest(s: UsageSnapshot | undefined): { account: UsageAccount; window: UsageWindow } | undefined {
  const first = sortAccounts(s?.accounts ?? []).find((a) => tightestWindow(a));
  return first ? { account: first, window: tightestWindow(first)! } : undefined;
}

/** A duration in days and hours, hours and minutes, or minutes. */
export function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return t('usage.dur.dh', { d, h });
  if (h > 0) return t('usage.dur.hm', { h, m });
  return t('usage.dur.m', { m: Math.max(m, s > 0 ? 1 : 0) });
}

/** A window's name: its label, else its kind's. */
export function windowName(w: UsageWindow): string {
  const kind = t(`usage.kind.${w.kind}` as 'usage.kind.session');
  // A labelled session or weekly window (a group of models) says which it is.
  if (w.label) return w.kind === 'model' ? w.label : `${w.label} · ${kind}`;
  return kind;
}

export function providerName(p: string): string {
  return (PROVIDERS as readonly string[]).includes(p) ? t(`usage.provider.${p}` as 'usage.provider.claude') : p;
}

/** The thresholds setting as numbers, ascending. */
export function parseThresholds(v: unknown): number[] {
  const list = Array.isArray(v) ? v : ['80', '95'];
  return list
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 100)
    .sort((a, b) => a - b);
}

export interface Alert {
  id: string;
  kind: 'threshold' | 'reset' | 'pace';
  account: UsageAccount;
  window: UsageWindow;
  threshold?: number;
}

export const windowId = (a: UsageAccount, w: UsageWindow) => `${a.key}|${w.id ?? `${w.kind}|${w.label ?? ''}`}`;

/** Two resets this close are the same period's (a provider that says how
 * long until it gives a slightly different time at each poll). */
const SAME_PERIOD = 10 * 60;

/**
 * The alerts of a new snapshot: a window that reached a threshold (once per
 * period until it falls below it again), a window that started over after
 * it had reached the lowest threshold, and a window whose pace runs it out
 * before its reset (once per period). fired keeps what was said, by alert
 * id, with the period's reset. A window past its reset says nothing.
 */
export function alerts(
  prev: UsageSnapshot | undefined,
  next: UsageSnapshot,
  thresholds: number[],
  fired: Record<string, number>,
  now = Date.now() / 1000,
): Alert[] {
  const out: Alert[] = [];
  const before = new Map<string, UsageWindow>();
  for (const a of prev?.accounts ?? []) for (const w of a.windows ?? []) before.set(windowId(a, w), w);
  const low = thresholds[0];
  for (const a of next.accounts) {
    if (a.status !== 'ok') continue;
    for (const w of a.windows ?? []) {
      if (pastReset(w, now)) continue;
      const id = windowId(a, w);
      const period = w.resetsAt ?? 0;
      for (const th of thresholds) {
        const key = `${id}|${th}`;
        if (w.usedPct >= th) {
          // Not said yet, or said in an earlier period (no page saw the
          // window drop below the threshold in between).
          if (fired[key] === undefined || Math.abs(period - fired[key]) > SAME_PERIOD) {
            fired[key] = period;
            out.push({ id: key, kind: 'threshold', account: a, window: w, threshold: th });
          }
        } else if (fired[key] !== undefined) {
          delete fired[key]; // below it again: armed for the next time
        }
      }
      const old = before.get(id);
      if (
        old &&
        low !== undefined &&
        old.usedPct >= low &&
        old.resetsAt &&
        w.resetsAt &&
        w.resetsAt > old.resetsAt &&
        w.usedPct < old.usedPct
      ) {
        out.push({ id: `${id}|reset|${w.resetsAt}`, kind: 'reset', account: a, window: w });
      }
      const paceKey = `${id}|pace`;
      if (w.pace?.beforeReset && w.usedPct < 100) {
        if (fired[paceKey] !== period) {
          fired[paceKey] = period;
          out.push({ id: paceKey, kind: 'pace', account: a, window: w });
        }
      }
    }
  }
  return out;
}

/** The text of an alert. */
export function alertText(a: Alert): string {
  const who = [providerName(a.account.provider), a.account.email].filter(Boolean).join(' · ');
  const name = windowName(a.window);
  const now = Date.now() / 1000;
  switch (a.kind) {
    case 'threshold':
      return t('usage.alert.threshold', {
        who,
        window: name,
        pct: Math.round(a.window.usedPct),
        reset: a.window.resetsAt ? duration(a.window.resetsAt - now) : '–',
      });
    case 'reset':
      return t('usage.alert.reset', { who, window: name });
    case 'pace':
      return t('usage.alert.pace', { who, window: name, in: duration((a.window.pace?.exhaustsAt ?? now) - now) });
  }
}

// ---- cost ----

/** The local day of a date, YYYY-MM-DD. */
export function dayOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The last n days, oldest first, ending today. */
export function lastDays(n: number, today = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
  return out;
}

/** The total cost of the rows of the last n days. */
export function costOf(rows: CostRow[], n: number, today = new Date()): number {
  const from = lastDays(n, today)[0];
  return rows.reduce((s, r) => (r.day >= from ? s + r.cost : s), 0);
}

/** Cost per day of the last n days. */
export function daily(rows: CostRow[], n: number, today = new Date()): { day: string; cost: number }[] {
  const days = lastDays(n, today);
  const by = new Map(days.map((d) => [d, 0]));
  for (const r of rows) if (by.has(r.day)) by.set(r.day, by.get(r.day)! + r.cost);
  return days.map((day) => ({ day, cost: by.get(day)! }));
}

export type RankBy = 'model' | 'project' | 'machine';

/** The cost of the last n days by model, project or machine, most first. */
export function rank(rows: CostRow[], by: RankBy, n: number, today = new Date(), label: (r: CostRow) => string = (r) => r[by] ?? '') {
  const from = lastDays(n, today)[0];
  const sums = new Map<string, { name: string; cost: number; tokens: number }>();
  for (const r of rows) {
    if (r.day < from) continue;
    const name = label(r) || '–';
    const e = sums.get(name) ?? { name, cost: 0, tokens: 0 };
    e.cost += r.cost;
    e.tokens += r.input + r.cached + r.cacheWrite + r.output;
    sums.set(name, e);
  }
  return [...sums.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}

/** What a measured cost comes to in a week and in a month (168 and 750
 * hours, as the ai-usage report counts them). */
export function equivalents(cost: number, days: number, weekHours = 168, monthHours = 750) {
  const hours = days * 24;
  return { week: (cost * weekHours) / hours, month: (cost * monthHours) / hours };
}

export function money(v: number): string {
  return v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
