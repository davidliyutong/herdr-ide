// The conversations the agents plugin shows, read from their sessions'
// transcripts on their machines (internal/plugins/agents: GET
// /api/m/{id}/p/agents/tail): a feed for each session a surface shows, read
// by one poller per machine, and the source (conversation/source.ts) a
// surface's view takes the feed's events from, one per feed and terminal.
//
// A machine has at most one read in flight for the whole page: every
// session the page shows on it in one request, which waits on the machine
// for new lines (a long poll), then the next. A session's first read is a
// back read (the page at the transcript's end), the later ones go forward
// from the cursor the previous reply gave. Cursors are opaque numbers: sent
// back as they came and compared, never taken apart. A first page that
// does not come (the machine busy, the reads failing, FIRST_PAGE_MS gone)
// leaves the terminal shown while the reads go on; after a failure the
// next read waits, unless the machine comes back or the page is shown
// again.

import { create } from 'zustand';
import { hasNativeView } from '../../conversation/kinds';
import { blocksText, NOTICES, ownMeta, type ChatEvent, type ContentBlock, type SourceEvent } from '../../conversation/model';
import type { AgentSource, SourceCapabilities } from '../../conversation/source';
import { agentOf, agentStatus } from '../../lib/machine';
import { paneHandle } from '../../state/panes';
import { useStore } from '../../state/store';
import { terms, useTerms } from '../../state/terms';
import { isLive, type TerminalRecord } from '../../term/protocol';

/** The most sessions one read takes (agentproto.MaxTailRefs). */
export const MAX_REFS = 8;
/** How long a read waits on the machine for new lines (agentproto.MaxTailWait). */
export const WAIT_MS = 15_000;
/** How much longer than its wait a read may take before it counts as failed. */
export const READ_SLACK_MS = 10_000;
/** The first and the longest wait after a failed read; each failure doubles it. */
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 30_000;
/** How long a session shown waits for its first page, and how many first
 * reads in a row may find the machine busy, before the surface says the
 * conversation cannot be read and shows the terminal; the reads go on. */
export const FIRST_PAGE_MS = 5_000;
export const FIRST_READ_TRIES = 3;
/** How long a message typed into the terminal has to show in the transcript. */
export const CONFIRM_MS = 10_000;
/** The pause between a message pasted into the terminal and the Enter that
 * sends it: a terminal program that tells pastes from typing by their pace
 * (Codex) takes an Enter right after a burst of text as a new line. */
export const ENTER_DELAY_MS = 250;
/** The most bytes of an event's text (agentproto.MaxTextBytes): a longer
 * prompt is in the transcript cut short. */
export const MAX_TEXT_BYTES = 256 << 10;
/** How much of the start of a prompt the transcript has cut short is
 * compared with the message sent, as plain text. */
const PROMPT_HEAD = 4096;
/** Feeds no surface shows that are kept, for a pane shown again. */
const IDLE_FEEDS = 8;
/** The most events a feed keeps for views that subscribe later; earlier
 * ones are read again on request (loadEarlier). */
const MAX_EVENTS = 20_000;

/** What a feed has to show: nothing read yet (loading), the conversation
 * (ok), no transcript of the session yet (not_found), one stored compressed
 * (compressed), no first page that could be read (error), or a session the
 * machine does not read (bad). */
export type FeedState = 'loading' | 'ok' | 'not_found' | 'compressed' | 'error' | 'bad';

export interface FeedStatus {
  state: FeedState;
  /** The last read failed: what is shown may not be current. */
  stale?: boolean;
}

/** The feeds' states, by feedKey, for views and the surfaces' covers. */
export const useFeeds = create<{ status: Record<string, FeedStatus> }>(() => ({ status: {} }));

export const feedKey = (m: string, kind: string, session: string) => `${m}\n${kind}\n${session}`;

/** The state of a session's feed, when the page has one. */
export function feedStatus(m: string, kind: string, session: string): FeedStatus | undefined {
  return useFeeds.getState().status[feedKey(m, kind, session)];
}

/** The state of a session's feed, for components. */
export function useFeedStatus(m: string, kind: string | undefined, session: string | undefined): FeedStatus | undefined {
  return useFeeds((s) => (kind && session ? s.status[feedKey(m, kind, session)] : undefined));
}

/** The kind of the agent running in a terminal, when its conversations have
 * a native view. */
export function nativeKind(record: TerminalRecord | undefined): string | undefined {
  if (!record || !isLive(record)) return undefined;
  const kind = agentOf(record);
  return hasNativeView(kind) ? kind : undefined;
}

/** A transcript to read: the agent's kind, the session, and the cursor a
 * forward read starts at, or the page before which a back read reads. */
interface Ref {
  kind: string;
  session: string;
  from: number;
  back: boolean;
}

/** One transcript's part of a reply (agentproto.TranscriptTail). */
interface Tail {
  kind?: string;
  session?: string;
  file?: string;
  first?: number;
  next?: number;
  events?: ChatEvent[];
  more?: boolean;
  code?: string;
}

/** A message typed into the terminal, waiting to show in the transcript. */
interface Waiter {
  /** The message as compared (plain), and its start (PROMPT_HEAD), which is
   * compared with a prompt the transcript has cut short. */
  text: string;
  head: string;
  /** Longer than the transcript keeps of a prompt. */
  long: boolean;
  /** A command of the agent's interface (/name) or of its shell (!): the
   * transcript has a command's notice for it rather than a prompt. */
  command: boolean;
  /** The highest seq taken when it was sent. */
  after: number;
  resolve(): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Why a message did not reach the agent: read_only, detached (no terminal
 * on screen that runs the session's agent), blocked (the agent waits for
 * an answer in its terminal), empty, pasted (pasted into the terminal, but
 * the Enter not pressed: the agent began to wait for an answer, left the
 * terminal, or its pane went during the pause), unconfirmed (it did not
 * show in the transcript). */
export type SendCode = 'read_only' | 'detached' | 'blocked' | 'empty' | 'pasted' | 'unconfirmed';

export class SendError extends Error {
  constructor(readonly code: SendCode) {
    super(code);
  }
}

/** A session's conversation as the page has read it. */
export class Feed {
  readonly key: string;
  state: FeedState = 'loading';
  stale = false;
  /** The transcript's file as the machine names it (no path): a reply of
   * another one starts the feed over. */
  file?: string;
  /** The forward cursor; undefined while the next read is a first one. */
  next?: number;
  /** Where the events kept start: the cursor of a page of earlier ones. */
  first?: number;
  /** There are events before those read. */
  more = false;
  /** The events read, by seq. */
  events: ChatEvent[] = [];
  /** The highest seq taken. */
  last = -1;
  /** The surfaces that show it. */
  holders = 0;
  /** Counts the times the feed started over: a reply to a read made before
   * is not taken after it. */
  generation = 0;
  /** First reads in a row that failed. */
  misses = 0;
  /** Ends the time the first page has (FIRST_PAGE_MS). */
  firstTimer?: ReturnType<typeof setTimeout>;
  readonly listeners = new Set<(ev: SourceEvent) => void>();
  waiters: Waiter[] = [];
  /** Its sources, by the terminal they type into: a view drawn again gets
   * the one it had, and with it the user's draft. */
  readonly sources = new Map<string, TranscriptSource>();

  constructor(
    readonly m: string,
    readonly kind: string,
    readonly session: string,
  ) {
    this.key = feedKey(m, kind, session);
  }
}

const feeds = new Map<string, Feed>();
/** Feeds no surface shows, the one let go of longest ago first. */
let idle: string[] = [];
const pollers = new Map<string, Poller>();
let watching = false;

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function publish(f: Feed) {
  if (feeds.get(f.key) !== f) return;
  const now = useFeeds.getState().status[f.key];
  if (now && now.state === f.state && !!now.stale === f.stale) return;
  const st: FeedStatus = f.stale ? { state: f.state, stale: true } : { state: f.state };
  useFeeds.setState((s) => ({ status: { ...s.status, [f.key]: st } }));
}

function emit(f: Feed, ev: SourceEvent) {
  for (const fn of [...f.listeners]) fn(ev);
}

/** Forgets what was read: the views start over. */
function reset(f: Feed) {
  f.events = [];
  f.last = -1;
  f.file = undefined;
  f.next = undefined;
  f.first = undefined;
  f.more = false;
  f.generation++;
  emit(f, { t: 'reset' });
}

/** Gives the first page its time while the feed is shown without one. */
function startFirstTimer(f: Feed) {
  if (f.state !== 'loading' || f.firstTimer !== undefined) return;
  f.firstTimer = setTimeout(() => {
    f.firstTimer = undefined;
    if (f.state !== 'loading' || feeds.get(f.key) !== f) return;
    f.state = 'error';
    publish(f);
  }, FIRST_PAGE_MS);
}

function stopFirstTimer(f: Feed) {
  clearTimeout(f.firstTimer);
  f.firstTimer = undefined;
}

/** Text as compared with a prompt in the transcript: line breaks and runs
 * of white space as one space, without white space around it. */
const plain = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Whether a prompt of the transcript (plain, cut: cut short there) is the
 * message a waiter waits for: the same text, or containing it; the same
 * start, for a prompt too long for the transcript to keep whole. */
const isPrompt = (text: string, cut: boolean, w: Waiter) =>
  text === w.text || text.includes(w.text) || ((cut || w.long) && text.slice(0, PROMPT_HEAD) === w.head);

function confirmed(f: Feed, w: Waiter) {
  settleWaiter(f, w);
  w.resolve();
}

/** Events of a read after those taken, in their order. */
function append(f: Feed, events: readonly ChatEvent[] | undefined) {
  const added: ChatEvent[] = [];
  for (const ev of events ?? []) {
    if (!ev || typeof ev.seq !== 'number' || ev.seq <= f.last) continue;
    f.last = ev.seq;
    f.events.push(ev);
    added.push(ev);
  }
  if (f.events.length > MAX_EVENTS) {
    f.events = f.events.slice(f.events.length - MAX_EVENTS);
    f.first = f.events[0].seq;
    f.more = true;
  }
  for (const ev of added) emit(f, ev);
  // A message typed into the terminal arrived: as the user's prompt, or,
  // for a command, as the first command's notice after it was sent.
  for (const ev of added) {
    if (!f.waiters.length) break;
    const seq = ev.seq!;
    if (ev.t === 'user' && Array.isArray(ev.content)) {
      const text = plain(blocksText(ev.content));
      const cut = ev.content.some((b) => ownMeta(b)?.truncated === true);
      for (const w of [...f.waiters]) if (seq > w.after && isPrompt(text, cut, w)) confirmed(f, w);
    } else if (ev.t === 'notice' && ev.method === NOTICES.command) {
      const w = f.waiters.find((x) => x.command && seq > x.after);
      if (w) confirmed(f, w);
    }
  }
}

function settleWaiter(f: Feed, w: Waiter) {
  clearTimeout(w.timer);
  f.waiters = f.waiters.filter((x) => x !== w);
}

/** Takes one transcript's part of a reply to ref; false when it is not one
 * (another session's, or without its cursors). */
function take(f: Feed, tail: Tail | undefined, ref: Ref): boolean {
  if (!tail || tail.kind !== f.kind || tail.session !== f.session) {
    failed(f, false);
    return false;
  }
  const code = typeof tail.code === 'string' ? tail.code : '';
  if (code) {
    if (f.file !== undefined || f.events.length) reset(f);
    f.state = code === 'not_found' ? 'not_found' : code === 'compressed' ? 'compressed' : 'bad';
    f.stale = false;
    f.misses = 0;
    stopFirstTimer(f);
    publish(f);
    return true;
  }
  if (typeof tail.next !== 'number' || typeof tail.first !== 'number') {
    failed(f, false);
    return false;
  }
  f.misses = 0;
  stopFirstTimer(f);
  const other = f.file !== undefined && typeof tail.file === 'string' && tail.file !== f.file;
  if (other && !ref.back) {
    // Another file answered a forward read: its events start where the old
    // file's cursor happened to fall, not at a page's start. The feed
    // starts over with the new file's last page, read next.
    reset(f);
    f.stale = false;
    publish(f);
    return true;
  }
  // Another file, or a forward cursor the file no longer has (the machine
  // answers it as a first read): the feed starts over.
  let fresh = ref.back;
  if (other || (!ref.back && tail.first < ref.from)) {
    reset(f);
    fresh = true;
  }
  if (typeof tail.file === 'string' && tail.file) f.file = tail.file;
  if (fresh) {
    f.first = tail.first;
    f.more = !!tail.more;
  }
  f.next = tail.next;
  f.state = 'ok';
  f.stale = false;
  append(f, Array.isArray(tail.events) ? tail.events : []);
  publish(f);
  return true;
}

/** A read of the feed failed (busy: the core had too many reads of the
 * machine, which passes). Without a first page, the surface says so at
 * once, or after FIRST_READ_TRIES busy reads in a row. */
function failed(f: Feed, busy: boolean) {
  if (f.state === 'loading') {
    f.misses++;
    if (!busy || f.misses >= FIRST_READ_TRIES) {
      f.state = 'error';
      stopFirstTimer(f);
    }
  } else if (f.state === 'ok') f.stale = true;
  publish(f);
}

function refOf(f: Feed): Ref {
  return f.next === undefined
    ? { kind: f.kind, session: f.session, from: 0, back: true }
    : { kind: f.kind, session: f.session, from: f.next, back: false };
}

/** Whether the feed's next read should be answered at once: its first, for
 * a session whose transcript the machine found or may have found. */
const firstRead = (f: Feed) => f.next === undefined && f.state !== 'not_found';

/** The URL of a read of refs that waits up to wait ms for new lines. */
export function tailUrl(m: string, refs: readonly Ref[], wait: number): string {
  const q = new URLSearchParams();
  for (const r of refs) q.append('s', [r.kind, r.session, String(r.from), ...(r.back ? ['b'] : [])].join('~'));
  q.set('wait', String(wait));
  return `/api/m/${encodeURIComponent(m)}/p/agents/tail?${q}`;
}

/** Reads the transcripts of a machine's feeds that surfaces show: one read
 * at a time, the next as soon as one is answered; after a failure the next
 * waits, longer each time, unless the machine's terminals come again or
 * the page is shown again (wake). A read is given up when the sessions
 * shown change (the next one has them), and none is made while the page
 * is hidden or nothing is shown. */
class Poller {
  private ctl?: AbortController;
  /** The sessions of the read in flight, or of the one that failed last. */
  private set = '';
  private wait = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private delay = 0;
  private turn = 0;
  private queued = false;
  /** Stops listening for the machine's terminals. */
  off?: () => void;

  constructor(readonly m: string) {}

  /** Looks again at what to read, once the current task is done (several
   * surfaces mounting together make one read). */
  poke() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.consider();
    });
  }

  /** Reads at once what waits for a retry, the failures before forgotten:
   * the machine is back, or the page is shown again. */
  wake() {
    this.delay = 0;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.poke();
  }

  /** The feeds to read: those shown, but not those that will not change. */
  private wanted(): Feed[] {
    const list = [...feeds.values()]
      .filter((f) => f.m === this.m && f.holders > 0 && f.state !== 'compressed' && f.state !== 'bad')
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (list.length <= MAX_REFS) return list;
    // More sessions shown than a read takes: each read takes the next ones.
    const at = this.turn % list.length;
    return [...list.slice(at), ...list.slice(0, at)].slice(0, MAX_REFS);
  }

  consider() {
    const list = this.wanted();
    const set = list.map((f) => f.key).join('\t');
    if (this.ctl) {
      // The same sessions: the read in flight goes on, unless it waits on
      // the machine while one of them needs its first page now.
      if (set === this.set && !(this.wait > 0 && list.some(firstRead))) return;
      this.abort();
    }
    if (!list.length) {
      clearTimeout(this.retry);
      this.retry = undefined;
      return;
    }
    if (hidden()) return;
    if (this.retry !== undefined) {
      if (set === this.set) return;
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    void this.read(list, set);
  }

  abort() {
    const ctl = this.ctl;
    this.ctl = undefined;
    ctl?.abort();
  }

  stop() {
    this.abort();
    clearTimeout(this.retry);
    this.retry = undefined;
    this.off?.();
    this.off = undefined;
  }

  private async read(list: Feed[], set: string) {
    this.turn += list.length;
    const ctl = new AbortController();
    this.ctl = ctl;
    this.set = set;
    const wait = list.some(firstRead) ? 0 : WAIT_MS;
    this.wait = wait;
    const refs = list.map(refOf);
    const generations = list.map((f) => f.generation);
    const timer = setTimeout(() => ctl.abort(), wait + READ_SLACK_MS);
    let tails: Tail[] | undefined;
    let status = 0;
    try {
      const r = await fetch(tailUrl(this.m, refs, wait), { signal: ctl.signal, cache: 'no-store' });
      status = r.status;
      if (r.ok) {
        const body = (await r.json()) as { tails?: unknown };
        if (Array.isArray(body?.tails)) tails = body.tails as Tail[];
      }
    } catch {
      // Failed, timed out, or given up (below).
    } finally {
      clearTimeout(timer);
    }
    // Given up for other sessions, or none shown any more.
    if (this.ctl !== ctl) return;
    this.ctl = undefined;
    // A reply the feeds cannot take counts as a failure, so that it is not
    // asked for again at once.
    let ok = !!tails;
    if (tails)
      list.forEach((f, i) => {
        if (f.generation === generations[i] && !take(f, tails[i], refs[i])) ok = false;
      });
    else for (const f of list) failed(f, status === 429);
    if (ok) {
      this.delay = 0;
      return this.consider();
    }
    this.delay = this.delay ? Math.min(this.delay * 2, RETRY_MAX_MS) : RETRY_MIN_MS;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.consider();
    }, this.delay);
  }
}

function pollerOf(m: string): Poller {
  let p = pollers.get(m);
  if (!p) {
    const poller = new Poller(m);
    pollers.set(m, (p = poller));
    // The machine's terminals are there again (the machine, its terminal
    // core or the connection to the core was away): its reads go on now.
    poller.off = terms.onTerminals(m, () => poller.wake());
  }
  if (!watching && typeof document !== 'undefined') {
    watching = true;
    // Shown again: each machine reads what it shows.
    document.addEventListener('visibilitychange', () => {
      if (!hidden()) for (const p of pollers.values()) p.wake();
    });
  }
  return p;
}

/** The feed of a session, made when the page has none. */
export function feedFor(m: string, kind: string, session: string): Feed {
  const key = feedKey(m, kind, session);
  let f = feeds.get(key);
  if (!f) {
    f = new Feed(m, kind, session);
    feeds.set(key, f);
    idle.push(key);
    evictSoon();
  }
  return f;
}

let evicting: ReturnType<typeof setTimeout> | undefined;

/** Evicts once the current task is done: a feed a surface made as it
 * rendered is held by then (hold, in its effect). */
function evictSoon() {
  if (evicting !== undefined) return;
  evicting = setTimeout(() => {
    evicting = undefined;
    evict();
  }, 0);
}

/** Keeps the newest few feeds no surface shows. */
function evict() {
  while (idle.length > IDLE_FEEDS) {
    const key = idle.shift()!;
    const f = feeds.get(key);
    if (!f || f.holders > 0) continue;
    feeds.delete(key);
    stopFirstTimer(f);
    for (const w of f.waiters) {
      clearTimeout(w.timer);
      w.reject(new SendError('unconfirmed'));
    }
    f.waiters = [];
    useFeeds.setState((s) => {
      const { [key]: _, ...rest } = s.status;
      return { status: rest };
    });
  }
}

/** A surface shows the feed: it is read while shown; returns a function
 * that lets go of it. */
export function hold(f: Feed): () => void {
  if (!feeds.has(f.key)) feeds.set(f.key, f);
  f.holders++;
  idle = idle.filter((k) => k !== f.key);
  startFirstTimer(f);
  publish(f);
  pollerOf(f.m).poke();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    f.holders--;
    if (f.holders === 0) {
      stopFirstTimer(f);
      idle.push(f.key);
      evictSoon();
    }
    pollerOf(f.m).poke();
  };
}

/** Reads the page before the feed's first event; resolves to whether there
 * are earlier ones still. */
async function readEarlier(f: Feed): Promise<boolean> {
  if (f.state !== 'ok' || f.first === undefined || !f.more) return false;
  const from = f.first;
  const generation = f.generation;
  const ref: Ref = { kind: f.kind, session: f.session, from, back: true };
  const r = await fetch(tailUrl(f.m, [ref], 0), { cache: 'no-store' });
  if (!r.ok) throw new Error(`http_${r.status}`);
  const body = (await r.json()) as { tails?: Tail[] };
  const tail = Array.isArray(body?.tails) ? body.tails[0] : undefined;
  // The feed started over or read earlier meanwhile.
  if (f.generation !== generation || f.first !== from) return f.more;
  if (!tail || tail.kind !== f.kind || tail.session !== f.session || typeof tail.first !== 'number') throw new Error('bad_reply');
  if (tail.code) throw new Error(typeof tail.code === 'string' ? tail.code : 'bad_reply');
  if (f.file !== undefined && typeof tail.file === 'string' && tail.file !== f.file) {
    // Another file: the feed starts over with its first read.
    reset(f);
    pollerOf(f.m).poke();
    return false;
  }
  const older = (Array.isArray(tail.events) ? tail.events : []).filter((ev) => typeof ev?.seq === 'number' && ev.seq < from);
  f.events = [...older, ...f.events];
  f.first = tail.first;
  f.more = !!tail.more;
  for (const ev of older) emit(f, ev);
  return f.more;
}

/** Waits for a message typed into the terminal to show in the transcript:
 * shown resolves once the user's prompt with its text is read (for a
 * command, a command's notice), and rejects after CONFIRM_MS or when the
 * wait is given up (drop). */
function confirm(f: Feed, text: string): { shown: Promise<void>; drop(code: SendCode): void } {
  let w!: Waiter;
  const compared = plain(text);
  // Most characters take a byte or two, none more than three.
  const long = text.length * 3 > MAX_TEXT_BYTES && new TextEncoder().encode(text).length > MAX_TEXT_BYTES;
  const shown = new Promise<void>((resolve, reject) => {
    w = {
      text: compared,
      head: compared.slice(0, PROMPT_HEAD),
      long,
      command: /^[/!]/.test(text.trimStart()),
      after: f.last,
      resolve,
      reject,
      timer: setTimeout(() => {
        settleWaiter(f, w);
        reject(new SendError('unconfirmed'));
      }, CONFIRM_MS),
    };
    f.waiters.push(w);
  });
  return {
    shown,
    drop(code) {
      settleWaiter(f, w);
      shown.catch(() => {});
      w.reject(new SendError(code));
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Why the user's text may not be typed into a terminal now, if it may not:
 * a read-only page; a terminal not on screen, or not running the agent of
 * kind (it left it, a shell would run the text as a command); the agent
 * waiting for an answer, which an Enter would give. */
function refusal(m: string, terminal: string, kind: string): SendCode | undefined {
  if (useStore.getState().readOnly) return 'read_only';
  const record = useTerms.getState().machines[m]?.terminals[terminal];
  if (nativeKind(record) !== kind) return 'detached';
  if (agentStatus(record) === 'blocked') return 'blocked';
  if (!paneHandle(m, terminal)) return 'detached';
  return undefined;
}

/** A session's conversation for the view over the terminal that runs it:
 * events from its feed; the user's messages typed into the terminal as a
 * paste and an Enter, as the user would. */
export class TranscriptSource implements AgentSource {
  constructor(
    readonly feed: Feed,
    readonly m: string,
    readonly terminal: string,
  ) {}

  get capabilities(): SourceCapabilities {
    return { input: useStore.getState().readOnly ? 'none' : 'terminal', permissions: false, streaming: false };
  }

  subscribe(fn: (ev: SourceEvent) => void): () => void {
    const f = this.feed;
    f.listeners.add(fn);
    for (const ev of f.events) fn(ev);
    return () => void f.listeners.delete(fn);
  }

  /** Offered while there are events before those read. */
  get loadEarlier(): (() => Promise<boolean>) | undefined {
    const f = this.feed;
    return f.more && f.first !== undefined ? () => readEarlier(f) : undefined;
  }

  /** Pastes the message into the terminal and presses Enter after
   * ENTER_DELAY_MS; resolves once the transcript has it as the user's
   * prompt (or a command's notice, for a command). Rejects at once when it
   * may not be typed into the terminal (refusal), and without the Enter
   * (pasted) when that holds after the pause. */
  async send(content: ContentBlock[]): Promise<void> {
    const { m, terminal, feed } = this;
    const text = blocksText(content).replace(/\s+$/, '');
    if (!text.trim()) throw new SendError('empty');
    const no = refusal(m, terminal, feed.kind);
    if (no) throw new SendError(no);
    const wait = confirm(feed, text);
    // Taken as one paste (bracketed, as the agents ask), so that its lines
    // do not send it; the Enter after it does.
    paneHandle(m, terminal)!.paste(text);
    await sleep(ENTER_DELAY_MS);
    // The same rule again: what changed during the pause would take the
    // Enter (a permission's default answer, a shell's command line).
    if (refusal(m, terminal, feed.kind)) {
      wait.drop('pasted');
      throw new SendError('pasted');
    }
    paneHandle(m, terminal)!.type('\r');
    return wait.shown;
  }

  /** Interrupts the agent's turn: Escape, the key both agents' interfaces
   * take for it. */
  cancel() {
    if (useStore.getState().readOnly) return;
    paneHandle(this.m, this.terminal)?.type('\x1b');
  }
}

/** The source of a feed for the view over a terminal: the same one each
 * time. */
export function sourceOf(f: Feed, terminal: string): TranscriptSource {
  let s = f.sources.get(terminal);
  if (!s) f.sources.set(terminal, (s = new TranscriptSource(f, f.m, terminal)));
  return s;
}

/** Forgets every feed and stops every read (tests). */
export function resetFeeds() {
  clearTimeout(evicting);
  evicting = undefined;
  for (const p of pollers.values()) p.stop();
  pollers.clear();
  for (const f of feeds.values()) {
    stopFirstTimer(f);
    for (const w of f.waiters) clearTimeout(w.timer);
  }
  feeds.clear();
  idle = [];
  useFeeds.setState({ status: {} });
}
