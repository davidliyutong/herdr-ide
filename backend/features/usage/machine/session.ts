// What one session of a coding agent used (the status bar's session
// item): the records of the session's transcript and its subagents',
// read by the parsers the spend reads the CLIs' logs with and priced as
// the spend prices them, with the latest request's model and context.
//
// Only the lines that carry usage are decoded, and of them only the usage
// members are kept: no prompt, reply or tool output. The transcripts are
// opened by the locator that found them (as the files it found); nothing is
// opened here by name. A transcript the cost cache holds unchanged is not
// read again, nor one read here lately; one that grew is read on. At most
// 2 sessions are read at once; a transcript over MAX_SESSION_BYTES, or a
// session of more records than are held, is too large.
import { lstat, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import type { z } from 'zod';
import { Fail } from '#shared/lib/fail.ts';
import { validSessionId } from '#shared/agents/kinds.ts';
import { TranscriptCode } from '#shared/proto/agentproto/transcript.ts';
import {
  LIMITS,
  SessionError,
  TIMING,
  claudeInfoOf,
  claudeProjectDirs,
  clean,
  codexDays,
  mtimeOf,
  rolloutId,
  sameDir,
  type Resolver,
  type SessionFile,
} from '#machine/agents/sessions.ts';
import type { sessionUsage } from '../protocol.ts';
import {
  DB_LIMITS,
  DBError,
  dbFiles,
  readAntigravitySession,
  readAntigravitySummaries,
  readAntigravityTrajectory,
  readOpenCodeSession,
  type DBLimits,
  type DBRead,
} from './databases.ts';
import { isObj, obj, str, type UsageEnv } from './env.ts';
import { kimiHome } from './kimi.ts';
import { grokHome } from './limits.ts';
import { NotRegular, eachLineBackward, endsLine, openRegular, readLines } from './logs.ts';
import { LOG, claudeLine, claudeUsage, codexParser, grokUpdate, kimiLine, kimiModelName, type Entry, type Rec } from './parsers.ts';
import { OPENCODE_TABLES, antigravityTable, contextWindow, pricingWith, tierCost, tierOf, type Tier } from './pricing.ts';
import { RETENTION, antigravityDBs, dedupe, openCodeDBs, type CostScanner } from './scan.ts';
import { SQLiteWorker } from './sqlworker.ts';

/** A transcript of a session: its path (the key of what is kept of it)
 * and how to open it as the file the locator found (no symbolic link
 * followed). A subagent's gone by now fails to open (ENOENT) and is left
 * out. */
export interface Transcript {
  path: string;
  open(): Promise<FileHandle>;
}

/** Finds a session's transcripts, its own first, then its subagents'.
 * Throws Fail not_found (none yet), compressed or bad_params. */
export type LocateSession = (kind: string, session: string, signal: AbortSignal, codexHomes?: readonly string[]) => Promise<Transcript[]>;

/** The locator of the coding agents' sessions (backend/machine/agents),
 * which the agents feature and the chat host use too: a session's
 * transcript and its subagents', each opened as the file it located,
 * through no link; a subagent's that is not that file any more is gone
 * (ENOENT) and left out, the session's own is not found. */
export function sessionsLocator(r: Resolver): LocateSession {
  const opened = async (fh: Promise<FileHandle | null>): Promise<FileHandle> => {
    const h = await fh;
    if (!h) throw Object.assign(new Error('usage: the transcript is not the file located'), { code: 'ENOENT' });
    return h;
  };
  return async (kind, session, _signal, codexHomes) => {
    let f: SessionFile;
    try {
      f = await r.locate(kind, session, codexHomes);
    } catch (err) {
      if (!(err instanceof SessionError)) throw err;
      if (err.code === 'not_found') throw new Fail(TranscriptCode.NotFound, 404, 'usage: no transcript of the session');
      if (err.code === 'compressed') throw new Fail(TranscriptCode.Compressed, 400, "usage: the session's transcript is compressed");
      throw new Fail('bad_params', 400, 'usage: not a session of an agent whose sessions are priced');
    }
    return [
      { path: f.path, open: () => opened(f.open()) },
      ...f.subagents.map((path, i) => ({ path, open: () => opened(f.openSubagent(i)) })),
    ];
  };
}

export type SessionUsage = z.input<typeof sessionUsage>;

/** Bounds of the session reads (tests make them small). */
export interface SessionLimits {
  /** A larger transcript is refused (too_large). */
  maxFileBytes: number;
  /** The records one read holds, of all its transcripts, and the bytes
   * they take: beyond, too_large. */
  maxRecords: number;
  maxHeldBytes: number;
  /** The transcripts whose last read is kept, and the bytes their records
   * take. */
  memoFiles: number;
  memoBytes: number;
  /** Reads at once; the others wait their turn. */
  parallel: number;
}

export const SESSION_LIMITS: SessionLimits = {
  maxFileBytes: 256 << 20,
  maxRecords: 200_000,
  maxHeldBytes: 48 << 20,
  memoFiles: 16,
  memoBytes: 48 << 20,
  parallel: 2,
};

/** How far back from a transcript's end the latest request's context is
 * looked for. */
const CONTEXT_BACK = 16 << 20;
/** Bounds the model's name in the answer. */
const MODEL_BYTES = 128;
/** About what a record takes besides its strings. */
const RECORD_BYTES = 136;

const recordBytes = (r: Rec) => RECORD_BYTES + r.k.length + r.m.length + r.s.length + r.j.length + r.v.length;

/** A session too large to read. */
const tooLarge = () => new Fail('too_large', 400, 'usage: a transcript of the session is too large');

/** The kind of log of a provider's file-based transcripts. */
const fileLogKind = (provider: string): string | undefined => {
  switch (provider) {
    case 'claude':
      return LOG.claude;
    case 'codex':
      return LOG.codex;
    case 'grok':
      return LOG.grok;
    case 'kimi':
      return LOG.kimi;
    default:
      return undefined;
  }
};

/** The provider of an agent kind whose sessions can be priced. */
export const SESSION_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'grok', 'kimi', 'antigravity', 'opencode']);

/** What a read of a transcript found, kept for the next. */
interface Read {
  ent: Entry;
  /** The file read (a file at the same name, size and time that is
   * another one is read again). */
  dev: bigint;
  ino: bigint;
  /** model, used and window were looked for (the session's own
   * transcript). */
  hasContext: boolean;
  model: string;
  used: number;
  window: number;
  bytes: number;
  use: number;
}

/** Counts the records one read holds. */
class Held {
  records = 0;
  bytes = 0;
  private readonly l: SessionLimits;

  constructor(l: SessionLimits) {
    this.l = l;
  }

  add(rs: readonly Rec[]): void {
    for (const r of rs) this.bytes += recordBytes(r);
    this.records += rs.length;
    if (this.records > this.l.maxRecords || this.bytes > this.l.maxHeldBytes) throw tooLarge();
  }
}

/** A model's name of at most MODEL_BYTES, cut at the start of a
 * character. */
export function cutModel(m: string): string {
  const b = Buffer.from(m, 'utf8');
  if (b.length <= MODEL_BYTES) return m;
  let i = MODEL_BYTES;
  while (i > 0 && (b[i]! & 0xc0) === 0x80) i--;
  return b.subarray(0, i).toString('utf8');
}

/** The sessions' reads of an agent and what they keep. */
export class SessionReader {
  private readonly memo = new Map<string, Read>();
  private memoBytes = 0;
  private use = 0;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly scanner: CostScanner;
  private readonly l: SessionLimits;

  constructor(scanner: CostScanner, l: SessionLimits = SESSION_LIMITS) {
    this.scanner = scanner;
    this.l = l;
  }

  /** What a session of provider used: files are its transcripts, its own
   * first. A response that several of them recorded counts once (the
   * record with the most output). */
  async cost(e: UsageEnv, provider: string, files: Transcript[], own: Record<string, Tier> | undefined): Promise<SessionUsage> {
    const kind = fileLogKind(provider);
    if (!kind) throw new Fail('bad_params', 400, 'usage: not a session of an agent whose sessions are priced');
    if (!files.length) throw new Fail('not_found', 404, 'usage: no transcript of the session');
    return this.withSlot(e.signal, () => this.read(e, provider, kind, files, own));
  }

  /** Runs fn while holding one of this reader's parallel session slots so
   * file-based and SQLite-backed session reads share the same bound. */
  async withSlot<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    await this.slot(signal);
    try {
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }

  /** Prices records already read while holding a slot (no nested slot acquire). */
  priceRecords(
    e: UsageEnv,
    provider: string,
    records: readonly Rec[],
    context: { model: string; used: number; window?: number; tableProvider?: string },
    own: Record<string, Tier> | undefined,
  ): SessionUsage {
    if (!SESSION_PROVIDERS.has(provider)) throw new Fail('bad_params', 400, 'usage: not a session of an agent whose sessions are priced');
    const held = new Held(this.l);
    held.add(records);
    return this.summarize(e, provider, [records], context, own);
  }

  /** Prices records read from a database-backed session (Antigravity,
   * OpenCode) with the same cutoff, deduplication, bounds and slot limit
   * as file-based transcripts. */
  async costRecords(
    e: UsageEnv,
    provider: string,
    records: readonly Rec[],
    context: { model: string; used: number; window?: number; tableProvider?: string },
    own: Record<string, Tier> | undefined,
  ): Promise<SessionUsage> {
    return this.withSlot(e.signal, async () => this.priceRecords(e, provider, records, context, own));
  }

  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }

  private async slot(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.running < this.l.parallel) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(signal.reason);
      };
      this.waiting.push(grant);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private async read(
    e: UsageEnv,
    provider: string,
    kind: string,
    files: Transcript[],
    own: Record<string, Tier> | undefined,
  ): Promise<SessionUsage> {
    const held = new Held(this.l);
    const lists: (readonly Rec[])[] = [];
    let main: Read | undefined;
    for (const [i, f] of files.entries()) {
      e.signal.throwIfAborted();
      let r: Read;
      try {
        r = await this.readFile(e, f, kind, i === 0, held);
      } catch (err) {
        if (i > 0 && (err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw err;
      }
      if (i === 0) main = r;
      lists.push(r.ent.records);
    }
    let model = main!.model;
    // The last turn's model, also before its first response.
    if (kind === LOG.codex && main!.ent.codex?.model) model = main!.ent.codex.model;
    if (!model) model = main!.ent.records.at(-1)?.m ?? '';
    return this.summarize(e, provider, lists, { model, used: main!.used, window: main!.window }, own);
  }

  private summarize(
    e: UsageEnv,
    provider: string,
    lists: readonly (readonly Rec[])[],
    context: { model: string; used: number; window?: number; tableProvider?: string },
    own: Record<string, Tier> | undefined,
  ): SessionUsage {
    const cutoff = Math.floor(e.now() / 1000) - RETENTION;
    const best = new Map<string, number>();
    const recs: Rec[] = [];
    for (const list of lists) {
      for (const x of list) {
        if (x.t < cutoff || x.e) continue;
        if (!x.k) {
          recs.push(x);
          continue;
        }
        const at = best.get(x.k);
        if (at === undefined) {
          best.set(x.k, recs.length);
          recs.push(x);
        } else if (x.o > recs[at]!.o) recs[at] = x;
      }
    }
    const u = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0, cost: 0, priced: true };
    for (const r of recs) {
      const table = provider === 'opencode' ? (OPENCODE_TABLES[r.v] ?? '') : provider === 'antigravity' ? antigravityTable(r.m) : provider;
      const { price } = pricingWith(table, r.m, own);
      const cost = price ? tierCost(tierOf(price, r.x || r.i + r.c + r.w + r.h), r.i, r.c, r.w, r.h, r.o) : r.p;
      u.input += r.i;
      u.cached += r.c;
      u.cacheWrite += r.w + r.h;
      u.output += r.o;
      u.reasoning += r.r;
      u.requests += Math.max(r.n, 1);
      u.cost += cost;
      u.priced &&= !!price || r.p > 0;
    }
    let model = context.model;
    if (!model) model = recs.at(-1)?.m ?? '';
    if (model === 'unknown') model = '';
    let size = context.window ?? 0;
    if (!size && model) {
      const table =
        provider === 'opencode'
          ? (OPENCODE_TABLES[context.tableProvider ?? recs.at(-1)?.v ?? ''] ?? '')
          : provider === 'antigravity'
            ? antigravityTable(model)
            : provider;
      if (table) size = contextWindow(table, model);
    }
    model = cutModel(model);
    const out: SessionUsage = {
      input: u.input,
      cached: u.cached,
      cacheWrite: u.cacheWrite,
      output: u.output,
      requests: u.requests,
      cost: u.cost,
      priced: u.priced,
    };
    if (model) out.model = model;
    if (u.reasoning) out.reasoning = u.reasoning;
    if (context.used) out.contextUsed = context.used;
    if (size) out.contextSize = size;
    return out;
  }

  /** A transcript of kind: the memo's or the cost cache's read of it when
   * it is unchanged since, else read on from that read when it only grew,
   * else whole. With main also its latest request's context. */
  private async readFile(e: UsageEnv, f: Transcript, kind: string, main: boolean, held: Held): Promise<Read> {
    const fh = await f.open();
    try {
      const st = await fh.stat({ bigint: true });
      if (!st.isFile()) throw new NotRegular();
      const size = Number(st.size);
      const mtime = Number(st.mtimeNs);
      if (size > this.l.maxFileBytes) throw tooLarge();
      let old = this.memo.get(f.path);
      if (old) old.use = ++this.use;
      let base: Entry | null;
      if (old && old.ent.kind === kind && old.dev === st.dev && old.ino === st.ino) base = old.ent;
      else {
        old = undefined;
        base = this.scanner.cachedEntry(f.path, kind);
      }
      const unchanged = !!base && base.kind === kind && base.size === size && base.mtime === mtime;
      if (unchanged && old && (old.hasContext || !main)) {
        held.add(old.ent.records);
        return old;
      }
      const r: Read = { ent: base!, dev: st.dev, ino: st.ino, hasContext: false, model: '', used: 0, window: 0, bytes: 0, use: 0 };
      if (!unchanged) r.ent = await this.readOn(e, fh, f.path, kind, size, mtime, base, held);
      else {
        held.add(base!.records);
        if (old) Object.assign(r, { hasContext: old.hasContext, model: old.model, used: old.used, window: old.window });
      }
      if (main && !r.hasContext) {
        Object.assign(r, await latestContext(fh, kind, size, e.signal), { hasContext: true });
        r.model = cutModel(r.model);
      }
      r.bytes = r.ent.records.reduce((n, x) => n + recordBytes(x), 0) + r.model.length;
      this.keep(f.path, r);
      return r;
    } finally {
      await fh.close();
    }
  }

  /** A transcript read as the scan reads a log, with its parser: on from
   * where old ended when the file only grew, else from the start, up to
   * size; the records it makes count in held as they come. */
  private async readOn(
    e: UsageEnv,
    fh: FileHandle,
    path: string,
    kind: string,
    size: number,
    mtime: number,
    old: Entry | null,
    held: Held,
  ): Promise<Entry> {
    const ent: Entry = { kind, size, mtime, off: 0, records: [] };
    let from = 0;
    if (
      old &&
      old.kind === kind &&
      old.off > 0 &&
      old.off <= size &&
      mtime >= old.mtime &&
      (kind !== LOG.codex || old.codex) &&
      (await endsLine(fh, old.off))
    ) {
      from = old.off;
      ent.records = old.records.slice();
      if (old.codex) ent.codex = { ...old.codex };
    }
    held.add(ent.records);
    let counted = ent.records.length;
    const count = () => {
      held.add(ent.records.slice(counted));
      counted = ent.records.length;
    };
    let line: (l: string) => void;
    let done = () => {};
    if (kind === LOG.codex) {
      const p = codexParser(path, ent.codex, ent.records);
      line = p.line;
      done = () => (ent.codex = p.state());
    } else if (kind === LOG.grok) {
      line = (l) => grokUpdate(path, l, ent.records);
    } else if (kind === LOG.kimi) {
      line = (l) => kimiLine('', l, ent.records);
    } else line = (l) => claudeLine(path, l, ent.records);
    ent.off = await readLines(
      fh,
      from,
      size,
      false,
      (l) => {
        line(l);
        if (ent.records.length > counted) count();
      },
      e.signal,
    );
    done();
    ent.records = dedupe(ent.records);
    return ent;
  }

  /** Keeps r, dropping the least recently used reads while there are too
   * many or they take too much; one larger than the memo alone is not
   * kept. */
  private keep(path: string, r: Read): void {
    const old = this.memo.get(path);
    if (old) {
      this.memoBytes -= old.bytes;
      this.memo.delete(path);
    }
    if (r.bytes > this.l.memoBytes) return;
    r.use = ++this.use;
    this.memo.set(path, r);
    this.memoBytes += r.bytes;
    while (this.memo.size > this.l.memoFiles || this.memoBytes > this.l.memoBytes) {
      let oldest: string | undefined;
      for (const [k, v] of this.memo) if (oldest === undefined || v.use < this.memo.get(oldest)!.use) oldest = k;
      this.memoBytes -= this.memo.get(oldest!)!.bytes;
      this.memo.delete(oldest!);
    }
  }

  /** How many reads are kept (tests). */
  get kept(): number {
    return this.memo.size;
  }
}

/** The model and the context of the latest request a transcript of kind
 * records, looked for backwards from its end (within CONTEXT_BACK): Claude
 * Code's last assistant message of the main chain (not a subagent's, not
 * one it made up), its prompt's tokens with the cache's; Codex's last
 * token_count event with its info, the last request's input and the
 * model's context window. */
async function latestContext(
  fh: FileHandle,
  kind: string,
  size: number,
  signal: AbortSignal,
): Promise<{ model: string; used: number; window: number }> {
  const out = { model: '', used: 0, window: 0 };
  await eachLineBackward(
    fh,
    Math.max(size - CONTEXT_BACK, 0),
    size,
    (line) => {
      if (kind === LOG.claude) {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) return false;
        const d = parse(line);
        const msg = obj(d?.message);
        if (!d || d.isSidechain === true || msg.role !== 'assistant' || msg.model === '<synthetic>') return false;
        const u = claudeUsage(obj(msg.usage));
        const n = u.i + u.c + u.w + u.h;
        if (n <= 0) return false;
        out.model = typeof msg.model === 'string' ? msg.model : '';
        out.used = n;
        return true;
      }
      if (kind === LOG.grok) {
        if (!line.includes('"turn_completed"') || !line.includes('"usage"')) return false;
        const d = parse(line);
        const update = obj(obj(d?.params).update);
        if (!d || update.sessionUpdate !== 'turn_completed') return false;
        const usage = obj(update.usage);
        const byModel = isObj(usage.modelUsage) && Object.keys(usage.modelUsage).length ? usage.modelUsage : { '': usage };
        for (const m of Object.keys(byModel).sort()) {
          const u = obj(byModel[m]);
          const input = typeof u.inputTokens === 'number' && Number.isFinite(u.inputTokens) ? Math.trunc(u.inputTokens) : 0;
          const created =
            typeof u.cacheCreationTokens === 'number' && Number.isFinite(u.cacheCreationTokens) ? Math.trunc(u.cacheCreationTokens) : 0;
          const calls =
            typeof u.modelCalls === 'number' && Number.isFinite(u.modelCalls) && u.modelCalls > 0 ? Math.trunc(u.modelCalls) : 1;
          if (input + created <= 0) continue;
          out.model = m;
          out.used = Math.max(Math.trunc((input + created) / calls), 1);
          return true;
        }
        return false;
      }
      if (kind === LOG.kimi) {
        if (!line.includes('"usage.record"')) return false;
        const d = parse(line);
        if (!d || d.type !== 'usage.record') return false;
        const u = obj(d.usage);
        const tok = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
        const n = tok(u.inputOther) + tok(u.inputCacheRead) + tok(u.inputCacheCreation);
        if (n <= 0) return false;
        const m = kimiModelName(str(d.model));
        out.model = m === 'unknown' ? '' : m;
        out.used = n;
        return true;
      }
      if (!line.includes('"token_count"')) return false;
      const p = obj(parse(line)?.payload);
      if (p.type !== 'token_count' || !p.info || typeof p.info !== 'object') return false;
      const info = obj(p.info);
      const input = obj(info.last_token_usage).input_tokens;
      if (typeof input !== 'number' || input <= 0) return false;
      out.used = Math.trunc(input);
      out.window = typeof info.model_context_window === 'number' ? Math.max(Math.trunc(info.model_context_window), 0) : 0;
      return true;
    },
    signal,
  );
  return out;
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ---- Locators for Grok, Kimi Code, Antigravity, OpenCode and Codex-by-cwd ----

const MAX_SCAN_DIRS = 256;
const MAX_SCAN_SESSIONS = 1024;
const MAX_AG_CANDIDATES = 16;

/** Cleaned cwd plus its realpath (when resolvable and distinct) so symlinked
 * directories like /tmp vs /private/tmp match agent logs reliably. */
async function cwdVariants(cwd: string): Promise<string[]> {
  if (!cwd) return [];
  const c = clean(cwd);
  try {
    const real = clean(await realpath(c));
    return real && real !== c ? [c, real] : [c];
  } catch {
    return [c];
  }
}

async function resolvedDir(p: string): Promise<string | null> {
  try {
    const real = await realpath(p);
    const st = await lstat(real);
    return st.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Verifies p is a user-owned regular file whose resolved path stays inside
 * root, returning its size/mtimeMs; null otherwise. */
async function ownRegularIn(root: string, p: string, uid: number): Promise<{ path: string; mtimeMs: number } | null> {
  try {
    const lst = await lstat(p);
    if (!lst.isFile()) return null;
    const real = await realpath(p);
    if (!real.startsWith(root + '/')) return null;
    const st = await lstat(real);
    if (!st.isFile() || (uid >= 0 && st.uid !== uid)) return null;
    return { path: real, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

const notFound = () => new Fail(TranscriptCode.NotFound, 404, 'usage: no transcript of the session');

/** Locates a Grok session's updates.jsonl by UUID or cwd (preferring
 * sessions modified since sinceMs, falling back to the newest matching cwd
 * session for resumed sessions prior to their first new write). */
export async function locateGrokSession(e: UsageEnv, session: string, cwd: string, sinceMs?: number): Promise<Transcript[]> {
  const root = await resolvedDir(posix.join(grokHome(e), 'sessions'));
  if (!root) throw notFound();
  let bestFresh: { path: string; mtimeMs: number } | null = null;
  let bestAny: { path: string; mtimeMs: number } | null = null;
  const consider = async (p: string) => {
    const hit = await ownRegularIn(root, p, e.uid);
    if (!hit) return;
    if (!bestAny || hit.mtimeMs > bestAny.mtimeMs) bestAny = hit;
    if (sinceMs === undefined || session || hit.mtimeMs >= sinceMs) {
      if (!bestFresh || hit.mtimeMs > bestFresh.mtimeMs) bestFresh = hit;
    }
  };
  if (session) {
    if (!validSessionId(session)) throw new Fail('bad_params', 400, 'usage: not a session id');
    let dirs;
    try {
      dirs = await readdir(root, { withFileTypes: true });
    } catch {
      throw notFound();
    }
    let n = 0;
    for (const d of dirs) {
      e.signal.throwIfAborted();
      if (!d.isDirectory()) continue;
      if (++n > MAX_SCAN_DIRS) break;
      await consider(posix.join(root, d.name, session, 'updates.jsonl'));
    }
  } else if (cwd) {
    for (const c of await cwdVariants(cwd)) {
      const encoded = encodeURIComponent(c);
      if (!encoded || encoded === '.' || encoded === '..' || encoded.includes('/')) continue;
      const projDir = posix.join(root, encoded);
      let subs;
      try {
        subs = await readdir(projDir, { withFileTypes: true });
      } catch {
        continue;
      }
      let n = 0;
      for (const s of subs) {
        e.signal.throwIfAborted();
        if (!s.isDirectory() || !validSessionId(s.name)) continue;
        if (++n > MAX_SCAN_SESSIONS) break;
        await consider(posix.join(projDir, s.name, 'updates.jsonl'));
      }
    }
  }
  const best = bestFresh ?? bestAny;
  if (!best) throw notFound();
  const chosen = (best as { path: string; mtimeMs: number }).path;
  return [{ path: chosen, open: () => openRegular(chosen) }];
}

/** Collects a Kimi Code session directory's wire logs, main agent first. */
async function kimiWireLogs(root: string, sessionDir: string, uid: number): Promise<{ paths: string[]; mtimeMs: number } | null> {
  const candidates: { name: string; path: string; mtimeMs: number }[] = [];
  const agentsDir = posix.join(sessionDir, 'agents');
  try {
    for (const a of await readdir(agentsDir, { withFileTypes: true })) {
      if (!a.isDirectory()) continue;
      const hit = await ownRegularIn(root, posix.join(agentsDir, a.name, 'wire.jsonl'), uid);
      if (hit) candidates.push({ name: a.name, path: hit.path, mtimeMs: hit.mtimeMs });
    }
  } catch {
    // no agents/ dir
  }
  const top = await ownRegularIn(root, posix.join(sessionDir, 'wire.jsonl'), uid);
  if (top) candidates.push({ name: '', path: top.path, mtimeMs: top.mtimeMs });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const am = a.name === 'main' || a.name === '' ? 0 : 1;
    const bm = b.name === 'main' || b.name === '' ? 0 : 1;
    return am - bm || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  const mtimeMs = candidates.reduce((m, c) => Math.max(m, c.mtimeMs), 0);
  return { paths: candidates.map((c) => c.path), mtimeMs };
}

/** Reads a Kimi Code session's state.json workDir/cwd safely (max 64 KiB). */
async function kimiSessionCwd(root: string, sessionDir: string, uid: number): Promise<string> {
  const hit = await ownRegularIn(root, posix.join(sessionDir, 'state.json'), uid);
  if (!hit) return '';
  try {
    const fh = await openRegular(hit.path);
    try {
      const b = Buffer.alloc(64 << 10);
      const { bytesRead } = await fh.read(b, 0, b.length, 0);
      const st = obj(parse(b.subarray(0, bytesRead).toString('utf8')));
      return str(st.cwd) || str(st.workDir);
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

/** Locates a Kimi Code session's wire logs by UUID or cwd (preferring
 * sessions modified since sinceMs, falling back to newest matching cwd). */
export async function locateKimiSession(e: UsageEnv, session: string, cwd: string, sinceMs?: number): Promise<Transcript[]> {
  const root = await resolvedDir(posix.join(kimiHome(e), 'sessions'));
  if (!root) throw notFound();
  let workspaces;
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch {
    throw notFound();
  }
  const wants = new Set(await cwdVariants(cwd));
  let bestFresh: { paths: string[]; mtimeMs: number } | null = null;
  let bestAny: { paths: string[]; mtimeMs: number } | null = null;
  let nWs = 0;
  for (const ws of workspaces) {
    e.signal.throwIfAborted();
    if (!ws.isDirectory()) continue;
    if (++nWs > MAX_SCAN_DIRS) break;
    const wsDir = posix.join(root, ws.name);
    if (session) {
      for (const name of [`session_${session}`, session]) {
        const found = await kimiWireLogs(root, posix.join(wsDir, name), e.uid);
        if (found && (!bestFresh || found.mtimeMs > bestFresh.mtimeMs)) bestFresh = found;
      }
      continue;
    }
    let subs;
    try {
      subs = await readdir(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    let nSess = 0;
    for (const s of subs) {
      e.signal.throwIfAborted();
      if (!s.isDirectory()) continue;
      if (++nSess > MAX_SCAN_SESSIONS) break;
      const sDir = posix.join(wsDir, s.name);
      const found = await kimiWireLogs(root, sDir, e.uid);
      if (!found) continue;
      const isFresh = sinceMs === undefined || found.mtimeMs >= sinceMs;
      if (isFresh && bestFresh && found.mtimeMs <= bestFresh.mtimeMs) continue;
      if (!isFresh && (bestFresh || (bestAny && found.mtimeMs <= bestAny.mtimeMs))) continue;
      const dir = await kimiSessionCwd(root, sDir, e.uid);
      if (!dir) continue;
      const dirVariants = await cwdVariants(dir);
      if (!dirVariants.some((v) => wants.has(v))) continue;
      if (isFresh) bestFresh = found;
      if (!bestAny || found.mtimeMs > bestAny.mtimeMs) bestAny = found;
    }
  }
  const best = bestFresh ?? bestAny;
  if (!best) throw notFound();
  return best.paths.map((p) => ({ path: p, open: () => openRegular(p) }));
}

/** Locates a Claude Code session by cwd (preferring transcripts modified
 * since sinceMs, falling back to the newest matching cwd transcript for
 * resumed or idle sessions). */
export async function locateClaudeByCwd(e: UsageEnv, r: Resolver, cwd: string, sinceMs: number | undefined): Promise<Transcript[]> {
  if (!cwd) throw notFound();
  const cands: Array<{ id: string; file: string; mod: number }> = [];
  for (const d of r.claudeDirs()) {
    for (const dir of await claudeProjectDirs(r, posix.join(d, 'projects'), cwd)) {
      for (const ent of await r.files.readDir(dir, LIMITS.entries)) {
        e.signal.throwIfAborted();
        const id = ent.name.endsWith('.jsonl') ? ent.name.slice(0, -'.jsonl'.length) : '';
        if (!validSessionId(id) || !ent.isFile()) continue;
        const file = posix.join(dir, ent.name);
        const st = await r.files.lstat(file);
        if (!st) continue;
        cands.push({ id, file, mod: mtimeOf(st) });
      }
    }
  }
  if (!cands.length) throw notFound();
  cands.sort((a, b) => b.mod - a.mod);
  const pick = async (list: typeof cands): Promise<string | null> => {
    let tried = 0;
    for (const c of list) {
      if (tried >= LIMITS.confirm || e.signal.aborted) break;
      tried++;
      let fh: FileHandle;
      try {
        fh = await r.files.openNoFollow(c.file);
      } catch {
        continue;
      }
      try {
        if (await sameDir(r.files, (await claudeInfoOf(fh)).cwd, cwd)) return c.id;
      } finally {
        await fh.close().catch(() => {});
      }
    }
    return null;
  };
  let chosen: string | null = null;
  if (sinceMs !== undefined) {
    const fresh = cands.filter((c) => c.mod >= sinceMs);
    if (fresh.length) chosen = await pick(fresh);
  }
  if (!chosen) chosen = await pick(sinceMs !== undefined ? cands.filter((c) => c.mod < sinceMs) : cands);
  if (!chosen) throw notFound();
  return sessionsLocator(r)('claude', chosen, e.signal);
}

/** Locates a Codex session by cwd (including extra configured Codex homes
 * and resumed rollouts: prefers rollouts modified since sinceMs, falling
 * back to the newest matching cwd rollout). */
export async function locateCodexByCwd(
  e: UsageEnv,
  r: Resolver,
  cwd: string,
  sinceMs: number | undefined,
  extraCodexHomes: readonly string[] | undefined,
): Promise<Transcript[]> {
  const homes = r.codexHomes(extraCodexHomes);
  const lookback = Math.min(sinceMs ?? e.now(), e.now() - 7 * 86_400_000);
  const days = codexDays(lookback, e.now());
  let bestFresh: { id: string; mod: number } | null = null;
  let bestSince: { id: string; mod: number } | null = null;
  let bestAny: { id: string; mod: number } | null = null;
  let reads = 0;
  for (const h of homes) {
    for (const d of days) {
      e.signal.throwIfAborted();
      const dir = posix.join(h, 'sessions', d);
      const ents = (await r.files.readDir(dir, LIMITS.entries)).sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
      for (const ent of ents) {
        const id = rolloutId(ent.name);
        if (!id || !ent.isFile()) continue;
        const p = posix.join(dir, ent.name);
        const st = await r.files.lstat(p);
        if (!st) continue;
        const mod = mtimeOf(st);
        const isSince = sinceMs === undefined || mod >= sinceMs;
        // Skip older candidates once a fresh match is already found.
        if (!isSince && (bestFresh || bestSince || (bestAny && mod <= bestAny.mod))) continue;
        if (reads >= LIMITS.metaReads || e.signal.aborted) break;
        reads++;
        const m = await r.rolloutMeta(p);
        if (!m || m.id !== id || m.parent !== '' || !(await sameDir(r.files, m.cwd, cwd))) continue;
        if (isSince) {
          if (sinceMs === undefined || m.started >= sinceMs) {
            if (!bestFresh || mod > bestFresh.mod) bestFresh = { id, mod };
          }
          if (!bestSince || mod > bestSince.mod) bestSince = { id, mod };
        }
        if (!bestAny || mod > bestAny.mod) bestAny = { id, mod };
      }
    }
  }
  const chosen = bestFresh ?? bestSince ?? bestAny;
  if (!chosen) throw notFound();
  return sessionsLocator(r)('codex', chosen.id, e.signal, extraCodexHomes);
}

/** Antigravity conversation_summaries.db paths (CLI first, then desktop/IDE). */
const ANTIGRAVITY_DIRS = ['.gemini/antigravity-cli', '.gemini/antigravity', '.gemini/antigravity-ide'] as const;

/** Reads and prices one Antigravity conversation database (by UUID or cwd)
 * inside the reader's shared concurrency slot. */
export async function readAntigravitySessionUsage(
  e: UsageEnv,
  reader: SessionReader,
  opts: { session: string; cwd: string; sinceMs?: number; own?: Record<string, Tier>; dbLimits?: DBLimits },
): Promise<SessionUsage> {
  return reader.withSlot(e.signal, async () => {
    const dbs = await antigravityDBs(e);
    if (!dbs.length) throw notFound();
    const limits = opts.dbLimits ?? DB_LIMITS;
    const worker = new SQLiteWorker(limits.requestMs);
    const db: DBRead = { signal: e.signal, limits, uid: e.uid, worker };
    try {
      let target: { path: string; mtimeSec: number } | null = null;
      if (opts.session) {
        const want = `${opts.session}.db`;
        let bestMtime = -1;
        for (const p of dbs) {
          if (posix.basename(p) !== want) continue;
          try {
            const st = await dbFiles(p, e.uid);
            if (st.mtime > bestMtime) {
              bestMtime = st.mtime;
              target = { path: p, mtimeSec: Math.floor(st.mtime / 1e9) };
            }
          } catch {
            // unreadable or link
          }
        }
      } else if (opts.cwd) {
        const wants = new Set(await cwdVariants(opts.cwd));
        const dbByPath = new Set(dbs);
        const dbsById = new Map<string, string[]>();
        for (const p of dbs) {
          const base = posix.basename(p);
          if (!base.endsWith('.db')) continue;
          const id = base.slice(0, -3);
          const list = dbsById.get(id);
          if (list) list.push(p);
          else dbsById.set(id, [p]);
        }
        // Primary lookup: conversation_summaries.db (reliable for agy CLI
        // conversations whose trajectory_metadata_blob may be empty).
        let bestSumFresh: { path: string; mtimeMs: number; mtimeSec: number; active: boolean } | null = null;
        let bestSumAny: { path: string; mtimeMs: number; mtimeSec: number; active: boolean } | null = null;
        for (const sub of ANTIGRAVITY_DIRS) {
          e.signal.throwIfAborted();
          const dir = posix.join(e.home, sub);
          const sumPath = posix.join(dir, 'conversation_summaries.db');
          let summaries;
          try {
            summaries = await readAntigravitySummaries(sumPath, db);
          } catch {
            continue;
          }
          for (const s of summaries) {
            e.signal.throwIfAborted();
            let matched = false;
            for (const ws of s.workspaces) {
              const wsVariants = await cwdVariants(ws);
              if (wsVariants.some((v) => wants.has(v))) {
                matched = true;
                break;
              }
            }
            if (!matched) continue;
            const preferred = posix.join(dir, 'conversations', `${s.id}.db`);
            const candidates = dbByPath.has(preferred) ? [preferred] : (dbsById.get(s.id) ?? []);
            for (const p of candidates) {
              try {
                const st = await dbFiles(p, e.uid);
                const fileMs = st.mtime / 1e6;
                const mtimeMs = Math.max(fileMs, s.modifiedMs);
                const cand = { path: p, mtimeMs, mtimeSec: Math.floor(st.mtime / 1e9), active: s.active };
                const better = (a: typeof cand, b: typeof cand | null) => !b || (a.active !== b.active ? a.active : a.mtimeMs > b.mtimeMs);
                if (opts.sinceMs === undefined || mtimeMs >= opts.sinceMs || s.active) {
                  if (better(cand, bestSumFresh)) bestSumFresh = cand;
                }
                if (better(cand, bestSumAny)) bestSumAny = cand;
              } catch {
                // skip unreadable/link
              }
            }
          }
        }
        const sumChosen = bestSumFresh ?? bestSumAny;
        if (sumChosen) {
          target = { path: sumChosen.path, mtimeSec: sumChosen.mtimeSec };
        } else {
          // Fallback: scan trajectory_metadata_blob (two-pass: prefer >= sinceMs,
          // then fall back to the newest matching cwd conversation).
          const allCands: { path: string; mtimeMs: number; mtimeSec: number }[] = [];
          for (const p of dbs) {
            e.signal.throwIfAborted();
            try {
              const st = await dbFiles(p, e.uid);
              allCands.push({ path: p, mtimeMs: st.mtime / 1e6, mtimeSec: Math.floor(st.mtime / 1e9) });
            } catch {
              // skip
            }
          }
          allCands.sort((a, b) => b.mtimeMs - a.mtimeMs);
          const scanTraj = async (list: typeof allCands) => {
            for (const c of list.slice(0, MAX_AG_CANDIDATES)) {
              e.signal.throwIfAborted();
              try {
                const traj = await readAntigravityTrajectory(c.path, db);
                if (!traj?.workspace) continue;
                const wsVariants = await cwdVariants(traj.workspace);
                if (wsVariants.some((v) => wants.has(v))) {
                  return { path: c.path, mtimeSec: c.mtimeSec };
                }
              } catch {
                // skip damaged/busy candidate
              }
            }
            return null;
          };
          if (opts.sinceMs !== undefined) {
            target = await scanTraj(allCands.filter((c) => c.mtimeMs >= opts.sinceMs!));
            if (!target) target = await scanTraj(allCands.filter((c) => c.mtimeMs < opts.sinceMs!));
          } else {
            target = await scanTraj(allCands);
          }
        }
      }
      if (!target) throw notFound();
      const cutoff = Math.floor(e.now() / 1000) - RETENTION;
      const res = await readAntigravitySession(target.path, cutoff, target.mtimeSec, db);
      return reader.priceRecords(e, 'antigravity', res.records, { model: res.model, used: res.contextUsed }, opts.own);
    } catch (err) {
      if (err instanceof DBError && err.code === 'too_large') throw tooLarge();
      throw err;
    } finally {
      worker.close();
    }
  });
}

/** Reads and prices one OpenCode session (by session id or cwd) inside the
 * reader's shared concurrency slot. */
export async function readOpenCodeSessionUsage(
  e: UsageEnv,
  reader: SessionReader,
  opts: { session: string; cwd: string; sinceMs?: number; own?: Record<string, Tier>; dbLimits?: DBLimits },
): Promise<SessionUsage> {
  return reader.withSlot(e.signal, async () => {
    const dbs = await openCodeDBs(e);
    if (!dbs.length) throw notFound();
    const limits = opts.dbLimits ?? DB_LIMITS;
    const worker = new SQLiteWorker(limits.requestMs);
    const db: DBRead = { signal: e.signal, limits, uid: e.uid, worker };
    const cwds = opts.cwd ? await cwdVariants(opts.cwd) : [];
    const cutoff = Math.floor(e.now() / 1000) - RETENTION;
    try {
      let best: Awaited<ReturnType<typeof readOpenCodeSession>> = null;
      for (const p of dbs) {
        e.signal.throwIfAborted();
        try {
          const res = await readOpenCodeSession(
            p,
            { session: opts.session || undefined, cwds, sinceMs: opts.sinceMs, sinceSec: cutoff },
            db,
          );
          if (res && (!best || res.updatedAt > best.updatedAt)) best = res;
        } catch (err) {
          if (err instanceof DBError && err.code === 'too_large') throw tooLarge();
          // skip unreadable/busy channel db and try the rest
        }
      }
      if (!best) throw notFound();
      return reader.priceRecords(
        e,
        'opencode',
        best.records,
        { model: best.mainModel, used: best.contextUsed, tableProvider: best.mainProvider },
        opts.own,
      );
    } finally {
      worker.close();
    }
  });
}

/** Process start time slack when matching a session by cwd+pid (ms). */
export const CWD_START_SLACK_MS = TIMING.startSlackMs;
