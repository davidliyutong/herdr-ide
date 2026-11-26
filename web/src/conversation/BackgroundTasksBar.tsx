// Collapsible tray above the composer listing active background tasks and
// running subagents (#10): draws from the host's authoritative `chat.tasks`
// snapshot merged with running background/subagent tool items from the
// timeline, with jump-to-item navigation and one-click termination.

import { useState } from 'react';
import { Activity, Bot, ChevronRight, Cpu, LoaderCircle, SquareTerminal, Workflow, X } from 'lucide-react';
import { t } from '../i18n';
import { commandOf, formatTokens, inputText } from './format';
import { isSubagent, subagentType } from './items';
import { itemById, taskMeta, toolItemId, type Conversation } from './model';
import { formatDuration, TaskStopButton } from './parts';
import type { BackgroundTask } from './source';

/** An active task shown in BackgroundTasksBar, enriched with timeline data. */
export interface ActiveTaskEntry extends BackgroundTask {
  lastTool?: string;
}

const KIND_ICON = {
  shell: SquareTerminal,
  subagent: Bot,
  monitor: Activity,
  workflow: Workflow,
  other: Cpu,
} as const;

const isActiveStatus = (s: BackgroundTask['status']) => s === 'running' || s === 'pending';

/** Collects running/pending background tasks and subagents from `conv.chat.tasks`
 * merged with running background/subagent tool items in `conv.items`. */
export function activeBackgroundTasks(conv: Conversation): ActiveTaskEntry[] {
  const out: ActiveTaskEntry[] = [];
  const seenIds = new Set<string>();
  const seenTools = new Set<string>();

  for (const task of conv.chat?.tasks ?? []) {
    if (!isActiveStatus(task.status)) continue;
    seenIds.add(task.id);
    if (task.toolCallId) seenTools.add(task.toolCallId);
    let entry: ActiveTaskEntry = { ...task };
    if (task.toolCallId) {
      const it = itemById(conv, toolItemId(task.toolCallId));
      if (it?.kind === 'tool') {
        const tm = taskMeta(it);
        if (tm?.lastTool) entry.lastTool = tm.lastTool;
        if (!entry.description) {
          entry.description = inputText(it.rawInput, 'description') ?? tm?.description ?? it.title.trim();
        }
        if (!entry.command && entry.kind === 'shell') {
          entry.command = commandOf(it.rawInput);
        }
        if (!entry.agentType && entry.kind === 'subagent') {
          entry.agentType = subagentType(it);
        }
        if (entry.tokens === undefined && tm?.tokens) entry.tokens = tm.tokens;
        if (entry.toolUses === undefined && tm?.toolUses) entry.toolUses = tm.toolUses;
        if (entry.durationMs === undefined && tm?.durationMs) entry.durationMs = tm.durationMs;
      }
    }
    out.push(entry);
  }

  for (const it of conv.items) {
    if (it.kind !== 'tool' || it.status !== 'in_progress') continue;
    const rawToolId = it.id.startsWith('tool:') ? it.id.slice(5) : it.id;
    const tm = taskMeta(it);
    const sub = isSubagent(it);
    const bg = tm?.backgrounded === true;
    if (!sub && !bg) continue;
    const id = tm?.taskId ?? rawToolId;
    if (seenIds.has(id) || seenTools.has(rawToolId)) continue;
    seenIds.add(id);
    seenTools.add(rawToolId);
    const cmd = !sub && it.toolKind === 'execute' ? commandOf(it.rawInput) : undefined;
    const desc = inputText(it.rawInput, 'description') ?? tm?.description ?? it.title.trim() ?? cmd ?? '';
    const entry: ActiveTaskEntry = {
      id,
      kind: sub ? 'subagent' : 'shell',
      status: 'running',
      description: desc,
      ...(cmd ? { command: cmd } : {}),
      ...(sub ? { agentType: subagentType(it) } : {}),
      toolCallId: rawToolId,
      backgrounded: bg || undefined,
      stoppable: !!tm?.taskId && tm.stoppable !== false,
      ...(tm?.tokens ? { tokens: tm.tokens } : {}),
      ...(tm?.toolUses ? { toolUses: tm.toolUses } : it.sub?.items.length ? { toolUses: it.sub.items.length } : {}),
      ...(tm?.durationMs ? { durationMs: tm.durationMs } : {}),
      ...(tm?.lastTool ? { lastTool: tm.lastTool } : {}),
    };
    out.push(entry);
  }

  return out;
}

export interface BackgroundTasksBarProps {
  tasks: readonly ActiveTaskEntry[];
  agent: string;
  readOnly: boolean;
  /** Whether the agent supports terminating individual background tasks (capabilities.stopTask). */
  canStop: boolean;
  onStopTask?(taskId: string): Promise<void>;
  /** Scrolls to and focuses the timeline item for a task's toolCallId. */
  onJumpToItem?(itemId: string): void;
  /** Returns whether the timeline currently has the given item id. */
  hasItem?(itemId: string): boolean;
}

export function BackgroundTasksBar({ tasks, agent, readOnly, canStop, onStopTask, onJumpToItem, hasItem }: BackgroundTasksBarProps) {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  if (!tasks.length) return null;

  const heading = tasks.length === 1 ? t('conversation.tasks.one') : t('conversation.tasks.many', { n: tasks.length });

  return (
    <div className="conv-tasks" role="region" aria-label={t('conversation.tasks.label')}>
      <button type="button" className="conv-tasks-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight className="conv-chevron" aria-hidden />
        <LoaderCircle className="conv-tasks-spin conv-spin" aria-hidden />
        <span className="conv-tasks-count">{heading}</span>
        {!open && (
          <span className="conv-tasks-preview ellipsis">
            {tasks[0].description || tasks[0].command || tasks[0].agentType || tasks[0].id}
          </span>
        )}
      </button>
      {error && (
        <div className="conv-tasks-error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon sm" aria-label={t('conversation.dismiss')} onClick={() => setError(undefined)}>
            <X aria-hidden />
          </button>
        </div>
      )}
      {open && (
        <ul className="conv-tasks-list">
          {tasks.map((task) => {
            const Icon = KIND_ICON[task.kind] ?? Cpu;
            const title = (task.description || task.command || task.agentType || task.id).split('\n')[0];
            const itemId = task.toolCallId ? toolItemId(task.toolCallId) : undefined;
            const canJump = !!itemId && !!onJumpToItem && (!hasItem || hasItem(itemId));
            const stoppable = !readOnly && canStop && !!onStopTask && task.stoppable !== false;
            return (
              <li key={task.id} className="conv-task-row" data-task={task.id} data-kind={task.kind}>
                <Icon className="conv-task-icon" aria-hidden />
                {canJump ? (
                  <button
                    type="button"
                    className="conv-task-jump"
                    title={t('conversation.task.jumpHint')}
                    onClick={() => onJumpToItem!(itemId!)}
                  >
                    {task.agentType && <span className="conv-task-agent">{task.agentType}</span>}
                    <span className={task.kind === 'shell' ? 'conv-task-title mono ellipsis' : 'conv-task-title ellipsis'}>{title}</span>
                  </button>
                ) : (
                  <span className="conv-task-label" title={task.command || task.description || task.id}>
                    {task.agentType && <span className="conv-task-agent">{task.agentType}</span>}
                    <span className={task.kind === 'shell' ? 'conv-task-title mono ellipsis' : 'conv-task-title ellipsis'}>{title}</span>
                  </span>
                )}
                <span className="conv-task-meta">
                  {task.lastTool && <span className="conv-task-live">{t('conversation.task.runningTool', { tool: task.lastTool })}</span>}
                  {task.pid !== undefined && <span className="conv-task-stat mono">{t('conversation.task.pid', { pid: task.pid })}</span>}
                  {task.toolUses !== undefined && task.toolUses > 0 && (
                    <span className="conv-task-stat">{t('conversation.subagent.steps', { n: task.toolUses })}</span>
                  )}
                  {task.tokens !== undefined && task.tokens > 0 && (
                    <span className="conv-task-stat">{t('conversation.task.tokens', { tokens: formatTokens(task.tokens) })}</span>
                  )}
                  {task.durationMs !== undefined && task.durationMs > 0 && (
                    <span className="conv-task-stat">{formatDuration(task.durationMs)}</span>
                  )}
                  {stoppable && <TaskStopButton taskId={task.id} name={title} agent={agent} stopTask={onStopTask!} onError={setError} />}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
