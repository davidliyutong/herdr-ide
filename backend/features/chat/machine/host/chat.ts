// A chat: one agent session in one directory. Its journal's row, its agent
// while one runs, the permissions and questions that wait, and the
// connections attached to it.
//
// Its events go to the journal (journal.ts, a worker thread) and reach its
// connections only once they are stored, in the order they were made: an
// event the journal refuses is told to nobody, and neither is anything the
// chat made after it (live increments too), so its log never has a hole and
// a client that attaches again from its last sequence number misses
// nothing. Until an event is stored, the chat's row as the clients see it
// (its seq, updated, turn end) is the one before it.
import { randomBytes, randomUUID } from 'node:crypto';
import { Notice, noticeMethod } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import type { Logger } from '#shared/lib/log.ts';
import type { PermissionAnswer, PermissionRequest, QuestionAnswer, QuestionRequest, Session, Sink, StartParams } from '../adapter.ts';
import { agentEnv, lookPath } from './env.ts';
import {
  AGENT_TITLE_RUNES,
  capStderr,
  checkAnswers,
  checkContent,
  clip,
  fit,
  hasStderr,
  isWellFormed,
  lineOf,
  masked,
  promptTitle,
} from './events.ts';
import type { Host } from './host.ts';
import { msOf, timeOf, type Row } from './journal.ts';
import type { Subscriber } from './subscriber.ts';

/** The most bytes of the JSON of each of what an adapter states of a chat
 * (its configuration options, slash commands, usage): with it, the list of
 * all chats fits a line, and the journal's rows stay small. */
export const STATE_BYTES = 64 << 10;
/** The most queued messages a chat follows (the adapters queue far fewer). */
const MAX_QUEUED = 256;
/** The permissions and questions that may wait in a chat; an agent that
 * asks more is answered that they were cancelled. */
export const MAX_PENDING = 64;
/** How often attaching brings what a handed off session did in a terminal
 * into the log (it may run the agent to ask). */
const CATCH_UP_MS = 10_000;
/** How many of a chat's last prompts a prompt with the page's id of one of
 * them is known by: it was taken already, and is not sent again. */
export const MAX_CLIENT_IDS = 256;
/** The most bytes of events a host's journal may have waiting: past it a
 * chat whose event comes fails (the journal does not keep up). */
export const MAX_BACKLOG = 64 << 20;

/** The form of an agent's session id the host takes: what the agents make
 * (UUIDs, their own ids), and nothing that could read as more than one
 * argument or an option. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Whether s may be a value of a chat's Options. */
export function validOption(s: string): boolean {
  return Buffer.byteLength(s) <= 256 && isWellFormed(s) && !/[\u0000-\u001f\u007f]/.test(s);
}

export const perr = (code: string, message: string): chat.ChatError => ({ code, message });
const refuse = (code: string, message: string) => new chat.ChatProtoError(perr(code, message));

/** What waits when the chat's agent ends. */
const errEnded = () => perr(chat.Code.Ended, "the chat's agent ended");

/** A new random id with a prefix: of a permission, a question, a queued
 * message. */
export const newID = (prefix: string): string => prefix + randomBytes(8).toString('hex');

/** Now, as the host keeps times: ms since the epoch. */
export const now = (): number => Date.now();

/** The protocol's error for what an adapter threw: its own when it is one,
 * else failed; a call that signal ended is the end it stands for. */
export function errorOf(e: unknown, signal?: AbortSignal): chat.ChatError {
  if (e instanceof chat.ChatProtoError) return capStderr({ ...e.error });
  if (signal?.aborted) {
    const r = signal.reason as { name?: string } | undefined;
    if (r?.name === 'TimeoutError') return perr(chat.Code.Failed, 'the agent did not answer in time');
    return perr(chat.Code.Ended, 'the chat ended');
  }
  const name = (e as { name?: string } | null)?.name;
  if (name === 'TimeoutError') return perr(chat.Code.Failed, 'the agent did not answer in time');
  if (name === 'AbortError') return perr(chat.Code.Ended, 'the chat ended');
  return perr(chat.Code.Failed, e instanceof Error ? e.message : String(e));
}

/** The mode option of a chat's configuration; undefined for none. */
export const modeOption = (config: readonly chat.ConfigOption[] | undefined): chat.ConfigOption | undefined =>
  config?.find((o) => o.category === chat.Category.Mode);

/** Whether mode gives the agent full access: full, or a value of the
 * chat's mode option its adapter marked full. */
export function fullMode(config: readonly chat.ConfigOption[] | undefined, mode: string): boolean {
  if (mode === chat.Mode.Full) return true;
  for (const o of config ?? []) {
    if (o.category !== chat.Category.Mode) continue;
    if ((o.options ?? []).some((v) => v.value === mode && v.full)) return true;
  }
  return false;
}

/** The value of a mode option that takes an agent out of a full access it
 * took by itself: the mode it had before (prev), the chat's mode (want),
 * the default mode, or the first of its values that gives no full access;
 * "" when it has none. */
export function safeMode(o: chat.ConfigOption, prev: string, want: string): string {
  const ok = (v: string) => v !== '' && v !== chat.Mode.Full && (o.options ?? []).some((x) => x.value === v && !x.full);
  for (const v of [prev, want, chat.Mode.Default, 'ask']) if (ok(v)) return v;
  for (const x of o.options ?? []) if (ok(x.value)) return x.value;
  return '';
}

/** Whether v's JSON is at most STATE_BYTES. */
function fits(v: unknown): boolean {
  const l = lineOf(v);
  return l !== null && Buffer.byteLength(l) <= STATE_BYTES;
}

/** The ways of history. */
export const Way = {
  /** The session's whole conversation (a new chat's import). */
  ImportAll: 0,
  /** What the session did in a terminal after the log's last item, as the
   * chat's agent starts. */
  CatchUpStart: 1,
  /** The same for an attach, while no agent runs or starts. */
  CatchUpAttach: 2,
} as const;
export type Way = (typeof Way)[keyof typeof Way];

/** A start of a chat's agent. */
interface Start {
  gen: number;
  abort: AbortController;
  done: Promise<void>;
  resolve: () => void;
  err?: chat.ChatError;
}

/** How a permission or a question was answered: the user's answer,
 * cancelled, or an error when the chat's agent ended. */
interface Answer {
  perm: PermissionAnswer;
  q: QuestionAnswer;
  err?: chat.ChatError;
}

/** A permission or a question that waits for the user. */
interface Pending {
  n: number;
  id: string;
  question: boolean;
  /** A permission's optionIds. */
  options: string[];
  /** A question's. */
  questions: chat.Question[];
  resolve: (a: Answer) => void;
}

const cancelled = (err?: chat.ChatError): Answer => ({ perm: { cancelled: true }, q: { cancelled: true }, ...(err ? { err } : {}) });

/** An entry of the chat's way to its connections: a line, and for a stored
 * event its sequence number until the journal took it. */
interface Out {
  line: string;
  seq?: number;
  done: boolean;
  epoch: number;
}

/** What the chat's row says of its last event: as stored, and as made. */
interface Mark {
  seq: number;
  historyAfter: string;
  turnEnd: number;
}

/** What an emit did: whether the event is stored as it is (its strings cut,
 * maybe), false when it was left out, replaced by a notice that it was too
 * large, or not stored at all; and once the journal answered, whether it
 * was stored. */
export interface Emitted {
  asIs: boolean;
  stored: Promise<boolean>;
}

const NOT: Emitted = { asIs: false, stored: Promise.resolve(false) };

/** Orders what waits, the oldest first. */
let pendingCount = 0;

export class Chat {
  readonly h: Host;
  /** The row as stored: its seq, updated, turnEnd, historyAfter and bytes
   * are of the last event the journal took. */
  r: Row;
  /** The state while no agent runs or starts: sleeping, closed or failed. */
  rest = '';
  /** The lowest sequence number still stored; r's seq + 1 when none is. */
  first = 1;
  subs = new Set<Subscriber>();
  deleted = false;
  /** The host stopped: nothing more is stored. */
  stopped = false;
  /** The journal did not take an event of the chat, which fails; cleared
   * once it takes one again. */
  brokenLog = false;

  sess: Session | null = null;
  /** Numbers the chat's agents: a session or a start of an earlier one is
   * no longer heard. */
  gen = 0;
  starting = false;
  start: Start | null = null;
  /** A prompt waits for the start. */
  held = false;
  /** A turn runs. */
  turn = false;
  pending = new Map<string, Pending>();
  /** The messages the adapter queued and did not tell taken or cancelled. */
  queued = new Set<string>();
  /** A turn ended while some waited, and the next turn, which takes them,
   * is to start: the chat works meanwhile (until nextTimer gives up). */
  next = false;
  nextTaken = false;
  private nextTimer: ReturnType<typeof setTimeout> | null = null;

  idleSince = 0;
  idleTimer: ReturnType<typeof setTimeout> | null = null;
  infoDirty = false;
  infoTimer: ReturnType<typeof setTimeout> | null = null;
  private lastState: chat.ChatState | null = null;
  private readonly dropped = new Set<string>();

  /** One history of the session at a time. */
  private catching: Promise<void> | null = null;
  private caughtUp = 0;

  /** The page's ids of the chat's last prompts its log has, the oldest
   * first; storing: those of the prompts whose events are on their way to
   * the journal (how many of each); sending: the prompts being taken, by
   * the page's id. */
  private readonly clients = new Set<string>();
  private readonly clientOrder: string[] = [];
  private readonly storing = new Map<string, number>();
  private readonly sending = new Map<string, Promise<chat.ChatError | undefined>>();

  /** The value of the chat's mode option its agent stated last, the agent
   * (gen) that stated it; denying: an agent of gen being taken out of a
   * full access it took by itself. */
  private mode = '';
  private modeGen = 0;
  private denying = 0;
  /** The agent (gen) whose start told that it runs without the project's
   * own settings. */
  private untrustedGen = 0;

  /** The chat's way to its connections, in the order events were made. */
  private flow: Out[] = [];
  private epoch = 0;
  /** The last event made (stored or on its way). */
  private made: Mark;
  private trimming = false;

  constructor(h: Host, r: Row) {
    this.h = h;
    this.r = r;
    this.made = { seq: r.chat.seq, historyAfter: r.historyAfter, turnEnd: r.turnEnd };
  }

  get id(): string {
    return this.r.chat.id;
  }

  /** The sequence number of the last event made, stored or on its way:
   * what counts as seen when the host puts what the chat did away. */
  madeSeq(): number {
    return this.made.seq;
  }

  private get log(): Logger {
    return this.h.logger;
  }

  private logf(line: string): void {
    this.log(`chat ${this.id}: ${line}`);
  }

  /** Notes the page's id of a prompt the log has now. */
  tookClient(id: string | undefined): void {
    if (!id || this.clients.has(id)) return;
    this.clients.add(id);
    this.clientOrder.push(id);
    if (this.clientOrder.length > MAX_CLIENT_IDS) this.clients.delete(this.clientOrder.shift()!);
  }

  /** The journal took or refused an event of the page's prompt id. */
  private storedClient(id: string | undefined): void {
    if (!id) return;
    const n = (this.storing.get(id) ?? 0) - 1;
    if (n > 0) this.storing.set(id, n);
    else this.storing.delete(id);
  }

  /** The chat as it is now. */
  snapshot(): chat.Chat {
    const c = this.r.chat;
    c.status = chat.statusOf(c.state, this.r.turnEnd, c.seen);
    const s: chat.Chat = { ...c, capabilities: { ...c.capabilities } };
    if (c.config) s.config = c.config.map((o) => ({ ...o, options: o.options ? o.options.map((v) => ({ ...v })) : o.options }));
    if (c.commands) s.commands = c.commands.map((x) => ({ ...x }));
    if (c.usage) s.usage = { ...c.usage, ...(c.usage.limits ? { limits: c.usage.limits.map((l) => ({ ...l })) } : {}) };
    if (c.error) s.error = { ...c.error };
    return s;
  }

  /** The journal's row of the chat. */
  row(): Row {
    return { ...this.r, chat: this.snapshot(), options: { ...this.r.options } };
  }

  /** Stores the chat's row (its members that are not its events'). */
  save(): void {
    if (this.deleted || this.stopped) return;
    this.h.journal.saveChat(this.row()).catch((e: Error) => this.logf(`save: ${e.message}`));
  }

  /** Tells the watchers the chat's state when it changed. */
  notify(): void {
    if (this.deleted) return;
    const st = chat.stateOf(this.snapshot());
    const last = this.lastState;
    if (last && JSON.stringify({ ...last, seq: st.seq, updated: st.updated }) === JSON.stringify(st)) return;
    this.lastState = st;
    this.h.broadcast(st);
  }

  /** The state the watchers were told last (load sets it). */
  setLastState(st: chat.ChatState): void {
    this.lastState = st;
  }

  /** Stores an event, numbered, and hands it to the attached connections
   * once the journal took it; one that fell too far behind is disconnected.
   * An event the journal does not take is told to nobody, nor is anything
   * made after it, and fails the chat (journalFailed). The agent's standard
   * error of an event's error (and of an info's chat's) goes to the
   * connections attached then, never into the journal. */
  emit(ev: chat.Event): Emitted {
    if (this.deleted || this.stopped) return NOT;
    const t = now();
    const seq = this.made.seq + 1;
    const e: chat.Event = { ...ev, seq };
    delete e.live;
    if (!e.at) e.at = timeOf(t);
    if (e.error) e.error = capStderr(e.error);
    if (e.t === chat.EventType.Info) {
      const c = this.snapshot();
      c.seq = seq;
      c.updated = timeOf(t);
      if (c.error) c.error = capStderr(c.error);
      e.chat = c;
    }
    const f = fit(chat.redactedEvent(e));
    if (!f) {
      this.logf(`an event ${e.t} that is no JSON was left out`);
      return NOT;
    }
    if (this.h.journal.backlog > MAX_BACKLOG) {
      this.journalFailed(new Error('the journal does not keep up'));
      return NOT;
    }
    const st = f.ev;
    const prev = this.made;
    const mark: Mark = {
      seq,
      historyAfter: st.item && !st.parent ? st.item : prev.historyAfter,
      turnEnd: st.t === chat.EventType.Turn && (st.state === chat.TurnState.End || st.state === chat.TurnState.Error) ? seq : prev.turnEnd,
    };
    this.made = mark;
    let out = f.line;
    if (st.t === e.t && hasStderr(e)) {
      const l = lineOf(e);
      if (l !== null && Buffer.byteLength(l) <= chat.MAX_LINE) out = l;
    }
    const o: Out = { line: out + '\n', seq, done: false, epoch: this.epoch };
    this.flow.push(o);
    const n = Buffer.byteLength(f.line);
    const client = st.t === chat.EventType.User || st.t === chat.EventType.Queued ? st.clientId : undefined;
    // A prompt whose event is on its way is one the host took: its answer
    // may reach the page before the journal took the event.
    if (client) this.storing.set(client, (this.storing.get(client) ?? 0) + 1);
    const stored = this.h.journal
      .appendEvent(
        this.id,
        prev.seq,
        { seq, t: st.t, item: st.item ?? '', at: msOf(st.at) || t, line: f.line },
        { updated: t, turnEnd: mark.turnEnd, historyAfter: mark.historyAfter, fresh: this.r.fresh },
      )
      .then(
        () => {
          this.stored(o, mark, t, n, client);
          return true;
        },
        (err: Error) => {
          this.refused(o, err);
          return false;
        },
      )
      .finally(() => this.storedClient(client));
    return { asIs: st.t === e.t, stored };
  }

  /** The journal took the event of o. */
  private stored(o: Out, mark: Mark, at: number, n: number, client: string | undefined): void {
    o.done = true;
    const turnEnd = this.r.turnEnd;
    this.r.chat.seq = mark.seq;
    this.r.chat.updated = timeOf(at);
    this.r.historyAfter = mark.historyAfter;
    this.r.turnEnd = mark.turnEnd;
    this.r.bytes += n;
    this.brokenLog = false;
    this.tookClient(client);
    this.pump();
    if (this.r.turnEnd !== turnEnd) this.notify();
    this.h.wrote(n);
    const max = this.h.settings().maxChatBytes;
    if (this.r.bytes > max) void this.trim(max - Math.floor(max / 8));
  }

  /** The journal refused the event of o: nothing made after it reaches a
   * connection, the chat goes on from its last stored event, and fails. */
  private refused(o: Out, err: Error): void {
    if (o.epoch !== this.epoch) return;
    this.epoch++;
    const i = this.flow.indexOf(o);
    if (i >= 0) this.flow.splice(i);
    this.made = { seq: this.r.chat.seq, historyAfter: this.r.historyAfter, turnEnd: this.r.turnEnd };
    this.logf(`store event ${o.seq}: ${err.message}`);
    this.journalFailed(err);
  }

  /** Hands what is ready of the chat's way to its connections: up to the
   * first stored event the journal has not taken yet. */
  private pump(): void {
    while (this.flow.length > 0) {
      const o = this.flow[0]!;
      if (o.seq !== undefined && !o.done) return;
      this.flow.shift();
      this.fanOut(o.line);
    }
  }

  /** Fails the chat whose event the journal did not take: its agent ends,
   * and what comes is not stored in a log with a hole. A prompt starts the
   * chat again, once the journal takes events. */
  journalFailed(err: Error): void {
    if (this.brokenLog || this.stopped) return;
    this.brokenLog = true;
    const e = perr(chat.Code.Failed, "the chat's log could not be written: " + err.message);
    // Not in the middle of the change that made the event.
    setTimeout(() => {
      if (this.deleted || this.stopped) return;
      this.logf(`failed: ${e.message}`);
      const sess = this.stopAgent(chat.State.Failed, e, e);
      this.notify();
      void this.h.endSession(sess, false);
      this.h.pokeQuiet();
    }, 0);
  }

  /** Hands a streaming increment to the attached connections. */
  live(ev: chat.Event): void {
    if (this.deleted || this.subs.size === 0) return;
    const e: chat.Event = { ...ev, live: true };
    delete e.seq;
    let l: string;
    try {
      l = chat.line(e);
    } catch {
      return;
    }
    if (Buffer.byteLength(l) > chat.MAX_LINE + 1) return;
    this.flow.push({ line: l, done: true, epoch: this.epoch });
    this.pump();
  }

  private fanOut(line: string): void {
    for (const s of this.subs) {
      if (!s.push(line)) {
        this.logf('a connection fell behind and was closed');
        this.subs.delete(s);
      }
    }
  }

  /** Drops the chat's oldest events until they take at most keep bytes. */
  async trim(keep: number): Promise<void> {
    if (this.trimming) return;
    this.trimming = true;
    try {
      while (this.r.bytes > keep && !this.deleted) {
        const { deleted, done } = await this.h.journal.trimStep(this.id, this.r.bytes - keep);
        this.r.bytes = Math.max(this.r.bytes - deleted, 0);
        if (done) break;
      }
      if (this.deleted) return;
      const first = await this.h.journal.first(this.id);
      this.first = first === 0 ? this.r.chat.seq + 1 : first;
    } catch (e) {
      this.logf(`trim: ${(e as Error).message}`);
    } finally {
      this.trimming = false;
    }
  }

  /** Changes the chat's state and says so. */
  setState(state: string): void {
    if (this.r.chat.state === state || this.deleted) return;
    this.r.chat.state = state;
    if (state !== chat.State.Failed) delete this.r.chat.error;
    const ev: chat.Event = { t: chat.EventType.State, state };
    if (state === chat.State.Failed && this.r.chat.error) ev.error = this.r.chat.error;
    if (state === chat.State.Idle) this.idleSince = now();
    this.emit(ev);
    this.armIdle();
    this.save();
    this.notify();
    this.h.pokeQuiet();
  }

  /** Gives the chat the state its agent, turn and what waits make. */
  settle(): void {
    let state = this.rest;
    if (this.starting) state = chat.State.Starting;
    else if (this.sess && this.pending.size > 0) state = chat.State.Waiting;
    else if (this.sess && (this.turn || this.next)) state = chat.State.Working;
    else if (this.sess) state = chat.State.Idle;
    this.setState(state || chat.State.Sleeping);
  }

  /** Whether a turn runs, is to start with what was queued, or waits for
   * the user. */
  busy(): boolean {
    return this.turn || this.next || this.pending.size > 0;
  }

  /** Has the chat work between the end of a turn and the start of the next
   * one, which takes the messages queued meanwhile: no idle stop, no room
   * made of it, no handoff. An adapter that does not start it within the
   * host's call timeout is not waited for any longer. */
  private awaitNext(): void {
    this.endNext();
    if (this.queued.size === 0 || !this.sess) return;
    this.next = true;
    const gen = this.gen;
    this.nextTimer = setTimeout(() => {
      if (this.gen !== gen || !this.next || this.deleted) return;
      this.logf(`no turn took the ${this.queued.size} queued messages`);
      this.endNext();
      this.settle();
      this.notify();
    }, this.h.o.callTimeout);
  }

  /** Stops waiting for the next turn; the caller settles the state. */
  private endNext(): void {
    this.next = false;
    this.nextTaken = false;
    if (this.nextTimer) clearTimeout(this.nextTimer);
    this.nextTimer = null;
  }

  /** Has an idle chat's agent ended once the chat was idle for the
   * settings' idleStopMinutes. */
  armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.deleted || !this.sess || this.r.chat.state !== chat.State.Idle) return;
    const minutes = this.h.settings().idleStopMinutes;
    const wait = Math.max(minutes * this.h.o.minute - (now() - this.idleSince), 0);
    const gen = this.gen;
    const since = this.idleSince;
    this.idleTimer = setTimeout(() => {
      if (this.gen !== gen || !this.sess || this.r.chat.state !== chat.State.Idle || this.idleSince !== since) return;
      this.logf(`its agent stopped, idle for ${this.h.settings().idleStopMinutes} minutes`);
      const sess = this.stopAgent(chat.State.Sleeping);
      void this.h.endSession(sess, false);
    }, wait);
  }

  /** Stores the chat as it is now (an info event) and its row. */
  emitInfo(): void {
    this.infoDirty = false;
    if (this.infoTimer) clearTimeout(this.infoTimer);
    this.infoTimer = null;
    this.emit({ t: chat.EventType.Info });
    this.save();
    this.notify();
  }

  /** Makes a chat whose agent ran when the last host ended sleep: the
   * permissions and questions that waited are cancelled, its turn ended in
   * an error. */
  async recover(): Promise<void> {
    let evs: chat.Event[] = [];
    try {
      evs = await this.h.journal.eventsOf(
        this.id,
        chat.EventType.Permission,
        chat.EventType.Question,
        chat.EventType.PermissionDone,
        chat.EventType.QuestionDone,
      );
    } catch (e) {
      this.logf(`recover: ${(e as Error).message}`);
    }
    const open = new Map<string, string>();
    for (const ev of evs) {
      if (!ev.id) continue;
      if (ev.t === chat.EventType.Permission || ev.t === chat.EventType.Question) open.set(ev.id, ev.t);
      else open.delete(ev.id);
    }
    for (const [id, t] of open) {
      if (t === chat.EventType.Permission)
        this.emit({
          t: chat.EventType.PermissionDone,
          id,
          by: chat.By.Ended,
          outcome: { outcome: chat.OutcomeKind.Cancelled },
        });
      else this.emit({ t: chat.EventType.QuestionDone, id, by: chat.By.Ended });
    }
    const state = this.r.chat.state;
    if (state === chat.State.Working || state === chat.State.Waiting)
      this.emit({ t: chat.EventType.Turn, state: chat.TurnState.Error, error: perr(chat.Code.Ended, 'the chat host ended') });
    this.rest = chat.State.Sleeping;
    if (this.r.chat.sessionId === '') {
      this.rest = chat.State.Failed;
      this.r.chat.error = perr(chat.Code.Ended, 'the chat host ended before the session existed');
    }
    this.settle();
  }

  /** Marks the chat as starting an agent, and returns the start. */
  beginStart(): Start {
    // A chat the user uses again is archived no more.
    delete this.r.chat.archived;
    this.gen++;
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const st: Start = { gen: this.gen, abort: new AbortController(), done, resolve };
    this.starting = true;
    this.start = st;
    this.settle();
    return st;
  }

  /** Lets go of the chat's agent, or of its start: what waits is cancelled,
   * a running turn ends in turnErr, and the chat is in rest (with e for a
   * failed chat). Returns the session for the caller to end
   * (Host.endSession). */
  stopAgent(rest: string, e?: chat.ChatError, turnErr?: chat.ChatError): Session | null {
    e = capStderr(e);
    turnErr = capStderr(turnErr);
    this.gen++;
    if (this.start) {
      this.start.abort.abort();
      this.start = null;
    }
    this.starting = false;
    this.endNext();
    this.queued.clear();
    this.cancelPending(chat.By.Ended, errEnded());
    if (this.turn) {
      this.turn = false;
      this.emit({ t: chat.EventType.Turn, state: chat.TurnState.Error, error: turnErr ?? errEnded() });
    }
    const sess = this.sess;
    this.sess = null;
    this.rest = rest;
    if (rest === chat.State.Failed) {
      if (e) this.r.chat.error = e;
      else delete this.r.chat.error;
      if (this.r.chat.state === chat.State.Failed) {
        // Failed again: the state is the same, the error is told.
        this.emit({ t: chat.EventType.State, state: chat.State.Failed, ...(e ? { error: e } : {}) });
        this.save();
      }
    }
    this.settle();
    return sess;
  }

  /** Starts the chat's agent, a new session or resume's, and settles when
   * the chat's agent runs or the start failed. */
  async launch(st: Start, resume: string): Promise<void> {
    try {
      const r = await this.startAgent(st, resume);
      const sess = 'sess' in r ? r.sess : null;
      let e = 'err' in r ? capStderr(r.err) : undefined;
      if (this.gen !== st.gen || this.deleted) {
        st.err = perr(chat.Code.Ended, "the chat's start was cancelled");
        // A host that stops waits for it: the agent does not outlive the
        // host.
        if (sess) await this.h.endLate(sess);
        return;
      }
      st.abort.abort();
      this.starting = false;
      this.start = null;
      if (!sess) {
        e ??= perr(chat.Code.StartFailed, 'the adapter made no session');
        st.err = e;
        this.logf(`did not start: ${chat.errorText(e)}`);
        this.rest = chat.State.Failed;
        this.r.chat.error = e;
        if (this.r.chat.state === chat.State.Failed) this.emit({ t: chat.EventType.State, state: chat.State.Failed, error: e });
        this.settle();
        this.save();
        this.notify();
        this.h.pokeQuiet();
        return;
      }
      this.sess = sess;
      const id = sess.id;
      if (id !== '' && SESSION_ID.test(id)) this.r.chat.sessionId = id;
      if (this.untrustedGen !== st.gen)
        // It started in a trusted folder: the next start without the
        // project's settings is told again.
        this.r.untrustedTold = false;
      delete this.r.chat.handedOff;
      delete this.r.chat.closed;
      delete this.r.chat.error;
      this.rest = chat.State.Sleeping;
      this.emitInfo();
      this.settle();
      const gen = this.gen;
      this.h.track(this.watchSession(sess, gen));
      this.h.pokeQuiet();
    } finally {
      st.resolve();
    }
  }

  /** Resolves the chat's agent and has its adapter start it. */
  private async startAgent(st: Start, resume: string): Promise<{ sess: Session } | { err: chat.ChatError }> {
    const h = this.h;
    const { kind, cwd, id, config } = this.r.chat;
    const opts: chat.Options = { ...this.r.options };
    const found = h.spec(kind);
    if ('code' in found) return { err: found };
    const bad = await h.checkCwd(cwd);
    if (bad) return { err: bad };
    const signal = AbortSignal.any([st.abort.signal, AbortSignal.timeout(h.o.startTimeout)]);
    const env = agentEnv(await h.env(signal), found.spec.env, cwd);
    const path = await lookPath(found.spec.argv[0]!, env);
    if (!path) return { err: perr(chat.Code.NotFound, `${found.spec.argv[0]} is not in the user's PATH`) };
    if (!h.makeRoom(this)) return { err: perr(chat.Code.TooMany, 'as many agents as the settings allow work, wait or start') };
    const settings = h.settings();
    if (!opts.mode) opts.mode = settings.defaultMode;
    if (!settings.allowFull && fullMode(config, opts.mode)) {
      this.fullAccessOff(st, opts.mode);
      opts.mode = chat.Mode.Default;
    }
    const p: StartParams = {
      kind,
      argv: [path, ...found.spec.argv.slice(1)],
      env,
      cwd,
      resume,
      sessionId: resume === '' ? randomUUID() : '',
      ...(found.spec.newSessionMeta ? { newSessionMeta: found.spec.newSessionMeta } : {}),
      options: opts,
      trusted: await h.trusted(cwd),
      client: h.client,
      settings,
      procs: h.procs,
      logger: (l) => h.logger(`chat ${id}: ${l}`),
    };
    try {
      const sess = await found.adapter.start(p, this.sink(st.gen), signal);
      if (!sess) return { err: perr(chat.Code.StartFailed, 'the adapter made no session') };
      return { sess };
    } catch (e) {
      if (signal.aborted && !st.abort.signal.aborted) return { err: perr(chat.Code.StartFailed, 'the agent did not start in time') };
      return { err: errorOf(e, signal) };
    }
  }

  /** Takes full access from a chat whose agent starts while the settings no
   * longer allow it: its mode is the default from now on, which a notice
   * tells. */
  private fullAccessOff(st: Start, mode: string): void {
    if (this.gen !== st.gen || this.deleted) return;
    this.logf('full access is not allowed: it starts in the default mode');
    this.r.options.mode = chat.Mode.Default;
    this.emit({ t: chat.EventType.Notice, method: noticeMethod(Notice.FullAccessOff), params: { mode } });
    this.save();
  }

  /** Ends the agent of a chat that runs or starts in a mode of full access
   * the settings no longer allow, and starts it again, its session resumed,
   * in the default mode, which the notice full_access_off tells. Returns the
   * session for the caller to end. */
  revokeFull(): Session | null {
    if (this.deleted || this.stopped || (!this.sess && !this.starting)) return null;
    let full = this.r.options.mode ?? '';
    if (!fullMode(this.r.chat.config, full)) {
      full = '';
      const o = modeOption(this.r.chat.config);
      if (o && fullMode(this.r.chat.config, o.currentValue)) full = o.currentValue;
    }
    if (full === '') return null;
    this.logf('full access was turned off: its agent starts again in the default mode');
    const sess = this.stopAgent(chat.State.Sleeping, undefined, perr(chat.Code.NotAllowed, 'full access was turned off'));
    this.r.options.mode = chat.Mode.Default;
    this.emit({ t: chat.EventType.Notice, method: noticeMethod(Notice.FullAccessOff), params: { mode: full } });
    this.save();
    if (!this.h.stopping) {
      const st = this.beginStart();
      const session = this.r.fresh ? '' : this.r.chat.sessionId;
      this.h.track(this.launch(st, session));
    }
    this.notify();
    return sess;
  }

  /** Waits for the end of a session: one the host did not end leaves the
   * chat failed (its error) or, ended without one, sleeping. */
  private async watchSession(sess: Session, gen: number): Promise<void> {
    const err = await sess.done;
    if (this.gen !== gen || this.sess !== sess) return;
    const rest = err ? chat.State.Failed : chat.State.Sleeping;
    const e = err ? capStderr(err) : undefined;
    this.logf(`its agent ended (${e ? chat.errorText(chat.withoutStderr(e)) : 'no error'})`);
    this.stopAgent(rest, e, perr(chat.Code.Ended, 'the agent ended'));
    this.h.pokeQuiet();
  }

  /** Brings a session's conversation from its adapter into the log: all of
   * it, or for a catch-up what came after the log's last item. A catch-up of
   * a chat no longer handed off, or one of an attach while an agent runs or
   * starts, brings nothing. What it brings counts as seen. A failure is
   * stored as an error notice, but for a catch-up that finds no such item
   * or session (not_found): the session goes on without it, and the host
   * logs why. The caller holds the chat's history turn (catch). */
  private async history(signal: AbortSignal, session: string, way: Way): Promise<void> {
    const h = this.h;
    const { kind, cwd } = this.r.chat;
    let after = '';
    if (way !== Way.ImportAll) {
      after = this.r.historyAfter;
      if (!this.r.chat.handedOff || this.deleted || this.sess || (way === Way.CatchUpAttach && this.starting)) return;
    }
    const found = h.spec(kind);
    if ('code' in found) return;
    const sig = AbortSignal.any([signal, AbortSignal.timeout(h.o.startTimeout)]);
    const env = agentEnv(await h.env(sig), found.spec.env, cwd);
    // None for an agent not in the PATH: an adapter that reads files needs
    // none.
    const path = await lookPath(found.spec.argv[0]!, env);
    const argv = path ? [path, ...found.spec.argv.slice(1)] : [];
    let n = 0;
    let err: chat.ChatError | undefined;
    try {
      await found.adapter.history(
        { kind, argv, env, cwd, sessionId: session, after, procs: h.procs, logger: h.logger },
        (ev) => {
          if (ev.live) return;
          switch (ev.t) {
            case chat.EventType.Info:
              if (way === Way.ImportAll && ev.chat && this.importTitle(sig, ev.chat.title)) n++;
              return;
            case chat.EventType.Ack:
            case chat.EventType.State:
              return;
          }
          if (this.deleted || sig.aborted) return;
          this.emit(ev);
          this.r.chat.seen = this.made.seq;
          n++;
        },
        sig,
      );
    } catch (e) {
      err = errorOf(e, sig);
    }
    if (err && !this.deleted) {
      if (way !== Way.ImportAll && err.code === chat.Code.NotFound) {
        h.logger(`chat ${this.id}: no catch-up of ${session} after ${clip(after, 64)}: ${chat.errorText(err)}`);
        if (n > 0) {
          this.save();
          this.notify();
        }
        return;
      }
      this.logf(`history of ${session}: ${chat.errorText(err)}`);
      this.emit({ t: chat.EventType.Notice, method: noticeMethod(Notice.Error), params: { message: err.message, code: err.code } });
      this.r.chat.seen = this.made.seq;
    }
    if (n > 0 || err) {
      this.save();
      this.notify();
    }
  }

  /** Runs f as the chat's one history at a time: a catch-up never brings
   * in what an earlier one brought. */
  async withHistory(f: () => Promise<void>): Promise<void> {
    while (this.catching) await this.catching;
    const p = f().catch((e: Error) => this.logf(`history: ${e.message}`));
    this.catching = p;
    try {
      await p;
    } finally {
      if (this.catching === p) this.catching = null;
    }
  }

  /** A new chat's import: the session's whole conversation, then its agent. */
  async importAndLaunch(st: Start, resume: string, imports: boolean): Promise<void> {
    if (imports) await this.withHistory(() => this.history(st.abort.signal, resume, Way.ImportAll));
    await this.launch(st, resume);
  }

  /** Takes the title an import's adapter stated of the session as the
   * chat's, unless the user named the chat here; the clients are told at
   * once, with an info event that counts as seen. */
  private importTitle(signal: AbortSignal, title: string): boolean {
    title = clip(title ?? '', AGENT_TITLE_RUNES).trim();
    if (title === '' || title === this.r.chat.title || this.r.renamed || this.deleted || signal.aborted) return false;
    this.r.chat.title = title;
    this.emitInfo();
    this.r.chat.seen = this.made.seq;
    return true;
  }

  /** Brings what a handed off chat's session did in a terminal into the
   * log, unless that runs already or ran less than CATCH_UP_MS ago. */
  catchUpLater(): void {
    const ok =
      this.r.chat.handedOff &&
      !this.sess &&
      !this.starting &&
      !this.deleted &&
      this.r.chat.sessionId !== '' &&
      now() - this.caughtUp >= CATCH_UP_MS;
    if (!ok || this.catching) return;
    this.caughtUp = now();
    const session = this.r.chat.sessionId;
    this.h.track(this.withHistory(() => this.history(this.h.signal, session, Way.CatchUpAttach)));
  }

  /** Attaches a connection: its head is the answer, then the stored events
   * after from, then every event from now on. False for a chat that is no
   * more. */
  subscribe(s: Subscriber, from: number): boolean {
    if (this.deleted) return false;
    let head: string;
    try {
      head = chat.line({ ok: true, chat: this.snapshot(), first: this.first });
    } catch {
      return false;
    }
    s.head = [head];
    if (from < this.r.chat.seq) s.replay = { chat: this.id, after: from, upTo: this.r.chat.seq };
    this.subs.add(s);
    return true;
  }

  unsubscribe(s: Subscriber): void {
    this.subs.delete(s);
  }

  /** The chat's running session, or why a command that needs one is
   * refused. */
  private agent(): Session {
    if (this.deleted) throw refuse(chat.Code.UnknownChat, 'no such chat');
    if (this.starting) throw refuse(chat.Code.Busy, 'the chat is starting');
    if (!this.sess && this.r.chat.handedOff) throw refuse(chat.Code.HandedOff, 'the session went on in a terminal');
    if (!this.sess) throw refuse(chat.Code.Sleeping, "the chat's agent does not run");
    return this.sess;
  }

  /** Runs a call of the agent with the host's call timeout. */
  private async call(f: (signal: AbortSignal) => Promise<void>): Promise<chat.ChatError | undefined> {
    const signal = AbortSignal.any([this.h.signal, AbortSignal.timeout(this.h.o.callTimeout)]);
    try {
      await f(signal);
      return undefined;
    } catch (e) {
      return errorOf(e, signal);
    }
  }

  /** Takes a message of the user: a new turn on an idle chat, after the
   * agent's start on a chat that has none (its session resumed, and what it
   * did in a terminal brought in first), else queued for the agent. A prompt
   * with the page's id of one of the chat's last MAX_CLIENT_IDS prompts its
   * log has, or of one whose event is on its way to the log, is that one
   * sent again by a page that did not get its answer: it is answered OK and
   * not sent again; one with the id of a prompt being taken gets that one's
   * answer. */
  async prompt(cmd: chat.Command): Promise<chat.ChatError | undefined> {
    let images: boolean;
    try {
      images = checkContent(cmd.content);
    } catch (e) {
      return errorOf(e);
    }
    const clientId = cmd.clientId ?? '';
    if (typeof clientId !== 'string' || clientId.length > 256) return perr(chat.Code.BadRequest, 'clientId too long');
    if (clientId !== '' && !this.deleted) {
      if (this.clients.has(clientId) || this.storing.has(clientId)) {
        this.logf('a prompt it took already came again');
        return undefined;
      }
      const f = this.sending.get(clientId);
      if (f) return f;
      const p = this.promptOnce(cmd, images);
      this.sending.set(clientId, p);
      try {
        return await p;
      } finally {
        this.sending.delete(clientId);
      }
    }
    return this.promptOnce(cmd, images);
  }

  private async promptOnce(cmd: chat.Command, images: boolean): Promise<chat.ChatError | undefined> {
    const msg = newID('m');
    const content = cmd.content ?? [];
    const clientId = cmd.clientId ?? '';
    let checked = false;
    for (;;) {
      if (this.deleted) return perr(chat.Code.UnknownChat, 'no such chat');
      if (this.sess && images && !this.r.chat.capabilities.images) return perr(chat.Code.Unsupported, 'the agent takes no images');
      if (this.sess && this.busy()) {
        // Queued: the adapter tells it (a queued event), or, when the turn
        // ended meanwhile, stores its user event itself.
        const sess = this.sess;
        return this.call((signal) => sess.prompt({ content, message: msg, clientId, recorded: false }, signal));
      }
      if (this.sess) return this.startTurn(content, clientId, msg);
      if (this.held) return perr(chat.Code.Busy, 'the chat is starting');
      if (this.starting && this.start) {
        const st = this.start;
        this.held = true;
        await st.done;
        this.held = false;
        if (!this.sess && !this.starting) return st.err ?? errEnded();
        continue;
      }
      if (this.h.stopping) return perr(chat.Code.Ended, 'the host stops');
      const handedOff = !!this.r.chat.handedOff;
      // The agent may not have kept a session that never had a turn: a new
      // one is made.
      const session = this.r.fresh ? '' : this.r.chat.sessionId;
      if (session !== '' && !checked) {
        // Not while another process runs the session (a terminal's): the
        // chat stays as it is.
        checked = true;
        const e = await this.h.inTerminal(this.r.chat.kind, this.r.chat.cwd, session);
        if (e) return e;
        continue;
      }
      const st = this.beginStart();
      this.held = true;
      try {
        if (handedOff && session !== '') await this.withHistory(() => this.history(st.abort.signal, session, Way.CatchUpStart));
        await this.launch(st, session);
      } finally {
        this.held = false;
      }
      if (!this.sess && !this.starting) return st.err ?? errEnded();
    }
  }

  /** Starts a turn of an idle chat with a message, its user event stored
   * (PromptParams.recorded). */
  private async startTurn(content: unknown[], clientId: string, msg: string): Promise<chat.ChatError | undefined> {
    let titled = false;
    if (this.r.chat.title === '') {
      const t = promptTitle(content);
      if (t !== '') {
        this.r.chat.title = t;
        titled = true;
      }
    }
    this.emit({ t: chat.EventType.User, content, ...(clientId ? { clientId } : {}) });
    this.turn = true;
    this.settle();
    if (titled) this.emitInfo();
    const sess = this.sess!;
    const gen = this.gen;
    const e = await this.call((signal) => sess.prompt({ content, message: msg, clientId, recorded: true }, signal));
    if (e && this.gen === gen && this.turn) {
      this.turn = false;
      this.cancelPending(chat.By.Ended);
      this.emit({ t: chat.EventType.Turn, state: chat.TurnState.Error, error: e });
      this.settle();
      this.notify();
    }
    return e;
  }

  /** Cancels the turn: what waits is answered as cancelled, and the agent
   * is told. */
  async cancelTurn(): Promise<chat.ChatError | undefined> {
    let sess: Session;
    try {
      sess = this.agent();
    } catch (e) {
      return errorOf(e);
    }
    // The queued messages go with the turn: no turn takes them.
    const next = this.next;
    this.queued.clear();
    this.endNext();
    if (!this.turn && !next && this.pending.size === 0) return undefined;
    this.cancelPending(chat.By.Cancel);
    this.settle();
    return this.call((signal) => sess.cancel(signal));
  }

  /** Has a permission or a question wait for the user, and settles with the
   * answer: the user's, cancelled (the turn's cancel or end, signal's end,
   * too many waiting), or an error when the chat's agent ended. */
  private async ask(signal: AbortSignal, gen: number, p: Omit<Pending, 'n' | 'id' | 'resolve'>, ev: chat.Event): Promise<Answer> {
    if (this.gen !== gen || this.deleted || (!this.sess && !this.starting)) return cancelled(errEnded());
    // An agent that asks is in a turn of the session: it keeps it.
    this.r.fresh = false;
    if (this.pending.size >= MAX_PENDING) {
      this.logf(`more than ${MAX_PENDING} permissions and questions wait: one more was cancelled`);
      return cancelled();
    }
    let resolve!: (a: Answer) => void;
    const answered = new Promise<Answer>((r) => (resolve = r));
    const pend: Pending = { ...p, n: ++pendingCount, id: newID(p.question ? 'q' : 'p'), resolve };
    ev.id = pend.id;
    this.pending.set(pend.id, pend);
    const emitted = this.emit(ev);
    if (!emitted.asIs) {
      // Nobody can answer what the log does not have as it is: too large
      // (a notice says it was left out), or not stored.
      this.pending.delete(pend.id);
      this.logf(`a ${ev.t} that could not be stored was cancelled`);
      return cancelled();
    }
    this.settle();
    void emitted.stored.then((ok) => {
      if (ok || this.pending.get(pend.id) !== pend) return;
      this.pending.delete(pend.id);
      pend.resolve(cancelled());
      this.settle();
    });
    const onAbort = () => {
      if (this.pending.get(pend.id) === pend) {
        this.resolve(pend, cancelled(), chat.By.Cancel);
        this.settle();
      }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await answered;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Answers what waits and says so; the caller settles the state. */
  private resolve(p: Pending, a: Answer, by: string): void {
    this.pending.delete(p.id);
    if (p.question) {
      const ev: chat.Event = { t: chat.EventType.QuestionDone, id: p.id, by };
      if (!a.q.cancelled) ev.answers = masked(p.questions, a.q.answers);
      this.emit(ev);
    } else {
      const outcome: chat.Outcome = a.perm.cancelled
        ? { outcome: chat.OutcomeKind.Cancelled }
        : { outcome: chat.OutcomeKind.Selected, optionId: a.perm.option };
      this.emit({ t: chat.EventType.PermissionDone, id: p.id, by, outcome });
    }
    p.resolve(a);
  }

  /** Answers everything that waits as cancelled, the oldest first, with err
   * for the adapter. */
  cancelPending(by: string, err?: chat.ChatError): void {
    for (const p of [...this.pending.values()].sort((a, b) => a.n - b.n)) this.resolve(p, cancelled(err), by);
  }

  /** Gives a permission the user's answer: the first one counts. */
  answerPermission(cmd: chat.Command): chat.ChatError | undefined {
    if (this.deleted) return perr(chat.Code.UnknownChat, 'no such chat');
    const p = this.pending.get(cmd.request ?? '');
    if (!p || p.question) return perr(chat.Code.NotFound, 'no such permission waits');
    let a = cancelled();
    if (!cmd.cancelled) {
      if (!p.options.includes(cmd.option ?? '')) return perr(chat.Code.BadRequest, 'not an option of the permission');
      a = { perm: { option: cmd.option! }, q: { cancelled: true } };
    }
    this.resolve(p, a, chat.By.User);
    this.settle();
    return undefined;
  }

  /** Gives a question the user's answers, or skips it: the first answer
   * counts. */
  answerQuestion(cmd: chat.Command): chat.ChatError | undefined {
    if (this.deleted) return perr(chat.Code.UnknownChat, 'no such chat');
    const p = this.pending.get(cmd.request ?? '');
    if (!p || !p.question) return perr(chat.Code.NotFound, 'no such question waits');
    let a = cancelled();
    if (!cmd.cancelled) {
      try {
        a = { perm: { cancelled: true }, q: { answers: checkAnswers(p.questions, cmd.answers) } };
      } catch (e) {
        return errorOf(e);
      }
    }
    this.resolve(p, a, chat.By.User);
    this.settle();
    return undefined;
  }

  /** Sets a configuration option of the chat to one of its values. */
  async setConfig(id: string, value: string): Promise<chat.ChatError | undefined> {
    let sess: Session;
    try {
      sess = this.agent();
    } catch (e) {
      return errorOf(e);
    }
    const o = (this.r.chat.config ?? []).find((x) => x.id === id);
    if (!o) return perr(chat.Code.BadRequest, 'no such configuration option');
    const v = (o.options ?? []).find((x) => x.value === value);
    if (!v) return perr(chat.Code.BadRequest, 'not a value of the option');
    if ((v.full || (o.category === chat.Category.Mode && value === chat.Mode.Full)) && !this.h.settings().allowFull)
      return perr(chat.Code.NotAllowed, 'full access is not allowed on this machine');
    const category = o.category;
    const gen = this.gen;
    const e = await this.call((signal) => sess.setConfig(id, value, signal));
    if (e) return e;
    if (this.gen !== gen) return undefined;
    this.r.chat.config = (this.r.chat.config ?? []).map((x) => (x.id === id ? { ...x, currentValue: value } : x));
    // The agent starts again with what was set last.
    if (category === chat.Category.Model) this.r.options.model = value;
    else if (category === chat.Category.ThoughtLevel) this.r.options.effort = value;
    // The agent's own modes too: an adapter takes its own values.
    else if (category === chat.Category.Mode) this.r.options.mode = value;
    this.emitInfo();
    return undefined;
  }

  /** Withdraws a queued message. */
  async cancelQueued(message: string | undefined): Promise<chat.ChatError | undefined> {
    if (!message || message.length > 64) return perr(chat.Code.BadRequest, 'no such message');
    let sess: Session;
    try {
      sess = this.agent();
    } catch (e) {
      return errorOf(e);
    }
    return this.call((signal) => sess.cancelQueued(message, signal));
  }

  /** Compacts the conversation's context. */
  async compact(): Promise<chat.ChatError | undefined> {
    let sess: Session;
    try {
      sess = this.agent();
    } catch (e) {
      return errorOf(e);
    }
    if (!this.r.chat.capabilities.compact) return perr(chat.Code.Unsupported, 'the agent does not compact');
    return this.call((signal) => sess.compact(signal));
  }

  /** Sets the chat's title. */
  rename(title: unknown): chat.ChatError | undefined {
    const t = clip(typeof title === 'string' ? title : '', AGENT_TITLE_RUNES).trim();
    if (t === '') return perr(chat.Code.BadRequest, 'an empty title');
    if (this.deleted) return perr(chat.Code.UnknownChat, 'no such chat');
    this.r.chat.title = t;
    this.r.renamed = true;
    this.emitInfo();
    return undefined;
  }

  /** Ends the chat's agent for its session to go on in a terminal, and
   * settles once the agent is gone. Refused while a turn runs. */
  async handoff(): Promise<chat.ChatError | undefined> {
    if (this.deleted) return perr(chat.Code.UnknownChat, 'no such chat');
    if (this.starting || this.held || this.busy()) return perr(chat.Code.Busy, 'a turn runs');
    if (this.r.chat.sessionId === '' || this.r.fresh)
      // A session without a turn may not be kept by the agent: no terminal
      // could take it up.
      return perr(chat.Code.NotFound, 'the chat has no session with a turn');
    const sess = this.stopAgent(chat.State.Sleeping);
    this.r.chat.handedOff = true;
    delete this.r.chat.closed;
    this.emit({ t: chat.EventType.Notice, method: noticeMethod(Notice.HandedOff) });
    this.emitInfo();
    await this.h.endSession(sess, true);
    return undefined;
  }

  /** Takes an event of the chat's adapter. Live increments of an item go to
   * the attached connections; the others are stored. The host's own events
   * (acks, states, infos, permissions and questions, which the adapter asks
   * through the Sink) are left out, and so is a turn event of no state the
   * protocol knows. */
  private agentEvent(gen: number, ev: chat.Event): void {
    if (this.gen !== gen || this.deleted) return;
    if (ev.live) {
      // An increment belongs to an item, which its stored event replaces.
      if (!ev.item) return this.dropEvent(`live ${ev.t} without an item`);
      return this.live(ev);
    }
    switch (ev.t) {
      case chat.EventType.Update:
      case chat.EventType.User:
      case chat.EventType.Notice:
        // The agent answered: it keeps the session.
        if (ev.t === chat.EventType.Update) this.r.fresh = false;
        if (ev.t === chat.EventType.Notice && ev.method === noticeMethod(Notice.UntrustedFolder)) {
          // Told once, until an agent of the chat starts in a trusted
          // folder.
          this.untrustedGen = gen;
          if (this.r.untrustedTold) return;
          this.r.untrustedTold = true;
          this.emit(ev);
          this.save();
          return;
        }
        this.emit(ev);
        return;
      case chat.EventType.Queued:
        this.followQueued(ev);
        this.emit(ev);
        if (this.next && this.queued.size === 0 && !this.nextTaken) {
          // Every message that waited was withdrawn: no turn comes.
          this.endNext();
          this.settle();
          this.notify();
        }
        return;
      case chat.EventType.Turn:
        if (ev.state === chat.TurnState.Start) {
          this.turn = true;
          this.endNext();
          this.emit(ev);
        } else if (ev.state === chat.TurnState.End || ev.state === chat.TurnState.Error) {
          // What waits was asked before the end: it is cancelled, and the
          // end is the turn's last event.
          this.cancelPending(chat.By.Ended);
          this.turn = false;
          if (ev.state === chat.TurnState.End) this.r.fresh = false;
          this.emit(ev);
          this.awaitNext();
        } else return this.dropEvent(`${ev.t}:${ev.state}`);
        this.settle();
        this.notify();
        return;
    }
    this.dropEvent(ev.t);
  }

  /** Follows the messages the adapter queued: waiting until it tells them
   * taken or cancelled. */
  private followQueued(ev: chat.Event): void {
    if (!ev.message) return;
    if (ev.state === chat.QueuedState.Waiting) {
      if (this.queued.size < MAX_QUEUED) this.queued.add(ev.message);
    } else if (ev.state === chat.QueuedState.Taken || ev.state === chat.QueuedState.Cancelled) {
      if (ev.state === chat.QueuedState.Taken && this.next) this.nextTaken = true;
      this.queued.delete(ev.message);
    }
  }

  /** Logs, once for each kind, that an adapter's event was left out. */
  private dropEvent(kind: string): void {
    if (!this.dropped.has(kind) && this.dropped.size < 64) {
      this.dropped.add(kind);
      this.logf(`the adapter's events ${JSON.stringify(kind)} are left out`);
    }
  }

  /** Takes what the chat's adapter states of the chat: its title (the
   * agent's own title of the session, unless the user named the chat),
   * session id, configuration options, slash commands, usage, capabilities
   * and agent version; the other members are the host's. A member whose
   * JSON is longer than STATE_BYTES is left as it was. The clients are told
   * soon, the changes of a moment together.
   *
   * A mode the agent changes to by itself after the first one it stated is
   * the chat's mode from then on: its agent starts again in it. A mode of
   * full access the agent takes while the settings do not allow it is taken
   * back (denyFull). */
  private update(gen: number, fn: (c: chat.Chat) => void): void {
    if (this.gen !== gen || this.deleted || this.stopped) return;
    const cp = this.snapshot();
    try {
      fn(cp);
    } catch (e) {
      this.logf(`an update of its adapter failed: ${(e as Error).message}`);
      return;
    }
    const title = clip(typeof cp.title === 'string' ? cp.title : '', AGENT_TITLE_RUNES).trim();
    if (title !== '' && !this.r.renamed) this.r.chat.title = title;
    if (cp.sessionId !== this.r.chat.sessionId && typeof cp.sessionId === 'string' && SESSION_ID.test(cp.sessionId))
      this.r.chat.sessionId = cp.sessionId;
    if (fits(cp.config)) {
      if (cp.config) this.r.chat.config = cp.config;
      else delete this.r.chat.config;
      const o = modeOption(this.r.chat.config);
      if (o && o.currentValue) {
        const { id, currentValue: value } = o;
        if (this.modeGen === gen && value !== this.mode && validOption(value)) {
          // Stored with the info event of this change.
          this.logf(`its agent changed its mode to ${JSON.stringify(clip(value, 64))}`);
          this.r.options.mode = value;
        }
        const prev = this.mode;
        this.mode = value;
        this.modeGen = gen;
        if (fullMode(this.r.chat.config, value) && !this.h.settings().allowFull && this.denying !== gen) {
          this.denying = gen;
          const back = safeMode(o, prev, this.r.options.mode ?? '');
          this.h.track(this.denyFull(gen, id, value, back));
        }
      }
    }
    if (fits(cp.commands)) {
      if (cp.commands) this.r.chat.commands = cp.commands;
      else delete this.r.chat.commands;
    }
    if (fits(cp.usage)) {
      if (cp.usage) this.r.chat.usage = cp.usage;
      else delete this.r.chat.usage;
    }
    if (cp.capabilities && typeof cp.capabilities === 'object') this.r.chat.capabilities = { ...cp.capabilities };
    const v = typeof cp.agentVersion === 'string' ? cp.agentVersion : '';
    if (Buffer.byteLength(v) <= 256) {
      if (v) this.r.chat.agentVersion = clip(v, 256);
      else delete this.r.chat.agentVersion;
    }
    this.infoDirty = true;
    if (!this.infoTimer) {
      this.infoTimer = setTimeout(() => {
        this.infoTimer = null;
        if (this.infoDirty && !this.deleted && !this.stopped) this.emitInfo();
      }, this.h.o.infoDelay);
    }
    this.notify();
  }

  /** Takes an agent (gen) out of a mode of full access it took by itself
   * while the settings do not allow it: its mode option id is set back to
   * back; when that cannot be, the agent is ended and the chat fails
   * (not_allowed). The chat's mode is back's (or the default) from then on,
   * which the notice full_access_off tells. */
  private async denyFull(gen: number, id: string, value: string, back: string): Promise<void> {
    const st = this.start;
    if (!this.sess && st && st.gen === gen)
      // Stated while it starts: once it runs, unless the start set another
      // mode.
      await st.done;
    const sess = this.sess;
    const o = modeOption(this.r.chat.config);
    if (this.gen !== gen || !sess || this.deleted) return;
    if (!o || !fullMode(this.r.chat.config, o.currentValue)) {
      this.denying = 0;
      return;
    }
    value = o.currentValue;
    this.logf(`its agent took the mode ${JSON.stringify(clip(value, 64))} of full access, which this machine does not allow`);
    const e =
      back === ''
        ? perr(chat.Code.NotAllowed, 'the agent has no mode without full access')
        : await this.call((s) => sess.setConfig(id, back, s));
    if (this.gen !== gen || this.deleted) return;
    this.r.options.mode = back || chat.Mode.Default;
    this.emit({ t: chat.EventType.Notice, method: noticeMethod(Notice.FullAccessOff), params: { mode: value } });
    if (!e) {
      const m = modeOption(this.r.chat.config);
      if (m && m.id === id) {
        this.r.chat.config = (this.r.chat.config ?? []).map((x) => (x.id === id ? { ...x, currentValue: back } : x));
        this.mode = back;
      }
      this.denying = 0;
      this.emitInfo();
      return;
    }
    this.logf(`its agent stays in full access (${chat.errorText(e)}): it is ended`);
    const fail = perr(chat.Code.NotAllowed, 'the agent took full access, which this machine does not allow');
    const ended = this.stopAgent(chat.State.Failed, fail, fail);
    this.save();
    this.notify();
    void this.h.endSession(ended, false);
  }

  /** Where the chat's agent of gen reports. */
  private sink(gen: number): Sink {
    return {
      event: (ev) => this.agentEvent(gen, ev),
      update: (fn) => this.update(gen, fn),
      permission: (r, signal) => this.askPermission(gen, r, signal),
      question: (r, signal) => this.askQuestion(gen, r, signal),
    };
  }

  private async askPermission(gen: number, r: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    const ids: string[] = [];
    const options: chat.PermissionOption[] = [];
    for (const o of r.options ?? []) {
      if (!o?.optionId || ids.includes(o.optionId)) continue;
      ids.push(o.optionId);
      options.push(o);
    }
    if (options.length === 0) return { cancelled: true };
    const ev: chat.Event = {
      t: chat.EventType.Permission,
      kind: r.kind || chat.PermissionKind.Other,
      ...(r.toolCall !== undefined ? { toolCall: r.toolCall } : {}),
      options,
      ...(r.parent ? { parent: r.parent } : {}),
    };
    const a = await this.ask(signal, gen, { question: false, options: ids, questions: [] }, ev);
    if (a.err) throw new chat.ChatProtoError(a.err);
    return a.perm;
  }

  /** Asks the user. A question without an id, or with the id of one before
   * it, is asked under an id of the host's: the answers come back to the
   * adapter under the ids it gave (the first answer of those of one id). */
  private async askQuestion(gen: number, r: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer> {
    const qs = (r.questions ?? []).map((q) => ({ ...q }));
    if (qs.length === 0) return { cancelled: true };
    // The adapter's ids that stay: each one's first.
    const used = new Set<string>();
    const keep = qs.map((q) => {
      if (q.id && !used.has(q.id)) {
        used.add(q.id);
        return true;
      }
      return false;
    });
    const ids = new Map<string, string>(); // the host's id → the adapter's
    qs.forEach((q, i) => {
      const id = q.id ?? '';
      if (!keep[i]) {
        let n = i + 1;
        while (used.has(`q${n}`)) n++;
        q.id = `q${n}`;
        used.add(q.id);
      }
      ids.set(q.id, id);
    });
    const ev: chat.Event = {
      t: chat.EventType.Question,
      questions: qs,
      ...(r.toolCall !== undefined ? { toolCall: r.toolCall } : {}),
      ...(r.parent ? { parent: r.parent } : {}),
    };
    const a = await this.ask(signal, gen, { question: true, options: [], questions: qs }, ev);
    if (a.err) throw new chat.ChatProtoError(a.err);
    if (a.q.cancelled) return a.q;
    const answers: Record<string, string[]> = {};
    for (const q of qs) {
      const vs = a.q.answers[q.id];
      const theirs = ids.get(q.id) ?? '';
      if (vs && !(theirs in answers)) answers[theirs] = vs;
    }
    return { answers };
  }
}
