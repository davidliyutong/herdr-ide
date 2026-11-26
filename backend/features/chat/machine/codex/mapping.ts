// Codex's items as chat events, and the user's prompts as Codex's input:
// what does not depend on the conversation so far (whose prompt a user
// message is, which subagent a thread is: the session's). Every event's
// update is in the shape of the Agent Client Protocol's session updates,
// as the chats of every agent are.
import { posix } from 'node:path';
import { SLUG } from '#shared/lib/brand.ts';
import { formatRFC3339 } from '#shared/lib/gotime.ts';
import { noticeMethod, Notice } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ChatProtoError, Code, EventType, type ChatError, type Event } from '#shared/proto/chatproto/index.ts';
import type {
  AsyncUserInputQuestion,
  CodexErrorInfo,
  CommandAction,
  FileUpdateChange,
  ThreadItem,
  TurnError,
  UserInput,
} from './appserver.gen.ts';

/** An ACP value as the adapter builds it. */
export type Obj = Record<string, unknown>;

/** The most bytes of a tool call's title. */
export const MAX_TITLE = 1 << 10;
/** The most bytes of a session's title in a list. */
export const MAX_SESSION_TITLE = 200;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A string member as Codex's items are read, leniently: "" for none, or
 * for a value of another type (as Go's decoding of a string member left
 * it). */
export const strOf = (v: unknown): string => (typeof v === 'string' ? v : '');

/** An array member read leniently: [] for none or another type. */
const arrOf = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

/** s cut to at most n bytes of its UTF-8, at a character's start. */
export function cutText(s: string, n: number): string {
  if (s.length * 3 <= n) return s;
  const b = Buffer.from(s, 'utf8');
  if (b.length <= n) return s;
  while (n > 0 && (b[n]! & 0xc0) === 0x80) n--;
  return b.subarray(0, n).toString('utf8');
}

/** Sets a member of m's own metadata: _meta.<slug>.key. */
export function setMeta(m: Obj, key: string, v: unknown): void {
  const meta = isObj(m._meta) ? m._meta : (m._meta = {} as Obj);
  const own = isObj(meta[SLUG]) ? (meta[SLUG] as Obj) : (meta[SLUG] = {} as Obj);
  own[key] = v;
}

export const textBlock = (text: string): Obj => ({ type: 'text', text });

/** A time in milliseconds since the epoch as an event's; undefined for none
 * (the host stamps the event). */
export const timeOf = (ms: number | undefined): string | undefined => (ms && ms > 0 ? formatRFC3339(new Date(ms)) : undefined);

/** An update event of an item. */
export function updateEvent(item: string, parent: string, live: boolean, update: Obj, at?: number): Event {
  const ev: Event = { t: EventType.Update };
  const t = timeOf(at);
  if (t) ev.at = t;
  if (live) ev.live = true;
  if (item) ev.item = item;
  if (parent) ev.parent = parent;
  ev.update = update;
  return ev;
}

/** A notice of the product's own (noticeMethod). */
export function noticeEvent(name: string, parent: string, params?: Obj, at?: number): Event {
  const ev: Event = { t: EventType.Notice };
  const t = timeOf(at);
  if (t) ev.at = t;
  if (parent) ev.parent = parent;
  ev.method = noticeMethod(name);
  if (params && Object.keys(params).length > 0) ev.params = params;
  return ev;
}

export const AGENT_MESSAGE_CHUNK = 'agent_message_chunk';
export const AGENT_THOUGHT_CHUNK = 'agent_thought_chunk';

/** A message's or a thought's text as an ACP chunk of the message id. */
export const chunk = (kind: string, text: string, messageId: string): Obj => ({
  sessionUpdate: kind,
  content: textBlock(text),
  messageId,
});

/** The statuses of an ACP tool call. */
export const Tool = {
  Pending: 'pending',
  InProgress: 'in_progress',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

/** When an item completed or started, else fallback (ms). */
export function itemTime(it: ThreadItem, fallback: number | undefined): number | undefined {
  for (const ms of [it.completedAtMs, it.startedAtMs]) if (typeof ms === 'number' && ms > 0) return ms;
  return fallback;
}

export const toolCall = (id: string, title: string, kind: string, status: string): Obj => ({
  sessionUpdate: 'tool_call',
  toolCallId: id,
  title: cutText(title, MAX_TITLE),
  kind,
  status,
});

/** An item's status as an ACP tool call's: inProgress, completed, failed,
 * declined (refused by the user: failed, marked) and interrupted. */
export function toolStatus(s: string | undefined): string {
  switch (s) {
    case 'completed':
      return Tool.Completed;
    case 'failed':
    case 'declined':
      return Tool.Failed;
    case 'interrupted':
      return Tool.Cancelled;
  }
  return Tool.InProgress;
}

/** The item types the adapter maps. */
export const ItemType = {
  UserMessage: 'userMessage',
  AgentMessage: 'agentMessage',
  Plan: 'plan',
  Reasoning: 'reasoning',
  Command: 'commandExecution',
  FileChange: 'fileChange',
  McpToolCall: 'mcpToolCall',
  DynamicTool: 'dynamicToolCall',
  CollabTool: 'collabAgentToolCall',
  SubAgent: 'subAgentActivity',
  WebSearch: 'webSearch',
  ImageView: 'imageView',
  Compaction: 'contextCompaction',
} as const satisfies Record<string, ThreadItem['type']>;

/** The kinds of a subAgentActivity. */
export const SubAgent = { Started: 'started', Completed: 'completed', Stopped: 'interrupted' } as const;

/** Whether an item of the type is a tool call (stored when it starts and
 * when it completes). */
export function isTool(t: string): boolean {
  switch (t) {
    case ItemType.Command:
    case ItemType.FileChange:
    case ItemType.McpToolCall:
    case ItemType.DynamicTool:
    case ItemType.CollabTool:
    case ItemType.WebSearch:
    case ItemType.ImageView:
      return true;
  }
  return false;
}

type ItemOf<T extends ThreadItem['type']> = Extract<ThreadItem, { type: T }>;

/** A normalized async user-input question attached to an agentMessage item. */
export interface AsyncQuestion {
  title: string;
  options?: string[];
}

/** Extracts well-formed async questions from an agentMessage item. */
export function asyncQuestions(raw: AsyncUserInputQuestion[] | null | undefined): AsyncQuestion[] {
  const out: AsyncQuestion[] = [];
  for (const q of arrOf(raw)) {
    if (!isObj(q)) continue;
    const title = strOf(q.title).trim();
    if (title === '') continue;
    const options = arrOf(q.options)
      .map((o) => (typeof o === 'string' ? o.trim() : ''))
      .filter((o) => o !== '');
    out.push(options.length > 0 ? { title, options } : { title });
  }
  return out;
}

/** Turns Codex's items into chat events. It keeps no state: the session
 * adds what depends on the conversation so far. */
export class Mapper {
  /** The session's directory: paths under it are shown relative to it in
   * titles. */
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** p relative to the session's directory when it is under it. */
  rel(p: string): string {
    if (this.cwd === '' || !posix.isAbsolute(p)) return p;
    const prefix = this.cwd.replace(/\/$/, '') + '/';
    return p.startsWith(prefix) && p.length > prefix.length ? p.slice(prefix.length) : p;
  }

  /** The stored events of an item, started (completed false) or completed:
   * messages, thoughts and plans once complete, tool calls when they start
   * and when they complete. User messages, subagents' activity and items of
   * other types are the session's (none here); null for a type the adapter
   * does not map. */
  itemEvents(it: ThreadItem, completed: boolean, parent: string, fallback?: number): Event[] | null {
    const at = itemTime(it, fallback);
    const one = (u: Obj): Event[] => [updateEvent(it.id, parent, false, u, at)];
    switch (it.type) {
      case ItemType.AgentMessage: {
        if (!completed) return [];
        const u = chunk(AGENT_MESSAGE_CHUNK, strOf(it.text), it.id);
        if (strOf(it.phase)) setMeta(u, 'phase', it.phase);
        if (strOf(it.delivery)) setMeta(u, 'delivery', it.delivery);
        const qs = asyncQuestions(it.questions);
        if (qs.length > 0) setMeta(u, 'questions', qs);
        return one(u);
      }
      case ItemType.Plan: {
        if (!completed) return [];
        const u = chunk(AGENT_MESSAGE_CHUNK, strOf(it.text), it.id);
        setMeta(u, 'plan', true);
        return one(u);
      }
      case ItemType.Reasoning:
        if (!completed) return [];
        return one(chunk(AGENT_THOUGHT_CHUNK, arrOf(it.summary).map(strOf).join('\n\n'), it.id));
      case ItemType.Command:
        return one(this.commandCall(it));
      case ItemType.FileChange:
        return one(this.fileCall(it));
      case ItemType.McpToolCall:
        return one(mcpCall(it));
      case ItemType.DynamicTool: {
        const u = toolCall(it.id, strOf(it.tool), 'other', toolStatus(it.status));
        if (it.arguments !== undefined && it.arguments !== null) u.rawInput = it.arguments;
        return one(u);
      }
      case ItemType.CollabTool:
        return one(collabCall(it));
      case ItemType.WebSearch:
        return one(webSearchCall(it, completed));
      case ItemType.ImageView: {
        const path = strOf(it.path);
        const u = toolCall(it.id, this.rel(path), 'read', completed ? Tool.Completed : Tool.InProgress);
        if (path !== '') u.locations = [{ path }];
        return one(u);
      }
      case ItemType.Compaction:
        return [noticeEvent(completed ? Notice.Compacted : Notice.Compacting, parent, undefined, at)];
    }
    return null;
  }

  /** A commandExecution as an execute tool call: titled by the script its
   * shell runs, its output (aggregatedOutput, the whole of it: the deltas
   * miss the first chunk) as text content. */
  commandCall(it: ItemOf<'commandExecution'>): Obj {
    const script = shellScript(strOf(it.command), it.commandActions);
    let status = toolStatus(it.status);
    if (status === Tool.Completed && typeof it.exitCode === 'number' && it.exitCode !== 0) status = Tool.Failed;
    const u = toolCall(it.id, script, 'execute', status);
    const input: Obj = { command: script };
    if (strOf(it.cwd)) input.cwd = it.cwd;
    u.rawInput = input;
    if (strOf(it.aggregatedOutput)) u.content = [{ type: 'content', content: textBlock(strOf(it.aggregatedOutput)) }];
    if (typeof it.exitCode === 'number') setMeta(u, 'exitCode', it.exitCode);
    if (strOf(it.processId)) setMeta(u, 'processId', it.processId);
    if (it.status === 'declined') setMeta(u, 'declined', true);
    return u;
  }

  /** A fileChange as an edit tool call, a diff per file. */
  fileCall(it: ItemOf<'fileChange'>): Obj {
    const u = toolCall(it.id, '', 'edit', toolStatus(it.status));
    if (it.status === 'declined') setMeta(u, 'declined', true);
    const { content, locations, titles } = fileDiffs(it.changes, this);
    u.title = cutText(titles.join(', '), MAX_TITLE);
    if (content.length > 0) {
      u.content = content;
      u.locations = locations;
    }
    return u;
  }
}

/** The changes of a fileChange as ACP diffs: an added file's diff is its
 * whole content (an ACP v1 diff from nothing), a deleted one's its old
 * content, an update's a hunk without headers (a v2 diff whose patch gets
 * the file's headers). */
export function fileDiffs(changes: FileUpdateChange[] | undefined, m: Mapper): { content: Obj[]; locations: Obj[]; titles: string[] } {
  const content: Obj[] = [];
  const locations: Obj[] = [];
  const titles: string[] = [];
  for (const c of arrOf(changes)) {
    if (!isObj(c)) continue;
    let p = strOf(c.path);
    const diff = strOf(c.diff);
    const kind: Obj = isObj(c.kind) ? c.kind : {};
    switch (kind.type) {
      case 'add':
        content.push({ type: 'diff', path: p, oldText: null, newText: diff });
        break;
      case 'delete':
        content.push({ type: 'diff', path: p, oldText: diff, newText: '' });
        break;
      default: {
        let change: Obj = { operation: 'modify', path: p };
        let to = p;
        const move = strOf(kind.move_path);
        if (move) {
          to = move;
          change = { operation: 'move', path: to, oldPath: p };
        }
        const d: Obj = { type: 'diff', changes: [change] };
        if (diff !== '') d.patch = { format: 'unified', text: `--- ${p}\n+++ ${to}\n${diff}` };
        content.push(d);
        p = to;
      }
    }
    locations.push({ path: p });
    titles.push(m.rel(p));
  }
  return { content, locations, titles };
}

function mcpCall(it: ItemOf<'mcpToolCall'>): Obj {
  const tool = strOf(it.tool);
  const title = strOf(it.server) ? `${it.server}/${tool}` : tool;
  const u = toolCall(it.id, title, 'other', toolStatus(it.status));
  if (it.arguments !== undefined && it.arguments !== null) u.rawInput = it.arguments;
  const text: string[] = [];
  for (const b of isObj(it.result) ? arrOf(it.result.content) : [])
    if (isObj(b) && b.type === 'text' && typeof b.text === 'string') text.push(b.text);
  if (isObj(it.error) && strOf(it.error.message)) {
    u.status = Tool.Failed;
    text.push(it.error.message);
  }
  if (text.length > 0) u.content = [{ type: 'content', content: textBlock(text.join('\n')) }];
  return u;
}

/** A collaboration tool of the agent with its subagents: spawning one or
 * giving it work is thinking (as Claude Code's Task is), waiting for one,
 * closing one and the like are other. */
export function collabCall(it: ItemOf<'collabAgentToolCall'>): Obj {
  const tool = strOf(it.tool);
  const think = ['spawnAgent', 'sendInput', 'sendMessage', 'followupTask', 'resumeAgent'].includes(tool);
  const status = toolStatus(it.status);
  const u = toolCall(it.id, tool, think ? 'think' : 'other', status);
  const input: Obj = { tool };
  const receivers = arrOf(it.receiverThreadIds).filter((id): id is string => typeof id === 'string' && id !== '');
  if (receivers.length > 0) input.receiverThreadIds = receivers;
  if (strOf(it.prompt)) {
    input.prompt = it.prompt;
    u.title = cutText(`${tool}: ${it.prompt}`, MAX_TITLE);
  }
  if (strOf(it.model)) input.model = it.model;
  if (think) {
    input.agent_type = 'subagent';
    const sub: Obj = { tool, status };
    if (receivers.length > 0) {
      sub.threadId = receivers[0];
      sub.receiverThreadIds = receivers;
    }
    setMeta(u, 'subagent', sub);
  }
  u.rawInput = input;
  return u;
}

/** The tool call of a subagent Codex started (a subAgentActivity of kind
 * started): what its thread does belongs to it. */
export function subAgentCall(it: ItemOf<'subAgentActivity'>, status: string): Obj {
  const agentPath = strOf(it.agentPath);
  const u = toolCall(it.id, agentPath, 'think', status);
  const input: Obj = { agentPath, agent_type: agentPath || 'subagent' };
  if (strOf(it.model)) input.model = it.model;
  if (strOf(it.reasoningEffort)) input.reasoningEffort = it.reasoningEffort;
  u.rawInput = input;
  const sub: Obj = { status };
  if (strOf(it.agentThreadId)) sub.threadId = it.agentThreadId;
  if (agentPath) sub.agentPath = agentPath;
  setMeta(u, 'subagent', sub);
  return u;
}

function webSearchCall(it: ItemOf<'webSearch'>, completed: boolean): Obj {
  let q = strOf(it.query);
  const input: Obj = {};
  const a = it.action;
  if (isObj(a)) {
    const query = 'query' in a ? strOf(a.query) : '';
    const url = 'url' in a ? strOf(a.url) : '';
    if (q === '' && query) q = query;
    else if (q === '' && url) q = url;
    if (url) input.url = url;
  }
  const u = toolCall(it.id, q, 'fetch', completed ? Tool.Completed : Tool.InProgress);
  if (q !== '') input.query = q;
  if (Object.keys(input).length > 0) u.rawInput = input;
  return u;
}

/** The stored state of a tool call with an updated status, cloning any
 * subagent metadata so callers never mutate a stored snapshot in place. */
export function callWithStatus(last: Obj, status: string): Obj {
  const next: Obj = { ...last, sessionUpdate: 'tool_call', status };
  if (isObj(last._meta) && isObj(last._meta[SLUG]) && isObj((last._meta[SLUG] as Obj).subagent)) {
    const own = last._meta[SLUG] as Obj;
    next._meta = {
      ...last._meta,
      [SLUG]: { ...own, subagent: { ...(own.subagent as Obj), status } },
    };
  }
  return next;
}

/** The stored state of a tool call that will not complete: its last state
 * with the status cancelled. */
export function cancelledCall(last: Obj): Obj {
  return callWithStatus(last, Tool.Cancelled);
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** What a command runs: the script of a shell's -c (Codex runs every
 * command as `/bin/zsh -lc '<script>'`), else the command, else its parsed
 * actions. */
export function shellScript(command: string | null | undefined, actions: CommandAction[] | null | undefined): string {
  if (!command) {
    return arrOf(actions)
      .map((a) => (isObj(a) ? strOf(a.command) : ''))
      .filter((c) => c !== '')
      .join('; ');
  }
  const sp = command.indexOf(' ');
  if (sp < 0 || !SHELLS.has(posix.basename(command.slice(0, sp)))) return command;
  const rest = command.slice(sp + 1);
  const sp2 = rest.indexOf(' ');
  if (sp2 < 0) return command;
  const flag = rest.slice(0, sp2);
  if (!flag.startsWith('-') || !flag.includes('c')) return command;
  return unquote(rest.slice(sp2 + 1)) ?? command;
}

/** A shell word in single or double quotes, or a plain one, without them;
 * null when s is more than one word. */
export function unquote(s: string): string | null {
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i]!;
    switch (c) {
      case "'": {
        const j = s.indexOf("'", i + 1);
        if (j < 0) return null;
        out += s.slice(i + 1, j);
        i = j + 1;
        break;
      }
      case '"': {
        i++;
        for (; i < s.length && s[i] !== '"'; i++) {
          if (s[i] === '\\' && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1]!)) i++;
          out += s[i];
        }
        if (i >= s.length) return null;
        i++;
        break;
      }
      case '\\':
        if (i + 1 >= s.length) return null;
        out += s[i + 1];
        i += 2;
        break;
      case ' ':
      case '\t':
      case '\n':
        return null;
      default:
        out += c;
        i++;
    }
  }
  return out;
}

// ---- prompts ----

const bad = (message: string) => new ChatProtoError({ code: Code.BadRequest, message });
const unsupported = (message: string) => new ChatProtoError({ code: Code.Unsupported, message });

/** A prompt's ACP content blocks as Codex's input: text as text, an image
 * as a data URL (never a local file: the item would keep only its path), a
 * file named with @ (resource_link) as a mention, an embedded resource's
 * text as text. Other blocks are refused. */
export function toUserInput(blocks: unknown[]): UserInput[] {
  const input: UserInput[] = [];
  for (const b of blocks) {
    if (!isObj(b)) throw bad('codex: a content block that is no JSON object');
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
    switch (b.type) {
      case 'text':
        input.push({ type: 'text', text: s('text'), text_elements: [] });
        break;
      case 'image':
        if (!s('mimeType').startsWith('image/') || s('data') === '') throw bad('codex: an image without data or an image type');
        input.push({ type: 'image', url: `data:${s('mimeType')};base64,${s('data')}` });
        break;
      case 'resource_link': {
        const p = filePath(s('uri'));
        if (p !== null) input.push({ type: 'mention', name: s('name') || posix.basename(p), path: p });
        else input.push({ type: 'text', text: s('uri'), text_elements: [] });
        break;
      }
      case 'resource': {
        const r = b.resource;
        if (!isObj(r) || typeof r.text !== 'string') throw unsupported('codex: an embedded resource without text');
        input.push({ type: 'text', text: r.text, text_elements: [] });
        break;
      }
      default:
        throw unsupported('codex: content of type ' + cutText(typeof b.type === 'string' ? b.type : '', 64));
    }
  }
  if (input.length === 0) throw bad('codex: an empty prompt');
  return input;
}

/** The absolute path of a file: URI; null for another. */
export function filePath(uri: string): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== 'file:' || (u.host !== '' && u.host !== 'localhost')) return null;
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  return posix.isAbsolute(p) ? p : null;
}

/** A file: URI of an absolute path, as Go's url.URL{Scheme: "file", Path}
 * writes it. */
function fileURI(p: string): string {
  return 'file://' + p.split('/').map(escapePathSegment).join('/');
}

/** A path segment escaped as Go escapes a URL's path: letters, digits,
 * "-_.~" and "$&+,:;=@" kept, every other byte as %XX. */
function escapePathSegment(s: string): string {
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~$&+,:;=@]/.test(c)) out += c;
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** A userMessage's input as ACP content blocks: an image given as a data
 * URL as an image, a local image, a mention and a skill as links to their
 * files. */
export function userContent(content: unknown): Obj[] {
  if (!Array.isArray(content)) return [];
  const out: Obj[] = [];
  for (const i of content) {
    if (!isObj(i)) continue;
    const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
    switch (i.type) {
      case 'text':
        out.push(textBlock(s('text')));
        break;
      case 'image': {
        const d = dataURL(s('url'));
        if (d) out.push({ type: 'image', mimeType: d.mime, data: d.data });
        else if (s('url') !== '') out.push({ type: 'resource_link', uri: s('url'), name: posix.basename(s('url')) });
        break;
      }
      case 'localImage':
      case 'mention':
      case 'skill':
      case 'localAudio':
        if (s('path') !== '') out.push({ type: 'resource_link', uri: fileURI(s('path')), name: s('name') || posix.basename(s('path')) });
        break;
    }
  }
  return out;
}

/** The type and the base64 data of a data: URL of base64 data. */
export function dataURL(s: string): { mime: string; data: string } | null {
  if (!s.startsWith('data:')) return null;
  const comma = s.indexOf(',');
  if (comma < 0) return null;
  const head = s.slice(5, comma);
  const data = s.slice(comma + 1);
  if (!head.endsWith(';base64')) return null;
  const mime = head.slice(0, -';base64'.length);
  if (mime === '' || data === '') return null;
  return { mime, data };
}

/** A failed turn's error: a Codex error that tells of a missing or refused
 * sign-in is auth_required. */
export function turnErrorOf(e: TurnError | null | undefined): ChatError {
  if (!e) return { code: Code.Failed, message: 'the turn failed' };
  return { code: unauthorized(e.codexErrorInfo) ? Code.AuthRequired : Code.Failed, message: e.message };
}

/** Whether a codexErrorInfo tells of a refused sign-in: "unauthorized", or
 * a variant whose httpStatusCode is 401. */
export function unauthorized(v: CodexErrorInfo | unknown): boolean {
  if (typeof v === 'string') return v === 'unauthorized';
  if (isObj(v)) {
    if (v.httpStatusCode === 401) return true;
    return Object.values(v).some(unauthorized);
  }
  return false;
}

/** The kind of a chat event of a turn's end: interrupted is cancelled,
 * failed an error. */
export function turnEnd(t: { id: string; status: string; error?: TurnError | null }, lastErr: TurnError | null, at?: number): Event {
  const ev: Event = { t: EventType.Turn };
  const time = timeOf(at);
  if (time) ev.at = time;
  if (t.id) ev.item = t.id;
  switch (t.status) {
    case 'interrupted':
      ev.state = chat.TurnState.End;
      ev.stopReason = 'cancelled';
      return ev;
    case 'failed':
      ev.state = chat.TurnState.Error;
      ev.error = turnErrorOf(t.error ?? lastErr);
      return ev;
  }
  ev.state = chat.TurnState.End;
  ev.stopReason = 'end_turn';
  return ev;
}
