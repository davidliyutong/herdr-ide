// A coding agent's session resumed in a terminal of its own, in a new tab:
// what continues a chat's session in a terminal (plugins/chat/handoff.ts),
// and the terminals whose agent runs a session.
//
// The terminal is the machine's shell, in the session's directory, which
// stays when the agent exits (its pane can then continue the session in a
// chat again, plugins/agents/ContinueInChat.tsx). Its leaf gets, in the
// same write that places it (term/layout.ts setTerminalFields), the session
// and the request for its agent back (`resume`, restore.ts): once its pane
// is attached, the page types the agent kind's own command that resumes the
// session (conversation/kinds.ts resumeCommand, by its id when the machine
// confirms that session for the terminal's directory, else the directory's
// latest), the way a restore after the terminal core started again does
// (state/terms.ts resumeAgent; docs/features/33). The command is the
// kind's, never text of a document or of a machine; only a session id that
// is a lower-case UUID goes into it. Once the machine detects the agent in
// the terminal, the page adds the agent and its program's pid to the leaf
// and keeps the leaf's session (rememberAgents). Until then the leaf's
// session says which terminal is about to run it (sessionTerminal).
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
  /** Where the shell starts; as a new tab's terminal otherwise
   * (state/terms.ts run). */
  cwd?: string;
}

/** Starts the machine's shell in a new terminal in a new tab of machine m,
 * shows it and gives it the keyboard; its leaf asks for the agent of kind
 * to resume session, which its pane types once attached (restore.ts
 * takeResume). Nothing on a read-only page, or for a kind that does not
 * resume a session by its id or a session that is not a session id.
 * Resolves to the terminal's address, undefined when none started (a
 * failure is said in a toast). */
export async function resumeInTerminal(
  m: string,
  kind: string,
  session: string,
  o: AgentTerminalOptions = {},
): Promise<string | undefined> {
  if (!resumeArgv(kind, session) || useStore.getState().readOnly) return undefined;
  const ws = o.workspace;
  try {
    const address = await terms.run(m, { workspace: ws, cwd: o.cwd }, (l, a) =>
      L.mapTerminals(
        L.setTerminalFields(L.openTerminal(l, a, ws && l.workspaces.some((w) => w.id === ws) ? ws : undefined), a, { session }),
        (leaf) => (leaf.terminal === a ? { ...leaf, resume: kind } : leaf),
      ),
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

/** The live terminal of machine m that runs session, or is on its way
 * to: the one whose agent runs it (as the machine found it: the record's
 * agent_session), else one whose leaf names the session (its `session`)
 * and that runs an agent whose session the machine did not tell yet, or
 * in which no agent was detected since the leaf took the session (a
 * resume asked for or typed, whose agent the machine did not see yet).
 * A leaf whose agent quit keeps the session (to continue it in a chat,
 * plugins/agents/ContinueInChat.tsx), but nothing runs it there: not that
 * one. Undefined when there is none. */
export function sessionTerminal(m: string, session: string): string | undefined {
  if (!session) return undefined;
  const machine = useTerms.getState().machines[m];
  const records = machine?.terminals ?? {};
  for (const r of Object.values(records)) {
    if (isLive(r) && agentOf(r) && r.agent_session === session) return r.address;
  }
  for (const ws of machine?.layout?.workspaces ?? []) {
    for (const tab of ws.tabs) {
      for (const leaf of L.leavesOf(tab.root)) {
        if (!L.isTerminalLeaf(leaf) || leaf.session !== session) continue;
        const r = records[leaf.terminal];
        if (r && isLive(r) && (agentOf(r) || leaf.agent === undefined)) return leaf.terminal;
      }
    }
  }
  return undefined;
}
