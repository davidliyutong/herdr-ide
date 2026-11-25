// The API prices the cost scan and a session's read apply: the table of
// spec/pricing/pricing.json (by provider and the longest model prefix,
// with long-prompt tiers and cache-write prices), and the user's own
// (usage.prices), which the core sends with each scan.
import table from '../../../../spec/pricing/pricing.json' with { type: 'json' };

/** A price tier, in USD per million tokens, for prompts of at most
 * inputMax tokens (null: any length). Cache writes cost the input price
 * (5 minutes) and twice it (1 hour) unless given. */
export interface Tier {
  inputMax: number | null;
  input: number;
  cached: number;
  output: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

/** A model's tiers. */
export interface ModelPrice {
  source: string;
  tiers: Tier[];
}

type Table = Record<string, Record<string, ModelPrice & { contextWindow?: number }>>;

const PROVIDERS = table.providers as unknown as Table;

/** The table's price of a model: the entry whose name is the longest
 * prefix of model; key "" when none is. */
export function modelPricing(provider: string, model: string): { key: string; price?: ModelPrice } {
  let key = '';
  let price: ModelPrice | undefined;
  for (const [k, v] of Object.entries(PROVIDERS[provider] ?? {})) {
    if (model.startsWith(k) && k.length > key.length) [key, price] = [k, v];
  }
  return { key, price };
}

/** modelPricing with the user's prices (own, by model name prefix, for
 * every provider): one of the same name as the table's entry replaces it,
 * and the longest prefix of the two lists wins, so a price the user gives
 * for a model the table does not know applies before a release adds it. */
export function pricingWith(provider: string, model: string, own?: Record<string, Tier>): { key: string; price?: ModelPrice } {
  let { key, price } = modelPricing(provider, model);
  for (const [k, t] of Object.entries(own ?? {})) {
    if (model.startsWith(k) && (k.length > key.length || k === key)) [key, price] = [k, { source: 'usage.prices', tiers: [t] }];
  }
  return { key, price };
}

/** The tier of a prompt of n tokens: the first whose inputMax is at least
 * n. */
export function tierOf(m: ModelPrice, n: number): Tier {
  return m.tiers.find((t) => t.inputMax === null || t.inputMax === undefined || n <= t.inputMax) ?? m.tiers[m.tiers.length - 1]!;
}

/** The price of tokens at t, in USD: input, cache reads, cache writes of 5
 * minutes and of an hour, output. */
export function tierCost(t: Tier, input: number, cached: number, cw5: number, cw1: number, output: number): number {
  const w5 = t.cacheWrite ?? t.input;
  const w1 = t.cacheWrite1h ?? 2 * t.input;
  return (input * t.input + cached * t.cached + cw5 * w5 + cw1 * w1 + output * t.output) / 1e6;
}

/** The most prices of the user's. */
export const MAX_OWN_PRICES = 50;
const OWN_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

/** Whether own are prices usage.prices can hold: at most 50, names as
 * the setting's, prices from 0 to 10000, of any prompt's length. The
 * agent refuses others, so a scan never prices with them. */
export function validPrices(own: Record<string, Tier> | undefined): boolean {
  const ok = (v: number) => Number.isFinite(v) && v >= 0 && v <= 10000;
  const e = Object.entries(own ?? {});
  if (e.length > MAX_OWN_PRICES) return false;
  return e.every(
    ([k, t]) =>
      OWN_MODEL.test(k) &&
      t.inputMax === null &&
      t.cacheWrite1h === undefined &&
      ok(t.input) &&
      ok(t.cached) &&
      ok(t.output) &&
      (t.cacheWrite === undefined || ok(t.cacheWrite)),
  );
}

/** The context window of a model as the table gives it (the longest
 * prefix of its name that has one), 0 when it gives none. */
export function contextWindow(provider: string, model: string): number {
  let best = '';
  let n = 0;
  for (const [k, v] of Object.entries(PROVIDERS[provider] ?? {})) {
    if (v.contextWindow && v.contextWindow > 0 && model.startsWith(k) && k.length > best.length) [best, n] = [k, v.contextWindow];
  }
  return n;
}

/** The tables of the providers whose APIs serve models the table prices,
 * for OpenCode's steps (by the provider that served them): their steps
 * cost what the CLIs' logs would, also signed in with a subscription,
 * which OpenCode records as free. */
export const OPENCODE_TABLES: Record<string, string> = { anthropic: 'claude', openai: 'codex', xai: 'grok', google: 'antigravity' };

/** The table of a model used in Antigravity: Anthropic's, OpenAI's and
 * xAI's models their own, Gemini's Antigravity's. */
export function antigravityTable(model: string): string {
  if (model.startsWith('claude-')) return 'claude';
  if (model.startsWith('gpt-')) return 'codex';
  if (model.startsWith('grok-')) return 'grok';
  return 'antigravity';
}
