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
import { Composer, type ComposerHandle } from './Composer';
import { spokenText } from './format';
import { ItemView } from './items';
import { agentKind, chatAdapter } from './kinds';
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
  /** Whether the pane is currently visible (false while kept mounted offscreen). */
  shown?: boolean;
  /** External request to jump to and open inline rewind on a specific user turn. */
  rewindRequest?: { seq: number; nonce: number };
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

/** Saved reading state of a chat across pane hiding or unmount/remount. */
export interface SavedScrollState {
  atEnd: boolean;
  scrollTop: number;
  /** First visible `[data-item]` id near the viewport top (resilient to layout shifts). */
  anchorItemId?: string;
  /** Offset of that item's top relative to the scroll container's top. */
  anchorOffset?: number;
  /** Expanded visible item limit (if user clicked "Show Earlier Messages"). */
  limit: number;
}

/** The most chats whose scroll/browsing state is kept by id. */
const MAX_SAVED_SCROLLS = 200;
const savedScrolls = new Map<string, SavedScrollState>();

function getSavedScroll(id: string | undefined): SavedScrollState | undefined {
  if (!id) return undefined;
  const s = savedScrolls.get(id);
  if (!s) return undefined;
  savedScrolls.delete(id);
  savedScrolls.set(id, s);
  return s;
}

function setSavedScroll(id: string | undefined, state: SavedScrollState) {
  if (!id) return;
  savedScrolls.delete(id);
  savedScrolls.set(id, state);
  if (savedScrolls.size > MAX_SAVED_SCROLLS) savedScrolls.delete(savedScrolls.keys().next().value!);
}

function deleteSavedScroll(id: string | undefined) {
  if (id) savedScrolls.delete(id);
}

/** Clears all saved browsing states (tests). */
export function clearSavedScrolls() {
  savedScrolls.clear();
}

/** How long a restored scroll position stays anchored against async lazy-render
 * height shifts (Markdown, KaTeX, Shiki) after the last resize. */
const RESTORE_SETTLE_MS = 600;

function findItemEl(list: HTMLElement, id: string): HTMLElement | undefined {
  const nodes = list.querySelectorAll<HTMLElement>('[data-item]');
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].getAttribute('data-item') === id) return nodes[i];
  }
  return undefined;
}

/** Finds the first visible `[data-item]` element in the scroll container via
 * binary search on `list.children` (O(log N) layout queries). Returns empty
 * object when layout geometry is unavailable (e.g. jsdom). */
function findAnchorItem(el: HTMLElement, list: HTMLElement | null): { anchorItemId?: string; anchorOffset?: number } {
  if (!list || !list.children.length) return {};
  const viewRect = el.getBoundingClientRect();
  const kids = list.children;
  let lo = 0;
  let hi = kids.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rect = (kids[mid] as HTMLElement).getBoundingClientRect();
    if (rect.height === 0 && rect.bottom === 0 && viewRect.top === 0) return {};
    if (rect.bottom > viewRect.top + 1) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (found < 0) return {};
  for (let i = found; i < Math.min(kids.length, found + 4); i++) {
    const node = kids[i] as HTMLElement;
    const id = node.getAttribute('data-item');
    if (!id) continue;
    const rect = node.getBoundingClientRect();
    if (rect.height > 0) return { anchorItemId: id, anchorOffset: rect.top - viewRect.top };
  }
  return {};
}

/** Applies a saved non-atEnd scroll position to `el`, preferring the anchored
 * item when rendered with non-zero layout geometry and falling back to
 * `saved.scrollTop`. Returns the resulting scrollTop applied. */
function applySavedScroll(el: HTMLElement, list: HTMLElement | null, saved: SavedScrollState): number {
  if (saved.anchorItemId && list) {
    const target = findItemEl(list, saved.anchorItemId);
    if (target) {
      const itemRect = target.getBoundingClientRect();
      if (itemRect.height > 0) {
        const viewTop = el.getBoundingClientRect().top;
        const delta = itemRect.top - viewTop - (saved.anchorOffset ?? 0);
        if (Math.abs(delta) > 0.5) el.scrollTop += delta;
        return el.scrollTop;
      }
    }
  }
  el.scrollTop = saved.scrollTop;
  return el.scrollTop;
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
    let initializing = true;
    let micro = false;
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    state.current = EMPTY;
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
      if (initializing) return;
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
    initializing = false;
    // Synchronously flush initial replay so the list renders populated on its
    // first paint instead of flashing EMPTY and chasing the bottom across frames.
    if (queue.length) flush();
    else setShown({ source, conv: EMPTY });
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
  shown: isShown = true,
  rewindRequest,
  base,
  branch,
  readOnly: readOnlyProp,
  allowFull = true,
  onOpenFile,
  onOpenChat,
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
  const composerRef = useRef<ComposerHandle>(null);

  const initialSaved = getSavedScroll(source.id);
  const atEnd = useRef(initialSaved ? initialSaved.atEnd : true);
  /** Saved scroll position being actively re-applied during mount / unhide layout shifts. */
  const restoreRef = useRef<SavedScrollState | undefined>(initialSaved && !initialSaved.atEnd ? initialSaved : undefined);
  /** Last scrollTop written programmatically by restore, so its async scroll event does not cancel anchoring. */
  const lastRestoredTop = useRef<number | undefined>(undefined);
  /** Most recently captured browsing state (survives hiding via `display: none`). */
  const lastKnownScroll = useRef<SavedScrollState | undefined>(initialSaved);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The list's distance from its end to keep when items come before those
   * shown. */
  const anchor = useRef<number | undefined>(undefined);
  /** An item to show and focus once it is drawn. */
  const reveal = useRef<string | undefined>(undefined);
  const [away, setAway] = useState(() => (initialSaved ? !initialSaved.atEnd : false));
  const [limit, setLimit] = useState(() => Math.max(SHOWN_ITEMS, initialSaved?.limit ?? SHOWN_ITEMS));
  const [earlier, setEarlier] = useState<'idle' | 'loading' | 'none'>('idle');
  const [rewindTarget, setRewindTarget] = useState<{ seq: number; nonce: number } | undefined>(undefined);
  const handledRewindNonce = useRef(0);

  const shownRef = useRef(isShown);
  shownRef.current = isShown;
  const prevShown = useRef(isShown);
  const limitRef = useRef(limit);
  limitRef.current = limit;
  const sourceIdRef = useRef(source.id);
  sourceIdRef.current = source.id;

  const clearRestore = useCallback(() => {
    restoreRef.current = undefined;
    lastRestoredTop.current = undefined;
    if (settleTimer.current !== undefined) {
      clearTimeout(settleTimer.current);
      settleTimer.current = undefined;
    }
  }, []);

  const armSettle = useCallback(() => {
    if (!restoreRef.current) return;
    if (settleTimer.current !== undefined) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      restoreRef.current = undefined;
      lastRestoredTop.current = undefined;
      settleTimer.current = undefined;
    }, RESTORE_SETTLE_MS);
  }, []);

  const applyRestore = useCallback(() => {
    const el = scrollRef.current;
    const saved = restoreRef.current;
    if (!el || !saved) return;
    lastRestoredTop.current = applySavedScroll(el, listRef.current, saved);
  }, []);

  const recordScroll = useCallback((el: HTMLElement, endOverride?: boolean) => {
    if (el.clientHeight === 0 || el.scrollHeight === 0) return;
    const end = endOverride ?? stickToEnd(el.scrollTop, el.scrollHeight, el.clientHeight);
    const anchorInfo = end ? undefined : findAnchorItem(el, listRef.current);
    const next: SavedScrollState = {
      atEnd: end,
      scrollTop: el.scrollTop,
      limit: limitRef.current,
      ...anchorInfo,
    };
    lastKnownScroll.current = next;
    setSavedScroll(sourceIdRef.current, next);
  }, []);

  /** Keeps the user's place while items come before those shown. */
  const keep = () => {
    const el = scrollRef.current;
    if (el) anchor.current = el.scrollHeight - el.scrollTop;
  };
  // An earlier page is drawn whole: the user asked for it.
  const conv = useConversation(source, (what) => {
    if ('reset' in what) {
      deleteSavedScroll(sourceIdRef.current);
      lastKnownScroll.current = undefined;
      clearRestore();
      setLimit(SHOWN_ITEMS);
      setEarlier('idle');
      atEnd.current = true;
      setAway(false);
      setRewindTarget(undefined);
      return;
    }
    keep();
    if (what.grown > 0) setLimit((l) => l + what.grown);
  });

  // The view starts over with another source (loading any saved browsing state).
  const [shownSource, setShownSource] = useState(source);
  if (shownSource !== source) {
    const nextSaved = getSavedScroll(source.id);
    setShownSource(source);
    setLimit(Math.max(SHOWN_ITEMS, nextSaved?.limit ?? SHOWN_ITEMS));
    setEarlier('idle');
    setAway(nextSaved ? !nextSaved.atEnd : false);
    setRewindTarget(undefined);
  }
  const latestSource = useRef(source);
  useLayoutEffect(() => {
    const prev = latestSource.current;
    if (prev !== source) {
      const nextSaved = getSavedScroll(source.id);
      atEnd.current = nextSaved ? nextSaved.atEnd : true;
      restoreRef.current = nextSaved && !nextSaved.atEnd ? nextSaved : undefined;
      lastKnownScroll.current = nextSaved;
      lastRestoredTop.current = undefined;
    }
    latestSource.current = source;
    return () => {
      clearRestore();
      const el = scrollRef.current;
      if (el && shownRef.current && el.clientHeight > 0 && el.scrollHeight > 0) {
        const end = stickToEnd(el.scrollTop, el.scrollHeight, el.clientHeight);
        const anchorInfo = end ? undefined : findAnchorItem(el, listRef.current);
        const next: SavedScrollState = { atEnd: end, scrollTop: el.scrollTop, limit: limitRef.current, ...anchorInfo };
        lastKnownScroll.current = next;
        setSavedScroll(source.id, next);
      } else if (lastKnownScroll.current) {
        setSavedScroll(source.id, lastKnownScroll.current);
      }
    };
  }, [source, clearRestore]);

  // What the items call: the same functions for the view's life, calling
  // the parent's latest ones.
  const latest = useRef({ onOpenFile, onOpenChat, onFork, source });
  useLayoutEffect(() => {
    latest.current = { onOpenFile, onOpenChat, onFork, source };
  });
  const canOpen = !!onOpenFile;
  const canOpenChat = !!onOpenChat;
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
      openChat: canOpenChat ? (chatId, chatKind) => latest.current.onOpenChat?.(chatId, chatKind) : undefined,
      trust: canTrust ? () => latest.current.source.trust?.() ?? Promise.resolve() : undefined,
      untrust: canUntrust ? () => latest.current.source.untrust?.() ?? Promise.resolve() : undefined,
    }),
    [agent, stableBase, canOpen, canOpenChat, canTrust, canUntrust],
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

  // Rewind is only enabled when the agent supports native rollback (preserving
  // prompt cache); agents without native rewind surface an explicit unsupported notice.
  const rewindReady = !readOnly && !working && !conv.chat?.handedOff && !!source.rewind;
  const canRewind = rewindReady && !!caps.rewind;
  const rewindUnsupported = rewindReady && !caps.rewind && !!conv.chat;
  const rewindFiles = !!caps.rewindFiles;
  const canFork = !readOnly && !working && !!onFork;
  const nativeFork = !!caps.fork;
  // ACP session/fork clones the full session only; mid-history partial forks
  // fall back to a lossy Markdown summary on ACP agents.
  const nativePartialFork = !!caps.fork && chatAdapter(kind) !== 'acp';
  const canStopTask = !readOnly && !!caps.stopTask && !!source.stopTask;

  const lastUserSeq = useMemo(() => {
    for (let i = conv.items.length - 1; i >= 0; i--) {
      const it = conv.items[i];
      if (it.kind === 'message' && it.role === 'user' && it.seq !== undefined) return it.seq;
    }
    return undefined;
  }, [conv.items]);

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

  const prefillComposer = useCallback((value: string) => {
    composerRef.current?.setDraft(value);
  }, []);
  const clearRewindTarget = useCallback(() => setRewindTarget(undefined), []);

  const timelineActions = useMemo<TimelineActions>(
    () => ({
      rewind: canRewind ? (seq, opts) => latest.current.source.rewind!(seq, opts) : undefined,
      rewindUnsupported,
      rewindFiles,
      prefillComposer: canRewind ? prefillComposer : undefined,
      rewindTarget: canRewind ? rewindTarget : undefined,
      clearRewindTarget,
      fork: canFork ? (upToSeq) => latest.current.onFork?.(upToSeq) : undefined,
      nativeFork,
      nativePartialFork,
      lastUserSeq,
      stopTask: canStopTask ? (taskId) => latest.current.source.stopTask!(taskId) : undefined,
      tasksByToolCall,
      questionSourceItems,
    }),
    [
      canRewind,
      rewindUnsupported,
      rewindFiles,
      prefillComposer,
      rewindTarget,
      clearRewindTarget,
      canFork,
      nativeFork,
      nativePartialFork,
      lastUserSeq,
      canStopTask,
      tasksByToolCall,
      questionSourceItems,
    ],
  );

  const activeTasks = useMemo(() => activeBackgroundTasks(conv, kind), [conv, kind]);
  const delivered = useCallback((clientId: string) => hasClientMessage(conv, clientId), [conv]);

  useImperativeHandle(
    ref,
    () => ({ focus: () => (inputRef.current && !inputRef.current.disabled ? inputRef.current : scrollRef.current)?.focus() }),
    [],
  );

  const toEnd = useCallback(() => {
    clearRestore();
    atEnd.current = true;
    setAway(false);
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      recordScroll(el, true);
    }
  }, [clearRestore, recordScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !shownRef.current || el.clientHeight === 0 || el.scrollHeight === 0) return;
    if (restoreRef.current) {
      // Ignore the browser's async scroll notification from our own restore assignment;
      // any other scrollTop change means the user scrolled manually.
      if (lastRestoredTop.current !== undefined && Math.abs(el.scrollTop - lastRestoredTop.current) <= 2) return;
      clearRestore();
    }
    const end = stickToEnd(el.scrollTop, el.scrollHeight, el.clientHeight);
    atEnd.current = end;
    setAway(!end);
    recordScroll(el, end);
  };

  const hidden = Math.max(0, conv.items.length - limit);
  const visibleItems = hidden ? conv.items.slice(hidden) : conv.items;

  const focusReveal = useCallback(() => {
    if (!shownRef.current) return;
    const id = reveal.current;
    const list = listRef.current;
    if (!id || !list) return;
    const targetItem = findItemEl(list, id);
    if (!targetItem) return;
    reveal.current = undefined;
    targetItem.scrollIntoView?.({ block: 'center' });
    const target = targetItem.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? targetItem;
    target.focus();
  }, []);

  /** Shows and focuses an item in the timeline, expanding hidden items if needed. */
  const jumpToItem = useCallback(
    (id: string) => {
      const at = conv.items.findIndex((it) => it.id === id);
      if (at >= 0 && at < hidden) setLimit(conv.items.length - at);
      reveal.current = id;
      focusReveal();
    },
    [conv.items, hidden, focusReveal],
  );

  // External rewind request from the pane header turn picker: reveal the turn
  // and open its inline rewind confirmation panel.
  useEffect(() => {
    if (!rewindRequest || !canRewind || rewindRequest.nonce === handledRewindNonce.current) return;
    const target = conv.items.find((it) => it.kind === 'message' && it.role === 'user' && it.seq === rewindRequest.seq);
    if (!target) return;
    handledRewindNonce.current = rewindRequest.nonce;
    clearRestore();
    jumpToItem(target.id);
    setRewindTarget(rewindRequest);
  }, [rewindRequest, canRewind, conv.items, clearRestore, jumpToItem]);

  /** Shows the card that waits for the user, and gives it the keyboard. */
  const showWaiting = () => {
    const id = Array.from(blockingSet).at(-1) ?? Array.from(waitingSet).at(-1);
    if (id === undefined) return;
    jumpToItem(id);
  };

  // When a kept pane becomes visible again, synchronously restore its scroll
  // position before paint so returning to an active or paused chat never animates
  // from top to bottom.
  useLayoutEffect(() => {
    const wasShown = prevShown.current;
    prevShown.current = isShown;
    if (!isShown || wasShown) return;
    const el = scrollRef.current;
    if (el) {
      if (atEnd.current) {
        el.scrollTop = el.scrollHeight;
      } else if (lastKnownScroll.current) {
        restoreRef.current = lastKnownScroll.current;
        applyRestore();
        armSettle();
      }
    }
    focusReveal();
  }, [isShown, applyRestore, armSettle, focusReveal]);

  // After each change: back to where the user was when items came before
  // those shown (the distance from the end kept), else restore saved scroll on
  // mount, else snap to the end while the user is there; then focus any reveal.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !shownRef.current) return;
    if (anchor.current !== undefined) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = undefined;
    } else if (restoreRef.current && conv.items.length > 0) {
      applyRestore();
      armSettle();
    } else if (atEnd.current) {
      el.scrollTop = el.scrollHeight;
    }
    focusReveal();
  }, [conv, limit, applyRestore, armSettle, focusReveal]);

  // What grows after it is drawn (Markdown, formulas and code as their
  // renderers load, a tool call opened, the pane resized) keeps the list at
  // its end while the user is there, or keeps a restored reading anchor steady.
  useEffect(() => {
    const el = scrollRef.current;
    const list = listRef.current;
    if (!el || !list || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!shownRef.current || el.clientHeight === 0 || el.scrollHeight === 0) return;
      if (restoreRef.current) {
        applyRestore();
        armSettle();
      } else if (atEnd.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    ro.observe(list);
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyRestore, armSettle]);

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
          onWheel={clearRestore}
          onPointerDown={clearRestore}
          onTouchStart={clearRestore}
          onKeyDown={clearRestore}
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
                {visibleItems.map((it) => (
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
        branch={branch}
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
        composerRef={composerRef}
      />
    </div>
  );
}
