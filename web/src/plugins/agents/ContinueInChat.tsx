// The button in the header of a terminal's pane whose agent ran a session
// and quit: Continue in Chat opens that session as a chat (the chat
// plugin's importSession, plugins/chat/imports.ts) in a new tab beside the
// terminal. It shows while the
// leaf remembers the agent and its session (restore.ts rememberAgents
// keeps them for AGENT_FORGET_MS after the agent quit), the agent's kind
// has chats, the terminal runs and no agent runs in it (two processes
// never write one session), the chat plugin is on and the page may make
// changes. The chat panel's earlier sessions offer the same afterwards.
import { MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { agentKind, chatAdapter, isSessionId } from '../../conversation/kinds';
import { t } from '../../i18n';
import { agentOf } from '../../lib/machine';
import { useStore } from '../../state/store';
import { terms, useTerms } from '../../state/terms';
import type { TerminalLeaf } from '../../term/layout';
import { isLive, type TerminalRecord } from '../../term/protocol';
import type { HeaderActionsComponent } from '../api';
import { importSession } from '../chat/imports';
import { usePluginOn } from '../registry';

/** The agent's kind and session a terminal's pane can continue in a chat:
 * the leaf's, when its kind has chats and the session is a session id,
 * while the terminal runs without an agent; undefined otherwise. */
export function chatTarget(leaf: TerminalLeaf, record: TerminalRecord | undefined): { kind: string; session: string } | undefined {
  if (!record || !isLive(record) || agentOf(record)) return undefined;
  const kind = leaf.agent;
  if (typeof kind !== 'string' || !chatAdapter(kind) || !isSessionId(leaf.session)) return undefined;
  return { kind, session: leaf.session };
}

/** Opens the session a terminal's agent ran as a chat of machine m, in
 * the directory the terminal is in (where the agent ran), in a new tab of
 * the terminal's workspace. */
export function continueInChat(m: string, terminal: string, target: { kind: string; session: string }): Promise<string | undefined> {
  const cwd = terms.directory(m, terminal) ?? useStore.getState().machines[m]?.info?.home ?? '';
  return importSession(m, { ...target, cwd }, terminal);
}

export const ContinueInChat: HeaderActionsComponent = ({ m, terminal, leaf }) => {
  const record = useTerms((s) => s.machines[m]?.terminals[terminal]);
  const readOnly = useStore((s) => s.readOnly);
  const chatOn = usePluginOn('chat');
  const [busy, setBusy] = useState(false);
  const target = chatTarget(leaf, record);
  if (!target || readOnly || !chatOn) return null;
  const label = t('agents.continueInChat');
  return (
    <button
      type="button"
      className="agents-continue"
      aria-label={label}
      title={t('agents.continueInChat.title', { agent: agentKind(target.kind)?.title ?? target.kind })}
      disabled={busy}
      tabIndex={-1}
      onClick={() => {
        setBusy(true);
        void continueInChat(m, terminal, target).finally(() => setBusy(false));
      }}
    >
      <MessagesSquare aria-hidden />
    </button>
  );
};
