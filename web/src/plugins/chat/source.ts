// A chat as the conversation view sees it (conversation/source.ts): the
// events of a chat that a machine's chat host runs, through a subscription
// of the page's chat connection (connection.ts), and its commands.
//
// After each attach its subscribers hear the chat as the host stated it
// (an info event) first, then its stored events after the last one the
// source has; after the page's connection came back (or the core lost its
// connection to the host) a reattach event comes before that, as live
// increments may have been lost. A chat whose log went back below what the
// source has (another host's), or whose stored events now begin after the
// next one the source lacks (the host's limits removed those in between),
// starts over: a reset, and its stored events from the first. A subscriber that comes later hears what the source has: the
// info and stored events in order, then the live increments of the items
// still being written.
//
// The pane that shows a chat takes its source with useChatSource; the
// sources of chats no pane shows are kept KEEP_MS (a tab shown again finds
// its chat as it was), at most KEEP_IDLE of them.
import { useEffect, useMemo } from 'react';
import { readChat, readUsage, type ContentBlock, type SourceEvent, type Usage } from '../../conversation/model';
import type { ChatSource, FileSuggestion, PermissionReply, QuestionReply } from '../../conversation/source';
import { listDir } from '../../lib/files';
import { useStore } from '../../state/store';
import { chatApi } from './api';
import { chatConnection, CLOSED, CommandError, readError, type ChatConnection, type Subscription } from './connection';
import { chatState, liveKey, setLive, useChats, type LiveChat } from './state';
import type { Command, Event } from './protocol';

/** How long a source no pane shows is kept. */
export const KEEP_MS = 30_000;
/** The most sources no pane shows kept at once. */
export const KEEP_IDLE = 6;
/** The most stored events a source keeps for subscribers that come later,
 * and the most live increments. */
export const MAX_STORED = 20_000;
export const MAX_LIVE = 4_000;
/** How long a command waits for the chat to be attached. */
export const ATTACH_WAIT_MS = 15_000;
/** The waits before attaching again after the core ended a subscription. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** The codes of a subscription's end after which it is not attached
 * again: the chat is no more, or the request cannot be taken. */
const FINAL = new Set(['unknown_chat', 'bad_request', 'plugin_disabled', CLOSED]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The usage after an update of the agent's (usage_update): its tokens and
 * cost; the limits stay. */
function usageAfter(prev: Usage | undefined, u: Record<string, unknown>): Usage | undefined {
  const next = readUsage({ ...u, size: typeof u.size === 'number' && u.size > 0 ? u.size : (prev?.size ?? 0) });
  if (!next) return prev;
  if (!next.cost && prev?.cost && u.cost === undefined) next.cost = prev.cost;
  if (!next.limits && prev?.limits) next.limits = prev.limits;
  return next;
}

export class ChatSourceImpl implements ChatSource {
  /** The chat's id: drafts are kept by it. */
  readonly id: string;
  private readonly fns = new Set<(ev: SourceEvent) => void>();
  private stored: SourceEvent[] = [];
  private liveEvents: Event[] = [];
  /** The last stored seq taken. */
  private last = 0;
  /** The current subscription (its handle is set once attach returned: the
   * core may answer before that). */
  private cur?: { sub?: Subscription };
  private attachedNow = false;
  private waiters: Array<{ resolve(): void; reject(e: CommandError): void; timer: ReturnType<typeof setTimeout> }> = [];
  private retry = RETRY_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** The core said there is no such chat. */
  private gone = false;
  private usage?: Usage;
  /** Its next subscription attaches again (a reattach first). */
  private again = false;

  constructor(
    readonly m: string,
    readonly chat: string,
    private readonly conn: ChatConnection = chatConnection(),
  ) {
    this.id = chat;
    this.attach();
  }

  /** The page is read-only: every control is disabled. */
  get readOnly(): boolean {
    return useStore.getState().readOnly;
  }

  subscribe(fn: (ev: SourceEvent) => void): () => void {
    this.fns.add(fn);
    for (const ev of this.stored) fn(ev);
    for (const ev of this.liveEvents) fn(ev);
    return () => void this.fns.delete(fn);
  }

  send(content: ContentBlock[], clientId: string): Promise<void> {
    return this.command({ op: 'prompt', content, clientId });
  }
  cancel(): Promise<void> {
    return this.command({ op: 'cancel' });
  }
  respond(permission: string, reply: PermissionReply): Promise<void> {
    return this.command(
      'option' in reply
        ? { op: 'permission', request: permission, option: reply.option }
        : { op: 'permission', request: permission, cancelled: true },
    );
  }
  answer(question: string, reply: QuestionReply): Promise<void> {
    return this.command(
      'answers' in reply
        ? { op: 'answer', request: question, answers: reply.answers }
        : { op: 'answer', request: question, cancelled: true },
    );
  }
  setConfig(id: string, value: string): Promise<void> {
    return this.command({ op: 'set_config', config: id, value });
  }
  cancelQueued(message: string): Promise<void> {
    return this.command({ op: 'cancel_queued', message });
  }
  compact(): Promise<void> {
    return this.command({ op: 'compact' });
  }
  /** Sets the chat's title. */
  rename(title: string): Promise<void> {
    return this.command({ op: 'rename', title });
  }
  /** Trusts the chat's folder, and those below it, on its machine (the
   * core's route trust, audited): its agents load the project's own
   * settings from their next start. */
  trust(): Promise<void> {
    return this.folderTrust(chatApi.trust);
  }
  /** Takes back the trust that covers the chat's folder on its machine
   * (the core's route untrust, audited): its agents start without the
   * project's own settings again. */
  untrust(): Promise<void> {
    return this.folderTrust(chatApi.untrust);
  }
  private async folderTrust(ask: (m: string, cwd: string) => Promise<void>): Promise<void> {
    if (this.readOnly) throw new CommandError('read_only');
    const cwd = chatCwd(this.m, this.chat);
    if (!cwd?.startsWith('/')) throw new CommandError('bad_request');
    await ask(this.m, cwd);
  }

  /** The files and folders of the chat's directory that match what the
   * user typed after `@`: a path relative to it, whose last part is
   * matched against the names of the folder before it (names that start
   * with it first). Names with white space cannot be written after `@`
   * and are left out. */
  async suggestFiles(query: string): Promise<FileSuggestion[]> {
    const cwd = chatCwd(this.m, this.chat);
    if (!cwd?.startsWith('/') || /\s/.test(query)) return [];
    const cut = query.lastIndexOf('/');
    const head = cut >= 0 ? query.slice(0, cut + 1) : '';
    const tail = (cut >= 0 ? query.slice(cut + 1) : query).toLowerCase();
    const dir = head.startsWith('/') ? head : `${cwd.replace(/\/+$/, '')}/${head}`;
    const listing = await listDir(this.m, dir.length > 1 ? dir.replace(/\/+$/, '') : dir);
    const entries = (Array.isArray(listing?.entries) ? listing.entries : []).filter(
      (e) => e && typeof e.name === 'string' && e.name && !/\s/.test(e.name) && (tail.startsWith('.') || !e.name.startsWith('.')),
    );
    const starts = entries.filter((e) => e.name.toLowerCase().startsWith(tail));
    const within = entries.filter((e) => !e.name.toLowerCase().startsWith(tail) && e.name.toLowerCase().includes(tail));
    const base = dir.endsWith('/') ? dir : `${dir}/`;
    return [...starts, ...within].slice(0, 50).map((e) => ({
      path: base + e.name,
      label: head + e.name + (e.is_dir ? '/' : ''),
    }));
  }

  /** Attaches again now if the chat is not attached (a pane shows it
   * again after the core ended its subscription). */
  wake() {
    if (this.stopped || this.gone || this.cur) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retry = RETRY_MIN_MS;
    this.attach();
  }

  /** Ends the subscription for good. */
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.cur?.sub?.detach();
    this.cur = undefined;
    this.attachedNow = false;
    this.fail(new CommandError('ended'));
    this.fns.clear();
    setLive(this.m, this.chat, undefined);
  }

  // ---- the subscription ----

  private attach() {
    if (this.stopped) return;
    this.attachedNow = false;
    this.live({ link: 'attaching', linkError: undefined });
    const cur: { sub?: Subscription } = {};
    this.cur = cur;
    cur.sub = this.conn.attach(this.m, this.chat, {
      from: () => this.last,
      attached: (chat, first, again) => {
        if (cur === this.cur) this.attached(cur, chat, first, again || this.again);
      },
      event: (ev) => {
        if (cur === this.cur) this.event(ev);
      },
      detached: (error) => {
        if (cur !== this.cur) return;
        this.cur = undefined;
        this.attachedNow = false;
        this.detached(error.code, error);
      },
      offline: () => {
        if (cur !== this.cur) return;
        this.attachedNow = false;
        this.live({ link: 'offline' });
      },
    });
  }

  private attached(cur: { sub?: Subscription }, chat: Record<string, unknown>, first: number | undefined, again: boolean) {
    this.again = false;
    this.retry = RETRY_MIN_MS;
    const seq = typeof chat.seq === 'number' ? chat.seq : undefined;
    const gap = first !== undefined && this.last > 0 && first > this.last + 1;
    if ((again && seq !== undefined && seq < this.last) || gap) {
      // Another log than the one the source has, or one without the events
      // that follow what it has: from its start.
      this.stored = [];
      this.liveEvents = [];
      this.last = 0;
      this.emit({ t: 'reset' });
      this.cur = undefined;
      queueMicrotask(() => {
        cur.sub?.detach();
        if (!this.cur) this.attach();
      });
      return;
    }
    if (again) {
      this.liveEvents = [];
      this.emit({ t: 'reattach' });
    }
    this.attachedNow = true;
    const info = readChat(chat);
    this.usage = info?.usage ?? this.usage;
    this.live({ link: 'attached', linkError: undefined, info, state: info?.state, error: info?.error, usage: this.usage });
    this.keep({ t: 'info', chat });
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  private detached(code: string, error: { code: string; message: string; stderr?: string }) {
    if (this.stopped) return;
    if (code === 'unknown_chat') {
      this.gone = true;
      this.live({ link: 'gone', linkError: error });
      this.fail(new CommandError(code, error.message));
      return;
    }
    this.live({ link: code === 'offline' || code === 'lost' ? 'offline' : 'failed', linkError: error });
    if (FINAL.has(code)) {
      this.fail(new CommandError(code, error.message));
      return;
    }
    // The events after the last one taken come again; increments may
    // have been lost meanwhile.
    this.again = true;
    const wait = code === 'lost' ? 0 : this.retry;
    this.retry = Math.min(this.retry * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.attach();
    }, wait);
  }

  private event(ev: Event) {
    const stored = ev.live !== true && typeof ev.seq === 'number';
    if (stored) {
      if (ev.seq! <= this.last) return;
      this.last = ev.seq!;
      this.track(ev);
      // What arrived live for this item is replaced by it.
      if (typeof ev.item === 'string' && ev.item) this.liveEvents = this.liveEvents.filter((x) => x.item !== ev.item);
      if (ev.t === 'turn' && ev.state !== 'start') this.liveEvents = [];
      this.keep(ev);
      return;
    }
    if (ev.t === 'ack') return;
    this.liveEvents.push(ev);
    if (this.liveEvents.length > MAX_LIVE) this.liveEvents.splice(0, this.liveEvents.length - MAX_LIVE);
    this.emit(ev);
  }

  /** What the store keeps of a stored event: the chat's state, what it
   * states, its usage. */
  private track(ev: Event) {
    if (ev.t === 'info') {
      const info = readChat(ev.chat);
      if (!info) return;
      this.usage = info.usage ?? this.usage;
      this.live({ info, state: info.state, error: info.error, usage: this.usage });
    } else if (ev.t === 'state' && typeof ev.state === 'string') {
      this.live({ state: ev.state, error: ev.state === 'failed' ? readError(ev.error) : undefined });
    } else if (ev.t === 'update' && isObject(ev.update) && ev.update.sessionUpdate === 'usage_update') {
      const usage = usageAfter(this.usage, ev.update);
      if (usage !== this.usage) {
        this.usage = usage;
        this.live({ usage });
      }
    }
  }

  /** Keeps an event for subscribers that come later, and gives it to
   * those there. */
  private keep(ev: SourceEvent) {
    this.stored.push(ev);
    if (this.stored.length > MAX_STORED) this.stored.splice(0, this.stored.length - MAX_STORED);
    this.emit(ev);
  }

  private emit(ev: SourceEvent) {
    for (const fn of [...this.fns]) fn(ev);
  }

  private live(patch: Partial<LiveChat>) {
    if (!this.stopped) setLive(this.m, this.chat, patch);
  }

  // ---- commands ----

  private fail(e: CommandError) {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(e);
    }
  }

  /** Resolves once the chat is attached. */
  private ready(): Promise<void> {
    if (this.attachedNow) return Promise.resolve();
    if (this.stopped) return Promise.reject(new CommandError('ended'));
    if (this.gone) return Promise.reject(new CommandError('unknown_chat'));
    const p = new Promise<void>((resolve, reject) => {
      const w = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new CommandError('offline'));
        }, ATTACH_WAIT_MS),
      };
      this.waiters.push(w);
    });
    this.wake();
    return p;
  }

  private async command(cmd: Omit<Command, 'id'>): Promise<void> {
    if (this.readOnly) throw new CommandError('read_only');
    await this.ready();
    await this.conn.command(this.m, this.chat, cmd as Command);
  }
}

/** A chat's directory: what its attached source states, else its state. */
export function chatCwd(m: string, chat: string): string | undefined {
  return useChats.getState().live[liveKey(m, chat)]?.info?.cwd || chatState(m, chat)?.cwd || undefined;
}

// ---- the sources the page has ----

interface Held {
  source: ChatSourceImpl;
  refs: number;
  timer?: ReturnType<typeof setTimeout>;
  /** When no pane held it any more. */
  idleSince: number;
}

const held = new Map<string, Held>();
const keyOf = (m: string, chat: string) => `${m}\n${chat}`;

function drop(k: string) {
  const h = held.get(k);
  if (!h) return;
  clearTimeout(h.timer);
  held.delete(k);
  h.source.stop();
}

/** Lets go of h: kept KEEP_MS, the sources kept longest going first past
 * KEEP_IDLE. */
function idle(k: string, h: Held) {
  h.idleSince = Date.now();
  clearTimeout(h.timer);
  h.timer = setTimeout(() => drop(k), KEEP_MS);
  const idleOnes = [...held.entries()].filter(([, x]) => x.refs === 0).sort((a, b) => a[1].idleSince - b[1].idleSince);
  for (const [key] of idleOnes.slice(0, Math.max(0, idleOnes.length - KEEP_IDLE))) drop(key);
}

/** The page's source of a chat, made when there is none; it is kept
 * KEEP_MS unless held (holdSource). */
export function chatSource(m: string, chat: string): ChatSourceImpl {
  const k = keyOf(m, chat);
  let h = held.get(k);
  if (!h) {
    h = { source: new ChatSourceImpl(m, chat), refs: 0, idleSince: Date.now() };
    held.set(k, h);
    idle(k, h);
  }
  return h.source;
}

/** Holds a chat's source until the function returned is called. */
export function holdSource(m: string, chat: string): () => void {
  const source = chatSource(m, chat);
  const k = keyOf(m, chat);
  const h = held.get(k)!;
  h.refs++;
  clearTimeout(h.timer);
  h.timer = undefined;
  source.wake();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const now = held.get(k);
    if (now !== h) return;
    h.refs--;
    if (h.refs === 0) idle(k, h);
  };
}

/** The source of a chat for a component, held while it is mounted. */
export function useChatSource(m: string, chat: string | undefined): ChatSourceImpl | undefined {
  const source = useMemo(() => (chat ? chatSource(m, chat) : undefined), [m, chat]);
  useEffect(() => (chat ? holdSource(m, chat) : undefined), [m, chat]);
  return source;
}

/** Runs fn with a chat's source, attached, held meanwhile (a command from
 * a menu of a pane not shown). */
export async function withSource<T>(m: string, chat: string, fn: (s: ChatSourceImpl) => Promise<T>): Promise<T> {
  const release = holdSource(m, chat);
  try {
    return await fn(chatSource(m, chat));
  } finally {
    release();
  }
}

/** Ends every source (tests). */
export function dropSources() {
  for (const k of [...held.keys()]) drop(k);
}
