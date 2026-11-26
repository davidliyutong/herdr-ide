// The items of a conversation as the view draws them: the user's prompts
// (as compact Markdown, with hover actions for edit/rewind and fork-from-here),
// the agent's messages as Markdown (tables, formulas, code; while one streams,
// a block at a time; plus follow-up questions in history replay), its thoughts
// and tool calls as quiet rows that open, a subagent's call with the subagent's
// own items nested in it (closed at first, with its live progress and stop
// control), the turn's plan as a checklist, notices as thin separators, and the
// cards that answer the agent (cards.tsx). An item is drawn again only when it
// changed (the reducer replaces only the items an event changes).

import { memo, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Bot,
  Brain,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  GitFork,
  ListTodo,
  MessageCircleQuestion,
  Pencil,
  RotateCcw,
  SquareSlash,
  TriangleAlert,
} from 'lucide-react';
import type { MarkdownBase } from '../markdown/links';
import { Markdown } from '../markdown/Markdown';
import { StreamMarkdown as SharedStreamMarkdown } from '../markdown/StreamMarkdown';
import { hasMessage, t } from '../i18n';
import { PermissionCard, PlanCard, QuestionCard } from './cards';
import { formatTokens, inputText, plainOutput } from './format';
import { agentKind } from './kinds';
import {
  asText,
  blocksText,
  CHAT_NOTICES,
  NOTICES,
  STOPPED,
  taskMeta,
  type AsyncFollowUpQuestion,
  type ContentBlock,
  type Item,
  type MessageItem,
  type NoticeItem,
  type PlanItem,
  type ThoughtItem,
  type ToolItem,
} from './model';
import {
  Blocks,
  errorText,
  formatDuration,
  isShortened,
  Shortened,
  TaskStopButton,
  TimelineActionsContext,
  type ItemContext,
} from './parts';
import { Results, Section, StatusIcon, ToolCallView } from './ToolCall';

/** A user's prompt longer than this (characters or lines) shows its start
 * until it is opened. */
const LONG_PROMPT = 1200;
const LONG_PROMPT_LINES = 14;

function when(at: string | undefined): string | undefined {
  if (!at) return undefined;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
}

function newClientId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function UserMessage({ item, ctx }: { item: MessageItem; ctx: ItemContext }) {
  const actions = useContext(TimelineActionsContext);
  const text = blocksText(item.content);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [restoreFiles, setRestoreFiles] = useState(false);
  const [saving, setSaving] = useState(false);
  const [forking, setForking] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      const el = editRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }, [editing]);

  let lines = 1;
  for (let i = text.indexOf('\n'); i >= 0 && lines <= LONG_PROMPT_LINES; i = text.indexOf('\n', i + 1)) lines++;
  const long = text.length > LONG_PROMPT || lines > LONG_PROMPT_LINES;

  const canRewind = item.seq !== undefined && !!actions.rewind;
  const canFork = item.seq !== undefined && !!actions.fork;
  const nonTextBlocks = useMemo(() => item.content.filter((b) => b.type !== 'text'), [item.content]);

  const startEdit = () => {
    setDraft(text);
    setRestoreFiles(false);
    setFailed(undefined);
    setEditing(true);
  };

  const cancelEdit = () => {
    if (saving) return;
    setEditing(false);
    setFailed(undefined);
  };

  const submitEdit = () => {
    if (saving || item.seq === undefined || !actions.rewind) return;
    const trimmed = draft.trim();
    if (!trimmed && !nonTextBlocks.length) return;
    const content: ContentBlock[] = [...nonTextBlocks, ...(trimmed ? [{ type: 'text' as const, text: draft }] : [])];
    setSaving(true);
    setFailed(undefined);
    actions
      .rewind(item.seq, {
        content,
        clientId: newClientId(),
        ...(actions.rewindFiles && restoreFiles ? { restoreFiles: true } : {}),
      })
      .then(
        () => {
          setSaving(false);
          setEditing(false);
        },
        (e: unknown) => {
          setSaving(false);
          setFailed(errorText(e, ctx.agent, 'conversation.commandFailed'));
        },
      );
  };

  const onEditKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submitEdit();
    }
  };

  const triggerFork = () => {
    if (forking || item.seq === undefined || !actions.fork) return;
    setForking(true);
    Promise.resolve(actions.fork(item.seq)).finally(() => setForking(false));
  };

  return (
    <div className="conv-item conv-user" data-item={item.id} data-seq={item.seq}>
      {editing ? (
        <div className="conv-bubble conv-user-edit">
          <span className="conv-sr">{t('conversation.you')}: </span>
          <textarea
            ref={editRef}
            className="conv-edit-input"
            value={draft}
            rows={Math.min(10, Math.max(2, draft.split('\n').length))}
            disabled={saving}
            aria-label={t('conversation.user.editRewind')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onEditKeyDown}
          />
          <div className="conv-edit-warn" role="note">
            <TriangleAlert aria-hidden />
            <span>{t('conversation.rewind.warning')}</span>
          </div>
          {actions.rewindFiles && (
            <label className="conv-edit-check">
              <input type="checkbox" checked={restoreFiles} disabled={saving} onChange={(e) => setRestoreFiles(e.target.checked)} />
              <span>{t('conversation.rewind.restoreFiles')}</span>
            </label>
          )}
          {failed && (
            <div className="conv-ask-error" role="alert">
              {failed}
            </div>
          )}
          <div className="conv-edit-actions">
            <button type="button" className="primary sm" disabled={saving || (!draft.trim() && !nonTextBlocks.length)} onClick={submitEdit}>
              <RotateCcw aria-hidden />
              {t('conversation.rewind.submit')}
            </button>
            <button type="button" className="sm" disabled={saving} onClick={cancelEdit}>
              {t('conversation.rewind.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="conv-user-wrap">
          {(canRewind || canFork) && (
            <div className="conv-user-actions" role="toolbar" aria-label={t('conversation.you')}>
              {canRewind && (
                <button
                  type="button"
                  className="conv-user-action"
                  aria-label={t('conversation.user.editRewind')}
                  title={t('conversation.user.editRewindHint')}
                  onClick={startEdit}
                >
                  <Pencil aria-hidden />
                </button>
              )}
              {canFork && (
                <button
                  type="button"
                  className="conv-user-action"
                  aria-label={t('conversation.user.forkHere')}
                  title={t('conversation.user.forkHereHint')}
                  disabled={forking}
                  onClick={triggerFork}
                >
                  <GitFork aria-hidden />
                </button>
              )}
            </div>
          )}
          <div className="conv-bubble" title={when(item.at)}>
            <span className="conv-sr">{t('conversation.you')}: </span>
            {text && (
              <div className={long && !open ? 'conv-user-text clamped' : 'conv-user-text'}>
                <Markdown text={text} variant="compact" base={ctx.base} onOpenPath={ctx.openFile} className="conv-md conv-user-md" />
              </div>
            )}
            <Blocks blocks={item.content} ctx={ctx} />
            {item.content.some(isShortened) && <Shortened />}
            {long && (
              <button type="button" className="conv-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                {open ? t('conversation.showLess') : t('conversation.showMore')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Markdown that is still arriving: its blocks apart, so that an increment
 * draws only the last; whole once it no longer streams. Delegates to the
 * unified Markdown component in compact mode. */
export function StreamMarkdown({
  text,
  live,
  base,
  onOpenPath,
  className,
}: {
  text: string;
  live?: boolean;
  base?: MarkdownBase;
  onOpenPath?: (path: string) => void;
  className: string;
}) {
  return (
    <SharedStreamMarkdown
      text={text}
      live={live}
      variant="compact"
      base={base}
      onOpenPath={onOpenPath}
      className={className}
      streamClassName="conv-stream"
    />
  );
}

/** Read-only follow-up questions attached to a Codex AgentMessage during
 * history replay; suppresses itself when an interactive QuestionCard already
 * correlates to this message (`questionSourceItems`). Kept in a separate child
 * so normal AgentMessage components never subscribe to TimelineActionsContext. */
function FollowUpQuestions({ itemId, questions, ctx }: { itemId: string; questions: readonly AsyncFollowUpQuestion[]; ctx: ItemContext }) {
  const { questionSourceItems } = useContext(TimelineActionsContext);
  if (questionSourceItems.has(itemId)) return null;
  return (
    <div className="conv-followup" role="region" aria-label={t('conversation.question.followUp')}>
      <div className="conv-followup-head">
        <MessageCircleQuestion aria-hidden />
        <span>{t('conversation.question.followUp')}</span>
      </div>
      <ul className="conv-followup-list">
        {questions.map((q, i) => (
          <li key={i} className="conv-followup-item">
            <Markdown text={q.title} variant="compact" base={ctx.base} onOpenPath={ctx.openFile} className="conv-md conv-q-text" />
            {q.options && q.options.length > 0 && (
              <div className="conv-followup-options">
                {q.options.map((opt, j) => (
                  <span key={j} className="conv-badge">
                    {opt}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentMessage({ item, ctx }: { item: MessageItem; ctx: ItemContext }) {
  const text = blocksText(item.content);
  return (
    <div className="conv-item conv-agent" data-item={item.id} aria-busy={item.live || undefined}>
      <span className="conv-sr">{ctx.agent}: </span>
      {text.trim() && <StreamMarkdown text={text} live={item.live} base={ctx.base} onOpenPath={ctx.openFile} className="conv-md" />}
      <Blocks blocks={item.content} ctx={ctx} />
      {item.followUpQuestions && item.followUpQuestions.length > 0 && (
        <FollowUpQuestions itemId={item.id} questions={item.followUpQuestions} ctx={ctx} />
      )}
      {item.content.some(isShortened) && <Shortened />}
    </div>
  );
}

/** A thought: its text opens; one the agent keeps to itself says how many
 * tokens it took, when the agent estimates them. */
function Thought({ item, ctx }: { item: ThoughtItem; ctx: ItemContext }) {
  const text = blocksText(item.content).trim();
  const [open, setOpen] = useState(false);
  const label =
    !text && item.estimatedTokens
      ? t('conversation.thoughtTokens', { tokens: formatTokens(item.estimatedTokens) })
      : t('conversation.thought');
  const head = (
    <>
      <ChevronRight className="conv-chevron" aria-hidden />
      <Brain className="conv-kind-icon" aria-hidden />
      <span className="conv-tool-label">{label}</span>
    </>
  );
  return (
    <div className="conv-item conv-quiet conv-thought">
      <div className="conv-row">
        {text ? (
          <button type="button" className="conv-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {head}
          </button>
        ) : (
          <div className="conv-toggle static">{head}</div>
        )}
      </div>
      {open && text && (
        <div className="conv-tool-body">
          <StreamMarkdown text={text} live={item.live} base={ctx.base} onOpenPath={ctx.openFile} className="conv-md conv-thought-text" />
        </div>
      )}
    </div>
  );
}

const PLAN_ICONS = { pending: Circle, in_progress: CircleDot, completed: CircleCheck } as const;

function Plan({ item }: { item: PlanItem }) {
  const done = item.entries.filter((e) => e.status === 'completed').length;
  return (
    <div className="conv-item conv-plan" role="group" aria-label={t('conversation.plan')}>
      <div className="conv-plan-head">
        <ListTodo aria-hidden />
        <span>{t('conversation.plan')}</span>
        <span className="conv-plan-count">{t('conversation.planProgress', { done, total: item.entries.length })}</span>
      </div>
      <ol>
        {item.entries.map((e, i) => {
          const Icon = PLAN_ICONS[e.status];
          return (
            <li key={i} data-status={e.status}>
              <Icon aria-hidden />
              <span>
                <span className="conv-sr">{t(`conversation.planStatus.${e.status}`)}: </span>
                {e.content}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => asText(v)?.trim() || undefined;

/** Where the folder of a notice that it is not trusted is: trusted from
 * the notice (and not taken back since), a request under way, and why the
 * last one failed. */
interface Trusting {
  trusted: boolean;
  busy?: boolean;
  failed?: string;
}

function Notice({ item, ctx }: { item: NoticeItem; ctx: ItemContext }) {
  const [open, setOpen] = useState(false);
  const [trusting, setTrusting] = useState<Trusting>({ trusted: false });
  const p = isObject(item.params) ? item.params : {};
  let text: string;
  let error = false;
  let untrusted = false;
  let command: string | undefined;
  let output: string | undefined;
  switch (item.method) {
    case NOTICES.compacted:
      text = t('conversation.notice.compacted');
      break;
    case NOTICES.skipped:
      text = t('conversation.notice.skipped');
      break;
    case NOTICES.error: {
      const message = str(p.message) ?? str(p.text) ?? str(p.error);
      if (p.willRetry === true)
        text = message ? t('conversation.notice.retrying', { message }) : t('conversation.notice.retryingNoMessage');
      else {
        error = true;
        text = message ?? t('conversation.notice.error');
      }
      break;
    }
    case CHAT_NOTICES.handedOff:
      text = t('conversation.notice.handedOff');
      break;
    case CHAT_NOTICES.imported:
      text = t(p.lossy === true ? 'conversation.notice.importedLossy' : 'conversation.notice.imported');
      break;
    case CHAT_NOTICES.restarted: {
      const mode = str(p.mode);
      const key = `conversation.mode.${mode ?? ''}`;
      text = mode ? t('conversation.notice.restartedFor', { mode: hasMessage(key) ? t(key) : mode }) : t('conversation.notice.restarted');
      break;
    }
    case CHAT_NOTICES.untrustedFolder:
      untrusted = true;
      text = trusting.trusted ? t('conversation.notice.trusted') : t('conversation.notice.untrustedFolder');
      break;
    case CHAT_NOTICES.fullAccessOff:
      text = t('conversation.notice.fullAccessOff');
      break;
    case CHAT_NOTICES.forked:
      text = t('conversation.notice.forked');
      break;
    case CHAT_NOTICES.switched: {
      const fromKind = str(p.fromKind);
      const fromAgent = fromKind ? (agentKind(fromKind)?.title ?? fromKind) : undefined;
      text = fromAgent ? t('conversation.notice.switchedFrom', { agent: fromAgent }) : t('conversation.notice.switched');
      break;
    }
    case CHAT_NOTICES.rewound:
      text = t(p.restoreFiles === true || p.restoredFiles === true ? 'conversation.notice.rewoundFiles' : 'conversation.notice.rewound');
      break;
    case NOTICES.command: {
      const name = str(p.name);
      command = name ? (name.startsWith('/') ? name : `/${name}`) : undefined;
      if (command && str(p.args)) command += ` ${str(p.args)}`;
      output = str(p.output);
      text = command ?? t('conversation.notice.command');
      break;
    }
    case STOPPED: {
      const key = `conversation.notice.stopped.${asText(p.stopReason) ?? ''}`;
      text = hasMessage(key) ? t(key) : t('conversation.notice.stopped.cancelled');
      break;
    }
    default:
      text = item.method;
  }
  return (
    <div className={error ? 'conv-item conv-notice error' : 'conv-item conv-notice'}>
      <div className="conv-notice-line">
        {command && <SquareSlash aria-hidden />}
        <span className={command ? 'conv-notice-text mono' : 'conv-notice-text'} title={text}>
          {text}
        </span>
        {output && (
          <button type="button" className="conv-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {t('conversation.notice.output')}
          </button>
        )}
        {untrusted && <TrustButton cwd={str(p.cwd) ?? ''} ctx={ctx} trusting={trusting} set={setTrusting} />}
      </div>
      {untrusted && trusting.failed && (
        <div className="conv-notice-failed" role="alert">
          {trusting.failed}
        </div>
      )}
      {open && output && <pre className="conv-pre conv-term">{plainOutput(output)}</pre>}
    </div>
  );
}

/** The action of a notice that the folder is not trusted: trust it, or,
 * once trusted from the notice, take that back (the source's trust and
 * untrust); the other one follows when it is done. */
function TrustButton({ cwd, ctx, trusting, set }: { cwd: string; ctx: ItemContext; trusting: Trusting; set: (t: Trusting) => void }) {
  const trusted = trusting.trusted;
  const ask = trusted ? ctx.untrust : ctx.trust;
  if (!ask) return null;
  return (
    <button
      type="button"
      className="conv-link"
      title={t(trusted ? 'conversation.notice.untrustHint' : 'conversation.notice.trustHint', { cwd })}
      disabled={!!trusting.busy}
      onClick={() => {
        set({ trusted, busy: true });
        ask().then(
          () => set({ trusted: !trusted }),
          (e: unknown) =>
            set({
              trusted,
              failed: errorText(e, ctx.agent, trusted ? 'conversation.notice.untrustFailed' : 'conversation.notice.trustFailed'),
            }),
        );
      }}
    >
      {t(trusted ? 'conversation.notice.untrust' : 'conversation.notice.trust')}
    </button>
  );
}

/** The kind of subagent a call runs (its type), when it says. */
export function subagentType(item: ToolItem): string | undefined {
  const fromInput = inputText(item.rawInput, 'subagent_type', 'agent_type', 'agentType', 'agent', 'agentPath');
  if (fromInput) return fromInput;
  const tm = taskMeta(item);
  if (tm?.subagentType) return tm.subagentType;
  if (inputText(item.rawInput, 'tool') === 'spawnAgent') return 'subagent';
  return undefined;
}

/** Whether a call runs a subagent: it has the subagent's items, names a
 * subagent's type/path/spawnAgent, or carries subagent task metadata. */
export function isSubagent(item: ToolItem): boolean {
  if (item.sub || subagentType(item) !== undefined) return true;
  const tm = taskMeta(item);
  return tm?.type === 'local_agent' || tm?.type === 'in_process_teammate' || tm?.type === 'subagent';
}

/** Live task badges, stats and inline stop button for a SubagentView row. */
function SubagentTaskMeta({
  item,
  status,
  steps,
  label,
  agent,
}: {
  item: ToolItem;
  status: NonNullable<ToolItem['status']>;
  steps: number;
  label: string;
  agent: string;
}) {
  const actions = useContext(TimelineActionsContext);
  const tm = useMemo(() => taskMeta(item), [item]);
  const rawToolCallId = item.id.startsWith('tool:') ? item.id.slice(5) : item.id;
  const liveTask = actions.tasksByToolCall.get(rawToolCallId);
  const isBg = liveTask?.backgrounded === true || tm?.backgrounded === true;
  const taskId = liveTask?.id ?? tm?.taskId;
  const model = inputText(item.rawInput, 'model');
  const stepCount = steps > 0 ? steps : (liveTask?.toolUses ?? tm?.toolUses ?? 0);
  const tokens = liveTask?.tokens ?? tm?.tokens;
  const durationMs = liveTask?.durationMs ?? tm?.durationMs;
  const stoppable = status === 'in_progress' && !!actions.stopTask && !!taskId && liveTask?.stoppable !== false && tm?.stoppable !== false;
  const statusLabel = t(`conversation.toolStatus.${status}`);

  return (
    <span className="conv-meta">
      {isBg && <span className="conv-badge conv-bg-badge">{t('conversation.task.background')}</span>}
      {model && <span className="conv-badge conv-model-badge mono">{model}</span>}
      {status === 'in_progress' && tm?.lastTool && (
        <span className="conv-task-live">{t('conversation.task.runningTool', { tool: tm.lastTool })}</span>
      )}
      <span className="conv-subagent-count">{t('conversation.subagent.steps', { n: stepCount })}</span>
      {tokens !== undefined && tokens > 0 && (
        <span className="conv-task-stat">{t('conversation.task.tokens', { tokens: formatTokens(tokens) })}</span>
      )}
      {durationMs !== undefined && durationMs > 0 && <span className="conv-task-stat">{formatDuration(durationMs)}</span>}
      {(status === 'failed' || status === 'cancelled') && (
        <span className={status === 'failed' ? 'conv-bad' : undefined}>{statusLabel}</span>
      )}
      {stoppable && <TaskStopButton taskId={taskId} name={label} agent={agent} stopTask={actions.stopTask!} />}
    </span>
  );
}

/** A subagent's call: its type and what it was asked to do, its status,
 * live progress, and how many items it has; opened, its prompt, its items as
 * the view draws the agent's own, and its result. */
function SubagentView({ item, ctx }: { item: ToolItem; ctx: ItemContext }) {
  const [open, setOpen] = useState(false);
  const status = item.status ?? 'pending';
  const tm = useMemo(() => taskMeta(item), [item]);
  const type = subagentType(item);
  const description = inputText(item.rawInput, 'description') ?? tm?.description ?? (item.title.trim() || undefined);
  const prompt = inputText(item.rawInput, 'prompt');
  const items = item.sub?.items ?? [];
  const results = item.content.filter((c) => c.type !== 'diff');
  const statusLabel = t(`conversation.toolStatus.${status}`);
  const rowLabel = type ?? t('conversation.subagent.label');
  return (
    <div
      className="conv-item conv-quiet conv-tool conv-subagent"
      data-item={item.id}
      data-kind={item.toolKind ?? 'think'}
      data-status={status}
      tabIndex={-1}
    >
      <div className="conv-row">
        <button type="button" className="conv-toggle" aria-expanded={open} title={description} onClick={() => setOpen((o) => !o)}>
          <ChevronRight className="conv-chevron" aria-hidden />
          {status === 'in_progress' || status === 'failed' || status === 'cancelled' ? (
            <StatusIcon kind="think" status={status} />
          ) : (
            <Bot className="conv-kind-icon" aria-hidden />
          )}
          <span className="conv-tool-label">{rowLabel}</span>
          {description && <span className="conv-tool-subject conv-subagent-desc">{description.split('\n')[0]}</span>}
          <span className="conv-sr">, {statusLabel}</span>
        </button>
        <SubagentTaskMeta item={item} status={status} steps={items.length} label={description ?? rowLabel} agent={ctx.agent} />
      </div>
      {open && (
        <div className="conv-tool-body conv-subagent-body">
          {prompt && (
            <Section title={t('conversation.tool.task')}>
              <div className="conv-prompt">{prompt}</div>
            </Section>
          )}
          {items.length > 0 && (
            <div className="conv-subagent-items" role="list" aria-label={t('conversation.subagent.items', { type: rowLabel })}>
              {items.map((it) => (
                <div role="listitem" key={it.id}>
                  <ItemView item={it} ctx={ctx} />
                </div>
              ))}
            </div>
          )}
          {results.length > 0 && (
            <Section title={t('conversation.tool.result')}>
              <Results content={results} kind="think" ctx={ctx} />
            </Section>
          )}
          {results.length === 0 && tm?.summary && (
            <Section title={t('conversation.tool.result')}>
              <Markdown text={tm.summary} variant="compact" base={ctx.base} onOpenPath={ctx.openFile} className="conv-md conv-tool-md" />
            </Section>
          )}
          {tm?.error && <div className="conv-ask-error">{tm.error}</div>}
        </div>
      )}
    </div>
  );
}

/** An item as the view draws it. */
export const ItemView = memo(function ItemView({ item, ctx }: { item: Item; ctx: ItemContext }) {
  switch (item.kind) {
    case 'message':
      return item.role === 'user' ? <UserMessage item={item} ctx={ctx} /> : <AgentMessage item={item} ctx={ctx} />;
    case 'thought':
      return <Thought item={item} ctx={ctx} />;
    case 'tool':
      return isSubagent(item) ? <SubagentView item={item} ctx={ctx} /> : <ToolCallView item={item} ctx={ctx} />;
    case 'plan':
      return <Plan item={item} />;
    case 'notice':
      return <Notice item={item} ctx={ctx} />;
    case 'permission':
      return item.permission === 'plan' ? <PlanCard item={item} ctx={ctx} /> : <PermissionCard item={item} ctx={ctx} />;
    case 'question':
      return <QuestionCard item={item} ctx={ctx} />;
    default:
      return null;
  }
});
