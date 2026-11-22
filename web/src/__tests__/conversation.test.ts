// The native view's contracts: the kinds of agents from the core's
// registry (commands built only from a session id that is a UUID), the
// conversation an agent's events reduce to (also from events of shapes no
// parser makes), the session the core reports in a terminal's record, and
// the text derived from items (diffs, a patch's lines, display formulas,
// what is read out), in bounded time.
import { describe, expect, it } from 'vitest';
import {
  AGENT_KINDS,
  agentKind,
  CHAT_ADAPTERS,
  chatAdapter,
  chatKinds,
  hasNativeView,
  isSessionId,
  PLACEHOLDER,
  resumeCommand,
  startArgv,
  usageProvider,
} from '../conversation/kinds';
import {
  asText,
  blocksText,
  emptyConversation,
  isDiffV2,
  isUpdate,
  itemById,
  NOTABLE_STOPS,
  NOTICES,
  noticeMethod,
  PLAN_STATUSES,
  prepend,
  reduce,
  reduceAll,
  STOPPED,
  take,
  TOOL_KINDS,
  TOOL_STATUSES,
  type ChatEvent,
  type Conversation,
  type MessageItem,
  type PlanItem,
  type SessionUpdate,
  type SourceEvent,
  type ToolItem,
} from '../conversation/model';
import { diffStat, hunks, lineDiff, MAX_DIFF_LINES, patchLines, splitLines } from '../conversation/diff';
import { commandOf, displayMath, exitCodeOf, formatTokens, plainOutput, spokenText, splitPath, subjectOf } from '../conversation/format';
import { agentSession } from '../lib/machine';
import { PROVIDERS } from '../plugins/usage/model';
import { APP_SLUG } from '../brand';
import registry from '../../../design/generated/registry.json';
import { en } from '../i18n/en';
import { en as conversationEn } from '../conversation/i18n/en';
import { hasMessage } from '../i18n';

const S1 = '0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f';

describe('agent kinds', () => {
  it('are the registry’s, with what the UI had in its own tables', () => {
    expect(AGENT_KINDS.length).toBe(registry.agents.length);
    expect(AGENT_KINDS[0].id).toBe('claude');
    expect(agentKind('claude')?.title).toBe('Claude Code');
    expect(agentKind('nobody')).toBeUndefined();
    expect(agentKind(undefined)).toBeUndefined();
    // The commands that continue the directory's latest conversation.
    expect(resumeCommand('claude')).toBe('claude --continue');
    expect(resumeCommand('codex')).toBe('codex resume --last');
    expect(AGENT_KINDS.filter((k) => k.continueLatest).map((k) => k.id)).toEqual(['claude', 'codex']);
    // The agents the palette starts.
    expect(AGENT_KINDS.filter((k) => k.start).map((k) => k.id)).toEqual([
      'claude',
      'codex',
      'gemini',
      'opencode',
      'kimi',
      'grok',
      'cursor',
      'copilot',
      'qwen',
      'amp',
    ]);
    expect(hasNativeView('claude')).toBe(true);
    expect(hasNativeView('codex')).toBe(true);
    expect(hasNativeView('gemini')).toBe(false);
    expect(hasNativeView(undefined)).toBe(false);
  });

  it('name providers the AI usage plugin has', () => {
    expect(usageProvider('agy')).toBe('antigravity');
    expect(usageProvider('claude')).toBe('claude');
    expect(usageProvider('droid')).toBeUndefined();
    for (const k of AGENT_KINDS) if (k.usageProvider) expect(PROVIDERS as readonly string[], k.id).toContain(k.usageProvider);
  });

  it('put only a session id that is a UUID into a command', () => {
    expect(isSessionId(S1)).toBe(true);
    expect(resumeCommand('claude', S1)).toBe(`claude --resume ${S1}`);
    expect(resumeCommand('codex', S1)).toBe(`codex resume ${S1}`);
    for (const bad of [
      'x; rm -rf ~',
      `${S1}; rm -rf ~`,
      `${S1}\n`,
      `'${S1}'`,
      '$(reboot)',
      '`reboot`',
      S1.toUpperCase(),
      `${S1} --dangerously-skip-permissions`,
      '',
      undefined,
    ]) {
      expect(isSessionId(bad)).toBe(false);
      expect(resumeCommand('claude', bad)).toBe('claude --continue');
      expect(resumeCommand('codex', bad)).toBe('codex resume --last');
      expect(startArgv('claude', bad)).toEqual(['claude']);
    }
    // An agent without either command, and an unknown one.
    expect(resumeCommand('gemini', S1)).toBeUndefined();
    expect(resumeCommand('rm -rf ~', S1)).toBeUndefined();
  });

  it('start with a session the page chose where the agent takes one', () => {
    expect(startArgv('claude', S1)).toEqual(['claude', '--session-id', S1]);
    expect(startArgv('claude')).toEqual(['claude']);
    expect(startArgv('codex', S1)).toEqual(['codex']);
    expect(startArgv('gemini')).toEqual(['gemini']);
    expect(startArgv('droid')).toBeUndefined();
    expect(startArgv('nobody')).toBeUndefined();
    expect(agentKind('claude')?.newSession).toContain(PLACEHOLDER);
  });

  it('name the chat host’s adapter of the agents it runs, never their command', () => {
    expect(chatKinds().map((k) => k.id)).toEqual(['claude', 'codex', 'kimi', 'grok']);
    expect(chatAdapter('claude')).toBe('claude');
    expect(chatAdapter('codex')).toBe('codex');
    expect(chatAdapter('kimi')).toBe('acp');
    expect(chatAdapter('grok')).toBe('acp');
    expect(chatAdapter('opencode')).toBeUndefined();
    expect(chatAdapter('nobody')).toBeUndefined();
    expect(chatAdapter(undefined)).toBeUndefined();
    for (const k of AGENT_KINDS) {
      if (k.chat) expect(CHAT_ADAPTERS as readonly string[], k.id).toContain(k.chat.adapter);
      expect(Object.keys(k.chat ?? {}), k.id).toEqual(k.chat ? ['adapter'] : []);
    }
  });
});

describe('a terminal record’s session', () => {
  it('is read when its id is a session id', () => {
    const r = (extra: Record<string, unknown>) => ({ address: 't1', agent: 'claude', ...extra });
    expect(agentSession(r({ agent_session: S1, agent_session_source: 'pid' }))).toEqual({ id: S1, source: 'pid' });
    expect(agentSession(r({ agent_session: S1 }))).toEqual({ id: S1, source: '' });
    expect(agentSession(r({ agent_session: 'x; rm -rf ~', agent_session_source: 'argv' }))).toBeUndefined();
    expect(agentSession(r({ agent_session: 7 }))).toBeUndefined();
    expect(agentSession(r({}))).toBeUndefined();
    expect(agentSession(undefined)).toBeUndefined();
  });
});

const text = (t: string) => ({ type: 'text' as const, text: t });
const update = (seq: number, update: unknown, extra: Partial<ChatEvent> = {}): ChatEvent => ({
  seq,
  t: 'update',
  update: update as ChatEvent['update'],
  ...extra,
});
const run = (events: SourceEvent[]) => events.reduce(reduce, emptyConversation());

describe('the conversation', () => {
  it('joins an agent’s message chunks and keeps thoughts apart', () => {
    const c = run([
      { seq: 0, t: 'user', content: [text('a table, please')], at: '2026-11-02T09:30:00Z' },
      { seq: 256, t: 'turn', state: 'start' },
      update(512, { sessionUpdate: 'agent_thought_chunk', content: text('Rows ') }),
      update(513, { sessionUpdate: 'agent_thought_chunk', content: text('and columns.') }),
      update(768, { sessionUpdate: 'agent_message_chunk', content: text('| a |') }),
      update(769, { sessionUpdate: 'agent_message_chunk', content: text('\n| 1 |') }),
    ]);
    expect(c.turn).toBe('working');
    expect(c.items).toStrictEqual([
      { kind: 'message', id: 'message:user:0', role: 'user', content: [text('a table, please')], at: '2026-11-02T09:30:00Z' },
      { kind: 'thought', id: 'thought:agent:512', content: [text('Rows and columns.')] },
      { kind: 'message', id: 'message:agent:768', role: 'agent', content: [text('| a |\n| 1 |')] },
    ]);
    expect(c.byId).toEqual({ 'message:user:0': 0, 'thought:agent:512': 1, 'message:agent:768': 2 });
    const done = reduce(c, { seq: 1024, t: 'turn', state: 'end', stopReason: 'end_turn' });
    expect(done.turn).toBe('idle');
    expect(c.turn).toBe('working');
  });

  it('puts chunks of one message together by its id, other blocks after the text', () => {
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' };
    const c = run([
      update(1, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: text('Hello') }),
      update(2, { sessionUpdate: 'agent_thought_chunk', messageId: 'm2', content: text('hm') }),
      update(3, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: text(', world') }),
      update(4, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: image }),
      update(5, { sessionUpdate: 'user_message_chunk', content: text('more') }),
    ]);
    expect(c.items.map((i) => i.id)).toEqual(['message:agent:id:m1', 'thought:agent:id:m2', 'message:user:5']);
    expect(c.items[0]).toMatchObject({ role: 'agent', content: [text('Hello, world'), image] });
    expect(c.items[2]).toMatchObject({ role: 'user', content: [text('more')] });
  });

  it('starts over on a reset, takes the session’s title and counts what it does not show', () => {
    const c = run([
      update(1, { sessionUpdate: 'agent_message_chunk', content: text('x') }),
      update(2, { sessionUpdate: 'session_info_update', title: 'Tables' }),
      update(3, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read' }),
      update(4, { sessionUpdate: 'some_future_update', x: 1 }),
      update(5, { sessionUpdate: 'agent_message_chunk', content: 'not a block' }),
      { seq: 6, t: 'notice', method: NOTICES.compacted },
      { seq: 7, t: 'notice', method: noticeMethod('some_future_notice') },
      { seq: 8, t: 'some_future_type' } as unknown as ChatEvent,
      // Known kinds the view has nothing to show for are not unknown.
      update(9, { sessionUpdate: 'available_commands_update', availableCommands: [] }),
      update(10, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }),
      { t: 'ack', id: 'c1' },
      { t: 'permission', id: 'p1' },
      { t: 'state', state: 'idle' },
    ]);
    expect(c.title).toBe('Tables');
    expect(c.items.map((i) => i.kind)).toEqual(['message', 'tool', 'notice']);
    expect(c.unknown).toBe(4);
    expect(reduce(c, { seq: 11, t: 'update', update: { sessionUpdate: 'session_info_update', title: null } }).title).toBeUndefined();
    expect(reduce(c, { t: 'reset' })).toEqual(emptyConversation());
  });

  it('tells updates apart by their kind', () => {
    const u: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: text('x') };
    expect(isUpdate(u, 'agent_message_chunk') && u.content.type).toBe('text');
    expect(isUpdate(u, 'agent_thought_chunk')).toBe(false);
    expect(isUpdate({ sessionUpdate: 'some_future_update' }, 'tool_call')).toBe(false);
    expect(isUpdate(undefined, 'plan')).toBe(false);
  });

  it('has messages of its own, for every kind and status the model names', () => {
    for (const [k, v] of Object.entries(conversationEn)) {
      expect(k).toMatch(/^conversation\./);
      expect(en[k as keyof typeof en]).toBe(v);
    }
    for (const k of TOOL_KINDS) expect(hasMessage(`conversation.toolKind.${k}`), k).toBe(true);
    for (const k of TOOL_STATUSES) expect(hasMessage(`conversation.toolStatus.${k}`), k).toBe(true);
    for (const k of PLAN_STATUSES) expect(hasMessage(`conversation.planStatus.${k}`), k).toBe(true);
    for (const k of Object.keys(NOTICES)) expect(hasMessage(`conversation.notice.${k}`), k).toBe(true);
  });

  it('names notices after the product and tells diffs of both versions apart', () => {
    expect(noticeMethod('cleared')).toBe(`_${APP_SLUG}/cleared`);
    expect(NOTICES.compacted).toBe(`_${APP_SLUG}/compacted`);
    expect(isDiffV2({ type: 'diff', path: '/a', oldText: null, newText: 'x' })).toBe(false);
    expect(isDiffV2({ type: 'diff', changes: [{ operation: 'modify', path: '/a' }], patch: { format: 'git_patch', text: '' } })).toBe(true);
  });
});

const turn = (seq: number, state: string, extra: Partial<ChatEvent> = {}): ChatEvent => ({ seq, t: 'turn', state, ...extra });
const prompt = (seq: number, s: string): ChatEvent => ({ seq, t: 'user', content: [text(s)] });
const say = (seq: number, s: string, messageId?: string) =>
  update(seq, { sessionUpdate: 'agent_message_chunk', content: text(s), messageId });
const think = (seq: number, s: string, messageId?: string) =>
  update(seq, { sessionUpdate: 'agent_thought_chunk', content: text(s), messageId });
const call = (seq: number, u: Record<string, unknown>) => update(seq, { sessionUpdate: 'tool_call', ...u });
const callUpdate = (seq: number, u: Record<string, unknown>) => update(seq, { sessionUpdate: 'tool_call_update', ...u });
const planOf = (seq: number, ...entries: [string, string][]) =>
  update(seq, { sessionUpdate: 'plan', entries: entries.map(([content, status]) => ({ content, status, priority: 'medium' })) });
const tool = (c: Conversation, id: string) => itemById(c, id) as ToolItem;
const texts = (c: Conversation) =>
  c.items.map((i) =>
    i.kind === 'message' || i.kind === 'thought'
      ? `${i.kind === 'thought' ? 'thought' : i.role}:${i.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('')}`
      : i.kind === 'plan'
        ? `plan:${i.entries.map((e) => e.content).join(',')}`
        : i.kind === 'tool'
          ? `tool:${i.id}`
          : `notice:${i.method.split('/')[1]}`,
  );

describe('the conversation’s prompts and messages', () => {
  it('takes the same prompt again in one turn as one, and in the next turn as another', () => {
    const c = run([
      turn(1, 'start'),
      prompt(2, 'go on'),
      prompt(3, 'go on'),
      say(4, 'ok'),
      prompt(5, 'go on'),
      turn(6, 'end'),
      turn(7, 'start'),
      prompt(8, 'go on'),
      prompt(9, 'stop'),
    ]);
    expect(texts(c)).toEqual(['user:go on', 'agent:ok', 'user:go on', 'user:go on', 'user:stop']);
  });

  it('joins chunks of one message by its id or, without one, adjacent ones; another kind between starts a new item', () => {
    const c = run([
      say(1, 'a'),
      say(2, 'b'),
      think(3, 'hm'),
      say(4, 'c'),
      say(5, 'd', 'm1'),
      call(6, { toolCallId: 't1', title: 'Run', kind: 'execute' }),
      say(7, 'e', 'm1'),
      say(8, 'f'),
    ]);
    expect(texts(c)).toEqual(['agent:ab', 'thought:hm', 'agent:c', 'agent:de', 'tool:t1', 'agent:f']);
  });

  it('keeps a block marked cut short apart, with its mark', () => {
    const cut = { _meta: { [APP_SLUG]: { truncated: true } } };
    const c = run([say(1, 'a', 'm'), update(2, { sessionUpdate: 'agent_message_chunk', content: text('b'), messageId: 'm', ...cut })]);
    expect((c.items[0] as MessageItem).content).toEqual([text('a'), { ...text('b'), ...cut }]);
  });
});

describe('the conversation’s tool calls', () => {
  it('upsert by their id: present members replace, content replaces, an update may come first', () => {
    const loc = [{ path: '/p/a.ts', line: 3 }];
    let c = run([
      callUpdate(1, { toolCallId: 'x', status: 'in_progress' }),
      call(2, { toolCallId: 'x', title: 'Edit a.ts', kind: 'edit', status: 'pending', locations: loc, rawInput: { file_path: '/p/a.ts' } }),
    ]);
    expect(c.items).toHaveLength(1);
    expect(tool(c, 'x')).toMatchObject({ title: 'Edit a.ts', toolKind: 'edit', status: 'pending', locations: loc });
    const diff = { type: 'diff', path: '/p/a.ts', oldText: 'a\n', newText: 'b\n' };
    c = reduceAll(c, [
      callUpdate(3, {
        toolCallId: 'x',
        status: 'completed',
        content: [diff, { type: 'bogus' }],
        title: null,
        _meta: { [APP_SLUG]: { exitCode: 0 } },
      }),
      callUpdate(4, { toolCallId: 'x', content: [{ type: 'content', content: text('done') }] }),
    ]);
    const t = tool(c, 'x');
    expect(t).toMatchObject({ title: 'Edit a.ts', status: 'completed', locations: loc, rawInput: { file_path: '/p/a.ts' } });
    expect(t.content).toEqual([{ type: 'content', content: text('done') }]);
    expect(t.meta).toEqual({ [APP_SLUG]: { exitCode: 0 } });
    // A call for an id an update settled keeps the settled status.
    const late = run([callUpdate(1, { toolCallId: 'y', status: 'failed' }), call(2, { toolCallId: 'y', title: 'Run', status: 'pending' })]);
    expect(tool(late, 'y')).toMatchObject({ title: 'Run', status: 'failed' });
  });

  it('pass over calls without an id or with an id another item has', () => {
    const c = run([say(1, 'x', 'm'), call(2, { title: 'no id' }), call(3, { toolCallId: 'message:agent:id:m', title: 'clash' })]);
    expect(c.items).toHaveLength(1);
    expect(c.unknown).toBe(2);
  });
});

describe('the conversation’s plan, usage, turns and notices', () => {
  it('keeps one plan a turn, replaced whole where it first came', () => {
    const c = run([
      turn(1, 'start'),
      prompt(2, 'do it'),
      planOf(3, ['a', 'in_progress'], ['b', 'pending']),
      say(4, 'working on a'),
      planOf(5, ['a', 'completed'], ['b', 'in_progress'], ['c', 'bogus']),
      turn(6, 'end'),
      turn(7, 'start'),
      planOf(8, ['d', 'pending']),
    ]);
    expect(texts(c)).toEqual(['user:do it', 'plan:a,b,c', 'agent:working on a', 'plan:d']);
    expect((c.items[1] as PlanItem).entries.map((e) => e.status)).toEqual(['completed', 'in_progress', 'pending']);
  });

  it('takes the context’s usage, keeping a size it knew', () => {
    let c = run([update(1, { sessionUpdate: 'usage_update', used: 1000, size: 200000, cost: { amount: 0.5, currency: 'USD' } })]);
    expect(c.usage).toEqual({ used: 1000, size: 200000, cost: { amount: 0.5, currency: 'USD' } });
    c = reduce(c, update(2, { sessionUpdate: 'usage_update', used: 5000 }));
    expect(c.usage).toEqual({ used: 5000, size: 200000, cost: { amount: 0.5, currency: 'USD' } });
    expect(reduce(c, update(3, { sessionUpdate: 'usage_update', used: 'many' })).unknown).toBe(1);
    expect(run([update(1, { sessionUpdate: 'usage_update', used: 7 })]).usage).toEqual({ used: 7, size: 0 });
  });

  it('tells of a turn that failed or stopped short, not of one that ended', () => {
    const c = run([
      turn(1, 'start'),
      turn(2, 'end', { stopReason: 'end_turn' }),
      turn(3, 'start'),
      turn(4, 'end', { stopReason: 'cancelled' }),
      turn(5, 'start'),
      turn(6, 'error', { error: { code: 'x', message: 'overloaded' } }),
      turn(7, 'bogus'),
    ]);
    expect(c.turn).toBe('idle');
    expect(c.items).toEqual([
      { kind: 'notice', id: 'notice:4', method: STOPPED, params: { stopReason: 'cancelled' } },
      { kind: 'notice', id: 'notice:6', method: NOTICES.error, params: { message: 'overloaded' } },
    ]);
    expect(c.unknown).toBe(1);
    expect(NOTABLE_STOPS).toContain('max_tokens');
  });

  it('shows each notice of a transcript', () => {
    const c = run(Object.values(NOTICES).map((method, i) => ({ seq: i + 1, t: 'notice' as const, method, params: { name: 'x' } })));
    expect(c.items.map((i) => (i.kind === 'notice' ? i.method : ''))).toEqual(Object.values(NOTICES));
    expect(c.unknown).toBe(0);
  });
});

describe('the conversation’s events taken twice', () => {
  it('passes over an event whose seq is not above the highest taken, and is then the same state', () => {
    const events = [prompt(1, 'a'), say(2, 'b'), say(3, 'c')];
    const c = run(events);
    expect(reduceAll(c, events)).toBe(c);
    expect(reduce(c, say(2, 'again'))).toBe(c);
    expect(texts(reduce(c, say(4, 'd')))).toEqual(['user:a', 'agent:bcd']);
    // Events without a seq (an ACP client's) are all taken.
    expect(
      texts(
        run([
          { t: 'user', content: [text('x')] },
          { t: 'user', content: [text('y')] },
        ]),
      ),
    ).toEqual(['user:x', 'user:y']);
  });

  it('leaves states it was given as they were, and their index right for their own items', () => {
    const a = run([prompt(1, 'a'), call(2, { toolCallId: 't', title: 'Run' })]);
    const before = JSON.stringify(a.items);
    const b = reduceAll(a, [call(3, { toolCallId: 'u', title: 'Read' }), callUpdate(4, { toolCallId: 't', status: 'completed' })]);
    // Another branch from a: its own item at the index b gave u.
    const c = reduceAll(a, [call(3, { toolCallId: 'v', title: 'Search' }), call(4, { toolCallId: 'u', title: 'Fetch' })]);
    expect(JSON.stringify(a.items)).toBe(before);
    expect(itemById(a, 'u')).toBeUndefined();
    expect(tool(a, 't').status).toBeUndefined();
    expect(tool(b, 't').status).toBe('completed');
    expect(tool(b, 'u').title).toBe('Read');
    expect(itemById(b, 'v')).toBeUndefined();
    expect(tool(c, 'v').title).toBe('Search');
    expect(tool(c, 'u').title).toBe('Fetch');
    expect(c.items.map((i) => i.id)).toEqual(['message:user:1', 't', 'v', 'u']);
    expect(b.items.map((i) => i.id)).toEqual(['message:user:1', 't', 'u']);
    // Items an event did not change stay the same objects.
    expect(b.items[0]).toBe(a.items[0]);
  });

  it('reduces thousands of events briskly, one at a time or as a batch', () => {
    const events: ChatEvent[] = [];
    for (let i = 0; i < 5000; i++) {
      const seq = (i + 1) * 256;
      if (i % 5 === 0) events.push(prompt(seq, `prompt ${i}`));
      else if (i % 5 === 1) events.push(say(seq, `answer ${i}`, `m${i}`));
      else if (i % 5 === 2) events.push(call(seq, { toolCallId: `t${i}`, title: 'Run', kind: 'execute', status: 'pending' }));
      else if (i % 5 === 3)
        events.push(callUpdate(seq, { toolCallId: `t${i - 1}`, status: 'completed', content: [{ type: 'content', content: text('ok') }] }));
      else events.push(say(seq, ` more`, `m${i - 3}`));
    }
    let t0 = performance.now();
    const one = run(events);
    const single = performance.now() - t0;
    t0 = performance.now();
    const all = reduceAll(emptyConversation(), events);
    const batch = performance.now() - t0;
    expect(one.items).toHaveLength(3000);
    expect(all.items).toEqual(one.items);
    expect(single).toBeLessThan(1500);
    expect(batch).toBeLessThan(300);
  });
});

describe('an earlier page of the conversation', () => {
  it('goes before the items, its overlap passed over', () => {
    const later = run([prompt(10, 'c'), say(11, 'd')]);
    const c = prepend(later, [prompt(1, 'a'), say(2, 'b'), prompt(10, 'c'), say(11, 'd')]);
    expect(texts(c)).toEqual(['user:a', 'agent:b', 'user:c', 'agent:d']);
    expect(c.first).toBe(1);
    expect(c.last).toBe(11);
    expect(itemById(c, 'message:user:10')).toBe(c.items[2]);
    expect(prepend(c, [prompt(5, 'x')])).toBe(c);
  });

  it('takes a tool call’s update, a message’s chunk and a plan from the later page into its items', () => {
    const later = run([
      callUpdate(20, { toolCallId: 't', status: 'completed', content: [{ type: 'content', content: text('out') }] }),
      say(21, ' world', 'm'),
      planOf(22, ['a', 'completed']),
      say(23, 'done', 'n'),
      turn(24, 'start'),
      prompt(25, 'next'),
    ]);
    const c = prepend(later, [
      turn(1, 'start'),
      prompt(2, 'go'),
      planOf(3, ['a', 'in_progress']),
      say(4, 'hello', 'm'),
      call(5, { toolCallId: 't', title: 'Run', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }),
    ]);
    expect(texts(c)).toEqual(['user:go', 'plan:a', 'agent:hello world', 'tool:t', 'agent:done', 'user:next']);
    expect((c.items[1] as PlanItem).entries[0].status).toBe('completed');
    expect(tool(c, 't')).toMatchObject({ title: 'Run', toolKind: 'execute', status: 'completed', rawInput: { command: 'ls' } });
    expect(tool(c, 't').content).toEqual([{ type: 'content', content: text('out') }]);
    expect(c.turnStart).toBe(5);
    expect(c.turn).toBe('working');
    // The turn's plan is the later page's.
    expect(texts(reduce(c, planOf(26, ['z', 'pending'])))).toContain('plan:z');
  });

  it('continues its last message with the later page’s chunks that have no id, and drops the prompt again', () => {
    const later = run([say(10, ' more'), say(11, '!')]);
    expect(texts(prepend(later, [say(1, 'some')]))).toEqual(['agent:some more!']);
    const again = run([prompt(10, 'go'), say(11, 'ok')]);
    expect(texts(prepend(again, [turn(1, 'start'), prompt(2, 'go')]))).toEqual(['user:go', 'agent:ok']);
    expect(texts(prepend(again, [turn(1, 'start'), prompt(2, 'go'), turn(3, 'end')]))).toEqual(['user:go', 'agent:ok']);
  });

  it('is told apart from new events in a batch by its seq', () => {
    const c = run([prompt(100, 'b')]);
    const d = take(c, [say(101, 'c'), prompt(5, 'a'), say(6, 'a2')]);
    expect(texts(d)).toEqual(['user:a', 'agent:a2', 'user:b', 'agent:c']);
    expect(texts(take(d, [{ t: 'reset' }, prompt(1, 'new')]))).toEqual(['user:new']);
    expect(take(d, [])).toBe(d);
  });
});

describe('diffs', () => {
  it('compares lines by their longest common subsequence', () => {
    const d = lineDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
    expect(d.lines.map((l) => l.op + l.text)).toEqual([' a', '-b', '+B', ' c', ' d', '+e']);
    expect([d.added, d.removed, d.exact]).toEqual([2, 1, true]);
    expect(lineDiff(null, 'x\ny').lines.map((l) => l.op + l.text)).toEqual(['+x', '+y']);
    expect(lineDiff('same\n', 'same').lines).toEqual([{ op: ' ', text: 'same' }]);
    expect(splitLines('a\r\nb\n')).toEqual(['a', 'b']);
  });

  it('gives what changed as removed and added beyond its limit', () => {
    const many = (p: string) => Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `${p}${i}`).join('\n');
    const d = lineDiff(`head\n${many('a')}\ntail`, `head\n${many('b')}\ntail`);
    expect(d.exact).toBe(false);
    expect([d.added, d.removed]).toEqual([MAX_DIFF_LINES + 1, MAX_DIFF_LINES + 1]);
    expect(d.lines[0]).toEqual({ op: ' ', text: 'head' });
    expect(d.lines[1].op).toBe('-');
    expect(d.lines[d.lines.length - 1]).toEqual({ op: ' ', text: 'tail' });
  });

  it('keeps a few lines around each change', () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const now = old.map((l, i) => (i === 10 ? 'X' : l));
    const rows = hunks(lineDiff(old.join('\n'), now.join('\n')).lines, 2);
    expect(rows.map((r) => (r.op === 'skip' ? `skip ${r.count}` : r.op + r.text))).toEqual([
      'skip 8',
      ' l8',
      ' l9',
      '-l10',
      '+X',
      ' l11',
      ' l12',
      'skip 7',
    ]);
    expect(hunks(lineDiff('a', 'a').lines)).toEqual([]);
  });

  it('reads a patch’s lines by what they are, in git’s format and apply_patch’s', () => {
    const git = patchLines(
      [
        'diff --git a/x.ts b/x.ts',
        'index 1..2 100644',
        '--- a/x.ts',
        '+++ b/x.ts',
        '@@ -1,3 +1,3 @@',
        ' keep',
        '--- not a header',
        '+new',
        ' end',
        '--- a/y.ts',
        '+++ b/y.ts',
        '@@ -1 +1 @@',
        '-y',
        '+z',
      ].join('\n'),
    );
    expect(git.lines.map((l) => l.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
      'hunk',
      'ctx',
      'del',
      'add',
      'ctx',
      'meta',
      'meta',
      'hunk',
      'del',
      'add',
    ]);
    expect([git.added, git.removed]).toEqual([2, 2]);
    expect(git.paths).toEqual(['x.ts', 'y.ts']);
    const ap = patchLines(
      ['*** Begin Patch', '*** Add File: n.txt', '+hi', '*** Update File: src/a.py', '@@ def f', '-a', '+b', '*** End Patch'].join('\n'),
    );
    expect(ap.lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'add', 'meta', 'hunk', 'del', 'add', 'meta']);
    expect(ap.paths).toEqual(['n.txt', 'src/a.py']);
  });

  it('marks the lines whose first character is a mark: in hunks, and apply_patch’s added lines', () => {
    const p = patchLines(
      ['free text', '*** Add File: n.txt', '+hi', '*** Update File: a.py', '@@ def f', ' keep', '', '-a', '+b'].join('\n'),
    );
    expect(p.lines.map((l) => `${l.kind}${l.marked ? '*' : ''}`)).toEqual([
      'ctx',
      'meta',
      'add*',
      'meta',
      'hunk',
      'ctx*',
      'ctx*',
      'del*',
      'add*',
    ]);
  });

  it('counts a diff’s lines as lineDiff does, within a budget of lines compared', () => {
    const cases: [string | null, string][] = [
      ['a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n'],
      [null, 'x\ny'],
      ['same\n', 'same'],
      ['one\ntwo\nthree\n', 'one\n2\nthree\nfour\n'],
      ['a\nb\nc', ''],
    ];
    for (const [a, b] of cases) {
      const d = lineDiff(a, b);
      expect(diffStat(a, b, 1_000_000)).toEqual({ added: d.added, removed: d.removed });
    }
    // The lines both sides start and end with are not compared.
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`).join('\n');
    expect(diffStat(`${many('same', 500)}\nx\n${many('end', 500)}`, `${many('same', 500)}\ny\n${many('end', 500)}`, 1)).toEqual({
      added: 1,
      removed: 1,
    });
    // Beyond the budget: not counted.
    expect(diffStat(many('a', 300), many('b', 300), 300 * 300 - 1)).toBeUndefined();
    expect(diffStat(many('a', 300), many('b', 300), 300 * 300)).toEqual({ added: 300, removed: 300 });
    // Beyond what lineDiff compares: what differs is removed, then added.
    expect(diffStat(many('a', MAX_DIFF_LINES + 1), many('b', 3), 0)).toEqual({ added: 3, removed: MAX_DIFF_LINES + 1 });
  });
});

describe('display formulas', () => {
  it('puts a paragraph of one formula between $$ on one line as a formula block', () => {
    expect(displayMath('Roots:\n\n$$x = \\frac{1}{2}$$\n\nDone.')).toBe('Roots:\n\n$$\nx = \\frac{1}{2}\n$$\n\nDone.');
    expect(displayMath('$$a+b$$')).toBe('$$\na+b\n$$');
    expect(displayMath('  $$ a $$  \r\n\nnext')).toBe('  $$\n  a\n  $$\n\nnext');
  });

  it('leaves formulas within text, code blocks and what is no single formula as they are', () => {
    for (const md of [
      'and $$E=mc^2$$ here',
      'Text before\n$$x$$',
      '$$x$$\ntext after',
      '```\n\n$$x$$\n\n```',
      '~~~~tex\n\n$$x$$\n\n~~~\n\n$$y$$\n~~~~',
      '    $$indented code$$',
      '$$a$$ and $$b$$',
      '$$$$',
      '$$ $$',
      '$$x\\$$',
      '`$$x$$`',
      '> $$quoted$$',
    ])
      expect(displayMath(md)).toBe(md);
    // After a code block closes, a formula paragraph is one again.
    expect(displayMath('```\ncode\n```\n\n$$x$$')).toBe('```\ncode\n```\n\n$$\nx\n$$');
  });
});

describe('text of tool calls', () => {
  it('drops terminal escapes from a command’s output and keeps what a carriage return left', () => {
    expect(plainOutput('\x1b[31mred\x1b[0m \x1b]0;title\x07ok\x1b(B\x1b[?25h')).toBe('red ok');
    expect(plainOutput('10%\r50%\r100%\ndone\r\n')).toBe('100%\ndone\n');
    expect(plainOutput('bell\x07 and \x1bPdcs\x1b\\ gone')).toBe('bell and  gone');
  });

  it('names the command, pattern, URL or path a call acts on', () => {
    expect(commandOf({ command: 'ls -la' })).toBe('ls -la');
    expect(commandOf({ command: ['bash', '-lc', 'npm test'] })).toBe('npm test');
    expect(commandOf({ command: ['git', 'commit', '-m', 'a b'] })).toBe(`git commit -m 'a b'`);
    expect(commandOf({ cmd: 'x' })).toBe('x');
    expect(commandOf('ls')).toBeUndefined();
    const t = (toolKind: ToolItem['toolKind'], rawInput: unknown, locations: ToolItem['locations'] = []): ToolItem => ({
      kind: 'tool',
      id: 'x',
      title: '',
      toolKind,
      content: [],
      locations,
      rawInput,
    });
    expect(subjectOf(t('search', { pattern: 'TODO', path: '/p' }))).toBe('TODO');
    expect(subjectOf(t('fetch', { url: 'https://a.example' }))).toBe('https://a.example');
    expect(subjectOf(t('read', { file_path: '/p/a.ts' }))).toBe('/p/a.ts');
    expect(subjectOf(t('read', { file_path: '/p/a.ts' }, [{ path: '/p/a.ts' }]))).toBeUndefined();
    expect(exitCodeOf({ ...t('execute', {}), meta: { [APP_SLUG]: { exitCode: 2 } } })).toBe(2);
    expect(exitCodeOf({ ...t('execute', {}), rawOutput: { exit_code: 1 } })).toBe(1);
  });

  it('counts tokens, splits paths and reads Markdown out for people', () => {
    expect([950, 1000, 12345, 200000, 1234567].map(formatTokens)).toEqual(['950', '1k', '12.3k', '200k', '1.23M']);
    expect(splitPath('/home/u/p/src/lib/a.ts')).toEqual({ name: 'a.ts', dir: '…/src/lib' });
    expect(splitPath('/a/b.ts')).toEqual({ name: 'b.ts', dir: '/a' });
    expect(splitPath('b.ts')).toEqual({ name: 'b.ts', dir: '' });
    expect(spokenText('## Title\n\n**bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe(
      'Title\n\n bold and code \n\n a b \n\n 1 2',
    );
    expect(spokenText('a | b\n:-- | --:\nc | d')).toBe('a b\n\nc d');
  });

  it('reads out the start of a message, in time linear in it', () => {
    // Runs of line breaks, spaces, dashes and pipes that are no table's rule.
    for (const md of ['\n'.repeat(200_000) + 'x', ' '.repeat(200_000) + 'x', '|-'.repeat(100_000) + ' x', `${'-'.repeat(100_000)} x`])
      expect(spokenText(md).length).toBeLessThanOrEqual(4000);
  });
});

describe('events of shapes no parser makes', () => {
  it('are passed over or counted as unknown, and never give an object as text', () => {
    const obj = { a: 1 };
    const c = reduceAll(emptyConversation(), [
      null,
      7,
      'text',
      { seq: 1, t: 'user', content: [null, { type: 'text', text: obj }, { type: 'text', text: 'hi' }], at: obj },
      { seq: 2, t: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: obj } } },
      { seq: 3, t: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } },
      { seq: 4, t: 'turn', state: 'error', error: { message: obj } },
    ] as unknown as SourceEvent[]);
    const user = c.items[0] as MessageItem;
    expect(user.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(user.at).toBeUndefined();
    expect(blocksText((c.items[1] as MessageItem).content)).toBe('ok');
    expect(c.items[2]).toMatchObject({ kind: 'notice', method: NOTICES.error });
    expect((c.items[2] as { params?: unknown }).params).toBeUndefined();
    expect(c.unknown).toBe(4);
    expect(take(emptyConversation(), [null, { t: 'reset' }] as unknown as SourceEvent[]).items).toEqual([]);
    expect(prepend(c, [null] as unknown as SourceEvent[])).toBe(c);
    expect(blocksText([null, { type: 'text', text: obj }, { type: 'text', text: 'x' }] as never)).toBe('x');
    expect([asText('a'), asText(obj), asText(1), asText(undefined)]).toEqual(['a', undefined, undefined, undefined]);
  });
});
