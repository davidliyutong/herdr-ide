// An agent's session opened as a chat, which the machine's chat host
// resumes and whose earlier conversation it brings into the chat (an
// import): from the chat panel's list of a directory's sessions
// (Sessions.tsx) and from the header of a terminal whose agent ran it (the
// agents plugin's ContinueInChat.tsx). What a machine answers is read by
// api.ts, member by member.
//
// Two processes never write one session: a session that a terminal's
// agent runs (its record's agent_session) is not imported, and the toast
// that says so names that terminal and shows it; the chat host refuses
// such a session too (in_terminal), and a session that is already a
// chat's shows that chat.
import { actions, terminalPlace } from '../../actions';
import { sessionTerminal } from '../../agentTerminal';
import { chatAdapter } from '../../conversation/kinds';
import { t } from '../../i18n';
import { useStore } from '../../state/store';
import { ChatFailure, chatApi, reasonText } from './api';
import { openChat } from './ops';
import type { Session } from './protocol';
import { upsertState } from './state';

/** The most sessions of a kind kept from all the pages of its list. */
export const MAX_SESSIONS = 1000;

/** The chat kinds the chat host of machine m can start now, in the order
 * it answered: those it says are available and that are a kind this page
 * knows the chat adapter of. */
export async function chatAgents(m: string): Promise<string[]> {
  const out: string[] = [];
  for (const a of await chatApi.agents(m)) if (a.available && chatAdapter(a.kind) && !out.includes(a.kind)) out.push(a.kind);
  return out;
}

/** A session an agent kept for a directory, as the page lists it. */
export interface PastSession {
  sessionId: string;
  cwd: string;
  title?: string;
  /** Milliseconds since the epoch. */
  updated?: number;
  /** The chat that has it. */
  chat?: string;
}

function pastSession(s: Session, cwd: string): PastSession {
  const out: PastSession = { sessionId: s.sessionId, cwd: s.cwd || cwd };
  if (s.title) out.title = s.title;
  const updated = s.updatedAt ? Date.parse(s.updatedAt) : NaN;
  if (Number.isFinite(updated) && updated > 0) out.updated = updated;
  if (s.chat) out.chat = s.chat;
  return out;
}

/** A page of the sessions the agent of kind kept for the directory cwd on
 * machine m, from cursor (the page before's next); next is undefined on
 * the last page. A session without an absolute directory is the listed
 * one's. */
export async function chatSessions(
  m: string,
  kind: string,
  cwd: string,
  cursor?: string,
): Promise<{ sessions: PastSession[]; next?: string }> {
  const page = await chatApi.sessions(m, kind, cwd, cursor);
  const sessions = page.sessions.map((s) => pastSession(s, cwd));
  return page.nextCursor ? { sessions, next: page.nextCursor } : { sessions };
}

/** Imports under way, by machine and session: a second ask while one is
 * on its way does nothing. */
const importing = new Set<string>();

/** What an import opens: the session of an agent's kind and the directory
 * it ran in, and the chat that has it already, if any. */
export interface ImportTarget {
  kind: string;
  session: string;
  cwd: string;
  chat?: string;
}

/** Opens an agent's session as a chat of machine m and shows the chat
 * (openChat, from from): the chat that has it already (a read-only page
 * too), else a new one the host resumes the session in and imports its
 * conversation into. Refused, with a toast that says why, while a
 * terminal's agent runs the session (the toast names it and shows it);
 * nothing on a read-only page or for a kind without chats. Resolves to
 * the chat's id, undefined when there is none (a failure is said in a
 * toast). */
export async function importSession(m: string, target: ImportTarget, from?: string): Promise<string | undefined> {
  const { kind, session, cwd } = target;
  const s = useStore.getState();
  if (!chatAdapter(kind) || !session) return undefined;
  if (target.chat) {
    await openChat(m, target.chat, kind, from);
    return target.chat;
  }
  if (s.readOnly) return undefined;
  const busy = sessionTerminal(m, session);
  if (busy) {
    const place = terminalPlace(m, busy);
    s.toast(
      place ? t('chat.import.inTerminal', { place }) : t('chat.import.inTerminalElsewhere'),
      { label: t('chat.import.show'), run: () => actions.focusPane(m, busy) },
      undefined,
      'warning',
    );
    return undefined;
  }
  const key = `${m}\n${session}`;
  if (importing.has(key) || !cwd.startsWith('/')) return undefined;
  importing.add(key);
  try {
    const chat = await chatApi.newChat(m, { kind, cwd, resume: session, import: true });
    upsertState(m, chat);
    await openChat(m, chat.id, kind, from);
    return chat.id;
  } catch (e) {
    const inTerminal = e instanceof ChatFailure && e.code === 'in_terminal';
    s.toast(
      inTerminal ? t('chat.import.inTerminalElsewhere') : t('chat.import.failed', { error: reasonText(e) }),
      undefined,
      undefined,
      inTerminal ? 'warning' : 'error',
    );
    return undefined;
  } finally {
    importing.delete(key);
  }
}
