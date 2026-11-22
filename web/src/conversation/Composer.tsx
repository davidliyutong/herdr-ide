// The composer of a chat: a field that sends on Enter (Shift+Enter or
// Alt+Enter: a new line), images attached by pasting, dropping or picking
// them (each at most MAX_IMAGE bytes, the message at most MAX_PROMPT, shown
// as thumbnails that can be removed), files of the chat's directory named
// with `@` (a list of the source's suggestions; the message then links
// them), the agent's commands with `/` (and compact, where the agent can),
// selectors of the model, the effort and the permission mode from the
// chat's options, the messages queued while a turn runs (withdrawn where
// the agent can), a stop button while it runs (and Escape), and a line of
// usage: the cost, the context in use, the tightest limit window and when
// it resets. Read-only, every control is disabled.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { ArrowUp, Clock, FileText, ImagePlus, ListPlus, LoaderCircle, Square, SquareSlash, TriangleAlert, X } from 'lucide-react';
import { locale, t, type MessageKey } from '../i18n';
import { AttachError, fits, formatBytes, IMAGE_TYPES, MAX_ATTACHMENTS, promptContent, readImage, type Attachment } from './attach';
import { contextPercent, formatCost, formatTokens, relativeTime, tightest, windowLabel } from './format';
import {
  blocksText,
  CATEGORY_MODE,
  CATEGORY_MODEL,
  CATEGORY_THOUGHT_LEVEL,
  configOf,
  MAX_IMAGE,
  MAX_PROMPT,
  MODES,
  NO_CAPABILITIES,
  type ChatError,
  type ChatInfo,
  type QueuedMessage,
  type Usage,
} from './model';
import { errorText } from './parts';
import type { ChatSource, FileSuggestion } from './source';
import type { ConfigOption, ConfigValue, Limit } from '../plugins/chat/protocol';

/** The user's text not sent yet, by chat (the source's id) or by source:
 * it outlives the view until it is sent. */
const drafts = new WeakMap<ChatSource, string>();
const namedDrafts = new Map<string, string>();
/** The most drafts kept by name. */
const MAX_DRAFTS = 200;

function draftOf(s: ChatSource): string {
  return (s.id ? namedDrafts.get(s.id) : drafts.get(s)) ?? '';
}

function keepDraft(s: ChatSource, text: string) {
  if (!s.id) {
    if (text) drafts.set(s, text);
    else drafts.delete(s);
    return;
  }
  namedDrafts.delete(s.id);
  if (!text) return;
  namedDrafts.set(s.id, text);
  if (namedDrafts.size > MAX_DRAFTS) namedDrafts.delete(namedDrafts.keys().next().value!);
}

/** A field's height to fit its text (up to its CSS max-height). */
function grow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

/** A new id of a message, the page's (Command.clientId). */
function newClientId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/** The list the field offers at the caret: the agent's commands after a
 * `/` that begins the text, or files after an `@` that begins a word. */
export interface MenuAt {
  type: 'slash' | 'mention';
  /** Where the word the list replaces begins and ends. */
  start: number;
  end: number;
  /** What is typed of it after its mark. */
  query: string;
}

export function menuAt(text: string, caret: number): MenuAt | undefined {
  const before = text.slice(0, caret);
  const rest = (re: RegExp) => re.exec(text.slice(caret))?.[0].length ?? 0;
  const slash = /^\/([^\s/]*)$/.exec(before);
  if (slash) return { type: 'slash', start: 0, end: caret + rest(/^\S*/), query: slash[1] };
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { type: 'mention', start: at.index + at[1].length, end: caret + rest(/^[^\s@]*/), query: at[2] };
  return undefined;
}

interface MenuItem {
  key: string;
  label: string;
  detail?: string;
  hint?: string;
  insert: string;
  mention?: FileSuggestion;
}

/** The most items the list shows. */
const MAX_MENU = 50;

/** How long after a keystroke the files that match are asked for. */
const SUGGEST_MS = 80;

/** Whether a message is the compact command, which the view sends as
 * compact rather than as text. */
const isCompact = (text: string) => /^\/compact\s*$/.test(text.trim());

function attachErrorText(e: unknown, agent: string): string {
  if (e instanceof AttachError) {
    switch (e.code) {
      case 'notImage':
        return t('conversation.attach.notImage', { name: e.file });
      case 'tooLarge':
        return t('conversation.attach.tooLarge', { name: e.file, max: formatBytes(MAX_IMAGE) });
      default:
        return t('conversation.attach.unreadable', { name: e.file });
    }
  }
  return t('conversation.attach.unreadable', { name: agent });
}

/** A mode's name in the view's words when it is one of the host's. */
function modeName(v: ConfigValue): string {
  return (MODES as readonly string[]).includes(v.value) ? t(`conversation.mode.${v.value as (typeof MODES)[number]}`) : v.name;
}

/** Why the values that give an agent full access (ConfigValue.full) are
 * not offered: the machine's settings do not allow it, or the view is
 * read-only. */
export type FullBlocked = 'off' | 'readOnly' | undefined;

function ConfigSelect({
  option,
  label,
  nameOf,
  disabled,
  fullBlocked,
  onSet,
}: {
  option: ConfigOption;
  label: string;
  nameOf?: (v: ConfigValue) => string;
  disabled: boolean;
  fullBlocked: FullBlocked;
  onSet: (id: string, value: string) => Promise<void>;
}) {
  /** The value asked for until the host took it. */
  const [asked, setAsked] = useState<string | undefined>(undefined);
  const value = asked ?? option.currentValue;
  const values = option.options.some((o) => o.value === value) ? option.options : [{ value, name: value }, ...option.options];
  const blocked = (v: ConfigValue) => !!fullBlocked && v.full === true;
  let title = option.description ? `${label}: ${option.description}` : label;
  if (fullBlocked === 'off' && values.some(blocked)) title += `\n${t('conversation.config.fullOffHint')}`;
  return (
    <select
      className="conv-select"
      data-config={option.category}
      value={value}
      aria-label={label}
      title={title}
      disabled={disabled || asked !== undefined}
      onChange={(e) => {
        const v = e.target.value;
        setAsked(v);
        onSet(option.id, v).finally(() => setAsked(undefined));
      }}
    >
      {values.map((v) => {
        const name = nameOf ? nameOf(v) : v.name;
        return blocked(v) ? (
          <option key={v.value} value={v.value} disabled data-full={fullBlocked}>
            {t(fullBlocked === 'readOnly' ? 'conversation.config.fullReadOnly' : 'conversation.config.fullOff', { name })}
          </option>
        ) : (
          <option key={v.value} value={v.value} title={v.description}>
            {name}
          </option>
        );
      })}
    </select>
  );
}

/** The current time, again every minute while shown. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

const limitName = (l: Limit) => l.label || (l.windowMinutes ? windowLabel(l.windowMinutes) : l.id);

/** The chat's usage: the context in use, the cost so far, and the limit
 * window most used with when it resets. */
export function UsageLine({ usage }: { usage: Usage }) {
  const pct = contextPercent(usage);
  const limit = tightest(usage.limits);
  const now = useNow(!!limit?.resetsAt);
  const level = (p: number) => (p >= 90 ? 'high' : p >= 75 ? 'mid' : undefined);
  const parts = [];
  if (pct !== undefined) {
    const n = Math.round(pct);
    parts.push(
      <span
        key="ctx"
        className="conv-meter"
        role="meter"
        aria-label={t('conversation.contextUsed')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={n}
        title={
          usage.size > 0
            ? t('conversation.context', { used: formatTokens(usage.used), size: formatTokens(usage.size) })
            : t('conversation.contextUsed')
        }
        data-level={level(pct)}
      >
        <span className="conv-meter-bar">
          <span style={{ width: `${n}%` }} />
        </span>
        <span className="conv-meter-pct">{t('conversation.usage.context', { pct: n })}</span>
      </span>,
    );
  } else if (usage.used > 0) {
    parts.push(
      <span key="ctx" className="conv-usage-tokens">
        {t('conversation.usage.tokens', { n: formatTokens(usage.used) })}
      </span>,
    );
  }
  if (usage.cost)
    parts.push(
      <span key="cost" className="conv-usage-cost" title={t('conversation.usage.costTitle')}>
        {formatCost(usage.cost, locale)}
      </span>,
    );
  if (limit) {
    const all = (usage.limits ?? [])
      .map((l) => t('conversation.usage.limit', { window: limitName(l), pct: Math.round(l.usedPercent) }))
      .join('\n');
    parts.push(
      <span key="limit" className="conv-usage-limit" data-level={level(limit.usedPercent)} title={all}>
        {t('conversation.usage.limit', { window: limitName(limit), pct: Math.round(limit.usedPercent) })}
        {limit.resetsAt ? ` · ${t('conversation.usage.resets', { when: relativeTime(limit.resetsAt, now, locale) })}` : ''}
      </span>,
    );
  }
  if (!parts.length) return null;
  return (
    <div className="conv-usage" aria-label={t('conversation.usage.label')}>
      {parts}
    </div>
  );
}

export interface ComposerProps {
  source: ChatSource;
  agent: string;
  chat?: ChatInfo;
  usage?: Usage;
  queued: readonly QueuedMessage[];
  /** A turn runs. */
  working: boolean;
  /** A permission or a question waits for the user. */
  waiting: boolean;
  state?: string;
  stateError?: ChatError;
  readOnly: boolean;
  /** The machine allows full access (its setting chat.allowFullAccess):
   * without it, and read-only, the values that give it are not offered. */
  allowFull: boolean;
  /** Shows the card that waits for the user. */
  onShowWaiting(): void;
  /** Whether the conversation has the user's message of that clientId (the
   * agent took it, or it is queued). */
  delivered?(clientId: string): boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

/** Whether a command's refusal leaves its outcome unknown: it was sent,
 * and the connection or the subscription ended before the answer came
 * (the source's error says unsure). */
const unsureOf = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { unsure?: unknown }).unsure === true;

export function Composer({
  source,
  agent,
  chat,
  usage,
  queued,
  working,
  waiting,
  state,
  stateError,
  readOnly,
  allowFull,
  onShowWaiting,
  delivered,
  inputRef,
}: ComposerProps) {
  const caps = chat?.capabilities ?? NO_CAPABILITIES;
  const [text, setText] = useState(() => draftOf(source));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mentions, setMentions] = useState<FileSuggestion[]>([]);
  const [pending, setPending] = useState(false);
  /** Why the last thing the user did was not done. */
  const [failed, setFailed] = useState<string | undefined>(undefined);
  /** The message last sent whose outcome is not known: its id, which
   * sending the same content again keeps (the host takes a message of one
   * id once), and its content. unsure: the connection ended before the
   * answer, and it shows in the conversation once the host has it. */
  const outstanding = useRef<{ clientId: string; key: string } | undefined>(undefined);
  const [unsure, setUnsure] = useState(false);
  const deliveredRef = useRef(delivered);
  useLayoutEffect(() => {
    deliveredRef.current = delivered;
  });
  const [caret, setCaret] = useState(text.length);
  /** The list the user closed (its kind and where its word begins). */
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<{ query: string; items: FileSuggestion[] } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const live = useRef(true);
  const nextCaret = useRef<number | undefined>(undefined);
  const picker = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    const el = inputRef.current;
    grow(el);
    if (el && nextCaret.current !== undefined) {
      el.setSelectionRange(nextCaret.current, nextCaret.current);
      setCaret(nextCaret.current);
      nextCaret.current = undefined;
    }
  }, [text, inputRef]);

  const fail = (message: string) => {
    if (live.current) setFailed(message);
  };
  const run = (p: () => Promise<void>, fallback: MessageKey = 'conversation.commandFailed') =>
    Promise.resolve()
      .then(p)
      .catch((e: unknown) => fail(errorText(e, agent, fallback)));

  // ---- the list at the caret ----
  const at = readOnly ? undefined : menuAt(text, caret);
  const menuKey = at ? `${at.type}:${at.start}` : undefined;
  const suggest = source.suggestFiles?.bind(source);
  const query = at?.type === 'mention' && suggest ? at.query : undefined;
  useEffect(() => {
    if (query === undefined || menuKey === dismissed) return;
    let current = true;
    const id = setTimeout(() => {
      suggest!(query).then(
        (items) => current && setFiles({ query, items: Array.isArray(items) ? items.slice(0, MAX_MENU) : [] }),
        () => current && setFiles({ query, items: [] }),
      );
    }, SUGGEST_MS);
    return () => {
      current = false;
      clearTimeout(id);
    };
    // suggest is the source's: a new one comes with a new source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, menuKey, dismissed, source]);
  const commands = chat?.commands;
  const menuItems = useMemo((): MenuItem[] => {
    if (!at) return [];
    if (at.type === 'mention') {
      if (!files || files.query !== at.query) return [];
      return files.items
        .filter((f) => f && typeof f.path === 'string' && typeof f.label === 'string' && !/\s/.test(f.label))
        .map((f) => ({ key: f.path, label: f.label, detail: f.path, insert: `@${f.label} `, mention: f }));
    }
    const all = [...(commands ?? [])];
    if (caps.compact && !all.some((c) => c.name === 'compact'))
      all.push({ name: 'compact', description: t('conversation.command.compact') });
    const q = at.query.toLowerCase();
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(q));
    const within = all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    return [...starts, ...within]
      .slice(0, MAX_MENU)
      .map((c) => ({ key: c.name, label: `/${c.name}`, detail: c.description, hint: c.argumentHint, insert: `/${c.name} ` }));
  }, [at?.type, at?.query, files, commands, caps.compact]); // eslint-disable-line react-hooks/exhaustive-deps
  const menuOpen = !!at && menuKey !== dismissed && menuItems.length > 0;
  const shown = Math.min(active, Math.max(0, menuItems.length - 1));
  useEffect(() => setActive(0), [menuKey, at?.query]);

  const change = (v: string, at?: number) => {
    setText(v);
    setFailed(undefined);
    setUnsure(false);
    if (at !== undefined) setCaret(at);
    // A list closed stays closed until its word ends.
    if (!menuAt(v, at ?? v.length)) setDismissed(undefined);
    keepDraft(source, v);
  };

  const choose = (item: MenuItem) => {
    if (!at) return;
    const tail = text.slice(at.end).replace(/^ /, '');
    nextCaret.current = at.start + item.insert.length;
    if (item.mention) setMentions((m) => [...m, item.mention!]);
    change(text.slice(0, at.start) + item.insert + tail);
    inputRef.current?.focus();
  };

  // ---- attachments ----
  const addFiles = (list: File[]) => {
    if (!list.length || readOnly) return;
    if (!caps.images) return fail(t('conversation.attach.noImages', { agent }));
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) return fail(t('conversation.attach.tooMany', { n: MAX_ATTACHMENTS }));
    Promise.allSettled(list.slice(0, room).map(readImage)).then((results) => {
      if (!live.current) return;
      let error: string | undefined;
      const ok: Attachment[] = [];
      for (const r of results) {
        if (r.status === 'rejected') error ??= attachErrorText(r.reason, agent);
        else ok.push(r.value);
      }
      if (list.length > room) error ??= t('conversation.attach.tooMany', { n: MAX_ATTACHMENTS });
      setAttachments((prev) => {
        // The images that keep the message within its limit.
        const out = prev.slice();
        let bytes = prev.reduce((n, a) => n + a.data.length, 0);
        for (const a of ok) {
          if (bytes + a.data.length > MAX_PROMPT - (64 << 10)) {
            error ??= t('conversation.attach.promptTooLarge', { max: formatBytes(MAX_PROMPT) });
            continue;
          }
          bytes += a.data.length;
          out.push(a);
        }
        return out;
      });
      setFailed(error);
    });
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const list = Array.from(e.clipboardData?.files ?? []);
    if (!list.length) return;
    if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
    addFiles(list);
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (readOnly || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = caps.images ? 'copy' : 'none';
    setDragging(true);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (readOnly || !hasFiles(e)) return;
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
  };

  // ---- sending ----
  const body = text.replace(/\s+$/, '');
  const compact = caps.compact && isCompact(body) && !attachments.length;
  const starting = state === 'starting';
  const queues = working && !compact;
  const canSend =
    !readOnly && !pending && !starting && (body.trim() !== '' || attachments.length > 0) && (compact ? !working : !working || caps.queue);

  const clear = () => {
    keepDraft(source, '');
    if (!live.current) return;
    setText('');
    setCaret(0);
    setAttachments([]);
    setMentions([]);
  };
  const send = () => {
    if (!canSend) return;
    setFailed(undefined);
    if (compact) {
      setPending(true);
      Promise.resolve()
        .then(() => source.compact())
        .then(
          () => {
            clear();
            if (live.current) setPending(false);
          },
          (e: unknown) => {
            if (!live.current) return;
            setPending(false);
            fail(errorText(e, agent, 'conversation.commandFailed'));
          },
        );
      return;
    }
    const content = promptContent(body, attachments, mentions);
    if (!fits(content)) return fail(t('conversation.attach.promptTooLarge', { max: formatBytes(MAX_PROMPT) }));
    // The same message sent again (after its outcome was not known, or a
    // refusal) keeps its id: the host takes it once.
    const key = JSON.stringify(content);
    const before = outstanding.current;
    const clientId = before && before.key === key ? before.clientId : newClientId();
    outstanding.current = { clientId, key };
    setUnsure(false);
    setPending(true);
    const done = () => {
      if (outstanding.current?.clientId === clientId) outstanding.current = undefined;
      clear();
      if (live.current) setPending(false);
    };
    Promise.resolve()
      .then(() => source.send(content, clientId))
      .then(done, (e: unknown) => {
        if (deliveredRef.current?.(clientId)) return done();
        if (!live.current) return;
        setPending(false);
        // Sent, but whether the host took it is not known: the draft stays
        // until the conversation shows it, or the user sends it again.
        if (unsureOf(e) && outstanding.current?.clientId === clientId) setUnsure(true);
        else fail(errorText(e, agent, 'conversation.sendFailed'));
      });
  };

  // A message whose outcome was not known is in the conversation: it was
  // taken, and the draft that was it goes.
  useEffect(() => {
    const o = outstanding.current;
    if (!o || pending || !delivered?.(o.clientId)) return;
    outstanding.current = undefined;
    setUnsure(false);
    if (JSON.stringify(promptContent(body, attachments, mentions)) === o.key) clear();
    // body, attachments and mentions are read when the message arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delivered, pending]);
  const stop = () => run(() => source.cancel());

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = menuItems.length;
        setActive((shown + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.altKey) || e.key === 'Tab') {
        e.preventDefault();
        choose(menuItems[shown]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(menuKey);
        return;
      }
    }
    if (e.key === 'Escape' && working && !readOnly) {
      e.preventDefault();
      e.stopPropagation();
      stop();
      return;
    }
    if (e.key !== 'Enter') return;
    // Shift+Enter: the field's own new line.
    if (e.shiftKey) return;
    e.preventDefault();
    if (e.altKey) {
      const el = e.currentTarget;
      const at = el.selectionStart;
      nextCaret.current = at + 1;
      change(el.value.slice(0, at) + '\n' + el.value.slice(el.selectionEnd));
      return;
    }
    send();
  };

  const model = configOf(chat, CATEGORY_MODEL);
  const effort = configOf(chat, CATEGORY_THOUGHT_LEVEL);
  const mode = configOf(chat, CATEGORY_MODE);
  const setConfig = (id: string, value: string) => run(() => source.setConfig(id, value));
  const fullBlocked: FullBlocked = readOnly ? 'readOnly' : allowFull ? undefined : 'off';
  const canCancelQueued = caps.cancelQueued && !readOnly;
  const handedOff = !!chat?.handedOff;

  return (
    <div className="conv-composer">
      {queued.length > 0 && (
        <div className="conv-queued" role="list" aria-label={t('conversation.queued.label')}>
          {queued.map((q) => {
            const qText = blocksText(q.content).trim();
            const images = q.content.filter((b) => b.type === 'image').length;
            return (
              <div key={q.message} className="conv-queued-item" role="listitem">
                <Clock aria-hidden />
                <span className="conv-queued-text" title={qText}>
                  {qText || t('conversation.queued.images', { n: images })}
                </span>
                <span className="conv-queued-tag">{t('conversation.queued.tag')}</span>
                {canCancelQueued && (
                  <button
                    type="button"
                    className="ghost sm icon"
                    aria-label={t('conversation.queued.cancel', { text: qText.slice(0, 60) })}
                    title={t('conversation.queued.cancelHint')}
                    onClick={() => run(() => source.cancelQueued(q.message))}
                  >
                    <X aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div
        className="conv-box"
        data-drop={dragging || undefined}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {waiting && !readOnly && (
          <div className="conv-banner" role="status">
            <span>{t('conversation.waiting', { agent })}</span>
            <button type="button" className="conv-link" onClick={onShowWaiting}>
              {t('conversation.showWaiting')}
            </button>
          </div>
        )}
        {state === 'failed' && (
          <div className="conv-banner error" role="alert">
            <TriangleAlert aria-hidden />
            <span title={stateError?.stderr || stateError?.message}>
              {stateError?.code && stateError.code !== 'failed'
                ? errorText(stateError, agent, 'conversation.failed')
                : t('conversation.failed', { agent })}{' '}
              {!readOnly && t('conversation.failedResume')}
            </span>
          </div>
        )}
        {handedOff && state !== 'failed' && (
          <div className="conv-banner" role="status">
            <span>{t('conversation.handedOff', { agent })}</span>
          </div>
        )}
        {state === 'closed' && !handedOff && (
          <div className="conv-banner" role="status">
            <span>{t('conversation.closed')}</span>
          </div>
        )}
        {unsure && failed === undefined && (
          <div className="conv-banner" role="status" data-unsure="">
            <Clock aria-hidden />
            <span>{t('conversation.sendUnsure', { agent })}</span>
          </div>
        )}
        {failed !== undefined && (
          <div className="conv-banner error" role="alert">
            <TriangleAlert aria-hidden />
            <span>{failed}</span>
            <button type="button" className="ghost sm icon" aria-label={t('conversation.dismiss')} onClick={() => setFailed(undefined)}>
              <X aria-hidden />
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="conv-attachments" role="list" aria-label={t('conversation.attach.label')}>
            {attachments.map((a) => (
              <figure key={a.id} className="conv-attachment" role="listitem" title={`${a.name} · ${formatBytes(a.size)}`}>
                <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
                {!readOnly && (
                  <button
                    type="button"
                    className="conv-attachment-remove"
                    aria-label={t('conversation.attach.remove', { name: a.name })}
                    onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                  >
                    <X aria-hidden />
                  </button>
                )}
              </figure>
            ))}
          </div>
        )}
        <div className="conv-field">
          {menuOpen && (
            <div
              id={listId}
              className="conv-menu"
              role="listbox"
              aria-label={at!.type === 'slash' ? t('conversation.command.list') : t('conversation.mention.list')}
            >
              {menuItems.map((m, i) => (
                <div
                  key={m.key}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === shown}
                  className="conv-menu-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(m)}
                >
                  {at!.type === 'slash' ? <SquareSlash aria-hidden /> : <FileText aria-hidden />}
                  <span className="conv-menu-label">{m.label}</span>
                  {m.hint && <span className="conv-menu-hint">{m.hint}</span>}
                  {m.detail && <span className="conv-menu-detail">{m.detail}</span>}
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            className={pending ? 'conv-input pending' : 'conv-input'}
            rows={1}
            value={text}
            disabled={readOnly}
            readOnly={pending}
            aria-busy={pending || undefined}
            aria-label={t('conversation.composer.label', { agent })}
            aria-keyshortcuts="Enter"
            aria-autocomplete="list"
            aria-controls={menuOpen ? listId : undefined}
            aria-activedescendant={menuOpen ? `${listId}-${shown}` : undefined}
            placeholder={
              readOnly
                ? t('conversation.composer.readOnly')
                : working && caps.queue
                  ? t('conversation.composer.queuePlaceholder', { agent })
                  : t('conversation.composer.placeholder', { agent })
            }
            spellCheck
            onChange={(e) => change(e.target.value, e.target.selectionStart)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => setDismissed(menuKey)}
            onFocus={() => setDismissed(undefined)}
          />
        </div>
        <div className="conv-foot">
          {caps.images && (
            <>
              <button
                type="button"
                className="ghost sm icon conv-attach"
                aria-label={t('conversation.attach.pick')}
                title={t('conversation.attach.pickHint', { max: formatBytes(MAX_IMAGE) })}
                disabled={readOnly || pending}
                onClick={() => picker.current?.click()}
              >
                <ImagePlus aria-hidden />
              </button>
              <input
                ref={picker}
                type="file"
                accept={IMAGE_TYPES.join(',')}
                multiple
                hidden
                tabIndex={-1}
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
            </>
          )}
          {model && (
            <ConfigSelect
              option={model}
              label={t('conversation.config.model')}
              disabled={readOnly}
              fullBlocked={fullBlocked}
              onSet={setConfig}
            />
          )}
          {effort && (
            <ConfigSelect
              option={effort}
              label={t('conversation.config.effort')}
              disabled={readOnly}
              fullBlocked={fullBlocked}
              onSet={setConfig}
            />
          )}
          {mode && (
            <ConfigSelect
              option={mode}
              label={t('conversation.config.mode')}
              nameOf={modeName}
              disabled={readOnly}
              fullBlocked={fullBlocked}
              onSet={setConfig}
            />
          )}
          <span className="spacer" />
          {working && !readOnly && (
            <button
              type="button"
              className="sm conv-stop"
              title={t('conversation.stopHint', { agent })}
              aria-keyshortcuts="Escape"
              onClick={stop}
            >
              <Square aria-hidden />
              {t('conversation.stop')}
            </button>
          )}
          <button
            type="button"
            className="primary conv-send"
            aria-label={queues ? t('conversation.queue') : t('conversation.send')}
            title={queues ? t('conversation.queueHint') : t('conversation.sendHint')}
            disabled={!canSend}
            onClick={send}
          >
            {pending ? <LoaderCircle className="conv-spin" aria-hidden /> : queues ? <ListPlus aria-hidden /> : <ArrowUp aria-hidden />}
          </button>
        </div>
      </div>
      {usage && <UsageLine usage={usage} />}
    </div>
  );
}
