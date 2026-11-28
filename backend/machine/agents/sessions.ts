// The coding agents' sessions on this machine (docs/features/35): which
// session an agent's process uses, and where a session's transcript is.
// The machine sides of the features that need them (agent detection and
// the agents plugin; the AI usage feature and the chat host read the
// transcripts it locates) share this.
//
// resolve maps a terminal's foreground program (its pid, command line and
// directory, as the terminal core reports them) to the id of its agent's
// session, trying in order the command line (claude --session-id and
// --resume, codex resume), Claude Code's record of its process
// (<claude dir>/sessions/<pid>.json), the rollout a Codex process holds
// open (Linux), the only Codex rollout of the directory made since the
// process started, and, as a guess, the newest transcript of the directory
// written since then (claude.ts, codex.ts). stamp is a cheap fingerprint of
// what resolve reads, so a caller polls with a few stats and resolves
// again on a change (Claude Code's /clear rewrites its record).
//
// locate maps a session id to its transcript. The id is the only thing a
// browser names: it must be a lower-case UUID before it reaches a path, and
// the file found must be a regular file of the user's own with one name
// inside the kind's own session root once links are resolved; a
// SessionFile opens it so that this still holds when it is opened (no link
// followed anywhere on its path, the very file found). A miss is
// remembered for a few seconds, so asking again and again for unknown ids
// does not search the session roots each time. Only the agents whose
// transcripts are read (Kind.transcript "claude" or "codex") have sessions.
//
// Everything is read as the user, read-only and asynchronously; nothing is
// started or written.
import { createHash } from 'node:crypto';
import { stat, type FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import { validSessionId } from '#shared/agents/kinds.ts';
import { rolloutMeta, type RolloutMeta } from './codex.ts';
import { driverOf } from './driver.ts';
import { Files, sameFile, type FileId } from './files.ts';
import { systemProcs, type ProcEntry, type ProcSource } from './procs.ts';
import { ReadOnlySQLiteWorker } from './sqlworker.ts';
import {
  Format,
  LIMITS,
  Search,
  SessionError,
  TIMING,
  clean,
  formatOf,
  recordPid,
  samePath,
  uniq,
  type Found,
  type Info,
  type Location,
  type Proc,
} from './common.ts';

export * from './common.ts';
export { agyArgv, agyConvId, agyResumedArgv } from './agy.ts';
export { CLAUDE_MAX_NAME, claudeArgv, claudeEscape, claudeInfoOf, claudeProjectDirs } from './claude.ts';
export { codexArgv, codexDays, decodeSessionMeta, rolloutId, uuidTime, type RolloutMeta } from './codex.ts';

interface Miss {
  err: SessionError;
  /** When every place was last searched, and when the places a new
   * transcript appears in were. */
  at: number;
  checked: number;
}

/** The transcript of a session: path, absolute and resolved through links,
 * and for Claude Code the transcripts of its subagents, each checked like
 * path. open and openSubagent open them as the files located: null when
 * one is not (any more). */
export class SessionFile {
  readonly path: string;
  readonly subagents: readonly string[];
  private readonly files: Files;
  private readonly id: FileId;
  private readonly subs: readonly FileId[];

  constructor(files: Files, loc: Location, subagents: Array<{ path: string; id: FileId }>) {
    this.files = files;
    this.path = loc.file;
    this.id = loc.id;
    this.subagents = subagents.map((s) => s.path);
    this.subs = subagents.map((s) => s.id);
  }

  /** The transcript, opened with no link followed on its path, as the file
   * located; null when it is not. */
  open(): Promise<FileHandle | null> {
    return this.files.openAs(this.path, this.id);
  }

  /** subagents[i] as open opens path; null when it is not the file
   * located there or i is out of range. */
  async openSubagent(i: number): Promise<FileHandle | null> {
    if (!Number.isInteger(i) || i < 0 || i >= this.subs.length) return null;
    return this.files.openAs(this.subagents[i], this.subs[i]);
  }
}

export interface ResolverOptions {
  /** The user's home directory; $HOME by default. */
  home?: string;
  /** The agent's environment; process.env by default. */
  getenv?: (key: string) => string | undefined;
  /** How many other terminals run the same kind in the same directory (a
   * guess is refused when there are any); none by default. */
  peers?: (kind: string, cwd: string) => number;
  /** The processes (tests give fake ones); this system's by default. */
  procs?: ProcSource;
  files?: Files;
  /** The clock, in ms (tests). */
  now?: () => number;
}

/** Finds sessions on this machine; one may serve several callers at once. */
export class Resolver {
  readonly files: Files;
  readonly procs: ProcSource;
  private readonly homeDir: string | undefined;
  private readonly getenvFn: (key: string) => string | undefined;
  private readonly peersFn: (kind: string, cwd: string) => number;
  private readonly nowFn: () => number;

  /** A terminal's pid and the Claude Code record that last named its
   * session (stamp watches it). */
  private readonly records = new Map<number, string>();
  /** Codex rollouts' first lines by path: a first line never changes once
   * written. */
  readonly metas = new Map<string, RolloutMeta>();
  /** locate's answers, checked again on use. */
  private readonly located = new Map<string, Location>();
  /** locate's misses, by format and id. */
  readonly misses = new Map<string, Miss>();
  /** Lazy off-main-thread read-only SQLite worker shared by drivers (e.g. Antigravity). */
  private dbWorker: ReadOnlySQLiteWorker | null = null;

  constructor(o: ResolverOptions = {}) {
    this.files = o.files ?? new Files();
    this.procs = o.procs ?? systemProcs(this.files);
    this.homeDir = o.home;
    this.getenvFn = o.getenv ?? ((k) => process.env[k]);
    this.peersFn = o.peers ?? (() => 0);
    this.nowFn = o.now ?? Date.now;
  }

  /** Lazily created off-main-thread read-only SQLite worker for external agent DBs. */
  sqlWorker(): ReadOnlySQLiteWorker {
    return (this.dbWorker ??= new ReadOnlySQLiteWorker());
  }

  /** Releases background resources held by this resolver (e.g. SQLite worker). */
  close(): void {
    this.dbWorker?.close();
    this.dbWorker = null;
  }

  /** The session of the agent of kind that p runs; null when none is known
   * (yet: Codex writes no file before the first prompt, and a caller tries
   * again when stamp changes). */
  async resolve(kind: string, p: Proc, signal: AbortSignal = new AbortController().signal): Promise<Found | null> {
    const driver = driverOf(formatOf(kind));
    return driver ? driver.resolve(this, kind, p, signal) : null;
  }

  /** Something cheap that changes when resolve's answer may have changed
   * (the mtime and size of Claude Code's <pid>.json and of its sessions
   * directory; for Codex the newest rollout's name in the dated
   * directories resolve reads, and its mtime when last is a guess; for
   * Antigravity its summary index and conversations directory); "" for a
   * kind without sessions. */
  async stamp(kind: string, p: Proc, last: Found): Promise<string> {
    const driver = driverOf(formatOf(kind));
    if (!driver) return '';
    const out: string[] = [];
    await driver.stamp(this, p, last, out);
    return createHash('sha256').update(out.join('')).digest('hex').slice(0, 16);
  }

  /** The transcript of a session: Claude Code's
   * <claude dir>/projects/<dir>/<id>.jsonl, Codex's
   * <home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl or
   * archived_sessions; the most recently modified one when there are
   * several. Throws SessionError: bad_id before the id reaches any path,
   * unknown_kind, not_found, compressed (only .jsonl.zst). A miss is
   * remembered (TIMING): a transcript made meanwhile is found within
   * missRecheckMs of a caller asking again, one that existed before only
   * after missTtlMs. */
  async locate(kind: string, id: string, extraCodexHomes?: readonly string[]): Promise<SessionFile> {
    const f = this.check(kind, id);
    return this.fileOf(f, id, await this.locateIn(f, id, extraCodexHomes));
  }

  /** locate and SessionFile.open in one: the session's transcript, open as
   * the file located; one replaced since it was located (another file at
   * the name, a link on the way) is located again once. */
  async openLocated(kind: string, id: string): Promise<{ fh: FileHandle; file: SessionFile }> {
    const f = this.check(kind, id);
    const { fh, loc } = await this.open(f, id);
    try {
      return { fh, file: await this.fileOf(f, id, loc) };
    } catch (e) {
      await fh.close().catch(() => {});
      throw e;
    }
  }

  /** What a transcript says of itself without its conversation: Claude
   * Code's first conversation line, Codex's session_meta, or Antigravity's
   * summary/trajectory metadata; empty when it does not say (yet). */
  async describe(kind: string, id: string): Promise<Info> {
    const f = this.check(kind, id);
    const driver = driverOf(f);
    if (!driver) throw new SessionError('unknown_kind');
    return driver.describe(
      this,
      id,
      () => this.open(f, id),
      () => this.locateIn(f, id),
    );
  }

  private check(kind: string, id: string): Format {
    if (!validSessionId(id)) throw new SessionError('bad_id');
    const f = formatOf(kind);
    if (!f) throw new SessionError('unknown_kind');
    return f;
  }

  private async fileOf(f: Format, id: string, loc: Location): Promise<SessionFile> {
    const driver = driverOf(f);
    const subs = driver?.subagents ? await driver.subagents(this, loc, id) : [];
    return new SessionFile(this.files, loc, subs);
  }

  /** Locates a transcript of format f and opens it, locating it once more
   * when it is not the file located. */
  private async open(f: Format, id: string): Promise<{ fh: FileHandle; loc: Location }> {
    for (let attempt = 0; ; attempt++) {
      const loc = await this.locateIn(f, id);
      const fh = await this.files.openAs(loc.file, loc.id);
      if (fh) return { fh, loc };
      if (attempt > 0) throw new SessionError('not_found');
      this.located.delete(`${f}/${id}`);
    }
  }

  /** Finds a session's transcript of format f; an earlier answer is used
   * again while it still names, through no link, the file found, and an
   * earlier miss while it is remembered. */
  private async locateIn(f: Format, id: string, extraCodexHomes?: readonly string[]): Promise<Location> {
    const driver = driverOf(f);
    if (!driver) throw new SessionError('unknown_kind');
    const extraKey = driver.cacheKeyExtra?.(extraCodexHomes) ?? '';
    const key = `${f}/${id}${extraKey}`;
    const known = this.located.get(key);
    if (known) {
      if ((await this.files.realpath(known.file)) === known.file) {
        const st = await this.files.lstatOwn(known.file);
        if (st && sameFile(st, known.id)) return known;
      }
      this.located.delete(key);
    }
    const now = this.now();
    let m = this.misses.get(key);
    const missed = !!m && !(now - m.at >= TIMING.missTtlMs || now < m.at);
    if (m && missed && now - m.checked < TIMING.missRecheckMs && !(now < m.checked)) throw m.err;
    const s = new Search();
    await driver.search(this, s, id, { now, full: !missed, extraHomes: extraCodexHomes });
    if (!s.best) {
      const err = new SessionError(s.compressed ? 'compressed' : 'not_found');
      if (!m) m = { err, at: now, checked: now };
      if (!missed || !driver.incrementalMissSearch) m.at = now;
      m.err = err;
      m.checked = now;
      this.rememberMiss(key, m, now);
      throw err;
    }
    this.misses.delete(key);
    if (this.located.size >= LIMITS.remembered) this.located.delete(this.located.keys().next().value!);
    this.located.set(key, s.best);
    return s.best;
  }

  /** Keeps a miss, at most LIMITS.misses of them: the expired ones go
   * first, then the oldest. */
  private rememberMiss(key: string, m: Miss, now: number): void {
    if (!this.misses.has(key) && this.misses.size >= LIMITS.misses) {
      let oldest: string | null = null;
      for (const [k, v] of this.misses) {
        if (now - v.at >= TIMING.missTtlMs || now < v.at) {
          this.misses.delete(k);
          continue;
        }
        if (oldest === null || v.at < this.misses.get(oldest)!.at) oldest = k;
      }
      if (this.misses.size >= LIMITS.misses && oldest !== null) this.misses.delete(oldest);
    }
    this.misses.set(key, m);
  }

  /** The running process of Claude Code that has session id open, as its
   * record tells (<claude dir>/sessions/<pid>.json in one of the user's
   * configuration directories): a record of the user's own, of a process
   * that runs and started when the record says, that names id. skip passes
   * over processes the caller knows (its own children). null when none. */
  async claudeRunning(id: string, skip?: (pid: number) => boolean, signal?: AbortSignal): Promise<number | null> {
    if (!validSessionId(id)) return null;
    let n = 0;
    for (const d of this.claudeDirs()) {
      const sdir = posix.join(d, 'sessions');
      for (const e of await this.files.readDir(sdir, LIMITS.entries)) {
        const pid = recordPid(e.name);
        if (pid === null || !e.isFile() || skip?.(pid)) continue;
        if (n >= LIMITS.claims || signal?.aborted) return null;
        n++;
        if ((await this.startOf(pid)) === null) continue;
        if ((await this.readRecord(posix.join(sdir, e.name), pid)) === id) return pid;
      }
    }
    return null;
  }

  // ---- what the formats' modules share (claude.ts, codex.ts) ----

  now(): number {
    return this.nowFn();
  }

  getenv(k: string): string {
    return this.getenvFn(k) ?? '';
  }

  peers(kind: string, cwd: string): number {
    return this.peersFn(kind, cwd);
  }

  /** The user's home directory; "" when it is not absolute (no path is
   * made from it then). */
  home(): string {
    const h = this.homeDir || process.env.HOME || '';
    return posix.isAbsolute(h) ? clean(h) : '';
  }

  /** p with ~ resolved against the home directory and a relative path
   * against base; "" when the result would not be absolute. */
  expand(p: string, base: string): string {
    if (p === '') return '';
    if (p === '~' || p.startsWith('~/')) {
      const h = this.home();
      return h === '' ? '' : posix.join(h, p.slice(1).replace(/^\/+/, ''));
    }
    if (posix.isAbsolute(p)) return clean(p);
    return posix.isAbsolute(base) ? posix.join(base, p) : '';
  }

  /** The agent's user's Claude Code configuration directories:
   * $CLAUDE_CONFIG_DIR, ~/.claude and ~/.config/claude. */
  claudeDirs(): string[] {
    const h = this.home();
    return uniq(this.expand(this.getenv('CLAUDE_CONFIG_DIR'), h), under(h, '.claude'), under(h, '.config/claude'));
  }

  /** The agent's user's Codex homes: $CODEX_HOME, ~/.codex, and any
   * configured extra homes. */
  codexHomes(extra?: readonly string[]): string[] {
    const h = this.home();
    return uniq(this.expand(this.getenv('CODEX_HOME'), h), under(h, '.codex'), ...(extra ?? []).map((x) => this.expand(x.trim(), h)));
  }

  /** The agent's user's Antigravity data directories (CLI first, then
   * desktop and IDE). */
  agyDirs(): string[] {
    const h = this.home();
    return uniq(under(h, '.gemini/antigravity-cli'), under(h, '.gemini/antigravity'), under(h, '.gemini/antigravity-ide'));
  }

  /** Whether a configuration directory a process's environment names
   * ($CLAUDE_CONFIG_DIR, $CODEX_HOME) may hold the agent's user's records
   * and transcripts: one of the user's own that locate searches too
   * (own), or a directory the user owns that no one else may write. One
   * that does not exist (yet) holds nothing to read. */
  async trustedDir(d: string, own: readonly string[]): Promise<boolean> {
    if (own.some((o) => samePath(o, d))) return true;
    let st;
    try {
      st = await stat(d, { bigint: true });
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT';
    }
    return Number(st.uid) === this.files.uid && this.files.private(st);
  }

  /** When pid started (ms); null when it is not known (the process is
   * gone). */
  startOf(pid: number): Promise<number | null> {
    return pid > 0 ? this.procs.start(pid) : Promise.resolve(null);
  }

  /** pid and its descendants in its process group, breadth first, at most
   * LIMITS.depth generations and LIMITS.candidates processes. */
  async candidates(pid: number): Promise<number[]> {
    const out = [pid];
    let table: ProcEntry[];
    try {
      table = await this.procs.table(pid);
    } catch {
      return out;
    }
    const me = table.find((e) => e.pid === pid);
    if (!me) return out;
    const children = new Map<number, number[]>();
    for (const e of table) {
      if (e.pgid !== me.pgid || e.pid === pid || e.pid <= 0) continue;
      const siblings = children.get(e.ppid);
      if (siblings) siblings.push(e.pid);
      else children.set(e.ppid, [e.pid]);
    }
    const seen = new Set([pid]);
    let level = [pid];
    for (let depth = 0; depth < LIMITS.depth && level.length > 0; depth++) {
      const next: number[] = [];
      for (const q of level)
        for (const c of (children.get(q) ?? []).sort((a, b) => a - b)) {
          if (seen.has(c)) continue;
          if (out.length >= LIMITS.candidates) return out;
          seen.add(c);
          out.push(c);
          next.push(c);
        }
      level = next;
    }
    return out;
  }

  /** The session Claude Code's record of process pid names (<pid>.json;
   * the <pid>.<hex>.key beside it is never read): when the record is a
   * file of the user's own in a directory no one else may write, is of
   * that pid, names a session id and, when the process's start is known,
   * has a numeric startedAt within recordSlackMs of it (a pid reused by
   * another process has an old record, and a record without the time
   * proves nothing). null otherwise. */
  async readRecord(file: string, pid: number): Promise<string | null> {
    let b: Buffer;
    try {
      b = await this.files.readRecord(posix.dirname(file), posix.basename(file), LIMITS.record);
    } catch {
      return null;
    }
    let rec: unknown;
    try {
      rec = JSON.parse(b.toString('utf8'));
    } catch {
      return null;
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    const r = rec as Record<string, unknown>;
    if (r.pid !== pid || typeof r.sessionId !== 'string' || !validSessionId(r.sessionId)) return null;
    const start = await this.startOf(pid);
    if (start !== null) {
      const ms = r.startedAt;
      if (typeof ms !== 'number' || ms <= 0 || ms > 1e15 || Math.abs(start - Math.trunc(ms)) > TIMING.recordSlackMs) return null;
    }
    return r.sessionId;
  }

  /** Keeps the Claude Code record that named the session of the terminal's
   * program pid ("" forgets it). */
  remember(pid: number, record: string): void {
    if (record === '') {
      this.records.delete(pid);
      return;
    }
    if (this.records.size >= LIMITS.remembered) this.records.delete(this.records.keys().next().value!);
    this.records.set(pid, record);
  }

  remembered(pid: number): string {
    return this.records.get(pid) ?? '';
  }

  /** A Codex rollout's first line, kept by path once read whole. */
  rolloutMeta(file: string): Promise<RolloutMeta | null> {
    return rolloutMeta(this, file);
  }

  /** Writes p's mtime and size, or that it is missing, to out. */
  async stampFile(out: string[], p: string): Promise<void> {
    try {
      const st = await stat(p, { bigint: true });
      out.push(`${p}\0${st.mtimeNs}\0${st.size}\n`);
    } catch {
      out.push(`${p}\0-\n`);
    }
  }
}

/** home/rel, "" without a home. */
const under = (home: string, rel: string): string => (home === '' ? '' : posix.join(home, rel));
