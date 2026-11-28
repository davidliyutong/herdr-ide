// @vitest-environment jsdom
//
// Background tasks & subagents (#10): collapsible BackgroundTasksBar above the
// composer, live task progress badges & stats on Claude/Codex subagents and
// background shell commands, jump-to-item navigation, and per-task Stop action.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { APP_SLUG } from '../brand';
import { activeBackgroundTasks } from '../conversation/BackgroundTasksBar';
import { Conversation, type ConversationProps } from '../conversation/Conversation';
import { emptyConversation, reduceAll, type ChatEvent, type SourceEvent } from '../conversation/model';
import type { ChatSource } from '../conversation/source';
import { t } from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSource implements ChatSource {
  id?: string;
  readOnly?: boolean;
  events: SourceEvent[] = [];
  subs = new Set<(ev: SourceEvent) => void>();
  send = vi.fn(async () => {});
  cancel = vi.fn(async () => {});
  respond = vi.fn(async () => {});
  answer = vi.fn(async () => {});
  setConfig = vi.fn(async () => {});
  cancelQueued = vi.fn(async () => {});
  compact = vi.fn(async () => {});
  stopTask = vi.fn(async (_taskId: string) => {});
  subscribe(fn: (ev: SourceEvent) => void) {
    this.subs.add(fn);
    for (const ev of this.events) fn(ev);
    return () => void this.subs.delete(fn);
  }
  emit(...evs: SourceEvent[]) {
    for (const ev of evs) {
      this.events.push(ev);
      for (const fn of this.subs) fn(ev);
    }
  }
}

let seq = 0;
const next = () => ++seq;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  seq = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const q = <E extends Element = HTMLElement>(sel: string, from: ParentNode = host) => from.querySelector<E>(sel as never) as E | null;
const qa = <E extends Element = HTMLElement>(sel: string, from: ParentNode = host) =>
  Array.from(from.querySelectorAll<E>(sel as never)) as E[];
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
async function show(source: ChatSource, extra: Partial<ConversationProps> = {}) {
  await act(async () => root.render(createElement(Conversation, { source, kind: 'claude', ...extra })));
  await settle();
}
async function emit(source: FakeSource, ...evs: SourceEvent[]) {
  await act(async () => source.emit(...evs));
  await settle();
}
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement).click());

describe('activeBackgroundTasks', () => {
  it('merges authoritative chat.tasks with running background/subagent timeline items without duplicates', () => {
    const conv = reduceAll(emptyConversation(), [
      {
        seq: 1,
        t: 'info',
        chat: {
          state: 'working',
          capabilities: { stopTask: true },
          tasks: [
            { id: 'bg-1', kind: 'shell', status: 'running', command: 'npm run dev', toolCallId: 'c1', pid: 9012, backgrounded: true },
            { id: 'bg-done', kind: 'shell', status: 'completed', command: 'echo hi' },
          ],
        } as ChatEvent['chat'],
      },
      {
        seq: 2,
        t: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Dev server',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'npm run dev', run_in_background: true },
          _meta: { [APP_SLUG]: { task: { taskId: 'bg-1', lastTool: 'Bash', durationMs: 2500 } } },
        } as ChatEvent['update'],
      },
      {
        seq: 3,
        t: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'c2',
          title: 'Audit tests',
          kind: 'think',
          status: 'in_progress',
          rawInput: { agent_type: 'Explorer', description: 'Audit tests' },
          _meta: { [APP_SLUG]: { subagent: { threadId: 'thr-9', agentPath: '/root/explorer' } } },
        } as ChatEvent['update'],
      },
    ]);

    const active = activeBackgroundTasks(conv);
    expect(active).toHaveLength(2);
    expect(active[0]).toMatchObject({ id: 'bg-1', kind: 'shell', pid: 9012, lastTool: 'Bash', durationMs: 2500 });
    expect(active[1]).toMatchObject({ id: 'thr-9', kind: 'subagent', agentType: 'Explorer', toolCallId: 'c2', stoppable: true });
  });
});

describe('BackgroundTasksBar and inline task controls', () => {
  it('shows active Claude background shell & subagent tasks, jumps to item, and stops individual tasks', async () => {
    const s = new FakeSource();
    s.emit(
      {
        seq: next(),
        t: 'info',
        chat: {
          state: 'working',
          capabilities: { stopTask: true },
          tasks: [
            {
              id: 'task-shell',
              kind: 'shell',
              status: 'running',
              description: 'Watch tests',
              command: 'vitest --watch',
              toolCallId: 'sh1',
              pid: 5150,
              backgrounded: true,
              stoppable: true,
            },
            {
              id: 'task-agent',
              kind: 'subagent',
              status: 'running',
              description: 'Explore codebase',
              agentType: 'Explore',
              toolCallId: 'sub1',
              backgrounded: true,
              tokens: 2400,
              toolUses: 4,
              durationMs: 6200,
              stoppable: true,
            },
          ],
        } as ChatEvent['chat'],
      },
      {
        seq: next(),
        t: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'sh1',
          title: 'Watch tests',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'vitest --watch', run_in_background: true },
          _meta: { [APP_SLUG]: { task: { taskId: 'task-shell', type: 'local_bash', backgrounded: true } } },
        } as ChatEvent['update'],
      },
      {
        seq: next(),
        t: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'sub1',
          title: 'Explore codebase',
          kind: 'think',
          status: 'in_progress',
          rawInput: { subagent_type: 'Explore', description: 'Explore codebase', model: 'haiku' },
          _meta: { [APP_SLUG]: { task: { taskId: 'task-agent', type: 'local_agent', backgrounded: true } } },
        } as ChatEvent['update'],
      },
      {
        seq: next(),
        t: 'update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'sub1',
          _meta: { [APP_SLUG]: { task: { lastTool: 'Grep', tokens: 2400, toolUses: 4, durationMs: 6200 } } },
        } as ChatEvent['update'],
      },
    );
    await show(s);

    // Inline badges, live stats & stop buttons on both timeline rows.
    const shRow = q('.conv-tool[data-item="tool:sh1"]')!;
    expect(q('.conv-bg-badge', shRow)?.textContent).toBe(t('conversation.task.background'));
    expect(q('.conv-task-stop', shRow)).not.toBeNull();

    const subRow = q('.conv-subagent[data-item="tool:sub1"]')!;
    expect(q('.conv-bg-badge', subRow)?.textContent).toBe(t('conversation.task.background'));
    expect(q('.conv-model-badge', subRow)?.textContent).toBe('haiku');
    expect(q('.conv-task-live', subRow)?.textContent).toBe(t('conversation.task.runningTool', { tool: 'Grep' }));
    expect(subRow.textContent).toContain(t('conversation.subagent.steps', { n: 4 }));
    expect(subRow.textContent).toContain(t('conversation.task.tokens', { tokens: '2.4k' }));
    expect(subRow.textContent).toContain('6.2s');

    // BackgroundTasksBar lists both tasks with heading count.
    const bar = q('.conv-tasks')!;
    expect(q('.conv-tasks-count', bar)?.textContent).toBe(t('conversation.tasks.many', { n: 2 }));
    const rows = qa('.conv-task-row', bar);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain(t('conversation.task.pid', { pid: 5150 }));
    expect(rows[1].textContent).toContain('Explore');
    expect(rows[1].textContent).toContain(t('conversation.task.runningTool', { tool: 'Grep' }));

    // Jump-to-item scrolls the correlated timeline tool row into view and moves focus into it.
    const scrollIntoView = vi.fn();
    shRow.scrollIntoView = scrollIntoView;
    await click(q('.conv-task-jump', rows[0]));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(shRow.contains(document.activeElement)).toBe(true);

    // Collapsing and expanding the tray works cleanly.
    const toggle = q<HTMLButtonElement>('.conv-tasks-head', bar)!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(q('.conv-tasks-list', bar)).toBeNull();
    expect(q('.conv-tasks-preview', bar)?.textContent).toBe('Watch tests');
    await click(toggle);
    const reopened = qa('.conv-task-row', bar);
    expect(reopened).toHaveLength(2);

    // Clicking Stop on a task calls source.stopTask with spinner while pending.
    let release!: () => void;
    s.stopTask.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const stopBtn = q<HTMLButtonElement>('.conv-task-stop', reopened[0])!;
    await click(stopBtn);
    expect(s.stopTask).toHaveBeenCalledWith('task-shell');
    expect(stopBtn.disabled).toBe(true);
    expect(q('.conv-spin', stopBtn)).not.toBeNull();
    await act(async () => release());
    await settle();
    expect(stopBtn.disabled).toBe(false);

    // Inline stop button on subagent also invokes stopTask.
    await click(q('.conv-task-stop', subRow));
    expect(s.stopTask).toHaveBeenCalledWith('task-agent');
  });

  it('recognizes Codex subagents (agentPath/spawnAgent) and background processId, shows stop errors, and hides stop in readOnly', async () => {
    const s = new FakeSource();
    s.stopTask.mockImplementationOnce(async () => {
      throw Object.assign(new Error('offline'), { code: 'offline' });
    });
    s.emit(
      {
        seq: next(),
        t: 'info',
        chat: {
          state: 'working',
          capabilities: { stopTask: true },
          tasks: [
            { id: 'proc-7', kind: 'shell', status: 'running', command: 'sleep 60', toolCallId: 'cmd1', stoppable: true },
            { id: 'thr-1', kind: 'subagent', status: 'running', toolCallId: 'codex-sub1', stoppable: true },
          ],
        } as ChatEvent['chat'],
      },
      {
        seq: next(),
        t: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'cmd1',
          title: 'Run sleep',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'sleep 60' },
          _meta: { [APP_SLUG]: { processId: 'proc-7' } },
        } as ChatEvent['update'],
      },
      {
        seq: next(),
        t: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'codex-sub1',
          title: 'Check auth',
          kind: 'think',
          status: 'in_progress',
          rawInput: { agentPath: '/root/reviewer', tool: 'spawnAgent', description: 'Check auth' },
          _meta: { [APP_SLUG]: { subagent: { threadId: 'thr-1', agentPath: '/root/reviewer', tool: 'spawnAgent' } } },
        } as ChatEvent['update'],
      },
    );
    await show(s, { kind: 'codex' });

    // Codex subagent renders as SubagentView with its agentPath label and Stop button.
    const sub = q('.conv-subagent[data-item="tool:codex-sub1"]')!;
    expect(sub).not.toBeNull();
    expect(q('.conv-tool-label', sub)?.textContent).toBe('/root/reviewer');
    expect(q('.conv-task-stop', sub)).not.toBeNull();

    // Failed stop displays dismissible error banner in BackgroundTasksBar.
    const bar = q('.conv-tasks')!;
    await click(q('.conv-task-row[data-task="proc-7"] .conv-task-stop', bar));
    await settle();
    const err = q('.conv-tasks-error', bar)!;
    expect(err.textContent).toContain(t('conversation.error.offline'));
    await click(q(`button[aria-label="${t('conversation.dismiss')}"]`, err));
    expect(q('.conv-tasks-error', bar)).toBeNull();
    expect(q('.conv-task-row[data-task="proc-7"]', bar)).not.toBeNull();

    // A stop that keeps failing (a task the agent no longer runs): Remove from
    // List takes it off this page's list; the others stay.
    s.stopTask.mockImplementationOnce(async () => {
      throw Object.assign(new Error('no such task'), { code: 'not_found' });
    });
    await click(q('.conv-task-row[data-task="proc-7"] .conv-task-stop', bar));
    await settle();
    const forget = [...(q('.conv-tasks-error', bar)?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === t('conversation.task.forget'),
    );
    expect(forget).toBeDefined();
    await click(forget!);
    expect(q('.conv-task-row[data-task="proc-7"]')).toBeNull();
    expect(q('.conv-task-row[data-task="thr-1"]')).not.toBeNull();
    expect(q('.conv-tasks-error')).toBeNull();

    // Read-only hides every stop button.
    await show(s, { kind: 'codex', readOnly: true });
    expect(q('.conv-task-stop')).toBeNull();

    // Codex's live list can clear while both calls still appear open in the timeline.
    await show(s, { kind: 'codex' });
    await emit(s, { seq: next(), t: 'info', chat: { state: 'idle', capabilities: { stopTask: true }, tasks: [] } as ChatEvent['chat'] });
    expect(q('.conv-tasks')).toBeNull();
    expect(q('.conv-task-stop')).toBeNull();
    await emit(s, {
      seq: next(),
      t: 'update',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'codex-sub1',
        status: 'completed',
        _meta: { [APP_SLUG]: { task: { summary: 'All auth checks passed.' } } },
      } as ChatEvent['update'],
    });
    // Opening completed subagent shows fallback task summary when content is empty.
    await click(q('.conv-subagent[data-item="tool:codex-sub1"] .conv-toggle'));
    await vi.waitFor(async () => {
      await settle();
      expect(q('.conv-subagent[data-item="tool:codex-sub1"] .conv-subagent-body')?.textContent).toContain('All auth checks passed.');
    });
  });

  it('renders Antigravity invoke_subagent calls (both normalized and legacy PascalCase) as SubagentView with nested steps', async () => {
    const s = new FakeSource();
    s.emit(
      {
        seq: next(),
        t: 'info',
        chat: {
          state: 'working',
          capabilities: { stopTask: false },
          tasks: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              kind: 'subagent',
              status: 'running',
              description: 'Shell Command Runner',
              agentType: 'self',
              toolCallId: 'agy-sub1',
              backgrounded: true,
              stoppable: false,
            },
          ],
        } as ChatEvent['chat'],
      },
      {
        seq: next(),
        t: 'update',
        item: 'agy-sub1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'agy-sub1',
          title: 'Shell Command Runner',
          kind: 'think',
          status: 'in_progress',
          rawInput: {
            TypeName: 'self',
            Role: 'Shell Command Runner',
            Prompt: 'Run ls',
            agent_type: 'self',
            description: 'Shell Command Runner',
            prompt: 'Run ls',
          },
          _meta: { [APP_SLUG]: { subagent: { threadId: '22222222-2222-4222-8222-222222222222', agentPath: 'Shell Command Runner' } } },
        } as ChatEvent['update'],
      },
      {
        seq: next(),
        t: 'update',
        item: 'agy-sub-22222222-s1-c0',
        parent: 'agy-sub1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'agy-sub-22222222-s1-c0',
          title: 'List directory contents',
          kind: 'execute',
          status: 'completed',
          rawInput: { command: 'ls' },
          content: [{ type: 'content', content: { type: 'text', text: 'AGENTS.md' } }],
        } as ChatEvent['update'],
      },
      {
        seq: next(),
        t: 'update',
        item: 'agy-legacy',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'agy-legacy',
          title: 'Run invoke_subagent',
          kind: 'other',
          status: 'completed',
          rawInput: { TypeName: 'research', Role: 'Code Explorer', Prompt: 'Find docs', Model: 'inherit' },
        } as ChatEvent['update'],
      },
    );
    await show(s, { kind: 'agy' });

    const active = q('.conv-subagent[data-item="tool:agy-sub1"]')!;
    expect(active).not.toBeNull();
    expect(q('.conv-tool-label', active)?.textContent).toBe('self');
    expect(q('.conv-subagent-desc', active)?.textContent).toBe('Shell Command Runner');
    expect(q('.conv-subagent-count', active)?.textContent).toBe(t('conversation.subagent.steps', { n: 1 }));
    await click(q('.conv-toggle', active));
    await vi.waitFor(async () => {
      await settle();
      expect(q('.conv-subagent-items .conv-tool[data-kind="execute"]', active)).not.toBeNull();
    });

    const legacy = q('.conv-subagent[data-item="tool:agy-legacy"]')!;
    expect(legacy).not.toBeNull();
    expect(q('.conv-tool-label', legacy)?.textContent).toBe('research');
    expect(q('.conv-subagent-desc', legacy)?.textContent).toBe('Code Explorer');
    expect(q('.conv-model-badge', legacy)).toBeNull();
  });
});
