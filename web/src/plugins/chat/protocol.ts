// The chat plugin's protocol as the page sees it: the chat host's types
// (internal/chatproto), which the core relays, and the page's WebSocket
// GET /api/p/chat/ws (internal/plugins/chat/wire.go). Each mirrors its Go
// type's JSON. What comes from a machine is not trusted to have these
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
/** The most subscriptions a page's WebSocket has at once. */
export const MAX_SUBS = 64;
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

/** The core's error codes of the WebSocket, besides the chat host's. */
export const CORE_CODES = ['read_only', 'offline', 'unknown_sub', 'too_many'] as const;

/** The chat plugin's message on the core's event channel for a machine:
 * every chat of it (full), or those that changed. */
export interface StatesData {
  t: 'states';
  states: ChatState[];
  full: boolean;
}
