// The protocol of the chat host's unix socket (internal/chatproto while the
// Go program exists): JSON lines, one JSON object per line, UTF-8, at most
// MAX_LINE bytes each.
//
// The chat host is the long-lived process of a machine that runs coding
// agents headless, each through its adapter (Claude Code's SDK protocol,
// Codex's app-server, the Agent Client Protocol), and keeps what each
// conversation did in its log. A client (the core, for its pages) connects
// to <run dir>/SOCKET_NAME and reads the host's Hello. It then sends one
// Request and reads one Response. Every request but Op.Attach and Op.Watch
// ends the connection after its response. After the response to Op.Attach
// the host writes the chat's stored events with a sequence number above
// Request.from, then every new one, live increments among them, an Event per
// line, until either side closes; meanwhile the client may send Command
// lines, each answered by an Event of type EventType.Ack. After the response
// to Op.Watch the host writes a ChatState line whenever a chat changes, and
// one in State.Deleted when a chat is no more, until either side closes.
//
// Requests name agents by their kinds (agentkinds ids with a Chat spec),
// never by a command line: what runs is the machine's to decide. Agents' own
// JSON (an ACP session update, a tool call) is handed on as the adapter made
// it (`unknown` members here).
import { randomBytes } from 'node:crypto';

/** The protocol's version, stated in the host's Hello. */
export const PROTO = 2;
/** The longest line either side sends or takes, in bytes without its newline. */
export const MAX_LINE = 16 << 20;
/** The most content a prompt may carry: the JSON of its content blocks, in bytes. */
export const MAX_PROMPT = 8 << 20;
/** The most bytes an image block of a prompt may carry, its data decoded. */
export const MAX_IMAGE = 5 << 20;
/** The most bytes of an agent's standard error a ChatError carries
 * (ChatError.stderr): its end. */
export const MAX_STDERR = 2 << 10;
/** The most bytes of a stored event's JSON. The host cuts what is longer: a
 * tool call's output to its first and last TOOL_OUTPUT_END bytes, anything
 * else to a notice that it was left out. */
export const MAX_EVENT = 1 << 20;
/** How much of a tool call's output a stored event keeps at each end when
 * the whole would not fit MAX_EVENT. */
export const TOOL_OUTPUT_END = 16 << 10;
/** The socket's file name in the instance's run directory. */
export const SOCKET_NAME = 'chat.sock';
/** The longest a host takes to end once it stops (Op.Shutdown, a signal,
 * its idle end), in milliseconds: it gives its agents their grace and exits
 * at the latest then, what is left of them killed. A host that has not
 * served for longer is stuck. */
export const STOP_GRACE_MS = 30_000;

/** The first line of a connection, written by the host. */
export interface Hello {
  host: HostInfo;
}

/** Names a chat host. */
export interface HostInfo {
  proto: number;
  version: string;
  pid: number;
}

/** The operations of a Request. */
export const Op = {
  /** Tells which of Request.kinds can be started on the machine
   * (Response.agents, one for each, in their order). */
  Agents: 'agents',
  /** Lists every chat the host keeps, closed ones included, the most
   * recently updated first (Response.chats). */
  Chats: 'chats',
  /** Makes a chat: it starts the agent of Request.kind in Request.cwd, with
   * a new session or with Request.resume's, under Request.options. The
   * answer comes at once, the chat in State.Starting (Response.chat); what
   * follows comes as events. A session another process runs is refused
   * (Code.InTerminal). */
  New: 'new',
  /** Subscribes to the events of Request.chat after Request.from
   * (Response.chat and Response.first, then events). */
  Attach: 'attach',
  /** Ends the agent process of Request.chat and keeps the chat, in
   * State.Closed, until the host's limits remove it. A closed chat takes
   * prompts again: the host resumes its session. */
  Close: 'close',
  /** Forgets Request.chat and its log, ending its agent process first. The
   * agent's own session files stay. */
  Delete: 'delete',
  /** Puts Request.chat away: its agent process ends as with Op.Close, what
   * the user had not seen of it counts as seen, and the chat is kept with its
   * log, in State.Closed with Chat.archived, until the host's limits remove
   * it (archived chats before the other closed ones). Op.Unarchive takes it
   * back, and so does a start of its agent (a prompt). */
  Archive: 'archive',
  Unarchive: 'unarchive',
  /** Lists the sessions the agent of Request.kind kept for the directory
   * Request.cwd, a page at a time from Request.cursor (Response.sessions,
   * Response.nextCursor). */
  Sessions: 'sessions',
  /** Subscribes to the states of every chat: Response.states holds them
   * all, as the other watchers were told them last, then each change comes
   * as a ChatState line, none older than what came before; a chat deleted
   * (Op.Delete) or removed by the host's limits comes one last time, in
   * State.Deleted. */
  Watch: 'watch',
  /** Tells that the user saw Request.chat up to Request.seq: a turn that
   * ended at or before it is no longer Status.Done. */
  Seen: 'seen',
  /** Gives the host the core's settings for this machine
   * (Request.settings), which it clamps (clampHostSettings). The core sends
   * it when it connects and when they change. */
  Configure: 'configure',
  /** Ends the host so that another version can take over. It is refused
   * with Code.Busy while a chat is in State.Working or State.Waiting;
   * otherwise the host ends every agent process, which the next host resumes
   * by session id at the next prompt. */
  Shutdown: 'shutdown',
  /** Trusts the directory Request.cwd, and every directory below it, on
   * this machine: an agent started there from then on loads the project's own
   * settings (its hooks, MCP servers and instructions) as it does in a folder
   * it trusts itself. Without that trust, of the agent's own or of this list,
   * an adapter that can starts the agent without them and tells so (the
   * notice untrusted_folder). The host keeps the list in its database; an
   * agent that runs already takes it at its next start. The host refuses
   * (Code.UnsafeFolder) "/", the user's home directory and the directories
   * above it, a directory that is not the user's or that its group or others
   * may write, and one below a directory others may write that has no sticky
   * bit; it keeps the device and inode of the directory, and a trusted path
   * that is another directory at an agent's start, or no longer one it would
   * take, is trusted no more. */
  Trust: 'trust',
  /** Takes back the trust that covers the directory Request.cwd: its own
   * (Op.Trust) and that of every directory above it. An agent that runs
   * already keeps what it loaded until its next start. */
  Untrust: 'untrust',
  /** Lists all persisted trusted folders on the machine (Response.trusted). */
  Trusted: 'trusted',
  /** Reports the running chat host's status, metadata, and active headless
   * agent sessions (Response.hostStatus). */
  HostStatus: 'host_status',
} as const;
export type Op = (typeof Op)[keyof typeof Op];

/** The operations of a Command. Each is answered by an EventType.Ack. */
export const CommandOp = {
  /** Sends Command.content to the agent. While a turn runs the host queues
   * the message, or steers it into the running turn where the agent can
   * (EventType.Queued); a chat in State.Sleeping or State.Closed is resumed
   * first, unless another process runs its session (Code.InTerminal). A
   * prompt with the clientId of one of the chat's last 256 prompts its log
   * has (EventType.User, EventType.Queued) is that one sent again by a client
   * that did not get its ack: it is acked OK and not sent again; one with the
   * clientId of a prompt still being taken gets that one's ack. */
  Prompt: 'prompt',
  /** Cancels the turn, every permission and question that waits, and the
   * queued messages. */
  Cancel: 'cancel',
  /** Answers the permission Command.request with Command.option, or with
   * Command.cancelled. */
  Permission: 'permission',
  /** Answers the question Command.request with Command.answers, or skips it
   * with Command.cancelled. */
  Answer: 'answer',
  /** Sets the configuration option Command.config (a ConfigOption's id) to
   * Command.value, one of its values: the model, the effort, the mode and the
   * agents' own options. */
  SetConfig: 'set_config',
  /** Withdraws the queued message Command.message before the agent took it. */
  CancelQueued: 'cancel_queued',
  /** Compacts (summarizes) the conversation's context. */
  Compact: 'compact',
  /** Sets the chat's title to Command.title. */
  Rename: 'rename',
  /** Ends the agent process so that its session can continue in a
   * terminal: the chat is then Chat.handedOff. Refused with Code.Busy while a
   * turn runs. */
  Handoff: 'handoff',
} as const;
export type CommandOp = (typeof CommandOp)[keyof typeof CommandOp];

/** What a new chat starts with; left out, each is the agent's default (for
 * mode, HostSettings.defaultMode). Each is a value of the chat's
 * ConfigOption of that category, which the host checks once the agent listed
 * them. */
export interface Options {
  model?: string;
  effort?: string;
  mode?: string;
}

/** The permission modes of the host's settings (HostSettings.defaultMode,
 * the setting chat.permissionMode): each adapter maps them to its agent's. */
export const Mode = {
  /** Asks before edits and commands. */
  Default: 'default',
  /** Makes edits in the working directory without asking. */
  AcceptEdits: 'acceptEdits',
  /** Plans first and asks to approve the plan. */
  Plan: 'plan',
  /** Asks for nothing: full access. */
  Full: 'full',
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

/** The permission modes, Mode.Default first. */
export const MODES = [Mode.Default, Mode.AcceptEdits, Mode.Plan, Mode.Full] as const;

/** The one line a client sends after the host's Hello. */
export interface Request {
  op: Op;
  /** The agents Op.Agents asks about. */
  kinds?: string[];
  /** The agent of Op.New and Op.Sessions. */
  kind?: string;
  /** The working directory of Op.New's chat, an absolute path, the
   * directory whose sessions Op.Sessions lists, the one Op.Trust trusts and
   * the one whose trust Op.Untrust takes back. */
  cwd?: string;
  /** The agent's id of a session Op.New takes up instead of making one. */
  resume?: string;
  /** Also brings resume's earlier conversation into the new chat's log, as
   * stored events before the first of its own. */
  import?: boolean;
  /** What Op.New's chat starts with. */
  options?: Options;
  /** The chat of Op.Attach, Op.Close, Op.Delete, Op.Archive, Op.Unarchive
   * and Op.Seen. */
  chat?: string;
  /** The last sequence number an attaching client has: the stored events
   * after it are sent. */
  from?: number;
  /** Op.Attach starts nothing on the machine. An attach brings what a handed
   * off chat's session did in a terminal into its log, which may run the
   * agent's program to ask; a reader who may not change the chat attaches
   * without it. */
  noCatchUp?: boolean;
  /** What Op.Seen tells the user saw. */
  seq?: number;
  /** The nextCursor of the page before, for Op.Sessions. */
  cursor?: string;
  /** Op.Configure's. */
  settings?: HostSettings;
}

/** The host's answer to a Request: ok with the members of the operation,
 * or error. A list that is asked for is there when it is empty. */
export interface Response {
  ok?: boolean;
  error?: ChatError;
  /** Answers Op.Agents, one for each kind asked about. */
  agents?: AgentStatus[];
  /** Answers Op.Chats. */
  chats?: Chat[];
  /** Answers Op.New and Op.Attach. */
  chat?: Chat;
  /** Answers Op.Attach: the lowest sequence number still stored, or the
   * next one's when none is. A client whose from is lower than first-1
   * missed events. */
  first?: number;
  /** sessions and nextCursor answer Op.Sessions; nextCursor is left out on
   * the last page. */
  sessions?: Session[];
  nextCursor?: string;
  /** Answers Op.Watch: the state of every chat, as Op.Chats orders them. */
  states?: ChatState[];
  /** Answers Op.Trusted. */
  trusted?: TrustedFolder[];
  /** Answers Op.HostStatus. */
  hostStatus?: HostStatus;
}

/** A directory the user trusted on the machine (Op.Trusted). */
export interface TrustedFolder {
  cwd: string;
  /** RFC 3339. */
  at: string;
}

/** A chat whose agent process runs or is starting on the chat host
 * (Op.HostStatus). */
export interface HostSessionInfo {
  chat: string;
  kind: string;
  title: string;
  cwd: string;
  sessionId: string;
  state: string;
  status: string;
  pid?: number;
  starting?: boolean;
  /** RFC 3339. */
  idleSince?: string;
  /** RFC 3339. */
  updated: string;
  bytes: number;
  agentVersion?: string;
}

/** A running chat host process and its active sessions (Op.HostStatus). */
export interface HostStatus {
  proto: number;
  version: string;
  pid: number;
  terminalId?: string;
  /** RFC 3339. */
  startedAt: string;
  socket?: string;
  base?: string;
  conns: number;
  watchers: number;
  liveAgents: number;
  totalChats: number;
  totalBytes: number;
  ending: number;
  settings: HostSettings;
  /** null from a Go host that has none. */
  sessions: HostSessionInfo[] | null;
}

/** The reasons of an AgentStatus that is not available. */
export const Reason = {
  /** The agent's program is not in the user's PATH. */
  NotFound: 'not_found',
  /** The kind has no chat (no Chat spec), or the program is a version the
   * adapter cannot drive. */
  Unsupported: 'unsupported',
} as const;

/** Whether an agent kind can be started. */
export interface AgentStatus {
  kind: string;
  available: boolean;
  /** The program's version, when it tells. */
  version?: string;
  /** Why the agent is not available. */
  reason?: string;
}

/** A session an agent kept for a directory. */
export interface Session {
  sessionId: string;
  cwd: string;
  title?: string;
  /** The time of the session's last activity (RFC 3339). */
  updatedAt?: string;
  /** The host's chat that has this session; left out for none. */
  chat?: string;
}

/** The states of a chat (Chat.state). */
export const State = {
  /** The agent is being started and the session made. */
  Starting: 'starting',
  /** The agent process runs; no turn does. */
  Idle: 'idle',
  /** A turn runs. */
  Working: 'working',
  /** A turn waits for a permission or a question nobody answered yet. */
  Waiting: 'waiting',
  /** No agent process (stopped when idle, or by a host that ended); the
   * next prompt resumes the session by its id. */
  Sleeping: 'sleeping',
  /** The agent could not start or ended unexpectedly; Chat.error says why. */
  Failed: 'failed',
  /** The user closed the chat (Op.Close). */
  Closed: 'closed',
  /** No state of a Chat: Op.Watch's last ChatState line of a chat that is no
   * more (Op.Delete, or the host's limits removed it), with Status.Idle. */
  Deleted: 'deleted',
} as const;

/** The statuses of a chat (Chat.status): what notifications and the UIs'
 * dots show, the vocabulary of the agents in terminals. */
export const Status = {
  /** A turn runs (State.Working). */
  Working: 'working',
  /** A permission or a question waits (State.Waiting). */
  Blocked: 'blocked',
  /** A turn ended after what the user saw (Chat.seen), and nobody saw it yet. */
  Done: 'done',
  /** Anything else. */
  Idle: 'idle',
} as const;

/** The status of a chat in state whose last turn ended at the sequence
 * number turnEnd (0 for none) and that the user saw up to seen. */
export function statusOf(state: string, turnEnd: number, seen: number): string {
  if (state === State.Working) return Status.Working;
  if (state === State.Waiting) return Status.Blocked;
  if (turnEnd > seen) return Status.Done;
  return Status.Idle;
}

/** The form of the host's chat ids. */
const chatID = /^c[0-9a-f]{16}$/;

/** Whether s is a chat id as the host makes them: "c" and 16 lower-case
 * hexadecimal digits. */
export const validChatID = (s: string): boolean => chatID.test(s);

/** A new random chat id. */
export const newChatID = (): string => 'c' + randomBytes(8).toString('hex');

/** A conversation with an agent, as the host knows it. */
export interface Chat {
  id: string;
  /** The agent's kind (agentkinds). */
  kind: string;
  title: string;
  cwd: string;
  /** The agent's id of the session; "" until it exists. */
  sessionId: string;
  state: string;
  status: string;
  /** Why the chat is in State.Failed. */
  error?: ChatError;
  /** RFC 3339. */
  created: string;
  /** The time of the chat's last stored event (RFC 3339). */
  updated: string;
  /** The sequence number of the chat's last stored event. */
  seq: number;
  /** The last sequence number the user saw (Op.Seen). */
  seen: number;
  /** When the chat was closed (State.Closed, RFC 3339); the host's retention
   * counts from it. */
  closed?: string;
  /** When the chat was archived (Op.Archive, RFC 3339); left out while it is
   * not. The host's retention of an archived chat counts from the later of
   * it and closed. */
  archived?: string;
  /** The session went on in a terminal (Op.Handoff); what it did there is
   * brought into the log when the chat takes a prompt again. */
  handedOff?: boolean;
  /** The version of the agent's program. */
  agentVersion?: string;
  /** The session's configuration options with their current values: model,
   * effort, mode and the agent's own. */
  config?: ConfigOption[];
  /** The slash commands the agent offers. */
  commands?: SlashCommand[];
  /** The session's context and cost, once known. */
  usage?: Usage;
  /** What the chat's agent can do. */
  capabilities: Capabilities;
}

/** What Op.Watch tells of the chat. Members Go leaves out when empty are
 * left out, so the line is the one the Go host writes. */
export function stateOf(c: Chat): ChatState {
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    cwd: c.cwd,
    state: c.state,
    status: c.status,
    updated: c.updated,
    seq: c.seq,
    ...(c.seen ? { seen: c.seen } : {}),
    ...(c.status === Status.Done ? { unread: true } : {}),
    sessionId: c.sessionId,
    ...(c.archived ? { archived: true } : {}),
  };
}

/** What Op.Watch tells of a chat. Its state is a chat's, or State.Deleted
 * once the chat is no more. */
export interface ChatState {
  id: string;
  kind: string;
  title: string;
  cwd: string;
  state: string;
  status: string;
  /** RFC 3339. */
  updated: string;
  seq: number;
  seen?: number;
  unread?: boolean;
  stale?: boolean;
  sessionId: string;
  /** The chat was archived (Op.Archive). */
  archived?: boolean;
}

/** What a chat's agent can do, for the UIs to offer. */
export interface Capabilities {
  /** Prompts may carry image blocks. */
  images: boolean;
  /** CommandOp.Compact. */
  compact: boolean;
  /** CommandOp.Prompt while a turn runs (EventType.Queued). */
  queue: boolean;
  /** The agent plans and asks to approve the plan (PermissionKind.Plan). */
  plan: boolean;
  /** The agent asks the user questions (EventType.Question). */
  questions: boolean;
  /** effort and model: the chat has a ConfigOption of that category. */
  effort: boolean;
  model: boolean;
  /** CommandOp.CancelQueued. */
  cancelQueued: boolean;
}

/** The categories of a ConfigOption the UIs know; others are the agents'. */
export const Category = {
  Mode: 'mode',
  Model: 'model',
  ThoughtLevel: 'thought_level',
} as const;

/** The type of a ConfigOption with values to choose from, the only one
 * there is. */
export const CONFIG_SELECT = 'select';

/** A session configuration option, in the shape of the Agent Client
 * Protocol's: the effort is the category thought_level. Values of an
 * agent's grouped options are listed one after the other. */
export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  /** Category.Mode, Category.Model, Category.ThoughtLevel or an agent's own. */
  category?: string;
  type: string;
  currentValue: string;
  /** null from a Go writer that has none. */
  options: ConfigValue[] | null;
}

/** A value of a ConfigOption. */
export interface ConfigValue {
  value: string;
  name: string;
  description?: string;
  /** Marks the value of a mode option that gives the agent full access
   * (Mode.Full, an agent's yolo): the host refuses it while
   * HostSettings.allowFull is off. */
  full?: boolean;
}

/** A command the agent takes as a prompt "/<name> ...". */
export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** A session's context window and cost. */
export interface Usage {
  /** used and size are the context window's tokens in use and in all; size
   * is 0 while unknown. */
  used: number;
  size: number;
  /** The agent's own measure of the context in use, when it gives one; else
   * used/size. */
  percentage?: number;
  /** The session's cost so far. */
  cost?: Cost;
  /** The subscription's rate limit windows the agent reports. */
  limits?: Limit[];
}

/** An amount of money. */
export interface Cost {
  amount: number;
  currency: string;
}

/** A rate limit window of the agent's subscription. */
export interface Limit {
  id: string;
  label?: string;
  /** How much of the window's allowance is used, 0 to 100. */
  usedPercent: number;
  /** When the window starts again, in seconds since the epoch; left out when
   * unknown. */
  resetsAt?: number;
  /** The window's length. */
  windowMinutes?: number;
}

// The bounds of HostSettings: their defaults, and the least and the most
// each may be (what the core's settings offer, the chat plugin, and what
// clampHostSettings enforces whatever is asked).
export const IDLE_STOP_MINUTES_DEFAULT = 30;
export const IDLE_STOP_MINUTES_MIN = 5;
export const IDLE_STOP_MINUTES_MAX = 1440;
export const MAX_LIVE_DEFAULT = 8;
export const MAX_LIVE_MIN = 1;
export const MAX_LIVE_MAX = 32;
export const MAX_CHATS_DEFAULT = 500;
export const MAX_CHATS_MIN = 50;
export const MAX_CHATS_MAX = 2000;
export const RETENTION_DAYS_DEFAULT = 30;
export const RETENTION_DAYS_MIN = 1;
export const RETENTION_DAYS_MAX = 365;
export const MAX_TOTAL_MB_DEFAULT = 512;
export const MAX_TOTAL_MB_MIN = 64;
export const MAX_TOTAL_MB_MAX = 2048;
export const MAX_CHAT_MB_DEFAULT = 64;
export const MAX_CHAT_MB_MIN = 8;
export const MAX_CHAT_MB_MAX = 256;

/** The core's settings for a machine's chat host (Op.Configure). A member
 * left out (or 0) means its default. */
export interface HostSettings {
  /** An agent process with no turn and nothing waiting for this long is
   * ended; its chat sleeps. */
  idleStopMinutes?: number;
  /** The most agent processes at once; one more ends the one idle the
   * longest. */
  maxLive?: number;
  /** The most chats kept; the oldest closed ones go first. */
  maxChats?: number;
  /** A closed chat is kept this long. */
  retentionDays?: number;
  /** The most bytes of every chat's log together; the oldest closed chats
   * go first. */
  maxTotalBytes?: number;
  /** The most bytes of a chat's log; its oldest events go first. */
  maxChatBytes?: number;
  /** The permission mode of a chat whose Options name none (MODES). */
  defaultMode?: string;
  /** Allows full access (Mode.Full, a ConfigValue.full): without it the
   * host refuses a chat or a configuration that asks for it, and a chat that
   * had it starts its agent again in Mode.Default (the notice
   * full_access_off). */
  allowFull?: boolean;
}

/** HostSettings as clampHostSettings returns them: every member set but
 * allowFull, which is there only when true. */
export type ClampedHostSettings = Required<Omit<HostSettings, 'allowFull'>> & Pick<HostSettings, 'allowFull'>;

const MIB = 1 << 20;

/** The settings of a host nobody configured. */
export const defaultHostSettings = (): ClampedHostSettings => clampHostSettings({});

/** s with each member within its bounds: a member left out or 0 its
 * default, one out of its bounds the nearest bound, and a defaultMode that is
 * no mode, or Mode.Full without allowFull, Mode.Default. What is no number
 * (settings read from JSON are not checked) counts as left out, and a
 * fraction is cut to a whole number. */
export function clampHostSettings(s: HostSettings): ClampedHostSettings {
  const allowFull = s.allowFull === true;
  const mode = typeof s.defaultMode === 'string' ? s.defaultMode : '';
  const out: ClampedHostSettings = {
    idleStopMinutes: clamp(s.idleStopMinutes, IDLE_STOP_MINUTES_DEFAULT, IDLE_STOP_MINUTES_MIN, IDLE_STOP_MINUTES_MAX),
    maxLive: clamp(s.maxLive, MAX_LIVE_DEFAULT, MAX_LIVE_MIN, MAX_LIVE_MAX),
    maxChats: clamp(s.maxChats, MAX_CHATS_DEFAULT, MAX_CHATS_MIN, MAX_CHATS_MAX),
    retentionDays: clamp(s.retentionDays, RETENTION_DAYS_DEFAULT, RETENTION_DAYS_MIN, RETENTION_DAYS_MAX),
    maxTotalBytes: clamp(s.maxTotalBytes, MAX_TOTAL_MB_DEFAULT * MIB, MAX_TOTAL_MB_MIN * MIB, MAX_TOTAL_MB_MAX * MIB),
    maxChatBytes: clamp(s.maxChatBytes, MAX_CHAT_MB_DEFAULT * MIB, MAX_CHAT_MB_MIN * MIB, MAX_CHAT_MB_MAX * MIB),
    defaultMode: (MODES as readonly string[]).includes(mode) && !(mode === Mode.Full && !allowFull) ? mode : Mode.Default,
  };
  if (allowFull) out.allowFull = true;
  return out;
}

function clamp(v: unknown, def: number, lo: number, hi: number): number {
  if (typeof v !== 'number' || Number.isNaN(v) || v === 0) return def;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return Math.trunc(v);
}

/** The types of an Event. */
export const EventType = {
  /** A session update in the shape of the Agent Client Protocol's (the
   * update member of a session/update's params), in Event.update. */
  Update: 'update',
  /** A prompt as the host accepted it, in Event.content, with the page's
   * Event.clientId. */
  User: 'user',
  /** A turn started, ended (Event.stopReason) or failed (Event.error);
   * Event.state is TurnState.Start, End or Error. */
  Turn: 'turn',
  /** The agent asks the permission Event.id, of Event.kind, for
   * Event.toolCall, to be answered with one of Event.options. */
  Permission: 'permission',
  /** The permission Event.id was answered with Event.outcome, by Event.by. */
  PermissionDone: 'permission_done',
  /** The agent asks the user Event.questions, together as the question
   * Event.id. */
  Question: 'question',
  /** The question Event.id was answered with Event.answers, by Event.by; no
   * answers when it was skipped or cancelled. */
  QuestionDone: 'question_done',
  /** A message sent while a turn ran, Event.message with Event.content and
   * the page's Event.clientId, is in Event.state: QueuedState.Waiting, Taken
   * or Cancelled. */
  Queued: 'queued',
  /** The chat is in Event.state now, for Event.error. */
  State: 'state',
  /** The chat as it is now, in Event.chat: once the session exists, and
   * when the host changed what a Chat states. */
  Info: 'info',
  /** Something of the session that is no session update, in Event.method
   * (an extension method, "_<product slug>/<name>", as agentproto's
   * noticeMethod makes them) and Event.params. */
  Notice: 'notice',
  /** The answer to the Command Event.id, with Event.error when it was
   * refused. Acks have no sequence number and are not stored. */
  Ack: 'ack',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/** The states of an EventType.Turn. */
export const TurnState = {
  Start: 'start',
  End: 'end',
  Error: 'error',
} as const;

/** The states of an EventType.Queued. */
export const QueuedState = {
  /** The message waits for the turn to take it. */
  Waiting: 'queued',
  /** The agent took the message, into the running turn or as the next one. */
  Taken: 'taken',
  /** The message was withdrawn (CommandOp.CancelQueued, CommandOp.Cancel)
   * and never reached the agent. */
  Cancelled: 'cancelled',
} as const;

/** The kinds of a permission (Event.kind). */
export const PermissionKind = {
  /** A tool call of another kind. */
  Tool: 'tool',
  /** A command to run. */
  Command: 'command',
  /** A change of files. */
  File: 'file',
  /** The approval of a plan; its options name the mode to go on in (the
   * chat adapters' plan option prefix). */
  Plan: 'plan',
  /** A tool of an MCP server. */
  MCP: 'mcp',
  /** Anything else. */
  Other: 'other',
} as const;

/** Who answered a permission or a question (Event.by). */
export const By = {
  /** A client's CommandOp.Permission or CommandOp.Answer. */
  User: 'user',
  /** The turn was cancelled. */
  Cancel: 'cancel',
  /** The turn or the chat ended. */
  Ended: 'ended',
} as const;

/** A line of an attached connection: something a chat did, or the answer
 * to a command.
 *
 * A stored event has a sequence number and stays in the chat's log within
 * the host's limits. A live event (live) is an increment of an item being
 * streamed (text, a thought, a tool's input or a command's output): it has no
 * sequence number, goes only to the clients attached at the time and is never
 * stored. Once an item is complete, or changes otherwise, the host stores one
 * event with its whole content under the same item: a client replaces what
 * it accumulated live for that item with it. A client that attaches again
 * gets the stored events after its from and discards the items it has only
 * live increments of. */
export interface Event {
  /** Numbers a chat's stored events from 1; left out for a live event or an
   * ack. */
  seq?: number;
  /** The event's type. */
  t: EventType;
  /** RFC 3339. */
  at?: string;
  /** The permission's (EventType.Permission, PermissionDone), the
   * question's (EventType.Question, QuestionDone) or the command's
   * (EventType.Ack). */
  id?: string;
  /** Marks a streaming increment. */
  live?: boolean;
  /** The id of the item an EventType.Update belongs to: a message, a
   * thought, a tool call. */
  item?: string;
  /** The tool call id of the subagent the event belongs to; left out for the
   * main agent's. */
  parent?: string;

  /** The session update (EventType.Update). */
  update?: unknown;
  /** A prompt's content blocks (EventType.User, EventType.Queued). */
  content?: unknown[];
  /** The page's id of the message (Command.clientId) for EventType.User and
   * EventType.Queued. */
  clientId?: string;
  /** The host's id of a queued message (EventType.Queued), which
   * CommandOp.CancelQueued names. */
  message?: string;
  /** The turn's (EventType.Turn), the chat's (EventType.State) or the queued
   * message's (EventType.Queued). */
  state?: string;
  stopReason?: string;
  error?: ChatError;
  /** A permission's: PermissionKind.Tool, Command, File, Plan, MCP or Other. */
  kind?: string;
  /** toolCall and options are what a permission is asked for, as an ACP
   * tool call, and the answers to choose from (EventType.Permission); outcome
   * and by how it was answered (EventType.PermissionDone). */
  toolCall?: unknown;
  options?: PermissionOption[];
  outcome?: Outcome;
  by?: string;
  /** questions are what EventType.Question asks; answers what
   * EventType.QuestionDone was answered, by Question.id. */
  questions?: Question[];
  answers?: Record<string, string[]>;
  /** The chat as it is now (EventType.Info). */
  chat?: Chat;
  /** method and params are a notice's (EventType.Notice). */
  method?: string;
  params?: unknown;
}

/** The kinds of a PermissionOption. */
export const OptionKind = {
  AllowOnce: 'allow_once',
  AllowAlways: 'allow_always',
  RejectOnce: 'reject_once',
  RejectAlways: 'reject_always',
} as const;

/** An answer a user may give to a permission. */
export interface PermissionOption {
  optionId: string;
  name: string;
  /** OptionKind.AllowOnce, AllowAlways, RejectOnce or RejectAlways. */
  kind: string;
}

/** The outcomes of a permission (Outcome.outcome). */
export const OutcomeKind = {
  Selected: 'selected',
  Cancelled: 'cancelled',
} as const;

/** How a permission was answered. */
export interface Outcome {
  outcome: string;
  optionId?: string;
}

/** One question of an EventType.Question. */
export interface Question {
  id: string;
  /** A short label of the question (a chip, a tab). */
  header?: string;
  question: string;
  /** More than one option may be chosen. */
  multiSelect?: boolean;
  /** An answer of the user's own words may be given. */
  allowOther?: boolean;
  /** The answer is not to be shown as typed (a password). */
  secret?: boolean;
  options?: QuestionOption[];
}

/** An answer to choose. Answers name options by label. */
export interface QuestionOption {
  label: string;
  description?: string;
  /** What choosing it would look like (Markdown). */
  preview?: string;
}

/** A line a client sends while attached. id is the client's, and comes
 * back in the command's ack. */
export interface Command {
  op: CommandOp;
  id: string;
  /** The content blocks of CommandOp.Prompt, as the Agent Client Protocol
   * defines them: text, image {mimeType, data} (at most MAX_IMAGE bytes each)
   * and resource_link (a file named with @); at most MAX_PROMPT bytes in all. */
  content?: unknown[];
  /** The page's id of CommandOp.Prompt's message, given back in its
   * EventType.User or EventType.Queued. */
  clientId?: string;
  /** The permission CommandOp.Permission answers, the question
   * CommandOp.Answer answers. */
  request?: string;
  /** The optionId chosen (CommandOp.Permission). */
  option?: string;
  /** CommandOp.Answer's, by Question.id: option labels, or the user's own
   * words for a question that allows them. */
  answers?: Record<string, string[]>;
  /** Answers a permission without an option, or skips a question. */
  cancelled?: boolean;
  /** config and value are the option CommandOp.SetConfig sets and its value. */
  config?: string;
  value?: string;
  /** The queued message CommandOp.CancelQueued withdraws. */
  message?: string;
  /** CommandOp.Rename's. */
  title?: string;
}

/** The codes of a ChatError. */
export const Code = {
  /** The request, the command or the chat's directory is not what the
   * protocol asks for. */
  BadRequest: 'bad_request',
  /** The host has no such chat. */
  UnknownChat: 'unknown_chat',
  /** The host keeps as many chats as its settings allow and none can go. */
  TooMany: 'too_many',
  /** A turn runs, the chat still starts, or a chat works or waits
   * (Op.Shutdown). */
  Busy: 'busy',
  /** The agent's program, the session, the permission or the question is
   * not there. */
  NotFound: 'not_found',
  /** The agent did not start or made no session. */
  StartFailed: 'start_failed',
  /** The agent speaks another version of its protocol. */
  Protocol: 'protocol',
  /** The agent wants the user to sign in first. */
  AuthRequired: 'auth_required',
  /** The agent lacks the capability. */
  Unsupported: 'unsupported',
  /** A line longer than MAX_LINE, a prompt over MAX_PROMPT or an image over
   * MAX_IMAGE. */
  TooLarge: 'too_large',
  /** The chat's agent is gone. */
  Ended: 'ended',
  /** The agent answered with an error, or not at all. */
  Failed: 'failed',
  /** Another process of the agent (a terminal's) runs the session; two
   * processes do not write one session. */
  InTerminal: 'in_terminal',
  /** The chat's session went on in a terminal (CommandOp.Handoff) and the
   * command needs its agent process. */
  HandedOff: 'handed_off',
  /** The chat has no agent process (State.Sleeping, State.Closed) and the
   * command needs one; a prompt resumes it. */
  Sleeping: 'sleeping',
  /** The machine's settings do not allow it: full access while
   * HostSettings.allowFull is off. */
  NotAllowed: 'not_allowed',
  /** Op.Trust of a directory that may not be trusted (see Op.Trust). */
  UnsafeFolder: 'unsafe_folder',
} as const;

/** Why a request, a command, a turn or a chat failed (the Go package's
 * Error). message is for logs and for a reader who wants the detail;
 * programs go by code. */
export interface ChatError {
  code: string;
  message: string;
  /** The end of what the agent wrote to its standard error, at most
   * MAX_STDERR bytes, for a chat or a turn that failed. It may tell what the
   * agent's environment holds: the host never stores it. It is on the chat's
   * error while the host runs, and on the events that carry an error
   * (EventType.State, EventType.Turn) and the Chat of an EventType.Info as
   * they are sent live; replayed, they have none. A client that shows a chat
   * to a reader who may not change it leaves it out (redactedChat,
   * redactedEvent). */
  stderr?: string;
}

/** A ChatError as text: "<code>: <message>". */
export const errorText = (e: ChatError): string => `${e.code}: ${e.message}`;

/** A ChatError to throw; its JSON is the ChatError's. */
export class ChatProtoError extends Error {
  readonly error: ChatError;

  constructor(error: ChatError) {
    super(errorText(error));
    this.error = error;
    this.name = 'ChatProtoError';
  }

  get code(): string {
    return this.error.code;
  }

  toJSON(): ChatError {
    return this.error;
  }
}

/** e without stderr: e itself when it has none, undefined for undefined. */
export function withoutStderr(e: ChatError): ChatError;
export function withoutStderr(e: ChatError | undefined): ChatError | undefined;
export function withoutStderr(e: ChatError | undefined): ChatError | undefined {
  if (!e?.stderr) return e;
  return { code: e.code, message: e.message };
}

/** A copy of the chat without what only a reader who may change it sees:
 * its error's stderr. */
export function redactedChat(c: Chat): Chat {
  const r = { ...c };
  if (c.error) r.error = withoutStderr(c.error);
  return r;
}

/** A copy of the event without what only a reader who may change the chat
 * sees: the stderr of its error and of its chat's. */
export function redactedEvent(ev: Event): Event {
  const r = { ...ev };
  if (ev.error) r.error = withoutStderr(ev.error);
  if (ev.chat?.error?.stderr) r.chat = redactedChat(ev.chat);
  return r;
}
