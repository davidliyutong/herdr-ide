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
  type HandoffMessage,
  type PermissionAnswer,
  type PromptParams,
  type QuestionAnswer,
  type RewindParams,
  type RewindResult,
  type Session,
  type Sink,
  type StartParams,
} from '../adapter.ts';
import type { AgentProcess, StopTiming } from '../agentproc.ts';
import { markUsageStale } from '../runtime.ts';
import type {
  ClientRequests,
  ItemCompletedNotification,
  Model,
  RateLimitSnapshot,
  ResponseItem,
  ServerNotificationMethod,
  ServerNotifications,
  ServerRequests,
  ThreadBackgroundTerminal,
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
  asyncQuestions,
  callWithStatus,
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
  toolStatus,
  turnEnd,
  updateEvent,
  userContent,
  MAX_TITLE,
  type AsyncQuestion,
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
const MAX_QUEUE = 16;
const BACKGROUND_POLL_MS = 2000;

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
 * fails unless strict is true (Op.Models). */
export async function listModels(c: Conn, signal: AbortSignal, logf: (l: string) => void, strict = false): Promise<Models> {
  const out: Model[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    let res: ClientRequests['model/list']['result'];
    try {
      res = await c.call('model/list', modelListParams(cursor), signal);
    } catch (e) {
      if (strict) throw e;
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
  handoffContext?: string;
  message: string;
  clientId: string;
}

const wireBlocks = (content: unknown[], handoffContext?: string): unknown[] =>
  handoffContext ? [{ type: 'text', text: handoffContext }, ...content] : content;

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

/** A subagent's thread: the tool call that started it and its live run state. */
interface Child {
  call: string;
  parent: string;
  state: Obj;
  agentPath: string;
  turnId: string;
  running: boolean;
  startedAt?: string;
}

/** A request of the app-server that waits for the user. */
interface Pending {
  ac: AbortController;
  /** The app-server settled it on its own (serverRequest/resolved). */
  resolved: boolean;
  /** Non-blocking requestUserInput: survives Turn.End and does not block. */
  async?: boolean;
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
  private readonly bgTerminals = new Map<string, ThreadBackgroundTerminal>();
  private hasProcessIds = false;
  private bgSyncing = false;
  private bgSyncAgain = false;
  private bgTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTasksJson = '';
  private keepQueueOnInterrupt = false;
  private drainOnInterrupt = false;
  private plan = { id: '', text: '' };
  private ask: PlanAsk | null = null;
  private asyncAsk: PlanAsk | null = null;
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
        if (!isMode(mode)) mode = this.p.settings.defaultModes?.[this.p.kind] ?? this.p.settings.defaultMode;
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
    clearTimeout(this.bgTimer);
    this.err = err;
    const evs: Event[] = [];
    if (this.ask) {
      this.ask.superseded = true;
      this.ask.ac.abort();
    }
    this.ask = null;
    this.supersedeAsyncAsk();
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
    this.keepQueueOnInterrupt = false;
    this.drainOnInterrupt = false;
    this.active = false;
    this.turn = '';
    this.bgTerminals.clear();
    for (const ch of this.children.values()) {
      if (ch.running) evs.push(this.finishChild(ch, Tool.Cancelled));
    }
    if (this.lastTasksJson !== '') {
      this.lastTasksJson = '';
      this.sink.update((c) => {
        delete c.tasks;
      });
    }
    const pend = this.takePending();
    for (const p of pend) p.ac.abort();
    this.ac.abort();
    this.emit(...evs);
    this.resolveDone(err);
    this.forget(this);
  }

  /** Empties the requests that wait (or only blocking ones when blockingOnly). */
  private takePending(blockingOnly = false): Pending[] {
    if (!blockingOnly) {
      const out = [...this.pending.values()];
      this.pending.clear();
      return out;
    }
    const out: Pending[] = [];
    for (const [k, p] of this.pending) {
      if (p.async) continue;
      this.pending.delete(k);
      out.push(p);
    }
    return out;
  }

  /** Supersedes an open non-blocking async question ask, if any. */
  private supersedeAsyncAsk(): void {
    const a = this.asyncAsk;
    if (!a) return;
    a.superseded = true;
    a.ac.abort(chat.By.Superseded);
    this.asyncAsk = null;
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
      for (const ch of this.children.values()) {
        if (ch.running) this.emit(this.finishChild(ch, Tool.Cancelled));
      }
      this.children.clear();
      this.bgTerminals.clear();
      this.hasProcessIds = false;
      clearTimeout(this.bgTimer);
      this.bgTimer = undefined;
      this.publishTasks();
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

  /** Starts a turn; while one runs, p.delivery selects FIFO queuing (default,
   * withdrawable via cancelQueued), mid-turn steering (turn/steer), or
   * interrupting the active turn while preserving unrelated queued messages.
   * A prompt while a plan waits for its approval keeps planning with it. A
   * prompt that starts a turn is the host's to tell (its user event) when it
   * recorded it, else told here before the turn starts; one sent while a turn
   * runs or a permission waits is told here: queued, then taken once the
   * agent took it (the user's message from then on), or cancelled. */
  async prompt(p: PromptParams, signal: AbortSignal): Promise<void> {
    if (isCompact(p.content)) return this.compact(signal);
    const input = toUserInput(wireBlocks(p.content, p.handoffContext));
    const delivery = p.delivery ?? chat.Delivery.Queue;
    const msg: Message = {
      content: p.content,
      ...(p.handoffContext ? { handoffContext: p.handoffContext } : {}),
      message: p.message || newID(),
      clientId: p.clientId,
    };
    let doInterrupt = false;
    if (!(await this.lock.acquire(signal))) throw new ChatProtoError(callError(new AbortedError(signal.reason)));
    try {
      if (this.ended || this.closing) throw errEnded();
      this.supersedeAsyncAsk();
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
      if (this.queue.length + this.steers.length >= MAX_QUEUE) throw perr(Code.Busy, 'too many messages wait for the turn');
      if (delivery === chat.Delivery.Interrupt) {
        this.queue.unshift(msg);
        this.emit(queuedEvent(msg, QueuedState.Waiting, true));
        this.keepQueueOnInterrupt = true;
        this.drainOnInterrupt = true;
        doInterrupt = true;
      } else if (delivery === chat.Delivery.Steer && this.turn !== '' && !this.compacting) {
        return await this.steerMessage(msg, input, true, signal);
      } else {
        this.queue.push(msg);
        this.emit(queuedEvent(msg, QueuedState.Waiting, true));
        return;
      }
    } finally {
      this.lock.release();
    }
    if (doInterrupt) {
      for (const pend of this.takePending(true)) pend.ac.abort();
      await this.interruptActiveTurn(signal);
    }
  }

  /** Steers msg into the active turn via turn/steer; the lock is held. When
   * restoreAt is set (steerQueued), an active-turn RPC rejection puts msg
   * back into this.queue and throws; otherwise (prompt delivery: steer) it
   * falls back to waiting in this.queue. */
  private async steerMessage(
    msg: Message,
    input: UserInput[],
    emitWaiting: boolean,
    signal: AbortSignal,
    restoreAt?: number,
  ): Promise<void> {
    const c = this.c!;
    const params: ClientRequests['turn/steer']['params'] = {
      threadId: this.thread,
      expectedTurnId: this.turn,
      clientUserMessageId: msg.message,
      input,
    };
    if (emitWaiting) this.emit(queuedEvent(msg, QueuedState.Waiting, true));
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
        if (restoreAt !== undefined) {
          this.queue.splice(Math.min(restoreAt, this.queue.length), 0, msg);
          throw new ChatProtoError(callError(err));
        }
        // The turn takes no steering: the message waits for its end.
        this.queue.push(msg);
        return;
      }
      this.emit(queuedEvent(msg, QueuedState.Cancelled, false));
      throw new ChatProtoError(callError(err));
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
          input.push(...toUserInput(wireBlocks(m.content, m.handoffContext)));
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
   * go with it, and the queued messages too unless opts.keepQueue is true.
   * A command the turn started still runs after the interrupt: the app-server
   * is started again if one does interruptGrace later. */
  async cancel(signal: AbortSignal, opts?: { keepQueue?: boolean }): Promise<void> {
    if (this.ended) return;
    const keepQueue = opts?.keepQueue === true;
    const ask = this.ask;
    this.supersedeAsyncAsk();
    let queue: Message[] = [];
    if (!keepQueue) {
      queue = this.queue;
      this.queue = [];
      this.keepQueueOnInterrupt = false;
      this.drainOnInterrupt = false;
    } else {
      this.keepQueueOnInterrupt = true;
      this.drainOnInterrupt = false;
    }
    const pend = this.takePending(keepQueue);
    const active = this.active;
    if (queue.length > 0) this.emit(...queue.map((m) => queuedEvent(m, QueuedState.Cancelled, false)));
    for (const p of pend) p.ac.abort();
    ask?.ac.abort();
    if (!active) return;
    await this.interruptActiveTurn(signal);
  }

  /** Sends turn/interrupt for the active turn and arms the interruptGrace
   * restart fallback if a shell command outlives the interrupt. */
  private async interruptActiveTurn(signal: AbortSignal): Promise<void> {
    // The turn's id comes with turn/start's answer (or turn/started, for a
    // compaction).
    while (this.turn === '' && this.active && !this.ended && !this.closing) await sleep(20, signal);
    const turn = this.turn;
    const c = this.c;
    if (!this.active || turn === '' || !c) return;
    let err: unknown;
    try {
      await c.conn.call('turn/interrupt', { threadId: this.thread, turnId: turn }, signal);
    } catch (e) {
      err = e;
    }
    const timer = setTimeout(() => {
      if (!this.ended && !this.closing && !this.active && this.commandRuns()) void this.restart();
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

  /** Promotes an already-queued message to steer into the active turn or
   * interrupt the active turn and run next while keeping other queued
   * messages in order. */
  async steerQueued(message: string, delivery: 'steer' | 'interrupt', signal: AbortSignal): Promise<void> {
    let doInterrupt = false;
    if (!(await this.lock.acquire(signal))) throw new ChatProtoError(callError(new AbortedError(signal.reason)));
    try {
      if (this.ended || this.closing) throw errEnded();
      const i = this.queue.findIndex((m) => m.message === message);
      if (i < 0) throw perr(Code.NotFound, 'no such queued message');
      const [msg] = this.queue.splice(i, 1);
      const input = toUserInput(wireBlocks(msg!.content, msg!.handoffContext));
      if (!this.active) {
        this.emit(queuedEvent(msg!, QueuedState.Taken, false));
        return await this.startTold(input, msg!.message, signal);
      }
      if (delivery === chat.Delivery.Interrupt) {
        this.queue.unshift(msg!);
        this.keepQueueOnInterrupt = true;
        this.drainOnInterrupt = true;
        doInterrupt = true;
      } else {
        if (this.turn === '' || this.compacting) {
          this.queue.splice(i, 0, msg!);
          throw perr(Code.Busy, 'the active turn cannot be steered right now');
        }
        return await this.steerMessage(msg!, input, false, signal, i);
      }
    } finally {
      this.lock.release();
    }
    if (doInterrupt) {
      for (const pend of this.takePending(true)) pend.ac.abort();
      await this.interruptActiveTurn(signal);
    }
  }

  /** Replaces the session's cached model catalog after an Op.Models refresh. */
  applyModels(ms: Models): void {
    if (this.ended || this.closing) return;
    this.models = ms;
    this.st.effort = this.models.effortFor(this.st.model, this.st.effort, '');
    this.sink.update(this.chatUpdate());
  }

  /** Appends structured handoff messages directly into this thread's model-visible
   * history via `thread/inject_items` without starting a user turn. Throws
   * Code.Unsupported when the running Codex version does not implement the method. */
  async injectHistory(messages: readonly HandoffMessage[], signal: AbortSignal): Promise<void> {
    if (messages.length === 0) return;
    if (!(await this.lock.acquire(signal))) throw new ChatProtoError(callError(new AbortedError(signal.reason)));
    try {
      if (this.ended || this.closing) throw errEnded();
      if (this.active || this.ask) throw perr(Code.Busy, 'a turn runs');
      const c = this.c;
      if (!c || this.thread === '') throw errEnded();
      const items: ResponseItem[] = messages.map((m) =>
        m.role === 'assistant'
          ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.text }] }
          : { type: 'message', role: 'user', content: [{ type: 'input_text', text: m.text }] },
      );
      try {
        await c.conn.call('thread/inject_items', { threadId: this.thread, items }, signal);
      } catch (e) {
        if (e instanceof RpcError && (e.code === METHOD_NOT_FOUND || /method not found|unknown variant|unsupported/i.test(e.message))) {
          throw perr(Code.Unsupported, 'codex: thread/inject_items is not supported by this version');
        }
        throw new ChatProtoError(callError(e));
      }
    } finally {
      this.lock.release();
    }
  }

  /** Rewinds an idle thread to just before p.beforeTurnId via thread/revert. */
  async rewind(p: RewindParams, signal: AbortSignal): Promise<RewindResult> {
    if (!(await this.lock.acquire(signal))) throw new ChatProtoError(callError(new AbortedError(signal.reason)));
    try {
      if (this.ended || this.closing) throw errEnded();
      if (this.active || this.ask) throw perr(Code.Busy, 'a turn runs');
      if (!p.beforeTurnId) throw perr(Code.BadRequest, 'codex: beforeTurnId is required for rewind');
      const c = this.c!;
      try {
        await c.conn.call('thread/revert', { threadId: this.thread, beforeTurnId: p.beforeTurnId }, signal);
      } catch (e) {
        throw new ChatProtoError(callError(e));
      }
      this.plan = { id: '', text: '' };
      this.usage = markUsageStale(this.usage) ?? { used: 0, size: 0 };
      this.dirty = true;
      this.flushUsage(true)?.();
      this.supersedeAsyncAsk();
      for (const pend of this.takePending()) pend.ac.abort();
      this.items.clear();
      this.children.clear();
      this.bgTerminals.clear();
      this.publishTasks();
      return { sessionId: this.thread };
    } finally {
      this.lock.release();
    }
  }

  /** Terminates a running background terminal (by processId) or interrupts a
   * running subagent thread (by agentThreadId). */
  async stopTask(taskId: string, signal: AbortSignal): Promise<void> {
    if (this.ended || this.closing) throw errEnded();
    if (!taskId) throw perr(Code.BadRequest, 'codex: empty task id');
    const c = this.c!;
    if (this.bgTerminals.has(taskId)) {
      let res: ClientRequests['thread/backgroundTerminals/terminate']['result'];
      try {
        res = await c.conn.call('thread/backgroundTerminals/terminate', { threadId: this.thread, processId: taskId }, signal);
      } catch (e) {
        throw new ChatProtoError(callError(e));
      }
      if (!res?.terminated) {
        void this.syncBackgroundTerminals();
        throw perr(Code.NotFound, 'no such background terminal');
      }
      this.bgTerminals.delete(taskId);
      this.publishTasks();
      void this.syncBackgroundTerminals();
      return;
    }
    const ch = this.children.get(taskId);
    if (ch) {
      if (!ch.running) throw perr(Code.NotFound, 'subagent is no longer running');
      if (!ch.turnId) throw perr(Code.Busy, 'subagent turn is not ready to interrupt');
      try {
        await c.conn.call('turn/interrupt', { threadId: taskId, turnId: ch.turnId }, signal);
      } catch (e) {
        throw new ChatProtoError(callError(e));
      }
      return;
    }
    if (this.hasProcessIds) {
      try {
        const res = await c.conn.call('thread/backgroundTerminals/terminate', { threadId: this.thread, processId: taskId }, signal);
        if (res?.terminated) {
          void this.syncBackgroundTerminals();
          return;
        }
      } catch (e) {
        if (!(e instanceof RpcError)) throw new ChatProtoError(callError(e));
      }
    }
    throw perr(Code.NotFound, 'no such running task');
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
      this.usage = markUsageStale(this.usage) ?? { used: 0, size: 0 };
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
    this.supersedeAsyncAsk();
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
    const afters: Array<() => void> = [];
    switch (method) {
      case 'turn/started': {
        const n = params as ServerNotifications['turn/started'];
        if (this.parentOf(n.threadId).main && isObj(n.turn) && typeof n.turn.id === 'string' && n.turn.id !== '') {
          this.active = true;
          this.turn = n.turn.id;
          evs.push({ t: EventType.Turn, ...(timeOf(at) ? { at: timeOf(at) } : {}), item: n.turn.id, state: TurnState.Start });
        } else if (typeof n.threadId === 'string' && isObj(n.turn) && typeof n.turn.id === 'string' && n.turn.id !== '') {
          const ch = this.children.get(n.threadId);
          if (ch && ch.turnId !== n.turn.id) {
            evs.push(...this.startChildTurn(ch, n.turn.id, at));
            afters.push(() => this.publishTasks());
          }
        }
        break;
      }
      case 'turn/completed': {
        const n = params as ServerNotifications['turn/completed'];
        if (this.parentOf(n.threadId).main && isObj(n.turn)) {
          const r = this.turnCompleted(n.turn, at);
          evs.push(...r.evs);
          afters.push(r.after);
        } else if (typeof n.threadId === 'string' && isObj(n.turn)) {
          const ch = this.children.get(n.threadId);
          const status = toolStatus(n.turn.status);
          if (
            ch?.running &&
            typeof n.turn.id === 'string' &&
            n.turn.id !== '' &&
            (!ch.turnId || ch.turnId === n.turn.id) &&
            status !== Tool.InProgress
          ) {
            ch.turnId = n.turn.id;
            evs.push(this.finishChild(ch, status, at));
            afters.push(() => this.publishTasks());
          }
        }
        break;
      }
      case 'item/started':
      case 'item/completed':
        evs.push(...this.itemEvent(srv, params as ItemCompletedNotification, method === 'item/completed', at, afters));
        break;
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
      case 'item/commandExecution/outputDelta':
        evs.push(...this.delta(method, params, at));
        break;
      case 'item/commandExecution/terminalInteraction':
        this.hasProcessIds = true;
        afters.push(() => void this.syncBackgroundTerminals());
        break;
      case 'process/exited':
        if (this.bgTerminals.size > 0) afters.push(() => void this.syncBackgroundTerminals());
        break;
      case 'thread/reverted':
        break;
      case 'thread/tokenUsage/updated': {
        const n = params as ServerNotifications['thread/tokenUsage/updated'];
        if (this.parentOf(n.threadId).main && isObj(n.tokenUsage)) {
          const used = n.tokenUsage.last?.totalTokens;
          const w = n.tokenUsage.modelContextWindow;
          this.usage.used = typeof used === 'number' ? used : 0;
          if (typeof w === 'number' && w > 0) this.usage.size = w;
          delete this.usage.percentage;
          delete this.usage.stale;
          if (this.usage.size > 0) this.usage.percentage = (this.usage.used * 100) / this.usage.size;
          this.dirty = true;
          const flush = this.flushUsage(false);
          if (flush) afters.push(flush);
        }
        break;
      }
      case 'account/rateLimits/updated': {
        const n = params as ServerNotifications['account/rateLimits/updated'];
        if (isObj(n.rateLimits)) {
          this.rateLimits(n.rateLimits);
          const flush = this.flushUsage(false);
          if (flush) afters.push(flush);
        }
        break;
      }
      case 'thread/name/updated': {
        const n = params as ServerNotifications['thread/name/updated'];
        if (n.threadId === this.thread && typeof n.threadName === 'string') {
          const name = cutText(n.threadName, 512);
          evs.push(updateEvent('', '', false, { sessionUpdate: 'session_info_update', title: name }, at));
          afters.push(() => this.sink.update((c) => void (c.title = name)));
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
    for (const fn of afters) fn();
  }

  /** The events of an item/started or item/completed. */
  private itemEvent(srv: AppServer, n: ItemCompletedNotification, completed: boolean, at: number, afters: Array<() => void>): Event[] {
    const it = n.item as ThreadItem | undefined;
    if (!isObj(it) || typeof it.id !== 'string' || it.id === '') {
      const type = isObj(it) && typeof it.type === 'string' ? it.type : '';
      srv.conn.passedOver('item ' + cutText(type, 64));
      return [];
    }
    const { parent, main } = this.parentOf(n.threadId);
    const related: Event[] = [];
    if (!main && typeof n.threadId === 'string' && typeof n.turnId === 'string' && n.turnId !== '') {
      const ch = this.children.get(n.threadId);
      if (ch && ch.turnId !== n.turnId) {
        related.push(...this.startChildTurn(ch, n.turnId, at));
        afters.push(() => this.publishTasks());
      }
    }
    switch (it.type) {
      case ItemType.UserMessage:
        return completed ? related.concat(this.userMessage(it, parent, main, at)) : related;
      case ItemType.SubAgent:
        return related.concat(this.subAgent(it, parent, completed, at, afters));
      case ItemType.CollabTool:
        if (it.tool === 'spawnAgent') {
          let changed = false;
          for (const t of Array.isArray(it.receiverThreadIds) ? it.receiverThreadIds : []) {
            if (typeof t === 'string' && t !== '' && !this.children.has(t)) {
              const state = it.agentsStates?.[t]?.status;
              setBounded(this.children, t, {
                call: it.id,
                parent,
                state: collabCall(it),
                agentPath: strOf(it.prompt) || 'subagent',
                turnId: '',
                running: it.status === 'inProgress' || state === 'running' || state === 'pendingInit',
                startedAt: timeOf(itemTime(it, at)),
              });
              changed = true;
            }
          }
          if (changed) afters.push(() => this.publishTasks());
        }
        if (completed && isObj(it.agentsStates)) {
          for (const [threadId, state] of Object.entries(it.agentsStates)) {
            const ch = this.children.get(threadId);
            if (!ch?.running || !isObj(state)) continue;
            switch (state.status) {
              case 'completed':
                related.push(this.finishChild(ch, Tool.Completed, at));
                break;
              case 'errored':
                related.push(this.finishChild(ch, Tool.Failed, at));
                break;
              case 'interrupted':
              case 'shutdown':
              case 'notFound':
                related.push(this.finishChild(ch, Tool.Cancelled, at));
                break;
            }
          }
          if (related.length) afters.push(() => this.publishTasks());
        }
        break;
      case ItemType.Plan:
        if (completed && main) this.plan = { id: it.id, text: strOf(it.text) };
        break;
      case ItemType.AgentMessage:
        if (completed && !this.closing) {
          const qs = asyncQuestions(it.questions);
          if (qs.length > 0) afters.push(() => this.startAsyncAsk(qs, it.id, parent));
        }
        break;
      case ItemType.Command:
        if (strOf(it.processId) !== '') {
          this.hasProcessIds = true;
          afters.push(() => void this.syncBackgroundTerminals());
        }
        break;
    }
    const evs = this.m.itemEvents(it, completed, parent, at);
    if (evs === null) {
      srv.conn.passedOver('item ' + cutText(String(it.type), 64));
      return related;
    }
    if (isTool(it.type) && evs.length === 1) {
      if (completed) this.items.delete(it.id);
      else setBounded(this.items, it.id, { type: it.type, item: it, parent, last: evs[0]!.update as Obj, shown: true });
    }
    return related.length ? related.concat(evs) : evs;
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
  private subAgent(
    it: Extract<ThreadItem, { type: 'subAgentActivity' }>,
    parent: string,
    completed: boolean,
    fallback: number,
    afters: Array<() => void>,
  ): Event[] {
    const at = itemTime(it, fallback);
    switch (it.kind) {
      case SubAgent.Started: {
        if (this.children.get(it.agentThreadId)?.call === it.id) return [];
        const u = subAgentCall(it, Tool.InProgress);
        if (it.agentThreadId) {
          const existing = this.children.get(it.agentThreadId);
          setBounded(this.children, it.agentThreadId, {
            call: it.id,
            parent,
            state: u,
            agentPath: strOf(it.agentPath),
            turnId: existing?.turnId ?? '',
            running: true,
            startedAt: existing?.startedAt ?? timeOf(at),
          });
          afters.push(() => this.publishTasks());
        }
        return [updateEvent(it.id, parent, false, u, at)];
      }
      case SubAgent.Completed:
      case SubAgent.Stopped: {
        const ch = this.children.get(it.agentThreadId);
        if (!completed || !ch?.running) return [];
        afters.push(() => this.publishTasks());
        return [this.finishChild(ch, it.kind === SubAgent.Stopped ? Tool.Cancelled : Tool.Completed, at)];
      }
    }
    return [];
  }

  private startChildTurn(ch: Child, turnId: string, at: number): Event[] {
    ch.turnId = turnId;
    if (ch.running) return [];
    ch.running = true;
    const update = callWithStatus(ch.state, Tool.InProgress);
    update.sessionUpdate = 'tool_call_update';
    return [updateEvent(ch.call, ch.parent, false, update, at)];
  }

  private finishChild(ch: Child, status: string, at?: number): Event {
    // Keep the turn ID so a late item from the same turn cannot reactivate it.
    ch.running = false;
    return updateEvent(ch.call, ch.parent, false, callWithStatus(ch.state, status), at);
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
    const keep = this.keepQueueOnInterrupt;
    const drain = this.drainOnInterrupt;
    this.keepQueueOnInterrupt = false;
    this.drainOnInterrupt = false;
    let cancelledQueue: Message[] = [];
    let next: Message | undefined;
    if (t.status === 'interrupted') {
      if (!keep) {
        cancelledQueue = this.queue;
        this.queue = [];
      } else if (drain) {
        next = this.queue.shift();
      }
    } else {
      next = this.queue.shift();
    }
    const lastErr = this.lastErr;
    this.active = false;
    this.turn = '';
    this.compacting = false;
    this.promptId = '';
    this.skipUser = false;
    this.lastErr = null;
    const flush = this.flushUsage(true)!;
    evs.push(turnEnd(t, lastErr, at));
    if (t.status === 'completed' && plan.text !== '' && this.st.mode === Mode.Plan && !next && this.queue.length === 0 && !this.closing) {
      // The turn ends first: its end cancels what was asked in it.
      let resolve!: () => void;
      const a: PlanAsk = { ac: new AbortController(), done: new Promise((r) => (resolve = r)), superseded: false };
      this.ask = a;
      return {
        evs,
        after: () => {
          flush();
          if (this.hasProcessIds || this.bgTerminals.size > 0) void this.syncBackgroundTerminals();
          void this.askPlan(a, resolve, plan.id, plan.text);
        },
      };
    }
    return {
      evs,
      after: () => {
        flush();
        if (this.hasProcessIds || this.bgTerminals.size > 0) void this.syncBackgroundTerminals();
        if (cancelledQueue.length > 0) {
          this.emit(...cancelledQueue.map((m) => queuedEvent(m, QueuedState.Cancelled, false)));
          return;
        }
        if (next) void this.sendQueued([next]);
      },
    };
  }

  /** Launches a non-blocking question ask for an agentMessage's async
   * questions; supersedes any prior unanswered async question ask. */
  private startAsyncAsk(qs: AsyncQuestion[], itemId: string, parent: string): void {
    if (this.ended || this.closing || qs.length === 0) return;
    this.supersedeAsyncAsk();
    let resolve!: () => void;
    const a: PlanAsk = { ac: new AbortController(), done: new Promise((r) => (resolve = r)), superseded: false };
    this.asyncAsk = a;
    void this.askAsyncQuestions(a, resolve, qs, itemId, parent);
  }

  /** Presents agentMessage.questions as a non-blocking question card and
   * sends the answer to the running turn or starts the next one. */
  private async askAsyncQuestions(a: PlanAsk, settle: () => void, qs: AsyncQuestion[], itemId: string, parent: string): Promise<void> {
    const chatQuestions: chat.Question[] = qs.map((q, i) => ({
      id: `q${i + 1}`,
      question: q.title,
      allowOther: true,
      ...(q.options && q.options.length > 0 ? { options: q.options.map((label) => ({ label })) } : {}),
    }));
    let ans: QuestionAnswer;
    try {
      ans = await this.sink.question(
        { questions: chatQuestions, parent, async: true, item: itemId },
        AbortSignal.any([a.ac.signal, this.ac.signal]),
      );
    } catch {
      ans = { cancelled: true };
    }
    a.ac.abort();
    if (this.asyncAsk === a) this.asyncAsk = null;
    settle();
    if (ans.cancelled || a.superseded) return;
    const lines: string[] = [];
    for (const q of chatQuestions) {
      const vals = (ans.answers[q.id] ?? []).map((v) => v.trim()).filter((v) => v !== '');
      if (vals.length === 0) continue;
      lines.push(`${q.question}: ${vals.join(', ')}`);
    }
    const reply = lines.join('\n');
    if (reply === '') return;
    if (!(await this.lock.acquire(this.ac.signal))) return;
    try {
      if (this.ended || this.closing || a.superseded) return;
      const content = [textBlock(reply)];
      const msg: Message = { content, message: newID(), clientId: '' };
      const input = toUserInput(content);
      if (this.active) {
        if (this.queue.length + this.steers.length >= MAX_QUEUE) throw perr(Code.Busy, 'too many messages wait for the turn');
        if (this.turn !== '' && !this.compacting) return await this.steerMessage(msg, input, true, this.ac.signal);
        this.queue.push(msg);
        this.emit(queuedEvent(msg, QueuedState.Waiting, true));
        return;
      }
      this.emit(userEvent(msg));
      await this.startTurn(input, msg.message, this.ac.signal);
    } catch (e) {
      const message = callError(e).message;
      this.logf(`sending async question answer: ${message}`);
      this.emit(noticeEvent(Notice.Error, '', { message }));
    } finally {
      this.lock.release();
    }
  }

  /** Queries thread/backgroundTerminals/list (coalescing concurrent calls)
   * and updates Chat.tasks. Best-effort: older app-servers or recordings
   * without this RPC are ignored quietly. */
  private async syncBackgroundTerminals(): Promise<void> {
    if (this.ended || this.closing || this.restarting || this.thread === '' || !this.c) return;
    if (this.bgSyncing) {
      this.bgSyncAgain = true;
      return;
    }
    clearTimeout(this.bgTimer);
    this.bgTimer = undefined;
    this.bgSyncing = true;
    try {
      const c = this.c;
      if (!c || this.ended || this.closing) return;
      const found = new Map<string, ThreadBackgroundTerminal>();
      let cursor = '';
      const signal = AbortSignal.any([this.ac.signal, AbortSignal.timeout(5000)]);
      for (let page = 0; page < 10; page++) {
        const res = await c.conn.call(
          'thread/backgroundTerminals/list',
          { threadId: this.thread, limit: 100, ...(cursor ? { cursor } : {}) },
          signal,
        );
        for (const t of Array.isArray(res?.data) ? res.data : []) {
          if (isObj(t) && typeof t.processId === 'string' && t.processId !== '') found.set(t.processId, t);
        }
        if (!res?.nextCursor) break;
        cursor = res.nextCursor;
      }
      if (this.ended || this.closing || this.restarting || this.c !== c) return;
      this.bgTerminals.clear();
      for (const [k, v] of found) this.bgTerminals.set(k, v);
      this.publishTasks();
    } catch {
      // Best-effort: app-servers without backgroundTerminals/list or closed connections.
    } finally {
      this.bgSyncing = false;
      const again = this.bgSyncAgain;
      this.bgSyncAgain = false;
      if (!this.ended && !this.closing && !this.restarting) {
        if (again) void this.syncBackgroundTerminals();
        else if (this.bgTerminals.size > 0) {
          // A shell can exit between notifications, including after the turn ends.
          this.bgTimer = setTimeout(() => void this.syncBackgroundTerminals(), BACKGROUND_POLL_MS).unref();
        }
      }
    }
  }

  /** Publishes the current live set of background terminals and running
   * subagents to Chat.tasks when it changed. */
  private publishTasks(): void {
    if (this.ended || this.closing) return;
    const tasks: chat.BackgroundTask[] = [];
    for (const term of this.bgTerminals.values()) {
      const cmd = cutText(shellScript(term.command, null) || strOf(term.command), MAX_TITLE);
      tasks.push({
        id: term.processId,
        kind: chat.TaskKind.Shell,
        status: chat.TaskStatus.Running,
        description: cmd || term.processId,
        ...(cmd ? { command: cmd } : {}),
        ...(strOf(term.itemId) ? { toolCallId: term.itemId } : {}),
        ...(typeof term.osPid === 'number' && term.osPid > 0 ? { pid: term.osPid } : {}),
        backgrounded: true,
        stoppable: true,
      });
    }
    for (const [threadId, ch] of this.children) {
      if (!ch.running) continue;
      const desc = cutText(ch.agentPath || 'subagent', MAX_TITLE);
      tasks.push({
        id: threadId,
        kind: chat.TaskKind.Subagent,
        status: chat.TaskStatus.Running,
        description: desc,
        agentType: desc,
        toolCallId: ch.call,
        backgrounded: true,
        stoppable: ch.turnId !== '',
        ...(ch.startedAt ? { startedAt: ch.startedAt } : {}),
      });
    }
    const json = tasks.length > 0 ? JSON.stringify(tasks) : '';
    if (json === this.lastTasksJson) return;
    this.lastTasksJson = json;
    if (tasks.length > 0) this.sink.update((c) => void (c.tasks = tasks));
    else
      this.sink.update((c) => {
        delete c.tasks;
      });
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

  /** Asks the user the questions of request_user_input (plan mode's or
   * non-blocking async questions); skipped, they are answered with no
   * answers. A question without options takes the user's own words, whatever
   * its isOther says: it could not be answered otherwise. */
  private async askQuestions(r: ServerRequest, p: Pending): Promise<void> {
    const params = (isObj(r.params) ? r.params : {}) as Partial<ServerRequests[typeof M.RequestUserInput]['params']>;
    const isAsync = params.isBlocking === false;
    p.async = isAsync;
    const autoResolutionMs =
      typeof params.autoResolutionMs === 'number' && params.autoResolutionMs > 0 ? params.autoResolutionMs : undefined;
    const item = typeof params.itemId === 'string' && params.itemId !== '' ? params.itemId : undefined;
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
      ans = await this.sink.question(
        {
          questions: qs,
          parent,
          ...(isAsync ? { async: true } : {}),
          ...(autoResolutionMs !== undefined ? { autoResolutionMs } : {}),
          ...(item ? { item } : {}),
        },
        this.waitSignal(p),
      );
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
