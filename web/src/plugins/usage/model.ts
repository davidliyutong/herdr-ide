// The AI usage plugin's data (internal/plugins/usage) and what the panel and
// the status bar compute from it: the tightest window, durations, the text
// of the core's alerts, and the cost report's totals and rankings.
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
  status: 'ok' | 'stale' | 'unauth' | 'error';
  code?: string;
  source?: string;
  asOf?: number;
  home?: string;
  machines: string[];
  fetchedAt?: number;
  seenAt: number;
  /** Machines whose answer was not ok in the poll that last read it,
   * while its numbers come from the best answer. */
  issues?: { machine: string; status: string; code?: string }[];
}

export interface StatusPage {
  indicator?: string;
  description?: string;
  url: string;
}

/** An alert the core fired (once per period of its window): a threshold
 * reached, a window that started over, a pace that runs it out before its
 * reset. */
export interface UsageAlert {
  id: string;
  kind: 'threshold' | 'reset' | 'pace';
  /** The account's key. */
  key: string;
  provider: string;
  email?: string;
  /** The window when the alert fired. */
  window: UsageWindow;
  threshold?: number;
  at: number;
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
  /** The alerts fired in the last hour (none while usage.alerts is off). */
  alerts?: UsageAlert[];
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
  /** Part of output. */
  reasoning?: number;
  requests: number;
  cost: number;
  priced: boolean;
}

export interface CostReport {
  generatedAt: number;
  days: number;
  weekHours: number;
  monthHours: number;
  /** failed: the logs a machine could not read, provider:code. */
  machines: Record<string, { error?: string; files: number; unpriced?: string[]; failed?: string[] }>;
  rows: CostRow[];
}

/** In the core's order (usage.Providers); OpenCode has spend only. */
export const PROVIDERS = ['claude', 'codex', 'grok', 'antigravity', 'kimi', 'deepseek', 'opencode'] as const;

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

/** The text of an alert. */
export function alertText(a: UsageAlert): string {
  const who = [providerName(a.provider), a.email].filter(Boolean).join(' · ');
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
    e.tokens += rowTokens(r);
    sums.set(name, e);
  }
  return [...sums.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}

/** The tokens of a row, all kinds (reasoning is part of the output). */
export function rowTokens(r: CostRow): number {
  return r.input + r.cached + r.cacheWrite + r.output;
}

export interface TokenKinds {
  input: number;
  /** Cache reads. */
  cached: number;
  cacheWrite: number;
  /** Includes the reasoning tokens. */
  output: number;
  /** The part of output spent on reasoning. */
  reasoning: number;
  /** All four kinds. */
  total: number;
  requests: number;
}

const emptyKinds = (): TokenKinds => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, requests: 0 });

function addRow(k: TokenKinds, r: CostRow) {
  k.input += r.input;
  k.cached += r.cached;
  k.cacheWrite += r.cacheWrite;
  k.output += r.output;
  k.reasoning += r.reasoning ?? 0;
  k.total += rowTokens(r);
  k.requests += r.requests;
}

/** The tokens of the rows of the last n days by kind, with the requests;
 * priced or not. */
export function tokenKinds(rows: CostRow[], n: number, today = new Date()): TokenKinds {
  const from = lastDays(n, today)[0];
  const k = emptyKinds();
  for (const r of rows) if (r.day >= from) addRow(k, r);
  return k;
}

/** Tokens per day of the last n days, oldest first, by kind. */
export function dailyTokens(rows: CostRow[], n: number, today = new Date()): ({ day: string } & TokenKinds)[] {
  const days = lastDays(n, today);
  const by = new Map(days.map((d) => [d, emptyKinds()]));
  for (const r of rows) {
    const k = by.get(r.day);
    if (k) addRow(k, r);
  }
  return days.map((day) => ({ day, ...by.get(day)! }));
}

/** The tokens of the last n days by model, project or machine, most first;
 * `unpriced` marks a name with a row the price table does not know (its
 * tokens count all the same, its cost is 0). */
export function rankTokens(rows: CostRow[], by: RankBy, n: number, today = new Date(), label: (r: CostRow) => string = (r) => r[by] ?? '') {
  const from = lastDays(n, today)[0];
  const sums = new Map<string, { name: string; tokens: number; cost: number; unpriced: boolean }>();
  for (const r of rows) {
    if (r.day < from) continue;
    const name = label(r) || '–';
    const e = sums.get(name) ?? { name, tokens: 0, cost: 0, unpriced: false };
    e.tokens += rowTokens(r);
    e.cost += r.cost;
    if (!r.priced) e.unpriced = true;
    sums.set(name, e);
  }
  return [...sums.values()].sort((a, b) => b.tokens - a.tokens || b.cost - a.cost);
}

/** What a measured cost (or token count) comes to in a week and in a month (168 and 750
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
