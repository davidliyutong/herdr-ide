// The right sidebar's Chats panel: the chats of the machine shown, those
// that need the user first (blocked, then done), then those working, then
// the others, the latest first; a click shows the chat (its pane, else a
// new tab), and each can be closed or deleted. A new chat starts from its
// header. Below the chats, the agents' earlier sessions of the focused
// pane's directory, which open as chats (Sessions.tsx).
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { CirclePower, Plus, Trash2 } from 'lucide-react';
import { openMenu } from '../../contextMenu';
import { relativeTime } from '../../conversation/format';
import { locale, t } from '../../i18n';
import { shortPath, statusRank, type AgentStatus } from '../../lib/machine';
import { useStore } from '../../state/store';
import { agentName, closeChat, deleteChat, kindIcon, kindsMenu, openChat } from './ops';
import { CHAT_STATUSES, type ChatState } from './protocol';
import { PastSessions } from './Sessions';
import { follow, loadAgents, useChats } from './state';
import { stateLabel } from './ChatPane';
import './chat.css';

/** How many chats the panel lists at first, and how many more each
 * "Show more" adds. */
export const SHOWN_CHATS = 50;

const rank = (st: ChatState): number =>
  (CHAT_STATUSES as readonly string[]).includes(st.status) ? statusRank[st.status as AgentStatus] : 0;

/** A machine's chats in the panel's order: blocked, done, working, then
 * the rest; the latest first within each. */
export function panelOrder(list: readonly ChatState[]): ChatState[] {
  const attention = (st: ChatState) => (st.status === 'blocked' || st.status === 'done' || st.status === 'working' ? rank(st) : 0);
  return [...list].sort((a, b) => attention(b) - attention(a) || b.updated.localeCompare(a.updated));
}

const EMPTY: Record<string, ChatState> = {};

export function ChatsPanel() {
  const m = useStore((s) => s.machineId);
  const ready = useStore((s) => (m ? s.machines[m]?.status === 'ready' : false));
  const readOnly = useStore((s) => s.readOnly);
  const home = useStore((s) => (m ? s.machines[m]?.info?.home : undefined));
  const states = useChats((s) => (m ? (s.states[m] ?? EMPTY) : EMPTY));
  const known = useChats((s) => (m ? !!s.full[m] : false));
  useChats((s) => (m ? s.agents[m] : undefined));
  const [shown, setShown] = useState(SHOWN_CHATS);
  useEffect(() => follow(), []);
  useEffect(() => {
    setShown(SHOWN_CHATS);
    if (m && ready) void loadAgents(m);
  }, [m, ready]);
  const list = useMemo(() => panelOrder(Object.values(states)), [states]);
  if (!m) return <div className="chat-panel-empty muted small">{t('chat.panel.noMachine')}</div>;

  const newMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu({ clientX: r.left, clientY: r.bottom, preventDefault() {}, stopPropagation() {} }, kindsMenu(m));
  };
  const now = Date.now();

  return (
    <div className="chat-panel">
      <div className="chat-panel-toolbar">
        <span className="chat-panel-title ellipsis">{t('chat.panel.chats')}</span>
        <span className="spacer" />
        {!readOnly && ready && (
          <button type="button" className="icon" aria-label={t('chat.new')} title={t('chat.new')} onClick={newMenu}>
            <Plus />
          </button>
        )}
      </div>
      {!ready && <div className="chat-panel-empty muted small">{t('chat.panel.offline')}</div>}
      {ready && known && !list.length && <div className="chat-panel-empty muted small">{t('chat.panel.none')}</div>}
      {list.length > 0 && (
        <div className="chat-rows" role="list" aria-label={t('chat.panel.chats')}>
          {list.slice(0, shown).map((st) => (
            <ChatRow key={st.id} m={m} st={st} home={home} now={now} readOnly={readOnly} />
          ))}
          {list.length > shown && (
            <button type="button" className="ghost sm chat-more" onClick={() => setShown((n) => n + SHOWN_CHATS)}>
              {t('chat.panel.more', { n: list.length - shown })}
            </button>
          )}
        </div>
      )}
      {ready && <PastSessions m={m} />}
    </div>
  );
}

function ChatRow({ m, st, home, now, readOnly }: { m: string; st: ChatState; home?: string; now: number; readOnly: boolean }) {
  const agent = agentName(st.kind);
  const Icon = kindIcon(st.kind);
  const updated = Date.parse(st.updated);
  const when = Number.isFinite(updated) ? relativeTime(updated / 1000, now, locale) : '';
  const status = (CHAT_STATUSES as readonly string[]).includes(st.status) ? st.status : 'idle';
  const label = stateLabel(st.state);
  const title = st.title || agent;
  return (
    <div className="chat-row" role="listitem" data-status={status} data-state={st.state}>
      <button
        type="button"
        className="chat-row-main"
        title={[title, st.cwd, label].filter(Boolean).join(' · ')}
        onClick={() => void openChat(m, st.id, st.kind)}
      >
        <span className={`dot dot-${status}`} aria-hidden />
        <span className="chat-row-text">
          <span className="chat-row-title ellipsis">{title}</span>
          <span className="chat-row-meta ellipsis small muted">
            <Icon className="chat-row-icon" />
            {[agent, shortPath(st.cwd, home), when].filter(Boolean).join(' · ')}
          </span>
        </span>
        {label && st.state !== 'idle' && st.state !== 'working' && <span className="chat-row-state small muted">{label}</span>}
      </button>
      {!readOnly && (
        <span className="chat-row-actions">
          {st.state !== 'closed' && (
            <button
              type="button"
              className="icon sm"
              aria-label={t('chat.closeNamed', { title })}
              title={t('chat.close')}
              onClick={() => void closeChat(m, st.id)}
            >
              <CirclePower />
            </button>
          )}
          <button
            type="button"
            className="icon sm"
            aria-label={t('chat.deleteNamed', { title })}
            title={t('chat.delete')}
            onClick={() => void deleteChat(m, st.id)}
          >
            <Trash2 />
          </button>
        </span>
      )}
    </div>
  );
}
