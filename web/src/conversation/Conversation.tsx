// A chat with a coding agent as a native view: the chat's events from a
// source (source.ts) reduced to items (model.ts) and drawn as a list that
// keeps to its end while the user is there, the cards that answer the
// agent at the places it asked, an active background tasks bar, and a
// composer (Composer.tsx) that hands the user's messages and commands to
// the source.
// The list draws the last SHOWN_ITEMS items; earlier ones, and then the
// source's earlier pages, come on request. Stored events are drawn as they
// come; live increments (text as the agent writes it) at most once a frame.

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { ArrowDown, MessagesSquare } from 'lucide-react';
import { t } from '../i18n';
import type { MarkdownBase } from '../markdown/links';
import { activeBackgroundTasks, BackgroundTasksBar } from './BackgroundTasksBar';
import { Composer } from './Composer';
import { spokenText } from './format';
import { ItemView } from './items';
import { agentKind } from './kinds';
import {
  blockingWaitingItems,
  blocksText,
  emptyConversation,
  hasClientMessage,
  itemById,
  NO_CAPABILITIES,
  take,
  waitingItems,
  type Conversation as State,
  type SourceEvent,
} from './model';
import { answeredOf, AnsweringContext, TimelineActionsContext, type Answering, type ItemContext, type TimelineActions } from './parts';
import type { BackgroundTask, ChatSource, ConversationExtras } from './source';
import './conversation.css';

/** What a parent may do with the view. */
export interface ConversationHandle {
  /** Focuses the composer, or the list when there is none. */
  focus(): void;
}

export interface ConversationProps extends ConversationExtras {
  source: ChatSource;
  /** The agent's kind (kinds.ts), whose title the view names it by. */
  kind: string;
  /** Machine and directory relative Markdown links and images resolve against. */
  base?: MarkdownBase;
  /** Read-only (also when the source says so): every control disabled. */
  readOnly?: boolean;
  /** The chat's machine allows full access (its setting
   * chat.allowFullAccess; allowed when absent, the host deciding): without
   * it the configuration values that give it are shown unavailable. */
  allowFull?: boolean;
  /** A path the agent named was activated. */
  onOpenFile?(path: string, line?: number): void;
  ref?: Ref<ConversationHandle>;
}

/** The most items the list draws at first, and how many more each "Show
 * earlier" draws. */
export const SHOWN_ITEMS = 300;

/** How close to the end (CSS pixels) the list counts as at its end. */
const END_SLACK = 24;

/** The most of the agent's last message read out. */
const SPOKEN = 2000;

/** How long live increments wait for a frame at most (a page in the
 * background draws no frames). */
const FRAME_WAIT_MS = 250;

/** Whether a list scrolled so is at its end, where it stays as items come. */
export function stickToEnd(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= END_SLACK;
}

const sourceKeys = new WeakMap<ChatSource, number>();
let nextKey = 0;
function sourceKey(s: ChatSource): number {
  let k = sourceKeys.get(s);
  if (k === undefined) sourceKeys.set(s, (k = ++nextKey));
  return k;
}

/** What a batch of events did besides adding items: put items before the
 * others (how many the list grew by), or started over. */
type Taken = { grown: number } | { reset: true };

/** The conversation before any event, shared: the reducer never writes
 * into a state it is given. */
const EMPTY: State = Object.freeze({ ...emptyConversation(), items: Object.freeze([]) as never, byId: Object.freeze({}) });

const isLive = (ev: SourceEvent) => typeof ev === 'object' && ev !== null && (ev as { live?: unknown }).live === true;

/** The conversation of a source, taken a batch of events at a time: stored
 * events at once (a microtask), live increments at the next frame; onTaken
 * hears of a batch that put items before the others or started over,
 * before it is drawn. */
function useConversation(source: ChatSource, onTaken: (what: Taken) => void) {
  const state = useRef<State>(EMPTY);
  const [shown, setShown] = useState({ source, conv: EMPTY });
  const taken = useRef(onTaken);
  useLayoutEffect(() => {
    taken.current = onTaken;
  });
  useEffect(() => {
    let queue: SourceEvent[] = [];
    let live = true;
    let micro = false;
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    state.current = EMPTY;
    setShown({ source, conv: EMPTY });
    // The events a source gives at once (a page, a frame's increments) are
    // reduced together: the list is copied once for them and drawn once.
    const flush = () => {
      micro = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = timer = undefined;
      if (!live || !queue.length) return;
      const batch = queue;
      queue = [];
      const cur = state.current;
      const next = take(cur, batch);
      if (next === cur) return;
      const first = cur.first;
      if (batch.some((ev) => ev.t === 'reset')) taken.current({ reset: true });
      else if (
        first !== undefined &&
        batch.some((ev) => ev.t !== 'reset' && ev.t !== 'reattach' && !isLive(ev) && typeof ev.seq === 'number' && ev.seq < first)
      )
        taken.current({ grown: next.items.length - cur.items.length });
      state.current = next;
      setShown({ source, conv: next });
    };
    const off = source.subscribe((ev) => {
      // An event is an object: what else a machine sent is passed over.
      if (typeof ev !== 'object' || ev === null) return;
      queue.push(ev);
      if (!isLive(ev)) {
        if (!micro) {
          micro = true;
          queueMicrotask(flush);
        }
        return;
      }
      if (frame === undefined && timer === undefined) {
        if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(flush);
        timer = setTimeout(flush, FRAME_WAIT_MS);
      }
    });
    return () => {
      live = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timer);
      off();
    };
  }, [source]);
  // Until the effect has run for a new source, the old one's items are not
  // its.
  return shown.source === source ? shown.conv : EMPTY;
}

export function Conversation({
  source,
  kind,
  base,
  readOnly: readOnlyProp,
  allowFull = true,
  onOpenFile,
  agentIcon,
  modelPicker,
  onFork,
  ref,
}: ConversationProps) {
  const agent = agentKind(kind)?.title ?? t('conversation.agent');
  const readOnly = !!readOnlyProp || !!source.readOnly;
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atEnd = useRef(true);
  /** The list's distance from its end to keep when items come before those
   * shown. */
  const anchor = useRef<number | undefined>(undefined);
  /** An item to show and focus once it is drawn. */
  const reveal = useRef<string | undefined>(undefined);
  const [away, setAway] = useState(false);
  const [limit, setLimit] = useState(SHOWN_ITEMS);
  const [earlier, setEarlier] = useState<'idle' | 'loading' | 'none'>('idle');

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
      atEnd.current = true;
      setAway(false);
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
  const latest = useRef({ onOpenFile, onFork, source });
  useLayoutEffect(() => {
    latest.current = { onOpenFile, onFork, source };
  });
  const canOpen = !!onOpenFile;
  const canTrust = !readOnly && !!source.trust;
  const canUntrust = !readOnly && !!source.untrust;
  const baseM = base?.m;
  const baseDir = base?.dir;
  const stableBase = useMemo<MarkdownBase | undefined>(() => (baseM && baseDir ? { m: baseM, dir: baseDir } : undefined), [baseM, baseDir]);
  const ctx = useMemo<ItemContext>(
    () => ({
      agent,
      base: stableBase,
      openFile: canOpen ? (path, line) => latest.current.onOpenFile?.(path, line) : undefined,
      trust: canTrust ? () => latest.current.source.trust?.() ?? Promise.resolve() : undefined,
      untrust: canUntrust ? () => latest.current.source.untrust?.() ?? Promise.resolve() : undefined,
    }),
    [agent, stableBase, canOpen, canTrust, canUntrust],
  );

  const state = conv.state;
  const caps = conv.chat?.capabilities ?? NO_CAPABILITIES;
  const working = state === 'working' || state === 'waiting' || (state === undefined && conv.turn === 'working');
  /** A blocking card that waits may be answered while the chat's turn runs. */
  const open = !readOnly && (state === undefined || state === 'working' || state === 'waiting');
  /** An async question stays answerable across turn end unless closed/failed. */
  const openAsync = !readOnly && state !== 'closed' && state !== 'failed';
  // The cards that wait: the same set while they are the same.
  const waitingKey = useMemo(() => waitingItems(conv).join('\n'), [conv]);
  const waitingSet = useMemo(() => new Set(waitingKey ? waitingKey.split('\n') : []), [waitingKey]);
  const blockingKey = useMemo(() => blockingWaitingItems(conv).join('\n'), [conv]);
  const blockingSet = useMemo(() => new Set(blockingKey ? blockingKey.split('\n') : []), [blockingKey]);
  const answering = useMemo<Answering>(
    () => ({
      open,
      openAsync,
      waiting: waitingSet,
      readOnly,
      answered: answeredOf(source),
      respond: (permission, reply) => latest.current.source.respond(permission, reply),
      answer: (question, reply) => latest.current.source.answer(question, reply),
    }),
    [open, openAsync, waitingSet, readOnly, source],
  );
  // Only blocking permissions/questions trigger the composer waiting banner.
  const waiting = open && blockingSet.size > 0;

  const canRewind = !readOnly && !working && !!caps.rewind && !!source.rewind;
  const rewindFiles = !!caps.rewindFiles;
  const canFork = !readOnly && !working && !!onFork;
  const canStopTask = !readOnly && !!caps.stopTask && !!source.stopTask;

  const tasksByToolCall = useMemo<ReadonlyMap<string, BackgroundTask>>(() => {
    const map = new Map<string, BackgroundTask>();
    for (const task of conv.chat?.tasks ?? []) {
      if (task.toolCallId) map.set(task.toolCallId, task);
    }
    return map;
  }, [conv.chat?.tasks]);

  const questionSourceKey = useMemo(() => {
    const ids: string[] = [];
    for (const it of conv.items) {
      if (it.kind === 'question' && it.sourceItem) ids.push(`message:agent:item:${it.sourceItem}`);
    }
    return ids.join('\n');
  }, [conv.items]);
  const questionSourceItems = useMemo<ReadonlySet<string>>(
    () => new Set(questionSourceKey ? questionSourceKey.split('\n') : []),
    [questionSourceKey],
  );

  const timelineActions = useMemo<TimelineActions>(
    () => ({
      rewind: canRewind ? (seq, opts) => latest.current.source.rewind!(seq, opts) : undefined,
      rewindFiles,
      fork: canFork ? (upToSeq) => latest.current.onFork?.(upToSeq) : undefined,
      stopTask: canStopTask ? (taskId) => latest.current.source.stopTask!(taskId) : undefined,
      tasksByToolCall,
      questionSourceItems,
    }),
    [canRewind, rewindFiles, canFork, canStopTask, tasksByToolCall, questionSourceItems],
  );

  const activeTasks = useMemo(() => activeBackgroundTasks(conv), [conv]);
  const delivered = useCallback((clientId: string) => hasClientMessage(conv, clientId), [conv]);

  useImperativeHandle(
    ref,
    () => ({ focus: () => (inputRef.current && !inputRef.current.disabled ? inputRef.current : scrollRef.current)?.focus() }),
    [],
  );

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

  const hidden = Math.max(0, conv.items.length - limit);
  const shown = hidden ? conv.items.slice(hidden) : conv.items;

  const focusReveal = () => {
    const id = reveal.current;
    const list = listRef.current;
    if (!id || !list) return;
    const targetItem = Array.from(list.querySelectorAll<HTMLElement>('[data-item]')).find((el) => el.getAttribute('data-item') === id);
    if (!targetItem) return;
    reveal.current = undefined;
    targetItem.scrollIntoView?.({ block: 'center' });
    const target = targetItem.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? targetItem;
    target.focus();
  };

  /** Shows and focuses an item in the timeline, expanding hidden items if needed. */
  const jumpToItem = (id: string) => {
    const at = conv.items.findIndex((it) => it.id === id);
    if (at >= 0 && at < hidden) setLimit(conv.items.length - at);
    reveal.current = id;
    focusReveal();
  };

  /** Shows the card that waits for the user, and gives it the keyboard. */
  const showWaiting = () => {
    const id = Array.from(blockingSet).at(-1) ?? Array.from(waitingSet).at(-1);
    if (id === undefined) return;
    jumpToItem(id);
  };

  // After each change: back to where the user was when items came before
  // those shown (the distance from the end kept), else to the end while the
  // user is there; then a card asked for is shown.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchor.current !== undefined) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = undefined;
    } else if (atEnd.current) el.scrollTop = el.scrollHeight;
    focusReveal();
    // focusReveal reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv, limit]);

  // What grows after it is drawn (Markdown, formulas and code as their
  // renderers load, a tool call opened, the pane resized) keeps the list at
  // its end while the user is there.
  useEffect(() => {
    const el = scrollRef.current;
    const list = listRef.current;
    if (!el || !list || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atEnd.current) el.scrollTop = el.scrollHeight;
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

  // What is read out: that the agent waits for an answer, else its last
  // message once it is whole.
  let spoken = '';
  if (waiting) spoken = t('conversation.waiting', { agent });
  else
    for (let i = conv.items.length - 1; i >= 0; i--) {
      const it = conv.items[i];
      if (it.kind !== 'message') continue;
      if (it.role === 'agent' && !it.live) spoken = spokenText(blocksText(it.content)).slice(0, SPOKEN);
      break;
    }

  const activity =
    conv.activity === 'compacting'
      ? t('conversation.compacting')
      : state === 'starting'
        ? t('conversation.starting', { agent })
        : t('conversation.working');

  return (
    <div className="conv">
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
              <div className="conv-unknown">{t('conversation.unknown', { n: conv.unknown })}</div>
            )}
            <AnsweringContext.Provider value={answering}>
              <TimelineActionsContext.Provider value={timelineActions}>
                {shown.map((it) => (
                  <ItemView key={it.id} item={it} ctx={ctx} />
                ))}
              </TimelineActionsContext.Provider>
            </AnsweringContext.Provider>
            {(working || state === 'starting') && (
              <div className="conv-working" role="status">
                <span className="dot dot-working" aria-hidden />
                {activity}
              </div>
            )}
            {conv.items.length === 0 && !working && state !== 'starting' && (
              <div className="empty-note conv-empty">
                <MessagesSquare aria-hidden />
                <div className="conv-empty-title">{agent}</div>
                <div>{t('conversation.empty', { agent })}</div>
                {conv.unknown > 0 && <div className="conv-unknown">{t('conversation.unknown', { n: conv.unknown })}</div>}
              </div>
            )}
          </div>
        </div>
        {away && (
          <button type="button" className="conv-jump" onClick={toEnd}>
            <ArrowDown aria-hidden />
            {t('conversation.jumpToLatest')}
          </button>
        )}
      </div>
      <div className="conv-sr" aria-live="polite">
        {spoken}
      </div>
      <BackgroundTasksBar
        tasks={activeTasks}
        agent={agent}
        readOnly={readOnly}
        canStop={canStopTask}
        onStopTask={canStopTask ? (taskId) => latest.current.source.stopTask!(taskId) : undefined}
        onJumpToItem={jumpToItem}
        hasItem={(id) => itemById(conv, id) !== undefined}
      />
      <Composer
        key={sourceKey(source)}
        source={source}
        kind={kind}
        agent={agent}
        agentIcon={agentIcon}
        base={stableBase}
        activity={conv.activity}
        modelPicker={modelPicker}
        chat={conv.chat}
        usage={conv.usage}
        queued={conv.queued ?? []}
        working={working}
        waiting={waiting}
        state={state}
        stateError={conv.stateError}
        readOnly={readOnly}
        allowFull={allowFull}
        onShowWaiting={showWaiting}
        delivered={delivered}
        inputRef={inputRef}
      />
    </div>
  );
}
