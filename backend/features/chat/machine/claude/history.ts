// Claude Code's sessions as the chat host lists and imports them: the
// transcripts of its projects directories (#machine/agents' Resolver finds
// and opens them as the user's own regular files, through no link), read
// asynchronously and mapped by the transcript's mapping
// (#shared/agents/transcript), the one the live session's messages go
// through, so that items are named alike.
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import { validSessionId } from '#shared/agents/kinds.ts';
import { claudeFrame, eachClaude } from '#shared/agents/transcript/index.ts';
import { formatRFC3339 } from '#shared/lib/gotime.ts';
import { Notice, Transcript, noticeMethod } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ChatProtoError, Code, EventType, TurnState, type Event } from '#shared/proto/chatproto/index.ts';
import { claudeProjectDirs, type Resolver } from '#machine/agents/sessions.ts';
import { resolvedRoot } from '#machine/agents/claude.ts';
import { gone as fileGone, readHead } from '#machine/agents/files.ts';
import { cut } from './config.ts';
import { badRequest } from './content.ts';
import { eventOf, headOf, isChunk, itemOf } from './items.ts';

/** The most of a transcript history reads, its end: an earlier part is
 * left out with a notice. */
export const MAX_HISTORY = 256 << 20;
/** The transcripts of a directory sessions considers. */
const MAX_LISTED = 4096;
/** How much of a transcript's start and end describe reads, and the most
 * lines of its start. */
const SESSION_HEAD = 1 << 20;
const SESSION_TAIL = 256 << 10;
const MAX_HEAD_LINES = 256;
/** The longest title. */
const MAX_TITLE = 512;

/** What describe reads of a transcript: its directory, its title, and the
 * title the user or Claude Code gave the session (agentTitle; "" for none,
 * title then the first prompt). */
export interface Described {
  cwd: string;
  title: string;
  agentTitle: string;
}

/** The text of a prompt's blocks, on one line. */
function promptText(blocks: unknown[] | undefined): string {
  const parts: string[] = [];
  for (const b of blocks ?? []) {
    if (typeof b !== 'object' || b === null) continue;
    const o = b as { type?: unknown; text?: unknown };
    if (o.type === 'text' && typeof o.text === 'string' && o.text.trim() !== '') parts.push(o.text.trim().split(/\s+/).join(' '));
  }
  return parts.join(' ');
}

/** The complete lines of b (each without its newline). */
function linesOf(b: Buffer, skipFirst: boolean): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  if (skipFirst) {
    const nl = b.indexOf(0x0a);
    if (nl < 0) return out;
    i = nl + 1;
  }
  for (;;) {
    const nl = b.indexOf(0x0a, i);
    if (nl < 0) return out;
    out.push(b.subarray(i, nl));
    i = nl + 1;
  }
}

/** Reads a transcript's directory and titles from its start and its end:
 * the user's own title before one Claude Code made, the latest of each,
 * else the first prompt; null when it holds no conversation. */
export async function describeOpen(fh: FileHandle, size: number): Promise<Described | null> {
  let cwd = '';
  let title = '';
  let custom = '';
  let prompt = '';
  const take = (line: Buffer) => {
    const s = line.toString('utf8');
    if (cwd === '' && s.includes('"cwd"')) {
      try {
        const v = JSON.parse(s) as { type?: unknown; cwd?: unknown };
        if (typeof v.cwd === 'string' && v.cwd !== '' && (v.type === 'user' || v.type === 'assistant' || v.type === 'system'))
          cwd = clean(v.cwd);
      } catch {
        // no conversation line
      }
    }
    const fr = claudeFrame(s, { text: MAX_TITLE });
    if (fr.title !== '') {
      if (fr.custom) custom = fr.title;
      else title = fr.title;
    }
    for (const ev of fr.events) if (prompt === '' && ev.t === Transcript.User) prompt = promptText(ev.content);
  };
  const head = await readHead(fh, SESSION_HEAD);
  for (const l of linesOf(head, false).slice(0, MAX_HEAD_LINES)) take(l);
  if (size > SESSION_HEAD) {
    const start = Math.max(size - SESSION_TAIL, SESSION_HEAD);
    const b = Buffer.allocUnsafe(size - start);
    let got = 0;
    while (got < b.length) {
      const { bytesRead } = await fh.read(b, got, b.length - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    // The first line read is a part of one.
    for (const l of linesOf(b.subarray(0, got), true)) take(l);
  }
  if (cwd === '') return null;
  return { cwd, title: cut((custom || title || prompt).trim(), MAX_TITLE), agentTitle: cut((custom || title).trim(), MAX_TITLE) };
}

/** describeOpen of the transcript at path, a regular file of the user's
 * own reached through no link; null when it is none. */
async function describe(r: Resolver, path: string): Promise<Described | null> {
  let o;
  try {
    o = await r.files.openStrict(path);
  } catch {
    return null;
  }
  try {
    return await describeOpen(o.fh, Number(o.st.size));
  } catch {
    return null;
  } finally {
    await o.fh.close().catch(() => {});
  }
}

const clean = (p: string): string => {
  const c = posix.normalize(p);
  return c.length > 1 && c.endsWith('/') ? c.slice(0, -1) : c;
};

/** The title the user or Claude Code gave session id, as its transcript
 * has it; "" for none. */
export async function titleOf(r: Resolver, id: string): Promise<string> {
  const f = await r.locate('claude', id);
  const d = await describe(r, f.path);
  return d?.agentTitle.trim() ?? '';
}

/** A transcript sessions found. */
interface Listed {
  id: string;
  path: string;
  /** Its modification time in nanoseconds. */
  mod: bigint;
}

const cursorOf = (f: Listed): string => `${f.mod}:${f.id}`;

/** Whether f comes after the cursor c in sessions' order (the most recent
 * first, then by id). */
const after = (f: Listed, c: Listed | null): boolean => !c || (f.mod !== c.mod ? f.mod < c.mod : f.id > c.id);

function parseCursor(s: string): Listed | null {
  if (s === '') return null;
  const i = s.indexOf(':');
  const ns = s.slice(0, i);
  const id = s.slice(i + 1);
  if (i < 0 || !/^-?\d+$/.test(ns) || !validSessionId(id)) throw badRequest('not a cursor');
  return { id, path: '', mod: BigInt(ns) };
}

/** The transcripts in the projects directories of the configuration
 * directory d that may hold cwd's; the projects directory is resolved
 * through links, nothing below it is followed. */
async function transcriptsOf(r: Resolver, d: string, cwd: string): Promise<Listed[]> {
  const root = await resolvedRoot(r, posix.join(d, 'projects'));
  if (!root) return [];
  const out: Listed[] = [];
  for (const dir of await claudeProjectDirs(r, root, cwd)) {
    const st = await r.files.lstat(dir);
    if (!st?.isDirectory()) continue;
    const ents: Dirent[] = await r.files.readDir(dir, MAX_LISTED);
    for (const e of ents) {
      if (!e.name.endsWith('.jsonl') || !e.isFile()) continue;
      const id = e.name.slice(0, -'.jsonl'.length);
      if (!validSessionId(id)) continue;
      const path = posix.join(dir, e.name);
      const s = await r.files.lstat(path);
      if (s?.isFile()) out.push({ id, path, mod: s.mtimeNs });
    }
  }
  return out;
}

/** Claude Code's sessions of a directory, the most recently active first:
 * the transcripts of its projects directories (of every configuration
 * directory of the user's) that say they ran in it, each a regular file of
 * the user's own reached through no link. The cursor is where the page
 * before ended. */
export async function sessionsOf(
  r: Resolver,
  cwd: string,
  cursor: string,
  page: number,
  signal: AbortSignal,
): Promise<{ sessions: chat.Session[]; next: string }> {
  if (!posix.isAbsolute(cwd)) throw badRequest('the directory is not an absolute path');
  cwd = clean(cwd);
  const c = parseCursor(cursor);
  const found: Listed[] = [];
  const seen = new Set<string>();
  for (const d of r.claudeDirs())
    for (const f of await transcriptsOf(r, d, cwd))
      if (!seen.has(f.id) && after(f, c)) {
        seen.add(f.id);
        found.push(f);
      }
  found.sort((a, b) => (a.mod !== b.mod ? (b.mod > a.mod ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sessions: chat.Session[] = [];
  let next = '';
  for (let i = 0; i < found.length; i++) {
    signal.throwIfAborted();
    if (sessions.length === page) {
      next = cursorOf(found[i - 1]!);
      break;
    }
    const f = found[i]!;
    const info = await describe(r, f.path);
    if (!info || info.cwd !== cwd) continue;
    const s: chat.Session = { sessionId: f.id, cwd };
    if (info.title) s.title = info.title;
    s.updatedAt = formatRFC3339(new Date(Number(f.mod / 1000000n)));
    sessions.push(s);
  }
  return { sessions, next };
}

/** The events of a transcript, with their index, in order: its turns end
 * once each (a turn that ends without a line saying so at the next prompt
 * or the transcript's end), the usage of each response left out, items
 * named as the live session names them. */
async function walk(fh: FileHandle, size: number, fn: (i: number, ev: Event) => void, signal: AbortSignal): Promise<void> {
  const start = Math.max(size - MAX_HISTORY, 0);
  let n = 0;
  const put = (ev: Event) => fn(n++, ev);
  if (start > 0) put({ t: EventType.Notice, method: noticeMethod(Notice.Skipped), params: { bytes: start } });
  let open = false;
  const blocks = new Map<string, number>();
  await eachClaude(
    fh,
    start,
    size,
    {},
    (_off, fr) => {
      let base = blocks.get(fr.message) ?? 0;
      if (fr.first >= 0) base = fr.first;
      fr.events.forEach((tev, k) => {
        const ev = eventOf(tev);
        if (tev.at) ev.at = tev.at;
        if (ev.t === EventType.Turn) {
          if (ev.state === TurnState.Start && open) {
            // The turn before ended without a line saying so.
            const end: Event = { t: EventType.Turn, state: TurnState.End };
            if (ev.at) end.at = ev.at;
            put(end);
          } else if (ev.state !== TurnState.Start && !open) {
            // Claude Code records the end twice (the response's stop and
            // turn_duration).
            return;
          }
          open = ev.state === TurnState.Start;
        } else if (ev.t === EventType.Update) {
          const h = headOf(ev.update);
          if (h.sessionUpdate === 'usage_update') return;
          if (isChunk(h.sessionUpdate) && fr.message !== '') ev.item = itemOf(fr.message, base + Math.max(fr.blocks[k] ?? -1, 0));
          else if (h.toolCallId !== '') ev.item = h.toolCallId;
        }
        put(ev);
      });
      if (fr.message !== '') blocks.set(fr.message, Math.max(blocks.get(fr.message) ?? 0, base + fr.count));
      return true;
    },
    signal,
  );
  if (open) put({ t: EventType.Turn, state: TurnState.End });
}

/** Emits the stored events of a session's conversation from its
 * transcript, oldest first; after the item an earlier history emitted last,
 * only what came after it (the turns made in a terminal since). The whole
 * conversation starts with an info event of the session's title, when the
 * transcript has one (the user's own before Claude Code's). */
export async function historyOf(
  r: Resolver,
  p: { sessionId: string; cwd: string; after: string },
  emit: (ev: Event) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!validSessionId(p.sessionId)) throw badRequest('not a session id');
  let fh: FileHandle;
  try {
    fh = (await r.openLocated('claude', p.sessionId)).fh;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'not_found' || code === 'compressed' || fileGone(e))
      throw new ChatProtoError({ code: Code.NotFound, message: 'claude: no transcript of the session' });
    throw e;
  }
  try {
    const st = await fh.stat();
    const info = await describeOpen(fh, st.size);
    if (info && info.cwd !== '' && p.cwd !== '' && info.cwd !== clean(p.cwd)) throw badRequest('the session ran in another directory');
    let from = -1;
    if (p.after !== '') {
      let last = -1;
      await walk(fh, st.size, (i, ev) => ev.item === p.after && (last = i), signal);
      if (last < 0) throw new ChatProtoError({ code: Code.NotFound, message: 'claude: the transcript has no item ' + p.after });
      from = last;
    } else if (info && info.agentTitle !== '') emit({ t: EventType.Info, chat: { title: info.agentTitle } as chat.Chat });
    // The turn's end the chat has after the item already.
    let skipping = from >= 0;
    await walk(
      fh,
      st.size,
      (i, ev) => {
        if (i <= from) return;
        if (skipping && ev.t === EventType.Turn && ev.state !== TurnState.Start) return;
        skipping = false;
        emit(ev);
      },
      signal,
    );
  } finally {
    await fh.close().catch(() => {});
  }
}
