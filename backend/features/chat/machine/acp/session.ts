// One ACP agent process running one session of a chat: what the agent
// reports (session/update) as chat events and changes of the chat, its
// permission requests as the host's, the user's prompts as turns (one per
// prompt: a prompt while a turn runs waits here and is sent when the turn
// ends), and the session's end.
//
// Everything runs on the host's one thread: the sink is called
// synchronously, in the order things happened, from the notification
// handler (which the connection calls in the order of the agent's output),
// from the turns' ends and from the session's methods. So the host has a
// tool call's stored event before the permission request for it, and every
// event of the session before done settles.
import {
  ChatProtoError,
  Code,
  EventType,
  QueuedState,
  TurnState,
  type ChatError,
  type ConfigOption,
  type Event,
  type SlashCommand,
} from '#shared/proto/chatproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import type { Logger } from '#shared/lib/log.ts';
import type { AgentProcess } from '../agentproc.ts';
import type { PromptParams, Session, Sink, StartParams } from '../adapter.ts';
import { Items, UPDATE_COMMANDS, UPDATE_CONFIG, UPDATE_INFO, UPDATE_MODE, UPDATE_USAGE, UPDATE_USER, contentUpdate } from './items.ts';
import {
  AbortedError,
  ClosedError,
  Conn,
  ProtocolVersionError,
  PROTOCOL_VERSION,
  RequestError,
  RpcCode,
  TimeoutError,
  initialize,
  permissionCancelled,
  permissionSelected,
  type AgentCapabilities,
} from './rpc.ts';
import {
  LEGACY_MODE_ID,
  LEGACY_MODE_ID_ALT,
  MAX_NAME,
  USD_PER_TICK,
  clip,
  cloneConfig,
  cloneUsage,
  configOptions,
  contextSizes,
  hasValue,
  isObj,
  markFull,
  modeValue,
  modesOption,
  optionByID,
  optionOf,
  present,
  sameCommands,
  slashCommands,
  str,
  turnMeta,
  usageUpdate,
  withContext,
  type Obj,
} from './state.ts';

/** A session's times, in milliseconds; shorter in tests. */
export interface AcpTiming {
  initialize: number;
  session: number;
  load: number;
  call: number;
  /** How long an agent whose input closed may take to exit before it gets
   * SIGTERM, term how long after that before SIGKILL. */
  grace: number;
  term: number;
  /** How long the output of an agent that exited is read on. */
  drain: number;
}

export const ACP_TIMING: AcpTiming = {
  initialize: 60_000,
  session: 60_000,
  load: 120_000,
  call: 30_000,
  grace: 2000,
  term: 3000,
  drain: 2000,
};

/** The most messages that wait for a running turn. */
export const MAX_QUEUE = 16;
/** The most permissions of a session that wait for the user; an agent
 * that asks more is answered that they were cancelled. */
export const MAX_PENDING = 64;
/** The most kinds of unknown updates and requests a session logs (once
 * each). */
const MAX_UNKNOWN = 64;
/** The longest title a chat takes from its agent. */
export const TITLE_RUNES = 200;

const METHOD_UPDATE = 'session/update';
const METHOD_PERMISSION = 'session/request_permission';

const perr = (code: string, message: string): ChatProtoError => new ChatProtoError({ code, message });

/** A prompt turn that runs: its signal ends with it, or when it is
 * cancelled, and the permissions it asks end then. */
interface Turn {
  readonly ac: AbortController;
}

/** A message that waits for the running turn to end. */
interface Queued {
  message: string;
  clientId: string;
  content: unknown[];
}

/** The error of a command or a turn, from the error of the call to the
 * agent. */
export function callError(err: unknown): ChatError {
  if (err instanceof ChatProtoError) return { ...err.error };
  if (err instanceof ClosedError) return { code: Code.Ended, message: 'the agent is gone' };
  if (err instanceof RequestError) {
    if (err.code === RpcCode.AuthRequired) return { code: Code.AuthRequired, message: err.message };
    if (err.code === RpcCode.MethodNotFound) return { code: Code.Unsupported, message: 'the agent does not know the method' };
    return { code: Code.Failed, message: err.message };
  }
  if (err instanceof TimeoutError) return { code: Code.Failed, message: 'the agent did not answer in time' };
  if (err instanceof AbortedError) return { code: Code.Ended, message: 'the session ends' };
  return { code: Code.Failed, message: (err as Error)?.message ?? String(err) };
}

/** The error of an agent that did not get to a session; signal is the
 * start's. */
export function startError(signal: AbortSignal, err: unknown): ChatError {
  if (err instanceof ChatProtoError) return { ...err.error };
  if (err instanceof ProtocolVersionError)
    return {
      code: Code.Protocol,
      message: `the agent speaks version ${err.version} of the Agent Client Protocol, this host version ${PROTOCOL_VERSION}`,
    };
  if (err instanceof RequestError) {
    if (err.code === RpcCode.AuthRequired) return { code: Code.AuthRequired, message: err.message };
    // The session to take up is not there.
    if (err.code === RpcCode.ResourceNotFound) return { code: Code.NotFound, message: err.message };
    return { code: Code.StartFailed, message: err.message };
  }
  const reason: unknown = signal.reason;
  if (err instanceof TimeoutError || (signal.aborted && reason instanceof DOMException && reason.name === 'TimeoutError'))
    return { code: Code.StartFailed, message: 'the agent did not start in time' };
  if (signal.aborted || err instanceof AbortedError) return { code: Code.Ended, message: 'the start was called off' };
  if (err instanceof ClosedError) return { code: Code.StartFailed, message: '' };
  return { code: Code.StartFailed, message: (err as Error)?.message ?? String(err) };
}

/** The kind of a permission for a tool call of an ACP tool kind. */
export function permissionKind(toolKind: string): string {
  switch (toolKind) {
    case 'execute':
      return chat.PermissionKind.Command;
    case 'edit':
    case 'delete':
    case 'move':
      return chat.PermissionKind.File;
  }
  return chat.PermissionKind.Tool;
}

/** The agent's options of a permission that the user is offered: not those
 * that allow or reject for good, which an agent may keep in its own
 * settings. */
export function permissionOptions(opts: Array<{ optionId: string; name: string; kind: string }>): chat.PermissionOption[] {
  return opts
    .filter((o) => (o.kind === chat.OptionKind.AllowOnce || o.kind === chat.OptionKind.RejectOnce) && o.optionId !== '')
    .map((o) => ({ optionId: o.optionId, name: clip(o.name, MAX_NAME), kind: o.kind }));
}

/** A permission request's params as the adapter reads them; null for
 * params that are none. */
function permissionParams(p: unknown): { toolCall: unknown; options: Array<{ optionId: string; name: string; kind: string }> } | null {
  if (!isObj(p) || str(p.sessionId) === undefined) return null;
  if (present(p.options) && !Array.isArray(p.options)) return null;
  const options: Array<{ optionId: string; name: string; kind: string }> = [];
  for (const o of (p.options as unknown[] | undefined) ?? []) {
    if (o === null) {
      options.push({ optionId: '', name: '', kind: '' });
      continue;
    }
    if (!isObj(o) || str(o.optionId) === undefined || str(o.name) === undefined || str(o.kind) === undefined) return null;
    options.push({ optionId: str(o.optionId)!, name: str(o.name)!, kind: str(o.kind)! });
  }
  return { toolCall: p.toolCall, options };
}

/** An agent process running one session of a chat. */
export class AcpSession implements Session {
  readonly done: Promise<chat.ChatError | undefined>;
  private resolveDone!: (e: chat.ChatError | undefined) => void;
  conn!: Conn;
  proc!: AgentProcess;
  /** Ends when the session does: the requests of the agent that wait for
   * the user return then. */
  private readonly ac = new AbortController();

  private sid = '';
  private caps: AgentCapabilities = { loadSession: false, image: false, audio: false, embeddedContext: false, list: false, resume: false };
  private readonly it: Items;
  private turn: Turn | null = null;
  private queue: Queued[] = [];
  /** session/load replays what the chat's log has. */
  private replaying = false;
  private closing = false;
  private ended = false;
  private err: ChatError | undefined;
  private pending = 0;
  private config: ConfigOption[] = [];
  /** The id of the option made of the agent's session modes; "" for none. */
  private legacy = '';
  private commands: SlashCommand[] = [];
  /** Context windows by model id. */
  private sizes = new Map<string, number>();
  /** The agent sent a usage_update, and one with its cost. */
  private sawUsage = false;
  private sawCost = false;
  private readonly unknown = new Set<string>();
  private readonly kind: string;
  private readonly logger: Logger;
  private readonly sink: Sink;
  private readonly t: AcpTiming;

  constructor(kind: string, logger: Logger, sink: Sink, t: AcpTiming, itemPrefix: string) {
    this.kind = kind;
    this.logger = logger;
    this.sink = sink;
    this.t = t;
    this.done = new Promise((r) => (this.resolveDone = r));
    this.it = new Items(itemPrefix, true, (ev) => this.emit(ev));
  }

  /** Speaks the protocol on proc's pipes and follows its end. */
  attach(proc: AgentProcess, name: string): void {
    this.proc = proc;
    this.conn = new Conn(proc, this, { name, logger: this.logger });
    this.watch().catch((e: unknown) => this.logf(`watching the agent: ${(e as Error).message}`));
  }

  get id(): string {
    return this.sid;
  }

  /** The agent's process id, which is its process group's. */
  get pid(): number {
    return this.proc?.pid ?? 0;
  }

  private logf(line: string): void {
    this.logger(`acp ${this.kind}: ${line}`);
  }

  /** Logs what the session passes over, once for each kind. */
  private once(what: string): void {
    if (this.unknown.has(what) || this.unknown.size >= MAX_UNKNOWN) return;
    this.unknown.add(what);
    this.logf(`passed over ${what}`);
  }

  private emit(ev: Event): void {
    this.sink.event(ev);
  }

  /** States the session's configuration options, and the capabilities they
   * make. */
  private stateConfig(): void {
    const cfg = cloneConfig(this.config);
    const model = optionOf(cfg, chat.Category.Model) !== undefined;
    const effort = optionOf(cfg, chat.Category.ThoughtLevel) !== undefined;
    this.sink.update((c) => {
      if (cfg.length > 0) c.config = cfg;
      else delete c.config;
      c.capabilities.model = model;
      c.capabilities.effort = effort;
    });
  }

  /** Takes the agent's configuration options, its session modes, or both:
   * an agent without an option of category mode has its session modes as an
   * option of the chat's own (LEGACY_MODE_ID), which session/set_mode sets.
   * undefined leaves what the session has. */
  takeConfig(options: unknown, modes: unknown): void {
    let mode: ConfigOption | undefined;
    let cfg: ConfigOption[] = [];
    for (const o of this.config) {
      if (this.legacy !== '' && o.id === this.legacy) mode = cloneConfig([o])[0];
      else cfg.push(o);
    }
    if (present(options)) cfg = configOptions(options) ?? [];
    if (present(modes)) {
      const o = modesOption(modes, '');
      if (o) mode = o;
    }
    this.legacy = '';
    if (mode && !optionOf(cfg, chat.Category.Mode)) {
      mode.id = optionByID(cfg, LEGACY_MODE_ID) ? LEGACY_MODE_ID_ALT : LEGACY_MODE_ID;
      cfg.push(mode);
      this.legacy = mode.id;
    }
    markFull(cfg);
    this.config = cfg;
    this.stateConfig();
  }

  /** The configuration options as the session keeps them (tests). */
  get configOptions(): ConfigOption[] {
    return cloneConfig(this.config);
  }

  /** Speaks the protocol up to the session, and sets what the chat starts
   * with. */
  async open(p: StartParams, signal: AbortSignal): Promise<void> {
    const init = await initialize(this.conn, p.client, this.t.initialize, signal);
    this.caps = init.capabilities;
    const meta = p.newSessionMeta ? { _meta: p.newSessionMeta } : {};
    let res: unknown;
    let id = p.resume;
    if (p.resume === '') {
      res = await this.conn.call('session/new', { cwd: p.cwd, mcpServers: [], ...meta }, { ms: this.t.session, signal });
      if (!isObj(res) || typeof res.sessionId !== 'string' || res.sessionId === '')
        throw new Error('acp: session/new: an answer without a sessionId');
      id = res.sessionId;
    } else if (this.caps.resume) {
      this.sid = id;
      res = await this.conn.call('session/resume', { sessionId: id, cwd: p.cwd, mcpServers: [], ...meta }, { ms: this.t.session, signal });
    } else if (this.caps.loadSession) {
      // The agent replays the session before it answers: the chat's log has
      // all of it.
      this.sid = id;
      this.replaying = true;
      try {
        res = await this.conn.call('session/load', { sessionId: id, cwd: p.cwd, mcpServers: [], ...meta }, { ms: this.t.load, signal });
      } finally {
        this.replaying = false;
      }
    } else {
      throw perr(Code.Unsupported, 'the agent cannot take up a session');
    }
    const r: Obj = isObj(res) ? res : {};
    const version = clip(init.version, MAX_NAME);
    const caps: chat.Capabilities = {
      images: this.caps.image,
      compact: false,
      queue: true,
      plan: false,
      questions: false,
      effort: false,
      model: false,
      cancelQueued: true,
    };
    this.sid = id;
    this.sizes = contextSizes(r.models);
    this.sink.update((c) => {
      c.sessionId = id;
      if (version) c.agentVersion = version;
      else delete c.agentVersion;
      c.capabilities = { ...caps };
    });
    this.takeConfig(r.configOptions, r.modes);
    await this.applyOptions(p.options, signal);
  }

  /** Sets what the chat starts with: the model, the effort and the mode,
   * each when the agent has it and it is not already set. A value the agent
   * does not offer is left (the host checks what it was asked). */
  private async applyOptions(o: chat.Options, signal: AbortSignal): Promise<void> {
    const wants: Array<[string, string | undefined]> = [
      [chat.Category.Model, o.model],
      [chat.Category.ThoughtLevel, o.effort],
      [chat.Category.Mode, o.mode],
    ];
    for (const [category, want] of wants) {
      if (!want) continue;
      const opt = optionOf(this.config, category);
      let value = '';
      if (opt) {
        value = category === chat.Category.Mode ? modeValue(opt, want) : hasValue(opt, want) ? want : '';
      }
      if (!opt || value === '') {
        this.logf(`no ${category} ${JSON.stringify(want)} to start with`);
        continue;
      }
      if (value === opt.currentValue) continue;
      try {
        await this.set(signal, this.sid, opt.id, value, opt.id === this.legacy);
      } catch (e) {
        this.logf(`setting ${opt.id} to ${JSON.stringify(value)}: ${(e as Error).message}`);
      }
    }
  }

  /** A notification of the agent (rpc.Handler), in the order of its
   * output. */
  notification(method: string, params: unknown): void {
    if (method !== METHOD_UPDATE) {
      this.once(`notification ${method}`);
      return;
    }
    const u = isObj(params) ? params.update : undefined;
    if (
      !isObj(params) ||
      typeof params.sessionId !== 'string' ||
      !isObj(u) ||
      typeof u.sessionUpdate !== 'string' ||
      u.sessionUpdate === ''
    ) {
      this.once('a malformed session/update');
      return;
    }
    if (this.ended || (this.sid !== '' && params.sessionId !== this.sid)) return;
    const kind = u.sessionUpdate;
    if (contentUpdate(kind)) {
      if (this.replaying) return; // what the chat's log has
      if (kind === UPDATE_USER) {
        this.once(`update ${kind}`);
        return; // the host states the user's prompts
      }
      this.it.update(kind, u);
      return;
    }
    switch (kind) {
      case UPDATE_COMMANDS: {
        const cmds = slashCommands(u);
        if (cmds && !sameCommands(cmds, this.commands)) {
          this.commands = cmds;
          const cp = cmds.map((c) => ({ ...c }));
          this.sink.update((c) => {
            if (cp.length > 0) c.commands = cp;
            else delete c.commands;
          });
        }
        return;
      }
      case UPDATE_CONFIG:
        if (present(u.configOptions)) this.takeConfig(u.configOptions, undefined);
        return;
      case UPDATE_MODE: {
        const o = this.legacy !== '' ? optionByID(this.config, this.legacy) : undefined;
        if (o && typeof u.currentModeId === 'string' && hasValue(o, u.currentModeId)) {
          o.currentValue = u.currentModeId;
          this.stateConfig();
        }
        return;
      }
      case UPDATE_INFO: {
        if (typeof u.title !== 'string') return;
        const title = clip(u.title.trim(), TITLE_RUNES);
        if (title !== '') this.sink.update((c) => void (c.title = title));
        return;
      }
      case UPDATE_USAGE: {
        const n = usageUpdate(u);
        if (!n) {
          this.once('a malformed usage_update');
          return;
        }
        this.sawUsage = true;
        if (n.cost) this.sawCost = true;
        this.sink.update((c) => {
          const usage = cloneUsage(c.usage);
          withContext(usage, n.used, n.size);
          if (n.cost) usage.cost = { ...n.cost };
          c.usage = usage;
        });
        return;
      }
    }
    this.once(`update ${kind}`);
  }

  /** A request of the agent (rpc.Handler): a permission, which waits for
   * the user's answer, the turn's cancel or the session's end; every other
   * method is one this client does not serve. */
  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (method !== METHOD_PERMISSION) {
      this.once(`request ${method}`);
      throw RequestError.methodNotFound(method);
    }
    const req = permissionParams(params);
    if (!req) throw new RequestError(RpcCode.InvalidParams, 'Invalid params');
    if (this.ended || this.pending >= MAX_PENDING) return permissionCancelled();
    this.pending++;
    try {
      const toolCall = this.it.toolCall(req.toolCall);
      const tc = isObj(req.toolCall) ? req.toolCall : {};
      let kind = this.it.toolKind(typeof tc.toolCallId === 'string' ? tc.toolCallId : '');
      if (typeof tc.kind === 'string' && tc.kind !== '') kind = tc.kind;
      const options = permissionOptions(req.options);
      if (options.length === 0) return permissionCancelled();
      const wait = AbortSignal.any([(this.turn?.ac ?? this.ac).signal, signal]);
      if (wait.aborted) return permissionCancelled();
      // The host has what came before the request: the tool call's events
      // went to the sink synchronously, before this request was read.
      let ans;
      try {
        ans = await this.sink.permission({ kind: permissionKind(kind), toolCall, options, parent: '' }, wait);
      } catch {
        return permissionCancelled();
      }
      if (ans.cancelled || !options.some((o) => o.optionId === ans.option)) return permissionCancelled();
      return permissionSelected(ans.option);
    } finally {
      this.pending--;
    }
  }

  /** Why the session takes no command; null when it does. */
  private usable(): ChatProtoError | null {
    if (this.ended || this.closing) return perr(Code.Ended, 'the agent is gone');
    return null;
  }

  /** Starts a turn with the user's message, or queues it while one runs:
   * the protocol has a turn per prompt, and the message is sent once the
   * turn ended (a queued event waiting, then taken). A message that starts
   * a turn the host did not record is told here (its user event). */
  async prompt(p: PromptParams): Promise<void> {
    this.checkContent(p.content);
    const e = this.usable();
    if (e) throw e;
    if (this.turn || this.queue.length > 0) {
      if (this.queue.length >= MAX_QUEUE) throw perr(Code.Busy, 'too many messages wait for the turn');
      const q: Queued = { message: p.message, clientId: p.clientId, content: [...p.content] };
      this.queue.push(q);
      this.emit(queuedEvent(QueuedState.Waiting, q, true));
      return;
    }
    // Not recorded: the host saw a turn run, which ended meanwhile.
    const user: Event | undefined = p.recorded
      ? undefined
      : { t: EventType.User, content: [...p.content], ...(p.clientId ? { clientId: p.clientId } : {}) };
    this.startTurn([...p.content], user);
  }

  /** Refuses content blocks the agent did not say it takes. */
  private checkContent(content: unknown[]): void {
    if (content.length === 0) throw perr(Code.BadRequest, 'a prompt without content');
    for (const b of content) {
      if (!isObj(b) || str(b.type) === undefined) throw perr(Code.BadRequest, 'a content block that is no object');
      let ok = true;
      switch (b.type) {
        case 'text':
        case 'resource_link':
          break;
        case 'image':
          ok = this.caps.image;
          break;
        case 'audio':
          ok = this.caps.audio;
          break;
        case 'resource':
          ok = this.caps.embeddedContext;
          break;
        default:
          throw perr(Code.BadRequest, 'a content block of an unknown type');
      }
      if (!ok) throw perr(Code.Unsupported, `the agent takes no ${String(b.type)} blocks`);
    }
  }

  /** Sends a prompt as a turn, after the prompt's user event when user is
   * given. No turn runs. The prompt is written before startTurn returns, so
   * a cancel after it goes after it. */
  private startTurn(content: unknown[], user: Event | undefined): void {
    this.it.endTurn(); // what the agent said between turns
    if (user) this.emit(user);
    const t: Turn = { ac: new AbortController() };
    this.turn = t;
    this.emit({ t: EventType.Turn, state: TurnState.Start });
    const answer = this.conn.call('session/prompt', { sessionId: this.sid, prompt: content }, { signal: this.ac.signal });
    this.runTurn(t, answer).catch((e: unknown) => this.logf(`a turn: ${(e as Error).message}`));
  }

  /** Waits for the agent's end of a turn, then sends the next queued
   * message. */
  private async runTurn(t: Turn, answer: Promise<unknown>): Promise<void> {
    let res: unknown;
    let err: unknown;
    try {
      res = await answer;
      if (res !== null && !isObj(res)) throw new Error('acp: session/prompt: a malformed answer');
      if (isObj(res) && str(res.stopReason) === undefined) throw new Error('acp: session/prompt: a malformed answer');
    } catch (e) {
      err = e;
    }
    // The session's end ends the turn.
    if (this.turn !== t || err instanceof ClosedError || this.ac.signal.aborted) return;
    this.it.endTurn();
    this.turn = null;
    t.ac.abort();
    if (err !== undefined) {
      this.emit({ t: EventType.Turn, state: TurnState.Error, error: callError(err) });
    } else {
      const r: Obj = isObj(res) ? res : {};
      const stopReason = str(r.stopReason)!;
      this.emit({ t: EventType.Turn, state: TurnState.End, ...(stopReason ? { stopReason } : {}) });
      this.turnUsage(r);
    }
    const q = this.queue.shift();
    if (q && !this.closing) {
      this.emit(queuedEvent(QueuedState.Taken, q, true));
      this.startTurn(q.content, undefined);
    } else if (q) {
      this.queue.unshift(q);
    }
  }

  /** Takes what an answer's _meta tells of the turn (Grok's): the context
   * in use, when the agent sends no usage_update, and the turn's cost, added
   * to the session's, when it sends no cost. */
  private turnUsage(res: Obj): void {
    if (!present(res._meta)) return;
    const m = turnMeta(res._meta);
    if (!m) return;
    const setContext = !this.sawUsage && m.totalTokens > 0;
    const used = m.totalTokens;
    const size = this.sizes.get(m.modelId) ?? 0;
    const cost = !this.sawCost && m.costUsdTicks > 0 ? m.costUsdTicks * USD_PER_TICK : 0;
    if (!setContext && cost === 0) return;
    this.sink.update((c) => {
      const usage = cloneUsage(c.usage);
      if (setContext) withContext(usage, used, size);
      if (cost > 0) {
        if (!usage.cost || usage.cost.currency !== 'USD') usage.cost = { amount: 0, currency: 'USD' };
        usage.cost.amount += cost;
      }
      c.usage = usage;
    });
  }

  /** Cancels the running turn: the agent is told, the permissions it asks
   * are answered as cancelled, and the queued messages are withdrawn. */
  async cancel(): Promise<void> {
    const e = this.usable();
    if (e) throw e;
    this.dropQueue();
    const t = this.turn;
    if (!t) return;
    t.ac.abort();
    try {
      await this.conn.notify('session/cancel', { sessionId: this.sid });
    } catch (err) {
      throw new ChatProtoError(callError(err));
    }
  }

  /** Withdraws every queued message. */
  private dropQueue(): void {
    for (const q of this.queue) this.emit(queuedEvent(QueuedState.Cancelled, q, false));
    this.queue = [];
  }

  async cancelQueued(message: string): Promise<void> {
    const e = this.usable();
    if (e) throw e;
    const i = this.queue.findIndex((q) => q.message === message);
    if (i < 0) throw perr(Code.NotFound, 'no such message waits');
    const [q] = this.queue.splice(i, 1);
    this.emit(queuedEvent(QueuedState.Cancelled, q!, false));
  }

  /** Sets a configuration option: through session/set_mode for the option
   * made of the agent's session modes, else session/set_config_option. */
  async setConfig(id: string, value: string, signal: AbortSignal): Promise<void> {
    const e = this.usable();
    if (e) throw e;
    const o = optionByID(this.config, id);
    if (!o) throw perr(Code.BadRequest, 'the chat has no such option');
    if (!hasValue(o, value)) throw perr(Code.BadRequest, 'not a value of the option');
    await this.set(signal, this.sid, id, value, id === this.legacy);
  }

  /** Sets an option the agent has to one of its values. */
  private async set(signal: AbortSignal, session: string, id: string, value: string, legacy: boolean): Promise<void> {
    if (legacy) {
      try {
        await this.conn.call('session/set_mode', { sessionId: session, modeId: value }, { ms: this.t.call, signal });
      } catch (err) {
        throw new ChatProtoError(callError(err));
      }
      const o = optionByID(this.config, id);
      if (o && !this.ended) {
        o.currentValue = value;
        this.stateConfig();
      }
      return;
    }
    let res: unknown;
    try {
      res = await this.conn.call('session/set_config_option', { sessionId: session, configId: id, value }, { ms: this.t.call, signal });
      if (res !== null && !isObj(res)) throw new Error('acp: session/set_config_option: a malformed answer');
    } catch (err) {
      throw new ChatProtoError(callError(err));
    }
    if (this.ended) return;
    if (isObj(res) && present(res.configOptions)) {
      this.takeConfig(res.configOptions, undefined);
      return;
    }
    const o = optionByID(this.config, id);
    if (o) {
      o.currentValue = value;
      this.stateConfig();
    }
  }

  /** The protocol has no way to compact; an agent's own command (/compact)
   * is a prompt. */
  async compact(): Promise<void> {
    throw perr(Code.Unsupported, 'the agent compacts by its own command only');
  }

  /** Ends the agent gracefully: its input closes, SIGTERM follows after a
   * grace period and SIGKILL after another one. Resolves once the agent is
   * gone or signal ends. */
  async close(signal?: AbortSignal): Promise<void> {
    this.closing = true;
    void this.proc.stop(this.t);
    if (!signal) {
      await this.done;
      return;
    }
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
      void this.done.then(() => resolve());
    });
  }

  /** Marks the session as being ended by its owner (a start that failed). */
  markClosing(): void {
    this.closing = true;
  }

  /** Waits for the agent's end: its output closing, or its process exiting
   * while a program it started still holds the output. */
  private async watch(): Promise<void> {
    await Promise.race([this.conn.closed, this.proc.exited]);
    if (!this.conn.ended) {
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.conn.closed, new Promise<void>((r) => (t = setTimeout(r, this.t.drain)))]);
      clearTimeout(t);
    }
    await this.proc.stop(this.t);
    this.conn.close();
    this.finish();
  }

  /** Ends the session once its process is gone: a turn that ran ends with
   * an error, the queued messages are withdrawn, and what waits for the user
   * returns. */
  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.closing) {
      const status = this.proc.status();
      const stderr = this.proc.stderr();
      this.err = { code: Code.Ended, message: 'the agent exited' + (status ? ` (${status})` : ''), ...(stderr ? { stderr } : {}) };
    }
    const t = this.turn;
    this.it.endTurn();
    if (t) {
      this.turn = null;
      t.ac.abort();
      this.emit({ t: EventType.Turn, state: TurnState.Error, error: { code: Code.Ended, message: 'the agent is gone' } });
    }
    this.dropQueue();
    this.ac.abort();
    this.resolveDone(this.err);
  }
}

/** A queued event of a message: with its content while it waits and when
 * the agent took it, without when it was withdrawn. */
function queuedEvent(state: string, q: Queued, content: boolean): Event {
  return {
    t: EventType.Queued,
    ...(content ? { content: q.content } : {}),
    ...(q.clientId ? { clientId: q.clientId } : {}),
    ...(q.message ? { message: q.message } : {}),
    state,
  };
}
