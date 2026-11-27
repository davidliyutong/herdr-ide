// The seam between the chat host (host/) and the adapters that drive coding
// agents headless: Claude Code's SDK protocol ("claude"), Codex's
// app-server ("codex") and the Agent Client Protocol ("acp"), the names of
// a kind's chat spec's adapter (#shared/agents/kinds.ts ADAPTERS). The host
// owns chats, their logs, clients, bounds and every decision about a
// process's lifetime; an adapter owns one agent process per Session and
// turns its protocol into chatproto events. The host gets its adapters by
// name from its composition root (hosts/machine/features.ts chatAdapters);
// a kind whose adapter it was not given is refused as a kind without a
// chat is (unsupported), never by a crash.
//
// Every adapter follows these rules:
//
//   - It runs argv as given (argv[0] is absolute; the host resolved it from
//     the kind's chat spec) with env as the whole environment, adding only
//     its protocol's own variables, through the host's process groups
//     (StartParams.procs: AgentProcess): never a command line, a path to
//     run or an environment variable from a client.
//   - It answers every request of the agent it does not serve with its
//     protocol's "method not found" (JSON-RPC -32601), never by dropping
//     it: an agent that is not answered waits.
//   - It passes over frames, notifications, members and values it does not
//     know, logging their kinds once, and never fails a turn for one; a
//     vendor's notification it has no mapping for becomes no event.
//   - It ignores answers to requests it did not make and routes the
//     agent's own requests by their method, not their id.
//   - It never writes the user's configuration: Codex threads start and
//     resume read-only and get their policy per turn; Claude Code's "allow
//     for this session" sends only its addRules with the session as
//     destination; models and efforts are set through the protocol, never
//     by a slash command that saves them.
//   - It ends the agent gracefully: close() ends the agent's input, then
//     its process group gets SIGTERM, and SIGKILL only after a grace
//     period (AgentProcess.stop): Codex killed outright leaves its shell
//     snapshots behind. What the agent left running in its group goes with
//     it once the agent is gone.
//   - It never holds up the agent's output for the host: Sink.event and
//     Sink.update return at once; Sink.permission and Sink.question settle
//     when the user answers, and hold up only the request that asked.
//   - It sends what streams (text, thoughts, a tool's input, a command's
//     output) as live events (Event.live) and, once an item is complete or
//     changes otherwise, one event with the item's whole content under the
//     same item: only those are stored.
//   - It tells each prompt once: the host stores the user event of a
//     prompt it believes starts a turn (PromptParams.recorded). Whether a
//     turn runs is the adapter's to know: a prompt not recorded that starts
//     a turn gets its user event (content, clientId) from the adapter
//     before the turn's start; a recorded one that finds a turn running is
//     told as a queued event with its clientId.
//   - It may call the Sink at any time, from within one of its Session's
//     methods too: the host calls a Session method only where its own state
//     is settled.
//   - It loads a project's own configuration (settings with their hooks,
//     MCP servers, instructions) only in a folder the agent itself trusts
//     or the user trusted through the host (StartParams.trusted), where the
//     agent lets a client choose; elsewhere it starts the agent without it
//     and says so with the stored notice untrusted_folder {cwd}.
//   - It marks every value of its mode option that may give the agent full
//     access with ConfigValue.full, a value it does not know the meaning of
//     too (deny by default), and states every mode its agent is in (the
//     mode option's currentValue), one the agent changed to by itself too.
//   - It neither resumes nor imports a session another process of the
//     agent runs (a terminal's), where it can tell (inTerminal), or maps
//     the agent's own refusal to the code in_terminal.
//   - The end of the agent's standard error it puts on an error
//     (ChatError.stderr) is for the user's eyes only: the host keeps at
//     most MAX_STDERR bytes of it, in memory.
//
// Errors an adapter throws are ChatProtoError when it knows the code
// (unsupported for what the agent cannot do, auth_required, protocol,
// busy, not_found, in_terminal); the host answers any other error as
// failed, and an aborted signal as the end it stands for.
import type { Logger } from '#shared/lib/log.ts';
import type * as chat from '#shared/proto/chatproto/index.ts';
import type { AgentProcesses } from './agentproc.ts';

/** Declarative capabilities & runtime characteristics of an Adapter, consumed
 * by Host/Chat so core orchestration never switches on adapter names. */
export interface AdapterMeta {
  /** 'process' resolves and spawns spec.argv[0] via PATH (default);
   * 'embedded' runs in-process inside the chat host (no PATH lookup, pid = 0). */
  runtime: 'process' | 'embedded';
  /** Preferred handoff delivery strategy when switching into this adapter. */
  handoffInjection?: 'native_history' | 'attributed_context';
  /** Which native boundary key partial fork requires ('message' for Claude
   * upToMessageId, 'turn' for Codex beforeTurnId/lastTurnId, 'any', or 'none'). */
  partialForkBy?: 'message' | 'turn' | 'any' | 'none';
}

/** Input passed to Adapter.prepareConfig so adapters can supply initial
 * configuration options (e.g. client-enforced ACP permission mode) before
 * a chat starts or wakes, without leaking adapter logic into Host. */
export interface PrepareConfigContext {
  kind: string;
  config?: chat.ConfigOption[];
  options: chat.Options;
  fromJournal: boolean;
  settings: chat.ClampedHostSettings;
}

/** Drives one protocol of coding agents. */
export interface Adapter {
  /** Declarative runtime & handoff/fork metadata; defaults to process runtime,
   * attributed_context handoff, and 'any' partial fork hint. */
  readonly meta?: AdapterMeta;
  /** Optional availability probe for embedded runtimes (when meta.runtime is
   * 'embedded', Host calls this instead of lookPath(spec.argv[0])). */
  available?(env: Record<string, string>, signal: AbortSignal): Promise<boolean>;
  /** Optional pre-start/journal-load config normalizer (e.g. injecting a
   * client-enforced permission mode option for ACP agents without native modes). */
  prepareConfig?(ctx: PrepareConfigContext): chat.ConfigOption[] | undefined;
  /** Runs the agent for a chat: a new session, or p.resume's. Resolves once
   * the session exists (its id known) or rejects when it did not come to
   * be; the session's events then go to sink until it is done. signal
   * bounds the start only (its end rejects the start, the agent ended):
   * the session lives until close() or the agent's end. */
  start(p: StartParams, sink: Sink, signal: AbortSignal): Promise<Session>;
  /** The sessions the agent kept for a directory, a page at a time (next
   * is "" on the last), the most recent first. It may start a short-lived
   * agent process to ask. */
  sessions(p: SessionsParams, signal: AbortSignal): Promise<{ sessions: chat.Session[]; next: string }>;
  /** Emits the stored events of a session's earlier conversation (an
   * import), oldest first: the events the chat's log would hold had the
   * chat run it, without sequence numbers, never live ones. For a whole
   * conversation (after "") it may also emit one info event whose chat has
   * the title the agent or the user gave the session (never one made of a
   * prompt): the host takes it as the imported chat's title, unless the
   * user named the chat. Every emit comes before the promise settles. */
  history(p: HistoryParams, emit: (ev: chat.Event) => void, signal: AbortSignal): Promise<void>;
  /** Present on an adapter that can tell that a process other than the
   * host's runs a session (the user's, in a terminal), which the host then
   * neither resumes nor imports: two processes do not write one session.
   * Resolves to a ChatError of code in_terminal when another process runs
   * p.sessionId; null when none does, or when it cannot be told. Its start
   * refuses such a session too. */
  inTerminal?(p: HistoryParams, signal: AbortSignal): Promise<chat.ChatError | null>;
  /** Lists the models the agent kind offers, reusing a live connection or
   * running a short-lived probe. */
  models?(p: ModelsParams, signal: AbortSignal): Promise<chat.ModelOption[]>;
  /** Forks an existing session on disk or through the agent's protocol,
   * optionally slicing up to a turn/message boundary. */
  fork?(p: ForkParams, signal: AbortSignal): Promise<ForkResult>;
}

/** An agent runtime executing one session (an external process group, or an
 * in-process embedded runtime with pid === 0). */
export interface Session {
  /** The agent's id of the session. */
  readonly id: string;
  /** The id of the agent's process, the leader of its process group; 0 for an
   * in-process embedded runtime or when no process runs. The host signals the
   * group only when pid > 0. */
  readonly pid: number;
  /** Starts a turn with p.content, or, while one runs, queues, steers or
   * interrupts according to p.delivery (a queued event under p.message tells
   * which, and when the agent took it). */
  prompt(p: PromptParams, signal: AbortSignal): Promise<void>;
  /** Cancels the running turn; what waits on the agent's side (its
   * permission requests) ends with it. When opts.keepQueue is true, queued
   * messages wait for the next turn instead of being cancelled. */
  cancel(signal: AbortSignal, opts?: { keepQueue?: boolean }): Promise<void>;
  /** Withdraws the queued message of that id (a PromptParams.message)
   * before the agent took it. */
  cancelQueued(message: string, signal: AbortSignal): Promise<void>;
  /** Promotes the queued message of that id to steer into the active turn or
   * interrupt the active turn and run immediately. */
  steerQueued?(message: string, delivery: 'steer' | 'interrupt', signal: AbortSignal): Promise<void>;
  /** Sets the configuration option id (a ConfigOption of the chat) to value,
   * one of its values. */
  setConfig(id: string, value: string, signal: AbortSignal): Promise<void>;
  /** Updates the session's known model list after an Op.Models refresh so
   * subsequent setConfig(model) calls accept newly discovered models. */
  updateModels?(models: readonly chat.ModelOption[]): void;
  /** Compacts the conversation's context, optionally guided by instructions. */
  compact(signal: AbortSignal, instructions?: string): Promise<void>;
  /** Terminates a running background task or subagent by its BackgroundTask.id. */
  stopTask?(taskId: string, signal: AbortSignal): Promise<void>;
  /** Rewinds an idle session to just before the named message/turn boundary,
   * optionally reverting file edits when capabilities.rewindFiles is true. */
  rewind?(p: RewindParams, signal: AbortSignal): Promise<RewindResult>;
  /** Appends structured handoff messages directly into a fresh session's
   * model-visible history without starting a turn (e.g. Codex
   * `thread/inject_items`). Throws Code.Unsupported when the running agent
   * version does not support direct injection so the host falls back to
   * prompt-time attributed context injection. */
  injectHistory?(messages: readonly HandoffMessage[], signal: AbortSignal): Promise<void>;
  /** Ends the agent process gracefully; resolves once it is gone or signal
   * ends. */
  close(signal: AbortSignal): Promise<void>;
  /** Settles once the agent process ended, for whatever reason, and the
   * sink had every event of the session: with why it ended, undefined after
   * close(). Never rejects. */
  readonly done: Promise<chat.ChatError | undefined>;
}

/** Where a Session reports to the host. */
export interface Sink {
  /** Hands on an event, stored or live (Event.live): the host numbers,
   * stores and fans out. Returns at once. */
  event(ev: chat.Event): void;
  /** Asks the user; settles with the user's answer, or cancelled (the
   * turn's cancel, signal's end, too many waiting); rejects with a
   * ChatProtoError when the chat's agent ended. */
  permission(r: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer>;
  /** Asks the user questions, as permission does. */
  question(r: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer>;
  /** Changes what the chat states (its session id, title, configuration
   * options, slash commands, usage, capabilities, the agent's version): fn
   * changes a copy of the chat and returns; the host takes what it may. */
  update(fn: (c: chat.Chat) => void): void;
}

/** Names the client to an agent: the product's name and its version. */
export interface ClientInfo {
  name: string;
  version: string;
}

/** What every call of an adapter gets from the host. */
export interface RunParams {
  /** The chat's agent kind (#shared/agents/kinds.ts). */
  kind: string;
  /** The kind's chat spec's command, argv[0] resolved to an absolute path;
   * for sessions and history empty when the program is not in the PATH (an
   * adapter that reads files needs none). */
  argv: string[];
  /** The agent's whole environment: the user's login shell's, without the
   * variables of the terminal core's own terminal, of ssh and of the agents'
   * sessions, with PWD the directory and the chat spec's variables added. */
  env: Record<string, string>;
  /** The directory, an absolute path that exists. */
  cwd: string;
  /** Where every agent process is started (AgentProcesses.spawn): in a
   * process group of its own that the host can end. */
  procs: AgentProcesses;
  logger: Logger;
}

/** What start runs. */
export interface StartParams extends RunParams {
  /** The session to take up; "" for a new one. The host starts a new
   * session for a chat whose session never had a turn (an agent may keep a
   * session only once it took a prompt). */
  resume: string;
  /** The id the host chose for a new session, a lower-case UUID, for an
   * agent that takes one (Claude Code's --session-id); an adapter whose
   * agent makes its own ignores it. */
  sessionId: string;
  /** The chat spec's _meta for ACP's session/new; undefined for none. */
  newSessionMeta?: Record<string, unknown>;
  /** What the chat starts with; mode is the settings' default when the chat
   * named none, never full (nor a value the adapter marked full) unless
   * settings.allowFull. */
  options: chat.Options;
  /** The user trusted cwd, or a folder above it, through the host
   * (Op.Trust): the adapter loads the project's own settings as in a
   * folder the agent trusts itself. */
  trusted: boolean;
  client: ClientInfo;
  /** The host's settings, clamped. */
  settings: chat.ClampedHostSettings;
}

/** What sessions lists. */
export interface SessionsParams extends RunParams {
  /** The next of the page before; "" for the first. */
  cursor: string;
}

/** The session whose conversation history emits. */
export interface HistoryParams extends RunParams {
  sessionId: string;
  /** The item of the last event an earlier history of this session
   * emitted: only what came after it is emitted (the turns the session made
   * in a terminal after a handoff). "" emits the whole conversation. */
  after: string;
}

/** What models probes. */
export interface ModelsParams extends RunParams {
  client: ClientInfo;
}

/** What fork clones. */
export interface ForkParams extends RunParams {
  /** Source session id to fork from. */
  sessionId: string;
  /** True when forking strictly before the end of the source chat (partial slice). */
  partial?: boolean;
  /** Optional native message id (inclusive) to slice up to (Claude upToMessageId). */
  upToMessageId?: string;
  /** Optional native turn id immediately after the last kept turn (Codex beforeTurnId). */
  beforeTurnId?: string;
  /** Optional native turn id of the last kept turn (Codex lastTurnId). */
  lastTurnId?: string;
  /** Optional title for the forked session. */
  title?: string;
  client: ClientInfo;
}

export interface ForkResult {
  sessionId: string;
}

/** What rewind rolls back. */
export interface RewindParams {
  /** Native message uuid of the user turn being rewound/replaced (Claude rewindFiles). */
  userMessageId?: string;
  /** Native message uuid of the last message before the rewound turn (Claude resumeSessionAt). */
  resumeBeforeId?: string;
  /** Native turn id of the turn being rewound/replaced (Codex thread/revert beforeTurnId). */
  beforeTurnId?: string;
  /** Also restore file checkpoints from userMessageId onward when supported. */
  restoreFiles?: boolean;
}

export interface RewindResult {
  /** New session id if rewinding branched to a new session id. */
  sessionId?: string;
  /** True when the rewound session is now a brand-new empty session with no
   * persisted conversation yet (so a later sleep/wake must start fresh instead
   * of passing --resume). */
  fresh?: boolean;
}

/** A structured conversation message for native history injection on handoff. */
export interface HandoffMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Agent kind id that authored an assistant message (e.g. 'claude', 'codex'). */
  agentKind?: string;
}

/** A message of the user. */
export interface PromptParams {
  /** ACP content blocks (text, image, resource_link), checked by the host
   * against MAX_PROMPT and MAX_IMAGE. Always the user's untouched content
   * (never includes handoff context, so stored User/Queued events stay clean). */
  content: unknown[];
  /** Optional attributed handoff context prepended ONLY on the wire to the
   * agent for backends without native history injection. Never written into
   * EventType.User or EventType.Queued. */
  handoffContext?: string;
  /** The host's id of the message, which queued events, cancelQueued and
   * steerQueued name. */
  message: string;
  /** The page's id of the message, for the user and queued events; "" for
   * none. */
  clientId: string;
  /** The host stored the prompt's user event, believing that no turn ran.
   * An adapter that finds a turn running queues the message (a queued
   * event with clientId). Without it, the host believed a turn ran: an
   * adapter that finds none emits the user event (content, clientId)
   * itself, before the turn's start. */
  recorded: boolean;
  /** Delivery mode when a turn is already active (default: Delivery.Queue). */
  delivery?: chat.Delivery;
  /** Stable UUIDv4 matching EventType.User.item for native rewind/fork mapping. */
  uuid?: string;
}

/** A permission the agent asks. */
export interface PermissionRequest {
  /** PermissionKind's: tool, command, file, plan, mcp or other. */
  kind: string;
  /** What is asked for, as an ACP ToolCall (toolCallId, title, kind,
   * status, content with a diff or the command, locations, rawInput). */
  toolCall: unknown;
  /** The answers to choose from: the agent's own (ACP), or the host's for
   * an agent without them (OPTION_ALLOW_ONCE …). */
  options: chat.PermissionOption[];
  /** The tool call id of the subagent that asks; "" for the main agent. */
  parent: string;
}

/** The user's answer to a permission: the optionId chosen, or cancelled. */
export type PermissionAnswer = { option: string; cancelled?: false } | { option?: undefined; cancelled: true };

/** Questions the agent asks the user. */
export interface QuestionRequest {
  questions: chat.Question[];
  /** The tool call that asks, as an ACP ToolCall, when there is one. */
  toolCall?: unknown;
  parent: string;
  /** Non-blocking question: does not hold chat in State.Waiting and survives Turn.End. */
  async?: boolean;
  /** Optional auto-resolution timeout in milliseconds (Codex non-blocking requestUserInput). */
  autoResolutionMs?: number;
  /** Correlating item id (e.g. agentMessage itemId) for deduplicating inline vs card UI. */
  item?: string;
}

/** The user's answers by Question.id (option labels or the user's own
 * words), or cancelled when the user skipped them. */
export type QuestionAnswer = { answers: Record<string, string[]>; cancelled?: false } | { answers?: undefined; cancelled: true };

// The permission options the host shows for an agent that has none of its
// own (Claude Code, Codex), by optionId: adapters offer these, and the UIs
// know them.

/** Allows this call. */
export const OPTION_ALLOW_ONCE = 'allow_once';
/** Allows calls like it for the rest of the session, without writing a
 * setting (kind allow_always). */
export const OPTION_ALLOW_SESSION = 'allow_session';
/** Refuses this call. */
export const OPTION_REJECT_ONCE = 'reject_once';
/** Starts the options of a plan's approval (PermissionKind.Plan):
 * "plan:<mode>" approves the plan and goes on in that mode (a MODES value
 * other than plan); OPTION_REJECT_ONCE keeps planning. */
export const OPTION_PLAN_PREFIX = 'plan:';

/** The option that approves a plan and goes on in mode. */
export const planOption = (mode: string): string => OPTION_PLAN_PREFIX + mode;

/** The adapters a host has, by name. */
export type Adapters = Readonly<Record<string, Adapter>>;
