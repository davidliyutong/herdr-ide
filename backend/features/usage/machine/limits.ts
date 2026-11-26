// The limits action: the accounts the machine's CLIs are signed in to,
// each provider asked in parallel, with their windows, credits and
// balances. Credentials are read from the CLIs' own files at each poll,
// sent only to their provider's fixed host, never returned, logged or
// written (Kimi Code's renewal, kimi.ts, writes its own file back as Kimi
// Code does); an expired token is not sent at all.
//
//   - Claude: ~/.claude/.credentials.json ($CLAUDE_CONFIG_DIR), or on macOS
//     the keychain item Claude Code keeps them in; /api/oauth/usage.
//   - Codex: auth.json of $CODEX_HOME or ~/.codex and of the homes the hub
//     names; /backend-api/wham/usage, else the newest session log's
//     rate limits.
//   - Grok: ~/.grok/auth.json; /v1/billing and /v1/settings.
//   - DeepSeek: the key file the panel writes, DEEPSEEK_API_KEY, or Claude
//     Code's settings when they point at DeepSeek; /user/balance.
//   - Kimi Code (kimi.ts) and Antigravity (antigravity.ts).
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { antigravityAccounts } from './antigravity.ts';
import {
  PROVIDERS,
  MODEL,
  MONTHLY,
  SESSION,
  WEEKLY,
  arr,
  clampPct,
  copyAccount,
  expand,
  first,
  firstNonEmpty,
  getenv,
  hashId,
  isObj,
  jwtClaims,
  nowSec,
  num,
  obj,
  skipped,
  skips,
  str,
  timeOf,
  win,
  wire,
  type Account,
  type Credits,
  type LimitsOptions,
  type UsageEnv,
  type Window,
} from './env.ts';
import { HttpError, failed, getJSON } from './http.ts';
import { kimiAccounts } from './kimi.ts';
import { lastLineWith, walk } from './logs.ts';
import { run } from './run.ts';

type Reader = (e: UsageEnv, o: LimitsOptions) => Promise<Account[]>;

const READERS: Record<string, Reader> = {
  claude: claudeAccounts,
  codex: codexAccounts,
  grok: grokAccounts,
  antigravity: antigravityAccounts,
  kimi: kimiAccounts,
  deepseek: deepseekAccounts,
};

/** The accounts of the providers o selects (all when none), in the
 * providers' order. A reader that fails reports its provider failed; no
 * error leaves (one could quote a credential file). */
export async function limits(e: UsageEnv, o: LimitsOptions): Promise<Account[]> {
  const want = o.providers?.length ? o.providers : PROVIDERS;
  const runs = PROVIDERS.filter((p) => want.includes(p) && READERS[p]).map(async (p) => {
    try {
      return await READERS[p]!(e, o);
    } catch {
      return [{ provider: p, status: 'error', code: 'failed' }];
    }
  });
  return (await Promise.all(runs)).flat().map(wire);
}

/** A file's text; null when it cannot be read. */
async function text(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** A file's JSON; undefined when it cannot be read or does not decode. */
async function jsonFile(p: string): Promise<unknown> {
  const t = await text(p);
  if (t === null) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

// --- Claude --------------------------------------------------------------

/** Claude Code's configuration directory. */
export function claudeDir(e: UsageEnv): string {
  const d = getenv(e, 'CLAUDE_CONFIG_DIR');
  return d ? expand(e.home, d) : posix.join(e.home, '.claude');
}

/** A generic password of the macOS keychain, read with security(1), which
 * fails without asking where no one can answer (ssh); null without one. */
async function keychain(e: UsageEnv, service: string): Promise<string | null> {
  try {
    const r = await run(e.programs.security, ['find-generic-password', '-s', service, '-w'], {
      env: e.env,
      ms: e.t.keychainMs,
      signal: e.signal,
    });
    return r.ok ? r.out.trim() : null;
  } catch {
    return null;
  }
}

/** The Claude subscription's windows: the credentials of
 * ~/.claude/.credentials.json (or the macOS keychain item Claude Code
 * keeps them in), GET /api/oauth/usage. */
async function claudeAccounts(e: UsageEnv, o: LimitsOptions): Promise<Account[]> {
  const dir = claudeDir(e);
  let raw = await text(posix.join(dir, '.credentials.json'));
  if (raw === null && o.claudeKeychain && e.platform === 'darwin') {
    raw = await keychain(e, 'Claude Code-credentials');
    // No item, or no one to allow the access (ssh): as if none.
    if (!raw) return [{ provider: 'claude', status: 'missing', code: 'keychain' }];
  }
  if (raw === null) return [{ provider: 'claude', status: 'missing' }];
  let oauth: Record<string, unknown> | undefined;
  try {
    const v: unknown = JSON.parse(raw);
    if (isObj(v) && isObj(v.claudeAiOauth)) oauth = v.claudeAiOauth;
  } catch {
    // not JSON
  }
  const token = str(oauth?.accessToken);
  if (!oauth || !token) return [{ provider: 'claude', status: 'missing', code: 'no_oauth' }];
  const a: Account = {
    provider: 'claude',
    source: 'api',
    status: '',
    plan: claudePlan(str(oauth.subscriptionType), str(oauth.rateLimitTier)),
  };
  const who = await claudeIdentity(e, dir);
  a.id = who.id;
  a.email = who.email;
  if (skips(o, 'claude', a.id)) return [skipped(a)];
  const exp = timeOf(oauth.expiresAt);
  if (exp > 0 && exp < nowSec(e)) return [{ ...a, status: 'stale', code: 'token_expired' }];
  const headers = { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' };
  if (!a.id) {
    // No local record of the account: ask its profile (best effort).
    try {
      const p = await getJSON(e, 'GET', e.urls.claudeProfile, headers);
      const acc = obj(p.account);
      const id = str(first(acc, 'uuid', 'id'));
      if (id) a.id = id;
      if (!a.email) a.email = str(first(acc, 'email', 'email_address'));
      if (skips(o, 'claude', a.id)) return [skipped(a)];
    } catch {
      // without
    }
  }
  try {
    const m = await getJSON(e, 'GET', e.urls.claudeUsage, headers);
    parseClaudeUsage(a, m);
    return [{ ...a, status: 'ok', asOf: nowSec(e) }];
  } catch (err) {
    return [failed(a, err)];
  }
}

/** The signed-in account as Claude Code records it in ~/.claude.json
 * (oauthAccount). */
async function claudeIdentity(e: UsageEnv, dir: string): Promise<{ id: string; email: string }> {
  for (const f of [posix.join(dir, '.claude.json'), posix.join(e.home, '.claude.json')]) {
    const v = obj(obj(await jsonFile(f)).oauthAccount);
    const id = str(v.accountUuid);
    const email = str(v.emailAddress);
    if (id || email) return { id, email };
  }
  return { id: '', email: '' };
}

export function claudePlan(sub: string, tier: string): string {
  sub = sub.trim();
  if (!sub) return '';
  let plan = sub[0]!.toUpperCase() + sub.slice(1);
  const t = tier.toLowerCase();
  if (t.includes('20x')) plan += ' 20x';
  else if (t.includes('5x')) plan += ' 5x';
  return plan;
}

/** Reads five_hour, seven_day, seven_day_<model> and extra_usage. */
export function parseClaudeUsage(a: Account, m: Record<string, unknown>): void {
  const windows: Window[] = (a.windows ??= []);
  const add = (key: string, kind: string, label: string, sec: number) => {
    if (!isObj(m[key])) return;
    const w = m[key];
    const p = num(w.utilization);
    if (p === undefined) return;
    windows.push(win(kind, clampPct(p), timeOf(w.resets_at), sec, label));
  };
  add('five_hour', SESSION, '', 5 * 3600);
  add('seven_day', WEEKLY, '', 7 * 86400);
  add('seven_day_opus', MODEL, 'Opus', 7 * 86400);
  add('seven_day_sonnet', MODEL, 'Sonnet', 7 * 86400);
  if (isObj(m.extra_usage)) {
    const x = m.extra_usage;
    const c: Credits = { unit: 'usd' };
    if (typeof x.is_enabled === 'boolean') c.enabled = x.is_enabled;
    // Amounts are in cents.
    const limit = num(x.monthly_limit);
    if (limit !== undefined) c.limit = limit / 100;
    const used = num(x.used_credits);
    if (used !== undefined) c.used = used / 100;
    if (c.enabled !== undefined || c.limit !== undefined || c.used !== undefined) a.credits = c;
    const p = num(x.utilization);
    if (p !== undefined && c.enabled) windows.push(win(MONTHLY, clampPct(p), 0, 0, 'Extra'));
  }
}

// --- Codex ---------------------------------------------------------------

/** The Codex homes to read: $CODEX_HOME or ~/.codex, then the configured
 * ones. */
export function codexHomes(e: UsageEnv, extra: readonly string[] = []): string[] {
  const h = getenv(e, 'CODEX_HOME');
  const homes = [h ? expand(e.home, h) : posix.join(e.home, '.codex')];
  for (let x of extra) {
    x = x.trim();
    if (!x) continue;
    const p = expand(e.home, x);
    if (!homes.includes(p)) homes.push(p);
  }
  return homes;
}

/** The ChatGPT subscription's windows of each Codex home. */
async function codexAccounts(e: UsageEnv, o: LimitsOptions): Promise<Account[]> {
  const out: Account[] = [];
  const homes = codexHomes(e, o.codexHomes);
  for (const [i, home] of homes.entries()) {
    const a = await codexAccount(e, o, home, i > 0 ? home : '');
    if (i > 0) a.home = home;
    if (a.status === 'missing' && i > 0 && out.length > 0) continue;
    out.push(a);
  }
  return out;
}

const codexPlan = (p: string) => (p ? p[0]!.toUpperCase() + p.slice(1) : '');

/** One Codex home: auth.json's tokens, GET /backend-api/wham/usage;
 * without an answer (or with an expired token), the rate limits the
 * newest session log recorded. label is its Account.home ("" for the
 * default one). */
async function codexAccount(e: UsageEnv, o: LimitsOptions, home: string, label: string): Promise<Account> {
  const a: Account = { provider: 'codex', source: 'api', status: '' };
  const tokens = obj(obj(await jsonFile(posix.join(home, 'auth.json'))).tokens);
  const access = str(tokens.access_token);
  if (!access) {
    // An API key alone has no subscription windows; a log may still have
    // them.
    return (await codexFromLog(e, home)) ?? { ...a, status: 'missing' };
  }
  a.id = str(tokens.account_id);
  const id = jwtClaims(str(tokens.id_token));
  if (id) {
    a.email = str(id.email);
    if (isObj(id['https://api.openai.com/auth'])) {
      const au = id['https://api.openai.com/auth'];
      a.plan = codexPlan(str(au.chatgpt_plan_type));
      if (!a.id) a.id = str(au.chatgpt_account_id);
    }
  }
  if (skips(o, 'codex', a.id, label)) return skipped(a);
  const fromLog = async (code?: string): Promise<Account | null> => {
    const log = await codexFromLog(e, home);
    if (!log) return null;
    return { ...log, id: a.id, email: a.email, plan: firstNonEmpty(log.plan ?? '', a.plan ?? ''), ...(code ? { code } : {}) };
  };
  const exp = timeOf(jwtClaims(access)?.exp);
  if (exp > 0 && exp < nowSec(e)) return (await fromLog('token_expired')) ?? { ...a, status: 'stale', code: 'token_expired' };
  const headers: Record<string, string> = { Authorization: `Bearer ${access}` };
  if (str(tokens.account_id)) headers['ChatGPT-Account-Id'] = str(tokens.account_id);
  let m: Record<string, unknown>;
  try {
    m = await getJSON(e, 'GET', e.urls.codexUsage, headers);
  } catch (err) {
    const f = failed(a, err);
    if (f.code === 'network') return (await fromLog()) ?? f;
    return f;
  }
  parseCodexUsage(a, m);
  const asOf = nowSec(e);
  for (const w of a.windows ?? []) if ((w.resetsAt ?? 0) < 0) w.resetsAt = asOf - w.resetsAt!;
  return { ...a, status: 'ok', asOf };
}

/** Reads plan_type, rate_limit's windows, credits and
 * additional_rate_limits. */
export function parseCodexUsage(a: Account, m: Record<string, unknown>): void {
  const p = str(m.plan_type);
  if (p) a.plan = codexPlan(p);
  const windows = (a.windows ??= []);
  windows.push(...codexWindows(obj(m.rate_limit), ''));
  for (const x of arr(m.additional_rate_limits)) {
    const xo = obj(x);
    const label = str(first(xo, 'limit_name', 'name', 'metered_feature', 'model'));
    const rl = isObj(xo.rate_limit) ? xo.rate_limit : xo;
    for (const w of codexWindows(rl, label)) windows.push({ ...w, kind: MODEL });
  }
  if (isObj(m.credits)) {
    const c = m.credits;
    const cr: Credits = { unit: 'credits' };
    if (typeof c.unlimited === 'boolean') cr.unlimited = c.unlimited;
    if (typeof c.has_credits === 'boolean') cr.enabled = c.has_credits;
    const b = num(c.balance);
    if (b !== undefined) cr.balance = b;
    if (cr.balance !== undefined || cr.unlimited || cr.enabled) a.credits = cr;
  }
}

/** primary_window and secondary_window (the API's) or primary and
 * secondary (a log's rate_limits). A reset given relative to now is
 * negative, resolved by the caller. */
function codexWindows(rl: Record<string, unknown>, label: string): Window[] {
  const out: Window[] = [];
  for (const [api, log] of [
    ['primary_window', 'primary'],
    ['secondary_window', 'secondary'],
  ] as const) {
    const w = obj(first(rl, api, log));
    const p = num(w.used_percent);
    if (p === undefined) continue;
    let sec = 0;
    const lws = num(w.limit_window_seconds);
    const wm = num(w.window_minutes);
    if (lws !== undefined) sec = Math.trunc(lws);
    else if (wm !== undefined) sec = Math.trunc(wm * 60);
    let kind = WEEKLY;
    if ((sec > 0 && sec <= 86400) || (sec === 0 && log === 'primary')) kind = SESSION;
    let resets = timeOf(first(w, 'reset_at', 'resets_at'));
    if (resets === 0) {
      const after = num(first(w, 'reset_after_seconds', 'resets_in_seconds'));
      if (after !== undefined) resets = -Math.trunc(after);
    }
    out.push({ kind, usedPct: clampPct(p), resetsAt: resets, windowSec: sec, ...(label ? { label } : {}) });
  }
  return out;
}

/** The newest rate_limits a session log of home recorded (a token_count
 * event), as a stale account; null when there is none. The newest log is
 * read backwards from its end until a line has them, and what it said is
 * kept (Memo) while it does not change: a rollout is tens of MB. */
async function codexFromLog(e: UsageEnv, home: string): Promise<Account | null> {
  let newest: { path: string; size: number; mtime: number } | null = null;
  for (const d of ['sessions', 'archived_sessions']) {
    const root = posix.join(home, d);
    for (const rel of await walk(root, (p) => posix.basename(p).startsWith('rollout-') && p.endsWith('.jsonl'), e.signal)) {
      try {
        const st = await stat(posix.join(root, rel));
        if (!newest || st.mtimeMs > newest.mtime) newest = { path: posix.join(root, rel), size: st.size, mtime: st.mtimeMs };
      } catch {
        // gone
      }
    }
  }
  if (!newest) return null;
  const kept = e.memo.codexLog.get(home);
  if (kept && kept.path === newest.path && kept.size === newest.size && kept.mtime === newest.mtime) return kept.a && copyAccount(kept.a);
  let rl: Record<string, unknown> | null = null;
  let ts = 0;
  await lastLineWith(newest.path, '"rate_limits"', (line) => {
    try {
      const d = obj(JSON.parse(line));
      const r = obj(d.payload).rate_limits;
      if (!isObj(r)) return false;
      rl = r;
      ts = timeOf(d.timestamp);
      return true;
    } catch {
      return false;
    }
  });
  let a: Account | null = null;
  if (rl) {
    const windows = codexWindows(rl, '');
    for (const w of windows) if ((w.resetsAt ?? 0) < 0) w.resetsAt = ts - w.resetsAt!;
    a = { provider: 'codex', status: 'stale', code: 'from_log', source: 'log', asOf: ts, windows };
    const p = str(obj(rl).plan_type);
    if (p) a.plan = codexPlan(p);
  }
  e.memo.codexLog.set(home, { ...newest, a: a && copyAccount(a) });
  return a;
}

// --- Grok ----------------------------------------------------------------

export function grokHome(e: UsageEnv): string {
  const h = getenv(e, 'GROK_HOME');
  return h ? expand(e.home, h) : posix.join(e.home, '.grok');
}

/** The Grok subscription's credits: ~/.grok/auth.json (an entry per
 * issuer scope; x.ai's own first), GET /v1/billing and /v1/settings for
 * the plan. */
async function grokAccounts(e: UsageEnv, o: LimitsOptions): Promise<Account[]> {
  const t = await text(posix.join(grokHome(e), 'auth.json'));
  if (t === null) return [{ provider: 'grok', status: 'missing' }];
  let entries: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(t);
    if (!isObj(v)) throw new Error('not an object');
    entries = v;
  } catch {
    return [{ provider: 'grok', status: 'missing', code: 'bad_credentials' }];
  }
  const xai = (k: string) => k.startsWith('https://auth.x.ai::');
  const keys = Object.keys(entries).sort((a, b) => (xai(a) !== xai(b) ? (xai(a) ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0));
  // Each entry on its own: one without a key lends nothing to the next.
  const k = keys.find((k) => str(obj(entries[k]).key) !== '');
  if (k === undefined) return [{ provider: 'grok', status: 'missing', code: 'no_key' }];
  const entry = obj(entries[k]);
  const a: Account = { provider: 'grok', id: str(entry.user_id), email: str(entry.email), source: 'api', status: '' };
  if (skips(o, 'grok', a.id)) return [skipped(a)];
  const exp = timeOf(entry.expires_at);
  if (exp > 0 && exp < nowSec(e)) return [{ ...a, status: 'stale', code: 'token_expired' }];
  const headers = { Authorization: `Bearer ${str(entry.key)}`, 'X-XAI-Token-Auth': 'xai-grok-cli' };
  try {
    parseGrokBilling(a, await getJSON(e, 'GET', e.urls.grokBilling, headers));
  } catch (err) {
    return [failed(a, err)];
  }
  try {
    const s = await getJSON(e, 'GET', e.urls.grokSettings, headers);
    a.plan = str(first(s, 'subscription_tier_display', 'subscriptionTierDisplay'));
  } catch {
    // no plan
  }
  return [{ ...a, status: 'ok', asOf: nowSec(e) }];
}

/** The kind of the credits' window, told by its period's length: a week
 * for the subscriptions Grok's CLI has, also when the answer gives none. */
function grokPeriodKind(sec: number): string {
  if (sec <= 0) return WEEKLY;
  if (sec <= 86400) return SESSION;
  if (sec < 20 * 86400) return WEEKLY;
  return MONTHLY;
}

/** Reads config.creditUsagePercent (else onDemandUsed over onDemandCap),
 * config.currentPeriod and config.productUsage. */
export function parseGrokBilling(a: Account, m: Record<string, unknown>): void {
  const c = isObj(m.config) ? m.config : m;
  const windows = (a.windows ??= []);
  const period = obj(c.currentPeriod);
  const start = timeOf(period.start);
  const end = timeOf(period.end);
  const sec = start > 0 && end > start ? end - start : 0;
  const used = num(obj(c.onDemandUsed).val);
  const limit = num(obj(c.onDemandCap).val);
  let pct = num(c.creditUsagePercent);
  if (pct === undefined && used !== undefined && limit !== undefined && limit > 0) pct = (used / limit) * 100;
  if (pct !== undefined) windows.push(win(grokPeriodKind(sec), clampPct(pct), end, sec));
  for (const x of arr(c.productUsage)) {
    const xo = obj(x);
    const label = str(first(xo, 'product', 'name', 'label', 'model'));
    const p = num(first(xo, 'usagePercent', 'creditUsagePercent', 'percent', 'usedPercent'));
    if (!label || p === undefined) continue;
    windows.push(win(MODEL, clampPct(p), end, sec, label));
  }
  if (used !== undefined || limit !== undefined) {
    const cr: Credits = { unit: 'credits' };
    if (used !== undefined) cr.used = used;
    if (limit !== undefined) cr.limit = limit;
    a.credits = cr;
  }
}

// --- DeepSeek ------------------------------------------------------------

/** The key file the panel writes, below the agent's data directory. */
export const DEEPSEEK_KEY_FILE = 'usage/deepseek.key';

/** Whether Claude Code's base URL is DeepSeek's own (https on
 * api.deepseek.com or below deepseek.com): only then is its token a
 * DeepSeek key, not one of a gateway that has deepseek in its name. */
export function isDeepSeekURL(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  return h === 'api.deepseek.com' || h.endsWith('.deepseek.com');
}

/** A DeepSeek API key: the key file the panel writes (the user's choice,
 * so it wins), DEEPSEEK_API_KEY of the agent's environment, or Claude
 * Code's settings when their base URL is DeepSeek's. */
async function deepseekKey(e: UsageEnv): Promise<string> {
  if (e.base) {
    const k = (await text(posix.join(e.base, DEEPSEEK_KEY_FILE)))?.trim();
    if (k) return k;
  }
  const k = getenv(e, 'DEEPSEEK_API_KEY').trim();
  if (k) return k;
  const env = obj(obj(await jsonFile(posix.join(claudeDir(e), 'settings.json'))).env);
  if (isDeepSeekURL(str(env.ANTHROPIC_BASE_URL))) return str(env.ANTHROPIC_AUTH_TOKEN).trim();
  return '';
}

/** The DeepSeek balance: GET /user/balance. */
async function deepseekAccounts(e: UsageEnv, o: LimitsOptions): Promise<Account[]> {
  const key = await deepseekKey(e);
  if (!key) return [{ provider: 'deepseek', status: 'missing' }];
  const a: Account = { provider: 'deepseek', id: hashId(key), source: 'api', status: '' };
  if (skips(o, 'deepseek', a.id)) return [skipped(a)];
  try {
    const m = await getJSON(e, 'GET', e.urls.deepseekBalance, { Authorization: `Bearer ${key}` });
    if (typeof m.is_available === 'boolean') a.available = m.is_available;
    for (const x of arr(m.balance_infos)) {
      const xo = obj(x);
      const total = num(xo.total_balance);
      if (total === undefined) continue;
      (a.balances ??= []).push({
        currency: str(xo.currency),
        total,
        granted: num(xo.granted_balance) ?? 0,
        toppedUp: num(xo.topped_up_balance) ?? 0,
      });
    }
    return [{ ...a, status: 'ok', asOf: nowSec(e) }];
  } catch (err) {
    return [failed(a, err)];
  }
}

/** Writes the DeepSeek key file below base (0600, its directory 0700),
 * atomically; an empty key removes it. HttpError-free: a key that cannot
 * be an API key throws BadKey. */
export class BadKey extends Error {
  constructor() {
    super('not an API key');
  }
}

export async function setDeepseekKey(base: string, key: string): Promise<void> {
  key = key.trim();
  const p = posix.join(base, DEEPSEEK_KEY_FILE);
  if (!key) {
    await rm(p, { force: true });
    return;
  }
  if (key.length > 256 || !/^[\x21-\x7e]+$/.test(key)) throw new BadKey();
  const dir = posix.dirname(p);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = posix.join(dir, `.deepseek-${randomBytes(6).toString('hex')}`);
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.chmod(0o600);
      await fh.writeFile(key + '\n');
    } finally {
      await fh.close();
    }
    await rename(tmp, p);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** HttpError is the readers' failure (re-exported for the tests). */
export { HttpError };
