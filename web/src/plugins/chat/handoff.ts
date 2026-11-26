// Continuing a chat's session in a terminal: the chat host ends the agent's
// headless process (the chat is then handed off, and takes the session up
// again at its next prompt) and a terminal tab, in the chat's workspace
// and directory, runs the machine's shell, into which the page types the
// agent's own command that resumes the session (agentTerminal.ts: the
// kind's, never text of a machine), as a restore does; its leaf remembers
// the session, and the shell stays when the agent exits, where the session
// can continue in a chat again. The chat pane's menu offers it
// (canContinueInTerminal) while the chat's state, as the page has it
// (state.ts), names an agent that resumes a session by its id and a
// session, and no turn runs. A terminal that already runs the session, or
// is about to (agentTerminal.ts sessionTerminal: its record's
// agent_session, or its leaf's session), is shown instead of starting
// another; a handoff stays under way until the machine detects an agent in
// the terminal it started, or HANDOFF_SETTLE_MS pass, so that asking again
// meanwhile starts no second one.
import { resumeArgv, resumeInTerminal, sessionTerminal } from '../../agentTerminal';
import { actions } from '../../actions';
import { t } from '../../i18n';
import { agentOf } from '../../lib/machine';
import { useStore } from '../../state/store';
import { terms, useTerms } from '../../state/terms';
import * as L from '../../term/layout';
import type { PluginView } from '../../term/layout';
import { isLive } from '../../term/protocol';
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

/** How long a handoff stays under way, at most, after its terminal
 * started while the machine detects no agent in it. */
export const HANDOFF_SETTLE_MS = 15_000;

/** Keeps the handoff key under way until the machine detects an agent in
 * terminal address of machine m, the terminal ends or goes, or
 * HANDOFF_SETTLE_MS pass. */
function settleHandoff(m: string, address: string, key: string): void {
  let seen = false;
  let over = false;
  let unsubscribe = () => {};
  const end = () => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    unsubscribe();
    pending.delete(key);
  };
  const timer = setTimeout(end, HANDOFF_SETTLE_MS);
  const check = () => {
    const r = useTerms.getState().machines[m]?.terminals[address];
    if (r) seen = true;
    if (r ? !isLive(r) || !!agentOf(r) : seen) end();
  };
  unsubscribe = useTerms.subscribe(check);
  check();
}

/** Hands the chat a pane shows over to a terminal and shows a terminal
 * that resumes its session: the one that already runs it, else a new tab
 * of the pane's workspace, in the chat's directory. What the machine
 * says of the chat decides (its kind, its session, its directory: its
 * chat host's list, else, while no host serves, the states the hub read
 * of it); a failure is said in a toast, and no terminal starts unless the
 * host let the session go. */
export async function continueInTerminal(m: string, view: PluginView): Promise<void> {
  const s = useStore.getState();
  const { chat } = chatRef(view);
  if (s.readOnly || !chat) return;
  const key = `${m}\n${chat}`;
  if (pending.has(key)) return;
  pending.add(key);
  let settling = false;
  const failed = (e: unknown) => s.toast(t('chat.handoff.failed', { error: reasonText(e) }), undefined, undefined, 'error');
  try {
    let info: ChatState | undefined;
    try {
      info = (await chatApi.chats(m)).find((c) => c.id === chat);
    } catch (e) {
      // No chat host serves (a GET starts none): no agent runs the chat.
      if (!(e instanceof ChatFailure && e.code === 'not_running')) return void failed(e);
      info = chatState(m, chat);
    }
    if (!info) return void s.toast(t('chat.handoff.gone'), undefined, undefined, 'warning');
    if (!resumeArgv(info.kind, info.sessionId)) return void s.toast(t('chat.handoff.noSession'), undefined, undefined, 'warning');
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
    const address = await resumeInTerminal(m, info.kind, info.sessionId, {
      workspace: workspaceOf(m, L.viewKey(view.id)),
      cwd: info.cwd.startsWith('/') ? info.cwd : undefined,
    });
    if (address) {
      settling = true;
      settleHandoff(m, address, key);
    }
  } finally {
    if (!settling) pending.delete(key);
  }
}
