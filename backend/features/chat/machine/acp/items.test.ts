// The mapping of an agent's session updates to chat events, and what a chat
// states of its agent's session.
import { describe, expect, test } from 'bun:test';
import * as chat from '#shared/proto/chatproto/index.ts';
import { discard } from '#shared/lib/log.ts';
import { Items, MAX_TOOLS, UPDATE_MESSAGE, UPDATE_THOUGHT, UPDATE_USER } from './items.ts';
import { ACP_TIMING, AcpSession, permissionKind, permissionOptions } from './session.ts';
import { configOptions, modeValue, modesOption, slashCommands, type Obj } from './state.ts';
import { Host } from './testing.ts';

/** Records what items makes. */
class Stream {
  evs: chat.Event[] = [];
  store = (ev: chat.Event) => void this.evs.push(ev);

  /** Each event as compact text: "live item text" or "item text". */
  lines(): string[] {
    return this.evs.map((ev) => {
      const u = ev.update as { sessionUpdate: string; content?: { type?: string; text?: string }; status?: string };
      let l = `${ev.item} ${u.sessionUpdate} `;
      l += u.content?.type ? `${u.content.type}:${u.content.text ?? ''}` : (u.status ?? '');
      return ev.live ? 'live ' + l : l;
    });
  }
}

const chunk = (kind: string, text: string, id = ''): Obj => ({
  sessionUpdate: kind,
  content: { type: 'text', text },
  ...(id ? { messageId: id } : {}),
});

const feed = (it: Items, ...updates: Obj[]) => {
  for (const u of updates) it.update(u.sessionUpdate as string, u);
};

describe('items', () => {
  test('chunks stream live and are stored whole when another kind comes, the message id changes or the turn ends; an agent image is an item of its own', () => {
    const s = new Stream();
    const it = new Items('p', true, s.store);
    feed(
      it,
      chunk(UPDATE_THOUGHT, 'Let me'),
      chunk(UPDATE_THOUGHT, ' think'),
      chunk(UPDATE_THOUGHT, ''),
      chunk(UPDATE_MESSAGE, 'Hello'),
      chunk(UPDATE_MESSAGE, ' world'),
      { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AA==' } },
      chunk(UPDATE_MESSAGE, 'a', 'msg_1'),
      chunk(UPDATE_MESSAGE, 'b', 'msg_1'),
      chunk(UPDATE_MESSAGE, 'c', 'msg_2'),
      chunk(UPDATE_MESSAGE, 'd', 'msg_1'),
      chunk(UPDATE_USER, 'an echo'),
    );
    it.endTurn();
    expect(s.lines()).toEqual([
      'live p-t-1 agent_thought_chunk text:Let me',
      'live p-t-1 agent_thought_chunk text: think',
      'p-t-1 agent_thought_chunk text:Let me think',
      'live p-m-2 agent_message_chunk text:Hello',
      'live p-m-2 agent_message_chunk text: world',
      'p-m-2 agent_message_chunk text:Hello world',
      'p-m-3 agent_message_chunk image:',
      'live m-msg_1 agent_message_chunk text:a',
      'live m-msg_1 agent_message_chunk text:b',
      'm-msg_1 agent_message_chunk text:ab',
      'live m-msg_2 agent_message_chunk text:c',
      'm-msg_2 agent_message_chunk text:c',
      'live m-msg_1~2 agent_message_chunk text:d',
      'm-msg_1~2 agent_message_chunk text:d',
    ]);
    expect((s.evs[9]!.update as Obj).messageId).toBe('msg_1');
  });

  test('a long message is stored in items of their own, each within MAX_EVENT however its text escapes', () => {
    const s = new Stream();
    const it = new Items('p', true, s.store);
    const part = '\x01'.repeat(32 << 10);
    for (let i = 0; i < 9; i++) feed(it, chunk(UPDATE_MESSAGE, part));
    it.endTurn();
    const stored = s.evs.filter((ev) => !ev.live);
    expect(stored.length).toBe(3);
    expect(new Set(stored.map((ev) => ev.item)).size).toBe(3);
    for (const ev of stored) expect(Buffer.byteLength(JSON.stringify(ev))).toBeLessThanOrEqual(chat.MAX_EVENT);
  });

  test('a tool call is stored whole when it changes but for its content and output, which go live while it runs and are stored at the turn end', () => {
    const s = new Stream();
    const it = new Items('p', true, s.store);
    feed(
      it,
      chunk(UPDATE_MESSAGE, 'Running it'),
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash', kind: 'execute', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress', rawInput: { command: 'ls' } },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'a' } }],
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [{ type: 'content', content: { type: 'text', text: 'a\nb' } }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c2', title: 'Write', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'completed' },
      { sessionUpdate: 'tool_call_update' },
      { sessionUpdate: 'plan', entries: [] },
      { sessionUpdate: 'plan', entries: [{ content: 'x', priority: 'high', status: 'pending' }] },
    );
    expect(it.toolKind('c1')).toBe('execute');
    const merged = it.toolCall({ toolCallId: 'c1', title: 'Run ls' }) as Obj;
    expect([merged.title, merged.kind, merged.rawInput, merged.sessionUpdate]).toEqual(['Run ls', 'execute', { command: 'ls' }, undefined]);
    it.endTurn();
    expect(s.lines()).toEqual([
      'live p-m-1 agent_message_chunk text:Running it',
      'p-m-1 agent_message_chunk text:Running it',
      'c1 tool_call pending',
      'c1 tool_call in_progress',
      'live c1 tool_call_update ',
      'live c1 tool_call_update ',
      'c2 tool_call in_progress',
      'c2 tool_call completed',
      'p-p-2 plan ',
      'p-p-2 plan ',
      'c1 tool_call in_progress',
    ]);
    // The live updates are increments of the text, which the clients
    // append; ACP's replace the whole content.
    for (const [i, want] of ['a', '\nb'].entries()) {
      const ev = s.evs[4 + i]!;
      expect([ev.live, ev.item, JSON.stringify(ev.update)]).toEqual([
        true,
        'c1',
        `{"sessionUpdate":"tool_call_update","toolCallId":"c1","content":[{"type":"content","content":{"type":"text","text":${JSON.stringify(want)}}}]}`,
      ]);
    }
    const last = s.evs.at(-1)!.update as Obj;
    expect(JSON.stringify(last.content)).toContain('a\\nb');
    expect(last.rawInput).toEqual({ command: 'ls' });
    // A new turn knows no tool calls.
    expect(it.toolKind('c1')).toBe('');

    // Without live (an import), every change is stored.
    const imp = new Stream();
    const h = new Items('h', false, imp.store);
    feed(
      h,
      chunk(UPDATE_MESSAGE, 'x'),
      { sessionUpdate: 'tool_call', toolCallId: 'c1', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [] },
    );
    h.endTurn();
    expect(imp.lines()).toEqual(['h-m-1 agent_message_chunk text:x', 'c1 tool_call in_progress', 'c1 tool_call in_progress']);
  });

  test('what a turn holds of tool calls is bounded: beyond MAX_TOOLS, updates are stored as they come', () => {
    const s = new Stream();
    const it = new Items('p', true, s.store);
    for (let i = 0; i < MAX_TOOLS + 2; i++) feed(it, { sessionUpdate: 'tool_call', toolCallId: `c${i}`, status: 'pending' });
    expect([it.toolCount, s.evs.length]).toEqual([MAX_TOOLS, MAX_TOOLS + 2]);
  });

  test('cancels only unfinished tools when a turn aborts, including tools with a null status update', () => {
    const s = new Stream();
    const it = new Items('p', true, s.store);
    feed(
      it,
      { sessionUpdate: 'tool_call', toolCallId: 'open', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'open', status: null, title: 'Still running' },
      { sessionUpdate: 'tool_call', toolCallId: 'done', status: 'completed' },
      { sessionUpdate: 'tool_call', toolCallId: 'detached', status: 'in_progress' },
    );
    it.endTurn((id) => id !== 'detached');
    expect(s.lines()).toEqual([
      'open tool_call in_progress',
      'open tool_call in_progress',
      'done tool_call completed',
      'detached tool_call in_progress',
      'open tool_call cancelled',
    ]);
    expect(s.evs.at(-1)?.update).toMatchObject({ title: 'Still running' });
  });

  test('a replayed user message: its chunks are its blocks, without what the agent added for the model', () => {
    const got: unknown[][] = [];
    const it = new Items('h', false, () => {});
    it.user = (c) => void got.push(c);
    feed(
      it,
      chunk(UPDATE_USER, 'Count to 3'),
      chunk(UPDATE_USER, '<system-reminder>\nThe previous turn was interrupted.\n</system-reminder>'),
      { sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AA==' } },
      chunk(UPDATE_USER, 'What color?<system-reminder>date</system-reminder>'),
      chunk(UPDATE_MESSAGE, 'Red'),
      chunk(UPDATE_USER, '<system-reminder>only</system-reminder>'),
    );
    it.close();
    expect(got).toEqual([
      [
        { type: 'text', text: 'Count to 3' },
        { type: 'image', mimeType: 'image/png', data: 'AA==' },
        { type: 'text', text: 'What color?' },
      ],
      [],
    ]);
  });
});

describe('what a chat states', () => {
  test('configuration options: select only, grouped values flattened; session modes as an option; modes by meaning', () => {
    const got = configOptions([
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'b',
        options: [
          { group: 'fast', name: 'Fast', options: [{ value: 'a', name: 'A' }] },
          { value: 'b', name: 'B', description: 'the best' },
        ],
      },
      { type: 'boolean', id: 'web', name: 'Web', currentValue: true },
      { type: 'select', id: 'broken', currentValue: 3, options: [] },
      { type: 'select', name: 'no id', currentValue: 'x', options: [] },
      'nonsense',
    ]);
    expect(JSON.stringify(got)).toBe(
      '[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"b","options":[{"value":"a","name":"A"},{"value":"b","name":"B","description":"the best"}]}]',
    );
    expect(configOptions({})).toBeNull();
    expect(configOptions([])).toEqual([]);

    const o = modesOption(
      {
        currentModeId: 'ask',
        availableModes: [
          { id: 'ask', name: 'Ask' },
          { id: 'yolo', name: 'YOLO' },
        ],
      },
      'mode',
    );
    expect([o?.id, o?.category, o?.currentValue, o?.options?.length]).toEqual(['mode', chat.Category.Mode, 'ask', 2]);
    expect(modesOption({ availableModes: [] }, 'mode')).toBeNull();

    const kimi: chat.ConfigOption = {
      id: 'mode',
      name: '',
      type: 'select',
      currentValue: '',
      options: ['default', 'plan', 'auto', 'yolo'].map((value) => ({ value, name: '' })),
    };
    for (const [mode, want] of [
      [chat.Mode.Default, 'default'],
      [chat.Mode.Plan, 'plan'],
      [chat.Mode.Full, 'yolo'],
      [chat.Mode.AcceptEdits, ''],
      ['auto', 'auto'],
      ['nope', ''],
    ]) {
      expect([mode, modeValue(kimi, mode!)]).toEqual([mode, want]);
    }

    // Antigravity (agy) exposes ['default', 'accept-edits', 'auto', 'plan']:
    // global Full must map to 'auto' (not fall back to default or accept-edits).
    const agy: chat.ConfigOption = {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      currentValue: 'default',
      options: ['default', 'accept-edits', 'auto', 'plan'].map((value) => ({ value, name: value })),
    };
    for (const [mode, want] of [
      [chat.Mode.Default, 'default'],
      [chat.Mode.AcceptEdits, 'accept-edits'],
      [chat.Mode.Plan, 'plan'],
      [chat.Mode.Full, 'auto'],
    ]) {
      expect([mode, modeValue(agy, mode!)]).toEqual([mode, want]);
    }
  });

  test('slash commands', () => {
    expect(
      slashCommands({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'compact', description: 'Compact', input: { hint: '<instructions>' } },
          { name: 'help', input: null },
          { name: ' ' },
          {},
        ],
      }),
    ).toEqual([{ name: 'compact', description: 'Compact', argumentHint: '<instructions>' }, { name: 'help' }]);
    expect(slashCommands({ sessionUpdate: 'available_commands_update' })).toBeNull();
  });

  test('permission kinds and options: never one that allows or rejects for good', () => {
    expect(['execute', 'edit', 'move', 'fetch', ''].map(permissionKind).join('')).toBe('commandfilefiletooltool');
    expect(
      permissionOptions([
        { optionId: 'a', name: 'Yes', kind: 'allow_once' },
        { optionId: 'b', name: 'Always', kind: 'allow_always' },
        { optionId: 'c', name: 'No', kind: 'reject_once' },
        { optionId: 'd', name: 'Never', kind: 'reject_always' },
        { optionId: '', name: 'Nothing', kind: 'allow_once' },
      ]),
    ).toEqual([
      { optionId: 'a', name: 'Yes', kind: 'allow_once' },
      { optionId: 'c', name: 'No', kind: 'reject_once' },
    ]);
  });

  test('the values of a mode option that may give full access are marked: every value but those known to ask, in an option of category mode and in one made of session modes', () => {
    const full = (cfg: chat.ConfigOption[]) => cfg.flatMap((o) => (o.options ?? []).filter((v) => v.full).map((v) => `${o.id}=${v.value}`));
    const s = new AcpSession('kimi', discard, new Host('/x'), ACP_TIMING, 'x');
    s.takeConfig(
      [
        {
          type: 'select',
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          currentValue: 'default',
          options: ['default', 'plan', 'auto', 'yolo'].map((value) => ({ value, name: value })),
        },
        {
          type: 'select',
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'yolo',
          options: [{ value: 'yolo', name: 'A model called yolo' }],
        },
      ],
      undefined,
    );
    expect(full(s.configOptions)).toEqual(['mode=auto', 'mode=yolo']);
    const o = new AcpSession('other', discard, new Host('/x'), ACP_TIMING, 'x');
    o.takeConfig(undefined, {
      currentModeId: 'ask',
      availableModes: ['ask', 'bypassPermissions', 'architect', 'accept-edits'].map((id) => ({ id, name: id })),
    });
    expect(full(o.configOptions)).toEqual(['mode=bypassPermissions', 'mode=architect']);
  });
});
