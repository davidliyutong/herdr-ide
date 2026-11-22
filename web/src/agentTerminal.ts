// Coding agents as the program of a terminal of their own, in a new tab:
// what continues a chat's session in a terminal (plugins/chat/handoff.ts),
// and the terminals whose agent runs a session.
//
// The argv is the agent kind's (conversation/kinds.ts), never text of a
// document or of a machine; only a session id that is a lower-case UUID
// goes into it. The terminal's leaf gets the session in the same write
// that places it (term/layout.ts setTerminalFields), so that a restore
// after the terminal core started again resumes that session
// (restore.ts): once the machine detects the agent in the terminal, the
// page adds the agent and its program's pid to the leaf and keeps the
// leaf's session (rememberAgents). The leaf never names the agent before
// that: a leaf with an agent but not the pid of the program it ran in
// reads as one whose program is gone, and a restore would type the
// agent's command into the agent itself.
import { agentKind, isSessionId, PLACEHOLDER } from './conversation/kinds';
import { agentOf } from './lib/machine';
import { withView } from './state/panes';
import { useStore } from './state/store';
import { terms, useTerms } from './state/terms';
import * as L from './term/layout';
import { isLive } from './term/protocol';

/** The argv that resumes a session of an agent kind by its id (the
 * kind's resumeById with the session in place of "{id}"); undefined when
 * the kind resumes none by its id or session is not a session id. */
export function resumeArgv(kind: string | undefined, session: string | undefined): string[] | undefined {
  const tokens = agentKind(kind)?.resumeById;
  if (!tokens?.length || !isSessionId(session)) return undefined;
  return tokens.map((tok) => tok.split(PLACEHOLDER).join(session));
}

export interface AgentTerminalOptions {
  /** The workspace of the new tab (the selected one by default, or when
   * it is gone). */
  workspace?: string;
  /** Where the agent starts; as a new tab's terminal otherwise
   * (state/terms.ts run). */
  cwd?: string;
  /** The session the agent starts with or resumes, which the leaf
   * remembers: taken only when it is a session id. */
  session?: string;
}

/** Starts a coding agent (argv) as the program of a new terminal in a new
 * tab of machine m, shows it and gives it the keyboard; its leaf gets the
 * session in the same write that places it. Nothing on a read-only page.
 * Resolves to the terminal's address, undefined when none started (a
 * failure is said in a toast). */
export async function startAgentTerminal(m: string, argv: readonly string[], o: AgentTerminalOptions = {}): Promise<string | undefined> {
  if (!argv.length || useStore.getState().readOnly) return undefined;
  const ws = o.workspace;
  const fields = isSessionId(o.session) ? { session: o.session } : {};
  try {
    const address = await terms.run(m, { workspace: ws, argv: [...argv], cwd: o.cwd }, (l, a) =>
      L.setTerminalFields(L.openTerminal(l, a, ws && l.workspaces.some((w) => w.id === ws) ? ws : undefined), a, fields),
    );
    if (address) {
      useStore.getState().selectMachine(m);
      withView(m, address, (h) => h.focus());
    }
    return address;
  } catch (e) {
    console.warn(e);
    useStore.getState().toast(e instanceof Error ? e.message : String(e), undefined, undefined, 'error');
    return undefined;
  }
}

/** The live terminal of machine m whose agent runs session (as the
 * machine found it: the record's agent_session), if any. */
export function sessionTerminal(m: string, session: string): string | undefined {
  if (!session) return undefined;
  for (const r of Object.values(useTerms.getState().machines[m]?.terminals ?? {})) {
    if (isLive(r) && agentOf(r) && r.agent_session === session) return r.address;
  }
  return undefined;
}
