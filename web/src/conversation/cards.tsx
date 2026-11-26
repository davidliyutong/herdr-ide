// The cards with which the user answers the agent, in the conversation at
// the place it asked: a permission (a command to run with its directory
// and reason, a change of files with its diff, another tool with its
// input), the approval of a plan (the plan as Markdown, approved to go on
// in a mode, or planning on), and questions (one or more, a choice of one
// or several options with their previews, the user's own words where
// allowed, hidden as typed where secret; or skipped). The first answer is
// the one that counts, and another window may give it: a card shows an
// answer as the user's own only when this page gave it (parts.tsx
// answeredOf, which outlives the view while the page lives); any other
// answer it shows as given, without saying where (after a reload, or
// attaching again, a card may come waiting and its answer after it, which
// the page cannot tell from another window's). Number keys choose a
// permission's options while the card has the keyboard.

import { useContext, useId, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ClipboardList, MessageCircleQuestion, ShieldQuestion } from 'lucide-react';
import { Markdown } from '../markdown/Markdown';
import { hasMessage, t } from '../i18n';
import { commandOf, inputText, jsonText } from './format';
import {
  asText,
  OPTION_ALLOW_ONCE,
  OPTION_ALLOW_SESSION,
  OPTION_REJECT_ONCE,
  PLAN_OPTION_PREFIX,
  type PermissionItem,
  type PermissionOption,
  type Question,
  type QuestionItem,
} from './model';
import { ANSWERED, AnsweringContext, errorText, keepAnswer, SKIPPED, type ItemContext } from './parts';
import { changedPaths, ChangeView, isDiff, PathButton, readDiff, Section } from './ToolCall';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What an option says: the host's options and plan modes in the view's
 * words, an agent's own by its name, else by its kind. */
export function optionLabel(o: PermissionOption): string {
  if (o.optionId === OPTION_ALLOW_ONCE) return t('conversation.ask.allowOnce');
  if (o.optionId === OPTION_ALLOW_SESSION) return t('conversation.ask.allowSession');
  if (o.optionId === OPTION_REJECT_ONCE) return t('conversation.ask.reject');
  if (o.optionId.startsWith(PLAN_OPTION_PREFIX)) {
    const key = `conversation.plan.approve.${o.optionId.slice(PLAN_OPTION_PREFIX.length)}`;
    if (hasMessage(key)) return t(key);
  }
  return o.name.trim() || t(`conversation.ask.kind.${o.kind}`);
}

const allows = (o: PermissionOption) => o.kind === 'allow_once' || o.kind === 'allow_always';

/** Whether a command's refusal leaves its outcome unknown (the source's
 * error says unsure): the answer may have been taken. */
const unsureOf = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { unsure?: unknown }).unsure === true;

/** How a card that waits no longer does, in words; mine: the answer is
 * the one this page gave. */
function doneText(by: string | undefined, chosen: string | undefined, mine: boolean): string {
  if (chosen !== undefined)
    return mine ? t('conversation.ask.youChose', { option: chosen }) : t('conversation.ask.answered', { option: chosen });
  if (by === 'cancel') return t('conversation.ask.cancelled');
  if (by === 'ended') return t('conversation.ask.ended');
  return mine ? t('conversation.ask.youDismissed') : t('conversation.ask.dismissed');
}

/** A card's frame: its heading, body, and what answers it. */
function Card({
  item,
  kind,
  icon,
  heading,
  request,
  state,
  parent,
  children,
  onKeyDown,
}: {
  /** The card's item id. */
  item: string;
  kind: string;
  icon: ReactNode;
  heading: string;
  request: string;
  state: 'waiting' | 'done' | 'stale';
  parent?: string;
  children: ReactNode;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const id = useId();
  return (
    <div
      className="conv-item conv-ask"
      data-item={item}
      data-ask={kind}
      data-request={request}
      data-state={state}
      role="group"
      aria-labelledby={id}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="conv-ask-head">
        {icon}
        <span id={id} className="conv-ask-title">
          {heading}
        </span>
        {parent && <span className="conv-ask-from">{t('conversation.ask.fromSubagent')}</span>}
      </div>
      {children}
    </div>
  );
}

/** A tool's input in a few lines: its members, each on one line, cut
 * short; the whole on request. */
function InputSummary({ input }: { input: unknown }) {
  const [open, setOpen] = useState(false);
  if (input === undefined) return null;
  const rows = isObject(input)
    ? Object.entries(input)
        .slice(0, 6)
        .map(([k, v]) => {
          const s = typeof v === 'string' ? v : jsonText(v, 400).replace(/\s+/g, ' ');
          return [k, s.length > 160 ? `${s.slice(0, 160)}…` : s] as const;
        })
    : [];
  return (
    <div className="conv-ask-input">
      {rows.length > 0 && !open && (
        <dl className="conv-kv">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {open && <pre className="conv-pre">{jsonText(input)}</pre>}
      <button type="button" className="conv-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? t('conversation.ask.hideInput') : t('conversation.ask.showInput')}
      </button>
    </div>
  );
}

/** What a permission is asked for, by its kind. */
function PermissionBody({ item, ctx }: { item: PermissionItem; ctx: ItemContext }) {
  const call = item.call;
  const changes = useMemo(() => call.content.filter(isDiff).map(readDiff), [call.content]);
  switch (item.permission) {
    case 'command': {
      const command = commandOf(call.rawInput) ?? (call.title || undefined);
      const cwd = inputText(call.rawInput, 'cwd', 'workdir', 'directory');
      const title = call.title.trim();
      const reason = inputText(call.rawInput, 'reason', 'justification') ?? (title && title !== command ? title : undefined);
      return (
        <>
          {reason && <div className="conv-ask-reason">{reason}</div>}
          {command && <pre className="conv-pre conv-command conv-ask-command">{command}</pre>}
          {cwd && <div className="conv-note">{t('conversation.ask.inDirectory', { cwd })}</div>}
        </>
      );
    }
    case 'file': {
      const paths: { path: string; line?: number | null }[] = call.locations.length ? call.locations : changedPaths(changes);
      const reason = inputText(call.rawInput, 'reason', 'justification');
      return (
        <>
          {reason && <div className="conv-ask-reason">{reason}</div>}
          {paths.length > 0 && (
            <div className="conv-ask-paths">
              {paths.slice(0, 8).map((p, i) => (
                <PathButton key={i} path={p.path} line={p.line} ctx={ctx} />
              ))}
              {paths.length > 8 && <span className="conv-more">+{paths.length - 8}</span>}
            </div>
          )}
          {changes.map((c, i) => (
            <ChangeView key={i} change={c} header={changes.length > 1} ctx={ctx} />
          ))}
        </>
      );
    }
    default:
      return (
        <>
          {call.title && <div className="conv-ask-tool mono">{call.title}</div>}
          <InputSummary input={call.rawInput} />
        </>
      );
  }
}

/** The heading of a permission, by its kind. */
function permissionHeading(item: PermissionItem, agent: string): string {
  switch (item.permission) {
    case 'command':
      return t('conversation.ask.command', { agent });
    case 'file':
      return t('conversation.ask.file', { agent });
    case 'mcp':
      return t('conversation.ask.mcp', { agent });
    default:
      return item.call.title.trim()
        ? t('conversation.ask.toolNamed', { agent, tool: item.call.title.trim() })
        : t('conversation.ask.tool', { agent });
  }
}

/** The answer this page gave to a card (Answering.answered), and how to
 * keep another: the card is drawn again when it changes. */
function useMine(item: string): [string | undefined, (answer: string | undefined) => void] {
  const answering = useContext(AnsweringContext);
  const [, redraw] = useState(0);
  const set = (answer: string | undefined) => {
    keepAnswer(answering.answered, item, answer);
    redraw((n) => n + 1);
  };
  return [answering.answered.get(item), set];
}

/** The answers of a permission or a plan: its options while it waits and
 * may be answered, else how it was answered. */
function useAnswer(item: PermissionItem, agent: string) {
  const answering = useContext(AnsweringContext);
  /** The option this page chose ('' for none: dismissed), and whether it
   * is being sent. */
  const [mine, setMine] = useMine(item.id);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const done = !!item.outcome;
  const waiting = !done && answering.open && answering.waiting.has(item.id);
  const choose = (option: string | undefined) => {
    if (!waiting || sending) return;
    setSending(true);
    setFailed(undefined);
    setMine(option ?? '');
    answering.respond(item.request, option === undefined ? { cancelled: true } : { option }).then(
      () => setSending(false),
      (e: unknown) => {
        setSending(false);
        // Sent, and perhaps taken: still this page's answer if it comes.
        if (!unsureOf(e)) setMine(undefined);
        // Another window answered first: its answer comes as the card's.
        if ((e as { code?: unknown })?.code !== 'not_found') setFailed(errorText(e, agent, 'conversation.commandFailed'));
      },
    );
  };
  const chosen =
    item.outcome?.outcome === 'selected'
      ? (() => {
          const o = item.options.find((x) => x.optionId === item.outcome!.optionId);
          return o ? optionLabel(o) : item.outcome!.optionId;
        })()
      : undefined;
  const state: 'waiting' | 'done' | 'stale' = done ? 'done' : waiting ? 'waiting' : 'stale';
  const status = done
    ? doneText(item.by, chosen, mine !== undefined && (chosen === undefined ? mine === '' : item.outcome?.optionId === mine))
    : !waiting
      ? answering.readOnly
        ? t('conversation.ask.readOnly')
        : t('conversation.ask.stale')
      : undefined;
  /** Number keys choose the options, in their order. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!waiting || e.altKey || e.ctrlKey || e.metaKey || !/^[1-9]$/.test(e.key)) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const o = item.options[Number(e.key) - 1];
    if (!o) return;
    e.preventDefault();
    choose(o.optionId);
  };
  return { waiting, sending, failed: done ? undefined : failed, state, status, choose, onKeyDown };
}

function Outcome({ status, failed }: { status?: string; failed?: string }) {
  return (
    <>
      {status && (
        <div className="conv-ask-outcome" role="status">
          {status}
        </div>
      )}
      {failed && (
        <div className="conv-ask-error" role="alert">
          {failed}
        </div>
      )}
    </>
  );
}

/** A permission the agent asks for. */
export function PermissionCard({ item, ctx }: { item: PermissionItem; ctx: ItemContext }) {
  const a = useAnswer(item, ctx.agent);
  const firstAllow = item.options.findIndex(allows);
  return (
    <Card
      item={item.id}
      kind={item.permission}
      icon={<ShieldQuestion aria-hidden />}
      heading={permissionHeading(item, ctx.agent)}
      request={item.request}
      state={a.state}
      parent={item.parent}
      onKeyDown={a.onKeyDown}
    >
      <div className="conv-ask-body">
        <PermissionBody item={item} ctx={ctx} />
      </div>
      {a.waiting && (
        <div className="conv-ask-actions">
          {item.options.map((o, i) => (
            <button
              key={o.optionId}
              type="button"
              className={i === firstAllow ? 'primary sm' : 'sm'}
              data-option={o.optionId}
              data-kind={o.kind}
              aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
              disabled={a.sending}
              onClick={() => a.choose(o.optionId)}
            >
              {optionLabel(o)}
            </button>
          ))}
          {!item.options.length && (
            <button type="button" className="sm" disabled={a.sending} onClick={() => a.choose(undefined)}>
              {t('conversation.ask.dismiss')}
            </button>
          )}
        </div>
      )}
      <Outcome status={a.status} failed={a.failed} />
    </Card>
  );
}

/** The plan of a plan's approval: the plan the agent wrote (Claude Code's
 * plan member), else the call's text. */
function planText(item: PermissionItem): string {
  const plan = inputText(item.call.rawInput, 'plan');
  if (plan) return plan;
  const text = item.call.content
    .flatMap((c) => (c.type === 'content' ? [c.content] : []))
    .map((b) => (b.type === 'text' ? (asText(b.text) ?? '') : ''))
    .join('\n');
  return text.trim() || item.call.title;
}

/** The approval of a plan: approved to go on in a mode, or planning on. */
export function PlanCard({ item, ctx }: { item: PermissionItem; ctx: ItemContext }) {
  const a = useAnswer(item, ctx.agent);
  const plan = planText(item);
  const approve = item.options.filter((o) => o.optionId.startsWith(PLAN_OPTION_PREFIX) || (allows(o) && !o.optionId.includes(':')));
  const keep = item.options.filter((o) => !approve.includes(o));
  return (
    <Card
      item={item.id}
      kind="plan"
      icon={<ClipboardList aria-hidden />}
      heading={t('conversation.plan.heading', { agent: ctx.agent })}
      request={item.request}
      state={a.state}
      parent={item.parent}
      onKeyDown={a.onKeyDown}
    >
      {plan.trim() && (
        <div className="conv-ask-plan">
          <Markdown text={plan} variant="compact" base={ctx.base} onOpenPath={ctx.openFile} className="conv-md conv-tool-md" />
        </div>
      )}
      {a.waiting && (
        <div className="conv-ask-actions">
          {approve.map((o, i) => (
            <button
              key={o.optionId}
              type="button"
              className={i === 0 ? 'primary sm' : 'sm'}
              data-option={o.optionId}
              aria-keyshortcuts={String(item.options.indexOf(o) + 1)}
              disabled={a.sending}
              onClick={() => a.choose(o.optionId)}
            >
              {optionLabel(o)}
            </button>
          ))}
          {keep.map((o) => (
            <button
              key={o.optionId}
              type="button"
              className="sm"
              data-option={o.optionId}
              aria-keyshortcuts={String(item.options.indexOf(o) + 1)}
              disabled={a.sending}
              onClick={() => a.choose(o.optionId)}
            >
              {o.optionId === OPTION_REJECT_ONCE ? t('conversation.plan.keepPlanning') : optionLabel(o)}
            </button>
          ))}
        </div>
      )}
      <Outcome status={a.status} failed={a.failed} />
    </Card>
  );
}

/** What the user gave a question so far. */
interface Draft {
  /** The options chosen, by label. */
  chosen: string[];
  /** "Other" is chosen (with its text). */
  other: boolean;
  text: string;
  /** The option whose preview shows. */
  preview?: string;
}

const emptyDraft = (): Draft => ({ chosen: [], other: false, text: '' });

/** A question's answers from its draft: the options chosen, and the user's
 * own words (a question without options takes only those). */
function answersOf(q: Question, d: Draft): string[] {
  const text = d.text.trim();
  if (!q.options?.length) return text ? [d.text] : [];
  const out = [...d.chosen];
  if (q.allowOther && d.other && text) out.push(d.text);
  return out;
}

function QuestionField({
  q,
  draft,
  disabled,
  ctx,
  onChange,
}: {
  q: Question;
  draft: Draft;
  disabled: boolean;
  ctx: ItemContext;
  onChange: (d: Draft) => void;
}) {
  const name = useId();
  const multi = !!q.multiSelect;
  const options = q.options ?? [];
  const pick = (label: string, on: boolean) => {
    if (multi) onChange({ ...draft, chosen: on ? [...draft.chosen, label] : draft.chosen.filter((x) => x !== label), preview: label });
    else onChange({ ...draft, chosen: on ? [label] : [], other: false, preview: label });
  };
  const preview = options.find((o) => o.label === (draft.preview ?? draft.chosen[draft.chosen.length - 1]))?.preview;
  const textType = q.secret ? 'password' : 'text';
  return (
    <fieldset className="conv-q" disabled={disabled}>
      <legend>
        {q.header && <span className="conv-q-header">{q.header}</span>}
        <span className="conv-q-text">{q.question}</span>
      </legend>
      {options.length > 0 && (
        <div className="conv-q-options">
          {options.map((o) => (
            <label key={o.label} className="conv-q-option">
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={name}
                value={o.label}
                checked={draft.chosen.includes(o.label)}
                onChange={(e) => pick(o.label, e.target.checked)}
                onFocus={() => o.preview && onChange({ ...draft, preview: o.label })}
              />
              <span className="conv-q-label">{o.label}</span>
              {o.description && <span className="conv-q-desc">{o.description}</span>}
            </label>
          ))}
          {q.allowOther && (
            <label className="conv-q-option conv-q-other">
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={name}
                checked={draft.other}
                onChange={(e) => onChange({ ...draft, other: e.target.checked, chosen: multi ? draft.chosen : [] })}
              />
              <span className="conv-q-label">{t('conversation.question.other')}</span>
              <input
                type={textType}
                className="conv-q-input"
                value={draft.text}
                aria-label={t('conversation.question.otherLabel')}
                placeholder={t('conversation.question.otherPlaceholder')}
                autoComplete="off"
                onChange={(e) => onChange({ ...draft, text: e.target.value, other: true, chosen: multi ? draft.chosen : [] })}
              />
            </label>
          )}
        </div>
      )}
      {!options.length && (
        <input
          type={textType}
          className="conv-q-input"
          value={draft.text}
          aria-label={q.header || q.question}
          autoComplete="off"
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
        />
      )}
      {preview && (
        <div className="conv-q-preview">
          <Markdown text={preview} variant="compact" base={ctx.base} onOpenPath={ctx.openFile} className="conv-md conv-tool-md" />
        </div>
      )}
    </fieldset>
  );
}

/** Questions the agent asks the user: answered together, or skipped. */
export function QuestionCard({ item, ctx }: { item: QuestionItem; ctx: ItemContext }) {
  const answering = useContext(AnsweringContext);
  // By question id: a Map, as an id may be any text.
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(() => new Map());
  const [sending, setSending] = useState(false);
  /** How this page answered: ANSWERED or SKIPPED. */
  const [mine, setMine] = useMine(item.id);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const waiting = !item.done && answering.open && answering.waiting.has(item.id);
  const draftOf = (q: Question) => drafts.get(q.id) ?? emptyDraft();
  const ready = item.questions.every((q) => answersOf(q, draftOf(q)).length > 0);
  const reply = (cancelled: boolean) => {
    if (!waiting || sending) return;
    const answers: Record<string, string[]> = Object.create(null);
    for (const q of item.questions) answers[q.id] = answersOf(q, draftOf(q));
    setSending(true);
    setFailed(undefined);
    setMine(cancelled ? SKIPPED : ANSWERED);
    answering.answer(item.request, cancelled ? { cancelled: true } : { answers }).then(
      () => setSending(false),
      (e: unknown) => {
        setSending(false);
        if (!unsureOf(e)) setMine(undefined);
        if ((e as { code?: unknown })?.code !== 'not_found') setFailed(errorText(e, ctx.agent, 'conversation.commandFailed'));
      },
    );
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) reply(false);
  };
  const state: 'waiting' | 'done' | 'stale' = item.done ? 'done' : waiting ? 'waiting' : 'stale';
  const heading =
    item.questions.length > 1
      ? t('conversation.question.headingMany', { agent: ctx.agent, n: item.questions.length })
      : t('conversation.question.heading', { agent: ctx.agent });
  let status: string | undefined;
  if (item.done) {
    const answered = !!item.answers && Object.values(item.answers).some((a) => a.length);
    if (answered) status = mine === ANSWERED ? t('conversation.question.youAnswered') : t('conversation.question.answered');
    else if (item.by === 'cancel') status = t('conversation.ask.cancelled');
    else if (item.by === 'ended') status = t('conversation.ask.ended');
    else status = t('conversation.question.skipped');
  } else if (!waiting) status = answering.readOnly ? t('conversation.ask.readOnly') : t('conversation.ask.stale');
  return (
    <Card
      item={item.id}
      kind="question"
      icon={<MessageCircleQuestion aria-hidden />}
      heading={heading}
      request={item.request}
      state={state}
      parent={item.parent}
    >
      {waiting ? (
        <form className="conv-ask-body conv-q-form" onSubmit={submit}>
          {item.questions.map((q) => (
            <QuestionField
              key={q.id}
              q={q}
              draft={draftOf(q)}
              disabled={sending}
              ctx={ctx}
              onChange={(d) => setDrafts((x) => new Map(x).set(q.id, d))}
            />
          ))}
          <div className="conv-ask-actions">
            <button type="submit" className="primary sm" disabled={!ready || sending}>
              {t('conversation.question.submit')}
            </button>
            <button type="button" className="sm" disabled={sending} onClick={() => reply(true)}>
              {t('conversation.question.skip')}
            </button>
          </div>
        </form>
      ) : (
        <div className="conv-ask-body">
          {item.questions.map((q) => {
            const a = item.answers && Object.hasOwn(item.answers, q.id) ? item.answers[q.id] : undefined;
            return (
              <Section key={q.id} title={q.header || q.question}>
                {q.header && <div className="conv-q-text">{q.question}</div>}
                {a?.length ? <div className="conv-q-answer">{q.secret ? t('conversation.question.secret') : a.join(', ')}</div> : null}
              </Section>
            );
          })}
        </div>
      )}
      <Outcome status={status} failed={item.done ? undefined : failed} />
    </Card>
  );
}
