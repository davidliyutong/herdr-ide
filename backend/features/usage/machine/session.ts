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
import type { FileHandle } from 'node:fs/promises';
import type { z } from 'zod';
import { Fail } from '#shared/lib/fail.ts';
import type { sessionUsage } from '../protocol.ts';
import { obj, type UsageEnv } from './env.ts';
import { NotRegular, eachLineBackward, endsLine, readLines } from './logs.ts';
import { LOG, claudeLine, claudeUsage, codexParser, type Entry, type Rec } from './parsers.ts';
import { contextWindow, pricingWith, tierCost, tierOf, type Tier } from './pricing.ts';
import { RETENTION, dedupe, type CostScanner } from './scan.ts';

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
export type LocateSession = (kind: string, session: string, signal: AbortSignal) => Promise<Transcript[]>;

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

/** The kind of log of a provider's transcripts. */
const logKind = (provider: string): string | undefined =>
  provider === 'claude' ? LOG.claude : provider === 'codex' ? LOG.codex : undefined;

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
    const kind = logKind(provider);
    if (!kind) throw new Fail('bad_params', 400, 'usage: not a session of an agent whose sessions are priced');
    if (!files.length) throw new Fail('not_found', 404, 'usage: no transcript of the session');
    await this.slot(e.signal);
    try {
      return await this.read(e, provider, kind, files, own);
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async slot(signal: AbortSignal): Promise<void> {
    while (this.running >= this.l.parallel) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => {
        const go = () => {
          signal.removeEventListener('abort', go);
          resolve();
        };
        this.waiting.push(go);
        signal.addEventListener('abort', go, { once: true });
      });
    }
    signal.throwIfAborted();
    this.running++;
  }

  private async read(
    e: UsageEnv,
    provider: string,
    kind: string,
    files: Transcript[],
    own: Record<string, Tier> | undefined,
  ): Promise<SessionUsage> {
    const cutoff = Math.floor(e.now() / 1000) - RETENTION;
    const held = new Held(this.l);
    const best = new Map<string, number>();
    const recs: Rec[] = [];
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
      for (const x of r.ent.records) {
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
      const { price } = pricingWith(provider, r.m, own);
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
    let model = main!.model;
    // The last turn's model, also before its first response.
    if (kind === LOG.codex && main!.ent.codex?.model) model = main!.ent.codex.model;
    if (!model) model = main!.ent.records.at(-1)?.m ?? '';
    let size = main!.window;
    if (!size && model) size = contextWindow(provider, model);
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
    if (main!.used) out.contextUsed = main!.used;
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
