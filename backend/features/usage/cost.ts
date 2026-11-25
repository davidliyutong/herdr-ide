// The spend: GET /api/p/usage/cost asks the connected machines in parallel
// for their logs' cost of the last days, merges their rows and quarters of
// an hour, and serves the report for a minute per range, time zone,
// providers, Codex homes and prices. A machine runs one scan at a time;
// requests for the same range share it, and the scan is bounded by its
// own time limit, not by the request that started it. The core keeps each
// machine's last reports with their ETags (also in its database), so that
// an unchanged machine answers notModified without its rows, and a
// disabled or offline machine's last report stays in the total until the
// machine is removed.
import { createHash } from 'node:crypto';
import pricing from '../../../spec/pricing/pricing.json' with { type: 'json' };
import { formatRFC3339, parseRFC3339 } from '#shared/lib/gotime.ts';
import { Fail } from '#kernel/fail.ts';
import { costReport, COST_MS, type CostParams, type CostReport, type CostRow, type CostSlot } from './protocol.ts';
import type { Store } from './store.ts';

/** How long a report is served again, in ms. */
export const COST_FRESH = 60_000;
/** How many reports (days|tz|…) are kept. */
const COST_KEEP = 4;
/** How many machines' reports are kept. */
const MACHINE_COST_KEEP = 64;
/** How far back the quarters of an hour go: past the start of a week's
 * window, in seconds. */
const RECENT_SPAN = 8 * 86_400;
/** The hours of a week and of a month the weekly and monthly equivalents
 * scale the range's cost to: the price table's, which the machines price
 * the logs with. */
export const WEEK_HOURS: number = pricing.weekHours;
export const MONTH_HOURS: number = pricing.monthHours;

/** How a machine's scan went. */
export interface MachineCost {
  error?: string;
  files: number;
  retries?: number;
  unpriced?: string[];
  failed?: string[];
}

/** GET /api/p/usage/cost. */
export interface Report {
  generatedAt: number;
  days: number;
  tzOffset: number;
  since: number;
  weekHours: number;
  monthHours: number;
  machines: Record<string, MachineCost>;
  rows: (CostRow & { machine: string })[];
  recentSince: number;
  recent: (CostSlot & { machine: string })[];
}

/** A machine's last report for a cost key, as the Go core kept it. */
interface Entry {
  machine: string;
  tzOffset: number;
  since: number;
  codexHomes?: string[];
  priceKey?: string;
  etag: string;
  rep: CostReport;
  /** ms */
  at: number;
}

/** What the spend uses of the feature. */
export interface SpendDeps {
  cost(m: string, p: CostParams, signal: AbortSignal): Promise<CostReport>;
  /** The machines connected now. */
  ready(): string[];
  /** Whether a machine is still configured (a removed one's report goes). */
  known(m: string): boolean;
  /** The providers on and the Codex homes. */
  options(): { providers: string[]; codexHomes: string[] };
  /** The user's prices and the key that tells them apart. */
  prices(): { own?: CostParams['prices']; key: string };
  store: Store;
  now(): number;
  /** Ends the scans when the core stops. */
  life: AbortSignal;
}

export const jsonETag = (prefix: string, v: unknown) =>
  `"${prefix}-${createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)}"`;

/** The error code of a failed call: the agent's, else failed. */
export const codeOf = (e: unknown) => (e instanceof Fail ? e.code : 'failed');

const sameList = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((x, i) => x === b[i]);
const sortedKeys = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** The day of t (Unix seconds) at tz minutes east of UTC. */
const dayOf = (t: number, tz: number) => new Date((t + tz * 60) * 1000).toISOString().slice(0, 10);

/** r narrowed to params: its days from params' since, its providers. */
function filtered(r: CostReport, params: CostParams): CostReport {
  const want = (p: string) => !params.providers?.length || params.providers.includes(p);
  const since = dayOf(params.since, params.tzOffset ?? 0);
  const rows = r.rows.filter((row) => row.day >= since && want(row.provider));
  const unpriced = [...new Set(rows.filter((row) => !row.priced).map((row) => `${row.provider}/${row.model}`))].sort();
  const recent = (r.recent ?? []).filter((s) => s.at >= (params.recentSince ?? 0) && want(s.provider));
  const failed = (r.failed ?? []).filter((f) => want(f.split(':')[0]!));
  return {
    since: params.since,
    rows,
    recent: recent.length ? recent : undefined,
    failed: failed.length ? failed : undefined,
    retries: r.retries,
    unpriced: unpriced.length ? unpriced : undefined,
    files: r.files,
    etag: undefined,
    notModified: undefined,
  };
}

export class Spend {
  private readonly d: SpendDeps;
  private readonly cache = new Map<string, { at: number; rep: Report; etag: string }>();
  private readonly entries = new Map<string, Entry>();
  private loaded = false;
  private readOnly = false;
  /** The scans under way, by machine. */
  readonly flights = new Map<string, { key: string; done: Promise<CostReport> }>();

  constructor(d: SpendDeps) {
    this.d = d;
  }

  /** The report of the last days (the user's: tz minutes east of UTC) and
   * its ETag. A request that gives up (signal) gets what arrived by then,
   * which is not served to others. */
  async report(days: number, tz: number, signal: AbortSignal): Promise<{ rep: Report; etag: string }> {
    this.load();
    const prices = this.d.prices();
    const o = this.d.options();
    const key = [days, tz, [...o.providers].sort().join(','), [...o.codexHomes].sort().join('\0'), prices.key].join('|');
    const now = this.d.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < COST_FRESH) return hit;
    const ready = this.d.ready();
    // From the start of the user's day days-1 days ago.
    const localDay = Math.floor((now / 1000 + tz * 60) / 86_400);
    const since = (localDay - (days - 1)) * 86_400 - tz * 60;
    let recentSince = Math.floor(now / 1000) - RECENT_SPAN;
    recentSince -= recentSince % 86_400;
    const params: CostParams = {
      since,
      tzOffset: tz || undefined,
      codexHomes: o.codexHomes.length ? o.codexHomes : undefined,
      providers: o.providers.length ? o.providers : undefined,
      prices: prices.own,
      recentSince,
    };
    const rep: Report = {
      generatedAt: Math.floor(now / 1000),
      days,
      tzOffset: tz,
      since,
      weekHours: WEEK_HOURS,
      monthHours: MONTH_HOURS,
      machines: {},
      rows: [],
      recentSince,
      recent: [],
    };
    const add = (m: string, r: CostReport) => {
      rep.machines[m] = { files: r.files, retries: r.retries, unpriced: r.unpriced, failed: r.failed };
      for (const row of r.rows) rep.rows.push({ ...row, machine: m });
      for (const s of r.recent ?? []) rep.recent.push({ ...s, machine: m });
    };
    await Promise.all(
      ready.map(async (m) => {
        try {
          add(m, await this.machine(m, key, params, prices.key, signal));
        } catch (e) {
          rep.machines[m] = { error: codeOf(e), files: 0 };
        }
      }),
    );
    // The last reports of the machines not connected (disabled, offline),
    // without asking them.
    const others = [...new Set([...this.entries.values()].map((e) => e.machine))]
      .filter((m) => m && !ready.includes(m) && this.d.known(m))
      .sort();
    for (const m of others) {
      const r = this.cached(m, key, params, prices.key);
      if (r) add(m, r);
    }
    rep.machines = sortedKeys(rep.machines);
    rep.rows.sort(
      (a, b) =>
        cmp(a.machine, b.machine) ||
        cmp(a.day, b.day) ||
        cmp(a.provider, b.provider) ||
        cmp(a.model, b.model) ||
        cmp(a.project ?? '', b.project ?? ''),
    );
    rep.recent.sort((a, b) => cmp(a.machine, b.machine) || a.at - b.at || cmp(a.provider, b.provider));
    const out = { rep, etag: jsonETag('c', { ...rep, generatedAt: 0 }) };
    if (signal.aborted) return out;
    // Fresh from when the scans ended, however long they took.
    this.cache.set(key, { at: this.d.now(), ...out });
    while (this.cache.size > COST_KEEP) {
      const oldest = [...this.cache].reduce((a, b) => (b[1].at < a[1].at ? b : a))[0];
      this.cache.delete(oldest);
    }
    return out;
  }

  /** Machine m's report for key: a scan of the same key under way is
   * shared, one of another is waited for. With a report of its own for
   * key, the machine is asked with its ETag and may answer notModified. */
  private async machine(m: string, key: string, params: CostParams, priceKey: string, signal: AbortSignal): Promise<CostReport> {
    for (;;) {
      const f = this.flights.get(m);
      if (!f) {
        const own = { key } as { key: string; done: Promise<CostReport> };
        own.done = this.scan(m, key, params, priceKey).finally(() => {
          if (this.flights.get(m) === own) this.flights.delete(m);
        });
        this.flights.set(m, own);
        return await own.done;
      }
      const done = f.done;
      const r = await new Promise<{ v: CostReport } | { e: unknown }>((resolve, reject) => {
        const gaveUp = () => reject(signal.reason);
        if (signal.aborted) return gaveUp();
        signal.addEventListener('abort', gaveUp, { once: true });
        void done
          .then(
            (v) => resolve({ v }),
            (e: unknown) => resolve({ e }),
          )
          .finally(() => signal.removeEventListener('abort', gaveUp));
      });
      if (f.key !== key) continue;
      if ('e' in r) throw r.e;
      return r.v;
    }
  }

  private async scan(m: string, key: string, params: CostParams, priceKey: string): Promise<CostReport> {
    const mcKey = `${m}|${key}`;
    const prev = this.entries.get(mcKey);
    const req = { ...params, ifNoneMatch: prev?.etag || undefined };
    const got = await this.d.cost(m, req, AbortSignal.any([AbortSignal.timeout(COST_MS), this.d.life]));
    const rep = got.notModified && prev ? prev.rep : got;
    const entry: Entry = {
      machine: m,
      tzOffset: params.tzOffset ?? 0,
      since: params.since,
      codexHomes: params.codexHomes,
      priceKey: priceKey || undefined,
      etag: rep.etag ?? '',
      rep,
      at: this.d.now(),
    };
    this.entries.set(mcKey, entry);
    const evicted: string[] = [];
    while (this.entries.size > MACHINE_COST_KEEP) {
      const k = this.evictable();
      this.entries.delete(k);
      evicted.push(k);
    }
    if ((!got.notModified || !prev) && !this.readOnly) this.d.store.saveMachineCost(mcKey, m, entryJSON(entry), evicted);
    return rep;
  }

  /** The oldest entry, of a machine with several if there is one: a
   * disabled machine's only report is kept. */
  private evictable(): string {
    const count = new Map<string, number>();
    for (const e of this.entries.values()) count.set(e.machine, (count.get(e.machine) ?? 0) + 1);
    const oldest = (multi: boolean) =>
      [...this.entries]
        .filter(([, e]) => !multi || count.get(e.machine)! > 1)
        .reduce<[string, Entry] | undefined>((a, b) => (!a || b[1].at < a[1].at ? b : a), undefined)?.[0];
    return oldest(true) ?? oldest(false)!;
  }

  /** Machine m's kept report for key, or its best match narrowed to
   * params. */
  private cached(m: string, key: string, params: CostParams, priceKey: string): CostReport | undefined {
    const exact = this.entries.get(`${m}|${key}`);
    if (exact) return exact.rep;
    let best: Entry | undefined;
    let bestScore = -1;
    for (const e of this.entries.values()) {
      if (e.machine !== m) continue;
      const score =
        (e.tzOffset === (params.tzOffset ?? 0) ? 8 : 0) +
        (e.since <= params.since ? 4 : 0) +
        ((e.priceKey ?? '') === priceKey ? 2 : 0) +
        (sameList(e.codexHomes, params.codexHomes) ? 1 : 0);
      if (!best || score > bestScore || (score === bestScore && (e.at > best.at || (e.at === best.at && e.since < best.since)))) {
        best = e;
        bestScore = score;
      }
    }
    return best && filtered(best.rep, params);
  }

  /** Reads the kept reports once (newer ones of memory stay). */
  private load(): void {
    if (this.loaded || !this.d.store.file) {
      this.loaded = true;
      return;
    }
    const r = this.d.store.readMachineCosts();
    if (!r) return;
    for (const [k, raw] of r.entries) {
      const e = entryOf(raw);
      const cur = this.entries.get(k);
      if (e && (!cur || e.at > cur.at)) this.entries.set(k, e);
    }
    this.readOnly = !r.writable;
    this.loaded = true;
  }

  /** Drops what is kept of a removed machine. */
  forget(m: string): void {
    for (const [k, e] of this.entries) if (e.machine === m) this.entries.delete(k);
    this.cache.clear();
    if (!this.readOnly) this.d.store.deleteMachineCosts(m);
  }
}

const entryJSON = (e: Entry) => ({ ...e, at: formatRFC3339(new Date(e.at)) });

function entryOf(raw: unknown): Entry | undefined {
  const o = raw as Partial<Record<keyof Entry, unknown>> | null;
  if (!o || typeof o.machine !== 'string' || !o.machine) return undefined;
  const rep = costReport.safeParse(o.rep);
  const at = typeof o.at === 'string' ? parseRFC3339(o.at) : null;
  if (!rep.success || !at) return undefined;
  const list = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length ? v : undefined);
  return {
    machine: o.machine,
    tzOffset: typeof o.tzOffset === 'number' ? o.tzOffset : 0,
    since: typeof o.since === 'number' ? o.since : 0,
    codexHomes: list(o.codexHomes),
    priceKey: typeof o.priceKey === 'string' && o.priceKey ? o.priceKey : undefined,
    etag: typeof o.etag === 'string' ? o.etag : '',
    rep: rep.data,
    at: at.getTime(),
  };
}
