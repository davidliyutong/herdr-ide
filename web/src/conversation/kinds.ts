// The kinds of coding agents (backend/shared/agents/kinds.ts), as the core's registry
// gives them to the UI (spec/generated/registry.json, key "agents"):
// how each starts, continues a directory's latest conversation or resumes
// a session, the AI usage provider of its subscription, the format of its
// transcripts, and the adapter the chat host runs it through headless.
// Only a session id that is a lower-case UUID is ever put into a command
// line.
import registry from '../../../spec/generated/registry.json';
import { isSessionId } from '../term/layout';

/** Whether s is a session id as the agents write them: a lower-case UUID
 * (agentkinds.ValidSessionID), the only kind of value of a layout leaf's
 * session. */
export { isSessionId };

export interface AgentKind {
  /** The detector's id ("claude"). */
  id: string;
  /** The agent's name for people ("Claude Code"). */
  title: string;
  /** The AI usage plugin's provider of its subscription. */
  usageProvider?: string;
  /** The argv that starts it; none for an agent the UI does not start. */
  start?: string[];
  /** Appended to start to start it with a session id the caller chose
   * ("{id}"). */
  newSession?: string[];
  /** The command line, as tokens, that continues the directory's latest
   * conversation. */
  continueLatest?: string[];
  /** The command line, as tokens, that resumes a session by its id ("{id}"). */
  resumeById?: string[];
  /** The format of its transcripts, which the machines read; none when
   * they are not read. */
  transcript?: string;
  /** How the chat host runs it headless; none for an agent without chats.
   * Its command stays on the machine's side. */
  chat?: { adapter: ChatAdapter };
}

/** The chat host's adapters (agentkinds.Adapters): Claude Code's SDK
 * protocol, Codex's app-server, the Agent Client Protocol. */
export const CHAT_ADAPTERS = ['claude', 'codex', 'acp'] as const;
export type ChatAdapter = (typeof CHAT_ADAPTERS)[number];

/** Stands for a session id in a command line's tokens. */
export const PLACEHOLDER = '{id}';

/** Every kind, in the order the UI offers them. */
export const AGENT_KINDS: readonly AgentKind[] = registry.agents as AgentKind[];

const byId = new Map(AGENT_KINDS.map((k) => [k.id, k]));

/** The kind of a detector's id. */
export function agentKind(id: string | undefined): AgentKind | undefined {
  return id === undefined ? undefined : byId.get(id);
}

/** The adapter the chat host runs the agent through; undefined for an
 * agent without chats (or one of an adapter this version does not know). */
export function chatAdapter(id: string | undefined): ChatAdapter | undefined {
  const a = agentKind(id)?.chat?.adapter;
  return a && (CHAT_ADAPTERS as readonly string[]).includes(a) ? a : undefined;
}

/** The kinds the chat host runs, in the order the UI offers them. */
export function chatKinds(): AgentKind[] {
  return AGENT_KINDS.filter((k) => chatAdapter(k.id) !== undefined);
}

/** The AI usage plugin's provider of the agent's subscription. */
export function usageProvider(id: string | undefined): string | undefined {
  return agentKind(id)?.usageProvider || undefined;
}

/** Tokens with each placeholder replaced by session; undefined when they
 * hold one and session is not a session id. */
function fill(tokens: readonly string[], session: string | undefined): string[] | undefined {
  const out: string[] = [];
  for (const tok of tokens) {
    if (!tok.includes(PLACEHOLDER)) out.push(tok);
    else if (isSessionId(session)) out.push(tok.split(PLACEHOLDER).join(session));
    else return undefined;
  }
  return out;
}

/** The command line, as typed into a shell, that brings the agent's
 * conversation back: the session's by its id when session is a session id
 * and the agent resumes by id, else the directory's latest; undefined when
 * the agent has neither. */
export function resumeCommand(id: string | undefined, session?: string): string | undefined {
  const k = agentKind(id);
  if (!k) return undefined;
  const byId = k.resumeById?.length && isSessionId(session) ? fill(k.resumeById, session) : undefined;
  const tokens = byId ?? (k.continueLatest?.length ? fill(k.continueLatest, undefined) : undefined);
  return tokens?.join(' ');
}

/** The argv that starts the agent: with session when it is a session id
 * and the agent takes one (newSession); undefined for an agent the UI does
 * not start. */
export function startArgv(id: string | undefined, session?: string): string[] | undefined {
  const k = agentKind(id);
  if (!k?.start?.length) return undefined;
  const extra = k.newSession?.length && isSessionId(session) ? fill(k.newSession, session) : undefined;
  return [...k.start, ...(extra ?? [])];
}
