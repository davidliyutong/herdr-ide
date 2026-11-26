// Kimi Code's quotas, and its sign-in renewed as Kimi Code renews it (its
// packages/oauth, CLI 2.2.0): the access token lasts about 15 minutes and
// the CLI renews it only while it runs, with a refresh token that is good
// once. So a renewal here does what the CLI does, under the CLI's own
// lock, and writes the new tokens back where the CLI reads them;
// otherwise the CLI would be left with a spent refresh token.
//
//   - Lock: proper-lockfile 4.1.2's protocol on <home>/oauth/kimi-code
//     (the CLI first creates that empty file and its directory): the lock
//     is the directory <home>/oauth/kimi-code.lock, made with mkdir; its
//     holder sets its time every 2.5 s; the CLI takes one untouched for
//     5 s as stale. Here a held lock is waited for (8 s) and never broken;
//     only one untouched for 30 s is taken over (rmdir, mkdir): a CLI whose
//     event loop stalled a few seconds keeps its lock (taken over, it
//     would find it compromised and throw). The lock is not the library:
//     proper-lockfile patches fs.close and process.cwd and installs signal
//     handlers in the process that imports it (graceful-fs, signal-exit),
//     which the node, serving every hub on one thread, does not take on
//     for one provider; its protocol is a directory and its time.
//   - Under the lock the file is read again and renewed only if the token
//     still needs it (the CLI may just have).
//   - Refresh: POST https://auth.kimi.com/api/oauth/token, the CLI's form
//     and identity headers; 3 attempts with base waits of 1 s and 2 s and jitter, for network
//     errors and 429/5xx; 401, 403 or invalid_grant is a refusal, not
//     tried again until the file changes.
//   - The file: JSON.stringify(…, null, 2) and a newline, the CLI's members
//     first, the file's others kept; written to <file>.tmp.<pid>.<8 hex>,
//     fsynced, given the file's mode and renamed.
//
// Tokens appear in no reply, log or error.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, utimes, type FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import { posix } from 'node:path';
import { retryDelay } from '#shared/lib/wait.ts';
import {
  MONTHLY,
  SESSION,
  WEEKLY,
  arr,
  clampPct,
  expand,
  first,
  getenv,
  isObj,
  jwtClaims,
  nowSec,
  num,
  obj,
  skipped,
  skips,
  sleep,
  str,
  timeOf,
  win,
  type Account,
  type Credits,
  type LimitsOptions,
  type UsageEnv,
  type Window,
} from './env.ts';
import { HttpError, failed, getJSON, postForm } from './http.ts';

/** Kimi Code's OAuth client. */
export const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
/** The credential slot of Kimi Code's default host: credentials/kimi-code.json,
 * locked as oauth/kimi-code. Other hosts' sign-ins
 * (kimi-code-env-<hash>.json) are never renewed here. */
const SLOT = 'kimi-code';
/** The CLI version whose renewal this follows, sent when the installed
 * one's is not known. */
export const KIMI_CLI_VERSION = '2.2.0';
/** A token that ends sooner than this is renewed first. */
const REFRESH_MARGIN = 60;
const ATTEMPTS = 3;

export function kimiHome(e: UsageEnv): string {
  const h = getenv(e, 'KIMI_CODE_HOME');
  return h ? expand(e.home, h) : posix.join(e.home, '.kimi-code');
}

/** The tokens a credential file holds, and its bytes. */
interface Token {
  access: string;
  refresh: string;
  /** Unix seconds, 0 when unknown. */
  expiresAt: number;
  raw: string;
}

async function readToken(file: string): Promise<Token | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const v = obj(JSON.parse(raw));
    return { access: str(v.access_token), refresh: str(v.refresh_token), expiresAt: timeOf(v.expires_at), raw };
  } catch {
    return { access: '', refresh: '', expiresAt: 0, raw };
  }
}

/** The token ends within the margin (one whose end is unknown is used as
 * it is, as the CLI does). */
const needsRefresh = (t: Token, now: number) => t.expiresAt > 0 && t.expiresAt - now < REFRESH_MARGIN;

const sum = (s: string) => createHash('sha256').update(s).digest('hex');

/** Kimi Code's weekly quota and its shorter windows:
 * credentials/kimi-code*.json, GET /coding/v1/usages; with kimiRefresh an
 * ended token of the default slot is renewed first. */
export async function kimiAccounts(e: UsageEnv, o: LimitsOptions): Promise<Account[]> {
  const dir = posix.join(kimiHome(e), 'credentials');
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => !d.isDirectory() && d.name.startsWith('kimi-code') && d.name.endsWith('.json'))
      .map((d) => d.name);
  } catch {
    return [{ provider: 'kimi', status: 'missing' }];
  }
  // kimi-code.json first.
  names.sort((a, b) =>
    (a === 'kimi-code.json') !== (b === 'kimi-code.json') ? (a === 'kimi-code.json' ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0,
  );
  const out: Account[] = [];
  for (const n of names) out.push(await kimiAccount(e, o, posix.join(dir, n)));
  return out.length ? out : [{ provider: 'kimi', status: 'missing' }];
}

async function kimiAccount(e: UsageEnv, o: LimitsOptions, file: string): Promise<Account> {
  const a: Account = { provider: 'kimi', source: 'api', status: '' };
  let tok = await readToken(file);
  if (!tok?.access) return { ...a, status: 'missing' };
  const c = jwtClaims(tok.access);
  if (c) {
    a.id = str(first(c, 'user_id', 'sub', 'uid'));
    a.email = str(c.email);
  }
  if (skips(o, 'kimi', a.id)) return skipped(a);
  if (o.kimiRefresh && renewable(e, file) && needsRefresh(tok, nowSec(e))) {
    try {
      tok = await e.memo.oneRenewal(() => renew(e, file));
    } catch (err) {
      if (err === REFUSED) return { ...a, status: 'unauth', code: 'unauthorized' };
      if (err === LOCK_BUSY) return { ...a, status: 'stale', code: 'lock_busy' };
      return failed(a, err);
    }
  }
  if (tok.expiresAt > 0 && tok.expiresAt < nowSec(e)) return { ...a, status: 'stale', code: 'token_expired' };
  try {
    parseKimiUsage(a, await getJSON(e, 'GET', e.urls.kimiUsage, { Authorization: `Bearer ${tok.access}` }));
  } catch (err) {
    return failed(a, err);
  }
  return { ...a, status: 'ok', asOf: nowSec(e) };
}

/** {limit, used, remaining, resetTime}, whose numbers may be strings. */
function detail(d: Record<string, unknown>): { pct: number; resets: number } | null {
  const limit = num(d.limit);
  let used = num(d.used);
  if (used === undefined) {
    const rem = num(d.remaining);
    if (rem !== undefined && limit !== undefined) used = limit - rem;
  }
  if (limit === undefined || used === undefined || limit <= 0) return null;
  return { pct: clampPct((used / limit) * 100), resets: timeOf(first(d, 'resetTime', 'reset_time', 'resetAt')) };
}

/** A time unit (MINUTE, TIME_UNIT_HOUR, days…) in seconds. */
function unitSeconds(u: string): number {
  u = u.toLowerCase();
  if (u.includes('sec')) return 1;
  if (u.includes('min')) return 60;
  if (u.includes('hour')) return 3600;
  if (u.includes('day')) return 86400;
  if (u.includes('week')) return 7 * 86400;
  return 60;
}

/** The answer of /coding/v1/usages in either shape it has had: usages
 * {limit_5h, limit_7d, limit_month_total, limit_month_code} (Kimi Code
 * 2.2.0's), or usage (the weekly quota) and limits[]. With both, the one
 * with more windows counts (the newer when they tie); the booster wallet
 * comes with the newer. */
export function parseKimiUsage(a: Account, m: Record<string, unknown>): void {
  const older: Window[] = [];
  const d = detail(obj(m.usage));
  if (d) older.push(win(WEEKLY, d.pct, d.resets, 7 * 86400));
  for (const x of arr(m.limits)) {
    const xo = obj(x);
    const dd = detail(obj(xo.detail));
    if (!dd) continue;
    const w = obj(xo.window);
    const sec = Math.trunc((num(w.duration) ?? 0) * unitSeconds(str(w.timeUnit)));
    older.push(win(sec > 86400 ? WEEKLY : SESSION, dd.pct, dd.resets, sec));
  }
  // The session windows first, the others in their order.
  older.sort((x, y) => ((x.kind === SESSION) === (y.kind === SESSION) ? 0 : x.kind === SESSION ? -1 : 1));
  const newer: Window[] = [];
  const u = obj(m.usages);
  const add = (key: string, kind: string, label: string, sec: number) => {
    const x = obj(u[key]);
    const r = num(x.used_ratio);
    if (r !== undefined) newer.push(win(kind, clampPct(r * 100), timeOf(x.reset_time), sec, label));
  };
  add('limit_5h', SESSION, '', 5 * 3600);
  add('limit_7d', WEEKLY, '', 7 * 86400);
  // A month taken as 30 days (for the pace).
  add('limit_month_total', MONTHLY, '', 30 * 86400);
  add('limit_month_code', MONTHLY, 'Code', 30 * 86400);
  a.windows = older.length > newer.length ? older : newer;
  const c = kimiWallet(obj(m.boosterWallet));
  if (c) a.credits = c;
}

/** boosterWallet, extra usage bought beyond the plan, as Kimi Code reads
 * it: a BOOSTER balance with amount and amountLeft in millionths of a
 * cent, monthlyUsed and monthlyChargeLimit {priceInCents, currency},
 * monthlyChargeLimitEnabled. Null without one. */
function kimiWallet(w: Record<string, unknown>): Credits | null {
  const b = obj(w.balance);
  if (str(b.type) !== 'BOOSTER') return null;
  const amount = num(b.amount);
  if (amount === undefined || amount <= 0) return null;
  // An amount in millionths of a cent, in currency units: at least a cent
  // when there is any.
  const fixed = (v: number) => {
    let c = v / 1e6;
    if (c > 0 && c < 1) c = 1;
    return Math.round(c) / 100;
  };
  const money = (x: Record<string, unknown>) => {
    const c = num(x.priceInCents);
    return { v: Math.trunc(c ?? 0) / 100, cur: str(x.currency), ok: c !== undefined };
  };
  const leftRaw = num(b.amountLeft);
  const limit = money(obj(w.monthlyChargeLimit));
  const used = money(obj(w.monthlyUsed));
  const cur = limit.cur || used.cur || 'USD';
  const c: Credits = { balance: leftRaw !== undefined ? fixed(leftRaw) : 0, enabled: true, unit: cur.toLowerCase() };
  if (used.ok) c.used = used.v;
  if (w.monthlyChargeLimitEnabled === true && limit.ok && limit.v > 0) c.limit = limit.v;
  return c;
}

// --- Renewal -------------------------------------------------------------

/** The CLI held its lock for longer than the wait. */
export const LOCK_BUSY = new Error('lock_busy');
/** The provider refused the refresh token. */
export const REFUSED = new Error('refused');

/** Whether file's sign-in may be renewed here: the default slot, where the
 * CLI locks (not with KIMI_DISABLE_OAUTH_LOCK=1, where it renews without a
 * lock). */
const renewable = (e: UsageEnv, file: string) =>
  posix.basename(file) === `${SLOT}.json` && e.platform !== 'win32' && getenv(e, 'KIMI_DISABLE_OAUTH_LOCK') !== '1';

/** Renews the access token of file under the CLI's lock and writes the new
 * tokens back; the token to use. Throws LOCK_BUSY, REFUSED, or an
 * HttpError. */
async function renew(e: UsageEnv, file: string): Promise<Token> {
  const before = await readToken(file);
  if (before && e.memo.kimiRefused.get(file) === sum(before.raw)) throw REFUSED;
  const lock = await lockKimi(e, posix.join(kimiHome(e), 'oauth', SLOT));
  try {
    // The CLI (or another agent) may have renewed it meanwhile.
    const tok = await readToken(file);
    if (!tok?.access) throw new HttpError('bad_credentials');
    if (!needsRefresh(tok, nowSec(e))) return tok;
    if (e.memo.kimiRefused.get(file) === sum(tok.raw)) throw REFUSED;
    if (!tok.refresh) {
      e.memo.kimiRefused.set(file, sum(tok.raw));
      throw REFUSED;
    }
    let ans: Answer;
    try {
      ans = await refresh(e, tok.refresh);
    } catch (err) {
      if (err === REFUSED) e.memo.kimiRefused.set(file, sum(tok.raw));
      throw err;
    }
    // Written back even if the lock was taken over while the request ran:
    // the old refresh token is spent, and a CLI whose own refresh is then
    // refused reads the file again for these.
    let out: string;
    try {
      out = rewrite(tok.raw, ans, nowSec(e));
    } catch {
      throw new HttpError('bad_credentials');
    }
    try {
      await writeKimiFile(file, out);
    } catch {
      throw new HttpError('write_failed');
    }
    const nt = await readToken(file);
    if (!nt?.access) throw new HttpError('write_failed');
    return nt;
  } finally {
    await lock.release();
  }
}

/** A successful refresh. */
export interface Answer {
  access: string;
  refresh: string;
  scope: string;
  tokenType: string;
  expiresIn: number;
}

/** Asks the token endpoint as the CLI does, with its retries. Once a
 * request is sent its answer is read even if the poll ended (the refresh
 * token is spent once the provider answers); no new attempt starts after
 * it ended. */
async function refresh(e: UsageEnv, token: string): Promise<Answer> {
  const form = new URLSearchParams({ client_id: KIMI_CLIENT_ID, grant_type: 'refresh_token', refresh_token: token }).toString();
  const headers = await kimiHeaders(e);
  let last: unknown = new HttpError('network');
  for (let n = 0; n < ATTEMPTS; n++) {
    if (n > 0) await sleep(retryDelay(e.t.kimiBackoffMs * 2 ** (n - 1)), e.signal);
    if (e.signal.aborted) throw last;
    let r: { status: number; body: Record<string, unknown> };
    try {
      r = await postForm(e, e.urls.kimiToken, headers, form);
    } catch (err) {
      last = err;
      continue;
    }
    if (r.status === 200 && str(r.body.access_token)) return answerOf(r.body);
    if (r.status === 401 || r.status === 403 || str(r.body.error) === 'invalid_grant') throw REFUSED;
    if ([429, 500, 502, 503, 504].includes(r.status)) {
      last = new HttpError(`http_${r.status}`, r.status);
      continue;
    }
    // Not followed: the refresh token goes to the fixed host only.
    if (r.status >= 300 && r.status < 400) throw new HttpError('http_3xx', r.status);
    throw new HttpError(`http_${r.status}`, r.status);
  }
  throw last;
}

/** A token answer: access_token, refresh_token and a positive expires_in
 * are required. */
function answerOf(m: Record<string, unknown>): Answer {
  const a: Answer = {
    access: str(m.access_token),
    refresh: str(m.refresh_token),
    scope: str(m.scope),
    tokenType: typeof m.token_type === 'string' ? m.token_type : 'Bearer',
    expiresIn: num(m.expires_in) ?? 0,
  };
  if (!a.refresh || !(a.expiresIn > 0)) throw new HttpError('bad_response');
  return a;
}

/** Printable ASCII of v, trimmed ("unknown" when nothing is left), as the
 * CLI sends its headers. */
export function asciiHeader(v: string): string {
  const s = v.replace(/[^\x20-\x7e]/g, '').trim();
  return s || 'unknown';
}

/** The installed Kimi Code's version as its updater recorded it
 * (<home>/updates/install.json, lastSuccess.version), else the one whose
 * renewal this follows. */
export async function kimiVersion(e: UsageEnv): Promise<string> {
  try {
    const fh = await open(posix.join(kimiHome(e), 'updates', 'install.json'), 'r');
    let b: Buffer;
    try {
      b = Buffer.alloc(64 << 10);
      const { bytesRead } = await fh.read(b, 0, b.length, 0);
      b = b.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    const v = str(obj(obj(JSON.parse(b.toString('utf8'))).lastSuccess).version);
    if (/^[0-9][0-9A-Za-z.+-]{0,31}$/.test(v)) return v;
  } catch {
    // not recorded
  }
  return KIMI_CLI_VERSION;
}

/** The identity headers the CLI sends with a refresh: its product and
 * version, the host's name, OS and model as Node describes them, and the
 * device id it keeps (read, never made here). */
export async function kimiHeaders(e: UsageEnv): Promise<Record<string, string>> {
  const v = await kimiVersion(e);
  const release = os.release();
  let model = `${e.platform === 'darwin' ? 'macOS' : e.platform === 'linux' ? 'Linux' : e.platform} ${release} ${process.arch}`.trim();
  if (e.platform === 'darwin') {
    try {
      const plist = await readFile('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
      const m = /<key>ProductVersion<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
      if (m?.[1]?.trim()) model = `macOS ${m[1].trim()} ${process.arch}`;
    } catch {
      // the kernel's release
    }
  }
  const h: Record<string, string> = {
    'User-Agent': `kimi-code-cli/${v}`,
    'X-Msh-Platform': 'kimi_code_cli',
    'X-Msh-Version': v,
    'X-Msh-Device-Name': asciiHeader(os.hostname()),
    'X-Msh-Device-Model': asciiHeader(model),
    'X-Msh-Os-Version': asciiHeader(release),
  };
  try {
    const id = asciiHeader((await readFile(posix.join(kimiHome(e), 'device_id'), 'utf8')).trim());
    if (id !== 'unknown' && id.length <= 128) h['X-Msh-Device-Id'] = id;
  } catch {
    // none yet
  }
  return h;
}

/** The members the CLI writes, in its order. */
const FIELDS = ['access_token', 'refresh_token', 'expires_at', 'scope', 'token_type', 'expires_in'];

/** The credential file with the refresh's tokens, as the CLI writes it
 * (JSON.stringify(…, null, 2) and a newline): its members first, then the
 * file's others as they were. now in Unix seconds. */
export function rewrite(old: string, a: Answer, now: number): string {
  const v: unknown = JSON.parse(old);
  if (!isObj(v)) throw new Error('not an object');
  const out: Record<string, unknown> = {
    access_token: a.access,
    refresh_token: a.refresh,
    expires_at: now + a.expiresIn,
    scope: a.scope,
    token_type: a.tokenType,
    expires_in: a.expiresIn,
  };
  for (const [k, x] of Object.entries(v)) if (!FIELDS.includes(k)) out[k] = x;
  return JSON.stringify(out, null, 2) + '\n';
}

/** Replaces file with data as the CLI does, keeping its mode. */
async function writeKimiFile(file: string, data: string): Promise<void> {
  const mode = (await stat(file)).mode & 0o777;
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let fh: FileHandle | undefined;
  try {
    fh = await open(tmp, 'wx', mode);
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = undefined;
    await chmod(tmp, mode);
    await rename(tmp, file);
  } catch (err) {
    await fh?.close().catch(() => {});
    await rm(tmp, { force: true });
    throw err;
  }
}

/** The CLI's lock, held here. */
export interface KimiLock {
  /** Whether it is still the one set here, answered while no touch of it
   * runs. */
  held(): Promise<boolean>;
  /** Stops keeping it and removes it while it is still the one set here. */
  release(): Promise<void>;
}

/** Takes the CLI's lock on target as proper-lockfile does: mkdir
 * <target>.lock; a lock touched within kimiLockAbandonedMs is waited for
 * until kimiLockWaitMs, never broken. Throws LOCK_BUSY. */
export async function lockKimi(e: UsageEnv, target: string): Promise<KimiLock> {
  // As the CLI prepares it: the directory and the empty file it locks.
  await mkdir(posix.dirname(target), { recursive: true });
  await (await open(target, 'a', 0o666)).close();
  const dir = `${target}.lock`;
  const deadline = Date.now() + e.t.kimiLockWaitMs;
  for (;;) {
    if (await tryLock(e, dir)) return keepLock(e, dir);
    if (Date.now() >= deadline || e.signal.aborted) throw LOCK_BUSY;
    await sleep(Math.min(e.t.kimiLockRetryMs, Math.max(deadline - Date.now(), 1)), e.signal);
  }
}

const code = (err: unknown) => (err as NodeJS.ErrnoException)?.code;

/** Makes the lock directory; an abandoned one is removed and made again,
 * as proper-lockfile does with a stale one. */
async function tryLock(e: UsageEnv, dir: string): Promise<boolean> {
  try {
    await mkdir(dir);
    return true;
  } catch (err) {
    if (code(err) !== 'EEXIST') throw err;
  }
  let st;
  try {
    st = await stat(dir);
  } catch (err) {
    if (code(err) !== 'ENOENT') throw err;
    // Released meanwhile.
    return mkdir(dir).then(
      () => true,
      () => false,
    );
  }
  if (!st.isDirectory() || Date.now() - st.mtimeMs <= e.t.kimiLockAbandonedMs) return false;
  try {
    await rmdir(dir);
  } catch (err) {
    if (code(err) !== 'ENOENT') return false;
  }
  return mkdir(dir).then(
    () => true,
    () => false,
  );
}

/** Keeps the lock fresh: its time set every kimiLockUpdateMs, as long as
 * it is still the one set here. */
async function keepLock(e: UsageEnv, dir: string): Promise<KimiLock> {
  let mt = 0;
  let at = 0;
  let lost = false;
  const touch = async () => {
    const now = new Date();
    await utimes(dir, now, now);
    mt = (await stat(dir)).mtimeMs;
    at = Date.now();
  };
  const held = async () => {
    if (lost || Date.now() - at > e.t.kimiLockStaleMs) return false;
    try {
      return (await stat(dir)).mtimeMs === mt;
    } catch {
      return false;
    }
  };
  try {
    await touch();
  } catch (err) {
    await rmdir(dir).catch(() => {});
    throw err;
  }
  // The touches and the looks of held(), one after another.
  let busy: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(f: () => Promise<T>): Promise<T> => {
    const p = busy.then(f);
    busy = p.catch(() => {});
    return p;
  };
  const timer = setInterval(() => {
    void inTurn(async () => {
      if (lost) return;
      try {
        if (await held()) await touch();
        else lost = true;
      } catch {
        lost = true;
      }
    });
  }, e.t.kimiLockUpdateMs);
  timer.unref?.();
  return {
    // No touch runs while it looks, and one that came due meanwhile starts
    // only after the caller took the answer: a touch whose check came
    // before a takeover would make the lock that took over its own.
    held: () => inTurn(held),
    release: async () => {
      clearInterval(timer);
      await busy;
      if (await held()) await rmdir(dir).catch(() => {});
      lost = true;
    },
  };
}
