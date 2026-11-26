// Antigravity's model quotas: from its local language server
// (GetUserStatus on 127.0.0.1, with the CSRF token of its command line),
// else from `agy -p /usage --output-format json`. The language server is
// looked for among the agent's own user's processes only (ps), and asked
// only on the loopback ports that process listens on (/proc on Linux, lsof
// elsewhere). agy takes seconds and a few hundred MB, so it runs at most
// every agyEveryMs (the polls in between get its last answer), not again
// for agyBackoffMs after it failed, in a process group of its own killed
// after agyMs and once it exited (run.ts).
import { open, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import {
  MODEL,
  SESSION,
  WEEKLY,
  arr,
  clampPct,
  copyAccount,
  first,
  hashId,
  isObj,
  nowSec,
  num,
  obj,
  skipped,
  skips,
  str,
  timeOf,
  win,
  type Account,
  type LimitsOptions,
  type UsageEnv,
} from './env.ts';
import { HttpError, localPost } from './http.ts';
import { run } from './run.ts';

/** How long the language server gets to answer. */
const LOCAL_MS = 5000;

const STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

/** A running language server. */
export interface LSProcess {
  pid: number;
  csrf: string;
}

/** The auth and state files that change when Antigravity switches accounts. */
const ANTIGRAVITY_STATE_FILES = [
  '.gemini/antigravity-cli/cli.log',
  '.gemini/antigravity/cli.log',
  '.gemini/antigravity/antigravity_state.pbtxt',
  '.gemini/antigravity-cli/jetski_state.pbtxt',
];

/** A cheap fingerprint of Antigravity's auth/state files so account
 * switches invalidate memoized LS endpoints and agy answers promptly. */
async function antigravityAuthStamp(e: UsageEnv): Promise<string> {
  const parts: string[] = [];
  for (const rel of ANTIGRAVITY_STATE_FILES) {
    try {
      const st = await stat(posix.join(e.home, rel));
      parts.push(`${rel}:${st.size}:${Math.trunc(st.mtimeMs)}`);
    } catch {
      // absent
    }
  }
  return parts.join('|');
}

/** The quotas of Antigravity's accounts on the machine: every running
 * user-owned language server is probed so multiple accounts on the same
 * machine are all reported; one the hub names in skip (by the email's
 * hash, known once the server answered) or skipLocal is answered skipped. */
export async function antigravityAccounts(e: UsageEnv, o: LimitsOptions): Promise<Account[]> {
  e.signal.throwIfAborted();
  if (skips(o, 'antigravity')) return [skipped({ provider: 'antigravity', status: 'skipped' })];
  const answered = (m: Record<string, unknown>): Account | null => {
    const a: Account = { provider: 'antigravity', source: 'ls', status: '' };
    if (!parseAntigravity(a, m)) return null;
    if (a.id && skips(o, 'antigravity', a.id)) return skipped(a);
    return { ...a, status: 'ok', asOf: nowSec(e) };
  };
  const dedupeAccounts = (list: Account[]): Account[] => {
    const seen = new Set<string>();
    const out: Account[] = [];
    for (const a of list) {
      const k = a.id || a.email?.toLowerCase() || '';
      if (k && seen.has(k)) continue;
      if (k) seen.add(k);
      out.push(a);
    }
    return out;
  };
  const stamp = await antigravityAuthStamp(e);
  const memo = e.memo.antigravityLS;
  if (memo && !o.force && memo.stamp === stamp && e.now() - memo.at < e.t.agyEveryMs && memo.endpoints.length > 0) {
    const accs: Account[] = [];
    let allOk = true;
    for (const ep of memo.endpoints) {
      const m = await userStatus(ep.port, ep.csrf, ep.scheme, e.signal);
      const r = m && answered(m);
      if (!r) {
        allOk = false;
        break;
      }
      accs.push(r);
    }
    if (allOk && accs.length > 0) return dedupeAccounts(accs);
    e.memo.antigravityLS = null;
  }
  const procs = await languageServers(e);
  const endpoints: { port: number; csrf: string; scheme: 'https' | 'http' }[] = [];
  const found: Account[] = [];
  for (const p of procs) {
    let matched = false;
    for (const port of await listeningPorts(e, p.pid)) {
      for (const scheme of ['https', 'http'] as const) {
        const m = await userStatus(port, p.csrf, scheme, e.signal);
        if (!m) continue;
        const r = answered(m);
        if (r) {
          endpoints.push({ port, csrf: p.csrf, scheme });
          found.push(r);
          matched = true;
        }
        break;
      }
      if (matched) break;
    }
  }
  if (found.length > 0) {
    if (!e.signal.aborted) e.memo.antigravityLS = { endpoints, stamp, at: e.now() };
    return dedupeAccounts(found);
  }
  e.memo.antigravityLS = null;
  e.signal.throwIfAborted();
  const a = await agyUsage(e, o, stamp);
  if (a) return [a.id && skips(o, 'antigravity', a.id) ? skipped(a) : a];
  if (procs.length) return [{ provider: 'antigravity', status: 'error', code: 'no_answer' }];
  return [{ provider: 'antigravity', status: 'missing', code: 'not_running' }];
}

/** The agent's user's language servers, from ps. */
async function languageServers(e: UsageEnv): Promise<LSProcess[]> {
  try {
    const r = await run(await systemTool(e.programs.ps), ['-ax', '-o', 'uid=,pid=,command='], {
      env: e.env,
      ms: e.t.psMs,
      signal: e.signal,
    });
    return parsePS(r.out, e.uid);
  } catch {
    return [];
  }
}

/** The program at abs when it is there, else its name (looked up on the
 * PATH). */
async function systemTool(abs: string): Promise<string> {
  try {
    if (!(await stat(abs)).isDirectory()) return abs;
  } catch {
    // not there
  }
  return posix.basename(abs);
}

/** ps's uid, pid and command lines: the language servers of user uid with
 * their CSRF token (other users' are never asked). */
export function parsePS(out: string, uid: number): LSProcess[] {
  const ps: LSProcess[] = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || !/^\d+$/.test(f[0]!) || Number(f[0]) !== uid || !/^\d+$/.test(f[1]!)) continue;
    const args = f.slice(2);
    const low = args.join(' ').toLowerCase();
    if (!low.includes('language_server') || !low.includes('antigravity')) continue;
    let csrf = '';
    for (const [i, a] of args.entries()) {
      if (a.startsWith('--csrf_token=')) csrf = a.slice('--csrf_token='.length);
      else if (a === '--csrf_token' && i + 1 < args.length) csrf = args[i + 1]!;
    }
    if (csrf) ps.push({ pid: Number(f[1]), csrf });
  }
  return ps;
}

/** The loopback TCP ports pid listens on: from /proc on Linux, from lsof
 * elsewhere. */
async function listeningPorts(e: UsageEnv, pid: number): Promise<number[]> {
  if (e.platform === 'linux') return procPorts(e.procRoot, pid);
  try {
    const r = await run(await systemTool(e.programs.lsof), ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], {
      env: e.env,
      ms: e.t.psMs,
      signal: e.signal,
    });
    return parseLsof(r.out);
  } catch {
    return [];
  }
}

export function parseLsof(out: string): number[] {
  const ports: number[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('n')) continue;
    const addr = line.slice(1);
    const i = addr.lastIndexOf(':');
    if (i < 0) continue;
    const host = addr.slice(0, i);
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '*' && host !== '[::1]') continue;
    const p = /^\d+$/.test(addr.slice(i + 1)) ? Number(addr.slice(i + 1)) : 0;
    if (p > 0) ports.push(p);
  }
  return ports;
}

/** The sockets of pid (root/<pid>/fd) and the listening loopback ones
 * among them (root/net/tcp, tcp6). */
export async function procPorts(root: string, pid: number): Promise<number[]> {
  const fdDir = posix.join(root, String(pid), 'fd');
  let fds: string[];
  try {
    fds = await readdir(fdDir);
  } catch {
    return [];
  }
  const inodes = new Set<string>();
  for (const fd of fds) {
    try {
      const l = await readlink(posix.join(fdDir, fd));
      if (l.startsWith('socket:[')) inodes.add(l.slice('socket:['.length, -1));
    } catch {
      // closed meanwhile
    }
  }
  const ports: number[] = [];
  for (const f of ['net/tcp', 'net/tcp6']) {
    let b: string;
    try {
      b = await readFile(posix.join(root, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of b.split('\n').slice(1)) {
      const fs = line.trim().split(/\s+/);
      if (fs.length < 10 || fs[3] !== '0A' || !inodes.has(fs[9]!)) continue;
      const [host, port] = fs[1]!.split(':');
      if (host === undefined || port === undefined) continue;
      // Loopback (127.0.0.1 is 0100007F; ::1 and v4-mapped loopback end
      // the same way) or any address.
      if (
        host !== '0100007F' &&
        host !== '00000000' &&
        !host.endsWith('01000000') &&
        !host.endsWith('0100007F') &&
        host.replace(/0/g, '') !== ''
      )
        continue;
      const p = parseInt(port, 16);
      if (p > 0) ports.push(p);
    }
  }
  return ports;
}

/** GetUserStatus of the language server on port over scheme; null when it
 * does not answer with an object. */
async function userStatus(
  port: number,
  csrf: string,
  scheme: 'https' | 'http',
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const headers = { 'X-Codeium-Csrf-Token': csrf, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' };
  for (const body of ['{"metadata":{"ideName":"antigravity","extensionName":"antigravity","locale":"en"}}', '{}']) {
    signal.throwIfAborted();
    try {
      return await localPost(port, scheme, STATUS_PATH, headers, body, LOCAL_MS, signal);
    } catch (err) {
      signal.throwIfAborted();
      if (err instanceof HttpError && err.code === 'network') break;
    }
  }
  return null;
}

/** Reads userStatus{email, planStatus.planInfo.planName,
 * cascadeModelConfigData.clientModelConfigs[{label, quotaInfo{
 * remainingFraction, resetTime}}]}; false when there is nothing. */
export function parseAntigravity(a: Account, m: Record<string, unknown>): boolean {
  const us = isObj(m.userStatus) ? m.userStatus : m;
  a.email = str(us.email);
  a.id = hashId(a.email.toLowerCase());
  a.plan = str(obj(obj(us.planStatus).planInfo).planName);
  const windows = (a.windows ??= []);
  for (const x of arr(obj(us.cascadeModelConfigData).clientModelConfigs)) {
    const xo = obj(x);
    if (!isObj(xo.quotaInfo)) continue;
    const q = xo.quotaInfo;
    let rem = num(q.remainingFraction);
    if (rem === undefined) {
      // A model with quota info but no fraction is exhausted.
      if (!('resetTime' in q)) continue;
      rem = 0;
    }
    windows.push(win(MODEL, clampPct((1 - rem) * 100), timeOf(q.resetTime), 0, str(first(xo, 'label', 'modelName', 'model'))));
  }
  return windows.length > 0 || a.email !== '';
}

/** The PATH of the agent's environment, then where installers put
 * programs a login shell would add. */
async function lookPath(e: UsageEnv, name: string): Promise<string | null> {
  const dirs = (e.env.PATH ?? '').split(':');
  dirs.push(posix.join(e.home, '.local/bin'), posix.join(e.home, 'bin'), posix.join(e.home, '.antigravity/bin'), ...e.programs.extraPath);
  for (const d of dirs) {
    if (!d || !posix.isAbsolute(d)) continue;
    const p = posix.join(d, name);
    try {
      const st = await stat(p);
      if (st.isFile() && st.mode & 0o111) return p;
    } catch {
      // not there
    }
  }
  return null;
}

/** agy's answer: within agyEveryMs of a run that answered, or agyBackoffMs
 * of one that failed, that run's answer again instead of running agy
 * unless forced or auth state changed; null when there is no agy. */
async function agyUsage(e: UsageEnv, o: LimitsOptions, stamp: string): Promise<Account | null> {
  const bin = await lookPath(e, 'agy');
  if (!bin) return null;
  const now = e.now();
  const last = e.memo.agy.get(bin);
  if (
    last &&
    !o.force &&
    last.stamp === stamp &&
    now >= last.at &&
    now - last.at < (last.a.status === 'ok' ? e.t.agyEveryMs : e.t.agyBackoffMs)
  )
    return copyAccount(last.a);
  let out = '';
  let ok = false;
  try {
    const r = await run(bin, ['-p', '/usage', '--output-format', 'json'], {
      env: { ...e.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true', NO_COLOR: '1' },
      ms: e.t.agyMs,
      signal: e.signal,
    });
    out = r.out;
    ok = r.ok;
  } catch {
    // could not start
  }
  let a: Account = { provider: 'antigravity', source: 'cli', status: 'ok' };
  if (!parseAgy(a, out)) {
    a = { provider: 'antigravity', status: 'error', code: !ok || out === '' ? 'agy_failed' : 'bad_response', source: 'cli' };
  } else {
    a.asOf = nowSec(e);
    if (!a.id) {
      // agy 1.5 names no account; its log does, as the language server's
      // id is made: the email's hash.
      const email = await agyEmail(e);
      if (email) {
        a.email = email;
        a.id = hashId(email.toLowerCase());
      }
    }
  }
  // A run the poll cut short says nothing about agy.
  if (!e.signal.aborted) e.memo.agy.set(bin, { a: copyAccount(a), at: e.now(), stamp });
  return a;
}

/** agy's log below the home directory, where each run notes the account
 * it signed in as. */
const AGY_LOG = '.gemini/antigravity-cli/cli.log';
const AGY_ACCOUNT = /(?:authenticated successfully as|applyAuthResult: email=)\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** The account agy last signed in as, from the end of its log (256 KiB);
 * "" when it does not say. */
async function agyEmail(e: UsageEnv): Promise<string> {
  const TAIL = 256 << 10;
  try {
    const fh = await open(posix.join(e.home, AGY_LOG), 'r');
    try {
      const st = await fh.stat();
      const from = Math.max(st.size - TAIL, 0);
      const b = Buffer.alloc(Math.min(st.size, TAIL));
      const { bytesRead } = await fh.read(b, 0, b.length, from);
      let last = '';
      for (const m of b.subarray(0, bytesRead).toString('utf8').matchAll(AGY_ACCOUNT)) last = m[1]!;
      return last;
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

/** Reads agy's JSON output (its first JSON value after any text): agy
 * 1.5's command.data.groups of buckets, the language server's shape, or a
 * list of models with their remaining fraction or used percent. */
export function parseAgy(a: Account, out: string): boolean {
  out = out.trim();
  const i = out.search(/[{[]/);
  if (i > 0) out = out.slice(i);
  let v: unknown;
  try {
    v = firstJSON(out);
  } catch {
    return false;
  }
  const windows = (a.windows ??= []);
  // agy 1.5: {status, response (a table), command: {name: "usage", data:
  // {groups: [{name, buckets: [{name, window: weekly|5h,
  // remaining_fraction, reset_time}]}]}}}.
  const cmdData = obj(obj(v).command).data;
  const groups = arr(obj(cmdData).groups);
  for (const g of groups) {
    const go = obj(g);
    const group = str(go.name);
    for (const b of arr(go.buckets)) {
      const bo = obj(b);
      const r = num(bo.remaining_fraction);
      if (r === undefined) continue;
      let kind = MODEL;
      let sec = 0;
      if (bo.window === '5h') [kind, sec] = [SESSION, 5 * 3600];
      else if (bo.window === 'weekly') [kind, sec] = [WEEKLY, 7 * 86400];
      const label = kind === MODEL ? str(first(bo, 'name', 'id')) : group;
      windows.push(win(kind, clampPct((1 - r) * 100), timeOf(bo.reset_time), sec, label));
    }
  }
  if (windows.length) {
    if (!a.plan) a.plan = str(first(obj(cmdData), 'plan', 'planName', 'tier')) || str(first(obj(v), 'plan', 'planName', 'tier'));
    return true;
  }
  if (isObj(v)) {
    let m = v;
    const r = first(m, 'result', 'usage', 'data');
    if (isObj(r)) m = r;
    if (parseAntigravity(a, m) && windows.length) return true;
    const email = str(first(m, 'email', 'account'));
    if (email) {
      a.email = email;
      a.id = hashId(email.toLowerCase());
    }
    if (!a.plan) a.plan = str(first(m, 'plan', 'planName', 'tier'));
    v = first(m, 'models', 'quotas', 'limits');
  }
  for (const x of arr(v)) {
    const xo = obj(x);
    const label = str(first(xo, 'label', 'model', 'name', 'modelName'));
    let used: number;
    const rem = num(first(xo, 'remainingFraction', 'remaining_fraction'));
    const pct = num(first(xo, 'usedPercent', 'used_percent', 'usage_percent'));
    const remPct = num(first(xo, 'remainingPercent', 'remaining_percent'));
    if (rem !== undefined) used = (1 - rem) * 100;
    else if (pct !== undefined) used = pct;
    else if (remPct !== undefined) used = 100 - remPct;
    else continue;
    windows.push(win(MODEL, clampPct(used), timeOf(first(xo, 'resetTime', 'reset_time', 'resetsAt', 'resets_at')), 0, label));
  }
  return windows.length > 0;
}

/** The first JSON value of s, as a decoder of a stream reads it: text may
 * follow an object or an array. */
function firstJSON(s: string): unknown {
  return JSON.parse(s.slice(0, jsonEnd(s)));
}

/** Where the object or array s starts with ends (past its closing
 * bracket); s's length when it does not. */
function jsonEnd(s: string): number {
  if (s[0] !== '{' && s[0] !== '[') return s.length;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
  }
  return s.length;
}
