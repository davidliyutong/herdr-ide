// Continuing a chat's session in a terminal: the chat host ends the agent's
// headless process (the chat is then handed off, and takes the session up
// again at its next prompt) and a terminal tab, in the chat's workspace
// and directory, resumes the session with the agent's own command
// (agentTerminal.ts: the kind's resumeById, never text of a machine),
// its leaf remembering the session for a restore. The chat pane's menu
// offers it (canContinueInTerminal) while the chat's state, as the page
// has it (state.ts), names an agent that resumes a session by its id and
// a session, and no turn runs. A terminal that already runs the session
// (its record's agent_session) is shown instead of starting another.
import { resumeArgv, sessionTerminal, startAgentTerminal } from '../../agentTerminal';
import { actions } from '../../actions';
import { t } from '../../i18n';
import { useStore } from '../../state/store';
import { terms } from '../../state/terms';
import * as L from '../../term/layout';
import type { PluginView } from '../../term/layout';
import { ChatFailure, chatApi, reasonText } from './api';
import type { ChatState } from './protocol';
import { chatState } from './state';
import { chatRef } from './view';

/** The states and statuses of a chat in which a turn runs (or the chat
 * is no more): no handoff then. */
const BUSY: ReadonlySet<string> = new Set(['starting', 'working', 'waiting', 'deleted', 'blocked']);

/** Whether the chat a pane shows can continue in a terminal now: the page
 * may make changes, and the chat's state names an agent that resumes a
 * session by its id, a session (a session id), and neither a turn that
 * runs (working, or waiting for a permission or a question) nor a start
 * under way. False while the page has no state of the chat. */
export function canContinueInTerminal(m: string, view: PluginView): boolean {
  if (useStore.getState().readOnly) return false;
  const st = chatState(m, chatRef(view).chat);
  return !!st && !!resumeArgv(st.kind, st.sessionId) && !BUSY.has(st.state) && !BUSY.has(st.status);
}

/** The id of the workspace a pane of machine m is in. */
function workspaceOf(m: string, pane: string): string | undefined {
  const layout = terms.layout(m);
  const at = layout ? L.locate(layout, pane) : null;
  return at ? layout?.workspaces[at.workspace]?.id : undefined;
}

/** Codes of a handoff's refusal that leave the session free all the
 * same: the chat has no agent process (sleeping, closed) or was handed
 * off before. One that says a terminal runs the session (in_terminal)
 * shows that terminal when the page has it, and starts no other. */
const FREE = new Set(['sleeping', 'handed_off']);

/** Chats whose handoff is on its way, by machine: a second ask while one
 * is does nothing. */
const pending = new Set<string>();

/** Hands the chat a pane shows over to a terminal and shows a terminal
 * that resumes its session: the one that already runs it, else a new tab
 * of the pane's workspace, in the chat's directory. What the machine
 * says of the chat decides (its kind, its session, its directory); a
 * failure is said in a toast, and no terminal starts unless the host let
 * the session go. */
export async function continueInTerminal(m: string, view: PluginView): Promise<void> {
  const s = useStore.getState();
  const { chat } = chatRef(view);
  if (s.readOnly || !chat) return;
  const key = `${m}\n${chat}`;
  if (pending.has(key)) return;
  pending.add(key);
  const failed = (e: unknown) => s.toast(t('chat.handoff.failed', { error: reasonText(e) }), undefined, undefined, 'error');
  try {
    let info: ChatState | undefined;
    try {
      info = (await chatApi.chats(m)).find((c) => c.id === chat);
    } catch (e) {
      return void failed(e);
    }
    if (!info) return void s.toast(t('chat.handoff.gone'), undefined, undefined, 'warning');
    const argv = resumeArgv(info.kind, info.sessionId);
    if (!argv) return void s.toast(t('chat.handoff.noSession'), undefined, undefined, 'warning');
    let held: unknown;
    try {
      await chatApi.handoff(m, chat);
    } catch (e) {
      if (!(e instanceof ChatFailure && (FREE.has(e.code) || e.code === 'in_terminal'))) return void failed(e);
      if (e.code === 'in_terminal') held = e;
    }
    const running = sessionTerminal(m, info.sessionId);
    if (running) return actions.focusPane(m, running);
    // A terminal the page does not know of runs it: not another.
    if (held) return void failed(held);
    await startAgentTerminal(m, argv, {
      workspace: workspaceOf(m, L.viewKey(view.id)),
      cwd: info.cwd.startsWith('/') ? info.cwd : undefined,
      session: info.sessionId,
    });
  } finally {
    pending.delete(key);
  }
}
