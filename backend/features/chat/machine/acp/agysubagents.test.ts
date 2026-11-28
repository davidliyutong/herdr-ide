import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { SLUG } from '#shared/lib/brand.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import {
  AgySubagentTracker,
  agyDataDirs,
  decodeTranscriptArgs,
  isAgySubagentCall,
  loadAgySubagentHistory,
  mapTranscriptToolCall,
  normalizeAgySubagentCall,
  parseChildMessage,
  parseSubagentCreated,
  transcriptPath,
} from './agysubagents.ts';

const PARENT_SID = '11111111-1111-4111-8111-111111111111';
const CHILD_SID = '22222222-2222-4222-8222-222222222222';
const OLD_CHILD_SID = '33333333-3333-4333-8333-333333333333';

function makeTempAgyDir(): { root: string; agyDir: string; cleanup: () => void } {
  const root = mkdtempSync(posix.join(tmpdir(), 'veldr-agy-sub-'));
  const agyDir = posix.join(root, '.gemini', 'antigravity-cli');
  mkdirSync(agyDir, { recursive: true, mode: 0o700 });
  return {
    root,
    agyDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeJsonl(filePath: string, entries: readonly Record<string, unknown>[], append = false): void {
  mkdirSync(posix.dirname(filePath), { recursive: true, mode: 0o700 });
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  if (append) appendFileSync(filePath, body);
  else writeFileSync(filePath, body);
}

describe('agysubagents helpers', () => {
  test('isAgySubagentCall and normalizeAgySubagentCall recognize and normalize invoke_subagent', () => {
    const raw = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      name: 'invoke_subagent',
      kind: 'other',
      title: 'Run invoke_subagent',
      status: 'in_progress',
      rawInput: {
        TypeName: 'self',
        Role: 'Shell Command Runner',
        Prompt: 'Run ls and return output',
        Model: 'inherit',
      },
    };
    expect(isAgySubagentCall(raw)).toBe(true);
    expect(isAgySubagentCall({ toolCallId: 'c2', name: 'run_command', title: 'ls', rawInput: { CommandLine: 'ls' } })).toBe(false);

    const norm = normalizeAgySubagentCall(raw, {
      status: 'in_progress',
      childId: CHILD_SID,
      role: 'Shell Command Runner',
      typeName: 'self',
      toolUses: 2,
      tokens: 1500,
      lastTool: 'run_command',
    });
    expect(norm.kind).toBe('think');
    expect(norm.title).toBe('Shell Command Runner');
    expect(norm.status).toBe('in_progress');
    expect((norm.rawInput as Record<string, unknown>).agent_type).toBe('self');
    expect((norm.rawInput as Record<string, unknown>).description).toBe('Shell Command Runner');
    expect((norm.rawInput as Record<string, unknown>).prompt).toBe('Run ls and return output');
    expect((norm.rawInput as Record<string, unknown>).model).toBeUndefined();
    const own = (norm._meta as Record<string, Record<string, unknown>>)[SLUG]!;
    expect(own.subagent).toEqual({
      tool: 'invoke_subagent',
      status: 'in_progress',
      agentPath: 'Shell Command Runner',
      threadId: CHILD_SID,
    });
    expect(own.task).toMatchObject({
      type: 'subagent',
      taskId: CHILD_SID,
      description: 'Shell Command Runner',
      subagentType: 'self',
      backgrounded: true,
      stoppable: false,
      toolUses: 2,
      tokens: 1500,
      lastTool: 'run_command',
    });
  });

  test('decodeTranscriptArgs and mapTranscriptToolCall unwrap JSON-encoded args and set ACP tool kinds', () => {
    expect(decodeTranscriptArgs({ CommandLine: '"ls -la"', WaitMsBeforeAsync: '5000', toolSummary: '"List files"' })).toEqual({
      CommandLine: 'ls -la',
      WaitMsBeforeAsync: 5000,
      toolSummary: 'List files',
    });

    const cmd = mapTranscriptToolCall('c1', 'run_command', { CommandLine: '"ls"', toolSummary: '"List dir"' });
    expect(cmd.kind).toBe('execute');
    expect(cmd.title).toBe('List dir');
    expect((cmd.rawInput as Record<string, unknown>).command).toBe('ls');

    const rd = mapTranscriptToolCall('c2', 'read_file', { Path: '"/work/a.ts"', StartLine: '10' });
    expect(rd.kind).toBe('read');
    expect(rd.locations).toEqual([{ path: '/work/a.ts', line: 10 }]);

    const ed = mapTranscriptToolCall('c3', 'edit_file', { Path: '"/work/b.ts"' });
    expect(ed.kind).toBe('edit');
    expect(ed.locations).toEqual([{ path: '/work/b.ts' }]);

    const srch = mapTranscriptToolCall('c4', 'grep_search', { Query: '"subagent"' });
    expect(srch.kind).toBe('search');
    expect((srch.rawInput as Record<string, unknown>).query).toBe('subagent');
  });

  test('parseSubagentCreated and parseChildMessage extract valid UUIDs', () => {
    const created = parseSubagentCreated(
      `Created At: 2026-11-27T19:36:35+08:00\nCreated the following subagent:\n{\n  "conversationId": "${CHILD_SID}",\n  "logAbsoluteUri": "file:///tmp/brain/${CHILD_SID}/.system_generated/logs/transcript.jsonl"\n}`,
    );
    expect(created).toEqual({
      conversationId: CHILD_SID,
      logPath: `/tmp/brain/${CHILD_SID}/.system_generated/logs/transcript.jsonl`,
    });
    expect(parseSubagentCreated('Created the following subagent: {"conversationId":"not-a-uuid"}')).toBeNull();

    const msg = parseChildMessage(
      `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-27T11:36:47Z sender=${CHILD_SID} priority=MESSAGE_PRIORITY_HIGH content=ls output:\nAGENTS.md\n</SYSTEM_MESSAGE>`,
    );
    expect(msg).toEqual({ sender: CHILD_SID, content: 'ls output:\nAGENTS.md' });
  });

  test('agyDataDirs resolves default and flag-overridden data directories', () => {
    expect(agyDataDirs(['/bin/agy', 'acp', '--stdio'], { HOME: '/home/u' }, '/work')).toEqual([
      '/home/u/.gemini/antigravity-cli',
      '/home/u/.gemini/antigravity',
      '/home/u/.gemini/antigravity-ide',
    ]);
    expect(agyDataDirs(['/bin/agy', 'acp', '--app-data-dir', 'custom-agy'], { HOME: '/home/u' }, '/work')[0]).toBe(
      '/home/u/.gemini/custom-agy',
    );
  });
});

describe('AgySubagentTracker', () => {
  test('session stop settles an open subagent and clears its live task', () => {
    const events: chat.Event[] = [];
    const snapshots: chat.BackgroundTask[][] = [];
    const tracker = new AgySubagentTracker(
      { emit: (event) => events.push(event), updateTasks: (tasks) => snapshots.push(tasks), logf: () => {} },
      { dirs: [], pollMs: 0 },
    );
    tracker.onToolUpdate({ toolCallId: 'open', name: 'invoke_subagent', status: 'in_progress' });
    expect(snapshots.at(-1)).toMatchObject([{ id: 'open', status: 'running' }]);
    tracker.stop();
    expect(events.at(-1)).toMatchObject({ item: 'open', update: { status: 'cancelled' } });
    expect(snapshots.at(-1)).toEqual([]);
  });

  test('streams child thoughts, commands, outputs and completion under parent toolCallId and updates Chat.tasks', () => {
    const tmp = makeTempAgyDir();
    try {
      const events: chat.Event[] = [];
      const taskSnapshots: chat.BackgroundTask[][] = [];
      const tracker = new AgySubagentTracker(
        {
          emit: (ev) => events.push(ev),
          updateTasks: (tasks) => taskSnapshots.push(tasks),
          logf: () => {},
        },
        { dirs: [tmp.agyDir], pollMs: 0 },
      );
      tracker.setSession(PARENT_SID);

      // 1. ACP emits tool_call (in_progress), then quickly tool_call_update (completed) once spawned.
      const callRaw = {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_sub_1',
        name: 'invoke_subagent',
        kind: 'other',
        title: 'Run invoke_subagent',
        status: 'in_progress',
        rawInput: { TypeName: 'self', Role: 'Shell Command Runner', Prompt: 'Run ls' },
      };
      const first = tracker.onToolUpdate(callRaw)!;
      expect(first.kind).toBe('think');
      expect(first.status).toBe('in_progress');
      expect(taskSnapshots.at(-1)).toHaveLength(1);
      expect(taskSnapshots.at(-1)![0]).toMatchObject({
        kind: chat.TaskKind.Subagent,
        status: chat.TaskStatus.Running,
        toolCallId: 'call_sub_1',
        agentType: 'self',
        description: 'Shell Command Runner',
        stoppable: false,
      });

      // ACP immediate completion of the spawn tool keeps the subagent in_progress.
      const afterSpawn = tracker.onToolUpdate({ ...callRaw, sessionUpdate: 'tool_call_update', status: 'completed' })!;
      expect(afterSpawn.status).toBe('in_progress');

      // 2. Parent transcript records the spawned child conversationId.
      const parentFile = transcriptPath(tmp.agyDir, PARENT_SID);
      const childFile = transcriptPath(tmp.agyDir, CHILD_SID);
      writeJsonl(parentFile, [
        {
          step_index: 2,
          type: 'GENERIC',
          status: 'DONE',
          content: `Created the following subagent:\n{\n  "conversationId": "${CHILD_SID}",\n  "logAbsoluteUri": "file://${childFile}"\n}`,
        },
      ]);
      // Child transcript begins running `ls`.
      writeJsonl(childFile, [
        { step_index: 0, type: 'SYSTEM_MESSAGE', content: 'Run ls' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          thinking: 'Running ls in workspace.',
          input_tokens: 1000,
          output_tokens: 120,
          tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls"', toolSummary: '"List directory contents"' } }],
        },
      ]);

      tracker.poll();

      // Nested thought + nested execute tool_call emitted with parent = 'call_sub_1'.
      const childEvents = events.filter((e) => e.parent === 'call_sub_1');
      expect(childEvents.some((e) => (e.update as Record<string, unknown>).sessionUpdate === 'agent_thought_chunk')).toBe(true);
      const runEv = childEvents.find((e) => (e.update as Record<string, unknown>).kind === 'execute');
      expect(runEv).toBeDefined();
      expect((runEv!.update as Record<string, unknown>).status).toBe('in_progress');
      expect(((runEv!.update as Record<string, unknown>).rawInput as Record<string, unknown>).command).toBe('ls');
      expect(taskSnapshots.at(-1)![0]).toMatchObject({ id: CHILD_SID, toolUses: 1, tokens: 1120 });

      // 3. Child command finishes and sends reply to parent; parent receives SYSTEM_MESSAGE.
      writeJsonl(
        childFile,
        [
          {
            step_index: 2,
            type: 'GENERIC',
            status: 'DONE',
            content:
              'Created At: 2026-11-27T19:36:40+08:00\nCompleted At: 2026-11-27T19:36:40+08:00\nCommand exited with code 0.\n\nCommand output:\nAGENTS.md\nREADME.md\n',
          },
          {
            step_index: 3,
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            content: 'Finished running ls.',
          },
        ],
        true,
      );
      writeJsonl(
        parentFile,
        [
          {
            step_index: 4,
            type: 'SYSTEM_MESSAGE',
            status: 'DONE',
            content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-27T11:36:47Z sender=${CHILD_SID} priority=MESSAGE_PRIORITY_HIGH content=AGENTS.md\nREADME.md\n</SYSTEM_MESSAGE>`,
          },
        ],
        true,
      );

      tracker.poll();

      const completedRun = events.filter((e) => e.parent === 'call_sub_1' && e.item === runEv!.item).at(-1)!.update as Record<
        string,
        unknown
      >;
      expect(completedRun.status).toBe('completed');
      expect((completedRun._meta as Record<string, Record<string, unknown>>)[SLUG]!.exitCode).toBe(0);
      expect(JSON.stringify(completedRun.content)).toContain('AGENTS.md');

      // Child final agent_message_chunk was drained before completion.
      expect(
        events.some((e) => e.parent === 'call_sub_1' && (e.update as Record<string, unknown>).sessionUpdate === 'agent_message_chunk'),
      ).toBe(true);

      // Parent tool_call updated to completed with summary, and Chat.tasks cleared.
      const finalParent = events.filter((e) => !e.parent && e.item === 'call_sub_1').at(-1)!.update as Record<string, unknown>;
      expect(finalParent.status).toBe('completed');
      expect((finalParent._meta as Record<string, Record<string, Record<string, unknown>>>)[SLUG]!.task!.summary).toContain('AGENTS.md');
      expect(taskSnapshots.at(-1)).toEqual([]);

      tracker.stop();
    } finally {
      tmp.cleanup();
    }
  });

  test('settles cleanly on turn end when no transcript exists on disk', () => {
    const tmp = makeTempAgyDir();
    try {
      const events: chat.Event[] = [];
      const taskSnapshots: chat.BackgroundTask[][] = [];
      const tracker = new AgySubagentTracker(
        {
          emit: (ev) => events.push(ev),
          updateTasks: (tasks) => taskSnapshots.push(tasks),
          logf: () => {},
        },
        { dirs: [tmp.agyDir], pollMs: 0 },
      );
      tracker.setSession(PARENT_SID);
      tracker.onToolUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_no_disk',
        name: 'invoke_subagent',
        status: 'in_progress',
        rawInput: { TypeName: 'research', Role: 'Code Reader', Prompt: 'Inspect docs' },
      });
      tracker.onToolUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_no_disk',
        name: 'invoke_subagent',
        status: 'completed',
      });
      tracker.onTurnEnd();
      const settled = events.filter((e) => e.item === 'call_no_disk').at(-1)!.update as Record<string, unknown>;
      expect(settled.status).toBe('completed');
      expect(taskSnapshots.at(-1)).toEqual([]);
      tracker.stop();
    } finally {
      tmp.cleanup();
    }
  });

  test('resumed session ignores earlier spawns already in parent transcript and refuses symlinked child transcripts', () => {
    const tmp = makeTempAgyDir();
    try {
      const parentFile = transcriptPath(tmp.agyDir, PARENT_SID);
      writeJsonl(parentFile, [
        {
          step_index: 1,
          type: 'GENERIC',
          content: `Created the following subagent:\n{"conversationId":"${OLD_CHILD_SID}"}`,
        },
      ]);

      const events: chat.Event[] = [];
      const tracker = new AgySubagentTracker(
        { emit: (ev) => events.push(ev), updateTasks: () => {}, logf: () => {} },
        { dirs: [tmp.agyDir], pollMs: 0 },
      );
      // Seek to end of existing parent transcript (resumed session).
      tracker.setSession(PARENT_SID);

      tracker.onToolUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_new',
        name: 'invoke_subagent',
        status: 'in_progress',
        rawInput: { TypeName: 'self', Role: 'New Runner', Prompt: 'Do new work' },
      });

      // Create a symlinked child transcript outside agyDir: must be refused.
      const outside = posix.join(tmp.root, 'outside.jsonl');
      writeFileSync(outside, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'secret' }) + '\n');
      const symlinkChildFile = transcriptPath(tmp.agyDir, CHILD_SID);
      mkdirSync(posix.dirname(symlinkChildFile), { recursive: true, mode: 0o700 });
      symlinkSync(outside, symlinkChildFile);

      writeJsonl(
        parentFile,
        [{ step_index: 2, type: 'GENERIC', content: `Created the following subagent:\n{"conversationId":"${CHILD_SID}"}` }],
        true,
      );

      tracker.poll();
      // Must NOT link OLD_CHILD_SID and must NOT read symlinked CHILD_SID transcript.
      const parentEv = events.find((e) => e.item === 'call_new')!.update as Record<string, unknown>;
      expect((parentEv._meta as Record<string, Record<string, Record<string, unknown>>>)[SLUG]!.subagent!.threadId).toBe(CHILD_SID);
      expect(events.filter((e) => e.parent === 'call_new')).toHaveLength(0);
      tracker.stop();
    } finally {
      tmp.cleanup();
    }
  });

  test('loadAgySubagentHistory replays child transcript steps under parent toolCallId', () => {
    const tmp = makeTempAgyDir();
    try {
      const parentFile = transcriptPath(tmp.agyDir, PARENT_SID);
      const childFile = transcriptPath(tmp.agyDir, CHILD_SID);
      writeJsonl(parentFile, [
        { step_index: 2, type: 'GENERIC', content: `Created the following subagent:\n{"conversationId":"${CHILD_SID}"}` },
        { step_index: 4, type: 'SYSTEM_MESSAGE', content: `[Message] sender=${CHILD_SID} content=All done` },
      ]);
      writeJsonl(childFile, [
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'run_command', args: { CommandLine: '"false"' } }],
        },
        { step_index: 2, type: 'GENERIC', content: 'Command exited with code 1.\n' },
      ]);
      const emitted: chat.Event[] = [];
      loadAgySubagentHistory(
        PARENT_SID,
        [
          {
            toolCallId: 'call_hist_1',
            raw: {
              toolCallId: 'call_hist_1',
              name: 'invoke_subagent',
              rawInput: { TypeName: 'self', Role: 'Verifier', Prompt: 'Check build' },
            },
          },
        ],
        [tmp.agyDir],
        (ev) => emitted.push(ev),
      );
      const failedCmd = emitted
        .filter((e) => e.parent === 'call_hist_1' && (e.update as Record<string, unknown>).kind === 'execute')
        .at(-1)!.update as Record<string, unknown>;
      expect(failedCmd.status).toBe('failed');
      expect((failedCmd._meta as Record<string, Record<string, unknown>>)[SLUG]!.exitCode).toBe(1);
      const finalParent = emitted.filter((e) => !e.parent && e.item === 'call_hist_1').at(-1)!.update as Record<string, unknown>;
      expect(finalParent.status).toBe('completed');
      expect((finalParent._meta as Record<string, Record<string, Record<string, unknown>>>)[SLUG]!.task!.summary).toBe('All done');
    } finally {
      tmp.cleanup();
    }
  });

  test('parseSubagentCreated handles nested braces and } inside JSON strings', () => {
    const content = `Created the following subagent:\n{"note":"a } b { c","conversationId":"${CHILD_SID}","meta":{"nested":true},"logAbsoluteUri":"file:///tmp/t.jsonl"}`;
    expect(parseSubagentCreated(content)).toEqual({
      conversationId: CHILD_SID,
      logPath: '/tmp/t.jsonl',
    });
  });

  test('refuses parent-dir symlink escape, drains >1 MiB multi-chunk transcripts, guards re-entrant completion, and enforces caps', () => {
    const tmp = makeTempAgyDir();
    try {
      const parentFile = transcriptPath(tmp.agyDir, PARENT_SID);
      const childSid2 = '44444444-4444-4444-8444-444444444444';
      const escapedSid = '55555555-5555-4555-8555-555555555555';

      // Create an outside directory symlinked into brain/<escapedSid> (parent-dir escape!).
      const outside = posix.join(tmp.root, 'outside-brain');
      mkdirSync(posix.join(outside, '.system_generated', 'logs'), { recursive: true, mode: 0o700 });
      writeJsonl(posix.join(outside, '.system_generated', 'logs', 'transcript.jsonl'), [
        { step_index: 1, type: 'PLANNER_RESPONSE', content: 'SHOULD_NOT_BE_READ' },
      ]);
      mkdirSync(posix.join(tmp.agyDir, 'brain'), { recursive: true, mode: 0o700 });
      symlinkSync(outside, posix.join(tmp.agyDir, 'brain', escapedSid));

      const events: chat.Event[] = [];
      const tracker = new AgySubagentTracker(
        { emit: (ev) => events.push(ev), updateTasks: () => {}, logf: () => {} },
        { dirs: [tmp.agyDir], pollMs: 0 },
      );
      tracker.setSession(PARENT_SID);

      // Concurrent subagent calls (1 normal >1 MiB + 1 parent-dir symlink escape + early report matching).
      tracker.onToolUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_big',
        name: 'invoke_subagent',
        status: 'in_progress',
        rawInput: { TypeName: 'self', Role: 'Big Worker', Prompt: 'Emit > 1 MiB' },
      });
      tracker.onToolUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_escape',
        name: 'invoke_subagent',
        status: 'in_progress',
        rawInput: { TypeName: 'self', Role: 'Escaped', Prompt: 'Attempt symlink escape' },
      });

      // Write > 1.1 MiB child transcript with multi-byte UTF-8 and final message at the tail.
      const bigChildFile = transcriptPath(tmp.agyDir, childSid2);
      const pad = '你好🚀'.repeat(400); // ~4 KiB per entry
      const bigEntries: Record<string, unknown>[] = [];
      for (let i = 1; i <= 300; i++) {
        bigEntries.push({ step_index: i, type: 'PLANNER_RESPONSE', thinking: `chunk-${i} ${pad}` });
      }
      bigEntries.push({ step_index: 301, type: 'PLANNER_RESPONSE', content: 'FINAL_TAIL_MARKER' });
      writeJsonl(bigChildFile, bigEntries);

      // Write parent spawns and completion report.
      writeJsonl(parentFile, [
        { step_index: 1, type: 'GENERIC', content: `Created the following subagent:\n{"conversationId":"${childSid2}"}` },
        { step_index: 2, type: 'GENERIC', content: `Created the following subagent:\n{"conversationId":"${escapedSid}"}` },
        { step_index: 3, type: 'SYSTEM_MESSAGE', content: `[Message] sender=${childSid2} content=Finished big run` },
      ]);

      tracker.poll();
      // Calling onTurnEnd after already completed must NOT emit a duplicate parent completion!
      tracker.onTurnEnd();

      // Parent-dir symlink escape produced ZERO child events.
      expect(events.filter((e) => e.parent === 'call_escape')).toHaveLength(0);

      // Big child drained across >1 MiB boundary and emitted FINAL_TAIL_MARKER without U+FFFD corruption.
      const bigChildEvents = events.filter((e) => e.parent === 'call_big');
      expect(bigChildEvents.length).toBeGreaterThan(0);
      expect(bigChildEvents.some((e) => JSON.stringify(e.update).includes('FINAL_TAIL_MARKER'))).toBe(true);
      expect(bigChildEvents.some((e) => JSON.stringify(e.update).includes('\ufffd'))).toBe(false);

      // Parent completion for call_big was emitted exactly ONCE.
      const bigParentCompletions = events.filter(
        (e) => !e.parent && e.item === 'call_big' && (e.update as Record<string, unknown>).status === 'completed',
      );
      expect(bigParentCompletions).toHaveLength(1);

      // Verify MAX_SUBAGENTS (64) eviction keeps memory bounded.
      for (let i = 0; i < 70; i++) {
        tracker.onToolUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: `call_cap_${i}`,
          name: 'invoke_subagent',
          status: 'in_progress',
          rawInput: { TypeName: 'self', Role: `R${i}`, Prompt: `P${i}` },
        });
      }
      expect(tracker.tracks('call_cap_69')).toBe(true);
      expect(tracker.tracks('call_cap_0')).toBe(false);
      tracker.stop();
    } finally {
      tmp.cleanup();
    }
  });

  test('loadAgySubagentHistory maps ERROR/Encountered error steps to failed status with parity to live tracker', () => {
    const tmp = makeTempAgyDir();
    try {
      const parentFile = transcriptPath(tmp.agyDir, PARENT_SID);
      const childFile = transcriptPath(tmp.agyDir, CHILD_SID);
      writeJsonl(parentFile, [
        { step_index: 1, type: 'GENERIC', content: `Created the following subagent:\n{"conversationId":"${CHILD_SID}"}` },
        { step_index: 2, type: 'SYSTEM_MESSAGE', content: `[Message] sender=${CHILD_SID} content=Done` },
      ]);
      writeJsonl(childFile, [
        { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: '"/missing"' } }] },
        { step_index: 2, type: 'GENERIC', status: 'ERROR', content: 'Encountered error: ENOENT' },
      ]);
      const emitted: chat.Event[] = [];
      loadAgySubagentHistory(
        PARENT_SID,
        [{ toolCallId: 'call_err', raw: { toolCallId: 'call_err', name: 'invoke_subagent', rawInput: { Role: 'Reader' } } }],
        [tmp.agyDir],
        (ev) => emitted.push(ev),
      );
      const failedRead = emitted.filter((e) => e.parent === 'call_err' && (e.update as Record<string, unknown>).kind === 'read').at(-1)!
        .update as Record<string, unknown>;
      expect(failedRead.status).toBe('failed');
    } finally {
      tmp.cleanup();
    }
  });
});
