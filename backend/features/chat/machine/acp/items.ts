// An agent's session updates of a conversation's content as chatproto
// events, by item: a message or a thought streams as live events (its chunks
// as they came, each an increment of its text), and is stored whole, in one
// content block, once it ends (another kind of update comes, or the turn
// ends); a tool call (its item is its toolCallId) is stored whole whenever
// it changes but for its content and output. While it runs, text its
// content gains goes live as tool_call_updates of the text added, which the
// clients append (an ACP update replaces the content: an agent sends the
// whole of it each time); content that changes otherwise is stored at once;
// what changed live is stored once more at the turn's end. A plan is stored
// as it comes, a whole each time. Without live, nothing streams: an import
// stores each item once it ended.
import type * as chat from '#shared/proto/chatproto/index.ts';
import { isObj, present, str, type Obj } from './state.ts';

// The session updates of a conversation's content.
export const UPDATE_MESSAGE = 'agent_message_chunk';
export const UPDATE_THOUGHT = 'agent_thought_chunk';
export const UPDATE_USER = 'user_message_chunk';
export const UPDATE_TOOL_CALL = 'tool_call';
export const UPDATE_TOOL = 'tool_call_update';
export const UPDATE_PLAN = 'plan';

// The session updates of a session's state, which the chat states.
export const UPDATE_COMMANDS = 'available_commands_update';
export const UPDATE_MODE = 'current_mode_update';
export const UPDATE_CONFIG = 'config_option_update';
export const UPDATE_INFO = 'session_info_update';
export const UPDATE_USAGE = 'usage_update';

/** Whether a session update is of the conversation's content. */
export const contentUpdate = (kind: string): boolean =>
  kind === UPDATE_MESSAGE ||
  kind === UPDATE_THOUGHT ||
  kind === UPDATE_USER ||
  kind === UPDATE_TOOL_CALL ||
  kind === UPDATE_TOOL ||
  kind === UPDATE_PLAN;

/** The most text a stored message event holds, in bytes: a longer message
 * goes on in an item of its own, so that each fits MAX_EVENT once its text
 * is escaped as JSON. */
export const SPLIT_BYTES = 128 << 10;
/** The most tool calls of a turn whose state is kept; the updates of more
 * are stored as they come. */
export const MAX_TOOLS = 4096;

/** Where items puts an event: tool is the tool call's id for a tool call's
 * whole state (an import keeps one per call), "" otherwise. */
export type Store = (ev: chat.Event, tool: string) => void;

/** A message or a thought being streamed. */
interface Message {
  kind: string;
  messageId: string;
  item: string;
  text: string;
  bytes: number;
  /** A user message's content blocks: in a replay, each chunk of a user's
   * message is a block of it. */
  blocks: unknown[];
}

/** What a tool call stated so far. */
interface ToolState {
  /** Its members, as the agent sent them. */
  fields: Map<string, unknown>;
  /** Changed live since it was last stored. */
  dirty: boolean;
  /** The text of the call's content the clients have: as last stored,
   * with the live increments since. */
  shown: string;
}

const SHORT_KIND: Record<string, string> = { [UPDATE_MESSAGE]: 'm', [UPDATE_THOUGHT]: 't', [UPDATE_USER]: 'u' };

/** The members of a tool call that change while it runs: an update that
 * changes no other goes live. */
const STREAMED = new Set(['content', 'rawOutput', '_meta']);

/** What agents add to a user's message for the model (Kimi Code's replays
 * hold it): it is no part of what the user wrote. */
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** The text of a replayed user message without what the agent added to it. */
export const userText = (s: string): string => s.replace(REMINDER, '').trim();

/** A JSON value's text, to tell whether two values differ. */
const text = (v: unknown): string => JSON.stringify(v) ?? '';

export class Items {
  /** Starts the ids of the items it makes, unique among a chat's. */
  private readonly prefix: string;
  private readonly live: boolean;
  private readonly store: Store;
  /** Takes a user message that ended, for an import; undefined drops user
   * messages (the host states a chat's own prompts). */
  user?: (content: unknown[]) => void;

  private n = 0;
  private msg: Message | null = null;
  private tools = new Map<string, ToolState>();
  /** The tool calls by their first update. */
  private order: string[] = [];
  /** The item of the turn's plan. */
  private plan = '';
  private readonly used = new Map<string, number>();

  constructor(prefix: string, live: boolean, store: Store) {
    this.prefix = prefix;
    this.live = live;
    this.store = store;
  }

  /** The tool calls of the turn (tests). */
  get toolCount(): number {
    return this.tools.size;
  }

  /** A new item id: by the agent's id of the message when it gave one
   * ("m-<id>", the same in a chat and in an import of its session, so that
   * HistoryParams.after finds it), else by count after the prefix (a chat's
   * is random for each process, an import's "h"; an agent without ids, as
   * Kimi Code and Grok, leaves no item of a chat that an import has). */
  private fresh(short: string, id: string): string {
    if (id === '') return `${this.prefix}-${short}-${++this.n}`;
    const base = `${short}-${id}`;
    const k = this.used.get(base) ?? 0;
    this.used.set(base, k + 1);
    return k === 0 ? base : `${base}~${k + 1}`;
  }

  /** Takes one session update of the conversation's content. */
  update(kind: string, raw: Obj): void {
    switch (kind) {
      case UPDATE_MESSAGE:
      case UPDATE_THOUGHT:
      case UPDATE_USER:
        return this.chunk(kind, raw);
      case UPDATE_TOOL_CALL:
      case UPDATE_TOOL:
        return this.tool(kind, raw);
      case UPDATE_PLAN:
        this.close();
        if (this.plan === '') this.plan = this.fresh('p', '');
        this.store({ t: 'update', item: this.plan, update: raw }, '');
    }
  }

  private chunk(kind: string, raw: Obj): void {
    if (kind === UPDATE_USER && !this.user) return;
    const content = raw.content;
    const id = str(raw.messageId);
    if (!isObj(content) || id === undefined || str(content.type) === undefined || str(content.text) === undefined) return;
    const type = str(content.type)!;
    const t = str(content.text)!;
    const m0 = this.msg;
    if (m0 && (m0.kind !== kind || m0.messageId !== id)) this.close();
    if (kind === UPDATE_USER) {
      const m = this.open(kind, id);
      if (type !== 'text') m.blocks.push(content);
      else if (userText(t) !== '') m.blocks.push({ type: 'text', text: userText(t) });
      return;
    }
    if (type !== 'text') {
      // An image or a resource of the agent's: an item of its own.
      this.close();
      this.store({ t: 'update', item: this.fresh(SHORT_KIND[kind]!, ''), update: raw }, '');
      return;
    }
    if (t === '') return;
    const m = this.open(kind, id);
    m.text += t;
    m.bytes += Buffer.byteLength(t);
    if (this.live) this.store({ t: 'update', live: true, item: m.item, update: raw }, '');
    if (m.bytes >= SPLIT_BYTES) this.close();
  }

  /** The message being streamed, a new one of kind when there is none. */
  private open(kind: string, id: string): Message {
    this.msg ??= { kind, messageId: id, item: this.fresh(SHORT_KIND[kind]!, id), text: '', bytes: 0, blocks: [] };
    return this.msg;
  }

  /** Ends the message being streamed, storing it whole. */
  close(): void {
    const m = this.msg;
    if (!m) return;
    this.msg = null;
    if (m.kind === UPDATE_USER) {
      this.user?.(m.blocks);
      return;
    }
    if (m.text === '') return;
    const update: Obj = { sessionUpdate: m.kind, content: { type: 'text', text: m.text } };
    if (m.messageId !== '') update.messageId = m.messageId;
    this.store({ t: 'update', item: m.item, update }, '');
  }

  private tool(kind: string, raw: Obj): void {
    const id = str(raw.toolCallId);
    const status = str(raw.status);
    if (!id || status === undefined) return;
    this.close();
    let t = this.tools.get(id);
    if (!t) {
      if (this.tools.size === MAX_TOOLS) {
        this.store({ t: 'update', item: id, update: raw }, '');
        return;
      }
      t = { fields: new Map(), dirty: false, shown: '' };
      this.tools.set(id, t);
      this.order.push(id);
    }
    const settled = status === 'completed' || status === 'failed' || status === 'cancelled';
    let changed = kind === UPDATE_TOOL_CALL || settled || t.fields.size === 0;
    // A tool_call states the call whole.
    if (kind === UPDATE_TOOL_CALL) t.fields = new Map();
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'sessionUpdate' || (k === 'status' && status === '')) continue;
      if (!STREAMED.has(k) && (!t.fields.has(k) || text(t.fields.get(k)) !== text(v))) changed = true;
      t.fields.set(k, v);
    }
    if (changed || !this.live) return this.storeTool(id, t);
    const [shown, ok] = contentText(t.fields.get('content'));
    if (!ok || !shown.startsWith(t.shown)) {
      // Not an increment of what the clients have.
      this.storeTool(id, t);
    } else if (shown === t.shown) {
      // The output, or nothing the clients show.
      t.dirty = true;
    } else {
      const inc = shown.slice(t.shown.length);
      t.shown = shown;
      t.dirty = true;
      const update = { sessionUpdate: UPDATE_TOOL, toolCallId: id, content: [{ type: 'content', content: { type: 'text', text: inc } }] };
      this.store({ t: 'update', live: true, item: id, update }, '');
    }
  }

  private storeTool(id: string, t: ToolState): void {
    t.dirty = false;
    t.shown = contentText(t.fields.get('content'))[0];
    this.store({ t: 'update', item: id, update: whole(t) }, id);
  }

  /** A permission's tool call with what the tool call's updates stated
   * before it: some agents send a request with little more than the call's
   * id (Kimi Code), others the diff only in an update (Grok). */
  toolCall(raw: unknown): unknown {
    if (!isObj(raw)) return raw;
    const id = str(raw.toolCallId);
    const t = id === undefined ? undefined : this.tools.get(id);
    if (!t) return raw;
    const m: Obj = {};
    for (const [k, v] of t.fields) m[k] = v;
    for (const [k, v] of Object.entries(raw)) m[k] = v;
    return m;
  }

  /** The kind a tool call stated, "" for none. */
  toolKind(id: string): string {
    const k = this.tools.get(id)?.fields.get('kind');
    return typeof k === 'string' ? k : '';
  }

  /** Stores live changes and cancels unfinished tools when a turn aborts. */
  endTurn(cancelPending?: (id: string) => boolean): void {
    this.close();
    for (const id of this.order) {
      const t = this.tools.get(id)!;
      const status = t.fields.get('status');
      if ((status === 'pending' || status === 'in_progress' || status === 'paused') && cancelPending?.(id)) {
        t.fields.set('status', 'cancelled');
        t.dirty = true;
      }
      if (t.dirty) this.storeTool(id, t);
    }
    this.tools = new Map();
    this.order = [];
    this.plan = '';
  }
}

/** The tool call's state as one tool_call update. */
function whole(t: ToolState): Obj {
  const m: Obj = {};
  for (const [k, v] of t.fields) m[k] = v;
  m.sessionUpdate = UPDATE_TOOL_CALL;
  return m;
}

/** The text of a tool call's content, its text blocks one after the
 * other; false for content with blocks of other kinds (a diff, a terminal,
 * an image). */
export function contentText(raw: unknown): [string, boolean] {
  if (!present(raw)) return ['', true];
  if (!Array.isArray(raw)) return ['', false];
  let out = '';
  for (const c of raw) {
    if (c !== null && !isObj(c)) return ['', false];
    if (!c || c.type !== 'content' || !isObj(c.content) || c.content.type !== 'text' || typeof c.content.text !== 'string')
      return ['', false];
    out += c.content.text;
  }
  return [out, true];
}
