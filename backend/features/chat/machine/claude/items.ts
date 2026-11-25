// The chat's events of Claude Code's messages: items, live increments,
// tool calls as the transcript's mapping makes them
// (#shared/agents/transcript, the one imports use too).
import { SLUG } from '#shared/lib/brand.ts';
import { claudeFrame, type Frame } from '#shared/agents/transcript/index.ts';
import type { TranscriptEvent } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The item of a message's content block. */
export const itemOf = (message: string, block: number): string => `${message}/${block}`;

/** What an update says of what it belongs to. */
export function headOf(u: unknown): { sessionUpdate: string; toolCallId: string } {
  const o = isObj(u) ? u : {};
  return { sessionUpdate: str(o.sessionUpdate), toolCallId: str(o.toolCallId) };
}

export const isChunk = (kind: string): boolean => kind === 'agent_message_chunk' || kind === 'agent_thought_chunk';

/** A transcript's event as the chat's, without its time. */
export function eventOf(ev: TranscriptEvent, parent = ''): chat.Event {
  const e: chat.Event = { t: ev.t as chat.EventType };
  if (ev.update !== undefined) e.update = ev.update;
  if (ev.content !== undefined) e.content = ev.content;
  if (ev.state) e.state = ev.state;
  if (ev.stopReason) e.stopReason = ev.stopReason;
  if (ev.method) e.method = ev.method;
  if (ev.params !== undefined) e.params = ev.params;
  if (parent) e.parent = parent;
  return e;
}

/** A streaming increment of an item. */
export function live(item: string, update: Obj): chat.Event {
  return { t: chat.EventType.Update, live: true, item, update };
}

/** The update's _meta member of the product's own. */
export const ownMeta = (kv: Obj): Obj => ({ [SLUG]: kv });

/** A copy of the update u with _meta.<slug>.key set to v. */
export function withMeta(u: unknown, key: string, v: unknown): unknown {
  if (!isObj(u)) return u;
  const meta = isObj(u._meta) ? { ...u._meta } : {};
  const own = isObj(meta[SLUG]) ? { ...(meta[SLUG] as Obj) } : {};
  own[key] = v;
  meta[SLUG] = own;
  return { ...u, _meta: meta };
}

/** The Frame of a message of Claude Code's protocol (the transcript's
 * mapping reads its lines). */
export const frameOf = (m: unknown): Frame => claudeFrame(JSON.stringify(m));

/** The ACP tool_call of a tool use, as the transcript's mapping makes it
 * (title, kind, the input, diffs of the change it makes); null for a tool
 * that is no tool call (TodoWrite's plan). */
export function toolCallUpdate(id: string, name: string, input: unknown): Obj | null {
  const fr = frameOf({
    type: 'assistant',
    message: { id: '', content: [{ type: 'tool_use', id, name, input: input ?? {} }] },
  });
  for (const ev of fr.events) if (headOf(ev.update).sessionUpdate === 'tool_call' && isObj(ev.update)) return ev.update;
  return null;
}

/** The ACP ToolCall a permission is asked for. */
export function toolCall(id: string, name: string, input: unknown): Obj {
  const u = toolCallUpdate(id, name, input) ?? { toolCallId: id, title: name, kind: 'other', status: 'pending', rawInput: input };
  const { sessionUpdate: _, ...call } = u;
  return call;
}
