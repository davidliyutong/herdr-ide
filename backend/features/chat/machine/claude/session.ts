// One chat's Claude Code session: a run of the user's claude through the
// Agent SDK's query() (a Run; another one replaces it when the chat goes
// into full access), its messages as the chat's events, the user's
// prompts as turns or queued messages, and the controls.
//
// Everything runs on the host's one thread: the SDK hands the program's
// messages on in their order, and take() maps each one synchronously to
// the sink. A request of the program's (canUseTool) is asked of the sink
// once the messages before it were taken, so that the host has a tool
// call's event before the permission asked for it.
//
// What the SDK's messages become: stream_event deltas live increments (an
// item is a message's content block, "<message id>/<block index>", or a
// tool call by its id), the assistant message of a block the block's whole
// event, tool results tool call updates (the transcript's mapping, the one
// imports use), a subagent's messages events with its parent, system and
// result messages turns, notices and the chat's usage.
import { randomUUID } from 'node:crypto';
import type { Options, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { SLUG } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { Notice, Transcript, noticeMethod } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ChatProtoError, Code, EventType, QueuedState, TurnState, type ChatError, type Event } from '#shared/proto/chatproto/index.ts';
import { Resolver } from '#machine/agents/sessions.ts';
import type { PromptParams, Session, Sink, StartParams } from '../adapter.ts';
import type { StopTiming } from '../agentproc.ts';
import {
  Config,
  EFFORT_DEFAULT,
  MAX_LIMITS,
  MAX_TEXT,
  OPTION_EFFORT,
  OPTION_MODE,
  OPTION_MODEL,
  chatMode,
  claudeMode,
  cut,
  firstOf,
  modelsOf,
  slashCommands,
} from './config.ts';
import { badRequest, claudeContent, textBlock } from './content.ts';
import { titleOf } from './history.ts';
import { eventOf, frameOf, headOf, isChunk, isObj, itemOf, live, num, ownMeta, str, toolCallUpdate, withMeta, type Obj } from './items.ts';
import { DENY_UNASKED, decide } from './permissions.ts';
import { AgentSpawn, Prompts, cancelAsyncMessage, spawner } from './sdk.ts';
import type { SdkModule } from './load.ts';
import { trustedByClaude } from './trust.ts';

/** A session's times, in milliseconds; shorter in tests. */
export interface ClaudeTiming extends StopTiming {
  /** The answer to initialize. */
  initialize: number;
  /** The answer to every other control request. */
  request: number;
  /** When after a turn's end the session's title is read from its
   * transcript: Claude Code writes the title it makes (ai-title) there, not
   * on its output, and may write it after the turn. */
  titles: number[];
}

export const CLAUDE_TIMING: ClaudeTiming = {
  initialize: 60_000,
  request: 30_000,
  grace: 2000,
  term: 5000,
  drain: 1000,
  titles: [0, 5000],
};

/** Bounds the maps of tool calls, tasks and messages a session keeps for
 * its subagents' events: beyond it they start over (an event of an older
 * subagent then has no parent). */
const MAX_TRACKED = 4096;
const MAX_PENDING_PROMPTS = 16;
/** The most kinds of what is passed over a session logs (once each). */
const MAX_UNKNOWN = 64;

/** The SDK's version, which query() tells the program in its environment. */
const SDK_VARIABLE = 'CLAUDE_AGENT_SDK_VERSION';

/** What Claude Code writes to its standard error when it is to resume a
 * session it does not have. */
const NO_SESSION = 'No conversation found with session ID';

const perr = (code: string, message: string): ChatProtoError => new ChatProtoError({ code, message });
const gone = (): ChatProtoError => perr(Code.Ended, 'claude: the agent ended');
const busy = (): ChatProtoError => perr(Code.Busy, 'claude: a turn runs');
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** err as a ChatError, of code when it is none. */
function asError(err: unknown, code: string): ChatError {
  if (err instanceof ChatProtoError) return { ...err.error };
  return { code, message: messageOf(err) };
}

/** Settles as p, or rejects with timeout() after ms or with signal's
 * reason. */
function within<T>(p: Promise<T>, ms: number, signal: AbortSignal | undefined, timeout: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => done(() => reject(timeout())), ms);
    const abort = () => done(() => reject(signal!.reason as Error));
    const done = (f: () => void) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', abort);
      f();
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    p.then(
      (v) => done(() => resolve(v)),
      (e: unknown) => done(() => reject(e as Error)),
    );
  });
}

/** Settles as p, or rejects with signal's reason once it ends. */
function orAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', abort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(e as Error);
      },
    );
  });
}

/** Waits for the next turn of the event loop: what the SDK took before is
 * handed on by then. */
const nextTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A message of the user's sent to the program. */
interface Sent {
  uuid: string;
  message: string;
  clientId: string;
  content: unknown[];
  /** It was sent while a turn ran; the program took it. */
  queued: boolean;
  taken: boolean;
}

/** A response of the main agent being streamed. */
interface Stream {
  message: string;
  /** The index of the content block being streamed, -1 for none; kind its
   * type, tool its tool call's id. */
  open: number;
  kind: string;
  tool: string;
  /** The thinking's estimated tokens. */
  estimated: number;
}

const noStream = (): Stream => ({ message: '', open: -1, kind: '', tool: '', estimated: 0 });

/** What initialize answers, as the SDK hands it on. */
type Init = Obj;

/** A run of the program: one query() and its process. */
class Run {
  q!: Query;
  spawn: AgentSpawn | null = null;
  readonly prompts = new Prompts();
  readonly ac = new AbortController();
  /** Every message was taken and the program and its group are gone. */
  over = false;
  /** Why it ended, once over. */
  err: ChatError | undefined;
  readonly done: Promise<void>;
  resolveDone!: () => void;

  constructor() {
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  /** No answer comes any more: the program's output ended. */
  get silent(): boolean {
    return this.over || (this.spawn?.outputEnded ?? false);
  }
}

/** A chat's Claude Code session. */
export class ClaudeSession implements Session {
  readonly id: string;
  readonly done: Promise<ChatError | undefined>;
  /** Lines of the program's output passed over and frames not known
   * (tests). */
  unknown = 0;
  private resolveDone!: (e: ChatError | undefined) => void;
  private readonly p: StartParams;
  private readonly sink: Sink;
  private readonly t: ClaudeTiming;
  private readonly log: Logger;
  private readonly resolver: Resolver;
  /** The pids of the programs the adapter runs (its inTerminal passes over
   * their records). */
  private readonly own: Set<number>;
  /** The Agent SDK, loaded at run time (load.ts). */
  private readonly sdk: SdkModule;

  /** The run now; restarting: it is being replaced, which restartAbort
   * calls off. */
  private run: Run | null = null;
  private restarting = false;
  private restartAbort: AbortController | null = null;
  private closing = false;
  private ended = false;
  /** The program loads the project's own settings. */
  private trusted = false;
  /** The session's title stated last (readTitle). */
  private title = '';
  private titleTimers = new Set<ReturnType<typeof setTimeout>>();

  /** A turn runs; authFailed: an assistant message of the turn said that
   * the program is not signed in. */
  private inTurn = false;
  private authFailed = false;
  /** This session was resumed or a turn has started: initialize alone
   * makes no conversation for --resume to load. */
  private hasConversation: boolean;
  /** The user's messages the program has not completed, by the uuid they
   * were sent with; byMessage maps the host's message ids to them. */
  private sent = new Map<string, Sent>();
  private byMessage = new Map<string, string>();
  private stream = noStream();
  /** The content blocks seen of each assistant message, for the items of
   * messages without a stream (subagents'). */
  private blocks = new Map<string, number>();
  /** The program's tasks (a subagent's agent_id is its task id) and the tool
   * calls that started them; the subagent's tool call each tool call
   * belongs to ("" for the main agent). */
  private tasks = new Map<string, string>();
  private toolParent = new Map<string, string>();
  /** The program's requests that wait for the user. */
  private waiting = 0;

  private readonly cfg: Config;
  /** The model the program says it runs (system/init). */
  private running = '';
  /** What the program is started with, and was started with last. */
  private modelArg: string;
  private launchModel = '';
  /** The run was started allowed to skip permissions. */
  private launchedFull = false;
  private usage: chat.Usage = { used: 0, size: 0 };
  private readonly seen = new Set<string>();

  constructor(p: StartParams, sink: Sink, id: string, t: ClaudeTiming, own: Set<number>, sdk: SdkModule) {
    this.p = p;
    this.sdk = sdk;
    this.own = own;
    this.sink = sink;
    this.id = id;
    this.t = t;
    this.log = p.logger;
    this.resolver = new Resolver({ home: p.env.HOME ?? '', getenv: (k) => p.env[k] });
    this.cfg = new Config(p.options.effort || EFFORT_DEFAULT, p.options.mode || chat.Mode.Default);
    this.modelArg = p.options.model ?? '';
    this.hasConversation = p.resume !== '';
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  get pid(): number {
    if (this.ended || !this.run?.spawn) return 0;
    return this.run.spawn.pid;
  }

  /** Control requests that wait for their answers (tests). */
  calls = 0;

  /** Lines of the run's output handed to the SDK (tests). */
  get linesRead(): number {
    return this.run?.spawn?.lines ?? 0;
  }

  /** A turn runs (tests). */
  get turnRuns(): boolean {
    return this.inTurn;
  }

  /** Counts what is passed over, and logs its kind once. */
  private pass(kind: string): void {
    this.unknown++;
    if (this.seen.has(kind) || this.seen.size >= MAX_UNKNOWN) return;
    this.seen.add(kind);
    this.log(`claude: passing over ${kind}`);
  }

  private emit(ev: Event): void {
    this.sink.event(ev);
  }

  // ---- runs ----

  /** Starts the program, initializes it and applies the chat's options; on
   * an error the program is ended. In a folder nobody trusted the program
   * starts without the project's own settings, which a notice tells. */
  async begin(signal: AbortSignal): Promise<void> {
    const full = this.cfg.mode === chat.Mode.Full;
    this.trusted = this.p.trusted || (await trustedByClaude(this.p.env, this.p.cwd, this.log));
    const { run, init } = await this.launch(this.p.resume !== '', full, signal);
    try {
      await this.setup(run, init, full, signal);
    } catch (e) {
      this.closing = true;
      run.spawn?.killNow();
      await this.done;
      throw e;
    }
    if (!this.trusted) this.emit({ t: EventType.Notice, method: noticeMethod(Notice.UntrustedFolder), params: { cwd: this.p.cwd } });
  }

  /** The program's environment: the host's, with the SDK's variables (which
   * the SDK sets, NODE_OPTIONS dropped) and the entry point the product's
   * name: Claude Code hides the SDK's own entry points' sessions from the
   * terminal's /resume, and a chat may go on in a terminal. DEBUG and
   * DEBUG_CLAUDE_AGENT_SDK go too: the SDK drops DEBUG only when the other
   * is not set, and sets DEBUG=1 for the program when it is, which would
   * have the program write its debug log of the chat. */
  private env(): Record<string, string> {
    const env = { ...this.p.env };
    delete env.CLAUDE_AGENT_SDK_VERSION;
    delete env.CLAUDE_CODE_SDK_READS_SESSION_STATE;
    delete env.NODE_OPTIONS;
    delete env.DEBUG;
    delete env.DEBUG_CLAUDE_AGENT_SDK;
    env.CLAUDE_CODE_ENTRYPOINT = SLUG;
    return env;
  }

  /** query()'s options of a run. */
  private options(run: Run, resume: boolean, full: boolean): Options {
    let mode = this.p.options.mode || chat.Mode.Default;
    if (full) mode = chat.Mode.Full;
    else if (mode === chat.Mode.Full) mode = chat.Mode.Default;
    this.launchModel = this.modelArg;
    return {
      pathToClaudeCodeExecutable: this.p.argv[0],
      spawnClaudeCodeProcess: spawner(
        { procs: this.p.procs, argv: this.p.argv, timing: this.t, skipped: () => this.pass('a line longer than chatproto.MAX_LINE') },
        (s) => {
          run.spawn = s;
          s.started.then(
            (proc) => {
              this.own.add(proc.pid);
              void proc.exited.then(() => this.own.delete(proc.pid));
            },
            () => {},
          );
        },
      ),
      cwd: this.p.cwd,
      env: this.env(),
      // Without it the SDK gives Claude Code an empty system prompt.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // The project's own settings (and with them its hooks, MCP servers
      // and CLAUDE.md) only in a folder someone trusted: Claude Code asks
      // nothing of a program it runs headless.
      settingSources: this.trusted ? ['user', 'project', 'local'] : ['user'],
      permissionMode: claudeMode(mode),
      ...(full ? { allowDangerouslySkipPermissions: true } : {}),
      includePartialMessages: true,
      ...(resume ? { resume: this.id } : { sessionId: this.id }),
      ...(this.launchModel ? { model: this.launchModel } : {}),
      canUseTool: (tool, input, o) =>
        this.canUseTool(run, { tool, input, toolUseId: o.toolUseID, suggestions: o.suggestions, agentId: o.agentID ?? '' }, o.signal),
      abortController: run.ac,
    };
  }

  /** Starts a run of the program and initializes it; the run is the
   * session's from its start unless the session is restarting. */
  private async launch(resume: boolean, full: boolean, signal: AbortSignal): Promise<{ run: Run; init: Init }> {
    const run = new Run();
    // query() sets the variable in the host's own environment, which the
    // host gives the login shell whose environment every agent gets.
    const own = process.env[SDK_VARIABLE];
    try {
      run.q = this.sdk.query({ prompt: run.prompts, options: this.options(run, resume, full) });
    } catch (e) {
      throw perr(Code.StartFailed, 'claude: ' + messageOf(e));
    } finally {
      if (own === undefined) delete process.env[SDK_VARIABLE];
      else process.env[SDK_VARIABLE] = own;
    }
    if (!this.restarting) this.run = run;
    this.launchedFull = full;
    void this.consume(run);
    try {
      await run.spawn!.started;
    } catch (e) {
      await run.done;
      throw perr(Code.StartFailed, 'claude: ' + messageOf(e));
    }
    try {
      const init = await within(run.q.initializationResult() as Promise<unknown>, this.t.initialize, signal, () =>
        perr(Code.Failed, `claude: no answer to initialize within ${this.t.initialize / 1000}s`),
      );
      return { run, init: isObj(init) ? init : {} };
    } catch (e) {
      run.spawn!.killNow();
      await run.done;
      const err = this.startError(run, resume);
      err.message = 'claude: initialize: ' + messageOf(e) + '; ' + err.message;
      throw new ChatProtoError(err);
    }
  }

  /** Why a run ended: its exit and the end of its standard error. */
  private exitError(run: Run, code: string): ChatError {
    const proc = run.spawn?.process;
    let message = 'claude exited';
    const status = proc?.status() ?? '';
    if (status !== '' && status !== 'exit status 0') message += ': ' + status;
    const e: ChatError = { code, message };
    const stderr = proc?.stderr() ?? '';
    if (stderr) e.stderr = stderr;
    return e;
  }

  /** Why a run did not start: its end, as not_found when it had no such
   * session to resume. */
  private startError(run: Run, resume: boolean): ChatError {
    const e = this.exitError(run, Code.StartFailed);
    if (resume && e.stderr?.includes(NO_SESSION)) {
      e.code = Code.NotFound;
      e.message = 'claude: no such session; ' + e.message;
    }
    return e;
  }

  /** Takes a run's messages until they end, then ends the session unless
   * the run was replaced. */
  private async consume(run: Run): Promise<void> {
    try {
      for await (const m of run.q)
        try {
          this.take(run, m);
        } catch (e) {
          this.log(`claude: a message not taken: ${messageOf(e)}`);
        }
    } catch {
      // The run's end tells why (exitError).
    }
    run.prompts.end(gone());
    if (run.spawn) {
      void run.spawn.stop();
      await run.spawn.ended;
    }
    run.err = this.exitError(run, Code.Ended);
    run.over = true;
    run.resolveDone();
    this.finish(run, run.err);
  }

  /** Takes what initialize said and applies the chat's options: the model
   * (pinned to the id an alias resolves to, which plan mode would otherwise
   * map to another model) and the effort; then the context's usage. */
  private async setup(run: Run, init: Init, full: boolean, signal: AbortSignal): Promise<void> {
    this.cfg.models = modelsOf(init.models);
    const version = str(init.claude_code_version);
    const commands = slashCommands(init.commands);
    const want = this.cfg.model || this.p.options.model || '';
    if (want !== '') {
      const m = this.cfg.find(want);
      if (!m) throw badRequest('unknown model ' + want);
      this.cfg.model = m.value;
      if (m.resolved !== '' && m.resolved !== this.launchModel) await this.call(run, 'set_model', (q) => q.setModel(m.resolved), signal);
      this.modelArg = firstOf(m.resolved, m.value);
    }
    const effort = this.cfg.effort;
    if (effort !== EFFORT_DEFAULT) {
      if (!this.cfg.levels().includes(effort)) throw badRequest('the model has no effort ' + effort);
      await this.call(run, 'apply_flag_settings', (q) => q.applyFlagSettings({ effortLevel: effort as 'low' }), signal);
    }
    try {
      this.takeContextUsage(await this.call(run, 'get_context_usage', (q) => q.getContextUsage({ detail: 'summary' }), signal));
    } catch {
      // without it
    }
    const mode = chatMode(init.current_permission_mode);
    if (mode !== '') this.cfg.mode = mode;
    if (full) this.cfg.mode = chat.Mode.Full;
    const id = this.id;
    this.sink.update((c) => {
      c.sessionId = id;
      if (version) c.agentVersion = version;
      if (commands.length > 0) c.commands = commands;
      else delete c.commands;
    });
    this.configChanged();
  }

  /** Sends a control request of the run's through f: its answer, within
   * the request timeout and signal; ended once the program's output ended. */
  private async call<T>(run: Run, what: string, f: (q: Query) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (run.silent) throw gone();
    this.calls++;
    try {
      return await within(f(run.q), this.t.request, signal, () =>
        perr(Code.Failed, `claude: no answer to ${what} within ${this.t.request / 1000}s`),
      );
    } catch (e) {
      if (e instanceof ChatProtoError) throw e;
      if (run.silent) throw gone();
      if (signal?.aborted) throw e;
      throw perr(Code.Failed, 'claude: ' + messageOf(e));
    } finally {
      this.calls--;
    }
  }

  /** The run now; an error when the session ended or is being restarted. */
  private current(): Run {
    if (this.ended || !this.run) throw gone();
    if (this.restarting) throw perr(Code.Busy, 'claude: the agent is being restarted');
    // Its output ended: it is about to end the session.
    if (this.run.silent) throw gone();
    return this.run;
  }

  /** Ends the session after its run ended: err is why, none after close().
   * A turn that ran fails, the queued messages are withdrawn. */
  private finish(run: Run, err: ChatError | undefined): void {
    if (this.ended || run !== this.run || this.restarting) return;
    this.ended = true;
    if (this.closing) err = undefined;
    for (const u of [...this.sent.keys()].sort()) this.withdrawn(u);
    this.sent.clear();
    this.byMessage.clear();
    const e = err ?? gone().error;
    const error: ChatError = { code: Code.Ended, message: e.message };
    if (e.stderr) error.stderr = e.stderr;
    this.endTurn({ t: EventType.Turn, state: TurnState.Error, error });
    for (const t of this.titleTimers) clearTimeout(t);
    this.titleTimers.clear();
    this.resolveDone(err);
  }

  /** Ends a run that is the session's and is over already (its messages
   * ended before it was the session's). */
  private finishOver(run: Run): void {
    if (run.over) this.finish(run, run.err);
  }

  // ---- what the chat states ----

  private configChanged(): void {
    const { config, capabilities } = this.cfg.state();
    this.sink.update((c) => {
      c.config = config;
      c.capabilities = capabilities;
    });
  }

  private usageChanged(): void {
    const u: chat.Usage = { used: this.usage.used, size: this.usage.size };
    if (this.usage.percentage) u.percentage = this.usage.percentage;
    if (this.usage.cost) u.cost = { ...this.usage.cost };
    if (this.usage.limits && this.usage.limits.length > 0) u.limits = this.usage.limits.map((l) => ({ ...l }));
    this.sink.update((c) => (c.usage = u));
  }

  /** States what get_context_usage answered. */
  private takeContextUsage(cu: unknown): void {
    if (!isObj(cu)) return;
    const max = num(cu.maxTokens);
    const model = str(cu.model);
    if (max > 0) {
      this.usage.used = num(cu.totalTokens);
      this.usage.size = max;
      this.usage.percentage = num(cu.percentage);
    }
    if (model !== '' && this.running === '') this.running = model;
    if (model !== '' && this.cfg.model === '') {
      // The program's own default model: the list's value of it, the model
      // itself, else the default that resolves to it.
      this.cfg.model = this.cfg.valueOf(model);
      if (this.cfg.model !== '') this.configChanged();
    }
    this.usageChanged();
  }

  /** States the program's permission mode. */
  private takeMode(mode: unknown): void {
    const m = chatMode(mode);
    if (m !== '' && m !== this.cfg.mode) {
      this.cfg.mode = m;
      this.configChanged();
    }
  }

  // ---- turns ----

  private startTurn(): void {
    this.inTurn = true;
    this.authFailed = false;
    this.hasConversation = true;
    this.emit({ t: EventType.Turn, state: TurnState.Start });
  }

  /** Starts a turn unless one runs: the program works (a message it took, a
   * background task's notification). */
  private ensureTurn(): void {
    if (!this.inTurn) this.startTurn();
  }

  private endTurn(ev: Event): void {
    if (!this.inTurn) return;
    for (const m of this.sent.values()) if (!m.queued || m.taken) this.forget(m);
    this.inTurn = false;
    this.stream = noStream();
    this.emit(ev);
    this.titleSoon();
  }

  /** Reads the session's title after a turn's end (ClaudeTiming.titles). */
  private titleSoon(): void {
    for (const d of this.t.titles) {
      const t = setTimeout(() => {
        this.titleTimers.delete(t);
        void this.readTitle();
      }, d);
      this.titleTimers.add(t);
    }
  }

  /** States the session's title its transcript has (the user's own before
   * the one Claude Code made) when it is another than the one stated last. */
  async readTitle(): Promise<void> {
    if (this.ended || this.closing) return;
    let title: string;
    try {
      title = await titleOf(this.resolver, this.id);
    } catch {
      return;
    }
    if (title === '' || this.ended) return;
    const changed = title !== this.title;
    this.title = title;
    if (changed) this.sink.update((c) => (c.title = title));
  }

  // ---- the program's messages ----

  /** Takes a message of a run's program. */
  private take(run: Run, m: unknown): void {
    if (!isObj(m)) return;
    switch (m.type) {
      case 'stream_event':
        return this.streamEvent(m);
      case 'assistant':
        return this.assistant(m);
      case 'user':
        return this.user(m);
      case 'system':
        return this.system(m);
      case 'result':
        return this.result(run, m);
      case 'command_lifecycle':
        return this.lifecycle(m);
      case 'rate_limit_event':
        return this.rateLimit(m);
      case 'tool_progress':
      case 'tool_use_summary':
      case 'auth_status':
      case 'prompt_suggestion':
      case 'streamlined_text':
      case 'streamlined_tool_use_summary':
        // Known, and nothing the chat shows.
        return;
    }
    this.pass('frame ' + str(m.type));
  }

  private streamEvent(m: Obj): void {
    // Subagents do not stream; their messages come whole.
    if (str(m.parent_tool_use_id) !== '') return;
    this.taken(this.sent.get(str(m.user_message_uuid)));
    const ev = m.event;
    if (!isObj(ev)) return this.pass('a stream_event of another shape');
    const st = this.stream;
    switch (ev.type) {
      case 'message_start':
        this.ensureTurn();
        if (isObj(ev.message)) this.stream = { ...noStream(), message: str(ev.message.id) };
        return;
      case 'content_block_start': {
        const b = ev.content_block;
        if (!isObj(b)) return;
        st.open = num(ev.index);
        st.kind = str(b.type);
        st.tool = '';
        st.estimated = 0;
        if ((b.type === 'tool_use' || b.type === 'server_tool_use') && str(b.id) !== '') {
          st.tool = str(b.id);
          const u = toolCallUpdate(st.tool, str(b.name), {});
          if (u) this.emit(live(st.tool, u));
        }
        return;
      }
      case 'content_block_delta': {
        const d = ev.delta;
        if (!isObj(d) || num(ev.index) !== st.open || st.message === '') return;
        const item = itemOf(st.message, st.open);
        if (d.type === 'text_delta') {
          if (str(d.text) !== '')
            this.emit(live(item, { sessionUpdate: 'agent_message_chunk', content: textBlock(str(d.text)), messageId: st.message }));
        } else if (d.type === 'thinking_delta') {
          const u: Obj = { sessionUpdate: 'agent_thought_chunk', content: textBlock(str(d.thinking)), messageId: st.message };
          if (typeof d.estimated_tokens === 'number') {
            // Claude Code keeps the thinking's text to itself: what is shown
            // is how much of it there is.
            st.estimated = d.estimated_tokens;
            u._meta = ownMeta({ estimatedTokens: st.estimated });
          } else if (str(d.thinking) === '') return;
          this.emit(live(item, u));
        }
        return;
      }
      case 'content_block_stop':
        if (num(ev.index) === st.open) st.open = -1;
        return;
      case 'message_delta':
      case 'message_stop':
        return;
    }
    this.pass('stream event ' + str(ev.type));
  }

  /** Remembers the agent a tool call belongs to. */
  private trackTool(id: string, parent: string): void {
    if (this.toolParent.size >= MAX_TRACKED) this.toolParent = new Map();
    this.toolParent.set(id, parent);
  }

  private assistant(m: Obj): void {
    const parent = str(m.parent_tool_use_id);
    if (m.error === 'authentication_failed') this.authFailed = true;
    if (parent === '') {
      this.ensureTurn();
      this.taken(this.sent.get(str(m.user_message_uuid)));
    }
    const fr = frameOf(m);
    this.unknown += fr.unknown;
    const st = this.stream;
    let base = this.blocks.get(fr.message) ?? 0;
    if (parent === '' && fr.message !== '' && fr.message === st.message && st.open >= 0 && fr.count === 1) base = st.open;
    else if (fr.first >= 0) base = fr.first;
    fr.events.forEach((ev, k) => {
      if (ev.t === Transcript.Notice) return this.emit(eventOf(ev, parent));
      if (ev.t !== Transcript.Update) return;
      const h = headOf(ev.update);
      if (h.sessionUpdate === 'usage_update') return;
      const e = eventOf(ev, parent);
      if (isChunk(h.sessionUpdate) && fr.message !== '') {
        const block = base + Math.max(fr.blocks[k] ?? -1, 0);
        e.item = itemOf(fr.message, block);
        if (h.sessionUpdate === 'agent_thought_chunk' && parent === '' && block === st.open && st.estimated > 0)
          e.update = withMeta(e.update, 'estimatedTokens', st.estimated);
      } else if (h.toolCallId !== '') {
        e.item = h.toolCallId;
        if (h.sessionUpdate === 'tool_call') this.trackTool(h.toolCallId, parent);
      }
      this.emit(e);
    });
    if (fr.message !== '') {
      const n = Math.max(this.blocks.get(fr.message) ?? 0, base + fr.count);
      this.blocks.set(fr.message, n);
      if (this.blocks.size > MAX_TRACKED) this.blocks = new Map([[fr.message, n]]);
    }
  }

  private user(m: Obj): void {
    // Echoes of the user's messages, and the summary of a compaction.
    if (m.isSynthetic !== true) this.taken(this.sent.get(str(m.uuid)));
    if (m.isReplay === true || m.isSynthetic === true) return;
    const parent = str(m.parent_tool_use_id);
    const fr = frameOf(m);
    this.unknown += fr.unknown;
    for (const ev of fr.events) {
      // The prompt a subagent was given, the record of an interrupt: the
      // turn's own events say those.
      if (ev.t !== Transcript.Update) continue;
      const h = headOf(ev.update);
      if (h.sessionUpdate !== 'tool_call_update' && h.sessionUpdate !== 'plan') continue;
      const e = eventOf(ev, parent);
      if (h.toolCallId !== '') e.item = h.toolCallId;
      this.emit(e);
    }
  }

  private notice(name: string, params?: unknown): void {
    const ev: Event = { t: EventType.Notice, method: noticeMethod(name) };
    if (params !== undefined) ev.params = params;
    this.emit(ev);
  }

  private system(m: Obj): void {
    const usage = isObj(m.usage) ? m.usage : null;
    switch (m.subtype) {
      case 'init':
        this.ensureTurn();
        if (str(m.model) !== '') this.running = str(m.model);
        this.takeMode(m.permissionMode);
        return;
      case 'status': {
        this.takeMode(m.permissionMode);
        if (m.status === 'compacting') this.notice(Notice.Compacting);
        const r = str(m.compact_result);
        if (r !== '' && r !== 'success')
          this.notice(Notice.Error, { message: cut(firstOf(str(m.compact_error), 'compact: ' + r), MAX_TEXT) });
        return;
      }
      case 'api_retry': {
        // A request failed and is tried again.
        let msg = firstOf(str(m.error), 'the API request failed');
        if (typeof m.error_status === 'number' && m.error_status > 0) msg = `${m.error_status} ${msg}`;
        this.notice(Notice.Error, { message: cut(msg, MAX_TEXT), willRetry: true });
        return;
      }
      case 'compact_boundary': {
        const params: Obj = {};
        const md = m.compact_metadata;
        if (isObj(md)) {
          if (str(md.trigger) !== '') params.trigger = md.trigger;
          if (num(md.pre_tokens) > 0) params.preTokens = md.pre_tokens;
          if (num(md.post_tokens) > 0) params.postTokens = md.post_tokens;
        }
        this.notice(Notice.Compacted, params);
        return;
      }
      case 'session_state_changed':
        if (m.state === 'running') this.ensureTurn();
        // After the turn's result; a turn that had none ends here.
        else if (m.state === 'idle') this.endTurn({ t: EventType.Turn, state: TurnState.End, stopReason: 'end_turn' });
        return;
      case 'commands_changed':
        if (Array.isArray(m.commands)) {
          const commands = slashCommands(m.commands);
          this.sink.update((c) => {
            if (commands.length > 0) c.commands = commands;
            else delete c.commands;
          });
        }
        return;
      case 'task_started': {
        const task = str(m.task_id);
        const tool = str(m.tool_use_id);
        if (task !== '' && tool !== '') {
          if (this.tasks.size >= MAX_TRACKED) this.tasks = new Map();
          this.tasks.set(task, tool);
          this.task(tool, 'in_progress', { type: str(m.task_type), description: cut(str(m.description), MAX_TEXT) });
        }
        return;
      }
      case 'task_progress': {
        const tool = str(m.tool_use_id);
        if (tool !== '' && usage)
          this.task(tool, '', {
            description: cut(str(m.description), MAX_TEXT),
            lastTool: str(m.last_tool_name),
            tokens: num(usage.total_tokens),
            toolUses: num(usage.tool_uses),
            durationMs: num(usage.duration_ms),
          });
        return;
      }
      case 'task_updated': {
        const tool = this.tasks.get(str(m.task_id)) ?? '';
        if (tool !== '' && isObj(m.patch)) {
          const status = taskStatus(str(m.patch.status));
          if (status !== '') this.task(tool, status, null);
        }
        return;
      }
      case 'task_notification': {
        const tool = firstOf(str(m.tool_use_id), this.tasks.get(str(m.task_id)) ?? '');
        if (tool !== '') {
          const meta: Obj = { summary: cut(str(m.summary), MAX_TEXT) };
          if (usage) {
            meta.tokens = num(usage.total_tokens);
            meta.toolUses = num(usage.tool_uses);
            meta.durationMs = num(usage.duration_ms);
          }
          this.task(tool, taskStatus(str(m.status)), meta);
          this.tasks.delete(str(m.task_id));
        }
        return;
      }
      case 'local_command_output':
        if (str(m.content).trim() !== '') this.notice(Notice.Command, { output: cut(str(m.content), MAX_TEXT) });
        return;
      case 'thinking_tokens':
      case 'hook_started':
      case 'hook_progress':
      case 'hook_response':
      case 'files_persisted':
      case 'notification':
      case 'informational':
      case 'plugin_install':
      case 'background_tasks_changed':
      case 'memory_recall':
      case 'permission_denied':
      case 'elicitation_complete':
      case 'model_refusal_fallback':
      case 'model_refusal_no_fallback':
      case 'mirror_error':
      case 'session_writes_lost':
      case 'conversation_reset':
      case 'worker_shutting_down':
      case 'control_request_progress':
        // Known, and nothing the chat shows.
        return;
    }
    this.pass('system/' + str(m.subtype));
  }

  /** Updates the tool call of a task (a subagent's Agent call, a command's
   * Bash call): its status, and _meta.<slug>.task. */
  private task(tool: string, status: string, meta: Obj | null): void {
    const u: Obj = { sessionUpdate: 'tool_call_update', toolCallId: tool };
    if (status !== '') u.status = status;
    if (meta) u._meta = ownMeta({ task: meta });
    const ev: Event = { t: EventType.Update, item: tool, update: u };
    const parent = this.toolParent.get(tool) ?? '';
    if (parent !== '') ev.parent = parent;
    this.emit(ev);
  }

  /** Ends the turn: its stop reason, or its error; the chat's cost and
   * context are what the result and then get_context_usage say. */
  private result(run: Run, r: Obj): void {
    if (Array.isArray(r.user_message_uuids)) {
      for (const uuid of r.user_message_uuids.slice(0, 64)) this.taken(this.sent.get(str(uuid)));
    }
    this.taken(this.sent.get(str(r.user_message_uuid)));
    const subtype = str(r.subtype);
    let ev: Event;
    if (str(r.terminal_reason).startsWith('aborted')) {
      // interrupt: aborted_streaming, aborted_tools.
      ev = { t: EventType.Turn, state: TurnState.End, stopReason: 'cancelled' };
    } else if (subtype === 'error_max_turns') {
      ev = { t: EventType.Turn, state: TurnState.End, stopReason: 'max_turn_requests' };
    } else if (r.is_error === true || subtype.startsWith('error')) {
      const errors = Array.isArray(r.errors) ? r.errors.filter((x): x is string => typeof x === 'string') : [];
      const msg = firstOf(str(r.result), errors.join('; '), subtype);
      ev = {
        t: EventType.Turn,
        state: TurnState.Error,
        error: { code: this.authFailed ? Code.AuthRequired : Code.Failed, message: cut(msg, MAX_TEXT) },
      };
    } else {
      let stop = 'end_turn';
      if (r.stop_reason === 'max_tokens' || r.stop_reason === 'model_context_window_exceeded') stop = 'max_tokens';
      else if (r.stop_reason === 'refusal') stop = 'refusal';
      ev = { t: EventType.Turn, state: TurnState.End, stopReason: stop };
    }
    this.endTurn(ev);

    // The session's cost, from its start (it survives a resume).
    if (typeof r.total_cost_usd === 'number') this.usage.cost = { amount: r.total_cost_usd, currency: 'USD' };
    const its = isObj(r.usage) && Array.isArray(r.usage.iterations) ? r.usage.iterations : [];
    const it = its.length > 0 && isObj(its[its.length - 1]) ? (its[its.length - 1] as Obj) : null;
    if (it) {
      const used = num(it.input_tokens) + num(it.cache_read_input_tokens) + num(it.cache_creation_input_tokens) + num(it.output_tokens);
      if (used > 0) {
        this.usage.used = used;
        this.usage.percentage = 0;
        const mu = isObj(r.modelUsage) ? r.modelUsage[this.running] : undefined;
        if (isObj(mu) && num(mu.contextWindow) > 0) this.usage.size = num(mu.contextWindow);
      }
    }
    this.usageChanged();
    // The context's share in use, as Claude Code counts it.
    void this.call(run, 'get_context_usage', (q) => q.getContextUsage({ detail: 'summary' })).then(
      (cu) => this.takeContextUsage(cu),
      () => {},
    );
  }

  /** Follows the user's messages: a queued one the program took (into the
   * running turn after a tool's result, or as the next turn), one
   * withdrawn, one done. */
  private lifecycle(f: Obj): void {
    const uuid = str(f.command_uuid);
    const m = this.sent.get(uuid);
    switch (f.state) {
      case 'queued':
        return;
      case 'started':
        this.ensureTurn();
        return this.taken(m);
      case 'completed':
        if (m) this.forget(m);
        return;
      case 'cancelled':
        this.withdrawn(uuid);
        if (m) this.forget(m);
        return;
    }
    this.pass('command_lifecycle ' + str(f.state));
  }

  /** States the subscription's windows. */
  private rateLimit(f: Obj): void {
    const info = isObj(f.rate_limit_info) ? f.rate_limit_info : {};
    const windows = isObj(info.unifiedWindows) ? info.unifiedWindows : {};
    const ids = Object.keys(windows).sort();
    if (ids.length === 0) return;
    this.usage.limits = ids.slice(0, MAX_LIMITS).map((id) => {
      const w = isObj(windows[id]) ? (windows[id] as Obj) : {};
      const l: chat.Limit = { id: cut(id, 64), usedPercent: Math.round(Math.min(Math.max(num(w.utilization) * 100, 0), 100) * 1e4) / 1e4 };
      if (num(w.resetsAt) !== 0) l.resetsAt = Math.trunc(num(w.resetsAt));
      const wm = windowMinutes(id);
      if (wm !== 0) l.windowMinutes = wm;
      return l;
    });
    this.usageChanged();
  }

  // ---- the user's messages ----

  private queuedEvent(state: string, m: Sent, content: boolean): Event {
    const ev: Event = { t: EventType.Queued, state };
    if (m.message) ev.message = m.message;
    if (content) ev.content = m.content;
    if (m.clientId) ev.clientId = m.clientId;
    return ev;
  }

  private forget(m: Sent): void {
    this.sent.delete(m.uuid);
    if (this.byMessage.get(m.message) === m.uuid) this.byMessage.delete(m.message);
  }

  private taken(m: Sent | undefined): void {
    if (!m?.queued || m.taken) return;
    this.ensureTurn();
    m.taken = true;
    this.emit(this.queuedEvent(QueuedState.Taken, m, true));
    m.content = [];
  }

  /** Tells that the queued message uuid will not run. */
  private withdrawn(uuid: string): void {
    const m = this.sent.get(uuid);
    if (!m || !m.queued || m.taken) return;
    this.forget(m);
    this.emit(this.queuedEvent(QueuedState.Cancelled, m, false));
  }

  /** A message of the user's as the program takes it. */
  private userLine(uuid: string, content: unknown[]): SDKUserMessage {
    return {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.id,
      uuid,
      // A message the user typed: Claude Code treats one of no origin as
      // unattributed.
      origin: { kind: 'human' },
    } as unknown as SDKUserMessage;
  }

  /** Sends the user's message: a turn (its start event; the prompt's user
   * event is the host's when it recorded it, else told here first), or
   * while one runs a queued message (the program takes it into the running
   * turn after a tool's result, or as the next turn). */
  async prompt(p: PromptParams, signal: AbortSignal): Promise<void> {
    const run = this.current();
    signal.throwIfAborted();
    if (this.sent.size >= MAX_PENDING_PROMPTS) throw busy();
    const content = claudeContent(p.content, this.p.cwd);
    const m: Sent = {
      uuid: randomUUID(),
      message: p.message,
      clientId: p.clientId,
      content: this.inTurn ? p.content : [],
      queued: this.inTurn,
      taken: false,
    };
    this.sent.set(m.uuid, m);
    if (p.message) this.byMessage.set(p.message, m.uuid);
    if (m.queued) {
      this.emit(this.queuedEvent(QueuedState.Waiting, m, true));
    } else {
      // The host saw a turn run, which ended meanwhile.
      if (!p.recorded) {
        const ev: Event = { t: EventType.User, content: p.content };
        if (p.clientId) ev.clientId = p.clientId;
        this.emit(ev);
      }
      this.startTurn();
    }
    try {
      await orAbort(run.prompts.send(this.userLine(m.uuid, content)), signal);
    } catch (e) {
      if (signal.aborted) throw e;
      if (this.sent.get(m.uuid) === m) {
        this.forget(m);
        if (m.queued) this.emit(this.queuedEvent(QueuedState.Cancelled, m, false));
        else if (this.inTurn) this.endTurn({ t: EventType.Turn, state: TurnState.Error, error: asError(e, Code.Ended) });
      }
      throw e;
    }
  }

  /** Interrupts the running turn, withdrawing the queued messages first;
   * the program cancels the permissions it waits for. */
  async cancel(signal: AbortSignal): Promise<void> {
    const run = this.current();
    if (!this.inTurn) return;
    const queued = [...this.sent.values()]
      .filter((m) => m.queued && !m.taken)
      .map((m) => m.uuid)
      .sort();
    for (const u of queued) await this.withdraw(run, u, signal).catch(() => false);
    const r = await this.call(run, 'interrupt', (q) => q.interrupt(), signal);
    for (const u of r?.still_queued ?? []) {
      const m = this.sent.get(u);
      if (m && m.queued && !m.taken) await this.withdraw(run, u, signal).catch(() => false);
    }
  }

  /** Withdraws the queued message uuid; false when the program had taken
   * it. */
  private async withdraw(run: Run, uuid: string, signal: AbortSignal): Promise<boolean> {
    const ok = await this.call(run, 'cancel_async_message', (q) => cancelAsyncMessage(q, uuid), signal);
    if (ok) this.withdrawn(uuid);
    return ok;
  }

  /** Withdraws a queued message before the program takes it. */
  async cancelQueued(message: string, signal: AbortSignal): Promise<void> {
    const run = this.current();
    const uuid = this.byMessage.get(message) ?? '';
    const m = this.sent.get(uuid);
    const notFound = perr(Code.NotFound, 'claude: no such queued message');
    if (!m || !m.queued || m.taken) throw notFound;
    if (!(await this.withdraw(run, uuid, signal))) throw notFound;
  }

  /** Sets the model, the effort or the mode. */
  async setConfig(id: string, value: string, signal: AbortSignal): Promise<void> {
    switch (id) {
      case OPTION_MODEL:
        return this.setModel(value, signal);
      case OPTION_EFFORT:
        return this.setEffort(value, signal);
      case OPTION_MODE:
        return this.setMode(value, signal);
    }
    throw badRequest('no option ' + id);
  }

  private async setModel(value: string, signal: AbortSignal): Promise<void> {
    const m = this.cfg.find(value);
    if (!m || m.value !== value) throw badRequest('unknown model ' + value);
    const run = this.current();
    const arg = firstOf(m.resolved, m.value);
    await this.call(run, 'set_model', (q) => q.setModel(arg), signal);
    this.cfg.model = m.value;
    this.modelArg = arg;
    let reset = false;
    if (this.cfg.effort !== EFFORT_DEFAULT && !this.cfg.levels().includes(this.cfg.effort)) {
      this.cfg.effort = EFFORT_DEFAULT;
      reset = true;
    }
    this.configChanged();
    // The new model has no such effort: its default.
    if (reset) await this.call(run, 'apply_flag_settings', (q) => q.applyFlagSettings({ effortLevel: null }), signal);
  }

  private async setEffort(value: string, signal: AbortSignal): Promise<void> {
    if (!this.cfg.levels().includes(value)) throw badRequest('the model has no effort ' + value);
    const run = this.current();
    const level = value === EFFORT_DEFAULT ? null : (value as 'low');
    await this.call(run, 'apply_flag_settings', (q) => q.applyFlagSettings({ effortLevel: level }), signal);
    this.cfg.effort = value;
    this.configChanged();
  }

  private async setMode(value: string, signal: AbortSignal): Promise<void> {
    if (!(chat.MODES as readonly string[]).includes(value)) throw badRequest('unknown mode ' + value);
    if (value === chat.Mode.Full && !this.launchedFull) return this.restartFull(signal);
    await this.applyMode(this.current(), value, signal);
  }

  /** Sets the program's permission mode. */
  private async applyMode(run: Run, mode: string, signal?: AbortSignal): Promise<void> {
    await this.call(run, 'set_permission_mode', (q) => q.setPermissionMode(claudeMode(mode)), signal);
    this.cfg.mode = mode;
    this.configChanged();
  }

  /** Starts the program again, keeping the session id, allowed to skip
   * permissions: Claude Code takes bypassPermissions only from a program
   * started with --allow-dangerously-skip-permissions. Refused while a turn
   * runs or the program waits for the user. An existing conversation is
   * resumed; a new session before its first turn has none to resume.
   * close() calls it off: no program it started outlives the session. */
  private async restartFull(signal: AbortSignal): Promise<void> {
    if (this.ended || this.closing || !this.run) throw gone();
    if (this.inTurn || this.waiting > 0 || this.restarting) throw busy();
    const ac = new AbortController();
    const sig = AbortSignal.any([signal, ac.signal]);
    this.restarting = true;
    this.restartAbort = ac;
    const old = this.run;
    const resume = this.hasConversation;
    this.notice(Notice.Restarted, { mode: chat.Mode.Full });

    void old.spawn?.stop();
    if (!sig.aborted) await Promise.race([old.done, new Promise((r) => sig.addEventListener('abort', r, { once: true }))]);
    if (!old.over) {
      old.spawn?.killNow();
      await old.done;
    }
    let launched: { run: Run; init: Init } | null = null;
    let err: unknown = sig.aborted ? gone() : null;
    if (!err)
      try {
        launched = await this.launch(resume, true, sig);
      } catch (e) {
        err = e;
      }
    this.restartAbort = null;
    if (launched && this.closing) {
      // Closed meanwhile: the new program goes too, and with it the session.
      this.run = launched.run;
      this.restarting = false;
      void launched.run.spawn?.stop();
      this.finishOver(launched.run);
      throw gone();
    }
    if (!launched) {
      // No program: the session ends.
      this.restarting = false;
      if (this.closing) err = gone();
      this.finish(old, asError(err, Code.Ended));
      throw err;
    }
    this.run = launched.run;
    this.restarting = false;
    this.finishOver(launched.run);
    try {
      await this.setup(launched.run, launched.init, true, sig);
    } catch (e) {
      launched.run.spawn?.killNow();
      throw e;
    }
    // Closed while it was set up: the session ends with its program.
    if (this.closing) throw gone();
  }

  /** Compacts the conversation: the /compact command, a turn of its own.
   * Refused while a turn runs. */
  async compact(signal: AbortSignal): Promise<void> {
    const run = this.current();
    signal.throwIfAborted();
    if (this.inTurn || this.sent.size >= MAX_PENDING_PROMPTS) throw busy();
    const m: Sent = { uuid: randomUUID(), message: '', clientId: '', content: [], queued: false, taken: false };
    this.sent.set(m.uuid, m);
    this.startTurn();
    this.notice(Notice.Command, { name: '/compact' });
    try {
      await orAbort(run.prompts.send(this.userLine(m.uuid, [textBlock('/compact')])), signal);
    } catch (e) {
      if (signal.aborted) throw e;
      this.sent.delete(m.uuid);
      this.endTurn({ t: EventType.Turn, state: TurnState.Error, error: asError(e, Code.Ended) });
      throw e;
    }
  }

  /** Ends the program gracefully: its input is closed, then its group gets
   * SIGTERM and SIGKILL if it takes too long. When signal ends first, the
   * group is killed at once. */
  async close(signal: AbortSignal): Promise<void> {
    this.closing = true;
    this.restartAbort?.abort();
    const run = this.run;
    if (!run) return;
    void run.spawn?.stop();
    if (!signal.aborted) await Promise.race([this.done, new Promise((r) => signal.addEventListener('abort', r, { once: true }))]);
    if (!this.ended) {
      run.spawn?.killNow();
      if (this.run !== run) this.run?.spawn?.killNow();
    }
  }

  // ---- the program's requests ----

  /** Answers a request to use a tool (can_use_tool) once the messages
   * before it were taken. An approved plan's mode is set once the answer
   * was sent. */
  private async canUseTool(
    run: Run,
    r: { tool: string; input: unknown; toolUseId: string; suggestions: unknown; agentId: string },
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    this.waiting++;
    try {
      await nextTurn();
      // A request the program cancelled (an interrupt) or that outlived its
      // run is no one's to answer; the SDK sends this one, which the program
      // passes over.
      if (signal.aborted) return { behavior: 'deny', message: DENY_UNASKED };
      const parent = this.tasks.get(r.agentId) ?? '';
      const d = await decide(
        this.sink,
        { tool: r.tool, input: isObj(r.input) ? r.input : {}, toolUseId: r.toolUseId, suggestions: r.suggestions, parent },
        signal,
      );
      const mode = d.mode;
      if (mode)
        setImmediate(() => {
          this.applyMode(run, mode).catch((e: unknown) => this.log(`claude: the mode after the plan: ${messageOf(e)}`));
        });
      return d.result ?? { behavior: 'deny', message: DENY_UNASKED };
    } finally {
      this.waiting--;
    }
  }
}

/** The length of a rate limit window Claude Code names, in minutes. */
function windowMinutes(id: string): number {
  if (id === 'five_hour') return 5 * 60;
  if (id.startsWith('seven_day')) return 7 * 24 * 60;
  return 0;
}

/** The ACP status of a tool call of a task in status. */
function taskStatus(status: string): string {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'killed':
    case 'stopped':
    case 'error':
      return 'failed';
    case 'running':
    case 'pending':
      return 'in_progress';
  }
  return '';
}
