// The AI usage plugin's data (backend/features/usage) and what the panel and
// the status bar compute from it: the tightest window, durations, the text
// of the hub's alerts, the cost report's totals and rankings, and what a
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

/** An alert the hub fired (once per period of its window): a threshold
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
  machines: Record<string, { error?: string; files: number; unpriced?: string[]; failed?: string[]; disabled?: boolean }>;
  rows: CostRow[];
  /** The quarters of an hour with spend since recentSince (Unix seconds),
   * for the spend of a subscription's window. */
  recentSince?: number;
  recent?: CostSlot[];
}

/** Which rate-limit window(s) the status bar item shows. */
export type StatusBarWindowMode = 'auto' | '5h' | '7d' | 'both';

/** The default provider the status bar shows when no agent pane is active. */
export type StatusBarProvider = 'auto' | 'claude' | 'codex' | 'grok' | 'antigravity' | 'kimi';

/** Monetary-value and tier-weight estimate of one account's quota capacity and
 * remaining availability. Subscription capacity is expressed in USD only when
 * backed by observed local API-priced logs or explicit USD credits/balances. */
export interface AccountValueEstimate {
  /** Total estimated capacity in USD for the current cycle (observed API-priced
   * cycle capacity + enabled USD extra usage, or explicit credit limit);
   * undefined when neither empirical API spend nor explicit USD limits exist. */
  capacityUsd?: number;
  /** Relative subscription tier multiplier (baseline paid plan = 1), or
   * undefined when the account has no subscription windows or unknown plan. */
  tierWeight?: number;
  /** Estimated available / remaining value in USD (also set for balance-only
   * accounts such as DeepSeek). */
  availableUsd?: number;
  /** Estimated used value in USD (capacityUsd - availableUsd when bounded, or
   * observed cycle API spend so far when below the 5% extrapolation floor). */
  usedUsd?: number;
  /** Effective used percentage (0..100) of this account; undefined when the
   * account has neither active/replenished windows nor bounded credits. */
  usedPct?: number;
  /** How capacity was determined. */
  basis: 'api' | 'explicit' | 'hybrid' | 'tier' | 'unknown';
}

/** Combined approximate usage across 2+ accounts of one provider. Percentages
 * and current-cycle equivalent API amounts are computed over comparable window
 * cycles using deduplicated local API-priced logs, true quota tier multipliers,
 * and explicit USD credits/balances. */
export interface MergedQuotaSummary {
  /** Overall merged used percentage (0..100); undefined when no member has
   * measurable quota or bounded credits. */
  usedPct?: number;
  /** Overall merged remaining percentage (100 - usedPct). */
  remainingPct?: number;
  /** Estimated remaining value in USD for the summarized cycle (or prepaid
   * balances). Only set when backed by observed API logs or explicit money. */
  availableUsd?: number;
  /** Estimated total equivalent API capacity in USD for the summarized cycle
   * (or explicit bounded credit limit). */
  capacityUsd?: number;
  /** Estimated used equivalent API value in USD for the summarized cycle (or
   * observed spend so far / explicit used credits). */
  usedUsd?: number;
  /** How accounts were weighted:
   *  - 'api': calibrated from observed current-cycle equivalent API spend
   *  - 'explicit': weighted by explicit USD credit limits / balances
   *  - 'tier': weighted by subscription quota tier multipliers (e.g. 1x vs 20x)
   *  - 'equal': equal-weight fallback when neither tier nor monetary data exists */
  weighting: 'api' | 'explicit' | 'tier' | 'equal';
  /** Representative cycle window summarized (e.g. 5h session, 7d weekly, 30d
   * monthly) when all subscription accounts share that cycle. */
  window?: UsageWindow;
  /** Whether every log entry counted in the API-value estimate was priced. */
  priced?: boolean;
  /** Earliest upcoming reset among active primary windows in the summarized cycle. */
  resetsAt?: number;
}

/** A synthesized multi-account summary for any provider with 2+ accounts
 * that aggregates quotas while keeping every member for per-account views. */
export interface MergedUsageAccount extends UsageAccount {
  accountCount: number;
  members: UsageAccount[];
  summary: MergedQuotaSummary;
}

export function isMergedAccount(a: UsageAccount): a is MergedUsageAccount {
  return 'accountCount' in a && typeof (a as MergedUsageAccount).accountCount === 'number' && (a as MergedUsageAccount).accountCount > 1;
}

/** In the hub's order (usage.Providers); OpenCode has spend only. */
export const PROVIDERS = ['claude', 'codex', 'grok', 'antigravity', 'kimi', 'deepseek', 'opencode'] as const;

/** A window whose reset has passed since it was read: its use is of the
 * period before, until the next poll reads the new one. */
export function pastReset(w: UsageWindow, now = Date.now() / 1000): boolean {
  return !!w.resetsAt && w.resetsAt <= now;
}

const GEMINI_LABEL = /\bgemini\b/i;
const ANTIGRAVITY_THIRD_PARTY_LABEL = /\b(claude|gpt|openai|anthropic|sonnet|opus|haiku)\b/i;

/** Filters an account's windows to its primary quota pool for summary
 * calculations. Antigravity exposes separate third-party quotas (Claude/GPT)
 * alongside primary Gemini quotas; those smaller third-party buckets must not
 * dominate provider summaries when primary Gemini windows are present. */
export function primaryWindowsOf(a: Pick<UsageAccount, 'provider' | 'windows'>): UsageWindow[] {
  const ws = a.windows ?? [];
  if (a.provider !== 'antigravity' || ws.length === 0) return ws;
  const gemini = ws.filter((w) => GEMINI_LABEL.test(w.label ?? ''));
  if (gemini.length > 0) return gemini;
  const nonThirdParty = ws.filter((w) => !ANTIGRAVITY_THIRD_PARTY_LABEL.test(w.label ?? ''));
  return nonThirdParty.length > 0 ? nonThirdParty : ws;
}

/** The window an account is closest to running out of, of its primary quota
 * pool still in the period it was read in. */
export function tightestWindow(a: UsageAccount, now = Date.now() / 1000): UsageWindow | undefined {
  let best: UsageWindow | undefined;
  for (const w of primaryWindowsOf(a)) if (!pastReset(w, now) && (!best || w.usedPct > best.usedPct)) best = w;
  return best;
}

/** Relative subscription quota capacity multipliers by provider and plan tier
 * (baseline paid plan = 1). Reflects actual quota capacity ratios rather than
 * monthly retail subscription prices (e.g. Claude Max 20x is 20x Pro, not 10x). */
const PLAN_WEIGHT: Record<string, [RegExp, number][]> = {
  claude: [
    [/\bmax\b.*\b20x\b|\b20x\b/i, 20],
    [/\bteam\b.*\bpremium\b/i, 5],
    [/\bmax\b.*\b5x\b|\b5x\b|\bmax\b/i, 5],
    [/\benterprise\b/i, 3],
    [/\bteam\b/i, 1.5],
    [/\bpro\b/i, 1],
    [/\bfree\b/i, 0.2],
  ],
  codex: [
    [/\bpro\b/i, 10],
    [/\benterprise\b/i, 3],
    [/\b(team|business)\b/i, 1.5],
    [/\bedu\b/i, 1.25],
    [/\bplus\b/i, 1],
    [/\bgo\b/i, 0.4],
    [/\bfree\b/i, 0.2],
  ],
  grok: [
    [/\bheavy\b/i, 10],
    [/premium\s*\+|premium\s+plus/i, 1.33],
    [/\bsuper\s*grok\b|\bpro\b/i, 1],
    [/\bpremium\b/i, 0.27],
    [/\b(free|basic)\b/i, 0.13],
  ],
  antigravity: [
    [/\bultra\b/i, 12.5],
    [/\benterprise\b/i, 3],
    [/\b(team|business)\b/i, 1.5],
    [/\bpro\b/i, 1],
    [/\b(free|standard|individual)\b/i, 0.2],
  ],
  kimi: [
    [/\bvivace\b/i, 10],
    [/\ballegro\b/i, 5],
    [/\ballegretto\b/i, 2],
    [/\b(moderato|pro|plus)\b/i, 1],
    [/\b(andante|basic)\b/i, 0.5],
    [/\bfree\b/i, 0.2],
  ],
};

/** Monthly subscription retail prices (USD) by provider and plan tier; used
 * only to parse/compare explicit `$N` tiers and as a last-resort scale when
 * blending hybrid subscription + extra USD credits before local logs exist. */
const PLAN_USD: Record<string, [RegExp, number][]> = {
  claude: [
    [/\bmax\b.*\b20x\b|\b20x\b/i, 200],
    [/\bteam\b.*\bpremium\b/i, 150],
    [/\bmax\b.*\b5x\b|\b5x\b|\bmax\b/i, 100],
    [/\benterprise\b/i, 60],
    [/\bteam\b/i, 30],
    [/\bpro\b/i, 20],
    [/\bfree\b/i, 4],
  ],
  codex: [
    [/\bpro\b/i, 200],
    [/\benterprise\b/i, 60],
    [/\b(team|business)\b/i, 30],
    [/\bedu\b/i, 25],
    [/\bplus\b/i, 20],
    [/\bgo\b/i, 8],
    [/\bfree\b/i, 4],
  ],
  grok: [
    [/\bheavy\b/i, 300],
    [/premium\s*\+|premium\s+plus/i, 40],
    [/\bsuper\s*grok\b|\bpro\b/i, 30],
    [/\bpremium\b/i, 8],
    [/\b(free|basic)\b/i, 4],
  ],
  antigravity: [
    [/\bultra\b/i, 250],
    [/\benterprise\b/i, 60],
    [/\b(team|business)\b/i, 30],
    [/\bpro\b/i, 20],
    [/\b(free|standard|individual)\b/i, 4],
  ],
  kimi: [
    [/\bvivace\b/i, 199],
    [/\ballegro\b/i, 99],
    [/\ballegretto\b/i, 39],
    [/\b(moderato|pro|plus)\b/i, 19],
    [/\b(andante|basic)\b/i, 10],
    [/\bfree\b/i, 4],
  ],
};

/** Baseline paid plan monthly price (USD) per provider. */
const PROVIDER_BASELINE_USD: Record<string, number> = {
  claude: 20,
  codex: 20,
  grok: 30,
  antigravity: 20,
  kimi: 19,
};

/** Approximate FX rates to normalize non-USD credit/balance currencies onto
 * a common USD scale when combining accounts. */
const CURRENCY_TO_USD: Record<string, number> = {
  usd: 1,
  usdt: 1,
  cny: 1 / 7.2,
  rmb: 1 / 7.2,
  eur: 1.08,
  gbp: 1.27,
  jpy: 1 / 155,
};

const round2 = (v: number) => Math.round(v * 100) / 100;
const clampPct = (v: number) => round2(Math.min(100, Math.max(0, v)));
const finiteNonNeg = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Estimates the relative quota capacity multiplier of a subscription plan
 * tier (baseline paid tier = 1), or undefined when absent/unrecognized. */
export function estimatePlanWeight(provider: string, plan?: string): number | undefined {
  if (!plan) return undefined;
  const norm = plan.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!norm) return undefined;
  const rules = PLAN_WEIGHT[provider.toLowerCase()];
  if (rules) {
    for (const [re, w] of rules) if (re.test(norm)) return w;
  }
  const mult = /\b(\d+(?:\.\d+)?)\s*x\b/i.exec(norm);
  if (mult) {
    const n = Number(mult[1]);
    if (Number.isFinite(n) && n > 0) return round2(n);
  }
  const explicit = /\$\s*(\d+(?:\.\d+)?)/.exec(norm);
  if (explicit) {
    const n = Number(explicit[1]);
    const base = PROVIDER_BASELINE_USD[provider.toLowerCase()] ?? 20;
    if (Number.isFinite(n) && n > 0) return round2(n / base);
  }
  return undefined;
}

/** Estimates the monthly retail USD price of a subscription plan tier, or
 * undefined when the plan is absent or unrecognized. */
export function estimatePlanUsd(provider: string, plan?: string): number | undefined {
  if (!plan) return undefined;
  const norm = plan.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!norm) return undefined;
  const rules = PLAN_USD[provider.toLowerCase()];
  if (rules) {
    for (const [re, usd] of rules) if (re.test(norm)) return usd;
  }
  const explicit = /\$\s*(\d+(?:\.\d+)?)/.exec(norm);
  if (explicit) {
    const n = Number(explicit[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

interface ExplicitMoney {
  /** Bounded USD credit capacity (e.g. limit or balance + used). */
  capacityUsd?: number;
  /** Remaining USD value of bounded credits. */
  availableUsd?: number;
  /** Used USD value of bounded credits. */
  usedUsd?: number;
  /** Remaining USD of unbounded prepaid balances/wallets (no limit/used). */
  prepaidUsd?: number;
}

/** Extracts explicit dollar balances/limits from an account's credits and
 * prepaid balances. Non-monetary units (e.g. abstract "credits"), disabled
 * extra usage, and unlimited credits are excluded from bounded USD totals. */
function explicitMoneyOf(a: UsageAccount): ExplicitMoney {
  const out: ExplicitMoney = {};
  const c = a.credits;
  if (c && c.enabled !== false && !c.unlimited) {
    const fx = CURRENCY_TO_USD[(c.unit ?? 'usd').toLowerCase()];
    if (fx !== undefined) {
      const limit = finiteNonNeg(c.limit);
      const used = finiteNonNeg(c.used);
      const balance = finiteNonNeg(c.balance);
      if (limit !== undefined && limit > 0) {
        const cap = limit * fx;
        if (used !== undefined) {
          const u = Math.min(cap, used * fx);
          out.capacityUsd = cap;
          out.usedUsd = u;
          out.availableUsd = Math.max(0, cap - u);
        } else if (balance !== undefined) {
          const av = Math.min(cap, balance * fx);
          out.capacityUsd = cap;
          out.availableUsd = av;
          out.usedUsd = Math.max(0, cap - av);
        }
      } else if (balance !== undefined) {
        if (used !== undefined && balance + used > 0) {
          const av = balance * fx;
          const u = used * fx;
          out.capacityUsd = av + u;
          out.availableUsd = av;
          out.usedUsd = u;
        } else if (balance > 0) {
          out.prepaidUsd = (out.prepaidUsd ?? 0) + balance * fx;
        }
      }
    }
  }
  if (a.balances?.length) {
    let bal = 0;
    let found = false;
    for (const b of a.balances) {
      const fx = CURRENCY_TO_USD[b.currency.toLowerCase()];
      const total = finiteNonNeg(b.total);
      if (fx === undefined || total === undefined) continue;
      found = true;
      bal += (a.available === false ? 0 : total) * fx;
    }
    if (found) out.prepaidUsd = (out.prepaidUsd ?? 0) + bal;
  }
  return out;
}

/** Synthetic extra-usage monthly window emitted beside Claude's extra_usage
 * USD credits; excluded from subscription windows to avoid double-counting. */
const isExtraCreditWindow = (w: UsageWindow) => w.kind === 'monthly' && (w.label ?? '').trim().toLowerCase() === 'extra';

/** Subscription windows of an account's primary quota pool (excluding
 * Antigravity third-party Claude/GPT windows when Gemini windows exist, and
 * excluding synthetic Extra credit windows when explicit USD limits apply). */
function subWindowsOf(a: UsageAccount, hasExplicitCreditCap: boolean): UsageWindow[] {
  const ws = primaryWindowsOf(a);
  if (!hasExplicitCreditCap) return ws;
  const filtered = ws.filter((w) => !isExtraCreditWindow(w));
  return filtered.length ? filtered : [];
}

/** Estimates one account's current-cycle equivalent API capacity (when `cost`
 * has observed spend for its tightest primary window), explicit USD credits /
 * balances, tier weight, and effective used percentage. */
export function estimateAccountValue(
  a: UsageAccount,
  now = Date.now() / 1000,
  opts: { treatAllPastResetAsReplenished?: boolean; cost?: CostReport } = {},
): AccountValueEstimate {
  const moneyInfo = explicitMoneyOf(a);
  const hasExplicitCap = (moneyInfo.capacityUsd ?? 0) > 0;
  const subWindows = subWindowsOf(a, hasExplicitCap);
  const activeSub = subWindows.filter((w) => !pastReset(w, now));
  let tightSub: UsageWindow | undefined;
  let subUsedPct: number | undefined;
  if (activeSub.length > 0) {
    for (const w of activeSub) if (!tightSub || w.usedPct > tightSub.usedPct) tightSub = w;
    subUsedPct = clampPct(tightSub!.usedPct);
  } else if (subWindows.length > 0 && opts.treatAllPastResetAsReplenished) {
    subUsedPct = 0;
  }
  const tierWeight = subUsedPct !== undefined ? estimatePlanWeight(a.provider, a.plan) : undefined;

  // Empirical current-cycle API capacity from local logs for the tightest window.
  let apiCapUsd: number | undefined;
  let apiUsedUsd: number | undefined;
  let apiAvailUsd: number | undefined;
  if (opts.cost && tightSub) {
    const sp = windowSpend(opts.cost, a, tightSub, now);
    if (sp && sp.cost > 0) {
      const extraOverlap = subUsedPct !== undefined && subUsedPct >= 100 ? (moneyInfo.usedUsd ?? 0) : 0;
      const subCost = Math.max(0, sp.cost - extraOverlap);
      if (subCost > 0) {
        apiUsedUsd = subCost;
        if (tightSub.usedPct >= 5) {
          apiCapUsd = (subCost * 100) / tightSub.usedPct;
          apiAvailUsd = Math.max(0, apiCapUsd - subCost);
        }
      }
    }
  }

  let capacityUsd = 0;
  let availableUsd = 0;
  let hasCap = false;
  let hasAvail = false;

  if (apiCapUsd !== undefined && apiCapUsd > 0 && apiAvailUsd !== undefined) {
    capacityUsd += apiCapUsd;
    availableUsd += apiAvailUsd;
    hasCap = true;
    hasAvail = true;
  }

  if (hasExplicitCap) {
    capacityUsd += moneyInfo.capacityUsd!;
    availableUsd += moneyInfo.availableUsd!;
    hasCap = true;
    hasAvail = true;
  }

  if (moneyInfo.prepaidUsd !== undefined) {
    if (hasCap) {
      if (moneyInfo.prepaidUsd > 0) {
        capacityUsd += moneyInfo.prepaidUsd;
        availableUsd += moneyInfo.prepaidUsd;
      }
    } else if (subUsedPct === undefined) {
      availableUsd += moneyInfo.prepaidUsd;
      hasAvail = true;
    }
  }

  // Case 1: Pure explicit USD credits (no subscription windows) OR subscription
  // backed by empirical current-cycle API capacity.
  if (hasCap && capacityUsd > 0 && (subUsedPct === undefined || apiCapUsd !== undefined)) {
    const usedUsd = Math.max(0, capacityUsd - availableUsd);
    const usedPct = clampPct((usedUsd / capacityUsd) * 100);
    const basis: AccountValueEstimate['basis'] =
      apiCapUsd !== undefined && hasExplicitCap ? 'hybrid' : apiCapUsd !== undefined ? 'api' : 'explicit';
    return {
      capacityUsd: round2(capacityUsd),
      tierWeight,
      availableUsd: round2(availableUsd),
      usedUsd: round2(usedUsd),
      usedPct,
      basis,
    };
  }

  // Case 2: Subscription windows without observed empirical API capacity yet.
  if (subUsedPct !== undefined) {
    // If bounded USD extra credits exist alongside subscription windows, blend
    // them into usedPct using the provider's baseline scale without fabricating
    // a monthly retail fee as current-cycle API dollar capacity.
    let usedPct = subUsedPct;
    if (hasExplicitCap) {
      const baseUsd = PROVIDER_BASELINE_USD[a.provider.toLowerCase()] ?? 20;
      const subBlendCap = (tierWeight ?? 1) * baseUsd;
      const blendCap = subBlendCap + moneyInfo.capacityUsd! + Math.max(0, moneyInfo.prepaidUsd ?? 0);
      const blendAvail = subBlendCap * (1 - subUsedPct / 100) + moneyInfo.availableUsd! + Math.max(0, moneyInfo.prepaidUsd ?? 0);
      usedPct = clampPct(((blendCap - blendAvail) / blendCap) * 100);
    }
    const spentSoFar = (apiUsedUsd ?? 0) + (moneyInfo.usedUsd ?? 0);
    return {
      tierWeight,
      usedUsd: spentSoFar > 0 ? round2(spentSoFar) : undefined,
      usedPct,
      basis: hasExplicitCap ? 'hybrid' : tierWeight !== undefined ? 'tier' : 'unknown',
    };
  }

  return {
    availableUsd: hasAvail ? round2(availableUsd) : undefined,
    basis: hasAvail ? 'explicit' : 'unknown',
  };
}

/** Headline used percentage (0..100) for an account or merged provider
 * summary: uses the merged summary when merged, the tightest primary active
 * window for a single subscription account, else bounded USD credits. */
export function accountUsedPct(a: UsageAccount | MergedUsageAccount, now = Date.now() / 1000): number | undefined {
  if (isMergedAccount(a)) return a.summary.usedPct;
  const w = tightestWindow(a, now);
  if (w) return w.usedPct;
  return estimateAccountValue(a, now).usedPct;
}

/** Accounts, the tightest first; those without measurable usage last. */
export function sortAccounts<T extends UsageAccount>(list: T[], now = Date.now() / 1000): T[] {
  return [...list].sort((a, b) => {
    const wa = accountUsedPct(a, now) ?? -1;
    const wb = accountUsedPct(b, now) ?? -1;
    if (wa !== wb) return wb - wa;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

const statusPriority: Record<UsageAccount['status'], number> = { ok: 0, stale: 1, error: 2, unauth: 3 };

/** Minimum component used fraction (5%) before extrapolating full-cycle API
 * capacity from observed spend, matching single-account windowSpend. */
const MIN_EXTRAPOLATE_FRACTION = 0.05;
/** When plans are known across multiple disjoint machines, a per-tier-unit
 * spend rate below this share of a sibling's rate signals incomplete local
 * logs (e.g. usage on web or an untracked machine). */
const INCOMPLETE_LOG_RATIO = 0.15;

type CycleKey = '5h' | '7d' | '30d';

interface MemberMeta {
  account: UsageAccount;
  explicit: ExplicitMoney;
  subWindows: UsageWindow[];
  tierWeight?: number;
  priorWeight: number;
}

interface CycleEntry {
  meta: MemberMeta;
  window?: UsageWindow;
  usedPct: number;
}

interface CycleSpendResult {
  covered: boolean;
  cost: number;
  priced: boolean;
}

/** Deduplicated local API-equivalent spend across the unique machines hosting
 * a connected component of accounts for their current windows in one cycle.
 * Uses exact 15-minute CostReport.recent slots when covered, falling back to
 * daily CostReport.rows for cycles longer than 8 days (e.g. 30-day monthly). */
function componentCycleSpend(cost: CostReport | undefined, provider: string, entries: CycleEntry[], now: number): CycleSpendResult {
  if (!cost) return { covered: false, cost: 0, priced: true };
  const machines = new Set<string>();
  for (const e of entries) for (const m of e.meta.account.machines ?? []) machines.add(m);
  if (machines.size === 0) return { covered: false, cost: 0, priced: true };

  let totalCost = 0;
  let priced = true;
  let anyMeasurable = false;

  for (const m of machines) {
    const usedHosting = entries.filter((e) => (e.meta.account.machines ?? []).includes(m) && e.usedPct > 0);
    if (usedHosting.length === 0) continue;
    let start = Infinity;
    let maxWindowSec = 0;
    for (const e of usedHosting) {
      const w = e.window;
      if (!w || pastReset(w, now) || !w.resetsAt || !w.windowSec || w.kind === 'model') {
        return { covered: false, cost: 0, priced: true };
      }
      start = Math.min(start, w.resetsAt - w.windowSec);
      maxWindowSec = Math.max(maxWindowSec, w.windowSec);
    }
    if (cost.recent && cost.recentSince !== undefined && start >= cost.recentSince) {
      anyMeasurable = true;
      for (const s of cost.recent) {
        if (s.provider !== provider || s.machine !== m || s.at + SLOT_SEC / 2 <= start) continue;
        totalCost += s.cost;
        priced = priced && s.priced;
      }
    } else if (maxWindowSec >= 8 * 86400 && cost.rows && cost.days > 0) {
      const today = new Date(now * 1000);
      const startDay = dayOf(new Date(start * 1000));
      const oldestDay = lastDays(cost.days, today)[0];
      if (startDay < oldestDay) return { covered: false, cost: 0, priced: true };
      anyMeasurable = true;
      for (const r of cost.rows) {
        if (r.provider !== provider || r.machine !== m || r.day < startDay) continue;
        totalCost += r.cost;
        priced = priced && r.priced;
      }
    } else {
      return { covered: false, cost: 0, priced: true };
    }
  }
  return { covered: anyMeasurable, cost: totalCost, priced };
}

/** Partitions subscription entries into connected components by shared machines
 * so disjoint accounts measure their own API capacity directly while co-hosted
 * accounts share deduplicated machine logs without double-counting. */
function machineComponents(entries: CycleEntry[]): CycleEntry[][] {
  const n = entries.length;
  const visited = new Uint8Array(n);
  const machineSets = entries.map((e) => new Set(e.meta.account.machines ?? []));
  const sharesMachine = (i: number, j: number) => {
    for (const m of machineSets[i]) if (machineSets[j].has(m)) return true;
    return false;
  };
  const comps: CycleEntry[][] = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    visited[i] = 1;
    const queue = [i];
    const comp: CycleEntry[] = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      comp.push(entries[cur]);
      for (let j = 0; j < n; j++) {
        if (!visited[j] && sharesMachine(cur, j)) {
          visited[j] = 1;
          queue.push(j);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

interface CycleEvaluation {
  summary: MergedQuotaSummary;
  /** Subscription-only merged percentage (without hybrid extra USD credits),
   * used to keep per-window status bar buckets consistent with empirical weights. */
  subOnlyUsedPct?: number;
}

/** Evaluates one cycle (a comparable duration bucket such as 5h/7d, or a
 * tightest-window fallback) across all members of a provider. */
function evaluateCycle(
  provider: string,
  metas: MemberMeta[],
  subEntries: CycleEntry[],
  hasKnownTier: boolean,
  sampleWindow: UsageWindow | undefined,
  cost: CostReport | undefined,
  now: number,
): CycleEvaluation {
  let explicitCap = 0;
  let explicitAvail = 0;
  let explicitUsed = 0;
  let hasPrepaid = false;
  let prepaidAvail = 0;
  for (const m of metas) {
    if ((m.explicit.capacityUsd ?? 0) > 0) {
      explicitCap += m.explicit.capacityUsd!;
      explicitAvail += m.explicit.availableUsd!;
      explicitUsed += m.explicit.usedUsd!;
    }
    if (m.explicit.prepaidUsd !== undefined) {
      hasPrepaid = true;
      prepaidAvail += m.explicit.prepaidUsd;
    }
  }

  // Earliest upcoming reset among active windows contributing to this cycle.
  const activeResets = subEntries.map((e) => e.window).filter((w): w is UsageWindow => !!w && !pastReset(w, now) && !!w.resetsAt);
  const usedResets = activeResets.filter((w) => w.usedPct > 0);
  const resetSource = usedResets.length ? usedResets : activeResets;
  const resetsAt = resetSource.length ? Math.min(...resetSource.map((w) => w.resetsAt!)) : undefined;

  // Case 1: Pure explicit USD credits / prepaid balances (no subscription windows).
  if (subEntries.length === 0) {
    if (explicitCap > 0) {
      const totalCap = explicitCap + Math.max(0, prepaidAvail);
      const totalAvail = explicitAvail + Math.max(0, prepaidAvail);
      const totalUsed = Math.max(0, totalCap - totalAvail);
      const usedPct = clampPct((totalUsed / totalCap) * 100);
      return {
        summary: {
          usedPct,
          remainingPct: clampPct(100 - usedPct),
          capacityUsd: round2(totalCap),
          availableUsd: round2(totalAvail),
          usedUsd: round2(totalUsed),
          weighting: 'explicit',
          resetsAt,
        },
      };
    }
    return {
      summary: {
        availableUsd: hasPrepaid ? round2(prepaidAvail) : undefined,
        weighting: hasPrepaid ? 'explicit' : 'equal',
        resetsAt,
      },
    };
  }

  // Partition subscription accounts by shared machines and gather observed API spend.
  const comps = machineComponents(subEntries).map((entries) => {
    const totalWeight = entries.reduce((s, e) => s + e.meta.priorWeight, 0);
    const usedWeight = entries.reduce((s, e) => s + e.meta.priorWeight * (e.usedPct / 100), 0);
    const activeWeight = entries.reduce((s, e) => s + (e.usedPct > 0 ? e.meta.priorWeight : 0), 0);
    const usedFraction = totalWeight > 0 ? usedWeight / totalWeight : 0;
    // Measure signal strength against the weights of accounts with usedPct > 0
    // so an unused (0%) large-tier sibling on the same host does not suppress
    // calibration from an actively used smaller-tier account.
    const activeFraction = activeWeight > 0 ? usedWeight / activeWeight : 0;
    const spend = componentCycleSpend(cost, provider, entries, now);
    // When an account hit 100% and spilled into enabled extra USD usage, those
    // requests are already in local logs; deduct them from subscription spend.
    const extraOverlap = entries.reduce((s, e) => s + (e.usedPct >= 100 ? (e.meta.explicit.usedUsd ?? 0) : 0), 0);
    const subSpend = spend.covered ? Math.max(0, spend.cost - extraOverlap) : 0;
    const reliable = spend.covered && subSpend > 0 && activeFraction >= MIN_EXTRAPOLATE_FRACTION;
    const obsCap = reliable && usedFraction > 0 ? subSpend / usedFraction : undefined;
    const obsUnit = reliable && usedWeight > 0 ? subSpend / usedWeight : undefined;
    const allKnownPlan = entries.every((e) => e.meta.tierWeight !== undefined);
    return { entries, totalWeight, usedWeight, usedFraction, spend, subSpend, reliable, obsCap, obsUnit, allKnownPlan };
  });

  // Incomplete-log guard when plan tiers are known across multiple disjoint hosts:
  // a host recording far less API spend per tier unit than a sibling is missing
  // off-host/web usage and should be calibrated from the complete sibling's rate.
  if (hasKnownTier) {
    const knownReliable = comps.filter((c) => c.reliable && c.allKnownPlan && c.obsUnit !== undefined);
    if (knownReliable.length >= 2) {
      const maxUnit = Math.max(...knownReliable.map((c) => c.obsUnit!));
      for (const c of knownReliable) {
        if (c.obsUnit! < INCOMPLETE_LOG_RATIO * maxUnit) c.reliable = false;
      }
    }
  }

  const reliableComps = comps.filter((c) => c.reliable);

  // Branch A: Calibrated from real observed API-priced logs for this cycle!
  if (reliableComps.length > 0) {
    const pooledUsedW = reliableComps.reduce((s, c) => s + c.usedWeight, 0);
    const pooledSpend = reliableComps.reduce((s, c) => s + c.subSpend, 0);
    const pooledUnit = pooledUsedW > 0 ? pooledSpend / pooledUsedW : 0;
    let subCap = 0;
    let subUsed = 0;
    let subAvail = 0;
    let allPriced = true;
    for (const c of comps) {
      if (c.reliable && c.obsCap !== undefined) {
        subCap += c.obsCap;
        subUsed += c.subSpend;
        subAvail += Math.max(0, c.obsCap - c.subSpend);
        allPriced = allPriced && c.spend.priced;
      } else {
        const cap = c.totalWeight * pooledUnit;
        const used = cap * c.usedFraction;
        subCap += cap;
        subUsed += used;
        subAvail += Math.max(0, cap - used);
      }
    }
    const subOnlyUsedPct = subCap > 0 ? clampPct((subUsed / subCap) * 100) : 0;
    const totalCap = subCap + explicitCap + Math.max(0, prepaidAvail);
    const totalAvail = subAvail + explicitAvail + Math.max(0, prepaidAvail);
    const totalUsed = Math.max(0, totalCap - totalAvail);
    const usedPct = totalCap > 0 ? clampPct((totalUsed / totalCap) * 100) : subOnlyUsedPct;
    return {
      subOnlyUsedPct,
      summary: {
        usedPct,
        remainingPct: clampPct(100 - usedPct),
        capacityUsd: round2(totalCap),
        availableUsd: round2(totalAvail),
        usedUsd: round2(totalUsed),
        weighting: 'api',
        window: sampleWindow,
        priced: allPriced,
        resetsAt,
      },
    };
  }

  // Branch B: No reliable empirical cycle spend yet — weight percentages by
  // true quota tier multipliers (or equal weight) without fabricating monthly
  // subscription retail fees as current-cycle equivalent API capacity.
  const totalW = subEntries.reduce((s, e) => s + e.meta.priorWeight, 0);
  const usedW = subEntries.reduce((s, e) => s + e.meta.priorWeight * e.usedPct, 0);
  const subOnlyUsedPct = totalW > 0 ? clampPct(usedW / totalW) : 0;
  const observedSubSpend = comps.reduce((s, c) => s + (c.spend.covered ? c.subSpend : 0), 0);
  const observedPriced = comps.every((c) => !c.spend.covered || c.spend.priced);

  let usedPct = subOnlyUsedPct;
  if (explicitCap > 0) {
    const baseUsd = PROVIDER_BASELINE_USD[provider.toLowerCase()] ?? 20;
    const subBlendCap = totalW * baseUsd;
    const blendCap = subBlendCap + explicitCap + Math.max(0, prepaidAvail);
    const blendAvail = subBlendCap * (1 - subOnlyUsedPct / 100) + explicitAvail + Math.max(0, prepaidAvail);
    usedPct = clampPct(((blendCap - blendAvail) / blendCap) * 100);
  }
  const spentSoFar = observedSubSpend + explicitUsed;
  return {
    subOnlyUsedPct,
    summary: {
      usedPct,
      remainingPct: clampPct(100 - usedPct),
      usedUsd: spentSoFar > 0 ? round2(spentSoFar) : undefined,
      weighting: hasKnownTier ? 'tier' : explicitCap > 0 ? 'explicit' : 'equal',
      window: sampleWindow,
      priced: observedSubSpend > 0 ? observedPriced : undefined,
      resetsAt,
    },
  };
}

/** Matches a primary subscription window to a standard comparable cycle key. */
function cycleKeyOf(w: UsageWindow): CycleKey | undefined {
  if (is5hWindow(w)) return '5h';
  if (is7dWindow(w)) return '7d';
  if (w.kind === 'monthly' && !isExtraCreditWindow(w)) return '30d';
  return undefined;
}

/** Representative unlabelled cycle window metadata for UI labels (5 hours,
 * Weekly, Monthly). */
function cycleSampleWindow(ck: CycleKey, sample: UsageWindow): UsageWindow {
  if (ck === '5h') return { kind: 'session', usedPct: 0, windowSec: sample.windowSec || 18000 };
  if (ck === '7d') return { kind: 'weekly', usedPct: 0, windowSec: sample.windowSec || 604800 };
  return { kind: 'monthly', usedPct: 0, windowSec: sample.windowSec || 30 * 86400 };
}

/** Merges 2+ accounts of a provider into one aggregated summary. Accounts are
 * combined over comparable cycles (5h / 7d / 30d) using true quota tier
 * multipliers and, when `cost` provides local API-priced logs, empirical
 * current-cycle equivalent API capacity and used spend (deduplicated per
 * machine). Returns undefined when fewer than 2 accounts are present. */
export function mergeProviderAccounts(
  accounts: UsageAccount[],
  provider: string,
  now = Date.now() / 1000,
  cost?: CostReport,
): MergedUsageAccount | undefined {
  const matching = accounts.filter((a) => a.provider === provider);
  if (matching.length < 2) return undefined;
  const members = sortAccounts(matching, now);

  const metas: MemberMeta[] = members.map((account) => {
    const explicit = explicitMoneyOf(account);
    const hasExplicitCap = (explicit.capacityUsd ?? 0) > 0;
    const subWindows = subWindowsOf(account, hasExplicitCap);
    const tierWeight = subWindows.length > 0 ? estimatePlanWeight(account.provider, account.plan) : undefined;
    return { account, explicit, subWindows, tierWeight, priorWeight: tierWeight ?? 1 };
  });

  const subMetas = metas.filter((m) => m.subWindows.length > 0);
  const hasKnownTier = subMetas.some((m) => m.tierWeight !== undefined);

  // Evaluate comparable standard cycles (5h, 7d, 30d) shared by all subscription
  // accounts so we compare apples to apples instead of mixing 5h with 7d.
  const cycleResults = new Map<CycleKey, CycleEvaluation>();
  if (subMetas.length > 0) {
    const order: CycleKey[] = ['7d', '5h', '30d'];
    for (const ck of order) {
      const perMember = subMetas.map((m) => m.subWindows.filter((w) => cycleKeyOf(w) === ck));
      if (!perMember.every((ws) => ws.length > 0)) continue;
      const anyActive = perMember.some((ws) => ws.some((w) => !pastReset(w, now)));
      if (!anyActive) continue;
      let sample: UsageWindow | undefined;
      const entries: CycleEntry[] = subMetas.map((m, i) => {
        const ws = perMember[i];
        const active = ws.filter((w) => !pastReset(w, now));
        if (active.length > 0) {
          const tight = active.reduce((b, w) => (w.usedPct > b.usedPct ? w : b));
          if (!sample) sample = tight;
          return { meta: m, window: tight, usedPct: clampPct(tight.usedPct) };
        }
        if (!sample) sample = ws[0];
        // Past reset while a sibling still has an active window: replenished (0%).
        return { meta: m, usedPct: 0 };
      });
      cycleResults.set(ck, evaluateCycle(provider, metas, entries, hasKnownTier, cycleSampleWindow(ck, sample!), cost, now));
    }
  }

  // Pick the tightest comparable cycle; when accounts do not share a common
  // standard cycle (e.g. Antigravity LS model-only windows or mixed LS/CLI),
  // fall back to each account's tightest primary window.
  let chosen: CycleEvaluation;
  if (cycleResults.size > 0) {
    let best: CycleEvaluation | undefined;
    for (const ev of cycleResults.values()) {
      if (!best || (ev.summary.usedPct ?? -1) > (best.summary.usedPct ?? -1)) best = ev;
    }
    chosen = best!;
  } else {
    const anyActiveSub = subMetas.some((m) => m.subWindows.some((w) => !pastReset(w, now)));
    const entries: CycleEntry[] = [];
    for (const m of subMetas) {
      const active = m.subWindows.filter((w) => !pastReset(w, now));
      if (active.length > 0) {
        const tight = active.reduce((b, w) => (w.usedPct > b.usedPct ? w : b));
        entries.push({ meta: m, window: tight, usedPct: clampPct(tight.usedPct) });
      } else if (anyActiveSub) {
        entries.push({ meta: m, usedPct: 0 });
      }
    }
    chosen = evaluateCycle(provider, metas, entries, hasKnownTier, undefined, cost, now);
  }

  // Per-window buckets weighted by each account's subscription tier weight (or
  // empirical cycle weight when all subscription accounts share that cycle) for
  // status bar 5h / 7d / model-specific views.
  const buckets = new Map<string, { sample: UsageWindow; items: { w: UsageWindow; weight: number }[] }>();
  metas.forEach((m) => {
    const weight = hasKnownTier ? m.priorWeight : 1;
    for (const w of m.account.windows ?? []) {
      const k = `${w.kind}\0${w.label ?? ''}\0${w.windowSec ?? 0}`;
      const b = buckets.get(k);
      if (b) b.items.push({ w, weight });
      else buckets.set(k, { sample: w, items: [{ w, weight }] });
    }
  });

  const isPrimaryBucket = (w: UsageWindow) =>
    provider !== 'antigravity' || GEMINI_LABEL.test(w.label ?? '') || !ANTIGRAVITY_THIRD_PARTY_LABEL.test(w.label ?? '');

  const windows: UsageWindow[] = [];
  for (const { sample, items } of buckets.values()) {
    const active = items.filter(({ w }) => !pastReset(w, now));
    const totalW = items.reduce((s, x) => s + x.weight, 0);
    if (active.length > 0) {
      const ck = isPrimaryBucket(sample) ? cycleKeyOf(sample) : undefined;
      const cyclePct = ck && items.length === subMetas.length ? cycleResults.get(ck)?.subOnlyUsedPct : undefined;
      // Past-reset entries have replenished (0% used) while active entries carry current usage.
      const weightedUsed = items.reduce((sum, { w, weight }) => sum + weight * (pastReset(w, now) ? 0 : w.usedPct), 0);
      const usedPct = cyclePct !== undefined ? cyclePct : totalW > 0 ? clampPct(weightedUsed / totalW) : 0;
      const usedActive = active.filter(({ w }) => w.usedPct > 0 && w.resetsAt);
      const resetPool = usedActive.length ? usedActive : active.filter(({ w }) => w.resetsAt);
      const resetsAt = resetPool.length ? Math.min(...resetPool.map(({ w }) => w.resetsAt!)) : undefined;
      windows.push({
        id: sample.id,
        kind: sample.kind,
        label: sample.label,
        usedPct,
        resetsAt,
        windowSec: sample.windowSec,
      });
    } else {
      const weightedUsed = items.reduce((sum, { w, weight }) => sum + weight * w.usedPct, 0);
      const usedPct = totalW > 0 ? clampPct(weightedUsed / totalW) : 0;
      const resets = items.map(({ w }) => w.resetsAt).filter((r): r is number => !!r);
      windows.push({
        id: sample.id,
        kind: sample.kind,
        label: sample.label,
        usedPct,
        resetsAt: resets.length ? Math.max(...resets) : undefined,
        windowSec: sample.windowSec,
      });
    }
  }

  const status = members.reduce<UsageAccount['status']>(
    (best, a) => (statusPriority[a.status] < statusPriority[best] ? a.status : best),
    members[0].status,
  );
  const machines = [...new Set(members.flatMap((a) => a.machines ?? []))].sort();
  const fetchedAt = members.reduce((m, a) => Math.max(m, a.fetchedAt ?? 0), 0) || undefined;
  const seenAt = members.reduce((m, a) => Math.max(m, a.seenAt), 0);

  return {
    key: `${provider}:merged`,
    provider,
    status,
    windows,
    machines,
    fetchedAt,
    seenAt,
    accountCount: members.length,
    members,
    summary: chosen.summary,
  };
}

/** Preview account list: replaces 2+ accounts of ANY provider with their
 * merged summary so tiles, overview, status bar and hover previews reflect
 * combined capacity across all accounts of each provider. */
export function previewAccounts(
  accounts: UsageAccount[],
  now = Date.now() / 1000,
  cost?: CostReport,
): (UsageAccount | MergedUsageAccount)[] {
  const byProvider = new Map<string, UsageAccount[]>();
  for (const a of accounts) {
    const list = byProvider.get(a.provider);
    if (list) list.push(a);
    else byProvider.set(a.provider, [a]);
  }
  const out: (UsageAccount | MergedUsageAccount)[] = [];
  for (const [provider, list] of byProvider) {
    const merged = list.length >= 2 ? mergeProviderAccounts(list, provider, now, cost) : undefined;
    if (merged) out.push(merged);
    else out.push(...list);
  }
  return sortAccounts(out, now);
}

/** Whether w is a 5-hour / session rate-limit window. */
export function is5hWindow(w: UsageWindow): boolean {
  return w.kind === 'session' || w.windowSec === 18000;
}

/** Whether w is a 7-day / weekly rate-limit window. */
export function is7dWindow(w: UsageWindow): boolean {
  return w.kind === 'weekly' || w.windowSec === 604800;
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

/** Whether an Antigravity window specifically applies to `model`: handles both
 * per-model labels (including parenthetical variants like "Gemini 3 Pro (High)")
 * and agy CLI group labels ("Gemini Models" vs "Claude and GPT"). */
function antigravityWindowMatches(w: UsageWindow, model: string): boolean {
  if (w.kind === 'model') {
    if (!w.label) return false;
    if (bare(model).includes(bare(w.label))) return true;
    const stripped = w.label.replace(/\s*\([^)]*\)/g, '').trim();
    return !!stripped && bare(model).includes(bare(stripped));
  }
  if (!w.label) return true;
  if (ANTIGRAVITY_THIRD_PARTY_LABEL.test(model)) return ANTIGRAVITY_THIRD_PARTY_LABEL.test(w.label);
  if (GEMINI_LABEL.test(model)) return GEMINI_LABEL.test(w.label);
  return !ANTIGRAVITY_THIRD_PARTY_LABEL.test(w.label);
}

/** Formatted monetary value summary for a merged multi-account provider
 * (used in tiles, overview row, provider detail bar, and status bar hover). */
export function mergedValueText(a: MergedUsageAccount, remaining: boolean): string | undefined {
  const { summary } = a;
  if (summary.capacityUsd !== undefined && summary.availableUsd !== undefined) {
    return remaining
      ? t('usage.merged.valueLeft', { avail: money(summary.availableUsd), total: money(summary.capacityUsd) })
      : t('usage.merged.valueUsed', { used: money(summary.usedUsd ?? 0), total: money(summary.capacityUsd) });
  }
  if (summary.usedUsd !== undefined && summary.usedUsd > 0) {
    return t('usage.merged.spentSoFar', { used: money(summary.usedUsd) });
  }
  if (summary.availableUsd !== undefined) return t('usage.merged.balance', { avail: money(summary.availableUsd) });
  return undefined;
}

/** Whether a window is a synthesized combined multi-account summary entry. */
export const SUMMARY_WINDOW_ID = '__merged_summary__';

/** Picks the primary (and for 'both', secondary) active window(s) of an
 * account according to mode and optional model. For merged multi-account
 * summaries in 'auto' mode (when not filtering to a focused agent's model),
 * reports the combined summary so the status bar matches tiles, overview,
 * hover preview and detail summary bar; explicit 5h/7d/both modes and
 * model-filtered agent panes use the weighted per-window buckets. For
 * Antigravity, summary and unmatched lookups stay on the primary Gemini pool
 * rather than third-party Claude/GPT quotas. */
export function pickAccountWindows(
  a: UsageAccount,
  mode: StatusBarWindowMode = 'auto',
  model?: string,
  now = Date.now() / 1000,
  filterByModel = false,
): { primary: UsageWindow; secondary?: UsageWindow; matched: boolean } | undefined {
  if (isMergedAccount(a) && mode === 'auto' && !filterByModel && a.summary.usedPct !== undefined) {
    return {
      primary: {
        id: SUMMARY_WINDOW_ID,
        kind: a.summary.window?.kind ?? 'monthly',
        windowSec: a.summary.window?.windowSec,
        usedPct: a.summary.usedPct,
        resetsAt: a.summary.resetsAt,
      },
      matched: true,
    };
  }
  const primaryActive = primaryWindowsOf(a).filter((w) => !pastReset(w, now));
  const allActive = (a.windows ?? []).filter((w) => !pastReset(w, now));
  let pool: UsageWindow[];
  if (filterByModel && a.provider === 'antigravity') {
    if (model) {
      const exact = allActive.filter((w) => antigravityWindowMatches(w, model));
      if (exact.length > 0) {
        pool = exact;
      } else if (ANTIGRAVITY_THIRD_PARTY_LABEL.test(model)) {
        const third = allActive.filter((w) => ANTIGRAVITY_THIRD_PARTY_LABEL.test(w.label ?? ''));
        pool = third.length ? third : primaryActive;
      } else {
        pool = primaryActive;
      }
    } else {
      pool = primaryActive;
    }
  } else if (filterByModel) {
    const filtered = allActive.filter((w) => windowApplies(w, model));
    pool = filtered.length ? filtered : allActive;
  } else {
    pool = primaryActive;
  }
  if (!pool.length) {
    // Pure USD-credit accounts (or merged credit-only accounts) without rate-limit windows.
    const usedPct = accountUsedPct(a, now);
    if (usedPct === undefined) return undefined;
    const synthetic: UsageWindow = {
      id: isMergedAccount(a) ? SUMMARY_WINDOW_ID : undefined,
      kind: 'monthly',
      usedPct,
      resetsAt: isMergedAccount(a) ? a.summary.resetsAt : undefined,
    };
    return { primary: synthetic, matched: mode === 'auto' };
  }
  const maxOf = (ws: UsageWindow[]) => ws.reduce<UsageWindow | undefined>((b, w) => (!b || w.usedPct > b.usedPct ? w : b), undefined);
  const tight = maxOf(pool)!;
  if (mode === 'auto') return { primary: tight, matched: true };
  const w5 = maxOf(pool.filter(is5hWindow));
  const w7 = maxOf(pool.filter(is7dWindow));
  if (mode === '5h') return w5 ? { primary: w5, matched: true } : { primary: tight, matched: false };
  if (mode === '7d') return w7 ? { primary: w7, matched: true } : { primary: tight, matched: false };
  if (w5 && w7) return { primary: w5, secondary: w7, matched: true };
  if (w5 || w7) return { primary: (w5 ?? w7)!, matched: true };
  return { primary: tight, matched: false };
}

/** The tightest window that counts what the coding agent in the focused
 * pane does: of its service's accounts read on its machine (any of the
 * service's when none was), those of its model among the windows of
 * models (falling back to primary windows when the service reports model
 * windows only); merges 2+ accounts of any provider. */
export function tightestFor(
  s: UsageSnapshot | undefined,
  provider: string,
  m: string,
  model?: string,
  now = Date.now() / 1000,
  cost?: CostReport,
): { account: UsageAccount; window: UsageWindow } | undefined {
  const all = (s?.accounts ?? []).filter((a) => a.provider === provider);
  const here = all.filter((a) => (a.machines ?? []).includes(m));
  const raw = here.length ? here : all;
  const merged = mergeProviderAccounts(raw, provider, now, cost);
  const pool = merged ? [merged] : raw;
  let best: { account: UsageAccount; window: UsageWindow } | undefined;
  for (const a of pool) {
    const picked = pickAccountWindows(a, 'auto', model, now, true);
    if (!picked) continue;
    if (!best || picked.primary.usedPct > best.window.usedPct) best = { account: a, window: picked.primary };
  }
  return best;
}

/** Resolves what the status bar displays given the optional focused agent,
 * configured default provider, and window display mode. */
export function statusBarSelection(
  s: UsageSnapshot | undefined,
  opts: {
    agent?: { provider: string; m: string; model?: string };
    defaultProvider?: StatusBarProvider;
    windowMode?: StatusBarWindowMode;
    machineId?: string;
    now?: number;
    cost?: CostReport;
  } = {},
): { account: UsageAccount | MergedUsageAccount; primary: UsageWindow; secondary?: UsageWindow; showLogo: boolean } | undefined {
  const now = opts.now ?? Date.now() / 1000;
  const mode = opts.windowMode ?? 'auto';
  const pickFrom = (list: (UsageAccount | MergedUsageAccount)[], model?: string, filterByModel = false) => {
    let bestMatched:
      { account: UsageAccount | MergedUsageAccount; primary: UsageWindow; secondary?: UsageWindow; score: number } | undefined;
    let bestAny: { account: UsageAccount | MergedUsageAccount; primary: UsageWindow; secondary?: UsageWindow; score: number } | undefined;
    for (const a of list) {
      const p = pickAccountWindows(a, mode, model, now, filterByModel);
      if (!p) continue;
      const score = Math.max(p.primary.usedPct, p.secondary?.usedPct ?? -1);
      const cand = { account: a, primary: p.primary, secondary: p.secondary, score };
      if (!bestAny || cand.score > bestAny.score) bestAny = cand;
      if (p.matched && (!bestMatched || cand.score > bestMatched.score)) bestMatched = cand;
    }
    return bestMatched ?? bestAny;
  };
  const poolFor = (provider: string, machine?: string) => {
    const all = (s?.accounts ?? []).filter((a) => a.provider === provider);
    const here = machine ? all.filter((a) => (a.machines ?? []).includes(machine)) : [];
    const raw = here.length ? here : all;
    const merged = mergeProviderAccounts(raw, provider, now, opts.cost);
    return merged ? [merged] : raw;
  };
  if (opts.agent) {
    const hit = pickFrom(poolFor(opts.agent.provider, opts.agent.m), opts.agent.model, true);
    if (hit) return { account: hit.account, primary: hit.primary, secondary: hit.secondary, showLogo: true };
  }
  if (opts.defaultProvider && opts.defaultProvider !== 'auto') {
    const hit = pickFrom(poolFor(opts.defaultProvider, opts.machineId));
    if (hit) return { account: hit.account, primary: hit.primary, secondary: hit.secondary, showLogo: true };
  }
  const hit = pickFrom(previewAccounts(s?.accounts ?? [], now, opts.cost));
  return hit ? { account: hit.account, primary: hit.primary, secondary: hit.secondary, showLogo: false } : undefined;
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

/** The tightest window of all accounts (merging multi-account providers
 * using their cycle-consistent summary), for the status bar. */
export function tightest(
  s: UsageSnapshot | undefined,
  now = Date.now() / 1000,
  cost?: CostReport,
): { account: UsageAccount; window: UsageWindow } | undefined {
  for (const a of previewAccounts(s?.accounts ?? [], now, cost)) {
    if (isMergedAccount(a) && a.summary.usedPct !== undefined) {
      return {
        account: a,
        window: {
          id: SUMMARY_WINDOW_ID,
          kind: a.summary.window?.kind ?? 'monthly',
          windowSec: a.summary.window?.windowSec,
          usedPct: a.summary.usedPct,
          resetsAt: a.summary.resetsAt,
        },
      };
    }
    const w = tightestWindow(a, now);
    if (w) return { account: a, window: w };
    const pct = accountUsedPct(a, now);
    if (pct !== undefined) {
      return { account: a, window: { kind: 'monthly', usedPct: pct } };
    }
  }
  return undefined;
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

/** A session's usage from the hub's answer: numbers that are not finite
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
