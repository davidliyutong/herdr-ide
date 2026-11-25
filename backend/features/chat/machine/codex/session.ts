// A chat's Codex thread on an app-server process: Codex's turns, items and
// requests as the chat's events, the user's prompts as turns, and the end
// of the process.
//
// Everything runs on the host's one thread: the connection hands each
// notification and request to the session synchronously, in the order of
// the app-server's output, and the session calls the sink synchronously
// from there, from its methods and from the ends of its calls. What starts
// or steers a turn, compacts, carries out an approved plan or starts the
// app-server again holds the session's lock across its calls: one of
// them at a time.
import { randomBytes } from 'node:crypto';
import { NAME, SLUG } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { Notice } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import {
  ChatProtoError,
  Code,
  EventType,
  Mode,
  QueuedState,
  TurnState,
  type ChatError,
  type Event,
  type Usage,
} from '#shared/proto/chatproto/index.ts';
import {
  OPTION_ALLOW_ONCE,
  OPTION_ALLOW_SESSION,
  OPTION_PLAN_PREFIX,
  OPTION_REJECT_ONCE,
  planOption,
  type ClientInfo,
  type PermissionAnswer,
  type PromptParams,
  type QuestionAnswer,
  type Session,
  type Sink,
  type StartParams,
} from '../adapter.ts';
import type { AgentProcess, StopTiming } from '../agentproc.ts';
import type {
  ClientRequests,
  ItemCompletedNotification,
  Model,
  RateLimitSnapshot,
  ServerNotificationMethod,
  ServerNotifications,
  ServerRequests,
  ThreadItem,
  Turn,
  TurnError,
  UserInput,
} from './appserver.gen.ts';
import { COMMANDS, Models, Opt, hasEffort, isMode, modelListParams, threadParams, turnParams, type Settings } from './config.ts';
import {
  AGENT_MESSAGE_CHUNK,
  AGENT_THOUGHT_CHUNK,
  ItemType,
  Mapper,
  SubAgent,
  Tool,
  cancelledCall,
  chunk,
  collabCall,
  cutText,
  fileDiffs,
  isObj,
  isTool,
  itemTime,
  noticeEvent,
  setMeta,
  shellScript,
  strOf,
  subAgentCall,
  textBlock,
  timeOf,
  toUserInput,
  toolCall,
  turnEnd,
  updateEvent,
  userContent,
  MAX_TITLE,
  type Obj,
} from './mapping.ts';
import { AbortedError, ClosedError, Conn, METHOD_NOT_FOUND, RpcError, type ServerRequest } from './rpc.ts';

/** A session's times, in milliseconds; shorter in tests. */
export interface CodexTiming extends StopTiming {
  /** Bounds starting the app-server and its thread, whatever the start's
   * signal allows. */
  start: number;
  /** How long a command may still run after the turn was interrupted
   * (Codex does not stop it) before the app-server is started again,
   * which ends it. */
  interruptGrace: number;
  /** How often a turn's usage reaches the host at most; the end of a turn
   * sends it in any case. */
  usageEvery: number;
}

/** The app-server has grace (2 s) to exit once its input is closed before
 * its group gets SIGTERM, term (5 s) more before SIGKILL: Codex killed
 * outright leaves its shell snapshots in ~/.codex/shell_snapshots. */
export const CODEX_TIMING: CodexTiming = { start: 60_000, interruptGrace: 2000, usageEvery: 5000, grace: 2000, term: 5000, drain: 1000 };

/** The prompt that has an approved plan carried out, as Codex's own client
 * words it. */
export const IMPLEMENT_PLAN = 'Implement the plan.';

/** The answers of a permission the host shows for Codex, which has none of
 * its own. */
export const PERMISSION_OPTIONS: chat.PermissionOption[] = [
  { optionId: OPTION_ALLOW_ONCE, name: 'Allow', kind: chat.OptionKind.AllowOnce },
  { optionId: OPTION_ALLOW_SESSION, name: 'Allow for this session', kind: chat.OptionKind.AllowAlways },
  { optionId: OPTION_REJECT_ONCE, name: 'Reject', kind: chat.OptionKind.RejectOnce },
];

/** The answers of a plan's approval: carry it out asking before changes,
 * or making edits without asking, or keep planning. */
export const PLAN_OPTIONS: chat.PermissionOption[] = [
  { optionId: planOption(Mode.Default), name: 'Approve', kind: chat.OptionKind.AllowOnce },
  { optionId: planOption(Mode.AcceptEdits), name: 'Approve and accept edits', kind: chat.OptionKind.AllowOnce },
  { optionId: OPTION_REJECT_ONCE, name: 'Keep planning', kind: chat.OptionKind.RejectOnce },
];

/** The methods of the app-server's requests. */
const M = {
  CommandApproval: 'item/commandExecution/requestApproval',
  FileChangeApproval: 'item/fileChange/requestApproval',
  RequestUserInput: 'item/tool/requestUserInput',
  McpElicitation: 'mcpServer/elicitation/request',
  PermissionsApproval: 'item/permissions/requestApproval',
  DynamicToolCall: 'item/tool/call',
} as const satisfies Record<string, keyof ServerRequests>;

/** The notifications that show nothing the conversation needs: the items
 * tell it. */
const QUIET = new Set<string>([
  'thread/started',
  'thread/status/changed',
  'thread/settings/updated',
  'thread/readState/changed',
  'thread/goal/cleared',
  'thread/goal/updated',
  'turn/diff/updated',
  'turn/moderationMetadata',
  'turn/plan/updated',
  'item/reasoning/textDelta',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'hook/started',
  'hook/completed',
  'mcpServer/startupStatus/updated',
  'configWarning',
  'warning',
  'deprecationNotice',
  'remoteControl/status/changed',
  'account/updated',
  'skills/changed',
  'thread/compacted',
] satisfies ServerNotificationMethod[]);

/** What Codex 0.171.0 answers a thread/resume of a thread another process
 * of Codex has open ("thread <id> already has an active writer", "... a live
 * local writer"). */
const ACTIVE_WRITER = ['already has an active writer', 'already has a live local writer'];

/** Bounds the maps of the tool calls that started and did not complete and
 * of the subagents' threads a session keeps (an app-server that never
 * completes what it starts would grow them without end): beyond it the
 * oldest goes. A call forgotten is not marked cancelled at its turn's end
 * nor given its output's increments; a thread forgotten is its own parent. */
export const MAX_TRACKED = 4096;

/** Sets k to v in m, the oldest entry going when m holds MAX_TRACKED. */
function setBounded<K, V>(m: Map<K, V>, k: K, v: V): void {
  if (!m.has(k) && m.size >= MAX_TRACKED) m.delete(m.keys().next().value as K);
  m.set(k, v);
}

const perr = (code: string, message: string): ChatProtoError => new ChatProtoError({ code, message });
const errEnded = (): ChatProtoError => perr(Code.Ended, 'the session ended');

export const newID = (): string => 'm' + randomBytes(8).toString('hex');

/** An error of a request as the host's: Codex's answers about threads that
 * are not there are not_found, those about a thread another Codex writes (a
 * terminal's) in_terminal. */
export function callError(err: unknown): ChatError {
  if (err instanceof ChatProtoError) return { ...err.error };
  if (err instanceof RpcError) {
    let code: string = Code.Failed;
    if (['no rollout found', 'thread not found', 'thread not loaded', 'invalid thread id'].some((p) => err.message.startsWith(p)))
      code = Code.NotFound;
    if (ACTIVE_WRITER.some((p) => err.message.includes(p))) code = Code.InTerminal;
    return { code, message: err.message };
  }
  if (err instanceof ClosedError) return { code: Code.Ended, message: 'the app-server is gone' };
  if (err instanceof AbortedError) return { code: Code.Ended, message: 'the call was given up' };
  return { code: Code.Failed, message: (err as Error)?.message ?? String(err) };
}

/** Why a start failed: the app-server's own error, or its end with what it
 * wrote to its standard error. */
export function startError(proc: AgentProcess, err: unknown): ChatError {
  if (err instanceof ChatProtoError) return { ...err.error };
  const stderr = proc.stderr();
  const withStderr = (e: ChatError): ChatError => (stderr ? { ...e, stderr } : e);
  if (err instanceof ClosedError) return withStderr({ code: Code.StartFailed, message: 'the app-server ended' });
  if (err instanceof AbortedError) return withStderr({ code: Code.StartFailed, message: 'the app-server did not answer in time' });
  return callError(err);
}

/** The version a user agent "<name>/<version> (...)" states. */
export function agentVersion(ua: unknown): string {
  if (typeof ua !== 'string') return '';
  const slash = ua.indexOf('/');
  if (slash < 0) return '';
  return cutText(ua.slice(slash + 1).split(' ')[0]!, 64);
}

/** The handshake; resolves with the app-server's version (from its user
 * agent). */
export async function initialize(c: Conn, client: ClientInfo, signal: AbortSignal): Promise<string> {
  const res = await c.call(
    'initialize',
    {
      clientInfo: { name: SLUG, title: client.name || NAME, version: client.version || '0' },
      // requestAttestation is required: there is none to give.
      capabilities: { experimentalApi: true, requestAttestation: false },
    },
    signal,
  );
  c.notify('initialized');
  return agentVersion(isObj(res) ? res.userAgent : undefined);
}

/** The models model/list offers (the hidden ones left out); none when it
 * fails. */
async function listModels(c: Conn, signal: AbortSignal, logf: (l: string) => void): Promise<Models> {
  const out: Model[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    let res: ClientRequests['model/list']['result'];
    try {
      res = await c.call('model/list', modelListParams(cursor), signal);
    } catch (e) {
      logf(`model/list: ${(e as Error).message}`);
      break;
    }
    for (const m of Array.isArray(res?.data) ? res.data : []) if (isObj(m) && !m.hidden && Models.slug(m) !== '') out.push(m);
    if (!res?.nextCursor) break;
    cursor = res.nextCursor;
  }
  return new Models(out);
}

/** Refuses a start without a sign-in Codex needs. */
async function checkAccount(c: Conn, signal: AbortSignal): Promise<void> {
  let res: ClientRequests['account/read']['result'];
  try {
    res = await c.call('account/read', { refreshToken: false }, signal);
  } catch {
    return;
  }
  if (isObj(res) && res.requiresOpenaiAuth && (res.account === undefined || res.account === null))
    throw perr(Code.AuthRequired, 'Codex is not signed in');
}

/** The answer of a request of the app-server the user does not answer:
 * approvals cancelled, questions unanswered, MCP elicitations declined,
 * extra permissions not granted, dynamic tools (the session registers none)
 * failed; tokens and attestations (the session has none to give) and what
 * the adapter does not know get "method not found". */
export function refuse(r: ServerRequest): void {
  switch (r.method) {
    case M.CommandApproval:
    case M.FileChangeApproval:
      return r.reply({ decision: 'cancel' } satisfies ServerRequests[typeof M.CommandApproval]['result']);
    case M.RequestUserInput:
      return r.reply({ answers: {} } satisfies ServerRequests[typeof M.RequestUserInput]['result']);
    case M.McpElicitation:
      return r.reply({ action: 'decline', content: null, _meta: null } satisfies ServerRequests[typeof M.McpElicitation]['result']);
    case M.PermissionsApproval:
      return r.reply({ permissions: {}, scope: 'turn' } satisfies ServerRequests[typeof M.PermissionsApproval]['result']);
    case M.DynamicToolCall:
      return r.reply({
        contentItems: [{ type: 'inputText', text: 'This client has no such tool.' }],
        success: false,
      } satisfies ServerRequests[typeof M.DynamicToolCall]['result']);
  }
  r.fail(METHOD_NOT_FOUND, 'method not found: ' + cutText(r.method, 128));
}

/** A prompt the session queued or steered into a running turn. */
interface Message {
  content: unknown[];
  message: string;
  clientId: string;
}

/** A tool call of an item that started and did not complete. */
interface OpenItem {
  type: string;
  item: ThreadItem;
  parent: string;
  /** The stored state of its tool call. */
  last: Obj;
  /** The log has it in progress (not cancelled at its turn's end). */
  shown: boolean;
}

/** A subagent's thread: the tool call that started it. */
interface Child {
  call: string;
  parent: string;
  state: Obj;
}

/** A request of the app-server that waits for the user. */
interface Pending {
  ac: AbortController;
  /** The app-server settled it on its own (serverRequest/resolved). */
  resolved: boolean;
}

/** A plan's approval being asked, after the end of the turn that made the
 * plan (the host cancels what was asked before a turn's end). */
interface PlanAsk {
  ac: AbortController;
  done: Promise<void>;
  /** A prompt came instead of an answer (or the session ended): the plan is
   * not carried out. */
  superseded: boolean;
}

/** An app-server process of the session and the connection to it. */
interface AppServer {
  serial: number;
  proc: AgentProcess;
  conn: Conn;
}

/** One holder at a time, in the order they asked. */
class Lock {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  /** Resolves true once the caller holds the lock; false when signal ended
   * first. */
  acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (!this.held) {
      this.held = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const take = () => {
        signal?.removeEventListener('abort', give);
        resolve(true);
      };
      const give = () => {
        const i = this.waiters.indexOf(take);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      };
      signal?.addEventListener('abort', give, { once: true });
      this.waiters.push(take);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.held = false;
  }
}

/** Resolves once p settles or signal ends; rejects with the call given up
 * in the latter case. */
function until<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortedError(signal.reason));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AbortedError(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(e);
      },
    );
  });
}

const sleep = (ms: number, signal: AbortSignal) => until(new Promise<void>((r) => setTimeout(r, ms)), signal);

/** Whether a prompt is the slash command /compact. */
function isCompact(content: unknown[]): boolean {
  if (content.length !== 1) return false;
  const b = content[0];
  return isObj(b) && b.type === 'text' && typeof b.text === 'string' && b.text.trim() === '/compact';
}

function queuedEvent(m: Message, state: string, content: boolean): Event {
  return {
    t: EventType.Queued,
    ...(content ? { content: m.content } : {}),
    ...(m.clientId ? { clientId: m.clientId } : {}),
    ...(m.message ? { message: m.message } : {}),
    state,
  };
}

const userEvent = (m: Message): Event => ({ t: EventType.User, content: m.content, ...(m.clientId ? { clientId: m.clientId } : {}) });

/** A chat's Codex thread on an app-server process. */
export class CodexSession implements Session {
  readonly done: Promise<ChatError | undefined>;
  private resolveDone!: (e: ChatError | undefined) => void;
  /** Ends with the session: what waits for the user returns then. */
  private readonly ac = new AbortController();
  /** Held by what starts or steers a turn, compacts, or starts the
   * app-server again. */
  private readonly lock = new Lock();
  private readonly p: StartParams;
  private readonly sink: Sink;
  private readonly logger: Logger;
  private readonly t: CodexTiming;
  private readonly m: Mapper;
  /** Tells the adapter the session ended. */
  private readonly forget: (s: CodexSession) => void;

  private c: AppServer | null = null;
  private serial = 0;
  private thread = '';
  private models = new Models();
  /** What the turns run with. */
  readonly st: Settings = { model: '', effort: '', mode: '' };
  private version = '';
  /** The running turn's id, once known. */
  private turn = '';
  /** A turn runs (or was asked for). */
  private active = false;
  /** The running turn compacts. */
  private compacting = false;
  /** The clientUserMessageId of the turn's prompt. */
  private promptId = '';
  /** The turn's first user message is its prompt, which the host told. */
  private skipUser = false;
  private steers: Message[] = [];
  private queue: Message[] = [];
  private readonly items = new Map<string, OpenItem>();
  private readonly children = new Map<string, Child>();
  private plan = { id: '', text: '' };
  private ask: PlanAsk | null = null;
  private readonly pending = new Map<string, Pending>();
  private usage: Usage = { used: 0, size: 0 };
  private readonly limits = new Map<string, chat.Limit[]>();
  private dirty = false;
  private flushed = 0;
  private lastErr: TurnError | null = null;
  private restarting = false;
  private closing = false;
  private ended = false;
  private err: ChatError | undefined;

  constructor(p: StartParams, sink: Sink, t: CodexTiming, forget: (s: CodexSession) => void) {
    this.p = p;
    this.sink = sink;
    this.logger = p.logger;
    this.t = t;
    this.m = new Mapper(p.cwd);
    this.forget = forget;
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  get id(): string {
    return this.thread;
  }

  /** The app-server's process id, the leader of its process group; 0
   * before it started. */
  get pid(): number {
    return this.c?.proc.pid ?? 0;
  }

  /** Whether a turn runs or a plan waits for its approval: a prompt now is
   * not one the host records (tests). */
  get busy(): boolean {
    return this.active || this.ask !== null;
  }

  /** The app-server's connection, while it can answer questions (thread
   * lists, turns) for others. */
  get liveConn(): Conn | null {
    const c = this.c;
    if (this.ended || this.closing || this.restarting || this.thread === '' || !c || c.conn.ended) return null;
    return c.conn;
  }

  /** The connection of the running app-server (tests). */
  get conn(): Conn | null {
    return this.c?.conn ?? null;
  }

  private logf(line: string): void {
    this.logger(`codex: ${line}`);
  }

  private emit(...evs: Event[]): void {
    for (const ev of evs) this.sink.event(ev);
  }

  // ---- the app-server ----

  /** Starts an app-server and takes the session's thread on it: a new one
   * (resume ""), or resume's. first is the session's start: the models and
   * the settings are found then. */
  async connect(resume: string, first: boolean, signal: AbortSignal): Promise<void> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.t.start)]);
    let proc: AgentProcess;
    try {
      proc = await this.p.procs.spawn(this.p.argv, { cwd: this.p.cwd, env: this.p.env });
    } catch (e) {
      throw perr(Code.StartFailed, (e as Error).message);
    }
    const serial = ++this.serial;
    let srv!: AppServer;
    const conn = new Conn(
      proc,
      {
        notification: (method, params, at) => this.notification(srv, method, params, at),
        request: (r) => this.request(srv, r),
      },
      this.logger,
    );
    srv = { serial, proc, conn };
    this.c = srv;
    void this.watch(srv);
    try {
      const version = await initialize(conn, this.p.client, deadline);
      let ms = new Models();
      if (first) {
        ms = await listModels(conn, deadline, (l) => this.logf(l));
        await checkAccount(conn, deadline);
      }
      let model = this.st.model;
      if (first) {
        model = this.p.options.model ?? '';
        if (model !== '' && ms.length > 0 && !ms.find(model)) {
          this.logf(`the model ${JSON.stringify(model)} is not offered; the thread's own is used`);
          model = '';
        }
      }
      const method = resume !== '' ? 'thread/resume' : 'thread/start';
      const res =
        resume !== ''
          ? await conn.call('thread/resume', threadParams(resume, this.p.cwd, model), deadline)
          : await conn.call('thread/start', threadParams('', this.p.cwd, model), deadline);
      const id = isObj(res) && isObj(res.thread) && typeof res.thread.id === 'string' ? res.thread.id : '';
      if (id === '') throw perr(Code.StartFailed, `${method} answered no thread`);
      if (first) this.thread = id;
      else if (id !== this.thread) this.logf(`thread/resume of ${this.thread} answered the thread ${id}`);
      this.version = version;
      if (first) {
        this.models = ms;
        this.st.model = model !== '' ? model : typeof res.model === 'string' ? res.model : '';
        const threadEffort = typeof res.reasoningEffort === 'string' ? res.reasoningEffort : '';
        this.st.effort = ms.effortFor(this.st.model, this.p.options.effort ?? '', threadEffort);
        let mode = this.p.options.mode ?? '';
        if (!isMode(mode)) mode = this.p.settings.defaultMode;
        if (!isMode(mode)) mode = Mode.Default;
        this.st.mode = mode;
      }
    } catch (e) {
      throw new ChatProtoError(startError(proc, e));
    }
  }

  /** Ends the session when its app-server ends, unless the session replaced
   * it: once its output closed, or its process exited while a program it
   * started still holds the output, and what it left in its group is gone. */
  private async watch(srv: AppServer): Promise<void> {
    await Promise.race([srv.conn.closed, srv.proc.exited]);
    if (!srv.conn.ended) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([srv.conn.closed, new Promise<void>((r) => (timer = setTimeout(r, this.t.drain ?? 1000)))]);
      clearTimeout(timer);
    }
    await srv.proc.stop(this.t);
    srv.conn.close();
    if (srv !== this.c || this.restarting) return;
    let err: ChatError | undefined;
    if (!this.closing) {
      const status = srv.proc.status();
      const stderr = srv.proc.stderr();
      err = { code: Code.Ended, message: 'the app-server ended' + (status ? `: ${status}` : ''), ...(stderr ? { stderr } : {}) };
    }
    this.finish(err);
  }

  /** Ends the session: what waits is cancelled, a running turn ends
   * (cancelled after close, with the error otherwise). */
  finish(err: ChatError | undefined): void {
    if (this.ended) return;
    this.ended = true;
    this.err = err;
    const evs: Event[] = [];
    if (this.ask) {
      this.ask.superseded = true;
      this.ask.ac.abort();
    }
    this.ask = null;
    if (this.active) {
      evs.push(
        err === undefined
          ? { t: EventType.Turn, ...(this.turn ? { item: this.turn } : {}), state: TurnState.End, stopReason: 'cancelled' }
          : { t: EventType.Turn, ...(this.turn ? { item: this.turn } : {}), state: TurnState.Error, error: err },
      );
    }
    // Steered into the turn, which had them (as a turn's end tells).
    for (const m of this.steers) evs.push(queuedEvent(m, QueuedState.Taken, false));
    for (const m of this.queue) evs.push(queuedEvent(m, QueuedState.Cancelled, false));
    this.steers = [];
    this.queue = [];
    this.active = false;
    this.turn = '';
    const pend = this.takePending();
    for (const p of pend) p.ac.abort();
    this.ac.abort();
    this.emit(...evs);
    this.resolveDone(err);
    this.forget(this);
  }

  /** Empties the requests that wait. */
  private takePending(): Pending[] {
    const out = [...this.pending.values()];
    this.pending.clear();
    return out;
  }

  /** Ends the app-server and starts another on the session's thread: Codex
   * does not stop the command of a turn it interrupted, the end of its
   * process does. */
  private async restart(): Promise<void> {
    if (!(await this.lock.acquire(this.ac.signal))) return;
    try {
      if (this.ended || this.closing || this.active || !this.commandRuns()) return;
      this.restarting = true;
      const old = this.c!;
      const thread = this.thread;
      const evs: Event[] = [];
      for (const id of [...this.items.keys()].sort()) {
        const oi = this.items.get(id)!;
        if (oi.shown) evs.push(this.cancelledEvent(id, oi));
        this.items.delete(id);
      }
      for (const p of this.takePending()) p.ac.abort();
      this.emit(...evs);
      this.logf('starting the app-server again: a command of the interrupted turn still runs');
      await old.proc.stop(this.t);
      let err: ChatError | undefined;
      if (!this.closing) {
        try {
          await this.connect(thread, false, this.ac.signal);
        } catch (e) {
          err = callError(e);
        }
      }
      this.restarting = false;
      const c = this.c!;
      if (this.closing) {
        if (c !== old) await c.proc.stop(this.t);
        this.finish(undefined);
      } else if (err) {
        if (c !== old) void c.proc.stop(this.t);
        this.finish(err);
      } else {
        this.emit(noticeEvent(Notice.Restarted, '', { mode: this.st.mode }));
      }
    } finally {
      this.restarting = false;
      this.lock.release();
    }
  }

  /** Whether a command started and did not complete. */
  private commandRuns(): boolean {
    for (const oi of this.items.values()) if (oi.type === ItemType.Command) return true;
    return false;
  }

  // ---- Session ----

  /** Starts a turn; while one runs, it steers the message into it
   * (turn/steer), or queues it for the turn's end where the turn takes no
   * steering (a compaction); a prompt while a plan waits for its approval
   * keeps planning with it. A prompt that starts a turn is the host's to
   * tell (its user event) when it recorded it, else told here before the
   * turn starts; one sent while a turn runs or a permission waits is told
   * here: queued, then taken once the agent took it (the user's message
   * from then on), or cancelled. */
  async prompt(p: PromptParams, signal: AbortSignal): Promise<void> {
    if (isCompact(p.content)) return this.compact(signal);
    const input = toUserInput(p.content);
    const msg: Message = { content: p.content, message: p.message || newID(), clientId: p.clientId };
    if (!(await this.lock.acquire(signal))) throw new ChatProtoError(callError(new AbortedError(signal.reason)));
    try {
      if (this.ended || this.closing) throw errEnded();
      const a = this.ask;
      if (a) {
        // The host saw a permission waiting: the message is told as queued
        // and taken.
        a.superseded = true;
        a.ac.abort();
        await until(a.done, signal);
        // The host stored the message's user event, and stores the turn's
        // error.
        if (p.recorded) return await this.startTurn(input, msg.message, signal);
        this.emit(queuedEvent(msg, QueuedState.Waiting, true), queuedEvent(msg, QueuedState.Taken, false));
        return await this.startTold(input, msg.message, signal);
      }
      if (!this.active && p.recorded) return await this.startTurn(input, msg.message, signal);
      if (!this.active) {
        // The host saw a turn run, which ended meanwhile: the message starts
        // the next, told here.
        this.emit(userEvent(msg));
        return await this.startTold(input, msg.message, signal);
      }
      if (this.turn === '' || this.compacting) {
        this.queue.push(msg);
        this.emit(queuedEvent(msg, QueuedState.Waiting, true));
        return;
      }
      const c = this.c!;
      const params: ClientRequests['turn/steer']['params'] = {
        threadId: this.thread,
        expectedTurnId: this.turn,
        clientUserMessageId: msg.message,
        input,
      };
      this.emit(queuedEvent(msg, QueuedState.Waiting, true));
      this.steers.push(msg);
      try {
        await c.conn.call('turn/steer', params, signal);
        return;
      } catch (err) {
        const taken = !this.steers.some((m) => m.message === msg.message);
        this.steers = this.steers.filter((m) => m.message !== msg.message);
        // The turn ended meanwhile and told it taken.
        if (taken) return;
        if (err instanceof RpcError && err.message.startsWith('no active turn')) {
          // The turn ended before the message reached it: it starts the
          // next, which this session told as its message.
          this.emit(queuedEvent(msg, QueuedState.Taken, false));
          return await this.startTold(input, msg.message, signal);
        }
        if (err instanceof RpcError && this.active) {
          // The turn takes no steering: the message waits for its end.
          this.queue.push(msg);
          return;
        }
        this.emit(queuedEvent(msg, QueuedState.Cancelled, false));
        throw new ChatProtoError(callError(err));
      }
    } finally {
      this.lock.release();
    }
  }

  /** Sends turn/start; the lock is held. */
  private async startTurn(input: UserInput[], clientMessage: string, signal: AbortSignal): Promise<void> {
    if (this.ended || this.closing) throw errEnded();
    const params = turnParams(this.thread, this.p.cwd, clientMessage, input, this.st);
    this.active = true;
    this.turn = '';
    this.compacting = false;
    this.promptId = clientMessage;
    this.skipUser = true;
    const c = this.c!;
    let res: ClientRequests['turn/start']['result'];
    try {
      res = await c.conn.call('turn/start', params, signal);
    } catch (err) {
      this.active = false;
      this.promptId = '';
      this.skipUser = false;
      throw new ChatProtoError(callError(err));
    }
    if (this.active && this.turn === '' && isObj(res) && isObj(res.turn) && typeof res.turn.id === 'string') this.turn = res.turn.id;
  }

  /** Starts a turn whose message this session told the host (its user
   * event, or queued taken): a turn that does not start ends in an error
   * the log keeps, as the host does for the messages it told. The lock is
   * held. */
  private async startTold(input: UserInput[], clientMessage: string, signal: AbortSignal): Promise<void> {
    try {
      await this.startTurn(input, clientMessage, signal);
    } catch (err) {
      this.emit({ t: EventType.Turn, state: TurnState.Error, error: callError(err) });
      throw err;
    }
  }

  /** Starts a turn with the messages that waited for the last one's end. */
  async sendQueued(queue: Message[]): Promise<void> {
    // Never sent once the session ends: its end told the queue it had then,
    // not these.
    const unsent = () => this.emit(...queue.map((m) => queuedEvent(m, QueuedState.Cancelled, false)));
    if (!(await this.lock.acquire(this.ac.signal))) return unsent();
    try {
      if (this.ended || this.closing) return unsent();
      if (this.active) {
        this.queue = [...queue, ...this.queue];
        return;
      }
      const input: UserInput[] = [];
      const evs: Event[] = [];
      for (const m of queue) {
        try {
          input.push(...toUserInput(m.content));
          evs.push(queuedEvent(m, QueuedState.Taken, false));
        } catch {
          evs.push(queuedEvent(m, QueuedState.Cancelled, false));
        }
      }
      this.emit(...evs);
      if (input.length === 0) return;
      try {
        await this.startTurn(input, queue[0]!.message, this.ac.signal);
      } catch (e) {
        const message = callError(e).message;
        this.logf(`sending the queued messages: ${message}`);
        this.emit(noticeEvent(Notice.Error, '', { message }));
      }
    } finally {
      this.lock.release();
    }
  }

  /** Interrupts the running turn; the permissions and questions that wait
   * and the queued messages go with it. A command the turn started still
   * runs after the interrupt: the app-server is started again if one does
   * interruptGrace later. */
  async cancel(signal: AbortSignal): Promise<void> {
    if (this.ended) return;
    const ask = this.ask;
    const queue = this.queue;
    this.queue = [];
    const pend = this.takePending();
    const active = this.active;
    this.emit(...queue.map((m) => queuedEvent(m, QueuedState.Cancelled, false)));
    for (const p of pend) p.ac.abort();
    ask?.ac.abort();
    if (!active) return;
    // The turn's id comes with turn/start's answer (or turn/started, for a
    // compaction).
    while (this.turn === '' && this.active) await sleep(20, signal);
    const turn = this.turn;
    const c = this.c;
    if (turn === '' || !c) return;
    let err: unknown;
    try {
      await c.conn.call('turn/interrupt', { threadId: this.thread, turnId: turn }, signal);
    } catch (e) {
      err = e;
    }
    const timer = setTimeout(() => {
      if (!this.ended && !this.closing && this.commandRuns()) void this.restart();
    }, this.t.interruptGrace);
    timer.unref?.();
    if (err !== undefined) throw new ChatProtoError(callError(err));
  }

  /** Withdraws a message that waits for the turn's end; one steered into
   * the turn reached the agent already. */
  async cancelQueued(message: string): Promise<void> {
    const i = this.queue.findIndex((m) => m.message === message);
    if (i < 0) throw perr(Code.NotFound, 'no such queued message');
    const [m] = this.queue.splice(i, 1);
    this.emit(queuedEvent(m!, QueuedState.Cancelled, false));
  }

  /** Sets the model, the effort or the permission mode of the turns to
   * come: Codex takes them with each turn. */
  async setConfig(id: string, value: string): Promise<void> {
    if (this.ended) throw errEnded();
    const bad = (message: string) => perr(Code.BadRequest, message);
    switch (id) {
      case Opt.Model:
        if (!this.models.find(value) && value !== this.st.model) throw bad('no such model: ' + cutText(value, 128));
        this.st.model = value;
        this.st.effort = this.models.effortFor(value, this.st.effort, '');
        break;
      case Opt.Effort:
        if (!hasEffort(this.models.efforts(this.st.model) ?? [], value)) throw bad('no such effort for the model: ' + cutText(value, 64));
        this.st.effort = value;
        break;
      case Opt.Mode:
        if (!isMode(value)) throw bad('no such mode: ' + cutText(value, 64));
        this.st.mode = value;
        break;
      default:
        throw bad('no such option: ' + cutText(id, 64));
    }
    this.sink.update(this.chatUpdate());
  }

  /** What the chat states of the session now. */
  chatUpdate(): (c: chat.Chat) => void {
    const thread = this.thread;
    const version = this.version;
    const config = this.models.configOptions(this.st);
    const caps = this.models.capabilities(this.st);
    return (c) => {
      c.sessionId = thread;
      if (version) c.agentVersion = version;
      else delete c.agentVersion;
      c.config = config;
      c.commands = COMMANDS.map((x) => ({ ...x }));
      c.capabilities = { ...caps };
    };
  }

  /** Compacts the thread's context: Codex does it in a turn of its own. */
  async compact(signal: AbortSignal): Promise<void> {
    if (!(await this.lock.acquire(signal))) throw new ChatProtoError(callError(new AbortedError(signal.reason)));
    try {
      if (this.ended || this.closing) throw errEnded();
      if (this.active || this.ask) throw perr(Code.Busy, 'a turn runs');
      this.active = true;
      this.turn = '';
      this.compacting = true;
      this.promptId = '';
      this.skipUser = false;
      const c = this.c!;
      try {
        await c.conn.call('thread/compact/start', { threadId: this.thread }, signal);
      } catch (err) {
        if (this.turn === '') {
          this.active = false;
          this.compacting = false;
        }
        throw new ChatProtoError(callError(err));
      }
    } finally {
      this.lock.release();
    }
  }

  /** Ends the app-server gracefully: its input closed, SIGTERM and SIGKILL
   * only after their waits. Resolves once it is gone or signal ends. */
  async close(signal?: AbortSignal): Promise<void> {
    if (this.ended) return;
    this.closing = true;
    this.ask?.ac.abort();
    if (!this.c) return this.finish(undefined);
    void this.c.proc.stop(this.t);
    if (!signal) {
      await this.done;
      return;
    }
    await until(this.done, signal).catch(() => {});
  }

  // ---- what the app-server sends ----

  /** Whether srv is the session's app-server. */
  private current(srv: AppServer): boolean {
    return srv === this.c && !this.ended;
  }

  /** The tool call of the subagent a thread is, "" for the session's own
   * thread; a subagent's thread the session did not see start is its own
   * parent. */
  private parentOf(thread: unknown): { parent: string; main: boolean } {
    if (typeof thread !== 'string' || thread === '' || thread === this.thread) return { parent: '', main: true };
    const ch = this.children.get(thread);
    return { parent: ch ? ch.call : thread, main: false };
  }

  private notification(srv: AppServer, method: string, params: unknown, at: number): void {
    if (!this.current(srv)) return;
    if (!isObj(params)) {
      srv.conn.passedOver(method);
      return;
    }
    const evs: Event[] = [];
    let after: (() => void) | null = null;
    switch (method) {
      case 'turn/started': {
        const n = params as ServerNotifications['turn/started'];
        if (this.parentOf(n.threadId).main && isObj(n.turn) && typeof n.turn.id === 'string' && n.turn.id !== '') {
          this.active = true;
          this.turn = n.turn.id;
          evs.push({ t: EventType.Turn, ...(timeOf(at) ? { at: timeOf(at) } : {}), item: n.turn.id, state: TurnState.Start });
        }
        break;
      }
      case 'turn/completed': {
        const n = params as ServerNotifications['turn/completed'];
        if (this.parentOf(n.threadId).main && isObj(n.turn)) {
          const r = this.turnCompleted(n.turn, at);
          evs.push(...r.evs);
          after = r.after;
        }
        break;
      }
      case 'item/started':
      case 'item/completed':
        evs.push(...this.itemEvent(srv, params as ItemCompletedNotification, method === 'item/completed', at));
        break;
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
      case 'item/commandExecution/outputDelta':
        evs.push(...this.delta(method, params, at));
        break;
      case 'thread/tokenUsage/updated': {
        const n = params as ServerNotifications['thread/tokenUsage/updated'];
        if (this.parentOf(n.threadId).main && isObj(n.tokenUsage)) {
          const used = n.tokenUsage.last?.totalTokens;
          const w = n.tokenUsage.modelContextWindow;
          this.usage.used = typeof used === 'number' ? used : 0;
          if (typeof w === 'number' && w > 0) this.usage.size = w;
          delete this.usage.percentage;
          if (this.usage.size > 0) this.usage.percentage = (this.usage.used * 100) / this.usage.size;
          this.dirty = true;
          after = this.flushUsage(false);
        }
        break;
      }
      case 'account/rateLimits/updated': {
        const n = params as ServerNotifications['account/rateLimits/updated'];
        if (isObj(n.rateLimits)) {
          this.rateLimits(n.rateLimits);
          after = this.flushUsage(false);
        }
        break;
      }
      case 'thread/name/updated': {
        const n = params as ServerNotifications['thread/name/updated'];
        if (n.threadId === this.thread && typeof n.threadName === 'string') {
          const name = cutText(n.threadName, 512);
          evs.push(updateEvent('', '', false, { sessionUpdate: 'session_info_update', title: name }, at));
          after = () => this.sink.update((c) => void (c.title = name));
        }
        break;
      }
      case 'error': {
        const n = params as ServerNotifications['error'];
        if (!isObj(n.error)) break;
        const { parent, main } = this.parentOf(n.threadId);
        const message = typeof n.error.message === 'string' ? n.error.message : '';
        if (n.willRetry) evs.push(noticeEvent(Notice.Error, parent, { message, willRetry: true }, at));
        else if (main) this.lastErr = n.error;
        else evs.push(noticeEvent(Notice.Error, parent, { message }, at));
        break;
      }
      case 'serverRequest/resolved': {
        const n = params as ServerNotifications['serverRequest/resolved'];
        const p = this.pending.get(pendingKey(srv, JSON.stringify(n.requestId) ?? ''));
        if (p) {
          p.resolved = true;
          p.ac.abort();
        }
        break;
      }
      default:
        if (!QUIET.has(method)) srv.conn.passedOver(method);
    }
    this.emit(...evs);
    after?.();
  }

  /** The events of an item/started or item/completed. */
  private itemEvent(srv: AppServer, n: ItemCompletedNotification, completed: boolean, at: number): Event[] {
    const it = n.item as ThreadItem | undefined;
    if (!isObj(it) || typeof it.id !== 'string' || it.id === '') {
      const type = isObj(it) && typeof it.type === 'string' ? it.type : '';
      srv.conn.passedOver('item ' + cutText(type, 64));
      return [];
    }
    const { parent, main } = this.parentOf(n.threadId);
    switch (it.type) {
      case ItemType.UserMessage:
        return completed ? this.userMessage(it, parent, main, at) : [];
      case ItemType.SubAgent:
        return this.subAgent(it, parent, completed, at);
      case ItemType.CollabTool:
        if (it.tool === 'spawnAgent')
          for (const t of Array.isArray(it.receiverThreadIds) ? it.receiverThreadIds : [])
            if (!this.children.has(t)) setBounded(this.children, t, { call: it.id, parent, state: collabCall(it) });
        break;
      case ItemType.Plan:
        if (completed && main) this.plan = { id: it.id, text: strOf(it.text) };
        break;
    }
    const evs = this.m.itemEvents(it, completed, parent, at);
    if (evs === null) {
      srv.conn.passedOver('item ' + cutText(String(it.type), 64));
      return [];
    }
    if (isTool(it.type) && evs.length === 1) {
      if (completed) this.items.delete(it.id);
      else setBounded(this.items, it.id, { type: it.type, item: it, parent, last: evs[0]!.update as Obj, shown: true });
    }
    return evs;
  }

  /** A user message of the thread: the prompt of a turn the host started
   * (the host told it), a message steered into the turn (taken), or one the
   * session did not send (told as the user's). */
  private userMessage(it: Extract<ThreadItem, { type: 'userMessage' }>, parent: string, main: boolean, fallback: number): Event[] {
    const at = timeOf(itemTime(it, fallback));
    const time = at ? { at } : {};
    if (!main) return [{ t: EventType.User, ...time, item: it.id, ...(parent ? { parent } : {}), content: userContent(it.content) }];
    const cid = typeof it.clientId === 'string' ? it.clientId : '';
    // A steered message taken is the user's message from then on (the UIs
    // make it one of its queued event).
    const take = (i: number): Event[] => {
      const [m] = this.steers.splice(i, 1);
      return [{ ...queuedEvent(m!, QueuedState.Taken, false), ...time }];
    };
    if ((cid !== '' && cid === this.promptId) || (cid === '' && this.skipUser)) {
      this.promptId = '';
      this.skipUser = false;
      return [];
    }
    if (cid !== '') {
      const i = this.steers.findIndex((m) => m.message === cid);
      if (i >= 0) return take(i);
    }
    if (this.skipUser) {
      // Codex gave the prompt another client id.
      this.promptId = '';
      this.skipUser = false;
      return [];
    }
    if (this.steers.length > 0) return take(0);
    return [{ t: EventType.User, ...time, item: it.id, content: userContent(it.content) }];
  }

  /** A subagent's activity: its start is a tool call its thread's events
   * belong to, which its end completes. */
  private subAgent(it: Extract<ThreadItem, { type: 'subAgentActivity' }>, parent: string, completed: boolean, fallback: number): Event[] {
    const at = itemTime(it, fallback);
    switch (it.kind) {
      case SubAgent.Started: {
        if (this.children.has(it.agentThreadId) && completed) return [];
        const u = subAgentCall(it, Tool.InProgress);
        if (it.agentThreadId) setBounded(this.children, it.agentThreadId, { call: it.id, parent, state: u });
        return [updateEvent(it.id, parent, false, u, at)];
      }
      case SubAgent.Completed:
      case SubAgent.Stopped: {
        const ch = this.children.get(it.agentThreadId);
        if (!completed || !ch) return [];
        const u = cancelledCall(ch.state);
        u.status = it.kind === SubAgent.Stopped ? Tool.Cancelled : Tool.Completed;
        return [updateEvent(ch.call, ch.parent, false, u, at)];
      }
    }
    return [];
  }

  /** A streamed increment as a live event. */
  private delta(method: string, params: Obj, at: number): Event[] {
    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (itemId === '') return [];
    const { parent } = this.parentOf(params.threadId);
    let u: Obj;
    switch (method) {
      case 'item/agentMessage/delta':
        u = chunk(AGENT_MESSAGE_CHUNK, delta, itemId);
        break;
      case 'item/plan/delta':
        u = chunk(AGENT_MESSAGE_CHUNK, delta, itemId);
        setMeta(u, 'plan', true);
        break;
      case 'item/reasoning/summaryTextDelta':
        u = chunk(AGENT_THOUGHT_CHUNK, delta, itemId);
        break;
      case 'item/reasoning/summaryPartAdded':
        if (!params.summaryIndex) return [];
        u = chunk(AGENT_THOUGHT_CHUNK, '\n\n', itemId);
        break;
      default: {
        const oi = this.items.get(itemId);
        if (!oi?.shown) return [];
        u = { sessionUpdate: 'tool_call_update', toolCallId: itemId, content: [{ type: 'content', content: textBlock(delta) }] };
      }
    }
    if (delta === '' && method !== 'item/reasoning/summaryPartAdded') return [];
    return [updateEvent(itemId, parent, true, u, at)];
  }

  /** The stored state of a tool call that will not complete. */
  private cancelledEvent(id: string, oi: OpenItem): Event {
    oi.shown = false;
    return updateEvent(id, oi.parent, false, cancelledCall(isObj(oi.last) ? oi.last : { toolCallId: id }));
  }

  /** Ends the session's turn. A turn that made a plan in plan mode ends once
   * the plan's approval is answered. */
  private turnCompleted(t: Turn, at: number): { evs: Event[]; after: () => void } {
    // Steered into the turn, never shown as an item.
    const evs: Event[] = this.steers.map((m) => queuedEvent(m, QueuedState.Taken, false));
    this.steers = [];
    if (t.status !== 'completed') {
      for (const id of [...this.items.keys()].sort()) {
        const oi = this.items.get(id)!;
        if (oi.shown) evs.push(this.cancelledEvent(id, oi));
      }
    }
    const plan = this.plan;
    this.plan = { id: '', text: '' };
    const queue = this.queue;
    this.queue = [];
    const lastErr = this.lastErr;
    this.active = false;
    this.turn = '';
    this.compacting = false;
    this.promptId = '';
    this.skipUser = false;
    this.lastErr = null;
    const flush = this.flushUsage(true)!;
    evs.push(turnEnd(t, lastErr, at));
    if (t.status === 'completed' && plan.text !== '' && this.st.mode === Mode.Plan && queue.length === 0 && !this.closing) {
      // The turn ends first: its end cancels what was asked in it.
      let resolve!: () => void;
      const a: PlanAsk = { ac: new AbortController(), done: new Promise((r) => (resolve = r)), superseded: false };
      this.ask = a;
      return {
        evs,
        after: () => {
          flush();
          void this.askPlan(a, resolve, plan.id, plan.text);
        },
      };
    }
    return {
      evs,
      after: () => {
        flush();
        if (queue.length === 0) return;
        if (t.status === 'interrupted') {
          this.emit(...queue.map((m) => queuedEvent(m, QueuedState.Cancelled, false)));
          return;
        }
        void this.sendQueued(queue);
      },
    };
  }

  /** Asks to approve the plan of the turn that just ended. Approved, the
   * plan is carried out in the mode chosen, in the next turn; refused, the
   * chat goes on planning. */
  private async askPlan(a: PlanAsk, settle: () => void, planId: string, text: string): Promise<void> {
    const tc = {
      toolCallId: planId,
      title: 'Plan',
      kind: 'switch_mode',
      status: Tool.Pending,
      content: [{ type: 'content', content: textBlock(text) }],
      rawInput: { plan: text },
    };
    let ans: PermissionAnswer;
    try {
      ans = await this.sink.permission(
        { kind: chat.PermissionKind.Plan, toolCall: tc, options: PLAN_OPTIONS, parent: '' },
        AbortSignal.any([a.ac.signal, this.ac.signal]),
      );
    } catch {
      ans = { cancelled: true };
    }
    a.ac.abort();
    if (this.ask === a) this.ask = null;
    settle();
    if (ans.cancelled || a.superseded || !ans.option.startsWith(OPTION_PLAN_PREFIX)) return;
    const mode = ans.option.slice(OPTION_PLAN_PREFIX.length);
    if (mode === Mode.Plan || !isMode(mode)) return;
    if (!(await this.lock.acquire(this.ac.signal))) return;
    try {
      if (this.ended || this.closing || this.active || a.superseded) return;
      this.st.mode = mode;
      this.sink.update(this.chatUpdate());
      this.emit(userEvent({ content: [textBlock(IMPLEMENT_PLAN)], message: '', clientId: '' }));
      try {
        await this.startTurn([{ type: 'text', text: IMPLEMENT_PLAN, text_elements: [] }], '', this.ac.signal);
      } catch (e) {
        const message = callError(e).message;
        this.logf(`carrying out the plan: ${message}`);
        this.emit(noticeEvent(Notice.Error, '', { message }));
      }
    } finally {
      this.lock.release();
    }
  }

  /** Takes a rolling update of the account's rate limits: a window it does
   * not state keeps its last value. */
  private rateLimits(r: RateLimitSnapshot): void {
    const id = typeof r.limitId === 'string' && r.limitId !== '' ? cutText(r.limitId, 64) : 'codex';
    if (!this.limits.has(id) && this.limits.size >= 16) return;
    const old = this.limits.get(id) ?? [];
    const label = typeof r.limitName === 'string' ? cutText(r.limitName, 128) : '';
    const out: chat.Limit[] = [];
    for (const [w, suffix] of [
      [r.primary, '.primary'],
      [r.secondary, '.secondary'],
    ] as const) {
      const lid = id + suffix;
      if (!isObj(w)) {
        const kept = old.find((l) => l.id === lid);
        if (kept) out.push(kept);
        continue;
      }
      const l: chat.Limit = { id: lid, ...(label ? { label } : {}), usedPercent: typeof w.usedPercent === 'number' ? w.usedPercent : 0 };
      if (typeof w.resetsAt === 'number' && w.resetsAt !== 0) l.resetsAt = w.resetsAt;
      if (typeof w.windowDurationMins === 'number' && w.windowDurationMins !== 0) l.windowMinutes = w.windowDurationMins;
      out.push(l);
    }
    this.limits.set(id, out);
    this.dirty = true;
  }

  /** What sends the usage to the host, when it changed and the last went
   * usageEvery ago or force; null for nothing. */
  private flushUsage(force: boolean): (() => void) | null {
    if (!this.dirty || (!force && Date.now() - this.flushed < this.t.usageEvery)) return force ? () => {} : null;
    this.dirty = false;
    this.flushed = Date.now();
    const u: Usage = { ...this.usage };
    const limits = [...this.limits.keys()].sort().flatMap((id) => this.limits.get(id)!.map((l) => ({ ...l })));
    if (limits.length > 0) u.limits = limits;
    return () => this.sink.update((c) => void (c.usage = u));
  }

  // ---- requests of the app-server ----

  /** Answers a request of the app-server: approvals and questions are the
   * user's, the others are refused. */
  private request(srv: AppServer, r: ServerRequest): void {
    if (!this.current(srv)) return refuse(r);
    switch (r.method) {
      case M.CommandApproval:
      case M.FileChangeApproval:
      case M.RequestUserInput: {
        // Registered before the next line is read: serverRequest/resolved
        // may follow at once.
        const p: Pending = { ac: new AbortController(), resolved: false };
        const key = pendingKey(srv, r.key);
        this.pending.set(key, p);
        const ask =
          r.method === M.RequestUserInput
            ? this.askQuestions(r, p)
            : this.askApproval(r, p, r.method === M.CommandApproval ? chat.PermissionKind.Command : chat.PermissionKind.File);
        void ask
          .catch((e: unknown) => {
            this.logf(`answering ${r.method}: ${(e as Error).message}`);
            if (!p.resolved) refuse(r);
          })
          .finally(() => {
            if (this.pending.get(key) === p) this.pending.delete(key);
            p.ac.abort();
          });
        return;
      }
    }
    refuse(r);
  }

  /** The signal of a request that waits: it ends with the request, the
   * session, or the app-server settling it on its own. */
  private waitSignal(p: Pending): AbortSignal {
    return AbortSignal.any([p.ac.signal, this.ac.signal]);
  }

  /** Asks the user to allow a command or a change of files. */
  private async askApproval(r: ServerRequest, p: Pending, kind: string): Promise<void> {
    const params = (isObj(r.params) ? r.params : {}) as Partial<ServerRequests[typeof M.CommandApproval]['params']> &
      Partial<ServerRequests[typeof M.FileChangeApproval]['params']>;
    const { parent } = this.parentOf(params.threadId);
    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    const oi = this.items.get(itemId);
    const input: Obj = {};
    if (params.reason) input.reason = params.reason;
    let tc: Obj;
    if (kind === chat.PermissionKind.Command) {
      let script = shellScript(strOf(params.command), params.commandActions);
      if (script === '' && oi?.item.type === ItemType.Command) script = shellScript(strOf(oi.item.command), oi.item.commandActions);
      tc = toolCall(itemId, script, 'execute', Tool.Pending);
      input.command = script;
      if (params.cwd) input.cwd = params.cwd;
      if (params.networkApprovalContext !== undefined && params.networkApprovalContext !== null)
        input.network = params.networkApprovalContext;
    } else {
      tc = toolCall(itemId, '', 'edit', Tool.Pending);
      if (oi?.item.type === ItemType.FileChange) {
        const { content, locations, titles } = fileDiffs(oi.item.changes, this.m);
        tc.title = cutText(titles.join(', '), MAX_TITLE);
        if (content.length > 0) {
          tc.content = content;
          tc.locations = locations;
        }
      }
      if (params.grantRoot) input.grantRoot = params.grantRoot;
    }
    tc.rawInput = input;
    let ans: PermissionAnswer;
    try {
      ans = await this.sink.permission({ kind, toolCall: tc, options: PERMISSION_OPTIONS, parent }, this.waitSignal(p));
    } catch {
      ans = { cancelled: true };
    }
    if (p.resolved) return;
    let decision: ServerRequests[typeof M.CommandApproval]['result']['decision'] &
      ServerRequests[typeof M.FileChangeApproval]['result']['decision'] = 'cancel';
    if (!ans.cancelled) {
      switch (ans.option) {
        case OPTION_ALLOW_ONCE:
          decision = 'accept';
          break;
        case OPTION_ALLOW_SESSION:
          // Never an execpolicy or network amendment: those are saved.
          decision = 'acceptForSession';
          break;
        default:
          decision = 'decline';
      }
    }
    r.reply({ decision });
  }

  /** Asks the user the questions of request_user_input (plan mode's);
   * skipped, they are answered with no answers. A question without options
   * takes the user's own words, whatever its isOther says: it could not be
   * answered otherwise. */
  private async askQuestions(r: ServerRequest, p: Pending): Promise<void> {
    const params = (isObj(r.params) ? r.params : {}) as Partial<ServerRequests[typeof M.RequestUserInput]['params']>;
    const qs: chat.Question[] = [];
    const ids = new Set<string>();
    for (const q of Array.isArray(params.questions) ? params.questions : []) {
      if (!isObj(q)) continue;
      const options = Array.isArray(q.options) ? q.options : [];
      const cq: chat.Question = { id: q.id, ...(q.header ? { header: q.header } : {}), question: q.question };
      if (q.isOther || options.length === 0) cq.allowOther = true;
      if (q.isSecret) cq.secret = true;
      if (options.length > 0)
        cq.options = options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) }));
      qs.push(cq);
      ids.add(q.id);
    }
    const { parent } = this.parentOf(params.threadId);
    let ans: QuestionAnswer;
    try {
      ans = await this.sink.question({ questions: qs, parent }, this.waitSignal(p));
    } catch {
      ans = { cancelled: true };
    }
    if (p.resolved) return;
    const answers: ServerRequests[typeof M.RequestUserInput]['result']['answers'] = {};
    if (!ans.cancelled) for (const [id, a] of Object.entries(ans.answers)) if (ids.has(id)) answers[id] = { answers: a };
    r.reply({ answers });
  }

  /** The session's error, once it ended (tests). */
  get error(): ChatError | undefined {
    return this.err;
  }
}

/** The key of a request that waits: its app-server's and its id's. */
const pendingKey = (srv: AppServer, id: string): string => `${srv.serial}/${id}`;
