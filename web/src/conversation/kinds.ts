// The kinds of coding agents (internal/agentkinds), as the core's registry
// gives them to the UI (design/generated/registry.json, key "agents"):
// how each starts, continues a directory's latest conversation or resumes
// a session, the AI usage provider of its subscription, and whether its
// conversations have a native view. Only a session id that is a lower-case
// UUID is ever put into a command line.
import registry from '../../../design/generated/registry.json';
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
  /** The parser of its transcripts; none without a native view. */
  transcript?: string;
}

/** Stands for a session id in a command line's tokens. */
export const PLACEHOLDER = '{id}';

/** Every kind, in the order the UI offers them. */
export const AGENT_KINDS: readonly AgentKind[] = registry.agents as AgentKind[];

const byId = new Map(AGENT_KINDS.map((k) => [k.id, k]));

/** The kind of a detector's id. */
export function agentKind(id: string | undefined): AgentKind | undefined {
  return id === undefined ? undefined : byId.get(id);
}

/** Whether the agent's conversations can be shown as a native view. */
export function hasNativeView(id: string | undefined): boolean {
  return !!agentKind(id)?.transcript;
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
