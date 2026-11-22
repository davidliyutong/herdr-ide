// A coding agent's conversation as the native view shows it, independent of
// where it comes from (source.ts): the events of a session as an event log
// (each with its place, seq, and its type, t), their updates under the
// member names of the Agent Client Protocol's (ACP v1) session/update, and
// the state they reduce to. A transcript read on a machine (internal/
// agentproto TranscriptEvent) gives the types update, user, turn and
// notice; the others are the chat host's (internal/chatproto Event, relayed
// by the chat plugin, plugins/chat/protocol.ts): permissions and questions
// the user answers, queued messages, the chat's state and what it states
// (info: its configuration, commands, usage and capabilities), live
// increments of items being streamed, and the items of subagents (parent).
// Events come from a machine and are not trusted to have the shapes declared
// here: the reducer checks the type of every member it keeps, and the view
// reads text through asText.
import { APP_SLUG } from '../brand';
import type { Capabilities, ConfigOption, ConfigValue, Limit, SlashCommand } from '../plugins/chat/protocol';

// ---- ACP v1 ----

export interface Annotations {
  audience?: ('user' | 'assistant')[];
  priority?: number;
  lastModified?: string;
}

export interface TextContent {
  type: 'text';
  text: string;
  annotations?: Annotations;
}
export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
  uri?: string;
  annotations?: Annotations;
}
export interface AudioContent {
  type: 'audio';
  data: string;
  mimeType: string;
  annotations?: Annotations;
}
export interface ResourceLink {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: Annotations;
}
export interface TextResourceContents {
  uri: string;
  text: string;
  mimeType?: string;
}
export interface BlobResourceContents {
  uri: string;
  blob: string;
  mimeType?: string;
}
export interface EmbeddedResource {
  type: 'resource';
  resource: TextResourceContents | BlobResourceContents;
  annotations?: Annotations;
}
/** A content block. A block of another type may come from a newer agent:
 * readers go by `type` and pass over the ones they do not know. */
export type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource;

export const TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];
/** A tool call's status; cancelled is ACP v2's. */
export const TOOL_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

export interface ToolCallLocation {
  path: string;
  line?: number | null;
}

/** A diff as ACP v1 has it: one file's text before and after (oldText
 * null or absent for a new file). */
export interface DiffV1 {
  type: 'diff';
  path: string;
  oldText?: string | null;
  newText: string;
}
/** A change of a v2 diff. */
export interface DiffChange {
  operation: 'add' | 'delete' | 'modify' | 'move' | 'copy';
  path: string;
  oldPath?: string;
  fileType?: 'text' | 'binary' | 'directory' | 'symlink';
  mimeType?: string;
}
/** A diff as ACP v2 has it: the files changed, and the patch. */
export interface DiffV2 {
  type: 'diff';
  changes: DiffChange[];
  patch?: { format: string; text: string };
}
export type ToolDiff = DiffV1 | DiffV2;

export type ToolCallContent = { type: 'content'; content: ContentBlock } | ToolDiff | { type: 'terminal'; terminalId: string };

/** Whether a diff is v2's (changes and a patch) rather than v1's. */
export const isDiffV2 = (d: ToolDiff): d is DiffV2 => Array.isArray((d as DiffV2).changes);

export const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const;

export interface PlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: (typeof PLAN_STATUSES)[number];
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
}

export interface Cost {
  amount: number;
  currency: string;
}

interface Chunk {
  content: ContentBlock;
  /** The message the chunk belongs to, when the agent says. */
  messageId?: string;
}
export interface UserMessageChunk extends Chunk {
  sessionUpdate: 'user_message_chunk';
}
export interface AgentMessageChunk extends Chunk {
  sessionUpdate: 'agent_message_chunk';
}
export interface AgentThoughtChunk extends Chunk {
  sessionUpdate: 'agent_thought_chunk';
}
export type MessageChunk = UserMessageChunk | AgentMessageChunk | AgentThoughtChunk;
export interface ToolCall {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}
export interface ToolCallUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}
export interface PlanUpdate {
  sessionUpdate: 'plan';
  entries: PlanEntry[];
}
export interface AvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update';
  availableCommands: AvailableCommand[];
}
export interface CurrentModeUpdate {
  sessionUpdate: 'current_mode_update';
  currentModeId: string;
}
export interface ConfigOptionUpdate {
  sessionUpdate: 'config_option_update';
  configOptions: unknown[];
}
export interface SessionInfoUpdate {
  sessionUpdate: 'session_info_update';
  title?: string | null;
  updatedAt?: string | null;
}
/** How much of the context window the session uses, and its cost so far. */
export interface UsageUpdate {
  sessionUpdate: 'usage_update';
  used: number;
  size: number;
  cost?: Cost | null;
}

export type KnownSessionUpdate =
  | MessageChunk
  | ToolCall
  | ToolCallUpdate
  | PlanUpdate
  | AvailableCommandsUpdate
  | CurrentModeUpdate
  | ConfigOptionUpdate
  | SessionInfoUpdate
  | UsageUpdate;
export type SessionUpdateKind = KnownSessionUpdate['sessionUpdate'];
/** The update member of a session/update notification; an update of a kind
 * this version does not know is tolerated (isUpdate tells them apart). */
export type SessionUpdate = KnownSessionUpdate | { sessionUpdate: string; [key: string]: unknown };

/** Whether an update is of a kind, typed as that kind. */
export function isUpdate<K extends SessionUpdateKind>(
  u: SessionUpdate | undefined,
  kind: K,
): u is Extract<KnownSessionUpdate, { sessionUpdate: K }> {
  return !!u && u.sessionUpdate === kind;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface PermissionOutcome {
  outcome: 'selected' | 'cancelled';
  optionId?: string;
}

// ---- events ----

/** The types of an event: update, user, turn and notice come from
 * transcripts and the chat host alike; the others from the chat host
 * only. */
export type ChatEventType =
  | 'update'
  | 'user'
  | 'turn'
  | 'notice'
  | 'state'
  | 'permission'
  | 'permission_done'
  | 'question'
  | 'question_done'
  | 'queued'
  | 'info'
  | 'ack';

/** What a permission is asked for (chatproto.Permission*): plan is the
 * approval of a plan, whose options name the mode to go on in
 * (plugins/chat/protocol.ts PLAN_OPTION_PREFIX). */
export const PERMISSION_KINDS = ['tool', 'command', 'file', 'plan', 'mcp', 'other'] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

/** An answer to choose for a question; answers name options by label. */
export interface QuestionOption {
  label: string;
  description?: string;
  /** What choosing it would look like (Markdown). */
  preview?: string;
}

/** A question the agent asks the user (chatproto.Question). */
export interface Question {
  id: string;
  /** A short label of the question. */
  header?: string;
  question: string;
  /** More than one option may be chosen. */
  multiSelect?: boolean;
  /** An answer of the user's own words may be given. */
  allowOther?: boolean;
  /** The answer is not shown as typed. */
  secret?: boolean;
  options?: QuestionOption[];
}

/** Where a message sent while a turn ran is (chatproto.Queued*): waiting,
 * taken by the agent, or withdrawn before it reached it. */
export type QueuedState = 'queued' | 'taken' | 'cancelled';

/** Why something failed, by its code. */
export interface ChatError {
  code: string;
  message: string;
  stderr?: string;
}

/** An event of a conversation.
 *
 * The chat host's are stored (with a seq) or live: a live event (live) is
 * an increment of an item being streamed, without a seq, never stored.
 * Once an item is complete, or changes otherwise, a stored event carries
 * its whole content under the same item, which replaces what was taken
 * live for it (a stored notice under the item, when the host left the
 * item out, too); after attaching again, items that only have live
 * increments are dropped; once the turn ended, what arrived live and no
 * stored state followed stays as it is. */
export interface ChatEvent {
  /** Its place in the conversation; a transcript's is its line's byte
   * offset shifted left by 8 plus its index in the line. None for a live
   * event and an ack. */
  seq?: number;
  t: ChatEventType;
  /** RFC 3339. */
  at?: string;
  /** The permission's (permission, permission_done), the question's
   * (question, question_done) or the command's (ack). */
  id?: string;
  /** A streaming increment (text, a thought, a tool's input, a command's
   * output). */
  live?: boolean;
  /** The id of the item an update belongs to: a message, a thought, a
   * tool call. */
  item?: string;
  /** The tool call id of the subagent the event belongs to; none for the
   * main agent's. */
  parent?: string;
  /** update */
  update?: SessionUpdate;
  /** user, queued: the prompt's content blocks. */
  content?: ContentBlock[];
  /** user, queued: the page's id of the message. */
  clientId?: string;
  /** queued: the host's id of the message. */
  message?: string;
  /** turn: start, end or error; state: the chat's; queued: the message's
   * (QueuedState). */
  state?: string;
  stopReason?: StopReason | string;
  error?: ChatError;
  /** permission: its kind, what is asked about and the answers to choose
   * from. */
  kind?: PermissionKind;
  toolCall?: Omit<ToolCallUpdate, 'sessionUpdate'>;
  options?: PermissionOption[];
  /** permission_done: how it was answered; permission_done and
   * question_done: by whom (user, cancel, ended). */
  outcome?: PermissionOutcome;
  by?: string;
  /** question: what is asked. */
  questions?: Question[];
  /** question_done: the answers by question id (option labels or the
   * user's own words); none when it was skipped or cancelled. */
  answers?: Record<string, string[]>;
  /** info: the chat as it is now. */
  chat?: Record<string, unknown>;
  /** notice */
  method?: string;
  params?: unknown;
}

/** What a source says when what it gave so far no longer holds (another
 * file, another session): the view starts over. */
export interface ResetEvent {
  t: 'reset';
}
/** What a source says when it attached again after losing its connection:
 * the stored events it gives next follow those it gave, but live increments
 * may have been lost, so what only arrived live is dropped (an item that
 * has only live increments goes; one with a stored state goes back to it). */
export interface ReattachEvent {
  t: 'reattach';
}
export type SourceEvent = ChatEvent | ResetEvent | ReattachEvent;

// ---- the chat host's limits and names (internal/chatproto, chatadapter;
// plugins/chat/protocol.ts states them for the plugin) ----

/** The most content a prompt carries: the JSON of its blocks, in bytes. */
export const MAX_PROMPT = 8 << 20;
/** The most bytes of an image of a prompt, decoded. */
export const MAX_IMAGE = 5 << 20;
/** The permission options the host shows for an agent without its own. */
export const OPTION_ALLOW_ONCE = 'allow_once';
export const OPTION_ALLOW_SESSION = 'allow_session';
export const OPTION_REJECT_ONCE = 'reject_once';
/** A plan's approval: plan:<mode> approves it and goes on in that mode. */
export const PLAN_OPTION_PREFIX = 'plan:';
/** The categories of configuration options the view offers selectors for. */
export const CATEGORY_MODE = 'mode';
export const CATEGORY_MODEL = 'model';
export const CATEGORY_THOUGHT_LEVEL = 'thought_level';
/** The permission modes of the chat host (chatproto.Modes). */
export const MODES = ['default', 'acceptEdits', 'plan', 'full'] as const;

/** The method of a notice: an ACP extension method, `_<slug>/<name>`
 * (agentproto.NoticeMethod). */
export const noticeMethod = (name: string): string => `_${APP_SLUG}/${name}`;

/** The notices of a transcript, by name. */
export const NOTICES = {
  compacted: noticeMethod('compacted'),
  cleared: noticeMethod('cleared'),
  command: noticeMethod('command'),
  /** params: {message, willRetry?}: willRetry when the agent tries again. */
  error: noticeMethod('error'),
  model: noticeMethod('model'),
  /** A line of the transcript too long to read was passed over. */
  skipped: noticeMethod('skipped'),
} as const;

/** The notices of the chat host and its adapters, by name. */
export const CHAT_NOTICES = {
  /** The agent began to compact the context; compacted follows. No item:
   * the view says so while the turn works. */
  compacting: noticeMethod('compacting'),
  /** The session went on in a terminal (handoff). */
  handedOff: noticeMethod('handed_off'),
  /** The agent was started again (params: {mode?}): to switch to a
   * permission mode it takes only at its start. */
  restarted: noticeMethod('restarted'),
  /** What follows was imported from the agent's own record of the session
   * (params: {lossy?}: parts may differ or be missing). */
  imported: noticeMethod('imported'),
  /** The agent started without the project's own settings (its hooks, MCP
   * servers and instructions): nothing trusts the folder (params: {cwd}).
   * The view offers to trust it (ChatSource.trust). */
  untrustedFolder: noticeMethod('untrusted_folder'),
  /** The chat had full access, which the machine's settings no longer
   * allow: its agent started in the default mode (params: {mode}). */
  fullAccessOff: noticeMethod('full_access_off'),
} as const;

/** The notice the view adds when a turn ends for another reason than the
 * agent's being done (params: {stopReason}). */
export const STOPPED = noticeMethod('stopped');

/** The stop reasons of a turn the view tells the user about (STOPPED). */
export const NOTABLE_STOPS = ['cancelled', 'max_tokens', 'max_turn_requests', 'refusal'] as const;

// ---- the conversation ----

export interface MessageItem {
  kind: 'message';
  id: string;
  role: 'user' | 'agent';
  content: ContentBlock[];
  /** Its text is still arriving (live increments): the view draws it a
   * part at a time until its stored event gives it whole. */
  live?: boolean;
  at?: string;
}
export interface ThoughtItem {
  kind: 'thought';
  id: string;
  content: ContentBlock[];
  /** The tokens the agent thought, as it estimates them: for a thought
   * whose text it keeps to itself (`_meta.<slug>.estimatedTokens`). */
  estimatedTokens?: number;
  live?: boolean;
  at?: string;
}
export interface ToolItem {
  kind: 'tool';
  /** The tool call's id in the tool calls' own namespace (toolItemId):
   * `tool:<toolCallId>`. */
  id: string;
  title: string;
  toolKind?: ToolKind;
  status?: ToolStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  /** The tool call's `_meta`, ACP's member for extensions: under the
   * product's slug, a command's exitCode and whether it was interrupted. */
  meta?: Record<string, unknown>;
  /** The conversation of the subagent the call runs (events whose parent
   * is the call's id), reduced as a conversation of its own. */
  sub?: Conversation;
  at?: string;
}
export interface PlanItem {
  kind: 'plan';
  id: string;
  entries: PlanEntry[];
  at?: string;
}
export interface NoticeItem {
  kind: 'notice';
  id: string;
  method: string;
  params?: unknown;
  at?: string;
}
/** A permission the agent asked for: what (call), of which kind, the
 * answers to choose from, and once answered how and by whom. */
export interface PermissionItem {
  kind: 'permission';
  id: string;
  /** The host's id of the permission, which an answer names. */
  request: string;
  permission: PermissionKind;
  /** The tool call it is asked for. */
  call: ToolItem;
  options: PermissionOption[];
  /** The subagent's tool call that asked; none for the main agent. */
  parent?: string;
  /** Set once answered (permission_done). */
  outcome?: PermissionOutcome;
  /** Who answered: user, cancel (the turn was cancelled), ended. */
  by?: string;
  at?: string;
}
/** Questions the agent asked the user together. */
export interface QuestionItem {
  kind: 'question';
  id: string;
  request: string;
  questions: Question[];
  parent?: string;
  /** Answered or skipped (question_done). */
  done?: boolean;
  /** The answers by question id; none when skipped or cancelled. */
  answers?: Record<string, string[]>;
  by?: string;
  at?: string;
}
/** What the view shows, in order; an item is replaced by one of its id. */
export type Item = MessageItem | ThoughtItem | ToolItem | PlanItem | NoticeItem | PermissionItem | QuestionItem;

/** The context window, cost and the subscription's limits (usage_update,
 * the chat's usage); size 0 while it is not known. */
export interface Usage {
  used: number;
  size: number;
  /** The agent's own measure of the context in use, 0 to 100. */
  percentage?: number;
  cost?: Cost;
  limits?: Limit[];
}

/** A message sent while a turn ran, waiting for the agent to take it. */
export interface QueuedMessage {
  /** The host's id, which cancelling it names. */
  message: string;
  clientId?: string;
  content: ContentBlock[];
  at?: string;
}

/** What the chat states (an info event's chat), each member checked. */
export interface ChatInfo {
  title?: string;
  cwd?: string;
  state?: string;
  status?: string;
  error?: ChatError;
  handedOff?: boolean;
  agentVersion?: string;
  config: ConfigOption[];
  commands: SlashCommand[];
  usage?: Usage;
  capabilities: Capabilities;
}

/** The capabilities of a chat nobody told of: none. */
export const NO_CAPABILITIES: Capabilities = Object.freeze({
  images: false,
  compact: false,
  queue: false,
  plan: false,
  questions: false,
  effort: false,
  model: false,
  cancelQueued: false,
});

export interface Conversation {
  items: Item[];
  /** An item's index in items, by its id. A state shares this index with
   * the states reduced from it, which may have added ids at indexes beyond
   * its own items: an entry holds for a state when it is below
   * items.length (itemById). */
  byId: Record<string, number>;
  usage?: Usage;
  title?: string;
  turn: 'idle' | 'working';
  /** Events and updates of kinds the view does not show. */
  unknown: number;
  /** What the chat states (info events). */
  chat?: ChatInfo;
  /** The chat's state (chatproto.State*: state and info events), and why
   * it failed. */
  state?: string;
  stateError?: ChatError;
  /** Messages waiting for the agent, in the order sent. */
  queued?: QueuedMessage[];
  /** The host's ids of messages taken or withdrawn that were not waiting
   * here (queued on an earlier page): a page of earlier events no longer
   * has them waiting (join), the latest MAX_LIST.queued. */
  dequeued?: string[];
  /** What the agent does in the current turn besides its items. */
  activity?: 'compacting';
  /** The live overlay: for each item that took live increments since its
   * last stored state, that state (null: it has none, it only arrived
   * live). A stored event for the item, or a reattach, puts it back. */
  live?: Record<string, Item | null>;
  // What the reducer keeps of the events it took, for those that follow
  // and for a page of earlier ones (prepend).
  /** The lowest and the highest seq taken. */
  first?: number;
  last?: number;
  /** Where in items the current turn starts. */
  turnStart?: number;
  /** Where in items the first turn whose start was taken starts. */
  head?: number;
  /** A turn's start or end was taken. */
  turnSeen?: boolean;
  /** The id of the current turn's plan. */
  plan?: string;
  /** The first item was begun by a chunk without a message id: the last
   * item of its kind of an earlier page continues into it. */
  open?: boolean;
}

export function emptyConversation(): Conversation {
  return { items: [], byId: {}, turn: 'idle', unknown: 0 };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A member of an event read as text: a string, else nothing. */
export const asText = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A member read as text that is not empty. */
const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** A content block: an object with a type, and a text block's text a
 * string. */
const isBlock = (b: unknown): b is ContentBlock =>
  isObject(b) && typeof b.type === 'string' && (b.type !== 'text' || typeof b.text === 'string');

/** The text of content blocks, joined; what is no text block is passed
 * over (also in a list a machine sent, not yet checked). */
export function blocksText(blocks: readonly ContentBlock[]): string {
  let s = '';
  for (const b of blocks) if (isObject(b) && b.type === 'text' && typeof b.text === 'string') s += b.text;
  return s;
}

const isToolKind = (k: unknown): k is ToolKind => typeof k === 'string' && (TOOL_KINDS as readonly string[]).includes(k);
const isToolStatus = (s: unknown): s is ToolStatus => typeof s === 'string' && (TOOL_STATUSES as readonly string[]).includes(s);
const settled = (s: ToolStatus | undefined) => s === 'completed' || s === 'failed' || s === 'cancelled';

/** A tool call's content of a type the view knows: a content block, a diff
 * (v1's texts, v2's changes, or a patch) or a terminal. */
function isToolContent(x: unknown): x is ToolCallContent {
  if (!isObject(x)) return false;
  switch (x.type) {
    case 'content':
      return isBlock(x.content);
    case 'diff':
      return typeof x.newText === 'string' || Array.isArray(x.changes) || (isObject(x.patch) && typeof x.patch.text === 'string');
    case 'terminal':
      return typeof x.terminalId === 'string';
    default:
      return false;
  }
}

const isLocation = (l: unknown): l is ToolCallLocation =>
  isObject(l) && typeof l.path === 'string' && l.path !== '' && (l.line == null || typeof l.line === 'number');

/** Plan entries as the view shows them: an entry without text is dropped,
 * an unknown status or priority is pending or medium. */
function planEntries(entries: readonly unknown[]): PlanEntry[] {
  const out: PlanEntry[] = [];
  for (const e of entries) {
    if (!isObject(e) || typeof e.content !== 'string') continue;
    const status = (PLAN_STATUSES as readonly unknown[]).includes(e.status) ? (e.status as PlanEntry['status']) : 'pending';
    const priority = e.priority === 'high' || e.priority === 'low' ? e.priority : 'medium';
    out.push({ content: e.content, priority, status });
  }
  return out;
}

const isCost = (c: unknown): c is Cost =>
  isObject(c) && typeof c.amount === 'number' && Number.isFinite(c.amount) && typeof c.currency === 'string';
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

// ---- what the chat host states, read from what a machine sent ----

/** The most of a list a machine sends the view keeps: configuration
 * options, their values, commands, limit windows, questions and their
 * options, permission options, queued messages. */
const MAX_LIST = { config: 64, values: 256, commands: 500, limits: 16, questions: 16, options: 64, queued: 100 } as const;

function readError(e: unknown): ChatError | undefined {
  if (!isObject(e)) return undefined;
  const code = asText(e.code) ?? '';
  const message = asText(e.message) ?? '';
  if (!code && !message) return undefined;
  const stderr = asText(e.stderr);
  return stderr ? { code, message, stderr } : { code, message };
}

function readValue(v: unknown): ConfigValue | undefined {
  if (!isObject(v) || typeof v.value !== 'string') return undefined;
  const out: ConfigValue = { value: v.value, name: asText(v.name) || v.value };
  const d = asText(v.description);
  if (d) out.description = d;
  if (v.full === true) out.full = true;
  return out;
}

function readConfig(o: unknown): ConfigOption | undefined {
  if (!isObject(o) || !nonEmpty(o.id) || o.type !== 'select' || !Array.isArray(o.options)) return undefined;
  const options = o.options.slice(0, MAX_LIST.values).flatMap((v) => readValue(v) ?? []);
  const out: ConfigOption = {
    id: o.id as string,
    name: asText(o.name) || (o.id as string),
    type: 'select',
    currentValue: asText(o.currentValue) ?? '',
    options,
  };
  const d = asText(o.description);
  if (d) out.description = d;
  const c = asText(o.category);
  if (c) out.category = c;
  return out;
}

function readCommand(c: unknown): SlashCommand | undefined {
  if (!isObject(c)) return undefined;
  const name = asText(c.name)?.replace(/^\//, '').trim();
  if (!name || /\s/.test(name)) return undefined;
  const out: SlashCommand = { name };
  const d = asText(c.description);
  if (d) out.description = d;
  const h = asText(c.argumentHint);
  if (h) out.argumentHint = h;
  return out;
}

function readLimit(l: unknown): Limit | undefined {
  if (!isObject(l) || !nonEmpty(l.id)) return undefined;
  const used = count(l.usedPercent);
  if (used === undefined) return undefined;
  const out: Limit = { id: l.id as string, usedPercent: Math.min(100, used) };
  const label = asText(l.label);
  if (label) out.label = label;
  const resets = count(l.resetsAt);
  if (resets) out.resetsAt = resets;
  const minutes = count(l.windowMinutes);
  if (minutes) out.windowMinutes = minutes;
  return out;
}

/** A chat's usage, read from what a machine sent; undefined when it has
 * no count of tokens. */
export function readUsage(u: unknown): Usage | undefined {
  if (!isObject(u)) return undefined;
  const used = count(u.used);
  if (used === undefined) return undefined;
  const out: Usage = { used, size: count(u.size) ?? 0 };
  const pct = count(u.percentage);
  if (pct !== undefined && pct > 0) out.percentage = Math.min(100, pct);
  if (isCost(u.cost)) out.cost = { amount: u.cost.amount, currency: u.cost.currency };
  if (Array.isArray(u.limits)) {
    const limits = u.limits.slice(0, MAX_LIST.limits).flatMap((l) => readLimit(l) ?? []);
    if (limits.length) out.limits = limits;
  }
  return out;
}

function readCapabilities(c: unknown): Capabilities {
  if (!isObject(c)) return NO_CAPABILITIES;
  const out = { ...NO_CAPABILITIES };
  for (const k of Object.keys(out) as (keyof Capabilities)[]) out[k] = c[k] === true;
  return out;
}

/** What a chat states (chatproto.Chat), each member checked; undefined for
 * what is no object. */
export function readChat(chat: unknown): ChatInfo | undefined {
  if (!isObject(chat)) return undefined;
  const out: ChatInfo = {
    config: Array.isArray(chat.config) ? chat.config.slice(0, MAX_LIST.config).flatMap((o) => readConfig(o) ?? []) : [],
    commands: Array.isArray(chat.commands) ? chat.commands.slice(0, MAX_LIST.commands).flatMap((c) => readCommand(c) ?? []) : [],
    capabilities: readCapabilities(chat.capabilities),
  };
  for (const k of ['title', 'cwd', 'state', 'status', 'agentVersion'] as const) {
    const v = asText(chat[k]);
    if (v) out[k] = v;
  }
  const error = readError(chat.error);
  if (error) out.error = error;
  if (chat.handedOff === true) out.handedOff = true;
  const usage = readUsage(chat.usage);
  if (usage) out.usage = usage;
  return out;
}

/** The configuration option of a category the chat has, when it offers
 * a choice (two values or more). */
export function configOf(chat: ChatInfo | undefined, category: string): ConfigOption | undefined {
  const o = chat?.config.find((x) => x.category === category);
  return o && o.options.length > 1 ? o : undefined;
}

/** A question's id, which names its answer in a record: not a member every
 * object has (__proto__, constructor, toString…). */
const questionId = (id: unknown): id is string => !!nonEmpty(id) && !Object.hasOwn(Object.prototype, id as string);

function readQuestion(q: unknown): Question | undefined {
  if (!isObject(q) || !questionId(q.id) || !nonEmpty(q.question)) return undefined;
  const out: Question = { id: q.id as string, question: q.question as string };
  const header = asText(q.header);
  if (header) out.header = header;
  if (q.multiSelect === true) out.multiSelect = true;
  if (q.allowOther === true) out.allowOther = true;
  if (q.secret === true) out.secret = true;
  if (Array.isArray(q.options)) {
    const options = q.options.slice(0, MAX_LIST.options).flatMap((o): QuestionOption[] => {
      if (!isObject(o) || !nonEmpty(o.label)) return [];
      const opt: QuestionOption = { label: o.label as string };
      const d = asText(o.description);
      if (d) opt.description = d;
      const p = asText(o.preview);
      if (p) opt.preview = p;
      return [opt];
    });
    if (options.length) out.options = options;
  }
  return out;
}

const PERMISSION_OPTION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;

function readOption(o: unknown): PermissionOption | undefined {
  if (!isObject(o) || !nonEmpty(o.optionId)) return undefined;
  const id = o.optionId as string;
  const kind = (PERMISSION_OPTION_KINDS as readonly unknown[]).includes(o.kind)
    ? (o.kind as PermissionOption['kind'])
    : id.startsWith('reject')
      ? 'reject_once'
      : 'allow_once';
  return { optionId: id, name: asText(o.name) ?? '', kind };
}

function readAnswers(a: unknown): Record<string, string[]> | undefined {
  if (!isObject(a)) return undefined;
  const out: Record<string, string[]> = Object.create(null);
  let any = false;
  for (const [k, v] of Object.entries(a)) {
    if (!Array.isArray(v) || !questionId(k)) continue;
    out[k] = v.filter((x): x is string => typeof x === 'string');
    any = true;
  }
  return any ? out : undefined;
}

// ---- the reducer ----

/** The length of the list an index (byId) serves. Its entries below that
 * length are a state's; a state of a shorter list that adds an item copies
 * the index rather than write into one a longer list uses (a state reduced
 * a second time). */
const served = new WeakMap<object, number>();

/** A copy of an index with the entries below n, for a list of n items. */
function indexFor(byId: Record<string, number>, n: number): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const id of Object.keys(byId)) {
    const i = byId[id];
    if (typeof i === 'number' && i < n) out[id] = i;
  }
  return out;
}

/** The id of the item of a tool call: its call id in a namespace of its
 * own, apart from the host's items (permission:…, question:…), the
 * messages' and the notices', whatever an agent names its calls. */
export const toolItemId = (toolCallId: string): string => `tool:${toolCallId}`;

/** A new index of a list. */
function indexOfList(items: readonly Item[]): Record<string, number> {
  const byId: Record<string, number> = Object.create(null);
  for (let i = 0; i < items.length; i++) byId[items[i].id] = i;
  served.set(byId, items.length);
  return byId;
}

function indexOf(c: Conversation, id: string): number | undefined {
  const i = Object.hasOwn(c.byId, id) ? c.byId[id] : undefined;
  return typeof i === 'number' && i < c.items.length && c.items[i]?.id === id ? i : undefined;
}

/** Whether the conversation has the user's message a page named clientId
 * (Command.clientId): the agent took it, or it waits in the queue. */
export function hasClientMessage(state: Conversation, clientId: string): boolean {
  return !!clientId && (indexOf(state, clientItem(clientId)) !== undefined || !!state.queued?.some((q) => q.clientId === clientId));
}

/** The item of an id. */
export function itemById(state: Conversation, id: string): Item | undefined {
  const i = indexOf(state, id);
  return i === undefined ? undefined : state.items[i];
}

/** id, or id with a suffix when an item has it already. */
function fresh(c: Conversation, id: string): string {
  let out = id;
  for (let k = 2; indexOf(c, out) !== undefined; k++) out = `${id}~${k}`;
  return out;
}

/** Blocks with another one added: text after text joins it. */
function appendBlock(blocks: readonly ContentBlock[], block: ContentBlock): ContentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last?.type === 'text' && block.type === 'text' && !('_meta' in last) && !('_meta' in block))
    return [...blocks.slice(0, -1), { ...last, text: last.text + block.text }];
  return [...blocks, block];
}

const concat = (a: readonly ContentBlock[], b: readonly ContentBlock[]) => b.reduce(appendBlock, a as ContentBlock[]);

/** A state while it takes events: a copy of its members whose list is
 * copied at its first change, so that a batch of events copies it once and
 * each event costs only what it changes. */
interface Work {
  c: Conversation;
  /** c.items is the work's own copy. */
  own: boolean;
  /** c.live is the work's own copy. */
  ownLive: boolean;
  changed: boolean;
  /** The works of subagents' conversations this batch changed, by the
   * tool call that runs each: put into their calls once the batch is
   * taken (flush). */
  subs?: Map<string, Work>;
}

const work = (state: Conversation): Work => ({ c: { ...state }, own: false, ownLive: false, changed: false });

function items(w: Work): Item[] {
  if (!w.own) {
    w.c.items = w.c.items.slice();
    w.own = true;
  }
  w.changed = true;
  return w.c.items;
}

function put(w: Work, i: number, item: Item) {
  items(w)[i] = item;
}

function add(w: Work, item: Item) {
  const c = w.c;
  const n = c.items.length;
  items(w).push(item);
  if (served.get(c.byId) !== n) c.byId = indexFor(c.byId, n);
  c.byId[item.id] = n;
  served.set(c.byId, n + 1);
}

function unknown(w: Work) {
  w.c.unknown += 1;
  w.changed = true;
}

function liveMap(w: Work): Record<string, Item | null> {
  if (!w.ownLive) {
    w.c.live = Object.assign(Object.create(null), w.c.live) as Record<string, Item | null>;
    w.ownLive = true;
  }
  w.changed = true;
  return w.c.live!;
}

const hasBase = (c: Conversation, id: string) => !!c.live && Object.hasOwn(c.live, id);

/** Keeps an item's stored state (none: undefined) before its first live
 * increment. */
function remember(w: Work, id: string, stored: Item | undefined) {
  if (!hasBase(w.c, id)) liveMap(w)[id] = stored ?? null;
}

function forget(w: Work, id: string) {
  if (hasBase(w.c, id)) delete liveMap(w)[id];
}

/** The marks of a chunk under the product's slug in `_meta` (truncated: its
 * text was cut short), put on its block, where the view reads them. */
function marked(block: ContentBlock, meta: unknown): ContentBlock {
  const own = isObject(meta) ? meta[APP_SLUG] : undefined;
  if (!isObject(own) || own.truncated !== true) return block;
  const prev = (block as { _meta?: unknown })._meta;
  const mine = isObject(prev) && isObject(prev[APP_SLUG]) ? prev[APP_SLUG] : {};
  const out = { ...block, _meta: { ...(isObject(prev) ? prev : {}), [APP_SLUG]: { ...mine, truncated: true } } };
  return out as ContentBlock;
}

/** A thought's tokens as the agent estimates them, from its update's
 * `_meta` under the product's slug: a whole number above 0, or none. */
function estimatedTokens(meta: unknown): number | undefined {
  const own = isObject(meta) ? meta[APP_SLUG] : undefined;
  const n = isObject(own) ? own.estimatedTokens : undefined;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.round(n) : undefined;
}

/** The members a value has under the product's slug in its `_meta` (ACP's
 * member for extensions): a block's or a tool call's marks. */
export function ownMeta(x: unknown): Record<string, unknown> | undefined {
  const meta = isObject(x) ? x._meta : undefined;
  const own = isObject(meta) ? meta[APP_SLUG] : undefined;
  return isObject(own) ? own : undefined;
}

const withAt = <T extends Item>(item: T, at: unknown): T => (typeof at === 'string' && at ? { ...item, at } : item);

/** An item without its live mark. */
function settledItem<T extends MessageItem | ThoughtItem>(it: T): T {
  if (!it.live) return it;
  const out = { ...it };
  delete out.live;
  return out;
}

/** A chunk of a message or a thought. With an item id (the chat host's),
 * a live chunk adds to the item and a stored one gives the item whole;
 * without one, it is added to its message (by messageId), else to the
 * last item when that is the same kind of message, else as a new item. */
function chunk(w: Work, ev: ChatEvent, u: MessageChunk) {
  if (!isBlock(u.content)) return unknown(w);
  const c = w.c;
  const kind = u.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'message';
  const role = u.sessionUpdate === 'user_message_chunk' ? 'user' : 'agent';
  const same = (it: Item | undefined): it is MessageItem | ThoughtItem =>
    !!it && it.kind === kind && (it.kind === 'thought' || it.role === role);
  const meta = (u as { _meta?: unknown })._meta;
  const block = marked(u.content, meta);
  const live = ev.live === true;
  // A thought's estimate: the latest an increment gives, the one its
  // stored state gives.
  const estimate = kind === 'thought' ? estimatedTokens(meta) : undefined;
  const estimated = <T extends MessageItem | ThoughtItem>(it: T, whole: boolean): T => {
    if (it.kind !== 'thought' || (estimate === undefined && !(whole && it.estimatedTokens !== undefined))) return it;
    const out = { ...it };
    if (estimate === undefined) delete (out as ThoughtItem).estimatedTokens;
    else (out as ThoughtItem).estimatedTokens = estimate;
    return out;
  };
  const make = (id: string): MessageItem | ThoughtItem => {
    const it: MessageItem | ThoughtItem = kind === 'thought' ? { kind, id, content: [block] } : { kind, id, role, content: [block] };
    if (live) it.live = true;
    return estimated(withAt(it, ev.at), true);
  };
  const key = nonEmpty(ev.item);
  if (key !== undefined) {
    const id = `${kind}:${role}:item:${key}`;
    const i = indexOf(c, id);
    const prev = i === undefined ? undefined : c.items[i];
    if (prev && !same(prev)) return unknown(w);
    if (live) {
      remember(w, id, prev);
      if (i !== undefined && prev) put(w, i, estimated({ ...prev, content: appendBlock(prev.content, block), live: true }, false));
      else add(w, make(id));
      return;
    }
    forget(w, id);
    if (i !== undefined && prev) put(w, i, estimated(settledItem({ ...prev, content: [block] }), true));
    else add(w, make(id));
    return;
  }
  const byMessage = typeof u.messageId === 'string' && u.messageId !== '';
  const last = c.items.length - 1;
  let i: number | undefined;
  let id: string;
  if (byMessage) {
    id = `${kind}:${role}:id:${u.messageId}`;
    i = indexOf(c, id);
    // A tool call's id may look like a message's.
    if (i !== undefined && !same(c.items[i])) return unknown(w);
  } else if (same(c.items[last])) {
    i = last;
    id = c.items[last].id;
  } else {
    id = fresh(c, `${kind}:${role}:${ev.seq ?? c.items.length}`);
  }
  const prev = i === undefined ? undefined : c.items[i];
  if (live) remember(w, id, prev);
  if (i !== undefined && same(prev)) {
    const next = estimated(withAt({ ...prev, content: appendBlock(prev.content, block) }, prev.at ?? ev.at), false);
    put(w, i, live ? { ...next, live: true } : next);
    return;
  }
  if (!c.items.length && !byMessage) c.open = true;
  add(w, make(id));
}

/** A tool call's content with live output added: text after text joins
 * it. */
function appendOutput(prev: readonly ToolCallContent[], more: readonly ToolCallContent[]): ToolCallContent[] {
  const out = prev.slice();
  for (const x of more) {
    const last = out[out.length - 1];
    if (
      x.type === 'content' &&
      x.content.type === 'text' &&
      last?.type === 'content' &&
      last.content.type === 'text' &&
      !('_meta' in last.content) &&
      !('_meta' in x.content)
    )
      out[out.length - 1] = { type: 'content', content: { ...last.content, text: last.content.text + x.content.text } };
    else out.push(x);
  }
  return out;
}

/** A tool call after a call or an update of it: present members replace
 * the call's (a call for an id an update made first does not take a
 * settled status back); a live update adds its text output to the call's. */
function applyTool(prev: ToolItem | undefined, id: string, u: ToolCall | ToolCallUpdate, live: boolean): ToolItem {
  const call = u.sessionUpdate === 'tool_call';
  const next: ToolItem = prev ? { ...prev } : { kind: 'tool', id, title: '', content: [], locations: [] };
  if (typeof u.title === 'string' && (u.title || !prev)) next.title = u.title;
  if (isToolKind(u.kind)) next.toolKind = u.kind;
  if (isToolStatus(u.status) && !(call && prev && settled(prev.status))) next.status = u.status;
  if (Array.isArray(u.content)) {
    const content = u.content.filter(isToolContent);
    if (live && !call) next.content = appendOutput(prev?.content ?? [], content);
    else if (!call || content.length || !prev) next.content = content;
  }
  if (Array.isArray(u.locations)) {
    const locations = u.locations.filter(isLocation);
    if (!call || locations.length || !prev) next.locations = locations;
  }
  if (u.rawInput !== undefined) next.rawInput = u.rawInput;
  if (u.rawOutput !== undefined) next.rawOutput = u.rawOutput;
  const meta = (u as { _meta?: unknown })._meta;
  if (isObject(meta)) next.meta = { ...prev?.meta, ...meta };
  return next;
}

/** A tool call, or an update of one (applyTool); an update of a call not
 * seen yet makes its item. A live one keeps the call's stored state; a
 * stored one with an item id gives the call whole, on its stored state. */
function tool(w: Work, ev: ChatEvent, u: ToolCall | ToolCallUpdate) {
  if (typeof u.toolCallId !== 'string' || u.toolCallId === '') return unknown(w);
  const c = w.c;
  const id = toolItemId(u.toolCallId);
  const i = indexOf(c, id);
  const cur = i === undefined ? undefined : c.items[i];
  if (cur && cur.kind !== 'tool') return unknown(w);
  let next: ToolItem;
  if (ev.live === true) {
    remember(w, id, cur);
    next = applyTool(cur, id, u, true);
  } else if (hasBase(c, id)) {
    const base = (c.live![id] ?? undefined) as ToolItem | undefined;
    if (nonEmpty(ev.item) !== undefined) {
      forget(w, id);
      next = applyTool(base, id, u, false);
    } else {
      next = applyTool(cur, id, u, false);
      liveMap(w)[id] = applyTool(base, id, u, false);
    }
  } else next = applyTool(cur, id, u, false);
  // A subagent's conversation is the call's own, whatever state it goes
  // back to.
  if (cur?.sub) next.sub = cur.sub;
  else delete next.sub;
  if (cur?.at) next.at = cur.at;
  if (i !== undefined) put(w, i, next);
  else add(w, withAt(next, ev.at));
}

/** A plan: the current turn's plan item takes its entries, else it is the
 * turn's plan item. */
function plan(w: Work, ev: ChatEvent, u: PlanUpdate) {
  if (!Array.isArray(u.entries)) return unknown(w);
  const c = w.c;
  const entries = planEntries(u.entries);
  const i = c.plan === undefined ? undefined : indexOf(c, c.plan);
  const prev = i === undefined ? undefined : c.items[i];
  if (i !== undefined && prev?.kind === 'plan') return put(w, i, { ...prev, entries });
  const id = fresh(c, `plan:${ev.seq ?? c.items.length}`);
  add(w, withAt({ kind: 'plan', id, entries }, ev.at));
  c.plan = id;
}

/** An ACP usage update: the context's tokens and cost; the limits the
 * chat told of stay. */
function usage(w: Work, u: UsageUpdate) {
  if (typeof u.used !== 'number' || !Number.isFinite(u.used) || u.used < 0) return unknown(w);
  const c = w.c;
  const size = typeof u.size === 'number' && Number.isFinite(u.size) && u.size > 0 ? u.size : (c.usage?.size ?? 0);
  const cost = isCost(u.cost) ? u.cost : u.cost === null ? undefined : c.usage?.cost;
  const next: Usage = cost ? { used: u.used, size, cost } : { used: u.used, size };
  if (c.usage?.limits) next.limits = c.usage.limits;
  c.usage = next;
  w.changed = true;
}

function update(w: Work, ev: ChatEvent) {
  const u = ev.update;
  if (!isObject(u) || typeof u.sessionUpdate !== 'string') return unknown(w);
  if (isUpdate(u, 'agent_message_chunk') || isUpdate(u, 'agent_thought_chunk') || isUpdate(u, 'user_message_chunk')) return chunk(w, ev, u);
  if (isUpdate(u, 'tool_call') || isUpdate(u, 'tool_call_update')) return tool(w, ev, u);
  if (isUpdate(u, 'plan')) return plan(w, ev, u);
  if (isUpdate(u, 'usage_update')) return usage(w, u);
  if (isUpdate(u, 'session_info_update')) {
    if (u.title === undefined) return;
    if (typeof u.title === 'string' && u.title) w.c.title = u.title;
    else delete w.c.title;
    w.changed = true;
    return;
  }
  // Known kinds the view has nothing to show for (the chat's info gives
  // its commands, modes and options).
  if (isUpdate(u, 'available_commands_update') || isUpdate(u, 'current_mode_update') || isUpdate(u, 'config_option_update')) return;
  unknown(w);
}

const isUserMessage = (it: Item | undefined): it is MessageItem => it?.kind === 'message' && it.role === 'user';
const sameText = (a: MessageItem, b: readonly ContentBlock[]) => a.content.length === b.length && blocksText(a.content) === blocksText(b);

/** The id of the user's message a client named (its clientId), or a
 * queued message the host named. */
const clientItem = (clientId: string) => `message:user:c:${clientId}`;
const queuedItem = (message: string) => `message:user:q:${message}`;

/** A user's message the agent took: once, by the page's id of it. */
function userMessage(w: Work, id: string, content: ContentBlock[], at: unknown) {
  const i = indexOf(w.c, id);
  if (i === undefined) return add(w, withAt({ kind: 'message', id, role: 'user', content }, at));
  const prev = w.c.items[i];
  if (prev.kind === 'message' && content.length && !sameText(prev, content)) put(w, i, { ...prev, content });
}

/** A prompt of the user. One a page named (clientId) is taken once; one
 * without a name that repeats the text right before it in the same turn is
 * the same prompt. */
function user(w: Work, ev: ChatEvent) {
  const c = w.c;
  const content = (Array.isArray(ev.content) ? ev.content : []).filter(isBlock);
  const client = nonEmpty(ev.clientId);
  if (client !== undefined) return userMessage(w, clientItem(client), content, ev.at);
  const last = c.items.length - 1;
  const prev = c.items[last];
  if (isUserMessage(prev) && last >= (c.turnStart ?? 0) && sameText(prev, content)) return;
  add(w, withAt({ kind: 'message', id: fresh(c, `message:user:${ev.seq ?? c.items.length}`), role: 'user', content }, ev.at));
}

/** A message sent while a turn ran: waiting in the queue, then taken (a
 * prompt of the user's from then on) or withdrawn. */
function queued(w: Work, ev: ChatEvent) {
  const message = nonEmpty(ev.message);
  if (message === undefined || (ev.state !== 'queued' && ev.state !== 'taken' && ev.state !== 'cancelled')) return unknown(w);
  const c = w.c;
  const list = c.queued ?? [];
  const at = list.findIndex((q) => q.message === message);
  const content = Array.isArray(ev.content) ? ev.content.filter(isBlock) : [];
  const client = nonEmpty(ev.clientId) ?? (at >= 0 ? list[at].clientId : undefined);
  w.changed = true;
  if (ev.state === 'queued') {
    const q: QueuedMessage = { message, content: content.length || at < 0 ? content : list[at].content };
    if (client) q.clientId = client;
    if (typeof ev.at === 'string' && ev.at) q.at = ev.at;
    c.queued = at >= 0 ? list.map((x, k) => (k === at ? q : x)) : [...list, q].slice(-MAX_LIST.queued);
    return;
  }
  c.queued = at >= 0 ? list.filter((_, k) => k !== at) : list;
  if (at < 0 && !c.dequeued?.includes(message)) c.dequeued = [...(c.dequeued ?? []), message].slice(-MAX_LIST.queued);
  if (ev.state === 'cancelled') return;
  const blocks = content.length ? content : at >= 0 ? list[at].content : [];
  userMessage(w, client ? clientItem(client) : queuedItem(message), blocks, ev.at);
}

function noticeItem(w: Work, ev: ChatEvent, method: string, params: unknown): NoticeItem {
  const item: NoticeItem = { kind: 'notice', id: fresh(w.c, `notice:${ev.seq ?? w.c.items.length}`), method };
  return withAt(params === undefined ? item : { ...item, params }, ev.at);
}

function notice(w: Work, ev: ChatEvent, method: string, params: unknown) {
  add(w, noticeItem(w, ev, method, params));
}

/** Puts an item of another id at index i. */
function replaceAt(w: Work, i: number, item: Item) {
  put(w, i, item);
  const c = w.c;
  const n = c.items.length;
  if (served.get(c.byId) !== n) c.byId = indexFor(c.byId, n);
  c.byId[item.id] = i;
  served.set(c.byId, n);
}

/** A stored notice under an item (the host left the item's stored state
 * out: skipped) is that item's stored state: what arrived live for the
 * item goes. An item that only arrived live gives its place to the notice
 * (a subagent's call keeps its place, its conversation and what arrived
 * for it); one with a stored state goes back to it, the notice after it.
 * It reports whether the notice took an item's place. */
function noticeForItem(w: Work, ev: ChatEvent, key: string, method: string): boolean {
  let placed = false;
  for (const id of [`message:agent:item:${key}`, `thought:agent:item:${key}`, `message:user:item:${key}`, toolItemId(key)]) {
    const i = indexOf(w.c, id);
    if (i === undefined || !hasBase(w.c, id)) continue;
    const it = w.c.items[i];
    const base = w.c.live![id];
    forget(w, id);
    if (base !== null) put(w, i, it.kind === 'tool' && base.kind === 'tool' && it.sub ? { ...base, sub: it.sub } : base);
    else if (!placed && !(it.kind === 'tool' && it.sub)) {
      replaceAt(w, i, noticeItem(w, ev, method, ev.params));
      placed = true;
    } else if (it.kind === 'message' || it.kind === 'thought') put(w, i, settledItem(it));
  }
  return placed;
}

/** The conversation with what arrived live kept as it is: no item waits
 * for a stored state any more (its subagents' neither), which a turn that
 * ended without one leaves (cancelled while it streamed). */
function settleLive(c: Conversation): Conversation {
  if (!hasLive(c)) return c;
  const live = c.live ?? {};
  let list: Item[] | undefined;
  for (let k = 0; k < c.items.length; k++) {
    const it = c.items[k];
    let next = it;
    if (Object.hasOwn(live, it.id) && (next.kind === 'message' || next.kind === 'thought')) next = settledItem(next);
    if (next.kind === 'tool' && next.sub && hasLive(next.sub)) next = { ...next, sub: settleLive(next.sub) };
    if (next !== it) (list ??= c.items.slice())[k] = next;
  }
  const out: Conversation = { ...c };
  // The same ids at the same places: the index holds.
  if (list) out.items = list;
  delete out.live;
  return out;
}

/** Settles what arrived live (settleLive) in the work. */
function settle(w: Work) {
  if (!hasLive(w.c)) return;
  flush(w);
  const items = w.c.items;
  w.c = settleLive(w.c);
  if (w.c.items !== items) w.own = true;
  w.ownLive = false;
  w.changed = true;
}

const NOTICE_METHODS: readonly string[] = [
  ...Object.values(NOTICES),
  CHAT_NOTICES.handedOff,
  CHAT_NOTICES.restarted,
  CHAT_NOTICES.imported,
  CHAT_NOTICES.untrustedFolder,
  CHAT_NOTICES.fullAccessOff,
  STOPPED,
];

function turn(w: Work, ev: ChatEvent) {
  const c = w.c;
  if (ev.state === 'start') {
    c.turn = 'working';
    c.turnStart = c.items.length;
    c.head ??= c.items.length;
    c.turnSeen = true;
    delete c.plan;
    w.changed = true;
    return;
  }
  if (ev.state !== 'end' && ev.state !== 'error') return unknown(w);
  c.turn = 'idle';
  c.turnSeen = true;
  delete c.activity;
  w.changed = true;
  // What arrived live and no stored state followed (a turn cancelled while
  // it streamed) stays as it is.
  settle(w);
  const message = isObject(ev.error) ? asText(ev.error.message) : undefined;
  if (ev.state === 'error') notice(w, ev, NOTICES.error, message ? { message } : undefined);
  else if ((NOTABLE_STOPS as readonly unknown[]).includes(ev.stopReason)) notice(w, ev, STOPPED, { stopReason: ev.stopReason });
}

/** A permission the agent asks for, at the place it asked; a subagent's
 * too (its parent named): the user answers it here. */
function permission(w: Work, ev: ChatEvent) {
  const request = nonEmpty(ev.id);
  if (request === undefined) return unknown(w);
  const id = `permission:${request}`;
  const raw: Record<string, unknown> = isObject(ev.toolCall) ? ev.toolCall : {};
  const callId = nonEmpty(raw.toolCallId) ?? request;
  const call = applyTool(
    undefined,
    toolItemId(callId),
    { ...(raw as object), toolCallId: callId, sessionUpdate: 'tool_call' } as ToolCall,
    false,
  );
  const kind = (PERMISSION_KINDS as readonly unknown[]).includes(ev.kind) ? (ev.kind as PermissionKind) : 'other';
  const options = Array.isArray(ev.options) ? ev.options.slice(0, MAX_LIST.options).flatMap((o) => readOption(o) ?? []) : [];
  const item: PermissionItem = { kind: 'permission', id, request, permission: kind, call, options };
  const parent = nonEmpty(ev.parent);
  if (parent) item.parent = parent;
  const i = indexOf(w.c, id);
  if (i === undefined) return add(w, withAt(item, ev.at));
  const prev = w.c.items[i];
  if (prev.kind !== 'permission') return unknown(w);
  put(w, i, { ...item, at: prev.at, ...(prev.outcome ? { outcome: prev.outcome, by: prev.by } : {}) });
}

function permissionDone(w: Work, ev: ChatEvent) {
  const request = nonEmpty(ev.id);
  if (request === undefined) return unknown(w);
  const i = indexOf(w.c, `permission:${request}`);
  // One asked before the events taken: nothing to show it on.
  if (i === undefined) return;
  const prev = w.c.items[i];
  if (prev.kind !== 'permission') return unknown(w);
  const o: Record<string, unknown> = isObject(ev.outcome) ? ev.outcome : {};
  const outcome: PermissionOutcome =
    o.outcome === 'selected' && nonEmpty(o.optionId) ? { outcome: 'selected', optionId: o.optionId as string } : { outcome: 'cancelled' };
  put(w, i, { ...prev, outcome, by: asText(ev.by) || 'user' });
}

function question(w: Work, ev: ChatEvent) {
  const request = nonEmpty(ev.id);
  const seen = new Set<string>();
  // Questions by id: one whose id an earlier one has is passed over.
  const questions = Array.isArray(ev.questions)
    ? ev.questions.slice(0, MAX_LIST.questions).flatMap((x) => {
        const q = readQuestion(x);
        if (!q || seen.has(q.id)) return [];
        seen.add(q.id);
        return [q];
      })
    : [];
  if (request === undefined || !questions.length) return unknown(w);
  const id = `question:${request}`;
  const item: QuestionItem = { kind: 'question', id, request, questions };
  const parent = nonEmpty(ev.parent);
  if (parent) item.parent = parent;
  const i = indexOf(w.c, id);
  if (i === undefined) return add(w, withAt(item, ev.at));
  const prev = w.c.items[i];
  if (prev.kind !== 'question') return unknown(w);
  put(w, i, { ...prev, questions });
}

function questionDone(w: Work, ev: ChatEvent) {
  const request = nonEmpty(ev.id);
  if (request === undefined) return unknown(w);
  const i = indexOf(w.c, `question:${request}`);
  if (i === undefined) return;
  const prev = w.c.items[i];
  if (prev.kind !== 'question') return unknown(w);
  const next: QuestionItem = { ...prev, done: true, by: asText(ev.by) || 'user' };
  const answers = readAnswers(ev.answers);
  if (answers) next.answers = answers;
  else delete next.answers;
  put(w, i, next);
}

/** The chat as it is now. */
function info(w: Work, ev: ChatEvent) {
  const chat = readChat(ev.chat);
  if (!chat) return unknown(w);
  const c = w.c;
  c.chat = chat;
  if (chat.title) c.title = chat.title;
  if (chat.state) {
    c.state = chat.state;
    if (chat.error) c.stateError = chat.error;
    else delete c.stateError;
  }
  if (chat.usage) c.usage = chat.usage;
  w.changed = true;
}

/** The chat's state; a chat that failed tells why where it did. */
function state(w: Work, ev: ChatEvent) {
  const s = nonEmpty(ev.state);
  if (s === undefined) return unknown(w);
  const c = w.c;
  const error = readError(ev.error);
  const was = c.state;
  c.state = s;
  if (error) c.stateError = error;
  else delete c.stateError;
  if (s !== 'working') delete c.activity;
  w.changed = true;
  if (s === 'failed' && was !== 'failed') notice(w, ev, NOTICES.error, error?.message ? { message: error.message } : undefined);
}

/** A notice: compacting is what the agent does, the others are items. */
function noticeEvent(w: Work, ev: ChatEvent) {
  if (ev.method === CHAT_NOTICES.compacting) {
    w.c.activity = 'compacting';
    w.changed = true;
    return;
  }
  if (typeof ev.method === 'string' && NOTICE_METHODS.includes(ev.method)) {
    if (ev.method === NOTICES.compacted) delete w.c.activity;
    const key = ev.live === true ? undefined : nonEmpty(ev.item);
    if (key !== undefined && noticeForItem(w, ev, key, ev.method)) return;
    return notice(w, ev, ev.method, ev.params);
  }
  unknown(w);
}

/** Whether a conversation, or a subagent's in it, has items that took live
 * increments. */
function hasLive(c: Conversation): boolean {
  if (c.live && Object.keys(c.live).length) return true;
  return c.items.some((it) => it.kind === 'tool' && !!it.sub && hasLive(it.sub));
}

/** The conversation without what only arrived live: an item with no stored
 * state goes, one with a stored state goes back to it (its subagent's
 * conversation without what arrived live there). */
export function withoutLive(c: Conversation): Conversation {
  if (!hasLive(c)) return c;
  const live = c.live ?? {};
  const list: Item[] = [];
  let turnStart = c.turnStart;
  let head = c.head;
  for (let k = 0; k < c.items.length; k++) {
    let it = c.items[k];
    if (Object.hasOwn(live, it.id)) {
      const base = live[it.id];
      if (base === null) {
        if (c.turnStart !== undefined && k < c.turnStart) turnStart = (turnStart ?? 0) - 1;
        if (c.head !== undefined && k < c.head) head = (head ?? 0) - 1;
        continue;
      }
      it = it.kind === 'tool' && base.kind === 'tool' && it.sub ? { ...base, sub: it.sub } : base;
    }
    if (it.kind === 'tool' && it.sub && hasLive(it.sub)) it = { ...it, sub: withoutLive(it.sub) };
    list.push(it);
  }
  const out: Conversation = { ...c, items: list, byId: indexOfList(list) };
  delete out.live;
  if (turnStart !== undefined) out.turnStart = turnStart;
  if (head !== undefined) out.head = head;
  if (out.plan !== undefined && indexOf(out, out.plan) === undefined) delete out.plan;
  return out;
}

/** The work of the subagent's conversation that a tool call runs (call:
 * the call's item id, toolItemId). */
function subWork(w: Work, call: string): Work | undefined {
  const cached = w.subs?.get(call);
  if (cached) return cached;
  const c = w.c;
  let i = indexOf(c, call);
  if (i === undefined) {
    // A call of a subagent's own (deeper): its subagent's work takes it.
    for (const it of c.items) {
      if (it.kind !== 'tool' || !(it.sub || w.subs?.has(it.id))) continue;
      const sw = w.subs?.get(it.id);
      if (sw ? runs(sw.c, call) : runs(it.sub!, call)) return subWork(w, it.id);
    }
    // A call not seen yet: its item, to put the subagent's under.
    add(w, { kind: 'tool', id: call, title: '', toolKind: 'think', status: 'in_progress', content: [], locations: [] });
    i = c.items.length - 1;
  }
  const it = c.items[i];
  if (it.kind !== 'tool') return undefined;
  const sw = work(it.sub ?? emptyConversation());
  (w.subs ??= new Map()).set(call, sw);
  return sw;
}

/** Whether a conversation has the tool call's item (id: toolItemId), or a
 * subagent's in it does. */
function runs(c: Conversation, id: string): boolean {
  if (indexOf(c, id) !== undefined) return true;
  return c.items.some((it) => it.kind === 'tool' && !!it.sub && runs(it.sub, id));
}

/** Puts the subagents' conversations a batch changed into their calls. */
function flush(w: Work) {
  if (!w.subs) return;
  for (const [call, sw] of w.subs) {
    flush(sw);
    if (!sw.changed) continue;
    const i = indexOf(w.c, call);
    const it = i === undefined ? undefined : w.c.items[i];
    if (i !== undefined && it?.kind === 'tool') put(w, i, { ...it, sub: sw.c });
  }
  delete w.subs;
}

/** An event of a subagent (one with a parent): into the conversation of
 * the call that runs it; a deeper subagent's goes on down from there. */
function nested(w: Work, ev: ChatEvent, parent: string) {
  const call = toolItemId(parent);
  const sw = subWork(w, call);
  if (!sw) return unknown(w);
  // A deeper subagent's event keeps its parent; the subagent's own drops it.
  const own = indexOf(w.c, call) !== undefined;
  const inner: ChatEvent = { ...ev };
  if (own) delete inner.parent;
  step(sw, inner);
  if (sw.changed) w.changed = true;
}

/** The types of events whose items a subagent's conversation holds. */
const NESTED: ReadonlySet<string> = new Set(['update', 'user', 'turn', 'notice']);

function step(w: Work, ev: SourceEvent) {
  if (!isObject(ev)) return unknown(w);
  if (ev.t === 'reset') {
    w.c = emptyConversation();
    delete w.subs;
    w.own = true;
    w.ownLive = false;
    w.changed = true;
    return;
  }
  if (ev.t === 'reattach') {
    flush(w);
    const next = withoutLive(w.c);
    if (next !== w.c) {
      w.c = next;
      w.own = true;
      // No overlay: a live event after it in the batch makes one.
      w.ownLive = false;
      w.changed = true;
    }
    return;
  }
  const c = w.c;
  if (typeof ev.seq === 'number' && ev.live !== true) {
    if (c.last !== undefined && ev.seq <= c.last) return;
    c.last = ev.seq;
    c.first ??= ev.seq;
    w.changed = true;
  }
  const parent = nonEmpty(ev.parent);
  if (parent !== undefined && NESTED.has(ev.t)) return nested(w, ev, parent);
  switch (ev.t) {
    case 'update':
      return update(w, ev);
    case 'user':
      return user(w, ev);
    case 'turn':
      return turn(w, ev);
    case 'notice':
      return noticeEvent(w, ev);
    case 'permission':
      return permission(w, ev);
    case 'permission_done':
      return permissionDone(w, ev);
    case 'question':
      return question(w, ev);
    case 'question_done':
      return questionDone(w, ev);
    case 'queued':
      return queued(w, ev);
    case 'info':
      return info(w, ev);
    case 'state':
      return state(w, ev);
    case 'ack':
      // A command's answer: the source's to take.
      return;
    default:
      return unknown(w);
  }
}

/** The conversation after events, in their order. A stored event whose seq
 * is not above the highest one taken was taken already (a page fetched
 * again) and is passed over; a live one (live) adds to its item until a
 * stored one for the item gives it whole, or the turn ends. Shown are the user's prompts, the
 * agent's messages and thoughts (chunks of one message joined), tool calls
 * (by their id; a subagent's items in the conversation of the call that
 * runs it), the turn's plan, permissions and questions with their answers,
 * notices; kept are the context's usage, the session's title, the chat's
 * state and what it states, and the messages queued. Events and updates of
 * other kinds count as unknown. The list is copied once, and an event costs
 * only the item it changes. */
export function reduceAll(state: Conversation, events: readonly SourceEvent[]): Conversation {
  const w = work(state);
  for (const ev of events) step(w, ev);
  flush(w);
  return w.changed ? w.c : state;
}

/** The conversation after an event (reduceAll). */
export function reduce(state: Conversation, ev: SourceEvent): Conversation {
  return reduceAll(state, [ev]);
}

/** An item of a later page merged into the same item of an earlier one. */
function merge(a: Item, b: Item): Item {
  if (a.kind === 'tool' && b.kind === 'tool') {
    // Members b does not have stay a's: b was made by updates.
    const out: ToolItem = { ...a, ...b, title: b.title || a.title };
    if (!b.content.length) out.content = a.content;
    if (!b.locations.length) out.locations = a.locations;
    if (a.meta || b.meta) out.meta = { ...a.meta, ...b.meta };
    if (a.sub && b.sub) out.sub = join(a.sub, b.sub);
    else if (a.sub) out.sub = a.sub;
    if (a.at) out.at = a.at;
    return out;
  }
  if ((a.kind === 'message' && b.kind === 'message' && a.role === b.role) || (a.kind === 'thought' && b.kind === 'thought'))
    return { ...a, content: concat(a.content, b.content) };
  return b;
}

const continues = (a: Item | undefined, b: Item): a is MessageItem | ThoughtItem =>
  !!a && ((a.kind === 'message' && b.kind === 'message' && a.role === b.role) || (a.kind === 'thought' && b.kind === 'thought'));

/** The items of an earlier conversation e followed by those of s, as if s's
 * events had followed e's: an item of an id e has goes into e's, the
 * chunk s began without a message id continues e's last message, and what
 * s has before its first turn's start (a plan, the prompt again) belongs to
 * e's last turn. What the chat states is s's, else e's; the messages
 * waiting are e's that s did not take or withdraw, then s's; an item s took
 * live has e's part in the stored state a reattach goes back to. */
function join(e: Conversation, s: Conversation): Conversation {
  const list = e.items.slice();
  const byId: Record<string, number> = Object.create(null);
  for (let i = 0; i < list.length; i++) byId[list[i].id] = i;
  const at = (id: string) => (Object.hasOwn(byId, id) ? byId[id] : undefined);
  const headEnd = s.head ?? s.items.length;
  let turnStart = s.turnStart === undefined ? e.turnStart : undefined;
  let head: number | undefined;
  for (let k = 0; k <= s.items.length; k++) {
    if (k === s.turnStart) turnStart = list.length;
    if (k === s.head) head = list.length;
    if (k === s.items.length) break;
    const it = s.items[k];
    const last = list[list.length - 1];
    const same = at(it.id);
    if (same !== undefined) {
      list[same] = merge(list[same], it);
      continue;
    }
    if (k === 0 && s.open && continues(last, it)) {
      list[list.length - 1] = merge(last, it);
      continue;
    }
    const p = e.plan === undefined ? undefined : at(e.plan);
    const plan = p === undefined ? undefined : list[p];
    if (k < headEnd && it.kind === 'plan' && p !== undefined && plan?.kind === 'plan') {
      list[p] = { ...plan, entries: it.entries };
      continue;
    }
    if (
      k === 0 &&
      headEnd > 0 &&
      isUserMessage(it) &&
      isUserMessage(last) &&
      list.length - 1 >= (e.turnStart ?? 0) &&
      sameText(last, it.content)
    )
      continue;
    byId[it.id] = list.length;
    list.push(it);
  }
  served.set(byId, list.length);
  const out: Conversation = { items: list, byId, turn: s.turnSeen ? s.turn : e.turn, unknown: e.unknown + s.unknown };
  const usage = s.usage ?? e.usage;
  if (usage) out.usage = usage;
  const title = s.title ?? e.title;
  if (title) out.title = title;
  const chat = s.chat ?? e.chat;
  if (chat) out.chat = chat;
  const st = s.state !== undefined ? s : e;
  if (st.state !== undefined) out.state = st.state;
  if (st.stateError) out.stateError = st.stateError;
  if (s.queued || e.queued) {
    // The earlier page's waiting messages that the later one did not take,
    // withdraw or have waiting itself come first.
    const gone = new Set([...(s.dequeued ?? []), ...(s.queued ?? []).map((q) => q.message)]);
    out.queued = [...(e.queued ?? []).filter((q) => !gone.has(q.message)), ...(s.queued ?? [])].slice(-MAX_LIST.queued);
  }
  if (e.dequeued || s.dequeued) out.dequeued = [...new Set([...(e.dequeued ?? []), ...(s.dequeued ?? [])])].slice(-MAX_LIST.queued);
  const activity = s.turnSeen ? s.activity : (s.activity ?? e.activity);
  if (activity) out.activity = activity;
  if (s.live) {
    // An item the earlier page has too: what it gave the item belongs to
    // the item's stored state, which a reattach goes back to.
    const live: Record<string, Item | null> = Object.create(null);
    for (const id of Object.keys(s.live)) {
      const i = indexOf(e, id);
      const base = s.live[id];
      live[id] = i === undefined ? base : base === null ? e.items[i] : merge(e.items[i], base);
    }
    out.live = live;
  }
  const first = e.first ?? s.first;
  if (first !== undefined) out.first = first;
  const lastSeq = s.last ?? e.last;
  if (lastSeq !== undefined) out.last = lastSeq;
  if (turnStart !== undefined) out.turnStart = turnStart;
  const h = e.head ?? head;
  if (h !== undefined) out.head = h;
  if (e.turnSeen || s.turnSeen) out.turnSeen = true;
  const plan = s.head !== undefined || (s.plan !== undefined && at(s.plan) !== undefined) ? s.plan : e.plan;
  if (plan !== undefined) out.plan = plan;
  if (e.items.length ? e.open : s.open) out.open = true;
  return out;
}

/** Whether an event is a stored one of an earlier page: not live, not a
 * source's own. */
const earlier = (ev: SourceEvent, first: number | undefined) =>
  isObject(ev) &&
  ev.t !== 'reset' &&
  ev.t !== 'reattach' &&
  ev.live !== true &&
  (first === undefined || typeof ev.seq !== 'number' || ev.seq < first);

/** The conversation with a page of earlier events (loadEarlier) before its
 * items, taken with the same rules as if they had come first; those not
 * below the lowest seq taken are passed over. */
export function prepend(state: Conversation, events: readonly SourceEvent[]): Conversation {
  const first = state.first;
  const older = events.filter((ev) => earlier(ev, first));
  if (!older.length) return state;
  const e = reduceAll(emptyConversation(), older);
  return !e.items.length && !e.unknown && e.first === undefined ? state : join(e, state);
}

/** The conversation after a batch of a source's events, as the view takes
 * them: stored events below the lowest seq taken (a page loadEarlier gave)
 * go before the items (prepend), the others after them (reduceAll). */
export function take(state: Conversation, events: readonly SourceEvent[]): Conversation {
  let c = state;
  let lowest = c.first;
  let run: SourceEvent[] = [];
  let older: SourceEvent[] = [];
  for (const ev of events) {
    if (!isObject(ev)) continue;
    if (ev.t === 'reset') {
      c = emptyConversation();
      lowest = undefined;
      run = [];
      older = [];
      continue;
    }
    const stored = ev.t !== 'reattach' && ev.live !== true && typeof ev.seq === 'number';
    if (stored && lowest !== undefined && ev.seq! < lowest) older.push(ev);
    else {
      if (stored) lowest ??= ev.seq;
      run.push(ev);
    }
  }
  if (run.length) c = reduceAll(c, run);
  if (older.length) c = prepend(c, older);
  return c;
}

/** The permissions and questions of the current turn that wait for the
 * user (their items' ids, in order): one of an earlier turn no longer
 * waits, whether or not its answer was taken. */
export function waitingItems(c: Conversation): string[] {
  const out: string[] = [];
  for (let i = c.turnStart ?? 0; i < c.items.length; i++) {
    const it = c.items[i];
    if ((it.kind === 'permission' && !it.outcome) || (it.kind === 'question' && !it.done)) out.push(it.id);
  }
  return out;
}
