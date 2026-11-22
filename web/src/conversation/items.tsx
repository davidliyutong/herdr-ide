// The items of a conversation as the view draws them: the user's prompts as
// typed, the agent's messages as Markdown (tables, formulas, code; while
// one streams, a block at a time), its thoughts and tool calls as quiet
// rows that open, a subagent's call with the subagent's own items nested in
// it (closed at first, with their count), the turn's plan as a checklist,
// notices as thin separators, and the cards that answer the agent (cards.tsx).
// An item is drawn again only when it changed (the reducer replaces only
// the items an event changes).

import { memo, useMemo, useState } from 'react';
import { Bot, Brain, ChevronRight, Circle, CircleCheck, CircleDot, ListTodo, SquareSlash } from 'lucide-react';
import { Markdown } from '../markdown/Markdown';
import { hasMessage, t } from '../i18n';
import { PermissionCard, PlanCard, QuestionCard } from './cards';
import { displayMath, formatTokens, inputText, plainOutput } from './format';
import {
  asText,
  blocksText,
  CHAT_NOTICES,
  NOTICES,
  STOPPED,
  type Item,
  type MessageItem,
  type NoticeItem,
  type PlanItem,
  type ThoughtItem,
  type ToolItem,
} from './model';
import { Blocks, errorText, isShortened, Shortened, type ItemContext } from './parts';
import { streamBlocks } from './streaming';
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

function UserMessage({ item, ctx }: { item: MessageItem; ctx: ItemContext }) {
  const text = blocksText(item.content);
  const [open, setOpen] = useState(false);
  let lines = 1;
  for (let i = text.indexOf('\n'); i >= 0 && lines <= LONG_PROMPT_LINES; i = text.indexOf('\n', i + 1)) lines++;
  const long = text.length > LONG_PROMPT || lines > LONG_PROMPT_LINES;
  return (
    <div className="conv-item conv-user">
      <div className="conv-bubble" title={when(item.at)}>
        <span className="conv-sr">{t('conversation.you')}: </span>
        {text && <div className={long && !open ? 'conv-user-text clamped' : 'conv-user-text'}>{text}</div>}
        <Blocks blocks={item.content} ctx={ctx} />
        {item.content.some(isShortened) && <Shortened />}
        {long && (
          <button type="button" className="conv-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? t('conversation.showLess') : t('conversation.showMore')}
          </button>
        )}
      </div>
    </div>
  );
}

/** A block of Markdown still arriving, drawn again only when it changed. */
const StreamBlock = memo(function StreamBlock({ text, className }: { text: string; className: string }) {
  return <Markdown text={displayMath(text)} className={className} />;
});

/** Markdown that is still arriving: its blocks apart, so that an increment
 * draws only the last; whole once it no longer streams. */
export function StreamMarkdown({ text, live, className }: { text: string; live?: boolean; className: string }) {
  const blocks = useMemo(() => (live ? streamBlocks(text) : undefined), [text, live]);
  if (!blocks) return <Markdown text={displayMath(text)} className={className} />;
  return (
    <div className="conv-stream" data-live>
      {blocks.map((b, i) => (
        <StreamBlock key={i} text={b} className={className} />
      ))}
    </div>
  );
}

function AgentMessage({ item, ctx }: { item: MessageItem; ctx: ItemContext }) {
  const text = blocksText(item.content);
  return (
    <div className="conv-item conv-agent" aria-busy={item.live || undefined}>
      <span className="conv-sr">{ctx.agent}: </span>
      {text.trim() && <StreamMarkdown text={text} live={item.live} className="conv-md" />}
      <Blocks blocks={item.content} ctx={ctx} />
      {item.content.some(isShortened) && <Shortened />}
    </div>
  );
}

/** A thought: its text opens; one the agent keeps to itself says how many
 * tokens it took, when the agent estimates them. */
function Thought({ item }: { item: ThoughtItem }) {
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
          <StreamMarkdown text={text} live={item.live} className="conv-md conv-thought-text" />
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
    case NOTICES.cleared:
      text = t('conversation.notice.cleared');
      break;
    case NOTICES.skipped:
      text = t('conversation.notice.skipped');
      break;
    case NOTICES.model: {
      const model = str(p.model);
      text = model ? t('conversation.notice.modelTo', { model }) : t('conversation.notice.model');
      break;
    }
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
const subagentType = (item: ToolItem) => inputText(item.rawInput, 'subagent_type', 'agent_type', 'agentType', 'agent');

/** Whether a call runs a subagent: it has the subagent's items, or names
 * a subagent's type. */
export const isSubagent = (item: ToolItem) => !!item.sub || subagentType(item) !== undefined;

/** A subagent's call: its type and what it was asked to do, its status
 * and how many items it has; opened, its prompt, its items as the view
 * draws the agent's own, and its result. */
function SubagentView({ item, ctx }: { item: ToolItem; ctx: ItemContext }) {
  const [open, setOpen] = useState(false);
  const status = item.status ?? 'pending';
  const type = subagentType(item);
  const description = inputText(item.rawInput, 'description') ?? (item.title.trim() || undefined);
  const prompt = inputText(item.rawInput, 'prompt');
  const items = item.sub?.items ?? [];
  const results = item.content.filter((c) => c.type !== 'diff');
  const statusLabel = t(`conversation.toolStatus.${status}`);
  return (
    <div className="conv-item conv-quiet conv-tool conv-subagent" data-kind={item.toolKind ?? 'think'} data-status={status}>
      <div className="conv-row">
        <button type="button" className="conv-toggle" aria-expanded={open} title={description} onClick={() => setOpen((o) => !o)}>
          <ChevronRight className="conv-chevron" aria-hidden />
          {status === 'in_progress' || status === 'failed' || status === 'cancelled' ? (
            <StatusIcon kind="think" status={status} />
          ) : (
            <Bot className="conv-kind-icon" aria-hidden />
          )}
          <span className="conv-tool-label">{type ?? t('conversation.subagent.label')}</span>
          {description && <span className="conv-tool-subject conv-subagent-desc">{description.split('\n')[0]}</span>}
          <span className="conv-sr">, {statusLabel}</span>
        </button>
        <span className="conv-meta">
          <span className="conv-subagent-count">{t('conversation.subagent.steps', { n: items.length })}</span>
          {(status === 'failed' || status === 'cancelled') && (
            <span className={status === 'failed' ? 'conv-bad' : undefined}>{statusLabel}</span>
          )}
        </span>
      </div>
      {open && (
        <div className="conv-tool-body conv-subagent-body">
          {prompt && (
            <Section title={t('conversation.tool.task')}>
              <div className="conv-prompt">{prompt}</div>
            </Section>
          )}
          {items.length > 0 && (
            <div
              className="conv-subagent-items"
              role="list"
              aria-label={t('conversation.subagent.items', { type: type ?? t('conversation.subagent.label') })}
            >
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
      return <Thought item={item} />;
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
