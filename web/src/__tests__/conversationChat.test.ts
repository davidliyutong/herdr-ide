// The conversation of a chat the chat host runs: live increments overlaid
// on stored events (replaced by an item's stored event, dropped on a
// reattach), stored events taken once by seq, a subagent's items nested
// under its call, permissions and questions with their answers (also by
// another window), queued messages, what the chat states (its options,
// commands, usage, capabilities), its state and notices; and the pure
// helpers of the view: Markdown cut into blocks while it streams, the list
// at the caret, a message's content and limits, usage for people.
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_MODE,
  CATEGORY_MODEL,
  CATEGORY_THOUGHT_LEVEL,
  CHAT_NOTICES,
  configOf,
  emptyConversation,
  itemById,
  MAX_IMAGE,
  MAX_PROMPT,
  MODES,
  NOTICES,
  OPTION_ALLOW_ONCE,
  OPTION_ALLOW_SESSION,
  OPTION_REJECT_ONCE,
  PLAN_OPTION_PREFIX,
  prepend,
  readChat,
  reduce,
  reduceAll,
  take,
  toolItemId,
  waitingItems,
  withoutLive,
  type ChatEvent,
  type Conversation,
  type MessageItem,
  type PermissionItem,
  type QuestionItem,
  type SourceEvent,
  type ToolItem,
} from '../conversation/model';
import * as protocol from '../plugins/chat/protocol';
import { streamBlocks } from '../conversation/streaming';
import { menuAt } from '../conversation/Composer';
import { fileUri, fits, formatBytes, promptBytes, promptContent, type Attachment } from '../conversation/attach';
import { contextPercent, formatCost, relativeTime, tightest, windowLabel } from '../conversation/format';
import { hasMessage } from '../i18n';
import { APP_SLUG } from '../brand';

const text = (s: string) => ({ type: 'text' as const, text: s });
const run = (events: SourceEvent[]) => reduceAll(emptyConversation(), events);
const chunk = (s: string, kind = 'agent_message_chunk') => ({ sessionUpdate: kind, content: text(s) });
const liveSay = (item: string, s: string, extra: Partial<ChatEvent> = {}): ChatEvent => ({
  t: 'update',
  live: true,
  item,
  update: chunk(s) as ChatEvent['update'],
  ...extra,
});
const storedSay = (seq: number, item: string, s: string, extra: Partial<ChatEvent> = {}): ChatEvent => ({
  seq,
  t: 'update',
  item,
  update: chunk(s) as ChatEvent['update'],
  ...extra,
});
const toolEv = (seq: number | undefined, u: Record<string, unknown>, extra: Partial<ChatEvent> = {}): ChatEvent => ({
  ...(seq === undefined ? { live: true } : { seq }),
  t: 'update',
  update: u as ChatEvent['update'],
  ...extra,
});
const tool = (c: Conversation, id: string) => itemById(c, toolItemId(id)) as ToolItem;
const msg = (c: Conversation, id: string) => itemById(c, id) as MessageItem;
const ids = (c: Conversation) => c.items.map((i) => i.id);
const blocksOf = (b: { type: string; text?: string }[]) => b.map((x) => x.text ?? '').join('');

describe('live increments', () => {
  it('add to their item until its stored event gives it whole', () => {
    let c = run([{ seq: 1, t: 'turn', state: 'start' }, liveSay('m1:0', 'Hel'), liveSay('m1:0', 'lo')]);
    const id = 'message:agent:item:m1:0';
    expect(msg(c, id)).toMatchObject({ content: [text('Hello')], live: true });
    expect(c.live).toEqual({ [id]: null });
    // A live event has no seq: the highest taken stays.
    expect(c.last).toBe(1);
    c = reduce(c, storedSay(2, 'm1:0', 'Hello, world'));
    expect(msg(c, id).content).toEqual([text('Hello, world')]);
    expect(msg(c, id).live).toBeUndefined();
    expect(c.live).toEqual({});
    expect(c.items).toHaveLength(1);
    // A thought likewise, apart from the message.
    c = reduceAll(c, [
      { t: 'update', live: true, item: 'm2:0', update: chunk('hm', 'agent_thought_chunk') as ChatEvent['update'] },
      { seq: 3, t: 'update', item: 'm2:0', update: chunk('hmm.', 'agent_thought_chunk') as ChatEvent['update'] },
    ]);
    expect(ids(c)).toEqual([id, 'thought:agent:item:m2:0']);
    expect(itemById(c, 'thought:agent:item:m2:0')).toMatchObject({ kind: 'thought', content: [text('hmm.')] });
  });

  it('of a thought the agent keeps to itself carry its estimated tokens, the stored state’s once it comes', () => {
    const thought = (n?: unknown) =>
      ({
        sessionUpdate: 'agent_thought_chunk',
        content: text(''),
        ...(n === undefined ? {} : { _meta: { [APP_SLUG]: { estimatedTokens: n } } }),
      }) as ChatEvent['update'];
    const id = 'thought:agent:item:m1:0';
    let c = run([
      { t: 'update', live: true, item: 'm1:0', update: thought(120) },
      { t: 'update', live: true, item: 'm1:0', update: thought() },
      { t: 'update', live: true, item: 'm1:0', update: thought(480.4) },
    ]);
    expect(itemById(c, id)).toMatchObject({ kind: 'thought', estimatedTokens: 480, live: true });
    c = reduce(c, { seq: 1, t: 'update', item: 'm1:0', update: thought(512) });
    expect(itemById(c, id)).toEqual({ kind: 'thought', id, content: [text('')], estimatedTokens: 512 });
    c = reduce(c, { seq: 2, t: 'update', item: 'm1:0', update: thought() });
    expect(itemById(c, id)).toEqual({ kind: 'thought', id, content: [text('')] });
    for (const bad of [0, -3, 'many', Number.NaN, Number.POSITIVE_INFINITY, { n: 1 }]) {
      const b = run([{ seq: 1, t: 'update', item: 'x', update: thought(bad) }]);
      expect((itemById(b, 'thought:agent:item:x') as { estimatedTokens?: number }).estimatedTokens, String(bad)).toBeUndefined();
    }
    // A message's _meta is no thought's estimate.
    const m = run([
      { seq: 1, t: 'update', item: 'y', update: { ...chunk('hi'), _meta: { [APP_SLUG]: { estimatedTokens: 9 } } } as ChatEvent['update'] },
    ]);
    expect(itemById(m, 'message:agent:item:y')).not.toHaveProperty('estimatedTokens');
  });

  it('keep items of one message apart by their item id, even with a message id', () => {
    const c = run([
      storedSay(1, 'm:0', 'first', { update: { ...chunk('first'), messageId: 'm' } as ChatEvent['update'] }),
      toolEv(2, { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Run', kind: 'execute' }),
      storedSay(3, 'm:2', 'second', { update: { ...chunk('second'), messageId: 'm' } as ChatEvent['update'] }),
    ]);
    expect(c.items.map((i) => (i.kind === 'message' ? i.content[0] : i.id))).toEqual([text('first'), 'tool:t', text('second')]);
  });

  it('add a command’s output to its call; its stored state comes back on a stored event', () => {
    let c = run([
      toolEv(
        1,
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' } },
        { item: 't1' },
      ),
      toolEv(
        undefined,
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [{ type: 'content', content: text('a\n') }] },
        { item: 't1' },
      ),
      toolEv(
        undefined,
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [{ type: 'content', content: text('b\n') }] },
        { item: 't1' },
      ),
    ]);
    expect(tool(c, 't1').content).toEqual([{ type: 'content', content: text('a\nb\n') }]);
    expect(c.live?.['tool:t1']).toMatchObject({ id: 'tool:t1', status: 'in_progress', content: [] });
    // A stored change of the call without an item id: the call and its
    // stored state take it.
    c = reduce(c, toolEv(2, { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'List files' }));
    expect(tool(c, 't1')).toMatchObject({ title: 'List files', content: [{ type: 'content', content: text('a\nb\n') }] });
    expect(c.live?.['tool:t1']).toMatchObject({ title: 'List files', content: [] });
    // Its whole state: on the stored one.
    c = reduce(
      c,
      toolEv(
        3,
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'completed',
          content: [{ type: 'content', content: text('a\nb\nc\n') }],
        },
        { item: 't1' },
      ),
    );
    expect(tool(c, 't1')).toMatchObject({ title: 'List files', status: 'completed', rawInput: { command: 'ls' } });
    expect(tool(c, 't1').content).toEqual([{ type: 'content', content: text('a\nb\nc\n') }]);
    expect(c.live).toEqual({});
  });

  it('are dropped on a reattach: an item only live goes, one with a stored state goes back to it', () => {
    const c = run([
      { seq: 1, t: 'user', content: [text('go')] },
      { seq: 2, t: 'turn', state: 'start' },
      toolEv(3, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', kind: 'execute', status: 'in_progress' }, { item: 't1' }),
      liveSay('m1:0', 'half a sentence'),
      toolEv(undefined, { sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [{ type: 'content', content: text('out') }] }),
      storedSay(4, 'm0:0', 'a whole one'),
    ]);
    expect(ids(c)).toEqual(['message:user:1', 'tool:t1', 'message:agent:item:m1:0', 'message:agent:item:m0:0']);
    const r = reduce(c, { t: 'reattach' });
    expect(ids(r)).toEqual(['message:user:1', 'tool:t1', 'message:agent:item:m0:0']);
    expect(tool(r, 't1').content).toEqual([]);
    expect(itemById(r, 'message:agent:item:m0:0')).toBe(r.items[2]);
    expect(r.live).toBeUndefined();
    expect(r.turnStart).toBe(1);
    expect(r.last).toBe(4);
    // The state reduced from is as it was.
    expect(ids(c)).toHaveLength(4);
    // Nothing live: the same state.
    expect(reduce(r, { t: 'reattach' })).toBe(r);
    // The item arrives again after the reattach, then whole.
    const again = reduceAll(r, [liveSay('m1:0', 'half'), storedSay(5, 'm1:0', 'half a sentence.')]);
    expect(msg(again, 'message:agent:item:m1:0').content).toEqual([text('half a sentence.')]);
  });

  it('are not taken for a stored page’s events', () => {
    const c = run([storedSay(10, 'm:0', 'later')]);
    const d = take(c, [liveSay('m:1', 'live'), storedSay(5, 'e:0', 'earlier')]);
    expect(ids(d)).toEqual(['message:agent:item:e:0', 'message:agent:item:m:0', 'message:agent:item:m:1']);
    expect(prepend(c, [liveSay('x:0', 'no')])).toBe(c);
  });

  it('stay as they are when the turn ends without their stored state (cancelled while streaming), a subagent’s too', () => {
    const id = 'message:agent:item:m1:0';
    const streaming: SourceEvent[] = [
      { seq: 1, t: 'turn', state: 'start' },
      toolEv(
        2,
        { sessionUpdate: 'tool_call', toolCallId: 'task1', title: 'Explore', kind: 'think', status: 'in_progress' },
        { item: 'task1' },
      ),
      { t: 'update', live: true, parent: 'task1', item: 'sm:0', update: chunk('look') as ChatEvent['update'] },
      liveSay('m1:0', 'half a sen'),
    ];
    for (const end of [
      { seq: 3, t: 'turn', state: 'end', stopReason: 'cancelled' },
      { seq: 3, t: 'turn', state: 'error', error: { code: 'failed', message: 'gone' } },
    ] as ChatEvent[]) {
      const c = run([...streaming, end]);
      expect(msg(c, id)).toEqual({ kind: 'message', id, role: 'agent', content: [text('half a sen')] });
      expect(c.live).toBeUndefined();
      const sub = tool(c, 'task1').sub!;
      expect(sub.live).toBeUndefined();
      expect(msg(sub, 'message:agent:item:sm:0')).not.toHaveProperty('live');
      // No stored state will come: a reattach keeps them.
      const r = reduce(c, { t: 'reattach' });
      expect(r).toBe(c);
      // One at a time, the same.
      const one = [...streaming, end].reduce(reduce, emptyConversation());
      expect(one.items).toEqual(c.items);
    }
  });

  it('end with a stored notice under their item (the host left the item out): it is the item’s stored state', () => {
    const skipped = (seq: number, item: string, parent?: string): ChatEvent => ({
      seq,
      t: 'notice',
      item,
      ...(parent ? { parent } : {}),
      method: NOTICES.skipped,
      params: { bytes: 2_000_000, t: 'update' },
    });
    // Only live: the notice takes its place, for good.
    let c = run([{ seq: 1, t: 'turn', state: 'start' }, liveSay('m1:0', 'a very long'), skipped(2, 'm1:0'), storedSay(3, 'm2:0', 'next')]);
    expect(ids(c)).toEqual(['notice:2', 'message:agent:item:m2:0']);
    expect(itemById(c, 'notice:2')).toMatchObject({ kind: 'notice', method: NOTICES.skipped, params: { bytes: 2_000_000 } });
    expect(Object.keys(c.live ?? {})).toEqual([]);
    expect(ids(reduce(c, { t: 'reattach' }))).toEqual(['notice:2', 'message:agent:item:m2:0']);
    // A call with a stored state goes back to it; the notice follows.
    c = run([
      toolEv(1, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', kind: 'execute', status: 'in_progress' }, { item: 't1' }),
      toolEv(
        undefined,
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [{ type: 'content', content: text('out') }] },
        { item: 't1' },
      ),
      skipped(2, 't1'),
    ]);
    expect(ids(c)).toEqual(['tool:t1', 'notice:2']);
    expect(tool(c, 't1')).toMatchObject({ title: 'Run', status: 'in_progress', content: [] });
    expect(Object.keys(c.live ?? {})).toEqual([]);
    // A subagent's: in its conversation.
    c = run([
      toolEv(1, { sessionUpdate: 'tool_call', toolCallId: 'task1', title: 'Explore', kind: 'think' }),
      { t: 'update', live: true, parent: 'task1', item: 'sm:0', update: chunk('lo') as ChatEvent['update'] },
      skipped(2, 'sm:0', 'task1'),
    ]);
    expect(ids(tool(c, 'task1').sub!)).toEqual(['notice:2']);
    // Under an item not shown: after the items.
    expect(ids(run([storedSay(1, 'a:0', 'x'), skipped(2, 'zz')]))).toEqual(['message:agent:item:a:0', 'notice:2']);
  });

  it('after a reattach or a reset in the same batch start a new overlay', () => {
    const c = run([liveSay('m1:0', 'a'), { t: 'reattach' }, liveSay('m2:0', 'b'), { t: 'reset' }, liveSay('m3:0', 'c')]);
    expect(ids(c)).toEqual(['message:agent:item:m3:0']);
    expect(c.live).toEqual({ 'message:agent:item:m3:0': null });
  });

  it('of an item an earlier page has: a reattach goes back to what the page gave it', () => {
    const later = run([
      toolEv(
        undefined,
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [{ type: 'content', content: text('out') }] },
        { item: 't1' },
      ),
      liveSay('m:0', ', wor'),
    ]);
    const c = prepend(later, [
      toolEv(5, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', kind: 'execute', status: 'in_progress' }, { item: 't1' }),
      storedSay(6, 'm:0', 'Hello'),
    ]);
    expect(tool(c, 't1')).toMatchObject({ title: 'Run', content: [{ type: 'content', content: text('out') }] });
    expect(msg(c, 'message:agent:item:m:0').content).toEqual([text('Hello, wor')]);
    const r = reduce(c, { t: 'reattach' });
    expect(ids(r)).toEqual(['tool:t1', 'message:agent:item:m:0']);
    expect(tool(r, 't1')).toMatchObject({ title: 'Run', status: 'in_progress', content: [] });
    expect(msg(r, 'message:agent:item:m:0').content).toEqual([text('Hello')]);
  });

  it('come between stored events, which are taken once by their seq', () => {
    const c = run([
      storedSay(1, 'a:0', 'one'),
      liveSay('b:0', 'tw'),
      storedSay(1, 'z:0', 'again'),
      liveSay('b:0', 'o'),
      storedSay(2, 'b:0', 'two'),
    ]);
    expect(c.items.map((i) => (i as MessageItem).content[0])).toEqual([text('one'), text('two')]);
  });
});

describe('a subagent’s items', () => {
  const agent = toolEv(1, {
    sessionUpdate: 'tool_call',
    toolCallId: 'task1',
    title: 'Explore',
    kind: 'think',
    status: 'in_progress',
    rawInput: { subagent_type: 'Explore', description: 'Find the tests', prompt: 'Look for tests' },
  });
  const sub: ChatEvent[] = [
    {
      seq: 2,
      t: 'update',
      parent: 'task1',
      update: { sessionUpdate: 'tool_call', toolCallId: 's1', title: 'Grep', kind: 'search', status: 'completed' },
    },
    { seq: 3, t: 'update', parent: 'task1', item: 'sm:0', update: chunk('Found three.') as ChatEvent['update'] },
  ];

  it('go into the conversation of the call that runs it, the same one at a time or as a batch', () => {
    const c = run([agent, ...sub, toolEv(4, { sessionUpdate: 'tool_call_update', toolCallId: 'task1', status: 'completed' })]);
    expect(ids(c)).toEqual(['tool:task1']);
    const t = tool(c, 'task1');
    expect(t.status).toBe('completed');
    expect(t.sub && ids(t.sub)).toEqual(['tool:s1', 'message:agent:item:sm:0']);
    const one = [agent, ...sub].reduce(reduce, emptyConversation());
    expect(tool(one, 'task1').sub?.items).toEqual(tool(c, 'task1').sub?.items);
    // The main agent's items stay apart.
    expect(tool(c, 's1')).toBeUndefined();
  });

  it('make their call’s item when it is not there yet, and go deeper for a subagent’s subagent', () => {
    const c = run([
      { seq: 1, t: 'update', parent: 'task9', update: { sessionUpdate: 'tool_call', toolCallId: 'inner', title: 'Task', kind: 'think' } },
      { seq: 2, t: 'update', parent: 'inner', update: chunk('deep') as ChatEvent['update'] },
    ]);
    expect(ids(c)).toEqual(['tool:task9']);
    const inner = tool(tool(c, 'task9').sub!, 'inner');
    expect(inner.sub?.items.map((i) => (i as MessageItem).content[0])).toEqual([text('deep')]);
    expect(tool(c, 'task9')).toMatchObject({ toolKind: 'think', status: 'in_progress' });
  });

  it('keep their conversation when the call’s live increments are dropped', () => {
    const c = run([
      agent,
      toolEv(undefined, { sessionUpdate: 'tool_call_update', toolCallId: 'task1', content: [{ type: 'content', content: text('…') }] }),
      ...sub,
      { t: 'update', live: true, parent: 'task1', item: 'sm:1', update: chunk('typing') as ChatEvent['update'] },
    ]);
    expect(tool(c, 'task1').sub?.items).toHaveLength(3);
    const r = reduce(c, { t: 'reattach' });
    expect(tool(r, 'task1').content).toEqual([]);
    expect(ids(tool(r, 'task1').sub!)).toEqual(['tool:s1', 'message:agent:item:sm:0']);
  });

  it('of an earlier page join those of a later one', () => {
    const later = run([sub[1]]);
    const c = prepend(later, [agent, sub[0]]);
    expect(ids(c)).toEqual(['tool:task1']);
    expect(ids(tool(c, 'task1').sub!)).toEqual(['tool:s1', 'message:agent:item:sm:0']);
  });

  it('ask for permissions in the main list, naming the subagent', () => {
    const c = run([
      agent,
      { seq: 2, t: 'permission', id: 'p1', parent: 'task1', kind: 'command', toolCall: { toolCallId: 's2', title: 'Run' }, options: [] },
    ]);
    expect(ids(c)).toEqual(['tool:task1', 'permission:p1']);
    expect((c.items[1] as PermissionItem).parent).toBe('task1');
  });
});

const ask = (seq: number, id: string, extra: Partial<ChatEvent> = {}): ChatEvent => ({
  seq,
  t: 'permission',
  id,
  kind: 'command',
  toolCall: { toolCallId: `call-${id}`, title: 'List files', kind: 'execute', rawInput: { command: 'ls -la', cwd: '/w' } },
  options: [
    { optionId: OPTION_ALLOW_ONCE, name: 'Allow', kind: 'allow_once' },
    { optionId: OPTION_ALLOW_SESSION, name: 'Allow for session', kind: 'allow_always' },
    { optionId: OPTION_REJECT_ONCE, name: 'Reject', kind: 'reject_once' },
  ],
  ...extra,
});

describe('permissions', () => {
  it('are shown where asked and answered once, by whoever answered first', () => {
    let c = run([{ seq: 1, t: 'turn', state: 'start' }, ask(2, 'p1')]);
    const p = itemById(c, 'permission:p1') as PermissionItem;
    expect(p).toMatchObject({
      request: 'p1',
      permission: 'command',
      call: { id: 'tool:call-p1', title: 'List files', rawInput: { command: 'ls -la', cwd: '/w' } },
    });
    expect(p.options.map((o) => o.optionId)).toEqual([OPTION_ALLOW_ONCE, OPTION_ALLOW_SESSION, OPTION_REJECT_ONCE]);
    expect(waitingItems(c)).toEqual(['permission:p1']);
    // Another window answered.
    c = reduce(c, { seq: 3, t: 'permission_done', id: 'p1', outcome: { outcome: 'selected', optionId: OPTION_ALLOW_SESSION }, by: 'user' });
    expect(itemById(c, 'permission:p1')).toMatchObject({ outcome: { outcome: 'selected', optionId: OPTION_ALLOW_SESSION }, by: 'user' });
    expect(waitingItems(c)).toEqual([]);
    // One cancelled with the turn.
    c = reduceAll(c, [ask(4, 'p2'), { seq: 5, t: 'permission_done', id: 'p2', outcome: { outcome: 'cancelled' }, by: 'cancel' }]);
    expect(itemById(c, 'permission:p2')).toMatchObject({ outcome: { outcome: 'cancelled' }, by: 'cancel' });
    // An answer of a permission asked before the events taken: nothing to show.
    const before = c;
    c = reduce(c, { seq: 6, t: 'permission_done', id: 'p0', outcome: { outcome: 'cancelled' }, by: 'ended' });
    expect(c.items).toBe(before.items);
    expect(c.unknown).toBe(0);
  });

  it('wait only in the turn that asked them', () => {
    const c = run([{ seq: 1, t: 'turn', state: 'start' }, ask(2, 'old'), { seq: 3, t: 'turn', state: 'start' }, ask(4, 'new')]);
    expect(waitingItems(c)).toEqual(['permission:new']);
    expect(waitingItems(reduce(c, { seq: 5, t: 'turn', state: 'start' }))).toEqual([]);
  });

  it('read what a machine sent with care', () => {
    const c = run([
      ask(1, 'p1', {
        kind: 'bogus' as never,
        toolCall: 'x' as never,
        options: [null, { optionId: '' }, { optionId: 'reject_x', kind: 'odd' }, { optionId: 'yes' }] as never,
      }),
      { seq: 2, t: 'permission_done', id: 'p1', outcome: { outcome: 'selected' }, by: 7 } as never,
      { seq: 3, t: 'permission', id: '' } as never,
    ]);
    const p = itemById(c, 'permission:p1') as PermissionItem;
    expect(p.permission).toBe('other');
    expect(p.call).toMatchObject({ id: 'tool:p1', title: '', content: [] });
    expect(p.options).toEqual([
      { optionId: 'reject_x', name: '', kind: 'reject_once' },
      { optionId: 'yes', name: '', kind: 'allow_once' },
    ]);
    expect(p).toMatchObject({ outcome: { outcome: 'cancelled' }, by: 'user' });
    expect(c.unknown).toBe(1);
  });

  it('of a plan carry the plan and the modes to go on in', () => {
    const c = run([
      ask(1, 'plan1', {
        kind: 'plan',
        toolCall: { toolCallId: 'x', title: 'Plan', kind: 'switch_mode', rawInput: { plan: '# Steps\n\n1. a' } },
        options: [
          { optionId: `${PLAN_OPTION_PREFIX}default`, name: 'Approve', kind: 'allow_once' },
          { optionId: `${PLAN_OPTION_PREFIX}acceptEdits`, name: 'Approve, edits', kind: 'allow_once' },
          { optionId: OPTION_REJECT_ONCE, name: 'Keep planning', kind: 'reject_once' },
        ],
      }),
    ]);
    expect(itemById(c, 'permission:plan1')).toMatchObject({ permission: 'plan', call: { rawInput: { plan: '# Steps\n\n1. a' } } });
  });
});

describe('questions', () => {
  const q = (seq: number, id: string, questions: unknown[]): ChatEvent => ({ seq, t: 'question', id, questions: questions as never });

  it('are shown checked, then answered or skipped', () => {
    let c = run([
      q(1, 'q1', [
        {
          id: 'color',
          header: 'Color',
          question: 'Which color?',
          options: [{ label: 'Red', description: 'warm', preview: '**red**' }, { label: 'Blue' }, { label: 7 }],
          allowOther: true,
        },
        { id: 'pw', question: 'Password?', secret: true },
        { id: '', question: 'no id' },
        { id: 'x' },
      ]),
    ]);
    const item = itemById(c, 'question:q1') as QuestionItem;
    expect(item.questions).toEqual([
      {
        id: 'color',
        header: 'Color',
        question: 'Which color?',
        allowOther: true,
        options: [{ label: 'Red', description: 'warm', preview: '**red**' }, { label: 'Blue' }],
      },
      { id: 'pw', question: 'Password?', secret: true },
    ]);
    expect(waitingItems(c)).toEqual(['question:q1']);
    c = reduce(c, { seq: 2, t: 'question_done', id: 'q1', answers: { color: ['Blue'], pw: ['s3cret'], bad: 'x' } as never, by: 'user' });
    expect(itemById(c, 'question:q1')).toMatchObject({ done: true, by: 'user', answers: { color: ['Blue'], pw: ['s3cret'] } });
    c = reduceAll(c, [q(3, 'q2', [{ id: 'a', question: 'A?' }]), { seq: 4, t: 'question_done', id: 'q2', by: 'user' }]);
    const skipped = itemById(c, 'question:q2') as QuestionItem;
    expect(skipped.done).toBe(true);
    expect(skipped.answers).toBeUndefined();
    // No question that holds: none shown.
    expect(run([q(1, 'q3', [{ id: 'a' }])]).unknown).toBe(1);
  });

  it('are named by ids no object has as members, each once', () => {
    let c = run([
      q(1, 'q1', [
        { id: '__proto__', question: 'A?' },
        { id: 'constructor', question: 'B?' },
        { id: 'toString', question: 'C?' },
        { id: 'ok', question: 'D?' },
        { id: 'ok', question: 'D again?' },
      ]),
    ]);
    expect((itemById(c, 'question:q1') as QuestionItem).questions).toEqual([{ id: 'ok', question: 'D?' }]);
    c = reduce(c, {
      seq: 2,
      t: 'question_done',
      id: 'q1',
      answers: JSON.parse('{"__proto__":["x"],"constructor":["y"],"ok":["z"]}'),
      by: 'user',
    });
    const answers = (itemById(c, 'question:q1') as QuestionItem).answers!;
    expect(Object.keys(answers)).toEqual(['ok']);
    expect(Object.getPrototypeOf(answers)).toBeNull();
    expect(run([q(1, 'q2', [{ id: '__proto__', question: 'A?' }])]).unknown).toBe(1);
  });
});

describe('queued messages', () => {
  const queued = (seq: number, message: string, state: string, extra: Partial<ChatEvent> = {}): ChatEvent => ({
    seq,
    t: 'queued',
    message,
    state,
    ...extra,
  });

  it('wait in the queue, then become the user’s prompts once taken, once each', () => {
    let c = run([
      { seq: 1, t: 'turn', state: 'start' },
      queued(2, 'q1', 'queued', { clientId: 'c1', content: [text('also this')] }),
      queued(3, 'q2', 'queued', { clientId: 'c2', content: [text('and that')] }),
    ]);
    expect(c.queued?.map((x) => [x.message, x.clientId, x.content])).toEqual([
      ['q1', 'c1', [text('also this')]],
      ['q2', 'c2', [text('and that')]],
    ]);
    // Taken: a prompt of the user's, which its user event does not repeat.
    c = reduceAll(c, [queued(4, 'q1', 'taken'), { seq: 5, t: 'user', clientId: 'c1', content: [text('also this')] }]);
    expect(c.queued?.map((x) => x.message)).toEqual(['q2']);
    expect(ids(c)).toEqual(['message:user:c:c1']);
    // Withdrawn: no prompt.
    c = reduce(c, queued(6, 'q2', 'cancelled'));
    expect(c.queued).toEqual([]);
    expect(ids(c)).toEqual(['message:user:c:c1']);
    // The user event first, then taken.
    c = reduceAll(c, [
      queued(7, 'q3', 'queued', { clientId: 'c3', content: [text('x')] }),
      { seq: 8, t: 'user', clientId: 'c3', content: [text('x')] },
      queued(9, 'q3', 'taken'),
    ]);
    expect(ids(c)).toEqual(['message:user:c:c1', 'message:user:c:c3']);
    // Two prompts of the same text, two pages' ids: both.
    c = reduceAll(c, [{ seq: 10, t: 'user', clientId: 'c4', content: [text('x')] }]);
    expect(ids(c)).toHaveLength(3);
    // Without the page's id, by the host's.
    c = reduceAll(c, [queued(11, 'q5', 'queued', { content: [text('y')] }), queued(12, 'q5', 'taken')]);
    expect(ids(c).at(-1)).toBe('message:user:q:q5');
    expect(run([queued(1, '', 'queued'), queued(2, 'q', 'bogus')]).unknown).toBe(2);
  });

  it('of an earlier page still wait unless a later one took or withdrew them', () => {
    const later = run([
      queued(10, 'q3', 'queued', { content: [text('three')] }),
      queued(11, 'q1', 'taken', { clientId: 'c1', content: [text('one')] }),
      queued(12, 'q2', 'cancelled'),
    ]);
    expect(later.dequeued).toEqual(['q1', 'q2']);
    const c = prepend(later, [
      queued(1, 'q0', 'queued', { content: [text('zero')] }),
      queued(2, 'q1', 'queued', { clientId: 'c1', content: [text('one')] }),
      queued(3, 'q2', 'queued', { content: [text('two')] }),
      queued(4, 'q3', 'queued', { content: [text('3')] }),
    ]);
    expect(c.queued?.map((x) => [x.message, blocksOf(x.content)])).toEqual([
      ['q0', 'zero'],
      ['q3', 'three'],
    ]);
    expect(ids(c)).toEqual(['message:user:c:c1']);
    // A page before that one: what the later pages took stays taken.
    const d = prepend(c, [queued(0, 'q1', 'queued', { clientId: 'c1', content: [text('one')] })]);
    expect(d.queued?.map((x) => x.message)).toEqual(['q0', 'q3']);
  });
});

describe('what the chat states', () => {
  const chat = {
    id: 'c0123456789abcdef',
    kind: 'claude',
    title: 'Tables',
    cwd: '/w',
    state: 'idle',
    status: 'idle',
    config: [
      {
        id: 'model',
        name: 'Model',
        category: CATEGORY_MODEL,
        type: 'select',
        currentValue: 'claude-haiku-5-5',
        options: [{ value: 'claude-haiku-5-5', name: 'Haiku' }, { value: 'claude-opus-5-5', name: 'Opus' }, { value: 3 }],
      },
      {
        id: 'effort',
        name: 'Effort',
        category: CATEGORY_THOUGHT_LEVEL,
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }],
      },
      {
        id: 'mode',
        name: 'Mode',
        category: CATEGORY_MODE,
        type: 'select',
        currentValue: 'default',
        options: MODES.map((m) => ({ value: m, name: m })),
      },
      { id: 'odd', type: 'toggle', currentValue: 'x', options: [] },
      'junk',
    ],
    commands: [{ name: '/compact', description: 'Compact' }, { name: 'two words' }, { name: 'review', argumentHint: '[pr]' }, {}],
    usage: {
      used: 50_000,
      size: 200_000,
      percentage: 27,
      cost: { amount: 0.42, currency: 'USD' },
      limits: [
        { id: '5h', usedPercent: 72, resetsAt: 1_800_000_000, windowMinutes: 300 },
        { id: '', usedPercent: 1 },
      ],
    },
    capabilities: { images: true, compact: true, queue: 'yes', plan: true },
    handedOff: true,
    error: { code: 'x' },
  };

  it('is read with care and kept', () => {
    const info = readChat(chat)!;
    expect(info.config.map((o) => [o.id, o.options.map((v) => v.value)])).toEqual([
      ['model', ['claude-haiku-5-5', 'claude-opus-5-5']],
      ['effort', ['high']],
      ['mode', [...MODES]],
    ]);
    expect(info.commands).toEqual([
      { name: 'compact', description: 'Compact' },
      { name: 'review', argumentHint: '[pr]' },
    ]);
    expect(info.capabilities).toEqual({
      images: true,
      compact: true,
      queue: false,
      plan: true,
      questions: false,
      effort: false,
      model: false,
      cancelQueued: false,
    });
    expect(info.usage).toEqual({
      used: 50_000,
      size: 200_000,
      percentage: 27,
      cost: { amount: 0.42, currency: 'USD' },
      limits: [{ id: '5h', usedPercent: 72, resetsAt: 1_800_000_000, windowMinutes: 300 }],
    });
    expect(info).toMatchObject({ title: 'Tables', state: 'idle', handedOff: true, error: { code: 'x', message: '' } });
    // A selector only where there is a choice.
    expect(configOf(info, CATEGORY_MODEL)?.id).toBe('model');
    expect(configOf(info, CATEGORY_THOUGHT_LEVEL)).toBeUndefined();
    expect(readChat('x')).toBeUndefined();

    let c = run([{ seq: 1, t: 'info', chat: chat as never }]);
    expect(c.chat?.config).toHaveLength(3);
    expect(c.state).toBe('idle');
    expect(c.title).toBe('Tables');
    expect(c.usage?.percentage).toBe(27);
    // An ACP usage update keeps the limits, and the agent's own measure no longer holds.
    c = reduce(c, { seq: 2, t: 'update', update: { sessionUpdate: 'usage_update', used: 60_000, size: 200_000 } });
    expect(c.usage).toEqual({
      used: 60_000,
      size: 200_000,
      cost: { amount: 0.42, currency: 'USD' },
      limits: chat.usage.limits.slice(0, 1),
    });
    expect(run([{ seq: 1, t: 'info', chat: 'x' as never }]).unknown).toBe(1);
  });

  it('as its state, a failure told once where it happened', () => {
    let c = run([
      { seq: 1, t: 'state', state: 'working' },
      { seq: 2, t: 'state', state: 'failed', error: { code: 'ended', message: 'exit status 1', stderr: 'boom' } },
      { seq: 3, t: 'state', state: 'failed', error: { code: 'ended', message: 'exit status 1' } },
    ]);
    expect(c.state).toBe('failed');
    expect(c.stateError).toEqual({ code: 'ended', message: 'exit status 1' });
    expect(c.items).toEqual([{ kind: 'notice', id: 'notice:2', method: NOTICES.error, params: { message: 'exit status 1' } }]);
    c = reduce(c, { seq: 4, t: 'state', state: 'idle' });
    expect(c.stateError).toBeUndefined();
    expect(run([{ seq: 1, t: 'state' }]).unknown).toBe(1);
  });

  it('as notices: compacting while it works, then compacted; a handoff and a restart as items', () => {
    let c = run([
      { seq: 1, t: 'turn', state: 'start' },
      { seq: 2, t: 'notice', method: CHAT_NOTICES.compacting },
    ]);
    expect(c.activity).toBe('compacting');
    expect(c.items).toEqual([]);
    c = reduce(c, { seq: 3, t: 'notice', method: NOTICES.compacted, params: { trigger: 'manual' } });
    expect(c.activity).toBeUndefined();
    expect(c.items.map((i) => i.kind === 'notice' && i.method)).toEqual([NOTICES.compacted]);
    c = reduceAll(c, [
      { seq: 4, t: 'notice', method: CHAT_NOTICES.compacting },
      { seq: 5, t: 'turn', state: 'end', stopReason: 'end_turn' },
      { seq: 6, t: 'notice', method: CHAT_NOTICES.handedOff },
      { seq: 7, t: 'notice', method: CHAT_NOTICES.restarted, params: { mode: 'full' } },
      { seq: 8, t: 'notice', method: NOTICES.error, params: { message: 'overloaded', willRetry: true } },
      { seq: 9, t: 'notice', method: CHAT_NOTICES.imported, params: { lossy: true } },
      { seq: 10, t: 'notice', method: NOTICES.command, params: { name: '/compact' } },
    ]);
    expect(c.activity).toBeUndefined();
    expect(c.items.map((i) => i.kind === 'notice' && i.method)).toEqual([
      NOTICES.compacted,
      CHAT_NOTICES.handedOff,
      CHAT_NOTICES.restarted,
      NOTICES.error,
      CHAT_NOTICES.imported,
      NOTICES.command,
    ]);
    expect(c.unknown).toBe(0);
    for (const k of ['handedOff', 'restarted', 'restartedFor', 'retrying', 'imported', 'importedLossy'])
      expect(hasMessage(`conversation.notice.${k}`), k).toBe(true);
  });

  it('as notices: a folder the agent started in without its project settings, full access turned off', () => {
    const c = run([
      { seq: 1, t: 'notice', method: CHAT_NOTICES.untrustedFolder, params: { cwd: '/w' } },
      { seq: 2, t: 'notice', method: CHAT_NOTICES.fullAccessOff, params: { mode: 'full' } },
    ]);
    expect(c.items).toEqual([
      { kind: 'notice', id: 'notice:1', method: CHAT_NOTICES.untrustedFolder, params: { cwd: '/w' } },
      { kind: 'notice', id: 'notice:2', method: CHAT_NOTICES.fullAccessOff, params: { mode: 'full' } },
    ]);
    expect(c.unknown).toBe(0);
    for (const k of ['untrustedFolder', 'trust', 'trusted', 'fullAccessOff']) expect(hasMessage(`conversation.notice.${k}`), k).toBe(true);
  });

  it('as the notices’ names of the chat host (agentproto.Notice*)', () => {
    expect(CHAT_NOTICES).toEqual({
      compacting: `_${APP_SLUG}/compacting`,
      handedOff: `_${APP_SLUG}/handed_off`,
      restarted: `_${APP_SLUG}/restarted`,
      imported: `_${APP_SLUG}/imported`,
      untrustedFolder: `_${APP_SLUG}/untrusted_folder`,
      fullAccessOff: `_${APP_SLUG}/full_access_off`,
    });
    expect([NOTICES.compacted, NOTICES.command, NOTICES.error]).toEqual(['compacted', 'command', 'error'].map((n) => `_${APP_SLUG}/${n}`));
  });

  it('of an earlier page gives way to a later page’s', () => {
    const later = run([{ seq: 10, t: 'state', state: 'working' }]);
    const c = prepend(later, [
      { seq: 1, t: 'info', chat: chat as never },
      { seq: 2, t: 'queued', message: 'q', state: 'queued', content: [text('x')] },
    ]);
    expect(c.state).toBe('working');
    expect(c.chat?.title).toBe('Tables');
    expect(c.queued?.map((x) => x.message)).toEqual(['q']);
  });
});

describe('the chat host’s names and limits', () => {
  it('are the plugin protocol’s', () => {
    expect([MAX_PROMPT, MAX_IMAGE]).toEqual([protocol.MAX_PROMPT, protocol.MAX_IMAGE]);
    expect([OPTION_ALLOW_ONCE, OPTION_ALLOW_SESSION, OPTION_REJECT_ONCE, PLAN_OPTION_PREFIX]).toEqual([
      protocol.OPTION_ALLOW_ONCE,
      protocol.OPTION_ALLOW_SESSION,
      protocol.OPTION_REJECT_ONCE,
      protocol.PLAN_OPTION_PREFIX,
    ]);
    expect([CATEGORY_MODE, CATEGORY_MODEL, CATEGORY_THOUGHT_LEVEL]).toEqual([
      protocol.CATEGORY_MODE,
      protocol.CATEGORY_MODEL,
      protocol.CATEGORY_THOUGHT_LEVEL,
    ]);
    expect(MODES).toEqual(protocol.MODES);
    for (const m of MODES) {
      expect(hasMessage(`conversation.mode.${m}`), m).toBe(true);
      if (m !== 'plan') expect(hasMessage(`conversation.plan.approve.${m}`), m).toBe(true);
    }
    for (const code of ['busy', 'not_found', 'sleeping', 'handed_off', 'too_large', 'read_only', 'offline', 'in_terminal', 'auth_required'])
      expect(hasMessage(`conversation.error.${code}`), code).toBe(true);
  });
});

describe('Markdown while it streams', () => {
  it('is cut at blank lines, never within code or a display formula', () => {
    expect(streamBlocks('# Title\n\nPara one\nstill one\n\n\n| a |\n| - |\n| 1 |\n\nlast')).toEqual([
      '# Title',
      'Para one\nstill one',
      '| a |\n| - |\n| 1 |',
      'last',
    ]);
    expect(streamBlocks('```py\na\n\nb\n```\n\nafter')).toEqual(['```py\na\n\nb\n```', 'after']);
    expect(streamBlocks('~~~~\n```\n\n~~~\n\n~~~~\nx')).toEqual(['~~~~\n```\n\n~~~\n\n~~~~\nx']);
    expect(streamBlocks('$$\nx\n\ny\n$$\n\nz')).toEqual(['$$\nx\n\ny\n$$', 'z']);
    // An open fence takes the rest.
    expect(streamBlocks('text\n\n```\ncode\n\nmore')).toEqual(['text', '```\ncode\n\nmore']);
    expect(streamBlocks('')).toEqual([]);
    expect(streamBlocks('\n\n')).toEqual([]);
  });

  it('keeps the blocks before the last as they were as text is added', () => {
    const a = streamBlocks('one\n\ntwo');
    const b = streamBlocks('one\n\ntwo and three\n\nfo');
    expect(b.slice(0, a.length - 1)).toEqual(a.slice(0, -1));
  });
});

describe('the list at the caret', () => {
  it('offers commands after a / that begins the text, files after an @ that begins a word', () => {
    expect(menuAt('/', 1)).toEqual({ type: 'slash', start: 0, end: 1, query: '' });
    expect(menuAt('/comp', 3)).toEqual({ type: 'slash', start: 0, end: 5, query: 'co' });
    expect(menuAt('/compact now', 12)).toBeUndefined();
    expect(menuAt(' /x', 3)).toBeUndefined();
    expect(menuAt('see @src/a', 10)).toEqual({ type: 'mention', start: 4, end: 10, query: 'src/a' });
    expect(menuAt('@', 1)).toEqual({ type: 'mention', start: 0, end: 1, query: '' });
    expect(menuAt('mail a@b', 8)).toBeUndefined();
    expect(menuAt('see @a b', 8)).toBeUndefined();
    expect(menuAt('see @ab more', 6)).toEqual({ type: 'mention', start: 4, end: 7, query: 'a' });
  });
});

describe('a message’s content', () => {
  const image: Attachment = { id: 'a1', name: 'x.png', mimeType: 'image/png', data: 'AAAA', size: 3 };

  it('has its images first, the files it still names as links, its text last', () => {
    const content = promptContent(
      'look at @src/a b.ts and @gone',
      [image],
      [
        { path: '/w/src/a b.ts', label: 'src/a' },
        { path: '/w/gone.ts', label: 'other' },
        { path: 'relative.ts', label: 'gone' },
      ],
    );
    expect(content).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'resource_link', uri: 'file:///w/src/a%20b.ts', name: 'src/a' },
      { type: 'text', text: 'look at @src/a b.ts and @gone' },
    ]);
    expect(promptContent('  ', [], [])).toEqual([]);
    expect(fileUri('/a/#b?c')).toBe('file:///a/%23b%3Fc');
  });

  it('keeps to the host’s limit of a prompt, counted in bytes', () => {
    const big = (n: number) => promptContent('x'.repeat(n), [], []);
    const overhead = promptBytes(big(0).length ? big(0) : [{ type: 'text', text: '' }]);
    expect(fits(big(MAX_PROMPT - overhead))).toBe(true);
    expect(fits(big(MAX_PROMPT - overhead + 1))).toBe(false);
    expect(promptBytes([{ type: 'text', text: '中' }])).toBe(JSON.stringify([{ type: 'text', text: '' }]).length + 3);
    expect([formatBytes(MAX_IMAGE), formatBytes(820 << 10), formatBytes(12)]).toEqual(['5 MB', '820 KB', '12 B']);
  });
});

describe('usage for people', () => {
  it('says the context in use, the cost and the tightest limit', () => {
    expect(contextPercent({ used: 50, size: 200 })).toBe(25);
    expect(contextPercent({ used: 50, size: 200, percentage: 31 })).toBe(31);
    expect(contextPercent({ used: 50, size: 0 })).toBeUndefined();
    expect(formatCost({ amount: 0.0421, currency: 'USD' }, 'en')).toBe('$0.042');
    expect(formatCost({ amount: 12.5, currency: 'USD' }, 'en')).toBe('$12.50');
    expect(formatCost({ amount: 1, currency: 'not a code' }, 'en')).toBe('1.00 not a code');
    expect(
      tightest([
        { id: 'a', usedPercent: 10 },
        { id: 'b', usedPercent: 80 },
        { id: 'c', usedPercent: 40 },
      ])?.id,
    ).toBe('b');
    expect(tightest(undefined)).toBeUndefined();
    const now = Date.UTC(2026, 10, 22, 12);
    expect(relativeTime(now / 1000 + 3 * 3600, now, 'en')).toBe('in 3 hours');
    expect(relativeTime(now / 1000 + 12 * 60, now, 'en')).toBe('in 12 minutes');
    expect(relativeTime(now / 1000 + 2 * 86400, now, 'en')).toBe('in 2 days');
    expect([windowLabel(300), windowLabel(10080), windowLabel(45)]).toEqual(['5h', '7d', '45m']);
  });
});

describe('the reducer with the chat’s events', () => {
  it('leaves the states it was given as they were', () => {
    const a = run([ask(1, 'p1'), { seq: 2, t: 'queued', message: 'q', state: 'queued', content: [text('x')] }, liveSay('m:0', 'a')]);
    // The index is shared with the states reduced from it (entries beyond
    // its items are theirs): the rest is compared.
    const own = (c: Conversation) => JSON.stringify({ ...c, byId: undefined });
    const snapshot = own(a);
    reduceAll(a, [
      { seq: 3, t: 'permission_done', id: 'p1', outcome: { outcome: 'cancelled' }, by: 'cancel' },
      { seq: 4, t: 'queued', message: 'q', state: 'taken' },
      liveSay('m:0', 'b'),
      storedSay(5, 'm:0', 'ab'),
      { t: 'reattach' },
    ]);
    expect(own(a)).toBe(snapshot);
    expect(itemById(a, 'message:user:q:q')).toBeUndefined();
    expect(withoutLive(emptyConversation())).toEqual(emptyConversation());
  });
});
