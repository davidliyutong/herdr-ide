// The cost action: the CLIs' logs on the machine read (only what changed
// since they were last read) and their tokens summed by day, provider,
// model and project at API prices, and by provider and quarter of an hour
// from recentSince on.
//
// What was read of each log is kept per agent (its records, its size and
// time, the offset after its last complete line) and in the machine's
// database (cache.ts), read again only when another agent of the instance
// saved since. An unchanged log is not read again, a grown one is read on
// from its offset, a rewritten one from its start; databases are read
// whole when they or their log changed. Logs and records older than
// RETENTION leave the cache at each scan. The changes are saved in one
// transaction at most every costPersistEveryMs (or after
// costPersistBytes of logs), every costSaveEveryMs during a long scan, and
// when a scan is cut short, so a scan never starts over.
//
// One scan runs at a time per agent. Its work is reading files with
// fs/promises in chunks and SQLite in worker threads, parsing lines in
// between. The node's other sessions get the thread between chunks, and
// the summing yields every few milliseconds.
import { randomBytes, createHash } from 'node:crypto';
import { readdir, stat, type FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import type { z } from 'zod';
import type { costReport } from '../protocol.ts';
import { cacheState, dropStale, loadCache, saveCache } from './cache.ts';
import type { CacheWorker } from './cache-worker.ts';
import { DB_LIMITS, DBError, dbFiles, readAntigravity, readOpenCode, type DBLimits, type DBRead } from './databases.ts';
import { SQLiteWorker } from './sqlworker.ts';
import { expand, getenv, type UsageEnv } from './env.ts';
import { claudeDir, codexHomes, grokHome } from './limits.ts';
import { kimiHome } from './kimi.ts';
import { NotRegular, endsLine, openRegular, readGzLines, readLines, walk } from './logs.ts';
import {
  LOG,
  claudeLine,
  codexParser,
  grokEvent,
  grokUnified,
  grokUpdate,
  kimiLine,
  kimiProject,
  kimiStateFile,
  providerOf,
  type Entry,
  type Rec,
} from './parsers.ts';
import { OPENCODE_TABLES, antigravityTable, pricingWith, tierCost, tierOf, type ModelPrice, type Tier } from './pricing.ts';

/** How far back logs are read and records kept, in seconds. */
export const RETENTION = 90 * 86400;
/** The length of a quarter of an hour's slot, in seconds. */
export const SLOT = 900;

/** What a scan reports (the action's params). */
export interface CostOptions {
  /** The first instant reported (Unix seconds; at most RETENTION back). */
  since: number;
  /** The user's time zone, in minutes east of UTC: days are the user's. */
  tzOffset?: number;
  codexHomes?: string[];
  providers?: string[];
  /** The user's prices over the table's. */
  prices?: Record<string, Tier>;
  /** When given, the slots from that instant on. */
  recentSince?: number;
  /** The ETag of the caller's last report. */
  ifNoneMatch?: string;
}

export type CostReport = z.input<typeof costReport>;

/** A log to read and its kind. */
interface LogFile {
  path: string;
  kind: string;
}

/** The time of every few records the summing yields after. */
const SLICE_MS = 8;

/** Lets the node's other work in when the current slice of work ran for
 * SLICE_MS. */
class Slicer {
  private at = performance.now();
  private n = 0;

  /** Whether the slice ran long enough to pause (looked at every 1024
   * calls). */
  due(): boolean {
    return (++this.n & 1023) === 0 && performance.now() - this.at >= SLICE_MS;
  }

  async pause(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((r) => setImmediate(r));
    this.at = performance.now();
    signal?.throwIfAborted();
  }
}

/** One record per key, the one with the most output (the first of
 * equals), where the key first was: Claude logs a streamed response once
 * per content block, each line with the usage so far. Records without a
 * key all stay. */
export function dedupe(rs: Rec[]): Rec[] {
  let at: Map<string, number> | undefined;
  const out: Rec[] = [];
  for (const r of rs) {
    if (!r.k) {
      out.push(r);
      continue;
    }
    at ??= new Map();
    const i = at.get(r.k);
    if (i === undefined) {
      at.set(r.k, out.length);
      out.push(r);
    } else if (r.o > out[i]!.o) out[i] = r;
  }
  return out;
}

/** OpenCode's databases: $OPENCODE_DB (relative to its data directory)
 * when set, else every channel's in the data directory. */
export async function openCodeDBs(e: UsageEnv): Promise<string[]> {
  const xdg = getenv(e, 'XDG_DATA_HOME');
  const dir = xdg ? posix.join(expand(e.home, xdg), 'opencode') : posix.join(e.home, '.local/share/opencode');
  const db = getenv(e, 'OPENCODE_DB');
  if (db) {
    if (db === ':memory:') return [];
    return [posix.isAbsolute(db) ? db : posix.join(dir, db)];
  }
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && (d.name === 'opencode.db' || (d.name.startsWith('opencode-') && d.name.endsWith('.db'))))
      .map((d) => posix.join(dir, d.name))
      .sort();
  } catch {
    return [];
  }
}

/** Antigravity's conversation databases (desktop, CLI, IDE). */
export async function antigravityDBs(e: UsageEnv): Promise<string[]> {
  const out: string[] = [];
  for (const sub of ['.gemini/antigravity', '.gemini/antigravity-cli', '.gemini/antigravity-ide']) {
    const dir = posix.join(e.home, sub, 'conversations');
    try {
      for (const d of await readdir(dir, { withFileTypes: true }))
        if (d.isFile() && d.name.endsWith('.db')) out.push(posix.join(dir, d.name));
    } catch {
      // none
    }
  }
  return out.sort();
}

/** The logs of the providers o selects. */
async function costLogs(e: UsageEnv, o: CostOptions): Promise<LogFile[]> {
  const want = (p: string) => !o.providers?.length || o.providers.includes(p);
  const out: LogFile[] = [];
  const add = async (root: string, kind: string, match: (rel: string) => boolean) => {
    for (const rel of await walk(root, match, e.signal)) out.push({ path: posix.join(root, rel), kind });
  };
  const parts = (p: string) => p.split('/');
  if (want('claude')) {
    const roots = [...new Set([posix.join(claudeDir(e), 'projects'), posix.join(e.home, '.config/claude/projects')])];
    for (const r of roots) await add(r, LOG.claude, (p) => p.endsWith('.jsonl'));
  }
  if (want('codex')) {
    for (const h of codexHomes(e, o.codexHomes))
      for (const d of ['sessions', 'archived_sessions']) await add(posix.join(h, d), LOG.codex, (p) => p.endsWith('.jsonl'));
  }
  if (want('grok')) {
    const g = grokHome(e);
    await add(posix.join(g, 'sessions'), LOG.grok, (p) => parts(p).length === 3 && parts(p)[2] === 'updates.jsonl');
    await add(posix.join(g, 'sessions'), LOG.grokEvents, (p) => parts(p).length === 3 && parts(p)[2] === 'events.jsonl');
    await add(posix.join(g, 'logs'), LOG.grokLegacy, (p) => !p.includes('/') && p.startsWith('unified.jsonl'));
  }
  if (want('antigravity')) for (const p of await antigravityDBs(e)) out.push({ path: p, kind: LOG.antigravity });
  if (want('kimi')) {
    await add(posix.join(kimiHome(e), 'sessions'), LOG.kimi, (p) => {
      const s = parts(p);
      return (s.length === 5 && s[2] === 'agents' && s[4] === 'wire.jsonl') || (s.length === 3 && s[2] === 'wire.jsonl');
    });
  }
  if (want('opencode')) for (const p of await openCodeDBs(e)) out.push({ path: p, kind: LOG.opencode });
  return out;
}

/** A log's size and time (ns), which tell whether it changed: for SQLite
 * databases with their log's, where commits go first. null when it is not
 * a regular file. */
async function stampOf(lf: LogFile, uid: number): Promise<{ size: number; mtime: number } | null> {
  try {
    // A database, its log and the files SQLite opens beside it: regular
    // files of the user, none a link (dbFiles), else no database.
    if (lf.kind === LOG.opencode || lf.kind === LOG.antigravity) return await dbFiles(lf.path, uid);
    const st = await stat(lf.path, { bigint: true });
    if (!st.isFile()) return null;
    return { size: Number(st.size), mtime: Number(st.mtimeNs) };
  } catch {
    return null;
  }
}

/** The project of a Kimi Code wire log, from its session's state.json. */
async function kimiProjectOf(file: string): Promise<string> {
  let state: string | null = null;
  try {
    const fh = await openRegular(kimiStateFile(file));
    try {
      const b = Buffer.alloc(64 << 10);
      const { bytesRead } = await fh.read(b, 0, b.length, 0);
      state = b.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    // its workspace's name
  }
  return kimiProject(file, state);
}

/** The line reader of a log of kind into ent (its records, models and
 * parser state); done() settles the parser's state. */
async function lineParser(kind: string, path: string, ent: Entry): Promise<{ line: (l: string) => void; done(): void }> {
  const out = ent.records;
  switch (kind) {
    case LOG.claude:
      return { line: (l) => claudeLine(path, l, out), done() {} };
    case LOG.codex: {
      const p = codexParser(path, ent.codex, out);
      return { line: p.line, done: () => (ent.codex = p.state()) };
    }
    case LOG.grok:
      return { line: (l) => grokUpdate(path, l, out), done() {} };
    case LOG.grokLegacy:
      return { line: (l) => grokUnified(l, out), done() {} };
    case LOG.grokEvents: {
      const models = (ent.models ??= {});
      return { line: (l) => grokEvent(l, models), done() {} };
    }
    case LOG.kimi: {
      const proj = out[0]?.j || (await kimiProjectOf(path));
      return { line: (l) => kimiLine(proj, l, out), done() {} };
    }
  }
  return { line() {}, done() {} };
}

/** Reads a log into ent (whose size and mtime are the file's): on from
 * where old ended when the log only grew (old's records, models and parser
 * state carried over), else from the start; its last line counts once it
 * ends (all of a compressed log). Databases are read whole, from since on.
 * The bytes read. */
export async function parseLog(lf: LogFile, old: Entry | undefined, ent: Entry, since: number, db: DBRead): Promise<number> {
  const signal = db.signal;
  if (lf.kind === LOG.opencode) {
    ent.records = await readOpenCode(lf.path, since, db);
    return ent.size;
  }
  if (lf.kind === LOG.antigravity) {
    ent.records = await readAntigravity(lf.path, since, Math.floor(ent.mtime / 1e9), db);
    return ent.size;
  }
  const fh: FileHandle = await openRegular(lf.path);
  try {
    if (lf.path.endsWith('.gz')) {
      const p = await lineParser(lf.kind, lf.path, ent);
      await readGzLines(fh, p.line, signal);
      p.done();
      return ent.size;
    }
    let from = 0;
    if (
      old &&
      old.kind === lf.kind &&
      old.off > 0 &&
      old.off <= ent.size &&
      ent.mtime >= old.mtime &&
      (lf.kind !== LOG.codex || old.codex) &&
      (await endsLine(fh, old.off))
    ) {
      from = old.off;
      ent.records = old.records.slice();
      if (old.models) ent.models = { ...old.models };
      if (old.codex) ent.codex = { ...old.codex };
    }
    const p = await lineParser(lf.kind, lf.path, ent);
    ent.off = await readLines(fh, from, ent.size, false, p.line, signal);
    p.done();
    return ent.size - from;
  } finally {
    await fh.close();
  }
}

/** The code of a log that could not be read: too_large, busy, damaged
 * (a database's), or unreadable. */
const readFailure = (err: unknown): string => (err instanceof DBError ? err.code : 'unreadable');

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** The scans of an agent and what they keep. */
export class CostScanner {
  /** The cache in memory: null until the first scan loads it. */
  private files: Map<string, Entry> | null = null;
  /** The database's generation when this loaded or saved it. */
  private dbGen = 0;
  /** This agent's generation of the cache, bumped by every change. */
  private gen = 0;
  /** Entries changed and removed since the last save. */
  private readonly changed = new Set<string>();
  private readonly removed = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private scanning = false;
  /** Tells this agent's ETags from another's (whose generations count
   * from 0 too). */
  private readonly nonce = randomBytes(8).toString('hex');
  private readonly base: string;
  private readonly limits: DBLimits;
  private readonly cache?: CacheWorker;

  constructor(base: string, limits: DBLimits = DB_LIMITS, cache?: CacheWorker) {
    this.base = base;
    this.limits = limits;
    this.cache = cache;
  }

  /** Scans for o, after the scan before ended. */
  scan(e: UsageEnv, o: CostOptions): Promise<CostReport> {
    const p = this.queue.then(
      () => this.run(e, o),
      () => this.run(e, o),
    );
    this.queue = p.catch(() => {});
    return p;
  }

  /** A copy of the cache's entry of a log of kind at p, null when it has
   * none or a scan runs (a session is read again rather than waiting for a
   * scan, which may take minutes). */
  cachedEntry(p: string, kind: string): Entry | null {
    if (this.scanning || !this.files) return null;
    const ent = this.files.get(p);
    if (!ent || ent.kind !== kind) return null;
    return { ...ent, records: ent.records.slice(), codex: ent.codex && { ...ent.codex }, models: undefined };
  }

  /** The cache of a data directory no scan saved for RETENTION goes (the
   * feature is off there). */
  async housekeep(nowMs: number): Promise<void> {
    if (this.base && posix.isAbsolute(this.base) && !this.scanning) {
      const cutoff = nowMs - RETENTION * 1000;
      if (this.cache) await this.cache.sweep(cutoff);
      else dropStale(this.base, cutoff);
    }
  }

  private get dirty(): boolean {
    return this.changed.size > 0 || this.removed.size > 0;
  }

  /** The cache in memory, or the database's when another agent saved it
   * since. */
  private async acquire(signal: AbortSignal): Promise<Map<string, Entry>> {
    if (!this.base) return (this.files ??= new Map());
    try {
      if (this.files) {
        const saved = this.cache ? await this.cache.state(signal) : cacheState(this.base);
        if ((saved?.gen ?? 0) === this.dbGen) return this.files;
      }
      const { files, gen } = await (this.cache ? this.cache.load(signal) : loadCache(this.base));
      this.files = files;
      this.dbGen = gen;
      this.gen++;
      this.changed.clear();
      this.removed.clear();
      return files;
    } catch {
      signal.throwIfAborted();
      return (this.files ??= new Map());
    }
  }

  /** Saves what changed since the last save (at the wall clock's time: the
   * pace of the saves is the machine's, not the records'). */
  private async save(): Promise<void> {
    if (!this.base || !this.files || !this.dirty) return;
    try {
      const g = this.cache
        ? await this.cache.save(this.files, this.changed, this.removed, Date.now())
        : saveCache(this.base, this.files, this.changed, this.removed, Date.now());
      if (g === false) return;
      this.dbGen = g;
      this.changed.clear();
      this.removed.clear();
    } catch {
      // kept in memory, saved next time
    }
  }

  /** Whether a scan that changed the cache and read n bytes writes it:
   * none written yet, the last save is old enough, or it read enough. */
  private async persistDue(e: UsageEnv, n: number): Promise<boolean> {
    if (n >= e.t.costPersistBytes) return true;
    try {
      const s = this.cache ? await this.cache.state(e.signal) : cacheState(this.base);
      return !s || Date.now() - s.savedMs >= e.t.costPersistEveryMs;
    } catch {
      e.signal.throwIfAborted();
      return true;
    }
  }

  private async run(e: UsageEnv, o: CostOptions): Promise<CostReport> {
    this.scanning = true;
    try {
      return await this.scanNow(e, o);
    } catch (err) {
      // Cut short: what was read stays, saved now.
      await this.save();
      throw err;
    } finally {
      this.scanning = false;
    }
  }

  private async scanNow(e: UsageEnv, o: CostOptions): Promise<CostReport> {
    const cutoff = Math.floor(e.now() / 1000) - RETENTION;
    o = { ...o, since: Math.max(o.since, cutoff) };
    if (o.recentSince) o.recentSince = Math.max(o.recentSince, cutoff);
    const files = await this.acquire(e.signal);
    const seen = new Set<string>();
    const failed = new Set<string>();
    let read = 0;
    let lastSave = performance.now();
    const logs = await costLogs(e, o);
    // The databases' reads, in a worker of this scan's.
    const db: DBRead = { signal: e.signal, limits: this.limits, uid: e.uid, worker: new SQLiteWorker(this.limits.requestMs) };
    try {
      for (const lf of logs) {
        e.signal.throwIfAborted();
        if (this.dirty && performance.now() - lastSave >= e.t.costSaveEveryMs) {
          await this.save();
          lastSave = performance.now();
        }
        const st = await stampOf(lf, e.uid);
        if (!st || Math.floor(st.mtime / 1e9) < cutoff) continue;
        seen.add(lf.path);
        const old = files.get(lf.path);
        if (old && old.kind === lf.kind && old.size === st.size && old.mtime === st.mtime) continue;
        const ent: Entry = { kind: lf.kind, size: st.size, mtime: st.mtime, off: 0, records: [] };
        try {
          read += await parseLog(lf, old, ent, cutoff, db);
        } catch (err) {
          e.signal.throwIfAborted();
          failed.add(`${providerOf(lf.kind)}:${err instanceof NotRegular ? 'unreadable' : readFailure(err)}`);
          continue;
        }
        ent.records = dedupe(ent.records);
        files.set(lf.path, ent);
        this.changed.add(lf.path);
        this.removed.delete(lf.path);
        this.gen++;
      }
    } finally {
      db.worker!.close();
    }
    // Logs that are gone or too old leave the cache; those of providers
    // not selected stay as they are.
    const slicer = new Slicer();
    for (const [p, ent] of files) {
      if (!seen.has(p) && (!o.providers?.length || o.providers.includes(providerOf(ent.kind)))) {
        files.delete(p);
        this.changed.delete(p);
        this.removed.add(p);
        this.gen++;
        continue;
      }
      const kept = ent.records.filter((r) => r.t >= cutoff);
      if (kept.length !== ent.records.length) {
        ent.records = kept;
        this.changed.add(p);
        this.gen++;
      }
      if (slicer.due()) await slicer.pause();
    }
    if (this.dirty && this.base && (await this.persistDue(e, read))) await this.save();
    const fails = [...failed].sort();
    const etag = this.etag(o, fails);
    if (this.base && o.ifNoneMatch && o.ifNoneMatch === etag) return { since: o.since, rows: null, files: 0, etag, notModified: true };
    const rep = await aggregate(files, seen, o, e.signal);
    if (fails.length) rep.failed = fails;
    rep.etag = etag;
    return rep;
  }

  /** The ETag of a report of o: this agent's generation of the cache and
   * the options. */
  private etag(o: CostOptions, failed: string[]): string {
    const prices = Object.entries(o.prices ?? {}).sort(([a], [b]) => cmp(a, b));
    const key = [
      this.nonce,
      this.gen,
      o.since,
      o.tzOffset ?? 0,
      o.recentSince ?? 0,
      [...(o.providers ?? [])].sort(),
      [...(o.codexHomes ?? [])].sort(),
      failed,
      prices,
    ];
    return createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 16);
  }
}

type Row = CostReport['rows'] extends (infer R)[] | null | undefined ? R : never;
type Slot = NonNullable<CostReport['recent']>[number];

/** The records of the logs seen summed: deduplicated across logs (the
 * most output wins), by day, model and project from since on, by provider
 * and quarter of an hour from recentSince on. */
export async function aggregate(files: Map<string, Entry>, seen: Set<string>, o: CostOptions, signal?: AbortSignal): Promise<CostReport> {
  const rep: CostReport = { since: o.since, rows: [], files: 0 };
  const slicer = new Slicer();
  // Legacy Grok records name their session; its events name the model.
  const sid = new Map<string, string>();
  for (const [p, ent] of files) {
    if (!seen.has(p) || ent.kind !== LOG.grokEvents) continue;
    for (const [k, v] of Object.entries(ent.models ?? {})) if (!sid.has(k)) sid.set(k, v);
  }
  const from = o.recentSince ? Math.min(o.since, o.recentSince) : o.since;
  const best = new Map<string, { prov: string; r: Rec }>();
  const plain: { prov: string; r: Rec }[] = [];
  let retries = 0;
  let nfiles = 0;
  for (const p of [...files.keys()].sort()) {
    const ent = files.get(p)!;
    if (!seen.has(p) || ent.kind === LOG.grokEvents) continue;
    const prov = providerOf(ent.kind);
    nfiles++;
    for (let r of ent.records) {
      if (slicer.due()) await slicer.pause(signal);
      if (r.t < from) continue;
      if (r.e) {
        retries++;
        continue;
      }
      if (r.s && !r.m) r = { ...r, m: sid.get(r.s) || 'unknown' };
      if (!r.k) {
        plain.push({ prov, r });
        continue;
      }
      const b = best.get(r.k);
      if (!b || r.o > b.r.o) best.set(r.k, { prov, r });
    }
  }
  plain.push(...best.values());
  const rows = new Map<string, Row>();
  const slots = new Map<string, Slot>();
  const unpriced = new Set<string>();
  const tz = (o.tzOffset ?? 0) * 60;
  const days = new Map<number, string>();
  const dayOf = (t: number) => {
    const d = Math.floor((t + tz) / 86400);
    let s = days.get(d);
    if (s === undefined) days.set(d, (s = new Date(d * 86400_000).toISOString().slice(0, 10)));
    return s;
  };
  const prices = new Map<string, { key: string; price?: ModelPrice }>();
  for (const { prov, r } of plain) {
    if (slicer.due()) await slicer.pause(signal);
    // OpenCode's and Antigravity's steps by the table of the API that
    // served them (none for OpenCode's others: the user's prices only),
    // else at the cost OpenCode recorded.
    const table = prov === 'opencode' ? (OPENCODE_TABLES[r.v] ?? '') : prov === 'antigravity' ? antigravityTable(r.m) : prov;
    const pk = `${table}\0${r.m}`;
    let pw = prices.get(pk);
    if (!pw) prices.set(pk, (pw = pricingWith(table, r.m, o.prices)));
    let label = pw.key;
    let cost = 0;
    let priced = !!pw.price;
    if (pw.price) cost = tierCost(tierOf(pw.price, r.x || r.i + r.c + r.w + r.h), r.i, r.c, r.w, r.h, r.o);
    else if (r.p > 0) [label, cost, priced] = [r.m, r.p, true];
    else {
      label = r.m;
      if (r.t >= o.since) unpriced.add(`${prov}/${r.m}`);
    }
    if (o.recentSince && r.t >= o.recentSince) {
      const at = r.t - (r.t % SLOT);
      const sk = `${at}\0${prov}`;
      let s = slots.get(sk);
      if (!s) slots.set(sk, (s = { at, provider: prov, tokens: 0, requests: 0, cost: 0, priced: true }));
      s.tokens! += r.i + r.c + r.w + r.h + r.o;
      s.requests! += Math.max(r.n, 1);
      s.cost! += cost;
      s.priced = s.priced && priced;
    }
    if (r.t < o.since) continue;
    const day = dayOf(r.t);
    const rk = `${day}\0${prov}\0${label}\0${r.j}`;
    let row = rows.get(rk);
    if (!row) {
      row = { day, provider: prov, model: label, input: 0, cached: 0, cacheWrite: 0, output: 0, requests: 0, cost: 0, priced };
      if (r.j) row.project = r.j;
      rows.set(rk, row);
    }
    // A model some of whose steps OpenCode recorded no cost for.
    row.priced = row.priced && priced;
    row.input! += r.i;
    row.cached! += r.c;
    row.cacheWrite! += r.w + r.h;
    row.output! += r.o;
    if (r.r) row.reasoning = (row.reasoning ?? 0) + r.r;
    row.requests! += Math.max(r.n, 1);
    row.cost! += cost;
  }
  rep.rows = [...rows.values()].sort(
    (a, b) => cmp(a.day!, b.day!) || cmp(a.provider!, b.provider!) || cmp(a.model!, b.model!) || cmp(a.project ?? '', b.project ?? ''),
  );
  rep.files = nfiles;
  if (slots.size) rep.recent = [...slots.values()].sort((a, b) => cmp(a.at!, b.at!) || cmp(a.provider!, b.provider!));
  if (retries) rep.retries = retries;
  if (unpriced.size) rep.unpriced = [...unpriced].sort();
  return rep;
}
