// Claude Code's sessions (sessions.ts): its command line, its record of its
// process (<claude dir>/sessions/<pid>.json, rewritten on /clear), its
// transcripts (<claude dir>/projects/<escaped directory>/<id>.jsonl) and
// its subagents' (<session>/subagents/*.jsonl).
import type { FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import { validSessionId } from '#shared/agents/kinds.ts';
import { parseRFC3339 } from '#shared/lib/gotime.ts';
import { SessionFrom } from '#shared/proto/agentproto/index.ts';
import type { FileId } from './files.ts';
import { LIMITS, Search, TIMING, mtimeOf, recordPid, samePath, uniq, type Found, type Info, type Location, type Proc } from './common.ts';
import type { Resolver } from './sessions.ts';

/** The longest project directory name Claude Code makes from a directory
 * as it is; a longer one is cut there and followed by a hash. */
export const CLAUDE_MAX_NAME = 200;

/** The command line first, then Claude Code's record of the program or of
 * a descendant (which wins when it names another session than the command
 * line: /clear starts a new one), then a guess. */
export async function resolveClaude(r: Resolver, kind: string, p: Proc, signal: AbortSignal): Promise<Found | null> {
  const initial = claudeArgv(p.argv);
  const fromArgv = initial ? { id: initial, source: SessionFrom.Argv } : null;
  if (p.pid <= 0) return fromArgv;
  const { rec, cands, child } = await claudeRecord(r, p, signal);
  if (rec) {
    r.remember(p.pid, rec.file);
    return rec.id === initial ? fromArgv : { id: rec.id, source: SessionFrom.PID };
  }
  r.remember(p.pid, '');
  if (fromArgv) return fromArgv;
  if (child || signal.aborted) return null;
  return claudeGuess(r, kind, p, cands, signal);
}

/** The session Claude Code's command line names: --session-id <id> (or
 * --session-id=<id>), else --resume <id> (-r <id>, --resume=<id>) unless
 * --fork-session makes a new one. Only a session id counts; the arguments
 * after "--" are not options. "" for none. */
export function claudeArgv(argv: readonly string[]): string {
  let sid = '';
  let resumed = '';
  let fork = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    const next = argv[i + 1] ?? '';
    if (a === '--session-id') sid = next;
    else if (a.startsWith('--session-id=')) sid = a.slice('--session-id='.length);
    else if (a === '--resume' || a === '-r') resumed = next;
    else if (a.startsWith('--resume=')) resumed = a.slice('--resume='.length);
    else if (a === '--fork-session') fork = true;
  }
  if (validSessionId(sid)) return sid;
  if (!fork && validSessionId(resumed)) return resumed;
  return '';
}

/** Claude Code's record of the terminal's program and, when it has none,
 * of its descendants (cands, kept for the guess). child: a candidate's
 * environment says it is the child session of another Claude Code, which
 * keeps neither a record nor a transcript. */
async function claudeRecord(
  r: Resolver,
  p: Proc,
  signal: AbortSignal,
): Promise<{ rec: { id: string; file: string } | null; cands: number[]; child: boolean }> {
  let child = false;
  const attempt = async (pid: number) => {
    const { dirs, child: c } = await claudeDirsOf(r, pid, p.cwd);
    child ||= c;
    for (const d of dirs) {
      const file = posix.join(d, 'sessions', `${pid}.json`);
      const id = await r.readRecord(file, pid);
      if (id) return { id, file };
    }
    return null;
  };
  let rec = await attempt(p.pid);
  if (rec) return { rec, cands: [p.pid], child };
  const cands = await r.candidates(p.pid);
  for (const c of cands.slice(1)) {
    if (signal.aborted) break;
    if ((rec = await attempt(c))) return { rec, cands, child };
  }
  return { rec: null, cands, child };
}

/** The configuration directories a process of Claude Code may keep its
 * record in: its own $CLAUDE_CONFIG_DIR when its environment can be read
 * (Linux) and it is trusted (none otherwise: no record there is
 * believed), else the agent's user's. child: the environment has
 * CLAUDE_CODE_CHILD_SESSION. */
export async function claudeDirsOf(r: Resolver, pid: number, cwd: string): Promise<{ dirs: string[]; child: boolean }> {
  const env = pid > 0 ? await r.procs.environ(pid) : null;
  if (env) {
    const child = (env.get('CLAUDE_CODE_CHILD_SESSION') ?? '') !== '';
    const d = r.expand(env.get('CLAUDE_CONFIG_DIR') ?? '', cwd);
    if (d !== '') return { dirs: (await r.trustedDir(d, r.claudeDirs())) ? [d] : [], child };
    return { dirs: r.claudeDirs(), child };
  }
  return { dirs: r.claudeDirs(), child: false };
}

/** The sessions the records of other running processes name: a guess
 * never takes them (another Claude Code, maybe one outside the terminals,
 * works in the same directory). */
async function claimed(r: Resolver, dirs: string[], cands: number[], signal: AbortSignal): Promise<Set<string>> {
  const out = new Set<string>();
  let n = 0;
  for (const d of dirs) {
    const sdir = posix.join(d, 'sessions');
    for (const e of await r.files.readDir(sdir, LIMITS.entries)) {
      const pid = recordPid(e.name);
      if (pid === null || !e.isFile() || cands.includes(pid)) continue;
      if (n >= LIMITS.claims || signal.aborted) return out;
      n++;
      if ((await r.startOf(pid)) === null) continue;
      const id = await r.readRecord(posix.join(sdir, e.name), pid);
      if (id) out.add(id);
    }
  }
  return out;
}

/** The newest transcript of the program's directory written since the
 * program started, which no other running process's record claims and
 * whose first conversation line names the directory; only when no other
 * terminal runs Claude Code there. */
async function claudeGuess(r: Resolver, kind: string, p: Proc, cands: number[], signal: AbortSignal): Promise<Found | null> {
  if (p.cwd === '' || r.peers(kind, p.cwd) > 0) return null;
  const start = await r.startOf(p.pid);
  if (start === null) return null;
  const since = start - TIMING.startSlackMs;
  const own = (await claudeDirsOf(r, p.pid, p.cwd)).dirs;
  const dirs = uniq(...own, ...r.claudeDirs());
  const cs: Array<{ id: string; file: string; mod: number }> = [];
  for (const d of dirs)
    for (const dir of await claudeProjectDirs(r, posix.join(d, 'projects'), p.cwd))
      for (const e of await r.files.readDir(dir, LIMITS.entries)) {
        const id = e.name.endsWith('.jsonl') ? e.name.slice(0, -'.jsonl'.length) : '';
        if (!validSessionId(id) || !e.isFile()) continue;
        const st = await r.files.lstat(posix.join(dir, e.name));
        if (!st || mtimeOf(st) < since) continue;
        cs.push({ id, file: posix.join(dir, e.name), mod: mtimeOf(st) });
      }
  if (cs.length === 0) return null;
  const taken = await claimed(r, dirs, cands, signal);
  cs.sort((a, b) => b.mod - a.mod);
  let tried = 0;
  for (const c of cs) {
    if (taken.has(c.id)) continue;
    if (tried >= LIMITS.confirm || signal.aborted) break;
    tried++;
    let fh: FileHandle;
    try {
      fh = await r.files.openNoFollow(c.file);
    } catch {
      continue;
    }
    try {
      if (samePath((await claudeInfoOf(fh)).cwd, p.cwd)) return { id: c.id, source: SessionFrom.Guess };
    } finally {
      await fh.close().catch(() => {});
    }
  }
  return null;
}

/** The name Claude Code gives a directory's projects directory: every
 * character but an ASCII letter or digit becomes "-", one per UTF-16 code
 * unit. */
export function claudeEscape(cwd: string): string {
  let out = '';
  for (const ch of cwd) {
    if (/^[A-Za-z0-9]$/.test(ch)) out += ch;
    else out += ch.length > 1 ? '--' : '-';
  }
  return out;
}

/** The directories of a projects directory (<a claude dir>/projects) that
 * may hold cwd's transcripts: the escaped name, or for a long one every
 * directory that starts with its first CLAUDE_MAX_NAME characters and a
 * "-" (the hash after it is not reproduced; the transcripts' own cwd tells
 * them apart). */
export async function claudeProjectDirs(r: Resolver, projects: string, cwd: string): Promise<string[]> {
  const esc = claudeEscape(cwd);
  if (esc.length <= CLAUDE_MAX_NAME) return [posix.join(projects, esc)];
  const prefix = esc.slice(0, CLAUDE_MAX_NAME) + '-';
  return (await r.files.readDir(projects, LIMITS.projects))
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => posix.join(projects, e.name))
    .sort();
}

/** The directory and time of a Claude Code transcript's first
 * conversation line (user, assistant or system with a cwd), reading at
 * most LIMITS.headLines lines and LIMITS.head bytes; lines longer than
 * LIMITS.headLine (attachments) are passed over. */
export async function claudeInfoOf(fh: FileHandle): Promise<Info> {
  const none: Info = { cwd: '', started: null };
  // A line starting before head may extend past it by one bounded line.
  const max = LIMITS.head + LIMITS.headLine;
  let parts: Buffer[] = [];
  let length = 0;
  let lines = 0;
  const readLine = () => {
    if (!parts.length) return null;
    const line = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
    return line.includes('"cwd"') ? conversationLine(line.toString('utf8')) : null;
  };
  for (let offset = 0; offset < max;) {
    const buf = Buffer.allocUnsafe(Math.min(16 << 10, max - offset));
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    if (!bytesRead) break;
    const data = buf.subarray(0, bytesRead);
    for (let at = 0; at < data.length;) {
      const newline = data.indexOf(10, at);
      const end = newline < 0 ? data.length : newline + 1;
      length += end - at;
      if (length <= LIMITS.headLine) parts.push(data.subarray(at, end));
      else if (parts.length) parts = [];
      if (newline < 0) break;
      const found = readLine();
      if (found) return found;
      if (++lines >= LIMITS.headLines || offset + end >= LIMITS.head) return none;
      parts = [];
      length = 0;
      at = end;
    }
    offset += bytesRead;
  }
  return readLine() ?? none;
}

/** The directory and time a line of a transcript gives when it is a
 * conversation line with a directory. */
function conversationLine(line: string): Info | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string): string | null => (o[k] === undefined || o[k] === null ? '' : typeof o[k] === 'string' ? (o[k] as string) : null);
  const [type, cwd, ts] = [str('type'), str('cwd'), str('timestamp')];
  if (type === null || cwd === null || ts === null) return null;
  if (cwd === '' || !['user', 'assistant', 'system'].includes(type)) return null;
  return { cwd, started: parseRFC3339(ts)?.getTime() ?? null };
}

/** What resolve reads for Claude Code: the records of the program (its
 * own, the one that last named its session) and their directories (a
 * record made or removed); while no session or only a guess is known, the
 * projects directories of the program's directory too (a transcript
 * made). */
export async function claudeStamp(r: Resolver, p: Proc, last: Found, out: string[]): Promise<void> {
  const { dirs } = await claudeDirsOf(r, p.pid, p.cwd);
  if (p.pid > 0) {
    for (const d of dirs) {
      await r.stampFile(out, posix.join(d, 'sessions'));
      await r.stampFile(out, posix.join(d, 'sessions', `${p.pid}.json`));
    }
    const rec = r.remembered(p.pid);
    if (rec) await r.stampFile(out, rec);
  }
  if ((last.id === '' || last.source === SessionFrom.Guess) && p.cwd !== '')
    for (const d of uniq(...dirs, ...r.claudeDirs())) {
      const projects = posix.join(d, 'projects');
      await r.stampFile(out, projects);
      for (const dir of await claudeProjectDirs(r, projects, p.cwd)) await r.stampFile(out, dir);
    }
}

/** <id>.jsonl in every project directory of every configuration
 * directory. */
export async function searchClaude(r: Resolver, s: Search, id: string): Promise<void> {
  for (const d of r.claudeDirs()) {
    const root = await resolvedRoot(r, posix.join(d, 'projects'));
    if (!root) continue;
    for (const e of await r.files.readDir(root, LIMITS.projects)) {
      const dir = posix.join(root, e.name);
      await s.consider(r.files, root, posix.join(dir, `${id}.jsonl`));
      if (await r.files.lstat(posix.join(dir, `${id}.jsonl.zst`))) s.compressed = true;
    }
  }
}

/** The transcripts of a Claude Code session's subagents
 * (<session>/subagents/*.jsonl beside its transcript), each a regular file
 * of the user's own with one name inside the session root, in name order,
 * at most LIMITS.subagents. */
export async function claudeSubagents(r: Resolver, loc: Location): Promise<Array<{ path: string; id: FileId }>> {
  const dir = posix.join(loc.file.replace(/\.jsonl$/, ''), 'subagents');
  const names = (await r.files.readDir(dir, LIMITS.entries))
    .map((e) => e.name)
    .filter((n) => n.endsWith('.jsonl'))
    .sort();
  const out: Array<{ path: string; id: FileId }> = [];
  for (const n of names) {
    if (out.length >= LIMITS.subagents) break;
    const s = new Search();
    if (await s.consider(r.files, loc.root, posix.join(dir, n))) out.push({ path: s.best!.file, id: s.best!.id });
  }
  return out;
}

/** A session root resolved through links; null when it is not a
 * directory. */
export async function resolvedRoot(r: Resolver, p: string): Promise<string | null> {
  const real = await r.files.realpath(p);
  if (!real || !posix.isAbsolute(real)) return null;
  const st = await r.files.lstat(real);
  return st?.isDirectory() ? real : null;
}
