// Codex's items, commands and prompts as the adapter maps them.
import { describe, expect, test } from 'bun:test';
import { SLUG } from '#shared/lib/brand.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ChatProtoError } from '#shared/proto/chatproto/index.ts';
import type { ThreadItem } from './appserver.gen.ts';
import {
  Mapper,
  Tool,
  asyncQuestions,
  callWithStatus,
  collabCall,
  cutText,
  filePath,
  shellScript,
  subAgentCall,
  toUserInput,
  turnErrorOf,
  userContent,
} from './mapping.ts';
import { agentVersion } from './session.ts';
import { canonical } from './testing.ts';

describe('the mapping', () => {
  test("a command's script: a shell's -c, else the command, else its actions", () => {
    const cases: Record<string, string> = {
      "/bin/zsh -lc 'echo hi > hi.txt'": 'echo hi > hi.txt',
      '/bin/bash -c "echo \\"a\\" $HOME"': 'echo "a" $HOME',
      "/bin/zsh -lc 'it'\\''s'": "it's",
      'ls -la': 'ls -la',
      "/bin/zsh -lc 'a' extra": "/bin/zsh -lc 'a' extra",
      "/usr/bin/env zsh -c 'x'": "/usr/bin/env zsh -c 'x'",
      "/bin/sh -c 'for i in 1 2; do echo $i; done'": 'for i in 1 2; do echo $i; done',
    };
    for (const [input, want] of Object.entries(cases)) expect([input, shellScript(input, null)]).toEqual([input, want]);
    expect(
      shellScript('', [
        { type: 'unknown', command: 'a' },
        { type: 'unknown', command: 'b' },
      ]),
    ).toBe('a; b');
  });

  test('a prompt as Codex input: text, an image as a data URL, a file named with @ as a mention, a link as text, a resource as its text', () => {
    const input = toUserInput([
      { type: 'text', text: 'hi' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'resource_link', uri: 'file:///work/a%20b.go', name: 'a b.go' },
      { type: 'resource_link', uri: 'https://example.com/x', name: 'x' },
      { type: 'resource', resource: { uri: 'file:///x', text: 'body' } },
    ]);
    expect(input).toEqual([
      { type: 'text', text: 'hi', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AAAA' },
      { type: 'mention', name: 'a b.go', path: '/work/a b.go' },
      { type: 'text', text: 'https://example.com/x', text_elements: [] },
      { type: 'text', text: 'body', text_elements: [] },
    ]);
    for (const bad of [{ type: 'audio', data: 'x' }, { type: 'image', mimeType: 'text/plain', data: 'x' }, 'x'])
      expect(() => toUserInput([bad])).toThrow(ChatProtoError);
    expect(() => toUserInput([])).toThrow(ChatProtoError);
    expect(filePath('file://localhost/w/x')).toBe('/w/x');
    expect(filePath('file://host/w/x')).toBeNull();
  });

  test("a user message's input as content blocks", () => {
    expect(
      userContent([
        { type: 'text', text: 'a', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,QUJD' },
        { type: 'localImage', path: '/w/red.png' },
        { type: 'mention', name: 'm', path: '/w/m.go' },
        { type: 'mention', path: "/w/a b(1)'s?.go" },
      ]),
    ).toEqual([
      { type: 'text', text: 'a' },
      { type: 'image', mimeType: 'image/png', data: 'QUJD' },
      { type: 'resource_link', uri: 'file:///w/red.png', name: 'red.png' },
      { type: 'resource_link', uri: 'file:///w/m.go', name: 'm' },
      // Escaped as Go's url.URL writes a path.
      { type: 'resource_link', uri: 'file:///w/a%20b%281%29%27s%3F.go', name: "a b(1)'s?.go" },
    ]);
  });

  test('errors of turns, the version, titles cut at a character', () => {
    expect(turnErrorOf({ message: 'x', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } }).code).toBe(
      chat.Code.AuthRequired,
    );
    expect(turnErrorOf({ message: 'x', codexErrorInfo: 'usageLimitExceeded' })).toEqual({ code: chat.Code.Failed, message: 'x' });
    expect(turnErrorOf({ message: 'x', codexErrorInfo: 'unauthorized' }).code).toBe(chat.Code.AuthRequired);
    expect(turnErrorOf(null)).toEqual({ code: chat.Code.Failed, message: 'the turn failed' });
    expect(agentVersion('herdr_ide/0.171.0 (Mac OS 26.6.2; arm64) ghostty')).toBe('0.171.0');
    expect(agentVersion('nothing')).toBe('');
    expect(cutText('aé', 2)).toBe('a');
    expect(cutText('aé', 3)).toBe('aé');
  });

  test('file changes as diffs: an added file whole, a move with its patch, a deleted file, titles relative to the directory', () => {
    const it: ThreadItem = {
      type: 'fileChange',
      id: 'f',
      status: 'completed',
      changes: [
        { path: '/work/a.txt', diff: 'a\n', kind: { type: 'add' } },
        { path: '/work/b.txt', diff: '@@ -1 +1 @@\n-b\n+c\n', kind: { type: 'update', move_path: '/work/c.txt' } },
        { path: '/elsewhere/d.txt', diff: 'd\n', kind: { type: 'delete' } },
      ],
    };
    const evs = new Mapper('/work').itemEvents(it, true, '');
    expect(evs).not.toBeNull();
    expect(canonical(evs![0]!.update)).toBe(
      canonical({
        content: [
          { newText: 'a\n', oldText: null, path: '/work/a.txt', type: 'diff' },
          {
            changes: [{ oldPath: '/work/b.txt', operation: 'move', path: '/work/c.txt' }],
            patch: { format: 'unified', text: '--- /work/b.txt\n+++ /work/c.txt\n@@ -1 +1 @@\n-b\n+c\n' },
            type: 'diff',
          },
          { newText: '', oldText: 'd\n', path: '/elsewhere/d.txt', type: 'diff' },
        ],
        kind: 'edit',
        locations: [{ path: '/work/a.txt' }, { path: '/work/c.txt' }, { path: '/elsewhere/d.txt' }],
        sessionUpdate: 'tool_call',
        status: 'completed',
        title: 'a.txt, c.txt, /elsewhere/d.txt',
        toolCallId: 'f',
      }),
    );
  });

  test('items are read leniently: a member of another type is none, never a failure', () => {
    const m = new Mapper('/w');
    const odd = (it: Record<string, unknown>) => m.itemEvents(it as unknown as ThreadItem, true, '')![0]!.update as Record<string, unknown>;
    expect(odd({ type: 'commandExecution', id: 'c', command: 3, commandActions: 'x', status: 'completed', cwd: null })).toMatchObject({
      title: '',
      rawInput: { command: '' },
    });
    expect(odd({ type: 'agentMessage', id: 'a', text: null }).content).toEqual({ type: 'text', text: '' });
    expect(odd({ type: 'fileChange', id: 'f', changes: [null, { path: 1, kind: 'x' }], status: 'completed' }).title).toBe('');
    expect(odd({ type: 'webSearch', id: 'w', action: 'x' }).title).toBe('');
    expect(odd({ type: 'mcpToolCall', id: 'p', result: 'x', error: 1, status: 'failed' }).title).toBe('');
  });

  test('an item of a type the adapter does not map is none', () => {
    expect(new Mapper('/w').itemEvents({ type: 'enteredReviewMode', id: 'x', review: 'r' }, true, '')).toBeNull();
  });

  test('agentMessage preserves async delivery and questions metadata', () => {
    const m = new Mapper('/w');
    const it: ThreadItem = {
      type: 'agentMessage',
      id: 'am1',
      text: 'I can proceed two ways.',
      phase: 'final_answer',
      delivery: 'async',
      questions: [
        { title: 'Pick a database', options: ['SQLite', 'Postgres', '  '] },
        { title: 'Any constraints?', options: null },
        { title: '   ', options: ['ignored'] },
      ],
    };
    const evs = m.itemEvents(it, true, '');
    expect(evs?.length).toBe(1);
    const meta = ((evs![0]!.update as Record<string, unknown>)._meta as Record<string, Record<string, unknown>>)[SLUG];
    expect(meta).toEqual({
      phase: 'final_answer',
      delivery: 'async',
      questions: [{ title: 'Pick a database', options: ['SQLite', 'Postgres'] }, { title: 'Any constraints?' }],
    });
    expect(asyncQuestions(null)).toEqual([]);
  });

  test('commandCall preserves processId and subAgentCall/collabCall expose agent_type and subagent meta', () => {
    const m = new Mapper('/w');
    const cmdEv = m.itemEvents(
      {
        type: 'commandExecution',
        id: 'cmd1',
        command: "/bin/zsh -lc 'npm run dev'",
        commandActions: [],
        cwd: '/w',
        status: 'inProgress',
        processId: 'pty-42',
      },
      false,
      '',
    );
    const cmdMeta = ((cmdEv![0]!.update as Record<string, unknown>)._meta as Record<string, Record<string, unknown>>)[SLUG];
    expect(cmdMeta).toEqual({ processId: 'pty-42' });

    const sub = subAgentCall(
      {
        type: 'subAgentActivity',
        id: 'sa1',
        kind: 'started',
        agentThreadId: 'th-child',
        agentPath: '/root/helper',
        model: 'gpt-6-luna',
      },
      Tool.InProgress,
    );
    expect(sub.rawInput).toEqual({ agentPath: '/root/helper', agent_type: '/root/helper', model: 'gpt-6-luna' });
    expect((sub._meta as Record<string, Record<string, unknown>>)[SLUG]).toEqual({
      subagent: { status: Tool.InProgress, threadId: 'th-child', agentPath: '/root/helper' },
    });
    const done = callWithStatus(sub, Tool.Completed);
    expect((done._meta as Record<string, Record<string, unknown>>)[SLUG]).toEqual({
      subagent: { status: Tool.Completed, threadId: 'th-child', agentPath: '/root/helper' },
    });
    // Original snapshot is not mutated.
    expect(((sub._meta as Record<string, Record<string, unknown>>)[SLUG]!.subagent as Record<string, unknown>).status).toBe(
      Tool.InProgress,
    );

    const spawn = collabCall({
      type: 'collabAgentToolCall',
      id: 'col1',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'th-main',
      receiverThreadIds: ['th-child'],
      agentsStates: {},
      prompt: 'check logs',
    });
    expect((spawn.rawInput as Record<string, unknown>).agent_type).toBe('subagent');
    expect((spawn._meta as Record<string, Record<string, unknown>>)[SLUG]).toEqual({
      subagent: { tool: 'spawnAgent', status: Tool.InProgress, threadId: 'th-child', receiverThreadIds: ['th-child'] },
    });

    const wait = collabCall({
      type: 'collabAgentToolCall',
      id: 'col2',
      tool: 'wait',
      status: 'inProgress',
      senderThreadId: 'th-main',
      receiverThreadIds: [],
      agentsStates: {},
    });
    expect(wait.kind).toBe('other');
    expect(wait._meta).toBeUndefined();
  });
});
