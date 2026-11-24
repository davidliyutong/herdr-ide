// The AI usage plugin's data (internal/plugins/usage) and what the panel and
// the status bar compute from it: the tightest window, durations, the text
// of the core's alerts, the cost report's totals and rankings, and what a
// coding agent's session used.
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

/** A machine's quarter of an hour of a provider's spend (CostReport.recent). */
export interface CostSlot {
  /** The slot's start (Unix seconds). */
  at: number;
  provider: string;
  machine: string;
  tokens: number;
  requests: number;
  cost: number;
  priced: boolean;
}

/** The length of a CostSlot (s). */
export const SLOT_SEC = 900;

export interface CostReport {
  generatedAt: number;
  days: number;
  weekHours: number;
  monthHours: number;
  /** failed: the logs a machine could not read, provider:code. */
  machines: Record<string, { error?: string; files: number; unpriced?: string[]; failed?: string[] }>;
  rows: CostRow[];
  /** The quarters of an hour with spend since recentSince (Unix seconds),
   * for the spend of a subscription's window. */
  recentSince?: number;
  recent?: CostSlot[];
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

/** A name reduced to its letters and digits, lower case, to compare a
 * model's name with a window's label ("Opus", "GPT-5.3-Codex-Spark"). */
const bare = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Whether a window counts the requests of model: every window but those of
 * models (kind model), which count only the model their label names; none
 * of those when the model is not known. */
export function windowApplies(w: UsageWindow, model?: string): boolean {
  if (w.kind !== 'model') return true;
  return !!model && !!w.label && bare(model).includes(bare(w.label));
}

/** The tightest window that counts what the coding agent in the focused
 * pane does: of its service's accounts read on its machine (any of the
 * service's when none was), those of its model among the windows of
 * models; undefined when no such account has one. */
export function tightestFor(
  s: UsageSnapshot | undefined,
  provider: string,
  m: string,
  model?: string,
  now = Date.now() / 1000,
): { account: UsageAccount; window: UsageWindow } | undefined {
  const all = (s?.accounts ?? []).filter((a) => a.provider === provider);
  const here = all.filter((a) => (a.machines ?? []).includes(m));
  let best: { account: UsageAccount; window: UsageWindow } | undefined;
  for (const a of here.length ? here : all) {
    for (const w of a.windows ?? []) {
      if (pastReset(w, now) || !windowApplies(w, model)) continue;
      if (!best || w.usedPct > best.window.usedPct) best = { account: a, window: w };
    }
  }
  return best;
}

/** What a window of an account has cost so far at API prices. */
export interface WindowSpend {
  cost: number;
  tokens: number;
  requests: number;
  /** Every request had a price. */
  priced: boolean;
  /** The whole window at the rate its share was used: the spend over the
   * share; only from 5% used on. */
  full?: { cost: number; tokens: number };
}

/** The spend of a window: the quarters of an hour of the account's
 * machines' logs of its service since the window started (its reset less
 * its length; a quarter counts when most of it is in the window).
 * Undefined for a window without a start or past its reset, for a model's
 * window (the logs' spend is of every model), and when the report's
 * quarters do not reach back to its start. A machine where several
 * accounts of the service were used counts for each. */
export function windowSpend(
  rep: CostReport | undefined,
  a: UsageAccount,
  w: UsageWindow,
  now = Date.now() / 1000,
): WindowSpend | undefined {
  if (!rep?.recent || rep.recentSince === undefined || !w.resetsAt || !w.windowSec || w.kind === 'model' || pastReset(w, now)) {
    return undefined;
  }
  const start = w.resetsAt - w.windowSec;
  if (start < rep.recentSince) return undefined;
  const machines = new Set(a.machines ?? []);
  const out: WindowSpend = { cost: 0, tokens: 0, requests: 0, priced: true };
  for (const s of rep.recent) {
    if (s.provider !== a.provider || !machines.has(s.machine) || s.at + SLOT_SEC / 2 <= start) continue;
    out.cost += s.cost;
    out.tokens += s.tokens;
    out.requests += s.requests;
    out.priced = out.priced && s.priced;
  }
  if (w.usedPct >= 5) out.full = { cost: (out.cost * 100) / w.usedPct, tokens: (out.tokens * 100) / w.usedPct };
  return out;
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

export interface DailyProviderBreakdown {
  provider: string;
  cost: number;
  tokens: number;
  requests: number;
}

export interface DailyDetail {
  day: string;
  cost: number;
  kinds: TokenKinds;
  byProvider: DailyProviderBreakdown[];
}

const providerOrder = new Map<string, number>(PROVIDERS.map((p, i) => [p, i]));

/** Per-day cost, token kinds and provider breakdown for the last n days,
 * oldest first. */
export function dailyDetails(rows: CostRow[], n: number, today = new Date()): DailyDetail[] {
  const days = lastDays(n, today);
  const by = new Map(days.map((d) => [d, { cost: 0, kinds: emptyKinds(), providers: new Map<string, DailyProviderBreakdown>() }]));
  for (const r of rows) {
    const d = by.get(r.day);
    if (!d) continue;
    d.cost += r.cost;
    addRow(d.kinds, r);
    const p = d.providers.get(r.provider) ?? { provider: r.provider, cost: 0, tokens: 0, requests: 0 };
    p.cost += r.cost;
    p.tokens += rowTokens(r);
    p.requests += r.requests;
    d.providers.set(r.provider, p);
  }
  return days.map((day) => {
    const d = by.get(day)!;
    const byProvider = [...d.providers.values()]
      .filter((p) => p.cost > 0 || p.tokens > 0 || p.requests > 0)
      .sort((a, b) => {
        const oa = providerOrder.get(a.provider);
        const ob = providerOrder.get(b.provider);
        if (oa !== undefined && ob !== undefined) return oa - ob;
        if (oa !== undefined) return -1;
        if (ob !== undefined) return 1;
        return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
      });
    return { day, cost: d.cost, kinds: d.kinds, byProvider };
  });
}

/** A model's use in the last n days: its tokens by kind, requests and
 * cost. */
export interface ModelUsage extends TokenKinds {
  name: string;
  provider: string;
  cost: number;
  /** A row of it had no price: its tokens count, its cost does not. */
  unpriced: boolean;
}

/** Every model's use in the last n days, by service and model, the most
 * cost first (by tokens). */
export function modelBreakdown(rows: CostRow[], n: number, today = new Date(), by: 'cost' | 'tokens' = 'cost'): ModelUsage[] {
  const from = lastDays(n, today)[0];
  const sums = new Map<string, ModelUsage>();
  for (const r of rows) {
    if (r.day < from) continue;
    const key = `${r.provider}\u0000${r.model}`;
    let e = sums.get(key);
    if (!e) {
      e = { ...emptyKinds(), name: r.model || '–', provider: r.provider, cost: 0, unpriced: false };
      sums.set(key, e);
    }
    addRow(e, r);
    e.cost += r.cost;
    if (!r.priced) e.unpriced = true;
  }
  const list = [...sums.values()];
  return by === 'cost'
    ? list.sort((a, b) => b.cost - a.cost || b.total - a.total)
    : list.sort((a, b) => b.total - a.total || b.cost - a.cost);
}

/** A model's name for the status bar: without the vendor's prefix and a
 * date at the end (claude-opus-4-6-20260101: opus-4-6). */
export function shortModel(model: string): string {
  return model.replace(/^(claude|anthropic)[-/]/, '').replace(/-\d{8}$/, '');
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

/** A token count for the status bar: whole thousands ("84k"), millions
 * with a decimal below ten ("1.2M"). */
export function tokensShort(n: number): string {
  const k = Math.round(n / 1e3);
  if (k >= 1000) return n >= 1e7 ? `${Math.round(n / 1e6)}M` : `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${k}k`;
  return String(Math.max(0, Math.round(n)));
}

// ---- a coding agent's session ----

/** What a session of a coding agent used, at API prices
 * (agentproto.SessionUsage; GET /api/m/{id}/p/usage/session). */
export interface SessionUsage {
  /** The model of the session's latest request. */
  model?: string;
  input: number;
  cached: number;
  cacheWrite: number;
  /** Includes the reasoning tokens. */
  output: number;
  reasoning: number;
  requests: number;
  cost: number;
  /** Every request's model had a price. */
  priced: boolean;
  /** The tokens of the latest request's context. */
  contextUsed: number;
  /** The model's context window; 0 when it is not known. */
  contextSize: number;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** A session's usage from the core's answer: numbers that are not finite
 * and non-negative count 0, a model that is not text is left out;
 * undefined for an answer that is not an object. */
export function sessionUsageOf(v: unknown): SessionUsage | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  return {
    model: typeof o.model === 'string' && o.model ? o.model : undefined,
    input: count(o.input),
    cached: count(o.cached),
    cacheWrite: count(o.cacheWrite),
    output: count(o.output),
    reasoning: count(o.reasoning),
    requests: count(o.requests),
    cost: count(o.cost),
    priced: o.priced === true,
    contextUsed: count(o.contextUsed),
    contextSize: count(o.contextSize),
  };
}

/** A session's cost as the spend shows money; a dash when a model of it
 * has no price. */
export function sessionCost(u: SessionUsage): string {
  return u.priced ? money(u.cost) : '—';
}

/** The share of the context window in use, a whole percentage; undefined
 * when the window is not known. */
export function contextPct(u: SessionUsage): number | undefined {
  return u.contextSize > 0 ? Math.round((u.contextUsed / u.contextSize) * 100) : undefined;
}

/** The context in use for the status bar: its share of the window, else
 * the tokens; "" when the session has no context yet. */
export function contextShort(u: SessionUsage): string {
  const pct = contextPct(u);
  if (pct !== undefined) return `${pct}%`;
  return u.contextUsed > 0 ? tokensShort(u.contextUsed) : '';
}

/** The account of provider whose subscription an agent on machine m uses:
 * of those read on m, the one closest to running out of a window. */
export function sessionAccount(s: UsageSnapshot | undefined, provider: string, m: string): UsageAccount | undefined {
  return sortAccounts((s?.accounts ?? []).filter((a) => a.provider === provider && (a.machines ?? []).includes(m))).find((a) =>
    tightestWindow(a),
  );
}
