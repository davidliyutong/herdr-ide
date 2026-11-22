// A coding agent's conversation as a native view: the session's events
// from a source (source.ts) reduced to items (model.ts) and drawn as a list
// that keeps to its end while the user is there, and a composer that hands
// the user's message to the source.
// The list draws the last SHOWN_ITEMS items; earlier ones, and then the
// source's earlier pages, come on request. A short view (peek: the agent
// waits for an answer in its terminal, shown below) has no composer, unless
// the user was writing a message as it became short: then the composer
// stays, the keyboard with it, and the message waits there.

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from 'react';
import { ArrowDown, ArrowUp, LoaderCircle, MessagesSquare, Square, TriangleAlert } from 'lucide-react';
import type { AgentStatus } from '../lib/machine';
import { hasMessage, t } from '../i18n';
import { formatTokens, spokenText } from './format';
import { ItemView } from './items';
import { agentKind } from './kinds';
import { blocksText, emptyConversation, take, type Conversation as State, type SourceEvent, type Usage } from './model';
import type { ItemContext } from './parts';
import type { AgentSource } from './source';
import './conversation.css';

export type { AgentStatus };

/** What a parent may do with the view. */
export interface ConversationHandle {
  /** Focuses the composer, or the list when there is none. */
  focus(): void;
  /** The view is short (peek) and keeps its composer, because the user was
   * writing a message as it became so: the keyboard stays where it is. */
  writing(): boolean;
}

export interface ConversationProps {
  source: AgentSource;
  /** The agent's kind (kinds.ts), whose title the view names it by. */
  kind: string;
  /** The agent's state as its terminal reports it. */
  status: AgentStatus;
  /** What the agent waits for while blocked. */
  blockedText?: string;
  readOnly?: boolean;
  /** The view is short, its terminal shown below it: the list kept at its
   * end, and no composer unless the user was writing a message as the view
   * became short (writing); what the agent waits for is the parent's to
   * say. */
  peek?: boolean;
  /** The user asks for the agent's own interface. */
  onShowTerminal(): void;
  /** A path the agent named was activated. */
  onOpenFile?(path: string, line?: number): void;
  ref?: Ref<ConversationHandle>;
}

/** The most items the list draws at first, and how many more each "Show
 * earlier" draws. */
export const SHOWN_ITEMS = 300;

/** How close to the end (CSS pixels) the list counts as at its end. */
const END_SLACK = 24;

/** How long after a keystroke in the composer the user counts as writing a
 * message, also with nothing in it. */
export const WRITING_MS = 1500;

/** The most of the agent's last message read out. */
const SPOKEN = 2000;

/** Whether a list scrolled so is at its end, where it stays as items come. */
export function stickToEnd(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= END_SLACK;
}

/** The user's text not sent yet, by source: it outlives the view (another
 * tab shown, the terminal shown instead) until it is sent. */
const drafts = new WeakMap<AgentSource, string>();

const sourceKeys = new WeakMap<AgentSource, number>();
let nextKey = 0;
function sourceKey(s: AgentSource): number {
  let k = sourceKeys.get(s);
  if (k === undefined) sourceKeys.set(s, (k = ++nextKey));
  return k;
}

/** A field's height to fit its text (up to its CSS max-height). */
function grow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

function Meter({ usage }: { usage: Usage }) {
  const pct = Math.min(100, Math.max(0, Math.round((usage.used / usage.size) * 100)));
  return (
    <span
      className="conv-meter"
      role="meter"
      aria-label={t('conversation.contextUsed')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      title={t('conversation.context', { used: formatTokens(usage.used), size: formatTokens(usage.size) })}
      data-level={pct >= 90 ? 'high' : pct >= 75 ? 'mid' : undefined}
    >
      <span className="conv-meter-bar">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="conv-meter-pct">{pct}%</span>
    </span>
  );
}

/** Why a message was not sent, in words: by the code of the source's
 * error (SendError's of the agents plugin), else in general. */
function sendError(e: unknown, agent: string): string {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  const key = `conversation.sendError.${typeof code === 'string' ? code : ''}`;
  return hasMessage(key) ? t(key, { agent }) : t('conversation.sendFailed');
}

interface ComposerProps {
  source: AgentSource;
  agent: string;
  status: AgentStatus;
  blockedText?: string;
  usage?: Usage;
  /** The view is short: the parent says what the agent waits for. */
  peek: boolean;
  onShowTerminal(): void;
  /** Hears whether the user is writing a message: text not sent is in the
   * field, or it was typed in within WRITING_MS. */
  onWriting(writing: boolean): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

function Composer({ source, agent, status, blockedText, usage, peek, onShowTerminal, onWriting, inputRef }: ComposerProps) {
  const [text, setText] = useState(() => drafts.get(source) ?? '');
  const [pending, setPending] = useState(false);
  /** Why the last message was not sent. */
  const [failed, setFailed] = useState<string | undefined>(undefined);
  /** A key was pressed in the field within WRITING_MS. */
  const [typed, setTyped] = useState(false);
  const typedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const live = useRef(true);
  const caret = useRef<number | undefined>(undefined);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(typedTimer.current);
    };
  }, []);
  const writing = typed || (!pending && text.trim() !== '');
  const tell = useRef(onWriting);
  useLayoutEffect(() => {
    tell.current = onWriting;
  });
  useEffect(() => tell.current(writing), [writing]);
  useEffect(() => () => tell.current(false), []);
  useLayoutEffect(() => {
    const el = inputRef.current;
    grow(el);
    if (el && caret.current !== undefined) {
      el.setSelectionRange(caret.current, caret.current);
      caret.current = undefined;
    }
  }, [text, inputRef]);

  const blocked = status === 'blocked';
  const body = text.replace(/\s+$/, '');
  const canSend = body.trim() !== '' && !pending && !blocked;

  const change = (v: string) => {
    setText(v);
    setFailed(undefined);
    if (v) drafts.set(source, v);
    else drafts.delete(source);
  };

  const send = () => {
    if (!canSend || !source.send) return;
    const send = source.send.bind(source);
    setPending(true);
    setFailed(undefined);
    Promise.resolve()
      .then(() => send([{ type: 'text', text: body }]))
      .then(
        () => {
          if (drafts.get(source) === text) drafts.delete(source);
          if (!live.current) return;
          setText('');
          setPending(false);
        },
        (e: unknown) => {
          if (!live.current) return;
          setPending(false);
          setFailed(sendError(e, agent));
        },
      );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    setTyped(true);
    clearTimeout(typedTimer.current);
    typedTimer.current = setTimeout(() => setTyped(false), WRITING_MS);
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Shift+Enter: the field's own new line.
    if (e.shiftKey) return;
    e.preventDefault();
    if (e.altKey) {
      const el = e.currentTarget;
      const at = el.selectionStart;
      caret.current = at + 1;
      change(el.value.slice(0, at) + '\n' + el.value.slice(el.selectionEnd));
      return;
    }
    send();
  };

  return (
    <div className="conv-composer">
      <div className="conv-box" data-blocked={blocked || undefined}>
        {blocked && !peek && (
          <div className="conv-banner" role="status">
            <span>
              {t('conversation.blocked', { agent })}
              {blockedText && <span className="conv-banner-what"> {blockedText}</span>}
            </span>
            <button type="button" className="conv-link" onClick={onShowTerminal}>
              {t('conversation.showTerminal')}
            </button>
          </div>
        )}
        {failed !== undefined && (
          <div className="conv-banner error" role="alert">
            <TriangleAlert aria-hidden />
            <span>{failed}</span>
            <button type="button" className="conv-link" onClick={onShowTerminal}>
              {t('conversation.showTerminal')}
            </button>
          </div>
        )}
        {/* Not disabled while the agent waits: a field that is gives up
            the keyboard, which then goes to the terminal and its question
            (send() and the send button wait instead). */}
        <textarea
          ref={inputRef}
          className={pending ? 'conv-input pending' : 'conv-input'}
          rows={1}
          value={text}
          readOnly={pending}
          aria-busy={pending || undefined}
          aria-label={t('conversation.composer.label', { agent })}
          aria-keyshortcuts="Enter"
          placeholder={t('conversation.composer.placeholder', { agent })}
          spellCheck
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="conv-foot">
          {usage && usage.size > 0 && <Meter usage={usage} />}
          <span className="spacer" />
          {status === 'working' && source.cancel && (
            <button type="button" className="sm conv-stop" title={t('conversation.stopHint', { agent })} onClick={() => source.cancel?.()}>
              <Square aria-hidden />
              {t('conversation.stop')}
            </button>
          )}
          <button
            type="button"
            className="primary conv-send"
            aria-label={t('conversation.send')}
            title={t('conversation.sendHint')}
            disabled={!canSend}
            onClick={send}
          >
            {pending ? <LoaderCircle className="conv-spin" aria-hidden /> : <ArrowUp aria-hidden />}
          </button>
        </div>
      </div>
    </div>
  );
}

/** What a batch of events did besides adding items: put items before the
 * others (how many the list grew by), or started over. */
type Taken = { grown: number } | { reset: true };

/** The conversation before any event, shared: the reducer never writes
 * into a state it is given. */
const EMPTY: State = Object.freeze({ ...emptyConversation(), items: Object.freeze([]) as never, byId: Object.freeze({}) });

/** The conversation of a source, taken a batch of events at a time; onTaken
 * hears of a batch that put items before the others or started over,
 * before it is drawn. */
function useConversation(source: AgentSource, onTaken: (what: Taken) => void) {
  const state = useRef<State>(EMPTY);
  const [shown, setShown] = useState({ source, conv: EMPTY });
  const taken = useRef(onTaken);
  useLayoutEffect(() => {
    taken.current = onTaken;
  });
  useEffect(() => {
    let queue: SourceEvent[] = [];
    let live = true;
    state.current = EMPTY;
    setShown({ source, conv: EMPTY });
    // The events a source gives at once (a page) are reduced together: the
    // list is copied once for them and drawn once.
    const flush = () => {
      if (!live || !queue.length) return;
      const batch = queue;
      queue = [];
      const cur = state.current;
      const next = take(cur, batch);
      if (next === cur) return;
      const first = cur.first;
      if (batch.some((ev) => ev.t === 'reset')) taken.current({ reset: true });
      else if (first !== undefined && batch.some((ev) => ev.t !== 'reset' && typeof ev.seq === 'number' && ev.seq < first))
        taken.current({ grown: next.items.length - cur.items.length });
      state.current = next;
      setShown({ source, conv: next });
    };
    const off = source.subscribe((ev) => {
      // An event is an object: what else a machine sent is passed over.
      if (typeof ev !== 'object' || ev === null) return;
      if (!queue.length) queueMicrotask(flush);
      queue.push(ev);
    });
    return () => {
      live = false;
      off();
    };
  }, [source]);
  // Until the effect has run for a new source, the old one's items are not
  // its.
  return shown.source === source ? shown.conv : EMPTY;
}

export function Conversation({ source, kind, status, blockedText, readOnly, peek, onShowTerminal, onOpenFile, ref }: ConversationProps) {
  const agent = agentKind(kind)?.title ?? t('conversation.agent');
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atEnd = useRef(true);
  /** The list's distance from its end to keep when items come before those
   * shown. */
  const anchor = useRef<number | undefined>(undefined);
  const [away, setAway] = useState(false);
  const [limit, setLimit] = useState(SHOWN_ITEMS);
  const [earlier, setEarlier] = useState<'idle' | 'loading' | 'none'>('idle');
  /** The user is writing a message (the composer's onWriting). */
  const [writing, setWriting] = useState(false);
  /** The view became short while the user was writing: it keeps its
   * composer until it is not short any more. */
  const [kept, setKept] = useState(false);
  const [wasPeek, setWasPeek] = useState(!!peek);
  if (wasPeek !== !!peek) {
    setWasPeek(!!peek);
    setKept(!!peek && writing);
  }
  const keeps = !!peek && kept;
  const keepsRef = useRef(keeps);
  useLayoutEffect(() => {
    keepsRef.current = keeps;
  });

  /** Keeps the user's place while items come before those shown. */
  const keep = () => {
    const el = scrollRef.current;
    if (el) anchor.current = el.scrollHeight - el.scrollTop;
  };
  // An earlier page is drawn whole: the user asked for it.
  const conv = useConversation(source, (what) => {
    if ('reset' in what) {
      setLimit(SHOWN_ITEMS);
      setEarlier('idle');
      return;
    }
    keep();
    if (what.grown > 0) setLimit((l) => l + what.grown);
  });

  // The view starts over with another source.
  const [shownSource, setShownSource] = useState(source);
  if (shownSource !== source) {
    setShownSource(source);
    setLimit(SHOWN_ITEMS);
    setEarlier('idle');
    setAway(false);
  }
  const latestSource = useRef(source);
  useLayoutEffect(() => {
    if (latestSource.current !== source) atEnd.current = true;
    latestSource.current = source;
  }, [source]);

  // What the items call: the same functions for the view's life, calling
  // the parent's latest ones.
  const latest = useRef({ onOpenFile, onShowTerminal, peek });
  useLayoutEffect(() => {
    latest.current = { onOpenFile, onShowTerminal, peek };
  });
  const canOpen = !!onOpenFile;
  const ctx = useMemo<ItemContext>(
    () => ({
      agent,
      openFile: canOpen ? (path, line) => latest.current.onOpenFile?.(path, line) : undefined,
      showTerminal: () => latest.current.onShowTerminal(),
    }),
    [agent, canOpen],
  );

  useImperativeHandle(ref, () => ({ focus: () => (inputRef.current ?? scrollRef.current)?.focus(), writing: () => keepsRef.current }), []);

  const toEnd = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const end = stickToEnd(el.scrollTop, el.scrollHeight, el.clientHeight);
    atEnd.current = end;
    setAway(!end);
  };

  // After each change: back to where the user was when items came before
  // those shown (the distance from the end kept), else to the end while the
  // user is there.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchor.current !== undefined) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = undefined;
      return;
    }
    if (peek || atEnd.current) el.scrollTop = el.scrollHeight;
  }, [conv, limit, peek, status]);

  // What grows after it is drawn (Markdown, formulas and code as their
  // renderers load, a tool call opened, the pane resized) keeps the list at
  // its end while the user is there.
  useEffect(() => {
    const el = scrollRef.current;
    const list = listRef.current;
    if (!el || !list || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (latest.current.peek || atEnd.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(list);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const loadEarlier = () => {
    if (!source.loadEarlier || earlier === 'loading') return;
    const from = source;
    setEarlier('loading');
    source.loadEarlier().then(
      (more) => from === latestSource.current && setEarlier(more ? 'idle' : 'none'),
      () => from === latestSource.current && setEarlier('idle'),
    );
  };

  const hidden = Math.max(0, conv.items.length - limit);
  const shown = hidden ? conv.items.slice(hidden) : conv.items;
  const working = status === 'working' || (status === 'unknown' && conv.turn === 'working');
  const composer = !readOnly && (!peek || keeps) && source.capabilities.input !== 'none' && !!source.send;

  // The last message, read out when it is the agent's and changes.
  let spoken = '';
  for (let i = conv.items.length - 1; i >= 0; i--) {
    const it = conv.items[i];
    if (it.kind !== 'message') continue;
    if (it.role === 'agent') spoken = spokenText(blocksText(it.content)).slice(0, SPOKEN);
    break;
  }

  return (
    <div className="conv" data-peek={peek || undefined}>
      <div className="conv-main">
        <div
          ref={scrollRef}
          className="conv-scroll"
          role="log"
          aria-live="off"
          aria-label={t('conversation.list', { agent })}
          tabIndex={0}
          onScroll={onScroll}
        >
          <div ref={listRef} className="conv-list">
            {conv.items.length > 0 && (hidden > 0 || (source.loadEarlier && earlier !== 'none')) && (
              <div className="conv-earlier">
                {hidden > 0 ? (
                  <button
                    type="button"
                    className="ghost sm"
                    onClick={() => {
                      keep();
                      setLimit((l) => l + SHOWN_ITEMS);
                    }}
                  >
                    {t('conversation.loadEarlier')}
                  </button>
                ) : (
                  <button type="button" className="ghost sm" disabled={earlier === 'loading'} onClick={loadEarlier}>
                    {earlier === 'loading' ? t('conversation.loadingEarlier') : t('conversation.loadEarlier')}
                  </button>
                )}
              </div>
            )}
            {conv.items.length > 0 && conv.unknown > 0 && hidden === 0 && (
              <div className="conv-unknown">
                {t('conversation.unknown', { n: conv.unknown })}{' '}
                <button type="button" className="conv-link" onClick={onShowTerminal}>
                  {t('conversation.showTerminal')}
                </button>
              </div>
            )}
            {shown.map((it) => (
              <ItemView key={it.id} item={it} ctx={ctx} />
            ))}
            {working && conv.items.length > 0 && (
              <div className="conv-working">
                <span className="dot dot-working" aria-hidden />
                {t('conversation.working')}
              </div>
            )}
            {conv.items.length === 0 && (
              <div className="empty-note conv-empty">
                <MessagesSquare aria-hidden />
                <div className="conv-empty-title">{agent}</div>
                <div>{t('conversation.empty', { agent })}</div>
                {conv.unknown > 0 && (
                  <div className="conv-unknown">
                    {t('conversation.unknown', { n: conv.unknown })}{' '}
                    <button type="button" className="conv-link" onClick={onShowTerminal}>
                      {t('conversation.showTerminal')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {away && !peek && (
          <button type="button" className="conv-jump" onClick={toEnd}>
            <ArrowDown aria-hidden />
            {t('conversation.jumpToLatest')}
          </button>
        )}
      </div>
      <div className="conv-sr" aria-live="polite">
        {spoken}
      </div>
      {composer && (
        <Composer
          key={sourceKey(source)}
          source={source}
          agent={agent}
          status={status}
          blockedText={blockedText}
          usage={conv.usage}
          peek={!!peek}
          onShowTerminal={onShowTerminal}
          onWriting={setWriting}
          inputRef={inputRef}
        />
      )}
    </div>
  );
}
