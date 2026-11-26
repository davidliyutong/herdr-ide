// The AI usage feature's actions on a machine, as the machine side serves
// them (features/usage/machine): the machine reads the subscriptions its
// CLIs are signed in to and its logs' cost, and answers with numbers only.
//
//   - limits: the accounts with their windows, credits and balances; the
//     accounts named in skip / skipLocal are answered skipped, unasked;
//   - cost: the logs' tokens and cost by day, provider, model and project,
//     and the quarters of an hour from recentSince on; with ifNoneMatch the
//     report's etag, an unchanged scan answers notModified without rows;
//   - setDeepseekKey: writes (or with "" removes) the DeepSeek key file;
//   - session: what one session of a coding agent used, from its
//     transcripts.
//
// The results are read as the Go hub decoded them into its structs: a
// member that is absent or null is its zero value, members it does not
// know are dropped, and those Go writes with omitempty are left out when
// empty (undefined here), so that the hub writes them on as Go did.
import { z } from 'zod';
import { defineProtocol } from '#shared/proto/protocol.ts';

/** How long the hub waits for each action. */
export const LIMITS_MS = 60_000;
export const COST_MS = 120_000;
export const SESSION_MS = 30_000;

const zero = <T extends z.ZodType>(t: T, v: z.output<T>) => t.nullish().transform((x) => x ?? v);
const num = zero(z.number(), 0);
const text = zero(z.string(), '');
const flag = zero(z.boolean(), false);
/** omitempty: left out when absent or empty. */
const optNum = z
  .number()
  .nullish()
  .transform((v) => v || undefined);
const optText = z
  .string()
  .nullish()
  .transform((v) => v || undefined);
const optFlag = z
  .boolean()
  .nullish()
  .transform((v) => v || undefined);
const optList = <T extends z.ZodType>(t: T) =>
  z
    .array(t)
    .nullish()
    .transform((v) => (v?.length ? v : undefined));
/** A pointer: left out when absent, kept when zero. */
const ptr = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? undefined);

/** One rate-limit window of an account: used 0–100, its reset (Unix
 * seconds) and length when known. */
export const window = z.object({ kind: text, label: optText, usedPct: num, resetsAt: optNum, windowSec: optNum });
export type Window = z.output<typeof window>;

const credits = z.object({
  balance: ptr(z.number()),
  used: ptr(z.number()),
  limit: ptr(z.number()),
  unlimited: optFlag,
  enabled: ptr(z.boolean()),
  unit: optText,
});

const balance = z.object({ currency: text, total: num, granted: optNum, toppedUp: optNum });

/** What one provider says about one account on the machine: id tells it
 * apart across machines (none: nothing identifies it there); status is ok,
 * stale, unauth, error (code says why), missing or skipped. */
export const account = z.object({
  provider: text,
  id: optText,
  email: optText,
  plan: optText,
  windows: optList(window),
  credits: ptr(credits),
  balances: optList(balance),
  available: ptr(z.boolean()),
  status: text,
  code: optText,
  source: optText,
  asOf: optNum,
  retryAfter: optNum,
  home: optText,
});
export type Account = z.output<typeof account>;

/** A price of the user's (settings.ts Tier). */
const tier = z.object({
  inputMax: z.null(),
  input: z.number(),
  cached: z.number(),
  output: z.number(),
  cacheWrite: z.number().optional(),
});
const prices = z.record(z.string(), tier).optional();
const list = z.array(z.string()).optional();

/** What limits reads (members in Go's order: the agent shares an answer
 * between the hubs of a node whose params are the same bytes). */
export const limitsParams = z.object({
  providers: list,
  codexHomes: list,
  claudeKeychain: z.boolean().optional(),
  skip: list,
  skipLocal: list,
  kimiRefresh: z.boolean().optional(),
});
export type LimitsParams = z.input<typeof limitsParams>;

export const costParams = z.object({
  since: z.number(),
  tzOffset: z.number().optional(),
  codexHomes: list,
  providers: list,
  prices,
  recentSince: z.number().optional(),
  ifNoneMatch: z.string().optional(),
});
export type CostParams = z.output<typeof costParams>;

/** A day's tokens and cost of one model in one project. */
export const costRow = z.object({
  day: text,
  provider: text,
  model: text,
  project: optText,
  input: num,
  cached: num,
  cacheWrite: num,
  output: num,
  reasoning: optNum,
  requests: num,
  cost: num,
  priced: flag,
});
export type CostRow = z.output<typeof costRow>;

/** A provider's tokens and cost in a quarter of an hour from at. */
export const costSlot = z.object({ at: num, provider: text, tokens: num, requests: num, cost: num, priced: flag });
export type CostSlot = z.output<typeof costSlot>;

/** The cost of a machine's logs; failed are the logs it could not read
 * (provider:code). */
export const costReport = z.object({
  since: num,
  rows: zero(z.array(costRow), []),
  recent: optList(costSlot),
  failed: optList(z.string()),
  retries: optNum,
  unpriced: optList(z.string()),
  files: num,
  etag: optText,
  notModified: optFlag,
});
export type CostReport = z.output<typeof costReport>;

/** What a session of a coding agent used (agentproto.SessionUsage). */
export const sessionUsage = z.object({
  model: optText,
  input: num,
  cached: num,
  cacheWrite: num,
  output: num,
  reasoning: optNum,
  requests: num,
  cost: num,
  priced: flag,
  contextUsed: optNum,
  contextSize: optNum,
});

export const usageProtocol = defineProtocol('usage', {
  limits: { params: limitsParams, result: z.object({ accounts: zero(z.array(account), []) }), timeoutMs: LIMITS_MS },
  cost: { params: costParams, result: costReport, timeoutMs: COST_MS },
  setDeepseekKey: { params: z.object({ key: z.string() }), result: z.object({ set: optFlag }) },
  session: { params: z.object({ kind: z.string(), session: z.string(), prices }), result: sessionUsage, timeoutMs: SESSION_MS },
});
