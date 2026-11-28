import { describe, expect, test } from 'bun:test';
import { Notice, noticeMethod } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import {
  buildHandoffSeed,
  estimatePromptTokens,
  estimateTokens,
  parseHandoffSeed,
  renderAttributedContext,
  renderNativeHistoryMessages,
  selectHandoff,
  summarizeHandoffNotice,
} from './handoff.ts';

describe('handoff compiler', () => {
  test('estimateTokens accounts for ASCII, code punctuation, and CJK', () => {
    expect(estimateTokens('')).toBe(0);
    const ascii = estimateTokens('hello world this is plain prose');
    const cjk = estimateTokens('你好世界这是一段中文对话内容测试');
    const code = estimateTokens('{a: [1, 2], b: (x) => x + 1}');
    expect(ascii).toBeGreaterThan(0);
    expect(cjk).toBeGreaterThan(ascii); // CJK chars cost ~1.15 tokens/char vs ~0.25/char for ASCII
    expect(code).toBeGreaterThan(Math.floor(code * 0.5));
    expect(
      estimatePromptTokens([
        { type: 'text', text: 'fix bug' },
        { type: 'image', mimeType: 'image/png', data: 'AA==' },
      ]),
    ).toBeGreaterThan(1024);
  });

  test('short conversations stay 100% intact without artificial per-turn chopping', () => {
    // A single 30 KiB user message well under the 96 KiB default budget must NOT be truncated.
    const bigSpec = 'SPEC_START ' + 'requirement '.repeat(2400) + 'SPEC_END';
    const events: chat.Event[] = [
      { seq: 1, t: chat.EventType.User, content: [{ type: 'text', text: bigSpec }] },
      {
        seq: 2,
        t: chat.EventType.Update,
        item: 'a1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Understood the full spec.' } },
      },
      { seq: 3, t: chat.EventType.Turn, state: chat.TurnState.End, stopReason: 'end_turn' },
    ];
    const seed = buildHandoffSeed([{ chatId: 'c0000000000000001', kind: 'claude', cwd: '/repo', events }], {
      title: 'Big spec',
      cwd: '/repo',
      targetKind: 'codex',
    });
    const sel = selectHandoff(seed);
    expect(sel.truncated).toBe(false);
    expect(sel.keptTurns).toHaveLength(1);
    expect(sel.omittedSpan).toBeUndefined();
    const text = renderAttributedContext(sel);
    expect(text).toContain('SPEC_START');
    expect(text).toContain('SPEC_END');
    expect(text).toContain('Understood the full spec.');
    expect(text).not.toContain('Omitted History Reference');
  });

  test('strips private reasoning, permissions, subagent internals, live deltas, and binary images while preserving relative paths', () => {
    const events: chat.Event[] = [
      {
        seq: 1,
        t: chat.EventType.User,
        content: [
          { type: 'text', text: 'Fix login bug' },
          { type: 'resource_link', uri: 'file:///repo/src/auth/login.ts', name: 'login.ts' },
          { type: 'image', mimeType: 'image/png', data: 'SECRET_BASE64_PAYLOAD_XXXX' },
        ],
      },
      {
        t: chat.EventType.Update,
        live: true,
        item: 'm1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LIVE_DELTA_NOISE' } },
      },
      {
        seq: 2,
        t: chat.EventType.Update,
        item: 'th1',
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE_CHAIN_OF_THOUGHT' } },
      },
      {
        seq: 3,
        t: chat.EventType.Permission,
        id: 'p1',
        kind: 'command',
        toolCall: { toolCallId: 't1', title: 'INTERNAL_PERMISSION_STATE' },
        options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
      },
      {
        seq: 4,
        t: chat.EventType.Update,
        parent: 'sub-call-1',
        item: 'sub-msg',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SUBAGENT_PRIVATE_TEXT' } },
      },
      {
        seq: 5,
        t: chat.EventType.Update,
        item: 'a1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixed token validation.' } },
      },
      { seq: 6, t: chat.EventType.Turn, state: chat.TurnState.End, stopReason: 'end_turn' },
    ];
    const seed = buildHandoffSeed([{ chatId: 'c0000000000000002', kind: 'claude', cwd: '/repo', events }], { cwd: '/repo' });
    const ctx = renderAttributedContext(selectHandoff(seed));
    expect(ctx).toContain('[file: src/auth/login.ts]');
    expect(ctx).not.toContain('@login.ts');
    expect(ctx).toContain('[image omitted: image/png]');
    expect(ctx).not.toContain('SECRET_BASE64_PAYLOAD_XXXX');
    expect(ctx).not.toContain('PRIVATE_CHAIN_OF_THOUGHT');
    expect(ctx).not.toContain('INTERNAL_PERMISSION_STATE');
    expect(ctx).not.toContain('SUBAGENT_PRIVATE_TEXT');
    expect(ctx).not.toContain('LIVE_DELTA_NOISE');
    expect(ctx).toContain('Fixed token validation.');
  });

  test('preserves key command results for BOTH completed execute commands and failed tools', () => {
    const events: chat.Event[] = [
      { seq: 1, t: chat.EventType.User, content: [{ type: 'text', text: 'Run tests and inspect status' }] },
      {
        seq: 2,
        t: chat.EventType.Update,
        item: 't-read',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't-read',
          title: 'Read file',
          kind: 'read',
          status: 'completed',
          locations: [{ path: '/repo/src/app.ts' }],
          content: [{ type: 'content', content: { type: 'text', text: 'FULL_READ_FILE_DUMP_SHOULD_NOT_APPEAR' } }],
        },
      },
      {
        seq: 3,
        t: chat.EventType.Update,
        item: 't-exec-ok',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't-exec-ok',
          title: 'git status --short',
          kind: 'execute',
          status: 'completed',
          rawInput: { command: 'git status --short' },
          content: [{ type: 'content', content: { type: 'text', text: 'M src/auth.ts\nA src/oauth.ts' } }],
          _meta: { veldr: { exitCode: 0 } },
        },
      },
      {
        seq: 4,
        t: chat.EventType.Update,
        item: 't-exec-fail',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't-exec-fail',
          title: 'bun test auth',
          kind: 'execute',
          status: 'failed',
          rawInput: { cmd: ['bash', '-lc', 'bun test auth'] },
          content: [{ type: 'content', content: { type: 'text', text: 'FAIL auth.test.ts: expected 200 received 401' } }],
          _meta: { veldr: { exitCode: 1 } },
        },
      },
      { seq: 5, t: chat.EventType.Turn, state: chat.TurnState.End, stopReason: 'end_turn' },
    ];
    const seed = buildHandoffSeed([{ chatId: 'c0000000000000003', kind: 'codex', cwd: '/repo', events }], { cwd: '/repo' });
    const ctx = renderAttributedContext(selectHandoff(seed));
    expect(ctx).toContain('M src/auth.ts');
    expect(ctx).toContain('exit=0');
    expect(ctx).toContain('FAIL auth.test.ts: expected 200 received 401');
    expect(ctx).toContain('exit=1');
    expect(ctx).not.toContain('FULL_READ_FILE_DUMP_SHOULD_NOT_APPEAR');
  });

  test('long conversation prioritizes original request, recent turns, key command results from omitted turns, plan, and omission references', () => {
    const events: chat.Event[] = [
      { seq: 1, t: chat.EventType.User, content: [{ type: 'text', text: 'INITIAL_GOAL: migrate auth subsystem to OAuth2 PKCE' }] },
      {
        seq: 2,
        t: chat.EventType.Update,
        item: 'e1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'e1',
          title: 'Edit file',
          kind: 'edit',
          status: 'completed',
          locations: [{ path: '/repo/src/oauth.ts' }],
          content: [{ type: 'diff', path: '/repo/src/oauth.ts', oldText: 'a', newText: 'b' }],
        },
      },
      {
        seq: 3,
        t: chat.EventType.Update,
        item: 'c1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Run tests',
          kind: 'execute',
          status: 'failed',
          rawInput: { command: 'bun test oauth' },
          rawOutput: { stderr: 'OAuthError: invalid_grant during PKCE verification' },
          _meta: { veldr: { exitCode: 1 } },
        },
      },
      {
        seq: 4,
        t: chat.EventType.Update,
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'Implement PKCE verifier', status: 'completed' },
            { content: 'Fix token refresh race', status: 'in_progress' },
          ],
        },
      },
      { seq: 5, t: chat.EventType.Turn, state: chat.TurnState.End, stopReason: 'end_turn' },
    ];
    for (let i = 2; i <= 18; i++) {
      const base = i * 10;
      events.push({ seq: base, t: chat.EventType.User, content: [{ type: 'text', text: `Middle turn ${i}: ${'detail '.repeat(60)}` }] });
      events.push({
        seq: base + 1,
        t: chat.EventType.Update,
        item: `a${i}`,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Reply ${i}: ${'analysis '.repeat(60)}` } },
      });
      events.push({ seq: base + 2, t: chat.EventType.Turn, state: chat.TurnState.End, stopReason: 'end_turn' });
    }
    const seed = buildHandoffSeed([{ chatId: 'c0000000000000004', kind: 'claude', cwd: '/repo', events }], {
      title: 'OAuth2 migration',
      cwd: '/repo',
      targetKind: 'codex',
      maxBytes: 6144,
    });
    const sel = selectHandoff(seed);
    expect(sel.truncated).toBe(true);
    expect(sel.originalRequest?.text).toContain('INITIAL_GOAL: migrate auth subsystem to OAuth2 PKCE');
    expect(sel.omittedSpan).toBeDefined();
    expect(sel.omittedSpan!.count).toBeGreaterThan(0);
    expect(sel.omittedSpan!.sources[0]?.chatId).toBe('c0000000000000004');
    expect(sel.keptTurns.at(-1)?.index).toBe(18);
    expect(sel.latestPlan).toContain('- [-] Fix token refresh race');

    const ctx = renderAttributedContext(sel);
    expect(Buffer.byteLength(ctx, 'utf8')).toBeLessThanOrEqual(6144);
    expect(ctx).toContain('## Original Request (Turn 1)');
    expect(ctx).toContain('INITIAL_GOAL');
    expect(ctx).toContain('## Omitted History Reference');
    expect(ctx).toContain('c0000000000000004');
    expect(ctx).toContain('## Files Modified');
    expect(ctx).toContain('`src/oauth.ts`');
    expect(ctx).toContain('## Key Command Results');
    expect(ctx).toContain('OAuthError: invalid_grant');
    expect(ctx).toContain('## Latest Plan');
    expect(ctx).toContain('Fix token refresh race');
    expect(ctx).toContain('Middle turn 18');
  });

  test('deducts incoming promptTokens from history budget so latest prompt is never truncated', () => {
    const events: chat.Event[] = [];
    for (let i = 1; i <= 10; i++) {
      events.push({ seq: i * 3 - 2, t: chat.EventType.User, content: [{ type: 'text', text: `Turn ${i}: ${'alpha '.repeat(80)}` }] });
      events.push({
        seq: i * 3 - 1,
        t: chat.EventType.Update,
        item: `a${i}`,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Ans ${i}: ${'beta '.repeat(80)}` } },
      });
      events.push({ seq: i * 3, t: chat.EventType.Turn, state: chat.TurnState.End, stopReason: 'end_turn' });
    }
    const seed = buildHandoffSeed([{ chatId: 'c0000000000000005', kind: 'claude', cwd: '/repo', events }], {
      cwd: '/repo',
      maxBytes: 16384, // 4096 tokens
    });
    const fullSel = selectHandoff(seed, { promptTokens: 20 });
    const squeezedSel = selectHandoff(seed, { promptTokens: 3500 });
    expect(squeezedSel.effectiveTokenBudget).toBeLessThan(fullSel.effectiveTokenBudget);
    expect(squeezedSel.keptTurns.length).toBeLessThan(fullSel.keptTurns.length);
    // Even under extreme prompt size, history shrinks cleanly to a compact floor rather than erroring.
    const extremeSel = selectHandoff(seed, { promptTokens: 100_000 });
    expect(extremeSel.effectiveTokenBudget).toBeGreaterThanOrEqual(384);
    expect(extremeSel.keptTurns.length).toBeGreaterThanOrEqual(1);
  });

  test('renders structured user/assistant messages for native history injection with multi-hop attribution', () => {
    const segA: chat.Event[] = [
      { seq: 1, t: chat.EventType.User, content: [{ type: 'text', text: 'Design the cache layer' }] },
      {
        seq: 2,
        t: chat.EventType.Update,
        item: 'a1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Proposed an LRU cache.' } },
      },
      { seq: 3, t: chat.EventType.Turn, state: chat.TurnState.End, stopReason: 'end_turn' },
    ];
    const segB: chat.Event[] = [
      {
        seq: 1,
        t: chat.EventType.Notice,
        method: noticeMethod(Notice.Switched),
        params: { fromChat: 'c000000000000000a', fromKind: 'claude' },
      },
      { seq: 2, t: chat.EventType.User, content: [{ type: 'text', text: 'Now implement TTL eviction' }] },
      {
        seq: 3,
        t: chat.EventType.Update,
        item: 'b1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Added TTL eviction in cache.ts.' } },
      },
      { seq: 4, t: chat.EventType.Turn, state: chat.TurnState.End, stopReason: 'end_turn' },
    ];
    const seed = buildHandoffSeed(
      [
        { chatId: 'c000000000000000a', kind: 'claude', cwd: '/repo', events: segA },
        { chatId: 'c000000000000000b', kind: 'agy', cwd: '/repo', events: segB },
      ],
      { cwd: '/repo', targetKind: 'codex' },
    );
    const sel = selectHandoff(seed);
    expect(sel.lineageKinds).toEqual(['claude', 'agy']);
    const msgs = renderNativeHistoryMessages(sel);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(msgs[0]!.text).toContain('Claude Code → Antigravity');
    expect(msgs[0]!.text).toContain('Design the cache layer');
    expect(msgs[1]!.text).toContain('[Previous assistant: Claude Code]');
    expect(msgs[1]!.text).toContain('Proposed an LRU cache.');
    expect(msgs[2]!.text).toContain('Now implement TTL eviction');
    expect(msgs[3]!.text).toContain('[Previous assistant: Antigravity]');
    expect(msgs[3]!.text).toContain('Added TTL eviction in cache.ts.');

    const summary = summarizeHandoffNotice(seed, 'native_history');
    expect(summary).toMatchObject({
      injection: 'native_history',
      totalTurns: 2,
      keptTurns: 2,
      omittedTurns: 0,
      lineageKinds: ['claude', 'agy'],
    });
    expect(summary.estimatedTokens).toBeGreaterThan(0);
  });

  test('parseHandoffSeed remains backward-compatible with legacy raw Markdown strings', () => {
    const legacy = parseHandoffSeed('# Legacy Handoff\n\nOld text');
    expect(legacy?.legacyMarkdown).toBe('# Legacy Handoff\n\nOld text');
    const sel = selectHandoff(legacy!);
    expect(renderAttributedContext(sel)).toContain('Old text');
    expect(renderNativeHistoryMessages(sel)[0]!.text).toContain('Old text');
  });

  test('caps tool-heavy turns, preserves Latest Plan, and keeps native history messages within tight maxBytes', () => {
    const events: chat.Event[] = [
      { seq: 1, t: chat.EventType.User, content: [{ type: 'text', text: 'Audit all modules' }] },
      // 40 tool calls in a single turn.
      ...Array.from({ length: 40 }, (_, i): chat.Event => ({
        seq: 2 + i,
        t: chat.EventType.Update,
        item: `tool-${i}`,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: `tool-${i}`,
          title: `Inspect file-${i}.ts`,
          kind: 'read',
          status: 'completed',
          rawInput: { path: `src/module-${i}/index.ts` },
        },
      })),
      {
        seq: 50,
        t: chat.EventType.Update,
        item: 'a-big',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Summary: ' + 'detail '.repeat(600) } },
      },
      {
        seq: 51,
        t: chat.EventType.Update,
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'Step 1: harden tailer', status: 'completed' },
            { content: 'Step 2: verify budgets', status: 'in_progress' },
          ],
        },
      },
      { seq: 52, t: chat.EventType.Turn, state: chat.TurnState.End, stopReason: 'end_turn' },
    ];
    const seed = buildHandoffSeed([{ chatId: 'c0000000000000001', kind: 'claude', cwd: '/repo', events }], {
      cwd: '/repo',
      targetKind: 'codex',
      maxBytes: 3072,
    });
    const sel = selectHandoff(seed, { maxBytes: 3072 });
    const attributed = renderAttributedContext(sel);
    expect(Buffer.byteLength(attributed, 'utf8')).toBeLessThanOrEqual(3072);
    expect(attributed).toContain('## Latest Plan');
    expect(attributed).toContain('Step 2: verify budgets');

    const native = renderNativeHistoryMessages(sel);
    const nativeBytes = native.reduce((n, m) => n + Buffer.byteLength(m.text, 'utf8'), 0);
    expect(nativeBytes).toBeLessThanOrEqual(3072);
    expect(native.some((m) => m.text.includes('Step 2: verify budgets'))).toBe(true);
  });
});
