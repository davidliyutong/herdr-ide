// The chat plugin's protocol as the page sees it: the chat host's types
// (backend/shared/proto/chatproto), which the core relays, and the page's WebSocket
// GET /api/p/chat/ws (backend/features/chat). Each mirrors the JSON of its
// type there. What comes from a machine is not trusted to have these
// shapes: readers check the type of every member they keep and pass over
// members and values this version does not know.
import type { ChatError, ChatEvent, ContentBlock, Cost, Question } from '../../conversation/model';

export type { ChatError, Question };
/** An event of a chat (chatproto.Event). */
export type Event = ChatEvent;

/** The chat host's protocol version (chatproto.Proto). */
export const PROTO = 2;
/** The most content a prompt carries: the JSON of its blocks, in bytes. */
export const MAX_PROMPT = 8 << 20;
/** The most bytes of an image of a prompt, decoded. */
export const MAX_IMAGE = 5 << 20;
/** The most bytes of an agent's standard error an error carries (its
 * end, ChatError.stderr): never stored, sent only live, and left out for a
 * read-only page (chatproto.MaxStderr). */
export const MAX_STDERR = 2 << 10;

/** The states of a chat (chatproto.State*). */
export const CHAT_STATES = ['starting', 'idle', 'working', 'waiting', 'sleeping', 'failed', 'closed'] as const;
export type ChatStateName = (typeof CHAT_STATES)[number];
/** No state of a chat: the last ChatState the host tells of a chat that is
 * no more, deleted or removed by its limits (chatproto.StateDeleted). */
export const STATE_DELETED = 'deleted';

/** The statuses of a chat (chatproto.Status*), what notifications and
 * dots show: working, blocked (a permission or a question waits), done (a
 * turn ended that nobody saw yet), idle. */
export const CHAT_STATUSES = ['working', 'blocked', 'done', 'idle'] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];

/** The permission modes (chatproto.Modes; the setting chat.permissionMode). */
export const MODES = ['default', 'acceptEdits', 'plan', 'full'] as const;
export type Mode = (typeof MODES)[number];

/** The categories of a configuration option the UI knows; others are the
 * agents' own. */
export const CATEGORY_MODE = 'mode';
export const CATEGORY_MODEL = 'model';
export const CATEGORY_THOUGHT_LEVEL = 'thought_level';

/** A value of a configuration option. */
export interface ConfigValue {
  value: string;
  name: string;
  description?: string;
  /** Choosing it gives the agent full access (the mode full or the
   * agent's own equivalent, as Kimi's yolo): a read-only page may not, and
   * the chat host refuses it (not_allowed) while the machine's setting
   * chat.allowFullAccess (HostSettings.allowFull) is off. */
  full?: boolean;
}

/** A session configuration option (chatproto.ConfigOption), as ACP's: the
 * model, the effort (thought_level), the mode and the agents' own. */
export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: 'select';
  currentValue: string;
  options: ConfigValue[];
}

/** A slash command the agent takes ("/<name> ..."). */
export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** A rate limit window of the agent's subscription. */
export interface Limit {
  id: string;
  label?: string;
  /** 0 to 100. */
  usedPercent: number;
  /** Seconds since the epoch. */
  resetsAt?: number;
  windowMinutes?: number;
}

/** A session's context window and cost (chatproto.Usage). */
export interface ChatUsage {
  used: number;
  /** 0 while unknown. */
  size: number;
  /** The agent's own measure of the context in use; else used/size. */
  percentage?: number;
  cost?: Cost;
  limits?: Limit[];
}

/** What a chat's agent can do. */
export interface Capabilities {
  images: boolean;
  compact: boolean;
  queue: boolean;
  plan: boolean;
  questions: boolean;
  effort: boolean;
  model: boolean;
  cancelQueued: boolean;
}

/** A chat as the host knows it (chatproto.Chat). */
export interface Chat {
  id: string;
  /** The agent's kind (conversation/kinds.ts). */
  kind: string;
  title: string;
  cwd: string;
  sessionId: string;
  state: ChatStateName | string;
  status: ChatStatus | string;
  error?: ChatError;
  /** RFC 3339. */
  created: string;
  updated: string;
  /** The last stored event's seq. */
  seq: number;
  /** The last seq the user saw. */
  seen: number;
  /** When it was closed (RFC 3339). */
  closed?: string;
  /** Its session went on in a terminal. */
  handedOff?: boolean;
  agentVersion?: string;
  config?: ConfigOption[];
  commands?: SlashCommand[];
  usage?: ChatUsage;
  capabilities: Capabilities;
}

/** What the chats' states tell of each (chatproto.ChatState); its state
 * is STATE_DELETED once the chat is no more. */
export interface ChatState {
  id: string;
  kind: string;
  title: string;
  cwd: string;
  state: ChatStateName | typeof STATE_DELETED | string;
  status: ChatStatus | string;
  updated: string;
  seq: number;
  sessionId: string;
  seen?: number;
  unread?: boolean;
  stale?: boolean;
  /** The chat was archived: kept, closed, until the machine's chat limits
   * remove it; the Chats panel lists it apart. */
  archived?: boolean;
}

/** A trusted folder persisted on a machine's chat host. */
export interface TrustedFolder {
  cwd: string;
  /** RFC 3339. */
  at: string;
}

/** A session on a machine's headless chat host (debug/management overview). */
export interface ChatHostSession {
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

/** Overview of a machine's headless chat host (GET /api/p/chat/hosts). */
export interface ChatHostOverview {
  machine: string;
  label: string;
  machineStatus: string;
  running: boolean;
  status: 'running' | 'stopped' | 'offline' | 'error';
  pid?: number;
  version?: string;
  proto?: number;
  terminalId?: string;
  /** RFC 3339. */
  startedAt?: string;
  socket?: string;
  base?: string;
  conns?: number;
  watchers?: number;
  liveAgents?: number;
  totalChats: number;
  totalBytes?: number;
  ending?: number;
  settings?: HostSettings;
  sessions: ChatHostSession[];
  error?: string;
  message?: string;
}

/** Whether an agent kind can be started on a machine. */
export interface AgentStatus {
  kind: string;
  available: boolean;
  version?: string;
  /** not_found, unsupported */
  reason?: string;
}

/** A session an agent kept for a directory. */
export interface Session {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  /** The chat that has it. */
  chat?: string;
}

/** The settings the core gives a machine's chat host (chatproto.
 * HostSettings), from the machine's chat.* settings; a zero member is the
 * host's default. allowFull (chat.allowFullAccess) allows full access:
 * without it the host refuses a chat or a configuration value that asks
 * for it (not_allowed), and starts a chat that had it in the default mode
 * (the notice full_access_off). */
export interface HostSettings {
  idleStopMinutes?: number;
  maxLive?: number;
  maxChats?: number;
  retentionDays?: number;
  maxTotalBytes?: number;
  maxChatBytes?: number;
  defaultMode?: Mode;
  allowFull?: boolean;
}

/** The requests the core makes of a chat host for the page's routes,
 * besides those of the chats' states (chatproto.Op*): trust lets the
 * agents load a directory's own project settings (POST trust?cwd=),
 * untrust takes that back (POST untrust?cwd=).
 * The core attaches a read-only page's subscription with noCatchUp: it
 * starts nothing on the machine (no catch-up of what the session did in
 * a terminal). */
export const REQUEST_OPS = ['agents', 'chats', 'sessions', 'new', 'close', 'delete', 'seen', 'attach', 'trust', 'untrust'] as const;

/** What a new chat starts with; each a value of the chat's option of
 * that category. */
export interface Options {
  model?: string;
  effort?: string;
  mode?: string;
}

/** The operations of a command (chatproto.Op*), each answered by an ack. */
export const COMMAND_OPS = [
  'prompt',
  'cancel',
  'permission',
  'answer',
  'set_config',
  'cancel_queued',
  'compact',
  'rename',
  'handoff',
] as const;
export type CommandOp = (typeof COMMAND_OPS)[number];

/** A command for an attached chat (chatproto.Command). The core sets its
 * id; the page names the command in ClientMessage.id. */
export interface Command {
  op: CommandOp;
  id?: string;
  /** prompt: ACP content blocks (text, image, resource_link). */
  content?: ContentBlock[];
  /** prompt: the page's id of the message, given back in its user or
   * queued event. */
  clientId?: string;
  /** permission, answer: the request answered. */
  request?: string;
  /** permission: the optionId chosen. */
  option?: string;
  /** answer: by question id. */
  answers?: Record<string, string[]>;
  /** permission without an option; a question skipped. */
  cancelled?: boolean;
  /** set_config */
  config?: string;
  value?: string;
  /** cancel_queued */
  message?: string;
  /** rename */
  title?: string;
}

/** The permission options the host shows for an agent without its own
 * (chatadapter.Option*). A plan's approval offers planOption(mode) for
 * the modes to go on in, and OPTION_REJECT_ONCE to keep planning. */
export const OPTION_ALLOW_ONCE = 'allow_once';
export const OPTION_ALLOW_SESSION = 'allow_session';
export const OPTION_REJECT_ONCE = 'reject_once';
export const PLAN_OPTION_PREFIX = 'plan:';
export const planOption = (mode: Mode): string => PLAN_OPTION_PREFIX + mode;

/** Whether s is a chat id as the host makes them (chatproto.ValidChatID):
 * "c" and 16 lower-case hexadecimal digits. */
export const isChatId = (s: unknown): s is string => typeof s === 'string' && /^c[0-9a-f]{16}$/.test(s);

// ---- the page's WebSocket ----

/** The page's WebSocket. */
export const WS_PATH = '/api/p/chat/ws';
/** The most subscriptions a page's WebSocket has at once, and of them to
 * one machine's chats. */
export const MAX_SUBS = 32;
export const MAX_SUBS_PER_MACHINE = 16;
/** The longest id of a subscription or a command a page gives, in bytes. */
export const MAX_PAGE_ID = 64;
/** Every machine's chats' states as the core last read them
 * (StatesSnapshot), which a page reads before it applies the states
 * messages that follow. */
export const STATES_PATH = '/api/p/chat/states';
/** The longest message a page sends, in bytes. */
export const MAX_CLIENT_MESSAGE = MAX_PROMPT + (64 << 10);

/** A message of the page: subscribe to a chat's events after from,
 * unsubscribe, or send a command. */
export type ClientMessage =
  | { op: 'attach'; sub: string; m: string; chat: string; from?: number }
  | { op: 'detach'; sub: string }
  | { op: 'command'; id: string; m: string; chat: string; cmd: Command };

/** A message of the core: a subscription's chat and lowest stored seq, an
 * event of it, its end, and a command's answer. */
export type ServerMessage =
  | { t: 'attached'; sub: string; chat: Chat; first?: number }
  | { t: 'event'; sub: string; ev: ChatEvent }
  | { t: 'detached'; sub: string; error?: ChatError }
  | { t: 'ack'; id: string; error?: ChatError };

/** The chat host's error codes (chatproto.Code*): sleeping, a command
 * that needs the agent of a chat that has none (a prompt starts it);
 * not_allowed, full access while the machine's chat.allowFullAccess is
 * off; unsafe_folder, a folder that may not be trusted (the home
 * directory or one above it, one others may write); sdk_unavailable, a
 * Claude Code chat on a machine that has not got Anthropic's Agent SDK and
 * could not get it (from npm, or the server's --seed-dir). */
export const HOST_CODES = [
  'bad_request',
  'unknown_chat',
  'too_many',
  'busy',
  'not_found',
  'start_failed',
  'protocol',
  'auth_required',
  'unsupported',
  'too_large',
  'ended',
  'failed',
  'in_terminal',
  'handed_off',
  'sleeping',
  'not_allowed',
  'unsafe_folder',
  'sdk_unavailable',
] as const;

/** The machine's codes of reaching its chat host (its agent's open
 * action): not_running, no chat host serves and the core may not start
 * one (a read-only core); upgrading, a chat host of another version
 * serves until its chats are idle; no_terminal_core, the terminal core
 * that runs the host does not run; start_failed, the host did not start;
 * transport, the connection broke. */
export const MACHINE_CODES = ['not_running', 'upgrading', 'no_terminal_core', 'start_failed', 'transport'] as const;

/** The core's error codes of the WebSocket and the routes, besides the
 * chat host's: not_attached, a command for a chat the page has no
 * subscription to; lost, the subscription's connection to the chat host
 * ended while the machine stays (attach again; a command not answered may
 * have been carried out); plugin_disabled, the plugin was turned off;
 * timeout, the machine did not answer in time. */
export const CORE_CODES = [
  'read_only',
  'offline',
  'unknown_sub',
  'too_many',
  'not_attached',
  'lost',
  'plugin_disabled',
  'timeout',
] as const;

/** Every code of an error the page may receive: the host's, the
 * machine's, the core's, and network when the page did not reach the
 * core. */
export const ERROR_CODES = [...new Set<string>([...HOST_CODES, ...MACHINE_CODES, ...CORE_CODES, 'network'])];

/** The chat plugin's message on the core's event channel for a machine:
 * every chat of it (full), or those that changed (one that is no more in
 * STATE_DELETED). rev numbers a machine's messages since the core started;
 * a page applies one only when its rev is above the one it has. */
export interface StatesData {
  t: 'states';
  states: ChatState[];
  full: boolean;
  rev: number;
  stale?: boolean;
  /** The machine's chat host's version, and whether it is another build
   * than the core's (restarting the host brings the core's). */
  hostVersion?: string;
  outdated?: boolean;
}

/** GET STATES_PATH: each machine's states as the core last read them (full,
 * with the rev of the last message they hold), by machine; a machine whose
 * chat host the core has not read since it started is not there. */
export interface StatesSnapshot {
  machines: Record<string, StatesData>;
}
