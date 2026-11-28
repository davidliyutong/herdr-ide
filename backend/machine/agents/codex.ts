// Codex's sessions (sessions.ts): its command line, the rollouts
// (<codex home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, and
// archived_sessions) whose first line, session_meta, names the thread, its
// directory and its start, and the rollouts of its subagents' threads (a
// review, a spawned agent), which name their session as their parent.
import { posix } from 'node:path';
import { validSessionId } from '#shared/agents/kinds.ts';
import { parseRFC3339 } from '#shared/lib/gotime.ts';
import { SessionFrom } from '#shared/proto/agentproto/index.ts';
import { resolvedRoot } from './claude.ts';
import { readMetadata, type FileId } from './files.ts';
import { LIMITS, Search, TIMING, mtimeOf, sameDir, uniq, type Found, type Location, type Proc } from './common.ts';
import type { Resolver } from './sessions.ts';

/** The process whose open rollout identified this result, including a child. */
const fileOwners = new WeakMap<Found, number>();

function fromFile(id: string, pid: number): Found {
  const found = { id, source: SessionFrom.FD };
  fileOwners.set(found, pid);
  return found;
}

/** The command line, then the rollout a candidate process holds open
 * (Linux; a subagent's rollout stands for its parent session, and the
 * session's own wins), then the rollouts of the program's directory made
 * since it started, its subagents' left out: the only one (source start)
 * or the most recently written (a guess), both only when no other
 * terminal runs Codex there. */
export async function resolveCodex(r: Resolver, kind: string, p: Proc, signal: AbortSignal): Promise<Found | null> {
  const argv = codexArgv(p.argv);
  if (argv) return { id: argv, source: SessionFrom.Argv };
  if (p.pid <= 0) return null;
  const homes = await codexHomesOf(r, p.pid, p.cwd);
  if (r.procs.readsFiles) {
    const sessions = await codexSessionDirs(r, homes);
    let parent = '';
    let parentPID = 0;
    const fromFD = async (pid: number): Promise<Found | null> => {
      if (signal.aborted) return null;
      for (const t of (await r.procs.fds(pid)) ?? []) {
        const id = openRollout(t, sessions);
        if (!id) continue;
        const m = await r.rolloutMeta(t);
        if (m && m.parent !== '') {
          if (parent === '' && validSessionId(m.parent)) {
            parent = m.parent;
            parentPID = pid;
          }
          continue;
        }
        return fromFile(id, pid);
      }
      return null;
    };
    const direct = await fromFD(p.pid);
    if (direct || signal.aborted) return direct;
    for (const c of await r.candidates(p.pid)) {
      if (signal.aborted) return null;
      if (c === p.pid) continue;
      const found = await fromFD(c);
      if (found) return found;
    }
    if (parent !== '') return fromFile(parent, parentPID);
  }
  if (p.cwd === '') return null;
  const start = await r.startOf(p.pid);
  if (start === null || r.peers(kind, p.cwd) > 0) return null;
  let cs = await codexRollouts(r, homes, p.cwd, start, signal);
  if (cs.length === 0 && codexResumedArgv(p.argv)) cs = await codexRollouts(r, homes, p.cwd, start, signal, true);
  if (cs.length === 0) return null;
  if (cs.length === 1) return { id: cs[0].id, source: SessionFrom.Start };
  let newest = cs[0];
  for (const c of cs.slice(1)) if (c.mod > newest.mod) newest = c;
  return { id: newest.id, source: SessionFrom.Guess };
}

/** Whether Codex's command line resumes an existing session (e.g.
 * `codex resume --last` or interactive `codex resume`) without naming a
 * session UUID directly. */
export function codexResumedArgv(argv: readonly string[]): boolean {
  for (const a of argv) {
    if (a === '--') break;
    if (a === 'resume') return true;
  }
  return false;
}

/** The session Codex's command line resumes (resume <id>, also after
 * exec); only a session id counts, and the arguments after "--" are not
 * looked at. "" for none. */
export function codexArgv(argv: readonly string[]): string {
  for (let i = 0; i + 1 < argv.length; i++) {
    if (argv[i] === '--') break;
    if (argv[i] === 'resume' && validSessionId(argv[i + 1])) return argv[i + 1];
  }
  return '';
}

/** The Codex homes a process may write in: its own $CODEX_HOME when its
 * environment can be read (Linux) and it is trusted (none otherwise), and
 * the agent's user's. */
async function codexHomesOf(r: Resolver, pid: number, cwd: string): Promise<string[]> {
  const env = pid > 0 ? await r.procs.environ(pid) : null;
  const own = env ? r.expand(env.get('CODEX_HOME') ?? '', cwd) : '';
  if (own !== '' && !(await r.trustedDir(own, r.codexHomes()))) return [];
  return uniq(own, ...r.codexHomes());
}

/** The sessions directories of homes, as named and resolved through links
 * (the links of /proc/<pid>/fd name resolved paths). */
async function codexSessionDirs(r: Resolver, homes: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const h of homes) {
    const d = posix.join(h, 'sessions');
    out.push(d);
    const real = await r.files.realpath(d);
    if (real) out.push(posix.normalize(real));
  }
  return uniq(...out);
}

/** The session of a rollout's file name, rollout-<time>-<id>.jsonl; ""
 * for any other name. */
export function rolloutId(name: string): string {
  if (!name.endsWith('.jsonl')) return '';
  const stem = name.slice(0, -'.jsonl'.length);
  if (!stem.startsWith('rollout-') || stem.length < 'rollout-'.length + 37) return '';
  const id = stem.slice(-36);
  return stem[stem.length - 37] === '-' && validSessionId(id) ? id : '';
}

/** The session of a file a Codex process holds open when it is a rollout
 * inside one of the sessions directories. */
function openRollout(target: string, sessions: string[]): string {
  const id = rolloutId(posix.basename(target));
  return id && sessions.some((s) => target.startsWith(s + '/')) ? id : '';
}

/** The dated directories (YYYY/MM/DD, local time) that may hold a rollout
 * made between start and now (ms): from the day before start's to the day
 * after now's, as the agent's and Codex's time zones may differ; at most 9
 * days back from now and the 3 days around start. */
export function codexDays(start: number, now: number): string[] {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  };
  const shift = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);
  const name = (d: Date) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  const s = day(start);
  const n = day(now);
  const out: string[] = [];
  const add = (d: Date) => {
    const k = name(d);
    if (!out.includes(k)) out.push(k);
  };
  const first = shift(s, -1).getTime();
  for (let d = shift(n, 1); d.getTime() >= first && out.length < 9; d = shift(d, -1)) add(d);
  for (let i = -1; i <= 1; i++) add(shift(s, i));
  return out;
}

/** When a UUID of version 7 was made (its first 48 bits, ms since the
 * epoch); null for another id. */
export function uuidTime(id: string): number | null {
  if (id.length !== 36 || id[14] !== '7') return null;
  const hex = id.slice(0, 8) + id.slice(9, 13);
  return /^[0-9a-fA-F]{12}$/.test(hex) ? parseInt(hex, 16) : null;
}

/** The rollouts of homes' dated directories since start whose first line
 * is a session_meta of cwd made at start - startSlackMs or later, the
 * newest names first, reading at most LIMITS.metaReads first lines. */
async function codexRollouts(
  r: Resolver,
  homes: string[],
  cwd: string,
  start: number,
  signal: AbortSignal,
  resumed = false,
): Promise<Array<{ id: string; mod: number }>> {
  const since = start - TIMING.startSlackMs;
  const out: Array<{ id: string; mod: number }> = [];
  let reads = 0;
  for (const h of homes)
    for (const d of codexDays(start, r.now())) {
      const dir = posix.join(h, 'sessions', d);
      const ents = (await r.files.readDir(dir, LIMITS.entries)).sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
      for (const e of ents) {
        const id = rolloutId(e.name);
        if (!id || !e.isFile() || out.some((c) => c.id === id)) continue;
        const st = await r.files.lstat(posix.join(dir, e.name));
        if (!st || mtimeOf(st) < since) continue;
        if (reads >= LIMITS.metaReads || signal.aborted) return out;
        reads++;
        const m = await r.rolloutMeta(posix.join(dir, e.name));
        if (!m || m.id !== id || m.parent !== '' || !(await sameDir(r.files, m.cwd, cwd)) || (!resumed && m.started < since)) continue;
        out.push({ id, mod: mtimeOf(st) });
      }
    }
  return out;
}

/** What a rollout's first line (session_meta) says: its thread's id,
 * directory and start (ms), and for a subagent's thread (a review, a
 * spawned agent) the session it works for: parent_thread_id, else a
 * session_id other than its own id; "" for a session's own thread. */
export interface RolloutMeta {
  id: string;
  cwd: string;
  parent: string;
  started: number;
}

/** A rollout's session_meta, kept by path once read. */
export async function rolloutMeta(r: Resolver, file: string): Promise<RolloutMeta | null> {
  const known = r.metas.get(file);
  if (known) return known;
  let m: RolloutMeta | null;
  try {
    const fh = await r.files.openNoFollow(file);
    try {
      m = await readMetadata(fh, LIMITS.metaLine, decodeSessionMeta);
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    return null;
  }
  if (!m) return null;
  if (r.metas.size >= LIMITS.remembered) r.metas.delete(r.metas.keys().next().value!);
  r.metas.set(file, m);
  return m;
}

/** A rollout's first line, a session_meta, read member by member until it
 * has the type, the thread's id, its directory and when it was made
 * (payload.timestamp, else the line's): the line goes on with the model's
 * instructions, tens of KiB or more, which are never needed. Any other
 * first line, or one cut off before those members, is not a session_meta. */
export function decodeSessionMeta(head: Buffer | string): RolloutMeta | null {
  const s = typeof head === 'string' ? head : head.toString('utf8');
  const sc = new Scanner(s);
  if (!sc.open('{')) return null;
  let typ = '';
  let lineTS = '';
  let ts = '';
  let session = '';
  let parent = '';
  const m: RolloutMeta = { id: '', cwd: '', parent: '', started: 0 };
  const done = () => typ === 'session_meta' && m.id !== '' && m.cwd !== '' && ts !== '';
  const finish = (): RolloutMeta | null => {
    const t = parseRFC3339(ts);
    if (!t) return null;
    m.started = t.getTime();
    if (parent !== '' && parent !== m.id) m.parent = parent;
    else if (session !== '' && session !== m.id) m.parent = session;
    return m;
  };
  for (let first = true; ; first = false) {
    const k = sc.key(first, '}');
    if (k === null) return null; // the object ended, or no member
    switch (k) {
      case 'type': {
        const v = sc.string();
        if (v === null || v !== 'session_meta') return null;
        typ = v;
        break;
      }
      case 'timestamp': {
        const v = sc.string();
        if (v === null) return null;
        lineTS = v;
        break;
      }
      case 'payload': {
        if (!sc.open('{')) return null;
        for (let pf = true; ; pf = false) {
          const pk = sc.key(pf, '}');
          if (pk === null) {
            if (!sc.closed) return null;
            break;
          }
          const v = ['id', 'session_id', 'parent_thread_id', 'cwd', 'timestamp'].includes(pk) ? sc.string() : sc.skip() ? '' : null;
          if (v === null) return null;
          if (pk === 'id') m.id = v;
          else if (pk === 'session_id') session = v;
          else if (pk === 'parent_thread_id') parent = v;
          else if (pk === 'cwd') m.cwd = v;
          else if (pk === 'timestamp') ts = v;
          if (done()) return finish();
        }
        if (ts === '') ts = lineTS;
        break;
      }
      default:
        if (!sc.skip()) return null;
    }
    if (done()) return finish();
  }
}

/** Reads JSON a member at a time, as Go's json.Decoder tokens do: what is
 * cut off fails. */
class Scanner {
  private i = 0;
  /** The last key() ended at the object's close. */
  closed = false;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  private space(): void {
    while (this.i < this.s.length && ' \t\n\r'.includes(this.s[this.i])) this.i++;
  }

  /** Takes c (an object's or array's start). */
  open(c: string): boolean {
    this.space();
    if (this.s[this.i] !== c) return false;
    this.i++;
    return true;
  }

  /** The next member's key and its colon; null at the object's close
   * (closed) or on anything else. */
  key(first: boolean, close: string): string | null {
    this.closed = false;
    this.space();
    if (this.s[this.i] === close) {
      this.i++;
      this.closed = true;
      return null;
    }
    if (!first) {
      if (this.s[this.i] !== ',') return null;
      this.i++;
      this.space();
    }
    const k = this.string();
    if (k === null) return null;
    this.space();
    if (this.s[this.i] !== ':') return null;
    this.i++;
    return k;
  }

  /** A string value; null when the value is no string or is cut off. */
  string(): string | null {
    this.space();
    if (this.s[this.i] !== '"') return null;
    const end = stringEnd(this.s, this.i);
    if (end < 0) return null;
    try {
      const v = JSON.parse(this.s.slice(this.i, end)) as string;
      this.i = end;
      return v;
    } catch {
      return null;
    }
  }

  /** Passes over a whole value; false when it is cut off. */
  skip(): boolean {
    this.space();
    const end = valueEnd(this.s, this.i);
    if (end < 0) return false;
    try {
      JSON.parse(this.s.slice(this.i, end));
    } catch {
      return false;
    }
    this.i = end;
    return true;
  }
}

/** The index after the string that starts at s[i] (a quote); -1 when it
 * does not end. */
function stringEnd(s: string, i: number): number {
  for (let j = i + 1; ;) {
    const q = s.indexOf('"', j);
    if (q < 0) return -1;
    let n = 0;
    for (let p = q - 1; p > i && s[p] === '\\'; p--) n++;
    if (n % 2 === 0) return q + 1;
    j = q + 1;
  }
}

/** The index after the JSON value that starts at s[i]; -1 when it does not
 * end. */
function valueEnd(s: string, i: number): number {
  if (i >= s.length) return -1;
  const c = s[i];
  if (c === '"') return stringEnd(s, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    for (let j = i; j < s.length;) {
      const d = s[j];
      if (d === '"') {
        j = stringEnd(s, j);
        if (j < 0) return -1;
        continue;
      }
      if (d === '{' || d === '[') depth++;
      else if ((d === '}' || d === ']') && --depth === 0) return j + 1;
      j++;
    }
    return -1;
  }
  let j = i;
  while (j < s.length && !',}] \t\r\n'.includes(s[j])) j++;
  return j === i || j === s.length ? -1 : j;
}

/** What resolve reads for Codex: for each dated directory, the newest
 * rollout's name (names start with the time they were made) and how many
 * there are; while the answer is a guess, the newest one's mtime too. */
export async function codexStamp(r: Resolver, p: Proc, last: Found, out: string[]): Promise<void> {
  if (last.source === SessionFrom.Argv) return;
  const homes = await codexHomesOf(r, p.pid, p.cwd);
  if (last.source === SessionFrom.FD && r.procs.readsFiles) {
    const sessions = await codexSessionDirs(r, homes);
    const fds = (await r.procs.fds(fileOwners.get(last) ?? p.pid))?.filter((path) => !!openRollout(path, sessions));
    if (fds?.length) {
      out.push(...fds.sort());
      return;
    }
  }
  const now = r.now();
  const start = (await r.startOf(p.pid)) ?? now;
  for (const h of homes)
    for (const d of codexDays(start, now)) {
      const dir = posix.join(h, 'sessions', d);
      let newest = '';
      let n = 0;
      for (const e of await r.files.readDir(dir, LIMITS.entries))
        if (rolloutId(e.name)) {
          n++;
          if (e.name > newest) newest = e.name;
        }
      out.push(`${dir}\0${newest}\0${n}\n`);
      if (newest !== '' && last.source === SessionFrom.Guess) await r.stampFile(out, posix.join(dir, newest));
    }
}

/** rollout-*-<id>.jsonl in every Codex home's sessions and
 * archived_sessions, directly in them and in their dated directories.
 * Where a rollout is made is read first: the dated directories of now
 * and, for a time-ordered id (UUID version 7, which Codex makes), of the
 * day the id names; with walk the others are read when those have no
 * match. */
export async function searchCodex(
  r: Resolver,
  s: Search,
  id: string,
  now: number,
  walk: boolean,
  extraCodexHomes?: readonly string[],
): Promise<void> {
  const suffix = `-${id}.jsonl`;
  const match = async (root: string, dir: string): Promise<number> => {
    let n = 0;
    // archived_sessions keeps every archived rollout side by side.
    for (const e of await r.files.readDir(dir, dir === root ? LIMITS.archived : LIMITS.entries)) {
      if (!e.name.startsWith('rollout-')) continue;
      if (e.name.endsWith(suffix)) {
        if (await s.consider(r.files, root, posix.join(dir, e.name))) n++;
      } else if (e.name.endsWith(suffix + '.zst')) {
        s.compressed = true;
        n++;
      }
    }
    return n;
  };
  const days = codexDays(now, now);
  const t = uuidTime(id);
  if (t !== null) for (const d of codexDays(t, t)) if (!days.includes(d)) days.push(d);
  for (const h of r.codexHomes(extraCodexHomes))
    for (const sub of ['sessions', 'archived_sessions']) {
      const root = await resolvedRoot(r, posix.join(h, sub));
      if (!root) continue;
      let n = await match(root, root);
      for (const d of days) n += await match(root, posix.join(root, d));
      if (n === 0 && walk) await walkDated(r, root, (dir) => match(root, dir));
    }
}

/** Calls fn with each YYYY/MM/DD directory under root (names of digits
 * only; linked directories are not followed), reading at most
 * LIMITS.walkDirs directories. */
async function walkDated(r: Resolver, root: string, fn: (dir: string) => Promise<unknown>): Promise<void> {
  let n = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const e of await r.files.readDir(dir, LIMITS.entries)) {
      if (n >= LIMITS.walkDirs) return;
      if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
      n++;
      const sub = posix.join(dir, e.name);
      if (depth === 2) await fn(sub);
      else await walk(sub, depth + 1);
    }
  };
  await walk(root, 0);
}

/** The rollouts of a Codex session's subagents' threads (rolloutMeta's
 * parent is the session): those in the session's rollout's directory and,
 * in a dated tree, the dated directories from the session's start to now,
 * each a regular file of the user's own with one name inside the session
 * root, in name order; at most LIMITS.subagents, reading at most
 * LIMITS.metaReads first lines. A subagent's thread starts after its
 * session's, so a rollout whose id (a UUID of version 7) was made before
 * the session's is not read. */
export async function codexSubagents(r: Resolver, loc: Location, id: string): Promise<Array<{ path: string; id: FileId }>> {
  const dirs = [posix.dirname(loc.file)];
  const start = uuidTime(id);
  if (start !== null && posix.dirname(loc.file) !== loc.root)
    for (const d of codexDays(start, r.now())) {
      const dir = posix.join(loc.root, d);
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  const names: string[] = [];
  for (const dir of dirs)
    for (const e of await r.files.readDir(dir, LIMITS.entries)) {
      const sub = rolloutId(e.name);
      if (!sub || sub === id || !e.isFile()) continue;
      const t = uuidTime(sub);
      if (t !== null && start !== null && t < start) continue;
      names.push(posix.join(dir, e.name));
    }
  names.sort();
  const out: Array<{ path: string; id: FileId }> = [];
  let reads = 0;
  for (const p of names) {
    if (out.length >= LIMITS.subagents || reads >= LIMITS.metaReads) break;
    reads++;
    const m = await r.rolloutMeta(p);
    if (!m || m.parent !== id) continue;
    const s = new Search();
    if (await s.consider(r.files, loc.root, p)) out.push({ path: s.best!.file, id: s.best!.id });
  }
  return out;
}
