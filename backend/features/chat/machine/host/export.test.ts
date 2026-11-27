import { describe, expect, test } from 'bun:test';
import { Notice, noticeMethod } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { exportJson, exportMarkdown, wrapSeedPrompt } from './export.ts';

describe('exportMarkdown', () => {
  test('formats user turns, assistant replies, tool summaries, Q&A, and latest plan', () => {
    const events: chat.Event[] = [
      {
        seq: 1,
        t: chat.EventType.User,
        content: [
          { type: 'text', text: 'Inspect the config' },
          { type: 'resource_link', uri: 'file:///repo/app.ts', name: 'app.ts' },
          { type: 'image', mimeType: 'image/png', data: 'AA==' },
        ],
      },
      {
        seq: 2,
        t: chat.EventType.Update,
        item: 'm1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reading ' } },
      },
      {
        seq: 3,
        t: chat.EventType.Update,
        item: 'm1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'app.ts now.' } },
      },
      {
        seq: 4,
        t: chat.EventType.Update,
        item: 't1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Read file',
          kind: 'read',
          status: 'completed',
          locations: [{ path: 'src/app.ts' }],
        },
      },
      {
        seq: 5,
        t: chat.EventType.Update,
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'Read app.ts', status: 'completed' },
            { content: 'Fix bug', status: 'in_progress' },
          ],
        },
      },
      {
        seq: 6,
        t: chat.EventType.Question,
        id: 'q1',
        questions: [{ id: 'env', question: 'Target env?' }],
      },
      {
        seq: 7,
        t: chat.EventType.QuestionDone,
        id: 'q1',
        by: chat.By.User,
        answers: { env: ['staging'] },
      },
      { seq: 8, t: chat.EventType.Turn, state: chat.TurnState.End, stopReason: 'end_turn' },
    ];
    const md = exportMarkdown(events, { title: 'Debug config', kind: 'claude', cwd: '/repo' });
    expect(md).toContain('# Conversation Handoff');
    expect(md).toContain('- **Title:** Debug config');
    expect(md).toContain('- **Previous agent:** claude');
    expect(md).toContain('Inspect the config');
    expect(md).toContain('@app.ts');
    expect(md).toContain('[image attached]');
    expect(md).toContain('Reading app.ts now.');
    expect(md).toContain('Read file (src/app.ts) [completed]');
    expect(md).toContain('**Q:** Target env?');
    expect(md).toContain('**A:** staging');
    expect(md).toContain('- [x] Read app.ts');
    expect(md).toContain('- [-] Fix bug');
  });

  test('bounds output size by keeping recent turns and adding elision note', () => {
    const events: chat.Event[] = [];
    for (let i = 1; i <= 20; i++) {
      events.push({ seq: i * 2 - 1, t: chat.EventType.User, content: [{ type: 'text', text: `Turn ${i}: ${'x'.repeat(300)}` }] });
      events.push({
        seq: i * 2,
        t: chat.EventType.Update,
        item: `a${i}`,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Reply ${i}: ${'y'.repeat(300)}` } },
      });
    }
    const md = exportMarkdown(events, { maxBytes: 2500 });
    expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(2500);
    expect(md).toContain('Earlier turns omitted');
    expect(md).toContain('Turn 20');
    expect(md).not.toContain('Turn 1:');
  });

  test('includes taken queued messages and ignores cancelled or still-waiting ones', () => {
    const events: chat.Event[] = [
      { seq: 1, t: chat.EventType.User, content: [{ type: 'text', text: 'Initial task' }] },
      {
        seq: 2,
        t: chat.EventType.Update,
        item: 'a1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on initial task.' } },
      },
      {
        seq: 3,
        t: chat.EventType.Queued,
        message: 'q-taken',
        state: chat.QueuedState.Waiting,
        content: [{ type: 'text', text: 'Steer: also update tests' }],
      },
      {
        seq: 4,
        t: chat.EventType.Queued,
        message: 'q-cancel',
        state: chat.QueuedState.Waiting,
        content: [{ type: 'text', text: 'Withdrawn follow-up' }],
      },
      {
        seq: 5,
        t: chat.EventType.Queued,
        message: 'q-cancel',
        state: chat.QueuedState.Cancelled,
      },
      {
        seq: 6,
        t: chat.EventType.Queued,
        message: 'q-taken',
        state: chat.QueuedState.Taken,
      },
      {
        seq: 7,
        t: chat.EventType.Update,
        item: 'a2',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Updated tests too.' } },
      },
      {
        seq: 8,
        t: chat.EventType.Queued,
        message: 'q-waiting',
        state: chat.QueuedState.Waiting,
        content: [{ type: 'text', text: 'Still pending in queue' }],
      },
    ];
    const md = exportMarkdown(events, { title: 'Steered chat', kind: 'codex' });
    expect(md).toContain('Initial task');
    expect(md).toContain('Working on initial task.');
    expect(md).toContain('Steer: also update tests');
    expect(md).toContain('Updated tests too.');
    expect(md).not.toContain('Withdrawn follow-up');
    expect(md).not.toContain('Still pending in queue');
  });

  test('caps oversized plan entries within maxBytes', () => {
    const events: chat.Event[] = [
      { seq: 1, t: chat.EventType.User, content: [{ type: 'text', text: 'Build a plan' }] },
      {
        seq: 2,
        t: chat.EventType.Update,
        update: {
          sessionUpdate: 'plan',
          entries: Array.from({ length: 100 }, (_, i) => ({
            content: `Step ${i + 1}: ${'z'.repeat(120)}`,
            status: 'pending',
          })),
        },
      },
    ];
    const md = exportMarkdown(events, { maxBytes: 2500 });
    expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(2500);
    expect(md).toContain('Build a plan');
    expect(md).toContain('## Latest Plan');
  });

  test('wrapSeedPrompt prepends handoff context block before user content', () => {
    const wrapped = wrapSeedPrompt('# Handoff', [{ type: 'text', text: 'Next question' }]);
    expect(wrapped).toHaveLength(2);
    expect((wrapped[0] as { text: string }).text).toContain('<handoff_context>\n# Handoff\n</handoff_context>');
    expect(wrapped[1]).toEqual({ type: 'text', text: 'Next question' });
  });

  test('preserves original user request, modified files, recent issues, and compaction markers on budgets >= 4 KiB', () => {
    const events: chat.Event[] = [
      { seq: 1, t: chat.EventType.User, content: [{ type: 'text', text: 'Original goal: migrate auth to OAuth2' }] },
      {
        seq: 2,
        t: chat.EventType.Update,
        item: 't-edit',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't-edit',
          title: 'Edit file',
          kind: 'edit',
          status: 'completed',
          locations: [{ path: 'src/auth.ts' }],
          content: [{ type: 'diff', path: 'src/auth.ts', oldText: 'a', newText: 'b' }],
        },
      },
      {
        seq: 3,
        t: chat.EventType.Update,
        item: 't-fail',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't-fail',
          title: 'Run tests',
          kind: 'execute',
          status: 'failed',
          rawInput: { cmd: ['bash', '-lc', 'bun test auth'] },
          rawOutput: { stderr: 'TypeError: token undefined' },
        },
      },
      { seq: 4, t: chat.EventType.Notice, method: noticeMethod(Notice.Compacted) },
    ];
    for (let i = 2; i <= 16; i++) {
      events.push({ seq: i * 10, t: chat.EventType.User, content: [{ type: 'text', text: `Middle turn ${i}: ${'m'.repeat(300)}` }] });
      events.push({
        seq: i * 10 + 1,
        t: chat.EventType.Update,
        item: `m${i}`,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Reply ${i}: ${'r'.repeat(300)}` } },
      });
    }
    const md = exportMarkdown(events, { title: 'OAuth migration', kind: 'claude', cwd: '/repo', maxBytes: 5000 });
    expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(5000);
    expect(md).toContain('## Original Request');
    expect(md).toContain('Original goal: migrate auth to OAuth2');
    expect(md).toContain('## Files Modified');
    expect(md).toContain('`src/auth.ts`');
    expect(md).toContain('## Recent Issues');
    expect(md).toContain('TypeError: token undefined');
    expect(md).toContain('Earlier turns omitted');
    expect(md).toContain('Middle turn 16');
  });
});

describe('exportJson', () => {
  test('exports lossless metadata and stored events while skipping live increments', () => {
    const c: chat.Chat = {
      id: 'c0123456789abcdef',
      kind: 'agy',
      title: 'Raw test',
      cwd: '/repo',
      sessionId: 'sess-1',
      state: chat.State.Idle,
      status: chat.Status.Idle,
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:05:00Z',
      seq: 3,
      seen: 3,
      capabilities: {
        images: true,
        compact: true,
        queue: true,
        plan: false,
        questions: false,
        effort: true,
        model: true,
        cancelQueued: true,
      },
    };
    const events: chat.Event[] = [
      { seq: 1, t: chat.EventType.User, content: [{ type: 'text', text: 'hello' }] },
      {
        t: chat.EventType.Update,
        live: true,
        item: 'm1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      },
      {
        seq: 2,
        t: chat.EventType.Update,
        item: 'm1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi there' } },
      },
    ];
    const data = exportJson(events, { chat: c, upToSeq: 2, exportedAt: '2026-01-01T00:10:00Z' });
    expect(data.version).toBe(1);
    expect(data.exportedAt).toBe('2026-01-01T00:10:00Z');
    expect(data.chat).toMatchObject({ id: c.id, kind: 'agy', title: 'Raw test', cwd: '/repo', sessionId: 'sess-1' });
    expect(data.upToSeq).toBe(2);
    expect(data.truncated).toBeUndefined();
    expect(data.events).toHaveLength(2);
    expect(data.events.every((e) => !e.live)).toBe(true);
  });

  test('truncates oldest events when exceeding maxBytes', () => {
    const c: chat.Chat = {
      id: 'c0123456789abcdef',
      kind: 'claude',
      title: 'Big',
      cwd: '/repo',
      sessionId: '',
      state: chat.State.Idle,
      status: chat.Status.Idle,
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:05:00Z',
      seq: 100,
      seen: 100,
      capabilities: {
        images: false,
        compact: false,
        queue: false,
        plan: false,
        questions: false,
        effort: false,
        model: false,
        cancelQueued: false,
      },
    };
    const events: chat.Event[] = Array.from({ length: 100 }, (_, i) => ({
      seq: i + 1,
      t: chat.EventType.User,
      content: [{ type: 'text', text: `Event ${i + 1}: ${'a'.repeat(1200)}` }],
    }));
    const data = exportJson(events, { chat: c, exportedAt: '2026-01-01T00:10:00Z', maxBytes: 64 << 10 });
    expect(Buffer.byteLength(JSON.stringify(data), 'utf8')).toBeLessThanOrEqual(64 << 10);
    expect(data.truncated).toBe(true);
    expect(data.omittedEvents).toBeGreaterThan(0);
    expect(data.events.at(-1)?.seq).toBe(100);
  });
});
