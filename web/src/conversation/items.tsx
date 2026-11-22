// The items of a conversation as the view draws them: the user's prompts as
// typed, the agent's messages as Markdown (tables, formulas, code), its
// thoughts and tool calls as quiet rows that open, the turn's plan as a
// checklist and notices as thin separators. An item is drawn again only
// when it changed (the reducer replaces only the items an event changes).

import { memo, useState } from 'react';
import { Brain, ChevronRight, Circle, CircleCheck, CircleDot, ListTodo, SquareSlash } from 'lucide-react';
import { Markdown } from '../markdown/Markdown';
import { hasMessage, t } from '../i18n';
import { displayMath, plainOutput } from './format';
import {
  asText,
  blocksText,
  NOTICES,
  STOPPED,
  type Item,
  type MessageItem,
  type NoticeItem,
  type PlanItem,
  type ThoughtItem,
} from './model';
import { Blocks, isShortened, Shortened, type ItemContext } from './parts';
import { ToolCallView } from './ToolCall';

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

function AgentMessage({ item, ctx }: { item: MessageItem; ctx: ItemContext }) {
  const text = blocksText(item.content);
  return (
    <div className="conv-item conv-agent">
      <span className="conv-sr">{ctx.agent}: </span>
      {text.trim() && <Markdown text={displayMath(text)} className="conv-md" />}
      <Blocks blocks={item.content} ctx={ctx} />
      {item.content.some(isShortened) && <Shortened />}
    </div>
  );
}

function Thought({ item }: { item: ThoughtItem }) {
  const text = blocksText(item.content).trim();
  const [open, setOpen] = useState(false);
  const head = (
    <>
      <ChevronRight className="conv-chevron" aria-hidden />
      <Brain className="conv-kind-icon" aria-hidden />
      <span className="conv-tool-label">{t('conversation.thought')}</span>
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
          <Markdown text={text} className="conv-md conv-thought-text" />
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

function Notice({ item }: { item: NoticeItem }) {
  const [open, setOpen] = useState(false);
  const p = isObject(item.params) ? item.params : {};
  let text: string;
  let error = false;
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
    case NOTICES.error:
      error = true;
      text = str(p.message) ?? str(p.text) ?? str(p.error) ?? t('conversation.notice.error');
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
      </div>
      {open && output && <pre className="conv-pre conv-term">{plainOutput(output)}</pre>}
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
      return <ToolCallView item={item} ctx={ctx} />;
    case 'plan':
      return <Plan item={item} />;
    case 'notice':
      return <Notice item={item} />;
    default:
      return null;
  }
});
