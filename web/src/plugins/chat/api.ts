// The chat plugin's requests to the core (backend/features/chat), the
// page's one module of them (the agents plugin's part in chats uses it
// too): a machine's agents, chats and sessions, and the changes (a new
// chat, an agent's session imported, closing, deleting, seen, handing a
// chat over to a terminal, trusting a folder and taking that back). A GET
// never starts the machine's chat host (not_running while none serves);
// the changes do, and so do the POSTs that list the agents (startAgents)
// and the sessions (listing them may run the agent). Each answer is read
// member by member: what a machine sent is not trusted to have the
// protocol's shapes (protocol.ts), and lists are cut to their bounds.
import { hasMessage, t, type MessageKey } from '../../i18n';
import { answer, failureOf, jsonInit, makeErrorText, PluginError } from '../../lib/pluginApi';
import { builtinDefaults } from '../../settings';
import {
  MODES,
  STATES_PATH,
  isChatId,
  type AgentStatus,
  type ChatHostOverview,
  type ChatHostSession,
  type ChatState,
  type HostSettings,
  type Options,
  type Session,
  type TrustedFolder,
} from './protocol';

/** A failure with the core's or the chat host's code (chatproto's codes,
 * read_only, offline, …), or network when the core did not answer. */
export class ChatFailure extends PluginError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'ChatFailure';
  }
}

const failure = failureOf((code, message) => new ChatFailure(code, message));

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (e) {
    throw new ChatFailure('network', e instanceof Error ? e.message : String(e));
  }
  return answer<T>(r, failure);
}

const base = (m: string) => `/api/m/${encodeURIComponent(m)}/p/chat`;
const query = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** The most of each list read from an answer: a page of sessions at most
 * MAX_SESSION_PAGE. */
export const MAX_AGENTS = 64;
export const MAX_CHATS = 2000;
export const MAX_SESSION_PAGE = 200;
/** The most characters of a title, and of a path, kept; the longest
 * session id taken. */
const MAX_TITLE = 500;
const MAX_PATH = 4096;
const MAX_SESSION_ID = 256;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = MAX_TITLE): string => (typeof v === 'string' ? v.slice(0, max) : '');
const seq = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** An agent's status, read; undefined for what is none. */
export function readAgent(v: unknown): AgentStatus | undefined {
  if (!isObject(v) || typeof v.kind !== 'string' || !v.kind) return undefined;
  const out: AgentStatus = { kind: v.kind.slice(0, 64), available: v.available === true };
  if (typeof v.version === 'string' && v.version) out.version = v.version.slice(0, 100);
  if (typeof v.reason === 'string' && v.reason) out.reason = v.reason.slice(0, 64);
  return out;
}

/** What the host tells of a chat (a ChatState, or a Chat's members of
 * one), read; undefined without a chat id in the host's form. */
export function readState(v: unknown): ChatState | undefined {
  if (!isObject(v) || !isChatId(v.id)) return undefined;
  const out: ChatState = {
    id: v.id,
    kind: str(v.kind, 64),
    title: str(v.title),
    cwd: str(v.cwd, MAX_PATH),
    state: str(v.state, 32),
    status: str(v.status, 32),
    updated: str(v.updated, 64),
    seq: seq(v.seq),
    sessionId: str(v.sessionId, 200),
  };
  if (typeof v.seen === 'number' && Number.isSafeInteger(v.seen) && v.seen >= 0) out.seen = v.seen;
  if (v.unread === true) out.unread = true;
  if (v.stale === true) out.stale = true;
  if (v.archived === true || (typeof v.archived === 'string' && v.archived !== '')) out.archived = true;
  return out;
}

const optInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

/** A trusted folder entry, read; undefined for invalid entries. */
export function readTrustedFolder(v: unknown): TrustedFolder | undefined {
  if (!isObject(v)) return undefined;
  const cwd = plain(v.cwd, MAX_PATH);
  if (!cwd?.startsWith('/')) return undefined;
  return { cwd, at: str(v.at, 64) };
}

/** A session on a headless chat host, read; undefined without a valid chat id. */
export function readHostSession(v: unknown): ChatHostSession | undefined {
  if (!isObject(v) || !isChatId(v.chat)) return undefined;
  const out: ChatHostSession = {
    chat: v.chat,
    kind: str(v.kind, 64),
    title: str(v.title),
    cwd: str(v.cwd, MAX_PATH),
    sessionId: str(v.sessionId, MAX_SESSION_ID),
    state: str(v.state, 32),
    status: str(v.status, 32),
    updated: str(v.updated, 64),
    bytes: seq(v.bytes),
  };
  const pid = optInt(v.pid);
  if (pid !== undefined) out.pid = pid;
  if (v.starting === true) out.starting = true;
  if (typeof v.idleSince === 'string' && v.idleSince) out.idleSince = v.idleSince.slice(0, 64);
  if (typeof v.agentVersion === 'string' && v.agentVersion) out.agentVersion = v.agentVersion.slice(0, 100);
  return out;
}

/** A machine's headless chat host overview, read; undefined without a machine id. */
export function readHostOverview(v: unknown): ChatHostOverview | undefined {
  if (!isObject(v) || typeof v.machine !== 'string' || !v.machine) return undefined;
  const status =
    v.status === 'running' || v.status === 'stopped' || v.status === 'offline' || v.status === 'error'
      ? v.status
      : v.running === true
        ? 'running'
        : 'stopped';
  const out: ChatHostOverview = {
    machine: v.machine.slice(0, 128),
    label: str(v.label, 200) || v.machine.slice(0, 128),
    machineStatus: str(v.machineStatus, 32),
    running: v.running === true,
    status,
    totalChats: seq(v.totalChats),
    sessions: list(v.sessions, MAX_CHATS, readHostSession),
  };
  for (const k of ['pid', 'proto', 'conns', 'watchers', 'liveAgents', 'totalBytes', 'ending'] as const) {
    const n = optInt(v[k]);
    if (n !== undefined) out[k] = n;
  }
  if (typeof v.version === 'string' && v.version) out.version = v.version.slice(0, 100);
  if (typeof v.terminalId === 'string' && v.terminalId) out.terminalId = v.terminalId.slice(0, 200);
  if (typeof v.startedAt === 'string' && v.startedAt) out.startedAt = v.startedAt.slice(0, 64);
  if (typeof v.socket === 'string' && v.socket) out.socket = v.socket.slice(0, MAX_PATH);
  if (typeof v.base === 'string' && v.base) out.base = v.base.slice(0, MAX_PATH);
  if (typeof v.error === 'string' && v.error) out.error = v.error.slice(0, 64);
  if (typeof v.message === 'string' && v.message) out.message = v.message.slice(0, 500);
  if (isObject(v.settings)) out.settings = v.settings as HostSettings;
  return out;
}

/** A string of at most max characters without control characters;
 * undefined for anything else. */
const plain = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : undefined;

/** A session an agent kept, read: an id without control characters, an
 * absolute directory (else none: ''), a title on one line. */
export function readSession(v: unknown): Session | undefined {
  if (!isObject(v)) return undefined;
  const sessionId = plain(v.sessionId, MAX_SESSION_ID);
  if (!sessionId) return undefined;
  const cwd = plain(v.cwd, MAX_PATH);
  const out: Session = { sessionId, cwd: cwd?.startsWith('/') ? cwd : '' };
  const title = typeof v.title === 'string' ? v.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '';
  if (title) out.title = title;
  if (typeof v.updatedAt === 'string' && v.updatedAt) out.updatedAt = v.updatedAt.slice(0, 64);
  if (isChatId(v.chat)) out.chat = v.chat;
  return out;
}

const list = <T>(v: unknown, max: number, read: (x: unknown) => T | undefined): T[] =>
  Array.isArray(v) ? v.slice(0, max).flatMap((x) => read(x) ?? []) : [];

/** A machine's states as the core sends them (StatesData), read;
 * undefined for what is none. */
export interface States {
  states: ChatState[];
  full: boolean;
  rev: number;
  stale?: boolean;
  /** The chat host's version as the core read it last ("" for none), and
   * whether it is another build than the core's. */
  hostVersion: string;
  outdated: boolean;
}
export function readStates(v: unknown): States | undefined {
  if (!isObject(v) || v.t !== 'states' || !Array.isArray(v.states)) return undefined;
  // Deleted chats come too: room for them beyond the host's bound.
  const out: States = {
    states: list(v.states, MAX_CHATS + 1000, readState),
    full: v.full === true,
    rev: seq(v.rev),
    hostVersion: str(v.hostVersion, 128),
    outdated: v.outdated === true,
  };
  if (v.stale === true) out.stale = true;
  return out;
}

/** The most machines read from a snapshot. */
const MAX_MACHINES = 1000;

/** What a new chat is: its kind, its directory (absolute), the session it
 * takes up and whether that session's conversation comes with it. */
export interface NewChat {
  kind: string;
  cwd: string;
  resume?: string;
  import?: boolean;
  options?: Options;
}

export const chatApi = {
  /** Every machine's states as the core last read them (StatesSnapshot). */
  async states(): Promise<Record<string, States>> {
    const r = await send<{ machines?: unknown }>(STATES_PATH, { cache: 'no-store' });
    const out: Record<string, States> = {};
    if (!isObject(r.machines)) return out;
    for (const [m, v] of Object.entries(r.machines).slice(0, MAX_MACHINES)) {
      const st = readStates(v);
      if (st) out[m] = { ...st, full: true };
    }
    return out;
  },
  /** Which chat kinds the machine can start, from a chat host that serves
   * (not_running otherwise; read_only on a read-only page). */
  agents: async (m: string): Promise<AgentStatus[]> =>
    list((await send<{ agents?: unknown }>(`${base(m)}/agents`, { cache: 'no-store' })).agents, MAX_AGENTS, readAgent),
  /** The same, starting the machine's chat host when none serves (a
   * change: not on a read-only page). */
  startAgents: async (m: string): Promise<AgentStatus[]> =>
    list((await send<{ agents?: unknown }>(`${base(m)}/agents`, { method: 'POST' })).agents, MAX_AGENTS, readAgent),
  /** The machine's chats, closed ones included, the latest first, from a
   * chat host that serves (not_running otherwise). */
  chats: async (m: string): Promise<ChatState[]> =>
    list((await send<{ chats?: unknown }>(`${base(m)}/chats`, { cache: 'no-store' })).chats, MAX_CHATS, readState),
  /** A page of the sessions an agent kept for a directory, each once;
   * nextCursor asks for the next ('' after the last). A change, as listing
   * them may run the agent: it starts the machine's chat host when none
   * serves, and a read-only page has none. */
  async sessions(m: string, kind: string, cwd: string, cursor = ''): Promise<{ sessions: Session[]; nextCursor: string }> {
    const q: Record<string, string> = { kind, cwd };
    if (cursor) q.cursor = cursor;
    const r = await send<{ sessions?: unknown; nextCursor?: unknown }>(`${base(m)}/sessions?${query(q)}`, { method: 'POST' });
    const seen = new Set<string>();
    const sessions = list(r.sessions, MAX_SESSION_PAGE, readSession).filter((s) => {
      if (seen.has(s.sessionId)) return false;
      seen.add(s.sessionId);
      return true;
    });
    return { sessions, nextCursor: plain(r.nextCursor, 4096) ?? '' };
  },
  /** Makes a chat; resolves to its state as the host made it. */
  async newChat(m: string, body: NewChat): Promise<ChatState> {
    const r = await send<{ chat?: unknown }>(`${base(m)}/new`, jsonInit('POST', body));
    const chat = readState(r.chat);
    if (!chat) throw new ChatFailure('protocol', 'no chat in the answer');
    return chat;
  },
  /** Ends a chat's agent; the chat stays, closed. */
  close: (m: string, chat: string) => send<unknown>(`${base(m)}/close?${query({ chat })}`, { method: 'POST' }).then(() => {}),
  /** Forgets a chat and its log. */
  remove: (m: string, chat: string) => send<unknown>(`${base(m)}/chat?${query({ chat })}`, { method: 'DELETE' }).then(() => {}),
  /** Archives a chat: its agent ends, and the chat is kept with its log
   * until the machine's chat limits remove it. */
  archive: (m: string, chat: string) => send<unknown>(`${base(m)}/archive?${query({ chat })}`, { method: 'POST' }).then(() => {}),
  /** Takes an archived chat back. */
  unarchive: (m: string, chat: string) => send<unknown>(`${base(m)}/unarchive?${query({ chat })}`, { method: 'POST' }).then(() => {}),
  /** The user saw the chat up to seq. */
  seen: (m: string, chat: string, at: number) =>
    send<unknown>(`${base(m)}/seen?${query({ chat, seq: String(at) })}`, { method: 'POST' }).then(() => {}),
  /** Ends the chat's agent so that its session goes on in a terminal. */
  handoff: (m: string, chat: string) => send<unknown>(`${base(m)}/handoff?${query({ chat })}`, { method: 'POST' }).then(() => {}),
  /** Lets the agents started in a directory, and those below it, load
   * its own project settings. */
  trust: (m: string, cwd: string) => send<unknown>(`${base(m)}/trust?${query({ cwd })}`, { method: 'POST' }).then(() => {}),
  /** Takes back the trust that covers a directory: its own and that of
   * the directories above it. */
  untrust: (m: string, cwd: string) => send<unknown>(`${base(m)}/untrust?${query({ cwd })}`, { method: 'POST' }).then(() => {}),
  /** Lists trusted folders from a running host without starting one. */
  trusted: async (m: string): Promise<TrustedFolder[]> =>
    list((await send<{ trusted?: unknown }>(`${base(m)}/trusted`, { cache: 'no-store' })).trusted, MAX_CHATS, readTrustedFolder),
  /** Lists persisted trusted folders, starting the host if not running. */
  startTrusted: async (m: string): Promise<TrustedFolder[]> =>
    list((await send<{ trusted?: unknown }>(`${base(m)}/trusted`, { method: 'POST' })).trusted, MAX_CHATS, readTrustedFolder),
  /** Overview of headless chat hosts and sessions across all machines. */
  hosts: async (): Promise<ChatHostOverview[]> =>
    list((await send<{ hosts?: unknown }>('/api/p/chat/hosts', { cache: 'no-store' })).hosts, MAX_MACHINES, readHostOverview),
  /** Stops a machine's headless chat host cleanly (refused with busy while
   * any chat is working, waiting or starting). */
  stopHost: (m: string) => send<unknown>(`${base(m)}/host/stop`, { method: 'POST' }).then(() => {}),
};

type Values = Record<string, { value?: unknown; machines?: Record<string, unknown> } | undefined>;

/** A setting's value for machine m: its own, else the app's, else the
 * built-in default. */
const valueFor = (values: Values, key: string, m: string): unknown =>
  values[key]?.machines?.[m] ?? values[key]?.value ?? builtinDefaults[key];

/** Whether machine m's chats may give an agent full access: its setting
 * chat.allowFullAccess (off by default). */
export const fullAccessAllowed = (values: Values, m: string): boolean => valueFor(values, 'chat.allowFullAccess', m) === true;

/** The permission mode a new chat on machine m asks for: the setting
 * chat.permissionMode (one of MODES); none for full access while the
 * machine's chat.allowFullAccess is not on, which leaves the mode to the
 * chat host (it starts no agent with full access then). */
export function permissionMode(values: Values, m: string): string | undefined {
  const v = valueFor(values, 'chat.permissionMode', m);
  const mode = typeof v === 'string' && (MODES as readonly string[]).includes(v) ? v : 'default';
  return mode === 'full' && !fullAccessAllowed(values, m) ? undefined : mode;
}

/** A failure as the user reads it within a sentence ("… could not be
 * opened: <reason>"): the phrase of its code (chat.reason.<code>), else
 * its message. */
export const reasonText = makeErrorText(ChatFailure, 'chat.reason');

/** A failure as the user reads it: the conversation's text of its code
 * (conversation.error.<code>), the plugin's (chat.error.<code>), else
 * fallback; each with the agent's name. */
export function failureText(e: unknown, agent: string, fallback: MessageKey): string {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  if (typeof code === 'string') {
    for (const k of [`conversation.error.${code}`, `chat.error.${code}`]) if (hasMessage(k)) return t(k as MessageKey, { agent });
  }
  return t(fallback, { agent });
}
