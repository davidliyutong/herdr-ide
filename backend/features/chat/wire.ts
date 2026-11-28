// The page's WebSocket, GET /api/p/chat/ws: one per page, for the chats of
// every machine (a browser opens at most six HTTP/1.1 connections to an
// origin). Messages are JSON text frames, each one of the messages below;
// web/src/plugins/chat/protocol.ts mirrors them.
//
// The page subscribes to a chat with attach under an id of its own (sub):
// the hub answers attached with the chat and the lowest stored sequence
// number, then event for each event of the chat after from (stored ones,
// then live ones as they come), until the page sends detach or the hub
// sends detached (the machine left, the chat was deleted, the feature was
// turned off). Each subscription is a connection of its own to the
// machine's chat host, which fans the chat's events out. A page has at most
// MAX_SUBS subscriptions, MAX_SUBS_PER_MACHINE of one machine. The page
// sends a chat's commands with command under an id of its own (id), on a
// subscription of that chat it has, answered by ack with that id, exactly
// once, also when the subscription ends first; a chatproto Command's own id
// is the hub's. A read-only hub refuses every command (read_only) and
// takes attaches.
//
// The chats' states reach every page through the hub's event channel
// (/ws) as {t: "plugin", plugin: "chat", m, data: StatesData}; a page that
// (re)connects reads them all first from GET /api/p/chat/states
// (StatesSnapshot) and then applies the messages whose rev is above the
// snapshot's.
import { z } from 'zod';
import * as chat from '#shared/proto/chatproto/index.ts';

/** The hub's error codes, besides chatproto's and the machine's. */
export const HubCode = {
  /** The hub is read-only; commands are refused. */
  ReadOnly: 'read_only',
  /** The chat's machine is not connected. */
  Offline: 'offline',
  /** detach of a subscription the page does not have. */
  UnknownSub: 'unknown_sub',
  /** The page has MAX_SUBS subscriptions already, or MAX_SUBS_PER_MACHINE
   * of the machine; or the hub has as many connections to the machine's
   * chat host as it keeps (Limits.maxHostConns). */
  TooMany: 'too_many',
  /** command for a chat the page has no subscription to, or one that the
   * page detached before the command's answer came. */
  NotAttached: 'not_attached',
  /** The subscription's connection to the chat host ended (the host ended,
   * or dropped a connection that fell behind, or the connection broke)
   * while the machine stays connected: the page attaches again with its
   * last sequence number. A command whose answer had not come is told so
   * too: it may have been carried out. */
  Lost: 'lost',
  /** The feature was turned off; the WebSocket closes after telling each
   * subscription. */
  PluginDisabled: 'plugin_disabled',
  /** The machine or its chat host did not answer in time. */
  Timeout: 'timeout',
} as const;

/** The longest message a page sends, in bytes: a command with a prompt of
 * MAX_PROMPT and its envelope. */
export const MAX_CLIENT_MESSAGE = chat.MAX_PROMPT + (64 << 10);
/** The most subscriptions a page's WebSocket has at once, and the most of
 * them to one machine's chats. */
export const MAX_SUBS = 32;
export const MAX_SUBS_PER_MACHINE = 16;
/** The longest id of a subscription, a command or a machine a page gives,
 * in bytes. */
export const MAX_PAGE_ID = 64;

/** The operations a page's command may have. */
export const COMMAND_OPS: ReadonlySet<string> = new Set([
  chat.CommandOp.Prompt,
  chat.CommandOp.Cancel,
  chat.CommandOp.Permission,
  chat.CommandOp.Answer,
  chat.CommandOp.SetConfig,
  chat.CommandOp.CancelQueued,
  chat.CommandOp.SteerQueued,
  chat.CommandOp.Compact,
  chat.CommandOp.Rename,
  chat.CommandOp.Handoff,
  chat.CommandOp.StopTask,
  chat.CommandOp.Rewind,
]);

// Members a Go decoder takes: absent or null is the zero value.
const str = z
  .string()
  .nullish()
  .transform((v) => v ?? '');
const uint = z
  .number()
  .int()
  .nonnegative()
  .nullish()
  .transform((v) => v ?? 0);
const flag = z
  .boolean()
  .nullish()
  .transform((v) => v ?? false);

/** A command as a page sends it: the members of chatproto's Command, of
 * their types; others are dropped. */
const command = z.object({
  op: str,
  id: str,
  content: z.array(z.unknown()).nullish(),
  clientId: str,
  request: str,
  option: str,
  answers: z.record(z.string(), z.array(z.string()).nullable()).nullish(),
  cancelled: flag,
  config: str,
  value: str,
  message: str,
  delivery: str,
  title: str,
  task: str,
  seq: uint,
  restoreFiles: flag,
  instructions: str,
});
export type PageCommand = z.output<typeof command>;

/** A message of the page; one whose members are not of their types is
 * ignored. */
export const clientMessage = z.object({
  op: str,
  /** The page's id of a subscription (attach, detach). */
  sub: str,
  /** The page's id of a command (command). */
  id: str,
  /** The machine of the chat (attach, command). */
  m: str,
  /** The chat (attach, command). */
  chat: str,
  /** The last sequence number of the chat the page has: the stored events
   * after it are sent (attach). */
  from: uint,
  /** The command (command). */
  cmd: command.nullish(),
});
export type ClientMessage = z.output<typeof clientMessage>;

/** The command line the hub writes to the chat host for a page's
 * command, under the hub's id: chatproto's members in their order, those
 * that are empty left out. */
export function commandLine(c: PageCommand, id: string): string {
  return chat.line({
    op: c.op,
    id,
    ...(c.content?.length ? { content: c.content } : {}),
    ...(c.clientId ? { clientId: c.clientId } : {}),
    ...(c.request ? { request: c.request } : {}),
    ...(c.option ? { option: c.option } : {}),
    ...(c.answers != null && (c.op === chat.CommandOp.Answer || Object.keys(c.answers).length > 0) ? { answers: c.answers } : {}),
    ...(c.cancelled ? { cancelled: true } : {}),
    ...(c.config ? { config: c.config } : {}),
    ...(c.value ? { value: c.value } : {}),
    ...(c.message ? { message: c.message } : {}),
    ...(c.delivery ? { delivery: c.delivery } : {}),
    ...(c.title ? { title: c.title } : {}),
    ...(c.task ? { task: c.task } : {}),
    ...(c.seq ? { seq: c.seq } : {}),
    ...(c.restoreFiles ? { restoreFiles: true } : {}),
    ...(c.instructions ? { instructions: c.instructions } : {}),
  });
}

/** The messages of the hub. */
export const T = {
  /** Answers attach: the chat as it is, and the lowest sequence number
   * still stored. */
  Attached: 'attached',
  /** An event of the chat (ev). */
  Event: 'event',
  /** The subscription ended (error). */
  Detached: 'detached',
  /** Answers the page's command id; error when it was refused. */
  Ack: 'ack',
} as const;

export const attached = (sub: string, c: unknown, first: number): string =>
  JSON.stringify({ t: T.Attached, sub, ...(c ? { chat: c } : {}), ...(first ? { first } : {}) });
export const detached = (sub: string, error: chat.ChatError): string => JSON.stringify({ t: T.Detached, sub, error });
export const ack = (id: string, error?: chat.ChatError): string => JSON.stringify({ t: T.Ack, id, ...(error ? { error } : {}) });
/** The start of an event's message of subscription sub, which the host's
 * line follows as it is, and then "}". */
export const eventPrefix = (sub: string): string => `{"t":"event","sub":${JSON.stringify(sub)},"ev":`;

/** The type of StatesData. */
export const DATA_STATES = 'states';

/** The data of the chat feature's message on the hub's event channel for
 * machine m. */
export interface StatesData {
  t: typeof DATA_STATES;
  states: chat.ChatState[];
  /** states are every chat of the machine, and a chat the page has that is
   * not among them is gone; else they are the chats that changed, a chat
   * that is no more in State.Deleted. */
  full: boolean;
  /** The machine is not connected: its states were read when it was. */
  stale?: boolean;
  /** Numbers the machine's states since the hub started: each message has
   * the next number, and a snapshot the number of the last message it
   * holds. A page applies a message only when its rev is above the one it
   * has. */
  rev: number;
  /** The version of the machine's chat host as the watch read it last
   * (left out while none serves); outdated: that is not this hub's build,
   * whose host takes its place only when the user restarts it (POST
   * host/stop), which the page reminds of. */
  hostVersion?: string;
  outdated?: boolean;
}

/** Answers GET /api/p/chat/states: the last states the hub read of each
 * machine's chats, full, by machine id. A machine whose chat host the hub
 * has not read since it started is not there. The states of a machine that
 * is not connected are those it had when it was. */
export interface StatesSnapshot {
  machines: Record<string, StatesData>;
}

/** The time Go writes for none. */
export const ZERO_TIME = '0001-01-01T00:00:00Z';

/** What the hub reads of a chat's state from the host (Op.Watch). */
export const chatState = z.object({
  id: str,
  kind: str,
  title: str,
  cwd: str,
  state: str,
  status: str,
  updated: z
    .string()
    .nullish()
    .transform((v) => v || ZERO_TIME),
  seq: uint,
  seen: uint,
  unread: flag,
  stale: flag,
  sessionId: str,
  archived: flag,
});

/** A chat's state with chatproto's members in their order, those Go leaves
 * out when empty left out. */
export function stateOf(s: z.output<typeof chatState> | chat.ChatState): chat.ChatState {
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    cwd: s.cwd,
    state: s.state,
    status: s.status,
    updated: s.updated,
    seq: s.seq,
    ...(s.seen ? { seen: s.seen } : {}),
    ...(s.unread ? { unread: true } : {}),
    ...(s.stale ? { stale: true } : {}),
    sessionId: s.sessionId,
    ...(s.archived ? { archived: true } : {}),
  };
}
