// The scheduler of the AI usage feature: every TICK it looks whether a poll
// is due by usage.refresh (manual, a fixed interval, or adaptive: faster
// while a panel is open or a coding agent works), and polls the connected
// machines one after another, the local one first, passing the accounts
// already read in skip: an account signed in on several machines is asked
// once per poll and lists every machine it was seen on. Per account the
// best answer wins; an answer without numbers keeps the last good ones.
// After a poll it records the history, fires the alerts and sends the
// snapshot to the pages. A machine that connects later is asked alone at
// the next tick. Every STATUS_EVERY it reads the providers' status pages.
import type { Logger } from '#shared/lib/log.ts';
import type { Store as Settings } from '#kernel/config/settings/index.ts';
import { ALERT_KEEP, fireAlerts, thresholds, type Alert } from './alerts.ts';
import { codeOf, jsonETag, Spend, type SpendDeps } from './cost.ts';
import { History, pace, windowIDs, type Issue, type Kept, type WindowView } from './history.ts';
import type { Account, LimitsParams, Window } from './protocol.ts';
import { parsePrices, PROVIDERS, REFRESH_MODES } from './settings.ts';
import { keptJSON, type UsageStore } from './store.ts';

/** How often the scheduler looks whether a poll is due, in ms. */
export const TICK = 10_000;
/** How long a panel's GET ?watch=1 counts as open. */
const WATCH_FOR = 3 * 60_000;
/** Accounts no machine reported for this long are forgotten (seconds). */
const FORGET_AFTER = 7 * 86_400;
/** How often the status pages are read. */
const STATUS_EVERY = 10 * 60_000;
/** The least time between polls a manual refresh makes: requests sooner
 * wait for it and share that poll. */
export const MIN_REFRESH_GAP = 30_000;

/** The adaptive mode's cadences, in ms. */
export interface Cadence {
  open: number;
  working: number;
  idle: number;
}

export const DEFAULT_CADENCE: Cadence = { open: 5 * 60_000, working: 10 * 60_000, idle: 30 * 60_000 };

/** How often the scheduler polls in mode (ms; 0: never by itself). */
export function interval(mode: string, watching: boolean, working: boolean, c: Cadence): number {
  if (mode === 'manual') return 0;
  if (mode === 'adaptive' || mode === '') return Math.min(c.idle, working ? c.working : Infinity, watching ? c.open : Infinity);
  const n = /^\d+$/.test(mode) ? Number(mode) : 0;
  return n > 0 ? n * 60_000 : 30 * 60_000;
}

/** How the last poll of a machine went: ok, error or offline. */
export interface MachineView {
  status: string;
  code?: string;
  at: number;
}

/** A provider's status page: indicator none, minor, major, critical or
 * maintenance (absent for a page only linked). */
export interface StatusPage {
  indicator?: string;
  description?: string;
  url: string;
  at?: number;
}

/** What GET /api/p/usage and the /ws messages carry. */
export interface Snapshot {
  updatedAt: number;
  refresh: string;
  interval: number;
  nextAt?: number;
  polling: boolean;
  accounts: object[];
  machines: Record<string, MachineView>;
  status: Record<string, StatusPage>;
  alerts?: Alert[];
}

/** Status pages: Statuspage's summaries, Google's incident feed for
 * Antigravity; the others are links. */
export const STATUS_URLS: Record<string, string> = {
  claude: 'https://status.claude.com/api/v2/status.json',
  codex: 'https://status.openai.com/api/v2/status.json',
  antigravity: 'https://www.google.com/appsstatus/dashboard/incidents.json',
};
const STATUS_PAGES: Record<string, string> = {
  claude: 'https://status.claude.com',
  codex: 'https://status.openai.com',
  antigravity: 'https://www.google.com/appsstatus/dashboard/',
  grok: 'https://status.x.ai',
  deepseek: 'https://status.deepseek.com',
};
/** Antigravity's id in Google's incident feed. */
const ANTIGRAVITY_PRODUCT = 'npdyhgECDJ6tB66MxXyo';

/** A status page's JSON (at most 8 MiB, no redirect followed, 15 s). */
export async function fetchStatus(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (res.status !== 200 || !res.body) throw new Error(`status ${res.status}`);
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > 8 << 20) throw new Error('too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

interface GoogleIncident {
  end?: string;
  severity?: string;
  external_desc?: string;
  affected_products?: { id?: string }[];
}

/** Antigravity's state: its open incidents of Google's feed. */
function googleStatus(incidents: GoogleIncident[]): Omit<StatusPage, 'url'> {
  const sp: Omit<StatusPage, 'url'> = { indicator: 'none' };
  for (const i of incidents) {
    if (i.end || !i.affected_products?.some((p) => p.id === ANTIGRAVITY_PRODUCT)) continue;
    if (sp.indicator !== 'major')
      [sp.indicator, sp.description] = [i.severity === 'high' ? 'major' : 'minor', i.external_desc || undefined];
  }
  return sp;
}

/** An account's key: provider:id, else per machine (and Codex home). */
const keyOf = (a: Account, machine: string) => (a.id ? `${a.provider}:${a.id}` : `${a.provider}:@${machine}${a.home ? `:${a.home}` : ''}`);
/** The skipLocal entry of an account without an id. */
const localSkip = (a: Account) => (a.home ? `${a.provider}:${a.home}` : a.provider);
const hasNumbers = (a: Account) => !!a.windows?.length || !!a.credits || !!a.balances?.length;

/** Orders a poll's answers for one account, the best first: numbers from
 * the provider, numbers from elsewhere (a log), an expired sign-in, a
 * failed request, a refused sign-in. */
function rank(a: Account): number {
  if (a.status === 'ok') return 0;
  if (hasNumbers(a)) return 1;
  return a.status === 'stale' ? 2 : a.status === 'error' ? 3 : 4;
}

const sorted = <T>(m: Map<string, T>): Record<string, T> => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export interface UsageDeps {
  settings: Pick<Settings, 'bool' | 'string' | 'number' | 'get'>;
  limits(m: string, p: LimitsParams, signal: AbortSignal): Promise<Account[]>;
  cost: SpendDeps['cost'];
  /** The machines connected now, the local one first. */
  ready(): string[];
  /** Whether a machine is configured. */
  known(m: string): boolean;
  /** Whether a machine is actively disabled by the user. */
  disabled?(m: string): boolean;
  readOnly(): boolean;
  /** Whether the feature is on. */
  enabled(): boolean;
  broadcast(s: Snapshot): void;
  log: Logger;
  store: UsageStore;
  now?: () => number;
  status?: (url: string, signal: AbortSignal) => Promise<unknown>;
  /** How often the scheduler looks whether a poll is due (TICK). */
  tickMs?: number;
}

export class Usage {
  private readonly d: UsageDeps;
  readonly now: () => number;
  readonly spend: Spend;
  readonly history = new History();
  readonly accounts = new Map<string, Kept>();
  private readonly machines = new Map<string, MachineView>();
  private readonly status = new Map<string, StatusPage>();
  /** The alerts fired in the last ALERT_KEEP. */
  private recent: Alert[] = [];
  /** ms; 0: never. */
  private updatedAt = 0;
  lastPoll = 0;
  private lastWatch = 0;
  polling = false;
  /** machine|terminal of the coding agents working. */
  readonly working = new Set<string>();
  private refreshPending = false;
  private forceRefresh = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** The machines connected, and those that connected since the last
   * poll, asked on their own at the next tick. */
  private readonly readyNow = new Set<string>();
  private readonly joined = new Set<string>();
  private wakeUp: (() => void) | undefined;
  private woken = false;
  private readonly life = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
  private loadingHistory?: Promise<void>;

  constructor(d: UsageDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.spend = new Spend({
      cost: d.cost,
      ready: d.ready,
      known: d.known,
      disabled: d.disabled,
      options: () => this.options(),
      prices: () => this.prices(),
      store: d.store,
      now: this.now,
      life: this.life.signal,
    });
  }

  private sec(): number {
    return Math.floor(this.now() / 1000);
  }

  /** The providers on (["none"] for none), the Codex homes, and the
   * options of the machines' reads. A read-only hub never has a machine
   * renew Kimi Code's sign-in, which rewrites its credentials file there. */
  options(): { providers: string[]; codexHomes: string[]; claudeKeychain: boolean; kimiRefresh: boolean } {
    const st = this.d.settings;
    const providers = PROVIDERS.filter((p) => st.bool(`usage.providers.${p}`));
    const homes = st.get('usage.codexHomes');
    return {
      providers: providers.length ? providers : ['none'],
      codexHomes: Array.isArray(homes) ? homes : [],
      claudeKeychain: st.bool('usage.claudeKeychain'),
      kimiRefresh: st.bool('usage.kimiRefresh') && !this.d.readOnly(),
    };
  }

  /** The user's prices (usage.prices) and a key that tells them apart. */
  prices(): { own?: ReturnType<typeof parsePrices>; key: string } {
    const lines = this.d.settings.get('usage.prices');
    try {
      const own = parsePrices(Array.isArray(lines) ? lines : []);
      return Object.keys(own).length ? { own, key: (lines as string[]).join('\n') } : { key: '' };
    } catch {
      return { key: '' };
    }
  }

  private mode(): string {
    const m = this.d.settings.string('usage.refresh');
    return (REFRESH_MODES as readonly string[]).includes(m) ? m : 'adaptive';
  }

  private cadence(): Cadence {
    const min = (key: string, d: number) => {
      const n = this.d.settings.number(key);
      return n >= 1 ? Math.trunc(n) * 60_000 : d;
    };
    return {
      open: min('usage.refreshOpen', DEFAULT_CADENCE.open),
      working: min('usage.refreshWorking', DEFAULT_CADENCE.working),
      idle: min('usage.refreshIdle', DEFAULT_CADENCE.idle),
    };
  }

  private alertsOn(): boolean {
    return this.d.settings.bool('usage.alerts');
  }

  interval(): number {
    const watching = this.lastWatch > 0 && this.now() - this.lastWatch < WATCH_FOR;
    return interval(this.mode(), watching, this.working.size > 0, this.cadence());
  }

  /** The open panel's GET ?watch=1. */
  watch(): void {
    this.lastWatch = this.now();
  }

  /** Whether a poll is due: a machine is connected, and a manual refresh
   * is pending and MIN_REFRESH_GAP has passed, or the cadence has passed
   * since the last poll. */
  due(): boolean {
    if (this.polling || this.d.ready().length === 0) return false;
    const since = this.now() - this.lastPoll;
    if (this.refreshPending && (this.lastPoll === 0 || since >= MIN_REFRESH_GAP)) return true;
    const iv = this.interval();
    return iv > 0 && (this.lastPoll === 0 || since >= iv);
  }

  /** Asks for a poll as soon as MIN_REFRESH_GAP since the last one allows,
   * and returns when that is (ms); requests before then share it. */
  refresh(): number {
    const now = this.now();
    let at = now;
    if (this.polling) at = now + MIN_REFRESH_GAP;
    else if (this.lastPoll > 0 && this.lastPoll + MIN_REFRESH_GAP > now) at = this.lastPoll + MIN_REFRESH_GAP;
    this.refreshPending = true;
    this.forceRefresh = true;
    if (at > now) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.wake(), at - now);
      this.refreshTimer.unref?.();
    } else this.wake();
    return at;
  }

  /** Makes the scheduler look whether a poll is due. */
  private wake(): void {
    if (this.wakeUp) this.wakeUp();
    else this.woken = true;
  }

  /** A machine's state: one that connected after the first poll is asked
   * at the next tick; one that went away takes its agents along. */
  onMachine(st: { id: string; status: string }): void {
    if (st.status === 'ready') {
      const joined = !this.readyNow.has(st.id) && this.lastPoll > 0;
      this.readyNow.add(st.id);
      if (joined) {
        this.joined.add(st.id);
        this.wake();
      }
      return;
    }
    this.readyNow.delete(st.id);
    this.joined.delete(st.id);
    this.dropAgents(st.id);
    if (st.status === 'disabled') {
      this.machines.set(st.id, { status: 'disabled', at: this.sec() });
      for (const a of this.accounts.values()) {
        if (!a.issues) continue;
        const left = a.issues.filter((i) => i.machine !== st.id);
        a.issues = left.length ? left : undefined;
      }
      this.spend.invalidate();
      if (this.updatedAt > 0) this.broadcast();
    }
  }

  /** An agent event: which coding agents work (the adaptive cadence). */
  onAgent(ev: { m: string; data: unknown }): void {
    const d = ev.data as { terminal?: unknown; agent_status?: unknown } | null;
    if (typeof d?.terminal !== 'string' || !d.terminal) return;
    const k = `${ev.m}|${d.terminal}`;
    if (d.agent_status === 'working') this.working.add(k);
    else this.working.delete(k);
  }

  private dropAgents(m: string): void {
    for (const k of this.working) if (k.startsWith(`${m}|`)) this.working.delete(k);
  }

  /** Drops what is kept of a removed machine (its last spend too). */
  forget(m: string): void {
    this.spend.forget(m);
    this.machines.delete(m);
    this.readyNow.delete(m);
    this.joined.delete(m);
    this.dropAgents(m);
  }

  /** Runs the scheduler until signal ends. */
  async run(signal: AbortSignal): Promise<void> {
    if (this.d.store.file) await this.loadHistory();
    for (const m of this.d.ready()) this.readyNow.add(m);
    let lastStatus = -Infinity;
    try {
      while (!signal.aborted) {
        if (this.d.enabled()) {
          if (this.now() - lastStatus >= STATUS_EVERY) {
            lastStatus = this.now();
            this.track(this.pollStatus(signal));
          }
          await this.pollDue(signal);
        }
        if (this.woken) {
          this.woken = false;
          continue;
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            this.wakeUp = undefined;
            resolve();
          };
          const timer = setTimeout(done, this.d.tickMs ?? TICK);
          signal.addEventListener('abort', done, { once: true });
          this.wakeUp = done;
        });
      }
    } finally {
      clearTimeout(this.refreshTimer);
      this.life.abort();
      while (this.tasks.size > 0) await Promise.all(this.tasks);
    }
  }

  private track(p: Promise<void>): void {
    const t = p.catch((e: unknown) => this.d.log(`usage: ${(e as Error).message}`)).finally(() => this.tasks.delete(t));
    this.tasks.add(t);
  }

  /** Polls every machine when that is due, else the machines that
   * connected since the last poll. */
  async pollDue(signal: AbortSignal): Promise<void> {
    if (this.due()) return this.poll(signal);
    if (this.polling || this.joined.size === 0 || this.mode() === 'manual') return;
    const ms = this.d.ready().filter((m) => this.joined.has(m));
    this.joined.clear();
    if (ms.length > 0) await this.poll(signal, ms);
  }

  /** Asks machines in turn: every connected one, or only those that joined
   * since the last poll, which skip the accounts read within the cadence
   * and leave the cadence as it was. */
  async poll(signal: AbortSignal, only?: string[]): Promise<void> {
    if (this.polling) return;
    const joined = only !== undefined;
    let now = this.now();
    const showStart = this.updatedAt === 0 || this.refreshPending || (this.lastWatch > 0 && now - this.lastWatch < WATCH_FOR);
    const force = !joined && this.forceRefresh;
    const ready = only ?? this.d.ready();
    if (!joined) {
      this.refreshPending = false;
      this.forceRefresh = false;
      this.joined.clear();
    }
    if (ready.length === 0) return;
    this.polling = true;
    try {
      const iv = this.interval();
      // Accounts a provider asked to wait for (Retry-After) are skipped
      // until then: by id on every machine, those without an id on theirs.
      // Machines that joined skip the accounts read within the cadence too.
      const skip: string[] = [];
      const local = new Map<string, string[]>();
      for (const [k, a] of this.accounts) {
        const recent = joined && !!a.account.id && a.account.status === 'ok' && now - a.fetchedAt * 1000 < iv;
        if (!(a.notBefore > now) && !recent) continue;
        if (a.account.id) {
          skip.push(k);
          continue;
        }
        for (const m of ready) if (k === keyOf(a.account, m)) local.set(m, [...(local.get(m) ?? []), localSkip(a.account)]);
      }
      if (showStart) this.broadcast();

      const o = this.options();
      const seen = new Map<string, string[]>();
      const results = new Map<string, MachineView>();
      // Providers definitively reported by each machine that answered ok:
      // any non-error account, or a missing status that is not a transient
      // absence (not_running / keychain). Used to evict switched-out accounts.
      const reportedProviders = new Map<string, Set<string>>();
      // fresh: the answers with something to show; named: every answer
      // that names its account (an id), skipped ones too.
      const fresh: [string, Account][] = [];
      const named: [string, Account][] = [];
      for (const m of ready) {
        if (this.d.disabled?.(m)) {
          results.set(m, { status: 'disabled', at: this.sec() });
          continue;
        }
        const params: LimitsParams = {
          providers: o.providers,
          codexHomes: o.codexHomes.length ? o.codexHomes : undefined,
          claudeKeychain: o.claudeKeychain || undefined,
          skip: skip.length ? [...skip] : undefined,
          skipLocal: local.get(m),
          kimiRefresh: o.kimiRefresh || undefined,
          ...(force ? { force: true } : {}),
        };
        let accounts: Account[];
        try {
          accounts = await this.d.limits(m, params, signal);
        } catch (e) {
          results.set(
            m,
            this.d.disabled?.(m) ? { status: 'disabled', at: this.sec() } : { status: 'error', code: codeOf(e), at: this.sec() },
          );
          continue;
        }
        if (this.d.disabled?.(m)) {
          results.set(m, { status: 'disabled', at: this.sec() });
          continue;
        }
        results.set(m, { status: 'ok', at: this.sec() });
        const provs = new Set<string>();
        const ambiguous = new Set<string>();
        for (const a of accounts) {
          if (a.status === 'missing') {
            if (a.code !== 'not_running' && a.code !== 'keychain') provs.add(a.provider);
            continue;
          }
          if (a.status === 'error' || (!a.id && (a.status === 'stale' || a.status === 'unauth' || a.status === 'skipped'))) {
            ambiguous.add(a.provider);
          } else {
            provs.add(a.provider);
          }
          const k = keyOf(a, m);
          seen.set(k, [...(seen.get(k) ?? []), m]);
          if (a.id) named.push([m, a]);
          if (a.status === 'skipped') continue;
          fresh.push([m, a]);
          if (a.id && (a.status === 'ok' || (a.retryAfter ?? 0) > 0)) skip.push(k);
        }
        for (const p of ambiguous) provs.delete(p);
        reportedProviders.set(m, provs);
      }

      now = this.now();
      const nowSec = Math.floor(now / 1000);
      // Per account the best answer of this poll counts, whatever the
      // order the machines answered in; machines whose answer was not ok
      // are the account's issues (unless the machine is actively disabled).
      const best = new Map<string, [string, Account]>();
      const issues = new Map<string, Issue[]>();
      for (const [m, a] of fresh) {
        const k = keyOf(a, m);
        if (a.status !== 'ok' && !this.d.disabled?.(m))
          issues.set(k, [...(issues.get(k) ?? []), { machine: m, status: a.status, code: a.code }]);
        const b = best.get(k);
        if (!b || rank(a) < rank(b[1])) best.set(k, [m, a]);
      }
      const read = new Set<string>();
      const prev = new Map<string, Window[]>();
      for (const [k, [, a]] of best) {
        const cur = this.accounts.get(k);
        if (cur) prev.set(k, cur.account.windows ?? []);
        this.merge(k, a, now);
        this.accounts.get(k)!.issues = issues.get(k);
        read.add(k);
      }
      // An account seen lists the machines that saw it, and keeps those it
      // was seen on that did not answer this poll (or were not asked).
      for (const [k, ms] of seen) {
        const a = this.accounts.get(k);
        if (!a) continue;
        for (const m of a.machines) if (results.get(m)?.status !== 'ok' && !ms.includes(m)) ms.push(m);
        a.machines = ms;
        a.seenAt = nowSec;
      }
      // A machine that names an account it reported without an id before
      // replaces that account at once, also when it was told to skip it.
      for (const [m, a] of named) {
        const stand = keyOf({ ...a, id: undefined }, m);
        if (!seen.has(stand)) this.accounts.delete(stand);
      }
      // A machine that answered ok and definitively reported a provider no
      // longer hosts any other account of that provider: remove it from
      // stale accounts immediately so account switches take effect at once.
      for (const [k, a] of this.accounts) {
        const before = a.machines.length;
        const next = a.machines.filter(
          (m) => !(results.get(m)?.status === 'ok' && reportedProviders.get(m)?.has(a.account.provider) && !seen.get(k)?.includes(m)),
        );
        if (next.length !== before) {
          if (next.length === 0) {
            this.accounts.delete(k);
            continue;
          }
          a.machines = next;
          if (a.issues) {
            const left = a.issues.filter((i) => next.includes(i.machine));
            a.issues = left.length ? left : undefined;
          }
        }
      }
      for (const [k, a] of this.accounts) if (nowSec - a.seenAt > FORGET_AFTER) this.accounts.delete(k);
      for (const [m, v] of results) this.machines.set(m, v);
      if (!joined)
        for (const [m, v] of this.machines)
          if (!ready.includes(m)) this.machines.set(m, { status: this.d.disabled?.(m) ? 'disabled' : 'offline', at: v.at });
      this.history.record(this.accounts, read, nowSec);
      if (this.alertsOn()) {
        const ths = thresholds(this.listSetting('usage.thresholds'));
        this.recent.push(...fireAlerts(this.accounts, read, prev, this.history, ths, nowSec));
        this.recent = this.recent.filter((a) => nowSec - a.at <= ALERT_KEEP && this.accounts.has(a.key));
      }
      this.updatedAt = now;
      if (!joined) this.lastPoll = now;
    } finally {
      this.polling = false;
    }
    await this.save();
    this.broadcast();
  }

  private listSetting(key: string): string[] {
    const v = this.d.settings.get(key);
    return Array.isArray(v) ? v : [];
  }

  /** Takes a machine's answer for an account: numbers when it has them,
   * else the last good numbers stay with the new status and code. */
  private merge(key: string, a: Account, now: number): void {
    let cur = this.accounts.get(key);
    if (!cur) this.accounts.set(key, (cur = { key, account: a, machines: [], fetchedAt: 0, seenAt: 0, notBefore: 0 }));
    if ((a.retryAfter ?? 0) > 0) cur.notBefore = now + a.retryAfter! * 1000;
    if (a.status === 'ok' || (hasNumbers(a) && (cur.fetchedAt === 0 || (a.asOf ?? 0) >= cur.fetchedAt))) {
      cur.account = a;
      cur.fetchedAt = a.asOf || Math.floor(now / 1000);
      return;
    }
    // Keep the numbers; take the identity and the status.
    const old = cur.account;
    cur.account = {
      ...a,
      windows: old.windows,
      credits: old.credits,
      balances: old.balances,
      available: old.available,
      email: a.email || old.email,
      plan: a.plan || old.plan,
      source: old.source,
      asOf: old.asOf,
    };
  }

  /** The current state for the pages: the accounts of the providers on. */
  snapshot(): Snapshot {
    const on = this.options().providers;
    const now = this.sec();
    const iv = this.interval();
    let nextAt = iv > 0 && this.lastPoll > 0 ? Math.floor((this.lastPoll + iv) / 1000) : 0;
    if (this.refreshPending && this.lastPoll > 0) {
      const at = Math.floor((this.lastPoll + MIN_REFRESH_GAP) / 1000);
      if (nextAt === 0 || at < nextAt) nextAt = at;
    }
    const order = (p: string) => (PROVIDERS as readonly string[]).indexOf(p);
    const accounts = [...this.accounts.values()]
      .filter((a) => on.includes(a.account.provider))
      .sort((a, b) => order(a.account.provider) - order(b.account.provider) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((a) => {
        const ws = a.account.windows ?? [];
        const ids = windowIDs(ws);
        const windows: WindowView[] = ws.map((w, i) => ({
          ...w,
          id: ids[i]!,
          pace: pace(w, this.history.first(a.key, ids[i]!, w, now), now),
        }));
        return { ...keptJSON(a), windows };
      });
    const alerts = this.alertsOn()
      ? this.recent.filter((a) => now - a.at <= ALERT_KEEP && on.includes(a.provider) && this.accounts.has(a.key))
      : [];
    return {
      updatedAt: this.updatedAt ? Math.floor(this.updatedAt / 1000) : 0,
      refresh: this.mode(),
      interval: Math.floor(iv / 1000),
      nextAt: nextAt || undefined,
      polling: this.polling,
      accounts,
      machines: sorted(this.machines),
      status: sorted(this.status),
      alerts: alerts.length ? alerts : undefined,
    };
  }

  broadcast(): void {
    this.d.broadcast(this.snapshot());
  }

  /** Reads the status pages of the providers on; a page that does not
   * answer keeps what it said last (or stays a link). */
  async pollStatus(signal: AbortSignal): Promise<void> {
    const on = this.options().providers;
    const get = this.d.status ?? fetchStatus;
    const got = new Map<string, StatusPage>();
    await Promise.all(
      Object.entries(STATUS_PAGES)
        .filter(([p]) => on.includes(p))
        .map(async ([p, page]) => {
          got.set(p, { url: page });
          const url = STATUS_URLS[p];
          if (!url) return;
          let sp: Omit<StatusPage, 'url'> | undefined;
          try {
            const v = await get(url, signal);
            if (p === 'antigravity') sp = Array.isArray(v) ? googleStatus(v as GoogleIncident[]) : undefined;
            else {
              const s = (v as { status?: { indicator?: unknown; description?: unknown } } | null)?.status;
              if (typeof s?.indicator === 'string' && s.indicator)
                sp = {
                  indicator: s.indicator,
                  description: typeof s.description === 'string' && s.description ? s.description : undefined,
                };
            }
          } catch {
            // the page keeps what it said last
          }
          if (sp) got.set(p, { ...sp, url: page, at: this.sec() });
        }),
    );
    for (const [p, sp] of got) if (sp.indicator || !this.status.get(p)?.indicator) this.status.set(p, sp);
    for (const p of [...this.status.keys()]) if (!got.has(p)) this.status.delete(p);
    this.broadcast();
  }

  /** The snapshot's ETag: of its poll-driven state, without the drift of
   * the paces from second to second, so the open panel's heartbeat gets
   * 304 between polls. */
  static etag(s: Snapshot): string {
    const accounts = s.accounts.map((a) => {
      const v = a as { windows: WindowView[] };
      return { ...v, windows: v.windows.map((w) => (w.pace ? { ...w, pace: { beforeReset: w.pace.beforeReset } } : w)) };
    });
    return jsonETag('u', { ...s, accounts });
  }

  /** Reads the history and the accounts the hub's database keeps into
   * what memory has; a read that failed is tried again by the next save. */
  async loadHistory(): Promise<void> {
    if (this.history.loaded) return;
    if (!this.d.store.file) {
      this.history.loaded = true;
      return;
    }
    this.loadingHistory ??= Promise.resolve(this.d.store.readHistory())
      .then((r) => {
        if (!r) return;
        const now = this.sec();
        this.history.merge(r.stored.history);
        this.history.prune(now);
        this.history.loaded = true;
        for (const a of r.stored.accounts) {
          if (!a.key || now - a.seenAt > FORGET_AFTER || this.accounts.has(a.key)) continue;
          this.accounts.set(a.key, a);
        }
      })
      .finally(() => (this.loadingHistory = undefined));
    await this.loadingHistory;
  }

  /** Writes the history into the hub's database, once it was read back
   * from there. */
  async save(): Promise<void> {
    if (!this.d.store.file) return;
    if (!this.history.loaded) await this.loadHistory();
    if (this.history.loaded) await this.d.store.writeHistory(this.history, this.accounts.values());
  }
}
