import { describe, expect, test } from 'bun:test';
import * as chat from '#shared/proto/chatproto/index.ts';
import { exportMarkdown, wrapSeedPrompt } from './export.ts';

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
    expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(2700);
    expect(md).toContain('Earlier turns omitted');
    expect(md).toContain('Turn 20');
    expect(md).not.toContain('Turn 1:');
  });

  test('wrapSeedPrompt prepends handoff context block before user content', () => {
    const wrapped = wrapSeedPrompt('# Handoff', [{ type: 'text', text: 'Next question' }]);
    expect(wrapped).toHaveLength(2);
    expect((wrapped[0] as { text: string }).text).toContain('<handoff_context>\n# Handoff\n</handoff_context>');
    expect(wrapped[1]).toEqual({ type: 'text', text: 'Next question' });
  });
});
