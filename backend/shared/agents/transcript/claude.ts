// Claude Code's transcripts: <claude dir>/projects/<dir>/<session>.jsonl,
// a line per message (an assistant's message a line per content block, the
// lines of one response sharing message.id and its usage) and lines of the
// program's own state. Each line maps on its own, the usage of a response
// on each of its lines: a reader keeps the last of a message
// (Frame.message).
//
// The messages of Claude Code's SDK protocol (the assistant and user frames
// of its stream-json output) have the shapes of these lines, but for the
// tool result, which they name tool_use_result; claudeFrame maps them too.
//
// The transcripts are the agent's internal format and change between
// versions: the parser maps the lines it knows, passes over the kinds of
// lines known not to be conversation, and counts what it could not read
// (unknown) without forwarding it. A line is read as hostile (it holds what
// the agent read): checked whole, decoded only in the members needed.
import { RE2JS } from 're2js';
import { trimSpace } from '#shared/lib/gostrings.ts';
import { Notice, Transcript, Turn } from '#shared/proto/agentproto/index.ts';
import { MAX_BLOCKS, MAX_ITEMS, MAX_TITLE, cutMiddle, cutText, imageBlock, setMeta, type LineOut, type Obj } from './events.ts';
import { elements, member, memberString, pick, unquote, valid, wellFormed } from './json.ts';

// ---- the members of a line, typed as Go's decoder reads them ----

/** A member's raw value read as Go reads it into a field: undefined or null
 * is the field's zero value; a value of another type fails the decode
 * (WRONG). */
const WRONG = Symbol('wrong');
type Field<T> = T | typeof WRONG;
type Value = string | { decoded: unknown };
type Members = Map<string, string> | Obj;

function field(m: Members | null, k: string): Value | undefined {
  if (m instanceof Map) return m.get(k);
  if (m && Object.hasOwn(m, k)) return { decoded: m[k] };
}

function present(v: Value | undefined): v is Value {
  return typeof v === 'string' ? v !== 'null' : v?.decoded != null;
}

function str(v: Value | undefined): Field<string> {
  if (!present(v)) return '';
  if (typeof v === 'string') return v[0] === '"' ? unquote(v) : WRONG;
  return typeof v.decoded === 'string' ? wellFormed(v.decoded) : WRONG;
}

function bool(v: Value | undefined): Field<boolean> {
  if (!present(v)) return false;
  if (typeof v !== 'string') return typeof v.decoded === 'boolean' ? v.decoded : WRONG;
  if (v === 'false') return false;
  return v === 'true' ? true : WRONG;
}

/** An integer as Go reads one into an int64: integer syntax only. */
function int(v: Value | undefined): Field<number | null> {
  if (!present(v)) return null;
  if (typeof v === 'string') return /^-?\d+$/.test(v) ? Number(v) : WRONG;
  const n = v.decoded;
  return typeof n === 'number' && Number.isInteger(n) ? n : WRONG;
}

/** An object's members (keys), or null for null; WRONG for another type. */
function obj(v: Value | undefined, ...keys: string[]): Field<Members | null> {
  if (!present(v)) return null;
  if (typeof v === 'string') return pick(v, ...keys) ?? WRONG;
  return isObj(v.decoded) ? v.decoded : WRONG;
}

function array(v: Value, limit: number, fn: (v: Value) => boolean): { more: boolean; ok: boolean } {
  if (typeof v === 'string') return elements(v, limit, fn);
  if (!Array.isArray(v.decoded)) return { more: false, ok: false };
  for (let i = 0; i < Math.min(limit, v.decoded.length); i++) {
    if (!fn({ decoded: v.decoded[i] })) return { more: false, ok: true };
  }
  return { more: v.decoded.length > limit, ok: true };
}

/** Reads fields from a decoded object strictly: any of the wrong type
 * makes the whole decode fail, as Go's json.Unmarshal into a struct. */
class Strict {
  failed = false;
  private readonly m: Members;
  constructor(m: Members) {
    this.m = m;
  }
  private take<T>(v: Field<T>, zero: T): T {
    if (v === WRONG) {
      this.failed = true;
      return zero;
    }
    return v;
  }
  str(k: string): string {
    return this.take(str(this.raw(k)), '');
  }
  bool(k: string): boolean {
    return this.take(bool(this.raw(k)), false);
  }
  int(k: string): number | null {
    return this.take(int(this.raw(k)), null);
  }
  obj(k: string, ...keys: string[]): Strict | null {
    const m = this.take(obj(this.raw(k), ...keys), null);
    if (!m) return null;
    const s = new Strict(m);
    return s;
  }
  raw(k: string): Value | undefined {
    return field(this.m, k);
  }
}

/** Reads fields leniently: one of the wrong type is its zero value, as
 * Go's json.Unmarshal fills the others when the error is ignored. */
class Lenient {
  private readonly m: Members | null;
  constructor(m: Members | null) {
    this.m = m;
  }
  str(k: string): string {
    const v = str(this.raw(k));
    return v === WRONG ? '' : v;
  }
  bool(k: string): boolean {
    const v = bool(this.raw(k));
    return v === WRONG ? false : v;
  }
  int(k: string): number | null {
    const v = int(this.raw(k));
    return v === WRONG ? null : v;
  }
  obj(k: string, ...keys: string[]): Lenient {
    const v = obj(this.raw(k), ...keys);
    return new Lenient(v === WRONG ? null : v);
  }
  has(k: string): boolean {
    return this.raw(k) !== undefined;
  }
  raw(k: string): Value | undefined {
    return field(this.m, k);
  }
}

/** A content block of a message. */
interface Block {
  type: string;
  text: string;
  thinking: string;
  id: string;
  name: string;
  input?: Value;
  toolUseId: string;
  content?: Value;
  isError: boolean;
}

/** A block as Go decodes one; null when raw is no block (not valid JSON, a
 * member of the wrong type). */
function blockOf(raw: Value): Block | null {
  const m = obj(raw, 'type', 'text', 'thinking', 'id', 'name', 'input', 'tool_use_id', 'content', 'is_error');
  if (m === WRONG) return null;
  const s = new Strict(m ?? {});
  const b: Block = {
    type: s.str('type'),
    text: s.str('text'),
    thinking: s.str('thinking'),
    id: s.str('id'),
    name: s.str('name'),
    input: s.raw('input'),
    toolUseId: s.str('tool_use_id'),
    content: s.raw('content'),
    isError: s.bool('is_error'),
  };
  return s.failed ? null : b;
}

/** A string value as Go decodes one into a string; null when it is none. */
function jsonString(v: Value | undefined): string | null {
  if (!present(v)) return null;
  const t = str(v);
  return t === WRONG ? null : t;
}

// ---- lines ----

/** Maps one line (its text without the newline) into o. */
export function parseClaude(line: string, o: LineOut): void {
  const typ = memberString(line, 'type');
  switch (typ) {
    case 'user':
    case 'assistant':
    case 'system':
      break;
    case 'ai-title':
    case 'summary':
    case 'custom-title': {
      if (!valid(line)) return;
      const m = pick(line, 'aiTitle', 'summary', 'customTitle');
      if (!m) return;
      const s = new Strict(m);
      const t = s.str('aiTitle') + s.str('summary') + s.str('customTitle');
      if (s.failed) return;
      o.title = trimSpace(t);
      o.custom = typ === 'custom-title';
      return;
    }
    case 'attachment':
      claudeAttachment(line, o);
      return;
    case '':
      // No object with a type: a line that could not be read.
      if (member(line, 'type') === null) o.unknown++;
      return;
    default:
      // The program's own state (mode, api-request, queue-operation,
      // file-history-snapshot, last-prompt, cost-state, …), and kinds of
      // lines newer versions add: no conversation.
      return;
  }
  const fields = valid(line) ? pick(line, ...LINE_FIELDS) : null;
  conversation(typ, fields, o);
}

/** Maps the SDK's already-decoded assistant or user message. */
export function parseClaudeSDK(frame: unknown, o: LineOut): void {
  if (!isObj(frame) || (frame.type !== 'assistant' && frame.type !== 'user')) {
    o.unknown++;
    return;
  }
  conversation(frame.type, frame, o);
}

function conversation(typ: string, fields: Members | null, o: LineOut): void {
  const d = fields ? lineOf(fields) : null;
  if (!d) {
    o.unknown++;
    return;
  }
  // A subagent's: its own transcript, not shown here.
  if (d.isSidechain) return;
  o.setTime(d.timestamp);
  if (typ === 'user') claudeUser(d, o);
  else if (typ === 'assistant') claudeAssistant(d, o);
  else claudeSystem(d, o);
}

/** What a conversation line gives that is read. */
interface Line {
  subtype: string;
  timestamp: string;
  isSidechain: boolean;
  isMeta: boolean;
  /** The summary a compaction left as the user's message, shown by the
   * compaction's notice instead. */
  isCompactSummary: boolean;
  isVisibleInTranscriptOnly: boolean;
  isApiErrorMessage: boolean;
  message: Message | null;
  toolUseResult?: Value;
  /** The SDK protocol's name of toolUseResult. */
  toolUseResultSDK?: Value;
  /** The index in its message of an assistant line's content block. */
  apiBlockIndex: number | null;
  /** A system line's (local_command). */
  content?: Value;
  compact: { trigger: string; preTokens: number } | null;
}

interface Message {
  id: string;
  model: string;
  content?: Value;
  /** Why the response ended (the API's); "" while it runs. */
  stopReason: string;
  usage: { input: number; cacheRead: number; cacheCreation: number } | null;
}

const LINE_FIELDS = [
  'type',
  'subtype',
  'timestamp',
  'isSidechain',
  'isMeta',
  'isCompactSummary',
  'isVisibleInTranscriptOnly',
  'isApiErrorMessage',
  'message',
  'toolUseResult',
  'tool_use_result',
  'apiBlockIndex',
  'content',
  'compactMetadata',
];

/** A conversation line as Go decodes it; null when it is not one. */
function lineOf(m: Members): Line | null {
  const s = new Strict(m);
  const msg = s.obj('message', 'id', 'model', 'content', 'stop_reason', 'usage');
  let message: Message | null = null;
  if (msg) {
    const u = msg.obj('usage', 'input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens');
    message = {
      id: msg.str('id'),
      model: msg.str('model'),
      content: msg.raw('content'),
      stopReason: msg.str('stop_reason'),
      usage: u
        ? {
            input: u.int('input_tokens') ?? 0,
            cacheRead: u.int('cache_read_input_tokens') ?? 0,
            cacheCreation: u.int('cache_creation_input_tokens') ?? 0,
          }
        : null,
    };
    if (msg.failed || u?.failed) s.failed = true;
  }
  const cm = s.obj('compactMetadata', 'trigger', 'preTokens');
  s.str('type');
  const d: Line = {
    subtype: s.str('subtype'),
    timestamp: s.str('timestamp'),
    isSidechain: s.bool('isSidechain'),
    isMeta: s.bool('isMeta'),
    isCompactSummary: s.bool('isCompactSummary'),
    isVisibleInTranscriptOnly: s.bool('isVisibleInTranscriptOnly'),
    isApiErrorMessage: s.bool('isApiErrorMessage'),
    message,
    toolUseResult: s.raw('toolUseResult'),
    toolUseResultSDK: s.raw('tool_use_result'),
    apiBlockIndex: s.int('apiBlockIndex'),
    content: s.raw('content'),
    compact: cm ? { trigger: cm.str('trigger'), preTokens: cm.int('preTokens') ?? 0 } : null,
  };
  if (cm?.failed) s.failed = true;
  return s.failed ? null : d;
}

/** A turn's end, a compaction, a local command; the other subtypes (hook
 * summaries, retries of API errors, …) are no conversation. */
function claudeSystem(d: Line, o: LineOut): void {
  switch (d.subtype) {
    case 'turn_duration':
      o.turn(Turn.End);
      break;
    case 'compact_boundary': {
      let params: Obj | undefined;
      if (d.compact) {
        params = {};
        if (d.compact.trigger !== '') params.trigger = d.compact.trigger;
        if (d.compact.preTokens > 0) params.preTokens = d.compact.preTokens;
      }
      o.notice(Notice.Compacted, params);
      break;
    }
    case 'local_command': {
      const s = jsonString(d.content);
      if (s !== null) commandNotice(s, o);
      break;
    }
  }
}

/** How Claude Code records that the user stopped a turn. */
const INTERRUPTED = '[Request interrupted by user';

function claudeUser(d: Line, o: LineOut): void {
  if (d.isMeta || d.isCompactSummary || d.isVisibleInTranscriptOnly) return;
  if (!d.message) {
    o.unknown++;
    return;
  }
  const c = d.message.content;
  const s = jsonString(c);
  if (s !== null) {
    claudePromptText(s, true, o);
    return;
  }
  if (!present(c)) {
    if (c === undefined) o.unknown++;
    return;
  }
  // The blocks are read one at a time: a line of many blocks takes no more
  // than the events it may make.
  let results = 0;
  if (
    !array(c, MAX_BLOCKS, (raw) => {
      if ((typeof raw === 'string' ? memberString(raw, 'type') : isObj(raw.decoded) && raw.decoded.type) === 'tool_result') results++;
      return results < 2;
    }).ok
  ) {
    o.unknown++;
    return;
  }
  const prompt: Obj[] = [];
  let stopped = false;
  const { more } = array(c, MAX_BLOCKS, (raw) => {
    const b = blockOf(raw);
    if (!b) {
      o.unknown++;
      return true;
    }
    switch (b.type) {
      case 'tool_result': {
        let res: Value | undefined;
        if (results === 1) res = present(d.toolUseResult) ? d.toolUseResult : d.toolUseResultSDK;
        claudeToolResult(b, res, o);
        break;
      }
      case 'text':
        if (b.text.startsWith(INTERRUPTED)) stopped = true;
        else prompt.push(o.textBlock(b.text));
        break;
      case 'image':
        prompt.push(imageBlock());
        break;
      default:
        o.unknown++;
    }
    return !o.over;
  });
  o.over ||= more;
  if (prompt.length > 0) {
    o.turn(Turn.Start);
    o.user(prompt);
  }
  if (stopped) o.turn(Turn.End, 'cancelled');
}

/** The events of a prompt the user wrote as a string: the notice of a
 * slash command or a local command's output, the end of a turn the user
 * stopped, or the user's message, which begins a turn when begins is set. */
function claudePromptText(s: string, begins: boolean, o: LineOut): void {
  if (commandNotice(s, o)) return;
  if (s.startsWith(INTERRUPTED)) {
    o.turn(Turn.End, 'cancelled');
    return;
  }
  if (trimSpace(s) === '') return;
  if (begins) o.turn(Turn.Start);
  o.user([o.textBlock(s)]);
}

/** In every attachment line that may hold a message of the user's; the
 * other attachments (the environment, skill listings, prompt snapshots,
 * up to 140 KB a line) are passed over without a decode. */
const QUEUED_COMMAND = '"queued_command"';

/** An attachment line, the program's own state but for one kind: a message
 * the user sent while the agent was working. Claude Code records such a
 * message, once the running turn takes it up, as a queued_command
 * attachment of commandMode "prompt" whose origin is the human (other
 * origins are other agents' messages and the program's task
 * notifications), and writes no user line for it; a message still queued
 * when the turn ends becomes the next turn's user line instead, with no
 * attachment. So the attachment gives the user's message, and no turn's
 * start: the turn it joins is running. A message of a client of the SDK
 * protocol that did not say where it came from has no origin: it is the
 * user's too. */
function claudeAttachment(line: string, o: LineOut): void {
  if (!line.includes(QUEUED_COMMAND)) return;
  const m = pick(line, 'attachment', 'isSidechain', 'isMeta', 'timestamp');
  const raw = m?.get('attachment');
  if (!raw || !valid(raw)) return;
  const am = obj(raw, 'type', 'commandMode', 'isMeta', 'origin', 'prompt');
  if (am === WRONG || am === null) return;
  const a = new Strict(am);
  const origin = a.obj('origin', 'kind');
  const kind = origin?.str('kind');
  const ok = !a.failed && !origin?.failed;
  if (!ok || a.str('type') !== 'queued_command' || a.str('commandMode') !== 'prompt' || (origin && kind !== 'human') || a.bool('isMeta'))
    return;
  const top = new Lenient(m);
  if (top.bool('isSidechain') || top.bool('isMeta')) {
    // A subagent's, or a message of the program's own.
    return;
  }
  o.setTime(top.str('timestamp'));
  const c = a.raw('prompt') ?? '';
  const s = jsonString(c);
  if (s !== null) {
    claudePromptText(s, false, o);
    return;
  }
  // A message with pasted images: text and image blocks, read one at a
  // time.
  const prompt: Obj[] = [];
  const r = array(c, MAX_BLOCKS, (raw) => {
    const b = blockOf(raw);
    if (!b) {
      o.unknown++;
      return true;
    }
    if (b.type === 'text') prompt.push(o.textBlock(b.text));
    else if (b.type === 'image') prompt.push(imageBlock());
    else o.unknown++;
    return true;
  });
  if (!r.ok) {
    o.unknown++;
    return;
  }
  o.over ||= r.more;
  o.user(prompt);
}

/** The text between <tag> and </tag> in s; null when s has no such tag. */
function tagged(s: string, tag: string): string | null {
  const i = s.indexOf(`<${tag}>`);
  if (i < 0) return null;
  s = s.slice(i + tag.length + 2);
  const j = s.indexOf(`</${tag}>`);
  return j >= 0 ? s.slice(0, j) : s;
}

/** The notice of a slash command the user ran, or of a local command's
 * output, from the text Claude Code records for it; false when the text is
 * no such record. */
function commandNotice(s: string, o: LineOut): boolean {
  const t = trimSpace(s);
  if (!t.startsWith('<command-') && !t.startsWith('<local-command-') && !t.startsWith('<bash-')) return false;
  const params: Obj = {};
  const name = tagged(t, 'command-name');
  if (name !== null) {
    params.name = trimSpace(name);
    const args = tagged(t, 'command-args') ?? '';
    if (trimSpace(args) !== '') params.args = o.text(trimSpace(args))[0];
  }
  const cmd = tagged(t, 'bash-input');
  if (cmd !== null) {
    params.name = '!';
    params.args = o.text(cmd)[0];
  }
  const out: string[] = [];
  let clipped = false;
  for (const tag of ['local-command-stdout', 'local-command-stderr', 'bash-stdout', 'bash-stderr']) {
    const x = tagged(t, tag);
    if (x !== null && trimSpace(x) !== '') {
      const [head, cut] = cutText(x, o.lim.text * 4);
      clipped ||= cut;
      out.push(plain(head));
    }
  }
  if (out.length > 0) {
    const [x, cut] = o.text(out.join('\n'));
    params.output = x;
    if (cut || clipped) setMeta(params, 'truncated', true);
  }
  // A caveat or another record of the program's own: nothing to show.
  if (Object.keys(params).length === 0) return true;
  o.notice(Notice.Command, params);
  return true;
}

function claudeAssistant(d: Line, o: LineOut): void {
  const m = d.message;
  if (!m) {
    o.unknown++;
    return;
  }
  let blocks: Block[] = [];
  let more = false;
  const c = m.content;
  const s = jsonString(c);
  if (s !== null) {
    blocks = [{ type: 'text', text: s, thinking: '', id: '', name: '', toolUseId: '', isError: false }];
  } else if (present(c)) {
    // At most MAX_BLOCKS of them, one at a time; a block that is no block
    // makes the line one not read, as a decode of all would.
    let failed = false;
    const r = array(c, MAX_BLOCKS, (raw) => {
      const b = blockOf(raw);
      if (!b) {
        failed = true;
        return false;
      }
      blocks.push(b);
      return true;
    });
    if (!r.ok || failed) {
      o.unknown++;
      return;
    }
    more = r.more;
  } else if (c === undefined) {
    o.unknown++;
    return;
  }
  try {
    if (d.isApiErrorMessage || m.model === '<synthetic>') {
      const text = blocks.filter((b) => b.type === 'text' && b.text !== '').map((b) => b.text);
      o.notice(Notice.Error, { text: o.text(text.join('\n'))[0] });
      return;
    }
    o.message = m.id;
    o.count = blocks.length;
    if (d.apiBlockIndex !== null && d.apiBlockIndex >= 0 && d.apiBlockIndex < 1 << 20) o.first = d.apiBlockIndex + 1;
    for (let i = 0; i < blocks.length; i++) {
      o.block = i + 1;
      claudeBlockEvents(m, blocks[i], o);
      if (o.over) {
        o.block = 0;
        return;
      }
    }
    o.block = 0;
    if (m.usage) {
      const used = m.usage.input + m.usage.cacheRead + m.usage.cacheCreation;
      // The model's context window is not in the transcript: the update
      // gives no size.
      if (used > 0) o.add({ t: Transcript.Update, update: { sessionUpdate: 'usage_update', used } });
    }
    const stop = claudeStop(m.stopReason);
    if (stop !== '' && blocks.length > 0 && !thinking(blocks[blocks.length - 1].type)) {
      // The response the turn ends with: Claude Code writes a line per
      // block, each with the response's stop reason, the thinking before
      // the reply. A transcript of the SDK protocol's sessions has no other
      // end of a turn (no turn_duration line).
      o.turn(Turn.End, stop);
    }
  } finally {
    // Blocks beyond MAX_BLOCKS: more events than a line may make.
    o.over ||= more;
  }
}

/** The ACP stop reason of a turn that ends with a response that stopped
 * for reason (the API's); "" for a response the turn goes on after
 * (tool_use, pause_turn) or one still running. */
function claudeStop(reason: string): string {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
  }
  return '';
}

/** Whether a content block's type is a thought's. */
const thinking = (typ: string) => typ === 'thinking' || typ === 'redacted_thinking';

/** The update of a message's or a thought's text. */
function chunk(o: LineOut, kind: string, text: string, messageId: string): Obj {
  const [s, cut] = o.text(text);
  const u: Obj = { sessionUpdate: kind, content: { type: 'text', text: s } };
  if (messageId !== '') u.messageId = messageId;
  if (cut) setMeta(u, 'truncated', true);
  return u;
}

function claudeBlockEvents(m: Message, b: Block, o: LineOut): void {
  switch (b.type) {
    case 'text': {
      const u = chunk(o, 'agent_message_chunk', b.text, m.id);
      if (m.model !== '') setMeta(u, 'model', m.model);
      o.update(u);
      break;
    }
    case 'thinking':
      // Claude Code keeps the thinking's text hidden (empty): the view shows
      // that the agent thought.
      o.update(chunk(o, 'agent_thought_chunk', b.thinking, m.id));
      break;
    case 'redacted_thinking':
      o.update(chunk(o, 'agent_thought_chunk', '', m.id));
      break;
    case 'image': {
      const u: Obj = { sessionUpdate: 'agent_message_chunk', content: imageBlock() };
      if (m.id !== '') u.messageId = m.id;
      o.update(u);
      break;
    }
    case 'tool_use':
    case 'server_tool_use':
      claudeToolUse(b, o);
      break;
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
      if (b.toolUseId !== '') o.update({ sessionUpdate: 'tool_call_update', toolCallId: b.toolUseId, status: 'completed' });
      break;
    default:
      o.unknown++;
  }
}

/** The ACP kinds of Claude Code's tools; any other tool (an MCP server's
 * mcp__*) is "other". */
const TOOL_KINDS: Readonly<Record<string, string>> = {
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  KillBash: 'execute',
  Read: 'read',
  NotebookRead: 'read',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  web_search: 'fetch',
  web_fetch: 'fetch',
  Task: 'think',
  Agent: 'think',
  ExitPlanMode: 'switch_mode',
};

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const sval = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A tool call's title: what it acts on, as its input says; else the
 * tool's name. */
function claudeTitle(name: string, input: Obj): string {
  const keys: Record<string, string[]> = {
    Bash: ['description', 'command'],
    Edit: ['file_path', 'notebook_path'],
    MultiEdit: ['file_path', 'notebook_path'],
    Write: ['file_path', 'notebook_path'],
    Read: ['file_path', 'notebook_path'],
    NotebookEdit: ['file_path', 'notebook_path'],
    NotebookRead: ['file_path', 'notebook_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    LS: ['path'],
    WebFetch: ['url'],
    web_fetch: ['url'],
    WebSearch: ['query'],
    web_search: ['query'],
    Task: ['description'],
    Agent: ['description'],
  };
  for (const k of Object.hasOwn(keys, name) ? keys[name] : []) {
    const s = trimSpace(sval(input[k]));
    if (s !== '') return cutText(s, MAX_TITLE)[0];
  }
  return name;
}

function claudeToolUse(b: Block, o: LineOut): void {
  const { v, ok } = typeof b.input === 'string' || b.input === undefined ? o.decode(b.input) : o.decoded(b.input.decoded);
  const input = isObj(v) ? v : {};
  if (b.name === 'TodoWrite') {
    const entries = planEntries(input.todos, 'content', o);
    if (entries) o.update({ sessionUpdate: 'plan', entries });
    return;
  }
  if (b.id === '') {
    o.unknown++;
    return;
  }
  const kind = Object.hasOwn(TOOL_KINDS, b.name) ? TOOL_KINDS[b.name] : 'other';
  const u: Obj = { sessionUpdate: 'tool_call', toolCallId: b.id, title: claudeTitle(b.name, input), kind, status: 'pending' };
  if (ok && present(b.input)) u.rawInput = o.bounded(u, v);
  if (kind === 'edit' || kind === 'read') {
    const p = sval(first(input, 'file_path', 'notebook_path'));
    if (p !== '') {
      const loc: Obj = { path: p };
      const line = input.offset;
      if (typeof line === 'number' && line > 0) loc.line = Math.trunc(line);
      u.locations = [loc];
    }
  }
  const content = claudeInputContent(b.name, input, u, o);
  if (content) u.content = content;
  o.update(u);
}

/** The first of m's members that is there and not null. */
function first(m: Obj, ...keys: string[]): unknown {
  for (const k of keys) if (Object.hasOwn(m, k) && m[k] !== null && m[k] !== undefined) return m[k];
  return undefined;
}

/** What a tool call's input shows before it runs: the change of an Edit,
 * MultiEdit or Write as diffs (a Write's old text is not known: null, as a
 * new file's), the plan of an ExitPlanMode; undefined for another tool. */
function claudeInputContent(name: string, input: Obj, u: Obj, o: LineOut): Obj[] | undefined {
  const path = sval(input.file_path);
  switch (name) {
    case 'Edit':
      if (path !== '' && typeof input.old_string === 'string' && typeof input.new_string === 'string')
        return [o.diff(u, path, input.old_string, input.new_string, true)];
      break;
    case 'MultiEdit': {
      const out: Obj[] = [];
      for (const e of Array.isArray(input.edits) ? input.edits : []) {
        const m = isObj(e) ? e : {};
        if (path !== '' && typeof m.old_string === 'string' && typeof m.new_string === 'string' && out.length < MAX_ITEMS)
          out.push(o.diff(u, path, m.old_string, m.new_string, true));
      }
      return out.length > 0 ? out : undefined;
    }
    case 'Write':
      if (typeof input.content === 'string' && path !== '') return [o.diff(u, path, '', input.content, false)];
      break;
    case 'ExitPlanMode':
      if (typeof input.plan === 'string' && trimSpace(input.plan) !== '') return [{ type: 'content', content: o.textBlock(input.plan) }];
      break;
  }
  return undefined;
}

/** The entries of a plan from a list of items whose text is in key;
 * undefined for no list. */
function planEntries(items: unknown, key: string, o: LineOut): Obj[] | undefined {
  if (!Array.isArray(items)) return undefined;
  const entries: Obj[] = [];
  for (const it of items.slice(0, MAX_ITEMS)) {
    if (!isObj(it)) continue;
    let status = sval(it.status);
    if (!['pending', 'in_progress', 'completed'].includes(status)) status = 'pending';
    if (it.completed === true) status = 'completed';
    let priority = sval(it.priority);
    if (!['high', 'medium', 'low'].includes(priority)) priority = 'medium';
    entries.push({ content: o.text(sval(it[key]))[0], status, priority });
  }
  return entries;
}

/** The text of a tool result's content (a string or blocks) and how many
 * images it holds. */
function resultText(raw: Value | undefined): [string, number] {
  if (!present(raw)) return ['', 0];
  const text = jsonString(raw);
  if (text !== null) return [text, 0];
  // One block at a time, at most MAX_BLOCKS; any that is no block makes no
  // text, as a decode of all would.
  const texts: string[] = [];
  let images = 0;
  let failed = false;
  const r = array(raw, MAX_BLOCKS, (v) => {
    const b = blockOf(v);
    if (!b) {
      failed = true;
      return false;
    }
    if (b.type === 'text') texts.push(b.text);
    else if (b.type === 'image') images++;
    return true;
  });
  if (!r.ok || failed) return ['', 0];
  return [texts.join('\n'), images];
}

/** An error result's text without Claude Code's tags. */
const toolError = (s: string): string => tagged(s, 'tool_use_error') ?? s;

/** The update of a tool call from its result; res is the line's
 * toolUseResult when the line has this result only, which tells the tool
 * by its shape. */
function claudeToolResult(b: Block, res: Value | undefined, o: LineOut): void {
  const u: Obj = { sessionUpdate: 'tool_call_update', toolCallId: b.toolUseId, status: b.isError ? 'failed' : 'completed' };
  let [text, images] = resultText(b.content);
  if (b.isError) {
    text = toolError(text);
    const code = exitCode(text);
    // A command that failed, as Claude Code words it.
    if (code !== null) setMeta(u, 'exitCode', code);
  }
  // The members that tell the tool, without decoding the others.
  const members = obj(
    res,
    'newTodos',
    'oldString',
    'newString',
    'edits',
    'file',
    'stdout',
    'stderr',
    'filePath',
    'content',
    'originalFile',
    'agentId',
    'type',
    'interrupted',
    'isImage',
    'exitCode',
  );
  const r = new Lenient(members === WRONG ? null : members);
  const textOf = (k: string): string | null => jsonString(r.raw(k));
  let content: Obj[] | undefined;
  if (r.has('newTodos')) {
    // TodoWrite's: its plan was the update.
    return;
  } else if (r.has('agentId') && r.has('content')) {
    // A subagent's (Agent, Task): its report, without the words to the
    // model Claude Code wraps it in.
    const [report, n] = resultText(r.raw('content'));
    if (report !== '' || n > 0) [text, images] = [report, n];
  } else if (r.has('oldString') || r.has('newString')) {
    content = [o.diff(u, textOf('filePath') ?? '', textOf('oldString') ?? '', textOf('newString') ?? '', true)];
  } else if (r.has('edits')) {
    const path = textOf('filePath') ?? '';
    const diffs: Obj[] = [];
    array(r.raw('edits')!, MAX_ITEMS, (v) => {
      const m = obj(v, 'old_string', 'new_string');
      const e = new Lenient(m === WRONG ? null : m);
      diffs.push(o.diff(u, path, e.str('old_string'), e.str('new_string'), true));
      return true;
    });
    if (diffs.length > 0) content = diffs;
  } else if (r.has('file')) {
    const file = r.obj('file', 'filePath', 'numLines', 'startLine');
    if (r.str('type') === 'image') content = [{ type: 'content', content: imageBlock() }];
    const filePath = file.str('filePath');
    if (filePath !== '') {
      const loc: Obj = { path: filePath };
      const start = file.int('startLine') ?? 0;
      if (start > 0) loc.line = start;
      u.locations = [loc];
    }
    const lines = file.int('numLines') ?? 0;
    if (lines > 0) setMeta(u, 'lines', lines);
    // The file's text is not repeated.
    [text, images] = ['', 0];
  } else if (r.has('stdout') || r.has('stderr')) {
    // A background shell's (BashOutput).
    const code = r.int('exitCode');
    if (code !== null) setMeta(u, 'exitCode', code);
    if (r.bool('interrupted')) setMeta(u, 'interrupted', true);
    if (r.bool('isImage')) [text, images] = ['', 1];
    else {
      text = r.str('stdout').replace(/\n+$/, '');
      const e = r.str('stderr').replace(/\n+$/, '');
      if (e !== '') text = text !== '' ? text + '\n' + e : e;
    }
  } else {
    const path = textOf('filePath');
    const newText = textOf('content');
    if (path !== null && newText !== null) {
      // Write's: a new file, or a file written over.
      const d = o.diff(u, path, '', newText, false);
      const old = textOf('originalFile');
      if (old !== null) d.oldText = cutText(old, o.lim.text)[0];
      content = [d];
    }
  }
  if (!content) {
    const [sample, cut] = cutMiddle(text, o.lim.tool * 4);
    if (cut) setMeta(u, 'truncated', true);
    content = o.output(u, plain(sample));
    for (let i = 0; i < Math.min(images, MAX_ITEMS); i++) (content ??= []).push({ type: 'content', content: imageBlock() });
  }
  if (content) u.content = content;
  o.update(u);
}

// ---- text ----

/** Terminal escape sequences (CSI, OSC), as RE2 reads them. */
const ANSI = RE2JS.compile('\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)');

/** s without terminal escape sequences. */
export function plain(s: string): string {
  return s.includes('\x1b') ? ANSI.matcher(s).replaceAll('') : s;
}

/** The exit code an error result states: Claude Code's "Exit code N", and
 * "Exit code: N" and "Process exited with code N" (RE2, as the Go agent
 * reads it: \s is ASCII space, $ ends a line only at "\n"). */
const EXIT_CODE = RE2JS.compile('(?m)^(?:Error: )?(?:Exit code:? |Process exited with code )(-?\\d+)\\s*$');

/** The exit code the first lines of a command's output state; null for
 * none. */
export function exitCode(s: string): number | null {
  const [head] = cutText(s, 512);
  const m = EXIT_CODE.matcher(head);
  if (!m.find()) return null;
  const n = Number(m.group(1));
  return Number.isSafeInteger(n) && n >= -(2 ** 63) && n < 2 ** 63 ? n : null;
}
