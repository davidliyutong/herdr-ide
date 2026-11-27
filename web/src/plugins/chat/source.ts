// A chat as the conversation view sees it (conversation/source.ts): the
// events of a chat that a machine's chat host runs, through a subscription
// of the page's chat connection (connection.ts), and its commands.
//
// After each attach its subscribers hear the chat as the host stated it
// (an info event) first, then its stored events after the last one the
// source has; after the page's connection came back (or the hub lost its
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
import { blocksText, readChat, readUsage, type ContentBlock, type SourceEvent, type Usage } from '../../conversation/model';
import type { ChatSource, Delivery, FileSuggestion, PermissionReply, QuestionReply, RewindOptions } from '../../conversation/source';
import { listDir } from '../../lib/files';
import { RETRY_RESET_MS, retryDelay } from '../../lib/retry';
import { useStore } from '../../state/store';
import { chatApi } from './api';
import { chatConnection, CLOSED, CommandError, readError, type ChatConnection, type Subscription } from './connection';
import { chatCwd, setLive, type LiveChat } from './state';
import type { Command, Event } from './protocol';

export { chatCwd };

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
/** The waits before attaching again after the hub ended a subscription. */
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
   * hub may answer before that). */
  private cur?: { sub?: Subscription };
  private attachedNow = false;
  private waiters: Array<{ resolve(): void; reject(e: CommandError): void; timer: ReturnType<typeof setTimeout> }> = [];
  private retry = RETRY_MIN_MS;
  private attachedAt?: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** The hub said there is no such chat. */
  private gone = false;
  private usage?: Usage;
  /** The chat's last observed host state (working/waiting/starting/idle/…). */
  private lastState?: string;
  /** Its next subscription attaches again (a reattach first). */
  private again = false;
  /** Number of commands currently awaiting an ack on this subscription. */
  private inFlight = 0;
  /** A reset event arrived while a command (e.g. rewind) was awaiting its ack. */
  private deferredReset = false;

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

  /** Whether this chat's agent is currently active (working, waiting, or starting). */
  get active(): boolean {
    return this.lastState === 'working' || this.lastState === 'waiting' || this.lastState === 'starting';
  }

  /** Stored user turns (User or Queued(taken)) in order, with their sequence
   * numbers and plain text previews (used by header rewind turn pickers). */
  userTurns(): Array<{ seq: number; text: string }> {
    const out: Array<{ seq: number; text: string }> = [];
    const seenClient = new Set<string>();
    for (const raw of this.stored) {
      if (!isObject(raw)) continue;
      const ev = raw as unknown as Event;
      const isUser = ev.t === 'user' || (ev.t === 'queued' && ev.state === 'taken');
      if (!isUser || typeof ev.seq !== 'number') continue;
      const cid = typeof ev.clientId === 'string' && ev.clientId ? ev.clientId : '';
      if (cid) {
        if (seenClient.has(cid)) continue;
        seenClient.add(cid);
      }
      const content = Array.isArray(ev.content) ? (ev.content as ContentBlock[]) : [];
      const text = blocksText(content).replace(/\s+/g, ' ').trim();
      out.push({ seq: ev.seq, text });
    }
    return out;
  }

  subscribe(fn: (ev: SourceEvent) => void): () => void {
    this.fns.add(fn);
    for (const ev of this.stored) fn(ev);
    for (const ev of this.liveEvents) fn(ev);
    return () => void this.fns.delete(fn);
  }

  send(content: ContentBlock[], clientId: string, delivery?: Delivery): Promise<void> {
    return this.command({ op: 'prompt', content, clientId, ...(delivery ? { delivery } : {}) });
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
  steerQueued(message: string, delivery: 'steer' | 'interrupt' = 'steer'): Promise<void> {
    return this.command({ op: 'steer_queued', message, delivery });
  }
  compact(instructions?: string): Promise<void> {
    return this.command({ op: 'compact', ...(instructions ? { instructions } : {}) });
  }
  stopTask(taskId: string): Promise<void> {
    return this.command({ op: 'stop_task', task: taskId });
  }
  rewind(seq: number, opts: RewindOptions = {}): Promise<void> {
    return this.command({
      op: 'rewind',
      seq,
      ...(opts.content ? { content: opts.content } : {}),
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
      ...(opts.restoreFiles ? { restoreFiles: true } : {}),
    });
  }
  /** Sets the chat's title. */
  rename(title: string): Promise<void> {
    return this.command({ op: 'rename', title });
  }
  /** Trusts the chat's folder, and those below it, on its machine (the
   * hub's route trust, audited): its agents load the project's own
   * settings from their next start. */
  trust(): Promise<void> {
    return this.folderTrust(chatApi.trust);
  }
  /** Takes back the trust that covers the chat's folder on its machine
   * (the hub's route untrust, audited): its agents start without the
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

  private suggestAbort?: AbortController;

  /** The files and folders of the chat's directory that match what the
   * user typed after `@`. For non-empty relative queries that do not end in
   * `/`, tries the machine's recursive `/p/files/find` endpoint first and
   * falls back gracefully to `listDir` on the folder before the last `/`. */
  async suggestFiles(query: string, callerSignal?: AbortSignal): Promise<FileSuggestion[]> {
    const cwd = chatCwd(this.m, this.chat);
    if (!cwd?.startsWith('/') || /\s/.test(query)) return [];
    if (callerSignal?.aborted) return [];
    this.suggestAbort?.abort();
    const ac = new AbortController();
    this.suggestAbort = ac;
    const onCallerAbort = () => ac.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const signal = ac.signal;
    try {
      if (query !== '' && !query.startsWith('/') && !query.endsWith('/')) {
        try {
          const params = new URLSearchParams({ dir: cwd, query, limit: '50' });
          const r = await fetch(`/api/m/${encodeURIComponent(this.m)}/p/files/find?${params}`, { cache: 'no-store', signal });
          if (r.ok) {
            const j: unknown = await r.json();
            if (isObject(j) && Array.isArray(j.matches)) {
              const out: FileSuggestion[] = [];
              for (const m of j.matches.slice(0, 50)) {
                if (!isObject(m) || typeof m.path !== 'string' || !m.path || typeof m.rel !== 'string' || !m.rel) continue;
                const isDir = m.is_dir === true;
                const label = isDir && !m.rel.endsWith('/') ? `${m.rel}/` : m.rel;
                out.push(isDir ? { path: m.path, label, isDir: true } : { path: m.path, label });
              }
              return out;
            }
          }
        } catch {
          if (signal.aborted) return [];
          // Fall through to directory listing.
        }
      }
      if (signal.aborted) return [];
      const cut = query.lastIndexOf('/');
      const head = cut >= 0 ? query.slice(0, cut + 1) : '';
      const tail = (cut >= 0 ? query.slice(cut + 1) : query).toLowerCase();
      const dir = head.startsWith('/') ? head : `${cwd.replace(/\/+$/, '')}/${head}`;
      const listing = await listDir(this.m, dir.length > 1 ? dir.replace(/\/+$/, '') : dir, signal);
      const entries = (Array.isArray(listing?.entries) ? listing.entries : []).filter(
        (e) => e && typeof e.name === 'string' && e.name && !/\s/.test(e.name) && (tail.startsWith('.') || !e.name.startsWith('.')),
      );
      const starts = entries.filter((e) => e.name.toLowerCase().startsWith(tail));
      const within = entries.filter((e) => !e.name.toLowerCase().startsWith(tail) && e.name.toLowerCase().includes(tail));
      const base = dir.endsWith('/') ? dir : `${dir}/`;
      return [...starts, ...within].slice(0, 50).map((e) => ({
        path: base + e.name,
        label: head + e.name + (e.is_dir ? '/' : ''),
        ...(e.is_dir ? { isDir: true } : {}),
      }));
    } finally {
      callerSignal?.removeEventListener('abort', onCallerAbort);
      if (this.suggestAbort === ac) this.suggestAbort = undefined;
    }
  }

  /** Attaches again now if the chat is not attached (a pane shows it
   * again after the hub ended its subscription). */
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
    this.deferredReset = false;
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
    this.attachedAt = performance.now();
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
    if (info?.state) this.lastState = info.state;
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
    const ms = useStore.getState().machines[this.m];
    const transientCore = code === 'no_terminal_core' && !!ms && (ms.status !== 'ready' || ms.hc?.state === 'starting');
    this.live({ link: code === 'offline' || code === 'lost' || transientCore ? 'offline' : 'failed', linkError: error });
    if (FINAL.has(code)) {
      this.fail(new CommandError(code, error.message));
      return;
    }
    // The events after the last one taken come again; increments may
    // have been lost meanwhile.
    this.again = true;
    if (this.attachedAt !== undefined && performance.now() - this.attachedAt >= RETRY_RESET_MS) this.retry = RETRY_MIN_MS;
    this.attachedAt = undefined;
    // Pause retry timers while the machine is disabled; re-enabling wakes held
    // sources immediately via syncMachineWatch().
    if (ms?.status === 'disabled') return;
    const wait = code === 'lost' && this.retry === RETRY_MIN_MS ? 0 : retryDelay(this.retry);
    this.retry = Math.min(this.retry * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.attach();
    }, wait);
  }

  private performReset() {
    const prev = this.cur;
    this.stored = [];
    this.liveEvents = [];
    this.last = 0;
    this.attachedNow = false;
    this.emit({ t: 'reset' });
    this.cur = undefined;
    queueMicrotask(() => {
      prev?.sub?.detach();
      if (!this.stopped && !this.cur) this.attach();
    });
  }

  private event(ev: Event) {
    // Rewind broadcasts a reset event whose seq is the new truncated head
    // (lower than this.last): clear local log and re-attach from 0 so live
    // subscribers reload the truncated history cleanly. Guard against replaying
    // a stored reset immediately after attach from 0, and defer detaching while
    // an in-flight command (such as rewind itself) is still awaiting its ack.
    if ((ev as { t: string }).t === 'reset') {
      if (this.last === 0 && this.stored.length <= 1 && ev.live !== true) return;
      if (this.inFlight > 0) {
        this.deferredReset = true;
        return;
      }
      this.performReset();
      return;
    }
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
      if (info.state) this.lastState = info.state;
      this.live({ info, state: info.state, error: info.error, usage: this.usage });
    } else if (ev.t === 'state' && typeof ev.state === 'string') {
      this.lastState = ev.state;
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
    this.inFlight++;
    try {
      await this.conn.command(this.m, this.chat, cmd as Command);
    } finally {
      this.inFlight--;
      if (this.inFlight === 0 && this.deferredReset && !this.stopped) {
        this.deferredReset = false;
        this.performReset();
      }
    }
  }
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
let unwatchMachines: (() => void) | undefined;

function syncMachineWatch() {
  if (held.size > 0) {
    unwatchMachines ??= useStore.subscribe((st, prev) => {
      if (st.machines === prev.machines) return;
      for (const [m, info] of Object.entries(st.machines)) {
        const was = prev.machines[m];
        const machineUp = info.status === 'ready' && was?.status !== 'ready';
        const hcUp = info.hc?.state === 'ready' && was?.hc?.state !== 'ready';
        if (!machineUp && !hcUp) continue;
        for (const h of held.values()) if (h.source.m === m) h.source.wake();
      }
    });
  } else {
    unwatchMachines?.();
    unwatchMachines = undefined;
  }
}

function drop(k: string) {
  const h = held.get(k);
  if (!h) return;
  clearTimeout(h.timer);
  held.delete(k);
  h.source.stop();
  syncMachineWatch();
}

/** Lets go of h: kept KEEP_MS, the sources kept longest going first past
 * KEEP_IDLE. Idle (non-working) unreferenced sources are always evicted before
 * actively working ones so an active agent's subscription is protected. */
function idle(k: string, h: Held) {
  h.idleSince = Date.now();
  clearTimeout(h.timer);
  h.timer = setTimeout(() => drop(k), KEEP_MS);
  const idleOnes = [...held.entries()]
    .filter(([, x]) => x.refs === 0)
    .sort((a, b) => Number(a[1].source.active) - Number(b[1].source.active) || a[1].idleSince - b[1].idleSince);
  for (const [key] of idleOnes.slice(0, Math.max(0, idleOnes.length - KEEP_IDLE))) drop(key);
}

/** Stored user turns of a currently held chat source (empty when not attached). */
export function chatUserTurns(m: string, chat: string): Array<{ seq: number; text: string }> {
  return held.get(keyOf(m, chat))?.source.userTurns() ?? [];
}

/** The page's source of a chat, made when there is none; it is kept
 * KEEP_MS unless held (holdSource). */
export function chatSource(m: string, chat: string): ChatSourceImpl {
  const k = keyOf(m, chat);
  let h = held.get(k);
  if (!h) {
    h = { source: new ChatSourceImpl(m, chat), refs: 0, idleSince: Date.now() };
    held.set(k, h);
    syncMachineWatch();
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
