// The shared transcript vectors (spec/vectors/transcript): the events a
// machine makes of Claude Code's transcripts, which the machine builds'
// parsers produce from the same lines in their tests
// (internal/agent/transcript, backend/shared/agents/transcript), hold to
// the conversation model's types, and reduce.
import { describe, expect, it } from 'vitest';
import { APP_SLUG } from '../brand';
import {
  emptyConversation,
  isDiffV2,
  NOTICES,
  noticeMethod,
  PLAN_STATUSES,
  reduce,
  TOOL_KINDS,
  TOOL_STATUSES,
  type ChatEvent,
  type ChatEventType,
  type DiffChange,
  type PlanEntry,
  type SessionUpdateKind,
  type StopReason,
  type ToolDiff,
} from '../conversation/model';
import claudeTools from '../../../spec/vectors/transcript/claude-2.1.330-tools.json';
import claudeToolsErrors from '../../../spec/vectors/transcript/claude-tools-errors.json';
import claudeSessionEvents from '../../../spec/vectors/transcript/claude-session-events.json';
import claudeUnknown from '../../../spec/vectors/transcript/claude-unknown.json';
import claudeQueuedPrompts from '../../../spec/vectors/transcript/claude-queued-prompts.json';
import claudeHeadless from '../../../spec/vectors/transcript/claude-headless.json';

interface Vector {
  note: string;
  kind: string;
  lines: string[];
  unknown: number;
  title?: string;
  events: Record<string, unknown>[];
}

const vectors: Record<string, Vector> = {
  'claude-2.1.330-tools.json': claudeTools,
  'claude-tools-errors.json': claudeToolsErrors,
  'claude-session-events.json': claudeSessionEvents,
  'claude-unknown.json': claudeUnknown,
  'claude-queued-prompts.json': claudeQueuedPrompts,
  'claude-headless.json': claudeHeadless,
} as Record<string, Vector>;

// The types and kinds a transcript's events may have, each checked
// against the model's own by the compiler.
const EVENT_TYPES = ['update', 'user', 'turn', 'notice'] as const satisfies readonly ChatEventType[];
const UPDATE_KINDS = [
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'usage_update',
] as const satisfies readonly SessionUpdateKind[];
const STOP_REASONS = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'] as const satisfies readonly StopReason[];
const TURN_STATES = ['start', 'end', 'error'];
const PRIORITIES = ['high', 'medium', 'low'] as const satisfies readonly PlanEntry['priority'][];
const OPERATIONS = ['add', 'delete', 'modify', 'move', 'copy'] as const satisfies readonly DiffChange['operation'][];
const METHODS = [...Object.values(NOTICES), noticeMethod('skipped')];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** _meta holds the product's own members only. */
function checkMeta(v: Json, where: string) {
  if (v._meta === undefined) return;
  expect(isObj(v._meta), where).toBe(true);
  expect(Object.keys(v._meta as Json), where).toEqual([APP_SLUG]);
}

/** A content block: transcripts give text only, an image being an empty
 * text marked as one. */
function checkBlock(b: unknown, where: string) {
  expect(isObj(b), where).toBe(true);
  const block = b as Json;
  expect(block.type, where).toBe('text');
  expect(typeof block.text, where).toBe('string');
  checkMeta(block, where);
  const own = (block._meta as Json | undefined)?.[APP_SLUG] as Json | undefined;
  if (own?.image) expect(block.text, where).toBe('');
}

function checkToolContent(c: unknown, where: string) {
  expect(isObj(c), where).toBe(true);
  const content = c as Json;
  switch (content.type) {
    case 'content':
      checkBlock(content.content, where);
      break;
    case 'diff': {
      const d = content as unknown as ToolDiff;
      if (isDiffV2(d)) {
        for (const ch of d.changes) {
          expect(OPERATIONS, where).toContain(ch.operation);
          expect(typeof ch.path, where).toBe('string');
        }
        if (d.patch) expect([typeof d.patch.format, typeof d.patch.text], where).toEqual(['string', 'string']);
      } else {
        expect(typeof d.path, where).toBe('string');
        expect(typeof d.newText, where).toBe('string');
        expect(d.oldText === null || typeof d.oldText === 'string', where).toBe(true);
      }
      break;
    }
    default:
      expect.fail(`${where}: tool call content of type ${String(content.type)}`);
  }
}

function checkUpdate(u: unknown, where: string) {
  expect(isObj(u), where).toBe(true);
  const up = u as Json;
  expect(UPDATE_KINDS, where).toContain(up.sessionUpdate);
  checkMeta(up, where);
  switch (up.sessionUpdate as (typeof UPDATE_KINDS)[number]) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      checkBlock(up.content, where);
      if (up.messageId !== undefined) expect(typeof up.messageId, where).toBe('string');
      break;
    case 'tool_call':
    case 'tool_call_update':
      expect(typeof up.toolCallId, where).toBe('string');
      expect(up.toolCallId, where).not.toBe('');
      if (up.sessionUpdate === 'tool_call' || up.title !== undefined) expect(typeof up.title, where).toBe('string');
      if (up.sessionUpdate === 'tool_call' || up.kind !== undefined) expect(TOOL_KINDS, where).toContain(up.kind);
      if (up.sessionUpdate === 'tool_call' || up.status !== undefined) expect(TOOL_STATUSES, where).toContain(up.status);
      for (const c of (up.content as unknown[] | undefined) ?? []) checkToolContent(c, where);
      for (const l of (up.locations as unknown[] | undefined) ?? []) {
        expect(typeof (l as Json).path, where).toBe('string');
        const line = (l as Json).line;
        if (line !== undefined) expect(Number.isInteger(line), where).toBe(true);
      }
      break;
    case 'plan':
      expect(Array.isArray(up.entries), where).toBe(true);
      for (const e of up.entries as PlanEntry[]) {
        expect(typeof e.content, where).toBe('string');
        expect(PLAN_STATUSES, where).toContain(e.status);
        expect(PRIORITIES, where).toContain(e.priority);
      }
      break;
    case 'usage_update':
      expect(Number.isInteger(up.used), where).toBe(true);
      if (up.size !== undefined) expect(Number.isInteger(up.size), where).toBe(true);
      break;
  }
}

function checkEvent(ev: Json, where: string) {
  expect(EVENT_TYPES, where).toContain(ev.t);
  // The vectors leave out the event's time; transcript events have no place.
  expect(ev.seq, where).toBeUndefined();
  expect(ev.at, where).toBeUndefined();
  switch (ev.t as (typeof EVENT_TYPES)[number]) {
    case 'update':
      checkUpdate(ev.update, where);
      break;
    case 'user':
      expect(Array.isArray(ev.content) && ev.content.length > 0, where).toBe(true);
      for (const b of ev.content as unknown[]) checkBlock(b, where);
      break;
    case 'turn':
      expect(TURN_STATES, where).toContain(ev.state);
      if (ev.stopReason !== undefined) expect(STOP_REASONS, where).toContain(ev.stopReason);
      break;
    case 'notice':
      expect(METHODS, where).toContain(ev.method);
      if (ev.params !== undefined) expect(isObj(ev.params), where).toBe(true);
      break;
  }
}

describe('transcript vectors', () => {
  it('are all here: every file of the directory', async () => {
    const fsModule = 'node:fs';
    const fs = (await import(/* @vite-ignore */ fsModule)) as { readdirSync(p: URL): string[] };
    const files = fs.readdirSync(new URL('../../../spec/vectors/transcript/', import.meta.url)).filter((f) => f.endsWith('.json'));
    expect(Object.keys(vectors).sort()).toEqual(files.sort());
  });
  for (const [name, v] of Object.entries(vectors)) {
    describe(name, () => {
      it('has its lines and its kind', () => {
        expect(v.kind).toBe('claude');
        expect(v.note).not.toBe('');
        expect(v.lines.length).toBeGreaterThan(0);
        expect(Number.isInteger(v.unknown)).toBe(true);
      });
      it('gives events of the model’s types', () => {
        v.events.forEach((ev, i) => checkEvent(ev, `${name} event ${i}`));
        // An image's data is never forwarded.
        expect(JSON.stringify(v.events)).not.toMatch(/iVBORw0KGgo|;base64,/);
      });
      it('reduces', () => {
        let state = emptyConversation();
        for (const ev of v.events) state = reduce(state, ev as unknown as ChatEvent);
        expect(state.turn === 'idle' || state.turn === 'working').toBe(true);
        expect(state.items.length).toBeGreaterThan(0);
      });
    });
  }
  it('cover every kind of event a transcript gives', () => {
    const seen = new Set<string>();
    for (const v of Object.values(vectors))
      for (const ev of v.events) {
        seen.add(String(ev.t));
        if (isObj(ev.update)) seen.add(String(ev.update.sessionUpdate));
        if (typeof ev.method === 'string') seen.add(ev.method);
      }
    for (const k of [...EVENT_TYPES, ...UPDATE_KINDS, NOTICES.command, NOTICES.compacted, NOTICES.error]) expect(seen).toContain(k);
  });
});
