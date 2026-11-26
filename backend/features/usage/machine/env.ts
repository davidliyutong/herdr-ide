// What the AI usage feature's machine side reads a machine with: its home
// and data directory, the agent's environment, the providers' endpoints,
// the time limits, and what the agent remembers between requests (Memo).
// Also the accounts' types as the Go agent writes them, and the lenient
// readers of the providers' JSON (numbers that may be strings, times that
// may be RFC 3339 or Unix seconds or milliseconds).
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

/** The providers, in the order the UIs list them. OpenCode has spend
 * only: it is a client of many providers without a quota of its own. */
export const PROVIDERS = ['claude', 'codex', 'grok', 'antigravity', 'kimi', 'deepseek', 'opencode'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** The providers' endpoints: the only hosts the limits are asked of,
 * besides Antigravity's language server on 127.0.0.1. kimiToken renews
 * Kimi Code's sign-in. Tests point them at fake servers. */
export interface Urls {
  claudeUsage: string;
  claudeProfile: string;
  codexUsage: string;
  grokBilling: string;
  grokSettings: string;
  kimiUsage: string;
  kimiToken: string;
  deepseekBalance: string;
}

export const DEFAULT_URLS: Urls = {
  claudeUsage: 'https://api.anthropic.com/api/oauth/usage',
  claudeProfile: 'https://api.anthropic.com/api/oauth/profile',
  codexUsage: 'https://chatgpt.com/backend-api/wham/usage',
  grokBilling: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  grokSettings: 'https://cli-chat-proxy.grok.com/v1/settings',
  kimiUsage: 'https://api.kimi.com/coding/v1/usages',
  kimiToken: 'https://auth.kimi.com/api/oauth/token',
  deepseekBalance: 'https://api.deepseek.com/user/balance',
};

/** The time limits and paces, in ms (tests shorten them). */
export interface UsageTiming {
  /** One request to a provider. */
  requestMs: number;
  /** One limits action (the providers in parallel). */
  limitsMs: number;
  /** How long one hub's limits answer another hub's same request. */
  limitsShareMs: number;
  /** One cost scan (the hub waits 2 minutes). */
  costMs: number;
  /** One session action (the hub waits 30 s). */
  sessionMs: number;
  /** The keychain's security(1). */
  keychainMs: number;
  /** ps and lsof. */
  psMs: number;
  /** agy, and how long its answer (with numbers, or a failure) stands. */
  agyMs: number;
  agyEveryMs: number;
  agyBackoffMs: number;
  /** Kimi Code's lock: how long a held one is waited for, how often it is
   * tried, how often the one held here is touched, when it is stale by
   * Kimi Code's rule and when it is taken over here. */
  kimiLockWaitMs: number;
  kimiLockRetryMs: number;
  kimiLockUpdateMs: number;
  kimiLockStaleMs: number;
  kimiLockAbandonedMs: number;
  /** The wait before the refresh's attempt n+1 is kimiBackoffMs × 2^n. */
  kimiBackoffMs: number;
  /** A long scan saves what it read this often; a scan that changed the
   * cache writes it when its last save is this old, or it read this many
   * bytes of logs. */
  costSaveEveryMs: number;
  costPersistEveryMs: number;
  costPersistBytes: number;
}

export const USAGE_TIMING: UsageTiming = {
  requestMs: 15_000,
  limitsMs: 45_000,
  limitsShareMs: 60_000,
  costMs: 150_000,
  sessionMs: 40_000,
  keychainMs: 10_000,
  psMs: 5000,
  agyMs: 20_000,
  agyEveryMs: 10 * 60_000,
  agyBackoffMs: 30 * 60_000,
  kimiLockWaitMs: 8000,
  kimiLockRetryMs: 500,
  kimiLockUpdateMs: 2500,
  kimiLockStaleMs: 5000,
  kimiLockAbandonedMs: 30_000,
  kimiBackoffMs: 1000,
  costSaveEveryMs: 20_000,
  costPersistEveryMs: 5 * 60_000,
  costPersistBytes: 8 << 20,
};

/** The programs the limits run: the keychain's, and the process and
 * socket listers that find Antigravity's language server; and where agy
 * is looked for besides the PATH and the home's bin directories: where
 * installers put programs that a login shell would add. */
export interface Programs {
  security: string;
  ps: string;
  lsof: string;
  extraPath: string[];
}

export const DEFAULT_PROGRAMS: Programs = {
  security: '/usr/bin/security',
  ps: '/bin/ps',
  lsof: '/usr/sbin/lsof',
  extraPath: ['/usr/local/bin', '/opt/homebrew/bin'],
};

/** The machine as the readers see it. */
export interface UsageEnv {
  home: string;
  /** The agent's data directory (~/.<slug>[-<instance>]): the DeepSeek key
   * file is below it, the cost cache in its machine database. */
  base: string;
  /** The agent's environment. */
  env: Record<string, string>;
  platform: NodeJS.Platform;
  /** The agent's user: only its own language servers are asked. */
  uid: number;
  /** The time, in ms since the epoch. */
  now(): number;
  urls: Urls;
  t: UsageTiming;
  programs: Programs;
  /** /proc on Linux (tests point it at a fixture). */
  procRoot: string;
  memo: Memo;
  /** Ends the request. */
  signal: AbortSignal;
}

/** What the agent keeps between requests, which is costly to get again:
 * agy's answer (seconds of CPU and a few hundred MB per run), what each
 * Codex home's newest session log said, the Kimi Code credential files
 * whose refresh token the provider refused (not tried again until the file
 * changes), the last Antigravity language server that answered; and the
 * one Kimi Code renewal running at a time. */
export class Memo {
  readonly agy = new Map<string, { a: Account; at: number; stamp: string }>();
  readonly codexLog = new Map<string, { path: string; size: number; mtime: number; a: Account | null }>();
  readonly kimiRefused = new Map<string, string>();
  antigravityLS: { endpoints: { port: number; csrf: string; scheme: 'https' | 'http' }[]; stamp: string; at: number } | null = null;
  private renewal: Promise<unknown> = Promise.resolve();

  /** Runs f after the renewal before it ended. */
  oneRenewal<T>(f: () => Promise<T>): Promise<T> {
    const p = this.renewal.then(f, f);
    this.renewal = p.catch(() => {});
    return p;
  }
}

/** One rate-limit window of an account: used 0–100, its reset (Unix
 * seconds) and length when known. */
export interface Window {
  kind: string;
  label?: string;
  usedPct: number;
  resetsAt?: number;
  windowSec?: number;
}

/** A provider's credits or extra usage (USD unless unit says else). */
export interface Credits {
  balance?: number;
  used?: number;
  limit?: number;
  unlimited?: boolean;
  enabled?: boolean;
  unit?: string;
}

/** A prepaid balance in one currency. */
export interface Balance {
  currency: string;
  total: number;
  granted?: number;
  toppedUp?: number;
}

/** What one provider says about one account on the machine. id tells it
 * apart across machines (the provider's account id, or a hash where that
 * is a secret); status is ok, stale, unauth, error (code says why),
 * missing or skipped; source is api, log, ls or cli. */
export interface Account {
  provider: string;
  id?: string;
  email?: string;
  plan?: string;
  windows?: Window[];
  credits?: Credits;
  balances?: Balance[];
  available?: boolean;
  status: string;
  code?: string;
  source?: string;
  asOf?: number;
  retryAfter?: number;
  home?: string;
}

/** Window kinds. */
export const SESSION = 'session';
export const WEEKLY = 'weekly';
export const MONTHLY = 'monthly';
export const MODEL = 'model';

/** A window as the Go agent writes it: no empty label, unknown reset or
 * length. */
export function win(kind: string, usedPct: number, resetsAt = 0, windowSec = 0, label = ''): Window {
  const w: Window = { kind, usedPct };
  if (label) w.label = label;
  if (resetsAt) w.resetsAt = resetsAt;
  if (windowSec) w.windowSec = windowSec;
  return w;
}

/** a as the Go agent writes it: members it leaves out when empty are left
 * out (a window's are, win). */
export function wire(a: Account): Account {
  const out: Account = { provider: a.provider, status: a.status };
  if (a.id) out.id = a.id;
  if (a.email) out.email = a.email;
  if (a.plan) out.plan = a.plan;
  if (a.windows?.length) out.windows = a.windows.map((w) => win(w.kind, w.usedPct, w.resetsAt, w.windowSec, w.label));
  if (a.credits) {
    const c: Credits = {};
    if (a.credits.balance !== undefined) c.balance = a.credits.balance;
    if (a.credits.used !== undefined) c.used = a.credits.used;
    if (a.credits.limit !== undefined) c.limit = a.credits.limit;
    if (a.credits.unlimited) c.unlimited = true;
    if (a.credits.enabled !== undefined) c.enabled = a.credits.enabled;
    if (a.credits.unit) c.unit = a.credits.unit;
    out.credits = c;
  }
  if (a.balances?.length)
    out.balances = a.balances.map((b) => ({
      currency: b.currency,
      total: b.total,
      ...(b.granted ? { granted: b.granted } : {}),
      ...(b.toppedUp ? { toppedUp: b.toppedUp } : {}),
    }));
  if (a.available !== undefined) out.available = a.available;
  if (a.code) out.code = a.code;
  if (a.source) out.source = a.source;
  if (a.asOf) out.asOf = a.asOf;
  if (a.retryAfter) out.retryAfter = a.retryAfter;
  if (a.home) out.home = a.home;
  return out;
}

/** A copy of a, its windows and balances its own. */
export const copyAccount = (a: Account): Account => ({
  ...a,
  windows: a.windows?.map((w) => ({ ...w })),
  balances: a.balances?.map((b) => ({ ...b })),
  credits: a.credits && { ...a.credits },
});

/** The answer for an account the hub already has: its identity only. */
export const skipped = (a: Account): Account => ({
  provider: a.provider,
  id: a.id,
  email: a.email,
  plan: a.plan,
  status: 'skipped',
  home: a.home,
});

/** What limits reads (the action's params). */
export interface LimitsOptions {
  providers?: string[];
  codexHomes?: string[];
  claudeKeychain?: boolean;
  /** Accounts (provider:id) the hub already has or holds back. */
  skip?: string[];
  /** This machine's accounts without an id the hub holds back: provider,
   * or provider:home for a Codex home other than the default. */
  skipLocal?: string[];
  kimiRefresh?: boolean;
  /** Manual refresh: bypasses short-lived machine caches (shared limits,
   * Antigravity LS/CLI memos, Codex log memo) so account switches show at
   * once. */
  force?: boolean;
}

/** Whether an account is not to be asked: by its id, or, for one without
 * an id, by provider and home. */
export function skips(o: LimitsOptions, provider: string, id = '', home = ''): boolean {
  if (id) return !!o.skip?.includes(`${provider}:${id}`);
  return !!o.skipLocal?.includes(home ? `${provider}:${home}` : provider);
}

/** A hash of an identifier that must not leave the machine as it is. */
export const hashId = (s: string): string => (s ? 'h' + createHash('sha256').update(s).digest('hex').slice(0, 16) : '');

/** p with "~" resolved and made absolute relative to the home directory. */
export function expand(home: string, p: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return posix.join(home, p.slice(2));
  return posix.isAbsolute(p) ? p : posix.join(home, p);
}

/** A variable of the agent's environment ("" when unset). */
export const getenv = (e: UsageEnv, k: string): string => e.env[k] ?? '';

/** The current time in Unix seconds. */
export const nowSec = (e: UsageEnv): number => Math.floor(e.now() / 1000);

type JSONObject = Record<string, unknown>;

/** v as an object, or {} (walking decoded JSON without failing). */
export const obj = (v: unknown): JSONObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JSONObject) : {});
/** Whether v is an object. */
export const isObj = (v: unknown): v is JSONObject => !!v && typeof v === 'object' && !Array.isArray(v);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The first of keys present (and not null) in m. */
export function first(m: JSONObject, ...keys: string[]): unknown {
  for (const k of keys) if (m[k] !== undefined && m[k] !== null) return m[k];
  return undefined;
}

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A JSON number, or a number in a string; undefined otherwise. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!DECIMAL.test(s)) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const TIME = /^(\d{4})-(\d{2})-(\d{2})([Tt ])(\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?/;

/** The Unix seconds of an RFC 3339 time (zone: with one, as RFC 3339
 * requires; without, a time with no zone and no fraction taken as UTC, at
 * the start of s); undefined when s is none. */
export function parseTime(s: string, zone: 'required' | 'optional'): number | undefined {
  const m = TIME.exec(s);
  if (!m) return undefined;
  if (m[9]) {
    if (m[4] === ' ' || m[0].length !== s.length) return undefined;
  } else if (zone === 'required' || m[8]) return undefined;
  let t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[5]!, +m[6]!, +m[7]!) / 1000;
  if (m[9] && m[9] !== 'Z' && m[9] !== 'z') t -= (m[9][0] === '-' ? -1 : 1) * (+m[9].slice(1, 3) * 3600 + +m[9].slice(4, 6) * 60);
  return Number.isFinite(t) ? t : undefined;
}

/** A time: RFC 3339 (or without a zone, as UTC), or Unix seconds or
 * milliseconds (also in a string); 0 when it is none. In Unix seconds. */
export function timeOf(v: unknown): number {
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return 0;
    const t = parseTime(s, 'required') ?? (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}$/.test(s) ? parseTime(s, 'optional') : undefined);
    if (t !== undefined) return t;
  }
  let f = num(v);
  if (f === undefined || f <= 0) return 0;
  if (f > 1e12) f /= 1000; // milliseconds
  return Math.floor(f);
}

/** A share used, 0–100, to two decimals. */
export function clampPct(p: number): number {
  if (Number.isNaN(p) || p < 0) return 0;
  if (p > 100) return 100;
  return Math.round(p * 100) / 100;
}

/** A JWT's claims, unchecked (only to read the account it names on the
 * machine it was issued to); null when it is none. */
export function jwtClaims(tok: string): JSONObject | null {
  const parts = tok.split('.');
  if (parts.length !== 3) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(parts[1]!.replace(/=+$/, ''), 'base64url').toString('utf8'));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** The first non-empty of s. */
export const firstNonEmpty = (...s: string[]): string => s.find((x) => x !== '') ?? '';

/** Waits ms, or until signal ends. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
