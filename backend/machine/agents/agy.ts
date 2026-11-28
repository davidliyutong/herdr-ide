// Antigravity's sessions (sessions.ts): its command line (--conversation,
// --resume, -r), the conversation database a candidate process holds open
// (Linux /proc/<pid>/fd -> conversations/<uuid>.db*), and its summary index
// (<agy dir>/conversation_summaries.db) which maps root conversations to
// their workspace URIs, active state and last-modified time.
//
// All external SQLite reads run off the node's main thread via Resolver's
// ReadOnlySQLiteWorker so slow mounts, large scans, or TOCTOU FIFOs never
// stall the single-threaded event loop.
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validSessionId } from '#shared/agents/kinds.ts';
import { SessionFrom } from '#shared/proto/agentproto/index.ts';
import { resolvedRoot } from './claude.ts';
import { Search, TIMING, clean, mtimeOf, sameDir, uniq, type Found, type Info, type Proc } from './common.ts';
import type { Resolver } from './sessions.ts';
import type { SQLRow } from './sqlworker.ts';

/** The process whose open conversation database identified this result. */
const fileOwners = new WeakMap<Found, number>();

const SIDE_FILES = ['-wal', '-shm', '-journal'];
const MAX_SUMMARIES = 512;
const MAX_TRAJ_META = 64 << 10;
const MAX_TRAJ_ROWS = 64;

function fromFile(id: string, pid: number): Found {
  const found = { id, source: SessionFrom.FD };
  fileOwners.set(found, pid);
  return found;
}

/** The session Antigravity's command line names (--conversation, --resume,
 * -r); only a lower-case UUID counts, and arguments after "--" are not
 * looked at. "" for none. */
export function agyArgv(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') break;
    const next = argv[i + 1] ?? '';
    let cand = '';
    if (a === '--conversation' || a === '--resume' || a === '-r') cand = next;
    else if (a.startsWith('--conversation=')) cand = a.slice('--conversation='.length);
    else if (a.startsWith('--resume=')) cand = a.slice('--resume='.length);
    if (validSessionId(cand)) return cand;
  }
  return '';
}

/** Whether Antigravity's command line resumes an existing conversation
 * without naming its UUID directly (e.g. `agy --continue`). */
export function agyResumedArgv(argv: readonly string[]): boolean {
  for (const a of argv) {
    if (a === '--') break;
    if (a === '--continue' || a === '-c' || a === '--resume' || a === '-r') return true;
  }
  return false;
}

/** The conversation id of a database file name (<uuid>.db or its SQLite
 * side files); "" for any other name. */
export function agyConvId(name: string): string {
  let stem = name;
  for (const suffix of ['.db-wal', '.db-shm', '.db-journal', '.db']) {
    if (stem.endsWith(suffix)) {
      stem = stem.slice(0, -suffix.length);
      return validSessionId(stem) ? stem : '';
    }
  }
  return '';
}

/** The --app-data-dir argument from argv (if any); "" for none. */
function appDataArg(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') break;
    if (a === '--app-data-dir' && i + 1 < argv.length) return argv[i + 1]!;
    if (a.startsWith('--app-data-dir=')) return a.slice('--app-data-dir='.length);
  }
  return '';
}

/** The Antigravity data directories a process may write in: its own
 * --app-data-dir when trusted, plus the agent's user's directories. */
async function agyDirsOf(r: Resolver, argv: readonly string[], cwd: string): Promise<string[]> {
  const custom = appDataArg(argv).trim();
  if (custom) {
    const h = r.home();
    const resolved =
      posix.isAbsolute(custom) || custom.startsWith('~/') ? r.expand(custom, cwd) : h ? posix.join(h, '.gemini', custom) : '';
    if (resolved && (await r.trustedDir(resolved, r.agyDirs()))) return uniq(resolved, ...r.agyDirs());
  }
  return r.agyDirs();
}

/** The conversations directories of dirs, as named and resolved through
 * links (for matching /proc/<pid>/fd targets). */
async function agyConvDirs(r: Resolver, dirs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const d of dirs) {
    const c = posix.join(d, 'conversations');
    out.push(c);
    const real = await r.files.realpath(c);
    if (real) out.push(posix.normalize(real));
  }
  return uniq(...out);
}

/** The conversation id of a file a process holds open when it lives inside
 * one of the conversations directories. */
function openConv(target: string, convDirs: readonly string[]): string {
  const id = agyConvId(posix.basename(target));
  return id && convDirs.some((d) => target.startsWith(d + '/')) ? id : '';
}

/** Converts a file:// URI or plain path to a cleaned POSIX directory path. */
function uriToPath(s: string): string {
  const t = s.trim();
  if (!t) return '';
  if (t.startsWith('file://')) {
    try {
      const p = decodeURIComponent(new URL(t).pathname);
      if (p) return clean(p);
    } catch {
      // fall through
    }
  }
  return t.startsWith('/') ? clean(t) : '';
}

/** Parses workspace_uris (JSON array of file:// URIs or paths). */
function parseWorkspaces(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const item of v) {
      if (typeof item !== 'string') continue;
      const p = uriToPath(item);
      if (p) out.push(p);
    }
    return uniq(...out);
  } catch {
    return [];
  }
}

/** Parses SQLite datetime text (e.g. "2026-11-26 20:00:15.761865+00:00")
 * or numeric timestamps into epoch milliseconds; null when invalid. */
function parseSqliteTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v < 1e12 ? Math.trunc(v * 1000) : Math.trunc(v);
  }
  if (typeof v === 'bigint') {
    const n = Number(v);
    if (n > 0) return n < 1e12 ? Math.trunc(n * 1000) : Math.trunc(n);
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  // Normalize SQLite "YYYY-MM-DD HH:MM:SS.ffffff+00:00" to ISO-8601.
  let iso = s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s;
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

interface SummaryRow {
  id: string;
  workspaces: string[];
  parent: string;
  nestingDepth: number;
  running: boolean;
  active: boolean;
  killed: boolean;
  modifiedMs: number | null;
}

/** Checks that a SQLite database and any side files beside it are regular
 * user-owned files (never symlinks or FIFOs) and returns the worker open spec. */
async function safeDbTarget(r: Resolver, dbPath: string): Promise<{ path?: string; url?: string } | null> {
  // Reject a symlink at dbPath itself before resolving parent symlinks.
  const directSt = await r.files.lstatOwn(dbPath);
  if (!directSt) return null;
  for (const suffix of SIDE_FILES) {
    const st = await r.files.lstat(dbPath + suffix);
    if (!st) continue;
    if (!st.isFile() || (r.files.uid >= 0 && Number(st.uid) !== r.files.uid)) return null;
  }
  const real = await r.files.realpath(dbPath);
  if (!real) return null;
  const mainSt = await r.files.lstatOwn(real);
  if (!mainSt || mainSt.dev !== directSt.dev || mainSt.ino !== directSt.ino) return null;
  let wal = false;
  for (const suffix of SIDE_FILES) {
    const st = await r.files.lstat(real + suffix);
    if (!st) continue;
    if (!st.isFile() || (r.files.uid >= 0 && Number(st.uid) !== r.files.uid)) return null;
    if (suffix === '-wal') wal = true;
  }
  if (!wal) {
    const u = pathToFileURL(real);
    u.searchParams.set('immutable', '1');
    return { url: u.href };
  }
  return { path: real };
}

async function tableColumns(
  all: (sql: string, params?: (string | number)[]) => Promise<SQLRow[] | null>,
  table: string,
): Promise<Set<string>> {
  const rows = await all('SELECT name FROM pragma_table_info(?)', [table]);
  if (!rows) return new Set();
  return new Set(rows.map((r) => String(r.name ?? '')));
}

/** Reads recent rows from <dir>/conversation_summaries.db safely off the main thread. */
async function readSummaries(r: Resolver, dir: string, onlyId?: string, signal?: AbortSignal): Promise<SummaryRow[]> {
  const dbPath = posix.join(dir, 'conversation_summaries.db');
  const target = await safeDbTarget(r, dbPath);
  if (!target) return [];
  const rows = await r.sqlWorker().withDb(
    target,
    async (all) => {
      const cols = await tableColumns(all, 'conversation_summaries');
      if (!cols.has('conversation_id') || !cols.has('workspace_uris')) return [];
      const sel = [
        'conversation_id',
        'workspace_uris',
        cols.has('parent_conversation_id') ? 'parent_conversation_id' : "'' AS parent_conversation_id",
        cols.has('nesting_depth') ? 'nesting_depth' : '0 AS nesting_depth',
        cols.has('status') ? 'status' : "'' AS status",
        cols.has('not_fully_idle') ? 'not_fully_idle' : '0 AS not_fully_idle',
        cols.has('killed') ? 'killed' : '0 AS killed',
        cols.has('last_modified_time') ? 'last_modified_time' : 'NULL AS last_modified_time',
      ].join(', ');
      const orderCol = cols.has('last_modified_time') ? ' ORDER BY last_modified_time DESC' : '';
      const rawRows = onlyId
        ? await all(`SELECT ${sel} FROM conversation_summaries WHERE conversation_id = ? LIMIT 1`, [onlyId])
        : await all(`SELECT ${sel} FROM conversation_summaries${orderCol} LIMIT ?`, [MAX_SUMMARIES]);
      if (!rawRows) return [];
      const out: SummaryRow[] = [];
      for (const row of rawRows) {
        const id = typeof row.conversation_id === 'string' ? row.conversation_id : '';
        if (!validSessionId(id)) continue;
        const parent = typeof row.parent_conversation_id === 'string' ? row.parent_conversation_id : '';
        const nestingDepth = typeof row.nesting_depth === 'number' ? row.nesting_depth : Number(row.nesting_depth ?? 0) || 0;
        const status = typeof row.status === 'string' ? row.status : '';
        const notIdle = row.not_fully_idle === 1 || row.not_fully_idle === '1' || row.not_fully_idle === 'true';
        const killed = row.killed === 1 || row.killed === '1' || row.killed === 'true';
        out.push({
          id,
          workspaces: parseWorkspaces(row.workspace_uris),
          parent,
          nestingDepth,
          running: status === 'CASCADE_RUN_STATUS_RUNNING',
          active: status === 'CASCADE_RUN_STATUS_RUNNING' || notIdle,
          killed,
          modifiedMs: parseSqliteTime(row.last_modified_time),
        });
      }
      return out;
    },
    signal,
  );
  return rows ?? [];
}

/** Finds the parent conversation id (if any) of a conversation via
 * conversation_summaries.db, so subagents map back to their root session. */
async function parentOf(r: Resolver, dirs: readonly string[], id: string, signal?: AbortSignal): Promise<string> {
  for (const d of dirs) {
    if (signal?.aborted) return '';
    const rows = await readSummaries(r, d, id, signal);
    const hit = rows[0];
    if (hit && hit.parent && validSessionId(hit.parent)) return hit.parent;
  }
  return '';
}

/** Resolves the session of a running Antigravity CLI process: argv first,
 * then open conversation database FDs (Linux), then matching root
 * conversations in conversation_summaries.db for p.cwd (preferring active
 * or modified since start, falling back to latest when resumed). */
export async function resolveAgy(r: Resolver, kind: string, p: Proc, signal: AbortSignal): Promise<Found | null> {
  const argv = agyArgv(p.argv);
  if (argv) return { id: argv, source: SessionFrom.Argv };
  if (p.pid <= 0) return null;
  const dirs = await agyDirsOf(r, p.argv, p.cwd);
  if (r.procs.readsFiles) {
    const convDirs = await agyConvDirs(r, dirs);
    let parent = '';
    let parentPID = 0;
    // Deduplicate candidate conversation IDs across .db/-wal/-shm FDs and child
    // PIDs so parentOf() never re-opens conversation_summaries.db for the same ID.
    const checkedIds = new Set<string>();
    const fromFD = async (pid: number): Promise<Found | null> => {
      if (signal.aborted) return null;
      for (const target of (await r.procs.fds(pid)) ?? []) {
        const id = openConv(target, convDirs);
        if (!id || checkedIds.has(id)) continue;
        checkedIds.add(id);
        const par = await parentOf(r, dirs, id, signal);
        if (par) {
          if (!parent) {
            parent = par;
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
  const since = start - TIMING.startSlackMs;
  const seen = new Set<string>();
  const matches: Array<{ id: string; mod: number; running: boolean; active: boolean }> = [];
  for (const d of dirs) {
    if (signal.aborted) return null;
    const rows = await readSummaries(r, d, undefined, signal);
    for (const row of rows) {
      if (signal.aborted) return null;
      if (row.killed || row.parent !== '' || row.nestingDepth > 0 || seen.has(row.id)) continue;
      let matchedWs = false;
      for (const ws of row.workspaces) {
        if (await sameDir(r.files, ws, p.cwd)) {
          matchedWs = true;
          break;
        }
      }
      if (!matchedWs) continue;
      let mod = row.modifiedMs ?? 0;
      const dbSt = await r.files.lstat(posix.join(d, 'conversations', `${row.id}.db`));
      if (dbSt) mod = Math.max(mod, mtimeOf(dbSt));
      const walSt = await r.files.lstat(posix.join(d, 'conversations', `${row.id}.db-wal`));
      if (walSt) mod = Math.max(mod, mtimeOf(walSt));
      seen.add(row.id);
      matches.push({ id: row.id, mod, running: row.running, active: row.active });
    }
  }
  if (matches.length === 0) return null;
  const fresh = matches.filter((m) => m.mod >= since || m.active);
  if (fresh.length === 1) return { id: fresh[0]!.id, source: SessionFrom.Start };
  if (fresh.length > 1) {
    const running = fresh.filter((m) => m.running);
    if (running.length === 1) return { id: running[0]!.id, source: SessionFrom.Guess };
    const active = fresh.filter((m) => m.active);
    if (active.length === 1) return { id: active[0]!.id, source: SessionFrom.Guess };
    fresh.sort((a, b) => b.mod - a.mod);
    return { id: fresh[0]!.id, source: SessionFrom.Guess };
  }
  if (agyResumedArgv(p.argv)) {
    matches.sort((a, b) => b.mod - a.mod);
    return { id: matches[0]!.id, source: SessionFrom.Guess };
  }
  return null;
}

/** Cheap fingerprint of what resolveAgy reads: open conversation FDs when
 * resolved via FD, else conversation_summaries.db (+ WAL) and the
 * conversations directory in each Antigravity dir. */
export async function agyStamp(r: Resolver, p: Proc, last: Found, out: string[]): Promise<void> {
  if (last.source === SessionFrom.Argv) return;
  const dirs = await agyDirsOf(r, p.argv, p.cwd);
  if (last.source === SessionFrom.FD && r.procs.readsFiles) {
    const convDirs = await agyConvDirs(r, dirs);
    const fds = (await r.procs.fds(fileOwners.get(last) ?? p.pid))?.filter((path) => !!openConv(path, convDirs));
    if (fds?.length) {
      out.push(...fds.sort());
      return;
    }
  }
  for (const d of dirs) {
    await r.stampFile(out, posix.join(d, 'conversation_summaries.db'));
    await r.stampFile(out, posix.join(d, 'conversation_summaries.db-wal'));
    await r.stampFile(out, posix.join(d, 'conversations'));
  }
}

/** Locates <id>.db inside each Antigravity directory's conversations folder. */
export async function searchAgy(r: Resolver, s: Search, id: string): Promise<void> {
  for (const d of r.agyDirs()) {
    const root = await resolvedRoot(r, posix.join(d, 'conversations'));
    if (!root) continue;
    await s.consider(r.files, root, posix.join(root, `${id}.db`));
  }
}

// --- Minimal protobuf wire decoder for trajectory_metadata_blob fallback ---

function readVarint(b: Uint8Array, i: number): [number, number] | null {
  let v = 0;
  let mul = 1;
  for (let n = 0; n < 10; n++) {
    if (i >= b.length) return null;
    const x = b[i++]!;
    v += (x & 0x7f) * mul;
    mul *= 128;
    if (x < 0x80) return [v, i];
  }
  return null;
}

function* wireFields(b: Uint8Array): Generator<{ num: number; wt: number; u: number; b: Uint8Array }> {
  let i = 0;
  while (i < b.length) {
    const tag = readVarint(b, i);
    if (!tag) return;
    i = tag[1];
    const num = Math.floor(tag[0] / 8);
    const wt = tag[0] % 8;
    if (num === 0) return;
    if (wt === 0) {
      const v = readVarint(b, i);
      if (!v) return;
      i = v[1];
      yield { num, wt, u: v[0], b: new Uint8Array() };
    } else if (wt === 1) {
      if (b.length - i < 8) return;
      i += 8;
    } else if (wt === 2) {
      const l = readVarint(b, i);
      if (!l || l[0] > b.length - l[1]) return;
      const end = l[1] + l[0];
      yield { num, wt, u: 0, b: b.subarray(l[1], end) };
      i = end;
    } else if (wt === 5) {
      if (b.length - i < 4) return;
      i += 4;
    } else {
      return;
    }
  }
}

function parseTrajectoryInfo(b: Uint8Array): Info {
  let workspace = '';
  let uri = '';
  let started: number | null = null;
  for (const f of wireFields(b)) {
    if (f.wt !== 2) continue;
    if (f.num === 1 && !uri) {
      for (const s of wireFields(f.b)) {
        if (s.num === 1 && s.wt === 2 && s.b.length > 0 && s.b.length <= 4096) {
          uri = Buffer.from(s.b).toString('utf8').trim();
          break;
        }
      }
    } else if (f.num === 2 && started === null) {
      for (const t of wireFields(f.b)) {
        if (t.num === 1 && t.wt === 0 && t.u > 1_000_000_000 && t.u < 10_000_000_000) {
          started = t.u * 1000;
          break;
        }
      }
    } else if (f.num === 7 && !workspace && f.b.length > 0 && f.b.length <= 4096) {
      workspace = uriToPath(Buffer.from(f.b).toString('utf8'));
    }
  }
  return { cwd: workspace || (uri ? uriToPath(uri) : ''), started };
}

/** Reads an Antigravity conversation's workspace and timestamp from
 * conversation_summaries.db first, falling back to trajectory_metadata_blob
 * in dbPath (both executed off the main thread in Resolver's SQLite worker). */
export async function agyInfo(r: Resolver, id: string, dbPath: string): Promise<Info> {
  const baseDir = posix.dirname(posix.dirname(dbPath));
  for (const d of uniq(baseDir, ...r.agyDirs())) {
    const rows = await readSummaries(r, d, id);
    const hit = rows[0];
    if (hit && hit.workspaces.length > 0) {
      return { cwd: hit.workspaces[0]!, started: hit.modifiedMs };
    }
  }
  const target = await safeDbTarget(r, dbPath);
  if (!target) return { cwd: '', started: null };
  const info = await r.sqlWorker().withDb(target, async (all) => {
    const cols = await tableColumns(all, 'trajectory_metadata_blob');
    if (!cols.has('data')) return { cwd: '', started: null };
    // Prefer octet_length when supported (SQLite >= 3.43) so BLOB/TEXT sizes
    // are measured in bytes; fall back to length() on older builds, always with LIMIT.
    const rows =
      (await all('SELECT CASE WHEN octet_length(data) <= ? THEN data END AS data FROM trajectory_metadata_blob LIMIT ?', [
        MAX_TRAJ_META,
        MAX_TRAJ_ROWS,
      ])) ??
      (await all('SELECT CASE WHEN length(data) <= ? THEN data END AS data FROM trajectory_metadata_blob LIMIT ?', [
        MAX_TRAJ_META,
        MAX_TRAJ_ROWS,
      ]));
    if (!rows) return { cwd: '', started: null };
    let cwd = '';
    let started: number | null = null;
    for (const row of rows) {
      const b = row.data instanceof Uint8Array ? row.data : typeof row.data === 'string' ? Buffer.from(row.data) : null;
      if (!b || b.length === 0 || b.length > MAX_TRAJ_META) continue;
      const parsed = parseTrajectoryInfo(b);
      if (!cwd && parsed.cwd) cwd = parsed.cwd;
      if (started === null && parsed.started !== null) started = parsed.started;
      if (cwd && started !== null) break;
    }
    return { cwd, started };
  });
  return info ?? { cwd: '', started: null };
}
