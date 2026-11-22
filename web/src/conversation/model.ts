// A coding agent's conversation as the native view shows it, independent of
// where it comes from (source.ts): the events of a session as an event log
// (each with its place, seq, and its type, t), their updates under the
// member names of the Agent Client Protocol's (ACP v1) session/update, and
// the state they reduce to. A transcript read on a machine (internal/
// agentproto TranscriptEvent) gives the types update, user, turn and
// notice; the others are an ACP client's. Events come from a machine and
// are not trusted to have the shapes declared here: the reducer checks the
// type of every member it keeps, and the view reads text through asText.
import { APP_SLUG } from '../brand';

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
 * transcripts and an ACP client alike; the others from an ACP client
 * only. */
export type ChatEventType = 'update' | 'user' | 'turn' | 'notice' | 'state' | 'permission' | 'permission_done' | 'info' | 'ack';

/** Why something failed, by its code. */
export interface ChatError {
  code: string;
  message: string;
  stderr?: string;
}

/** An event of a conversation. */
export interface ChatEvent {
  /** Its place in the conversation; a transcript's is its line's byte
   * offset shifted left by 8 plus its index in the line. None for an ack. */
  seq?: number;
  t: ChatEventType;
  /** RFC 3339. */
  at?: string;
  /** The permission's (permission, permission_done) or the command's (ack). */
  id?: string;
  /** update */
  update?: SessionUpdate;
  /** user: the prompt's content blocks. */
  content?: ContentBlock[];
  /** turn: start, end or error; state: the chat's. */
  state?: string;
  stopReason?: StopReason | string;
  error?: ChatError;
  /** permission: what is asked about and the answers to choose from. */
  toolCall?: Omit<ToolCallUpdate, 'sessionUpdate'>;
  options?: PermissionOption[];
  /** permission_done: how it was answered, and by whom. */
  outcome?: PermissionOutcome;
  by?: string;
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
export type SourceEvent = ChatEvent | ResetEvent;

/** The method of a notice: an ACP extension method, `_<slug>/<name>`
 * (agentproto.NoticeMethod). */
export const noticeMethod = (name: string): string => `_${APP_SLUG}/${name}`;

/** The notices of a transcript, by name. */
export const NOTICES = {
  compacted: noticeMethod('compacted'),
  cleared: noticeMethod('cleared'),
  command: noticeMethod('command'),
  error: noticeMethod('error'),
  model: noticeMethod('model'),
  /** A line of the transcript too long to read was passed over. */
  skipped: noticeMethod('skipped'),
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
  at?: string;
}
export interface ThoughtItem {
  kind: 'thought';
  id: string;
  content: ContentBlock[];
  at?: string;
}
export interface ToolItem {
  kind: 'tool';
  /** The tool call's id. */
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
/** What the view shows, in order; an item is replaced by one of its id. */
export type Item = MessageItem | ThoughtItem | ToolItem | PlanItem | NoticeItem;

/** The context window and cost (usage_update); size 0 while it is not
 * known. */
export interface Usage {
  used: number;
  size: number;
  cost?: Cost;
}

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

const isCost = (c: unknown): c is Cost => isObject(c) && typeof c.amount === 'number' && typeof c.currency === 'string';

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

function indexOf(c: Conversation, id: string): number | undefined {
  const i = Object.hasOwn(c.byId, id) ? c.byId[id] : undefined;
  return typeof i === 'number' && i < c.items.length && c.items[i]?.id === id ? i : undefined;
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
  base: Conversation;
  c: Conversation;
  /** c.items is the work's own copy. */
  own: boolean;
  changed: boolean;
}

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

/** The members a value has under the product's slug in its `_meta` (ACP's
 * member for extensions): a block's or a tool call's marks. */
export function ownMeta(x: unknown): Record<string, unknown> | undefined {
  const meta = isObject(x) ? x._meta : undefined;
  const own = isObject(meta) ? meta[APP_SLUG] : undefined;
  return isObject(own) ? own : undefined;
}

const withAt = <T extends Item>(item: T, at: unknown): T => (typeof at === 'string' && at ? { ...item, at } : item);

/** A chunk of a message or a thought: added to its message (by messageId),
 * else to the last item when that is the same kind of message, else as a
 * new item. */
function chunk(w: Work, ev: ChatEvent, u: MessageChunk) {
  if (!isBlock(u.content)) return unknown(w);
  const c = w.c;
  const kind = u.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'message';
  const role = u.sessionUpdate === 'user_message_chunk' ? 'user' : 'agent';
  const same = (it: Item | undefined): it is MessageItem | ThoughtItem =>
    !!it && it.kind === kind && (it.kind === 'thought' || it.role === role);
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
  const block = marked(u.content, (u as { _meta?: unknown })._meta);
  const prev = i === undefined ? undefined : c.items[i];
  if (i !== undefined && same(prev)) {
    put(w, i, withAt({ ...prev, content: appendBlock(prev.content, block) }, prev.at ?? ev.at));
    return;
  }
  if (!c.items.length && !byMessage) c.open = true;
  add(w, withAt(kind === 'thought' ? { kind, id, content: [block] } : { kind, id, role, content: [block] }, ev.at));
}

/** A tool call, or an update of one: present members replace the item's (a
 * call for an id an update made first does not take a settled status
 * back); an update of a call not seen yet makes its item. */
function tool(w: Work, ev: ChatEvent, u: ToolCall | ToolCallUpdate) {
  if (typeof u.toolCallId !== 'string' || u.toolCallId === '') return unknown(w);
  const c = w.c;
  const i = indexOf(c, u.toolCallId);
  const prev = i === undefined ? undefined : c.items[i];
  if (prev && prev.kind !== 'tool') return unknown(w);
  const call = u.sessionUpdate === 'tool_call';
  const next: ToolItem = prev ? { ...prev } : { kind: 'tool', id: u.toolCallId, title: '', content: [], locations: [] };
  if (typeof u.title === 'string' && (u.title || !prev)) next.title = u.title;
  if (isToolKind(u.kind)) next.toolKind = u.kind;
  if (isToolStatus(u.status) && !(call && prev && settled(prev.status))) next.status = u.status;
  if (Array.isArray(u.content)) {
    const content = u.content.filter(isToolContent);
    if (!call || content.length || !prev) next.content = content;
  }
  if (Array.isArray(u.locations)) {
    const locations = u.locations.filter(isLocation);
    if (!call || locations.length || !prev) next.locations = locations;
  }
  if (u.rawInput !== undefined) next.rawInput = u.rawInput;
  if (u.rawOutput !== undefined) next.rawOutput = u.rawOutput;
  const meta = (u as { _meta?: unknown })._meta;
  if (isObject(meta)) next.meta = { ...prev?.meta, ...meta };
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

function usage(w: Work, u: UsageUpdate) {
  if (typeof u.used !== 'number' || !Number.isFinite(u.used) || u.used < 0) return unknown(w);
  const c = w.c;
  const size = typeof u.size === 'number' && Number.isFinite(u.size) && u.size > 0 ? u.size : (c.usage?.size ?? 0);
  const cost = isCost(u.cost) ? u.cost : u.cost === null ? undefined : c.usage?.cost;
  c.usage = cost ? { used: u.used, size, cost } : { used: u.used, size };
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
  // Known kinds the view has nothing to show for.
  if (isUpdate(u, 'available_commands_update') || isUpdate(u, 'current_mode_update') || isUpdate(u, 'config_option_update')) return;
  unknown(w);
}

const isUserMessage = (it: Item | undefined): it is MessageItem => it?.kind === 'message' && it.role === 'user';
const sameText = (a: MessageItem, b: readonly ContentBlock[]) => a.content.length === b.length && blocksText(a.content) === blocksText(b);

/** A prompt of the user; the same text again in the same turn, right after
 * it, is the same prompt. */
function user(w: Work, ev: ChatEvent) {
  const c = w.c;
  const content = (Array.isArray(ev.content) ? ev.content : []).filter(isBlock);
  const last = c.items.length - 1;
  const prev = c.items[last];
  if (isUserMessage(prev) && last >= (c.turnStart ?? 0) && sameText(prev, content)) return;
  add(w, withAt({ kind: 'message', id: fresh(c, `message:user:${ev.seq ?? c.items.length}`), role: 'user', content }, ev.at));
}

function notice(w: Work, ev: ChatEvent, method: string, params: unknown) {
  const item: NoticeItem = { kind: 'notice', id: fresh(w.c, `notice:${ev.seq ?? w.c.items.length}`), method };
  add(w, withAt(params === undefined ? item : { ...item, params }, ev.at));
}

const NOTICE_METHODS: readonly string[] = [...Object.values(NOTICES), STOPPED];

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
  w.changed = true;
  const message = isObject(ev.error) ? asText(ev.error.message) : undefined;
  if (ev.state === 'error') notice(w, ev, NOTICES.error, message ? { message } : undefined);
  else if ((NOTABLE_STOPS as readonly unknown[]).includes(ev.stopReason)) notice(w, ev, STOPPED, { stopReason: ev.stopReason });
}

function step(w: Work, ev: SourceEvent) {
  if (!isObject(ev)) return unknown(w);
  if (ev.t === 'reset') {
    w.c = emptyConversation();
    w.own = true;
    w.changed = true;
    return;
  }
  const c = w.c;
  if (typeof ev.seq === 'number') {
    if (c.last !== undefined && ev.seq <= c.last) return;
    c.last = ev.seq;
    c.first ??= ev.seq;
    w.changed = true;
  }
  switch (ev.t) {
    case 'update':
      return update(w, ev);
    case 'user':
      return user(w, ev);
    case 'turn':
      return turn(w, ev);
    case 'notice':
      if (typeof ev.method === 'string' && NOTICE_METHODS.includes(ev.method)) return notice(w, ev, ev.method, ev.params);
      return unknown(w);
    case 'state':
    case 'permission':
    case 'permission_done':
    case 'info':
    case 'ack':
      // An ACP client's, which the view does not show.
      return;
    default:
      return unknown(w);
  }
}

/** The conversation after events, in their order. An event whose seq is
 * not above the highest one taken was taken already (a page fetched again)
 * and is passed over. Shown are the user's prompts, the agent's messages
 * and thoughts (chunks of one message joined), tool calls (by their id),
 * the turn's plan, notices, the context's usage and the session's title;
 * events and updates of other kinds count as unknown. The list is copied
 * once, and an event costs only the item it changes. */
export function reduceAll(state: Conversation, events: readonly SourceEvent[]): Conversation {
  const w: Work = { base: state, c: { ...state }, own: false, changed: false };
  for (const ev of events) step(w, ev);
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
 * e's last turn. */
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

/** The conversation with a page of earlier events (loadEarlier) before its
 * items, taken with the same rules as if they had come first; those not
 * below the lowest seq taken are passed over. */
export function prepend(state: Conversation, events: readonly SourceEvent[]): Conversation {
  const first = state.first;
  const older = events.filter(
    (ev) => isObject(ev) && ev.t !== 'reset' && (first === undefined || typeof ev.seq !== 'number' || ev.seq < first),
  );
  if (!older.length) return state;
  const e = reduceAll(emptyConversation(), older);
  return !e.items.length && !e.unknown && e.first === undefined ? state : join(e, state);
}

/** The conversation after a batch of a source's events, as the view takes
 * them: events below the lowest seq taken (a page loadEarlier gave) go
 * before the items (prepend), the others after them (reduceAll). */
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
    if (typeof ev.seq === 'number' && lowest !== undefined && ev.seq < lowest) older.push(ev);
    else {
      if (typeof ev.seq === 'number') lowest ??= ev.seq;
      run.push(ev);
    }
  }
  if (run.length) c = reduceAll(c, run);
  if (older.length) c = prepend(c, older);
  return c;
}
