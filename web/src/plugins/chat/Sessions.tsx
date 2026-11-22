// The agents' earlier sessions of a directory, each of which can be opened
// as a chat (an import: imports.ts importSession), for the
// chat panel. The directory is the panel's, else the focused pane's of the
// machine (a terminal's current directory), else its workspace's, else
// the machine's home. For each chat kind the machine's chat host can start
// now, its sessions of that directory, newest first, a page at a time
// (Show More); a row opens with a click, Enter or its button, and a
// session that is already a chat's shows that chat (an archived one is
// restored; one deleted or removed since the listing, as the page's
// chats tell, is no chat's any more and opens anew). They are read again
// when the directory changes and with Refresh. Listing them may run the
// agent (Codex, ACP agents), a change the core takes only from a page that
// may make changes: a read-only page lists none.
import { Archive, History, MessageSquareShare, MessagesSquare, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { paneDirectory } from '../../actions';
import { Section, TreeRow } from '../../components/tree';
import { relativeTime } from '../../conversation/format';
import { agentKind } from '../../conversation/kinds';
import { locale, t } from '../../i18n';
import { shortPath } from '../../lib/machine';
import { useStore } from '../../state/store';
import { terms, useTerms } from '../../state/terms';
import * as L from '../../term/layout';
import { reasonText } from './api';
import { chatAgents, chatSessions, importSession, MAX_SESSIONS, type PastSession } from './imports';
import { chatGone, useChats } from './state';
import './chat.css';

export interface PastSessionsProps {
  m: string;
  /** The directory whose sessions are listed; the focused terminal's when absent. */
  cwd?: string;
}

/** The directory of machine m's focused pane (paneDirectory), else of its
 * selected workspace. */
export function focusedDirectory(m: string): string | undefined {
  const layout = terms.layout(m);
  if (!layout) return undefined;
  const pane = L.focusedPane(layout);
  const leaf = pane ? L.findLeaf(layout, pane) : null;
  return (leaf ? paneDirectory(m, leaf) : undefined) || L.selectedWorkspace(layout)?.cwd || undefined;
}

/** The absolute directory whose sessions are listed: dir with "~" as the
 * home directory, else home. */
export function listedDirectory(dir: string | undefined, home: string | undefined): string | undefined {
  const h = home?.startsWith('/') ? home : undefined;
  let d = dir;
  if (d === '~' || d?.startsWith('~/')) d = h ? h + d.slice(1) : undefined;
  return d?.startsWith('/') ? L.normFolder(d) : h && L.normFolder(h);
}

/** A kind's sessions as far as they were read. */
interface KindList {
  sessions: PastSession[];
  /** The cursor of the next page. */
  next?: string;
  loading: boolean;
  error?: string;
}

/** Newest first; those without a time after the others, in the order the
 * machine gave them. */
const newestFirst = (list: PastSession[]): PastSession[] =>
  list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (b.s.updated ?? -Infinity) - (a.s.updated ?? -Infinity) || a.i - b.i)
    .map((x) => x.s);

/** Sessions with those of more, each once, at most MAX_SESSIONS. */
function merged(list: PastSession[], more: PastSession[]): PastSession[] {
  const seen = new Set(list.map((s) => s.sessionId));
  return newestFirst([...list, ...more.filter((s) => !seen.has(s.sessionId))]).slice(0, MAX_SESSIONS);
}

export function PastSessions({ m, cwd }: PastSessionsProps): JSX.Element | null {
  const focused = useTerms(() => (cwd === undefined ? focusedDirectory(m) : undefined));
  const home = useStore((s) => s.machines[m]?.info?.home);
  const readOnly = useStore((s) => s.readOnly);
  const dir = listedDirectory(cwd ?? focused, home);
  const [kinds, setKinds] = useState<string[] | undefined>(undefined);
  const [lists, setLists] = useState<Record<string, KindList>>({});
  const [version, setVersion] = useState(0);
  const [opening, setOpening] = useState<string | undefined>(undefined);
  // What the lists are of: an answer for another is dropped.
  const generation = useRef(0);
  // The chats the sessions are listed with, as the page's chats are now:
  // gone (deleted, or removed by the machine's limits), archived or there.
  const listedIds = Object.values(lists).flatMap((l) => l.sessions.flatMap((s) => (s.chat ? [s.chat] : [])));
  const chats = useChats(
    useShallow((st) =>
      Object.fromEntries(
        listedIds.map((id) => [id, chatGone(st, m, id) ? 'gone' : st.states[m]?.[id]?.archived ? 'archived' : 'chat'] as const),
      ),
    ),
  );
  const chatOf = (s: PastSession): string | undefined => (s.chat && chats[s.chat] !== 'gone' ? s.chat : undefined);
  const archivedChat = (chat: string | undefined) => !!chat && chats[chat] === 'archived';

  useEffect(() => {
    let gone = false;
    setKinds(undefined);
    if (readOnly) {
      setKinds([]);
      return;
    }
    chatAgents(m).then(
      (k) => !gone && setKinds(k),
      () => !gone && setKinds([]),
    );
    return () => {
      gone = true;
    };
  }, [m, version, readOnly]);

  // Refresh reads the kinds again, whose answer reads the lists.
  useEffect(() => {
    const gen = ++generation.current;
    if (!kinds || !dir) {
      setLists({});
      return;
    }
    setLists(Object.fromEntries(kinds.map((k) => [k, { sessions: [], loading: true }])));
    for (const kind of kinds) {
      const set = (l: KindList) => generation.current === gen && setLists((all) => ({ ...all, [kind]: l }));
      chatSessions(m, kind, dir).then(
        (page) => set({ sessions: newestFirst(page.sessions), next: page.next, loading: false }),
        (e) => set({ sessions: [], loading: false, error: reasonText(e) }),
      );
    }
  }, [m, dir, kinds]);

  const more = useCallback(
    (kind: string) => {
      const list = lists[kind];
      if (!dir || !list?.next || list.loading) return;
      const gen = generation.current;
      const set = (f: (l: KindList) => KindList) =>
        generation.current === gen && setLists((all) => (all[kind] ? { ...all, [kind]: f(all[kind]) } : all));
      set((l) => ({ ...l, loading: true }));
      chatSessions(m, kind, dir, list.next).then(
        (page) => set((l) => ({ sessions: merged(l.sessions, page.sessions), next: page.next, loading: false })),
        (e) => set((l) => ({ ...l, loading: false, error: reasonText(e) })),
      );
    },
    [m, dir, lists],
  );

  const open = useCallback(
    async (kind: string, s: PastSession) => {
      const listed = s.chat && !chatGone(useChats.getState(), m, s.chat) ? s.chat : undefined;
      if (opening || (readOnly && !listed)) return;
      setOpening(s.sessionId);
      try {
        const chat = await importSession(m, { kind, session: s.sessionId, cwd: s.cwd, chat: listed });
        // The session is that chat's from now on.
        if (chat && chat !== s.chat)
          setLists((all) => {
            const l = all[kind];
            return l
              ? { ...all, [kind]: { ...l, sessions: l.sessions.map((x) => (x.sessionId === s.sessionId ? { ...x, chat } : x)) } }
              : all;
          });
      } finally {
        setOpening(undefined);
      }
    },
    [m, opening, readOnly],
  );

  if (!dir || (kinds && !kinds.length)) return null;
  const shown = (kinds ?? []).filter((k) => lists[k] && (lists[k].sessions.length || lists[k].error || lists[k].next));
  const loading = !kinds || kinds.some((k) => lists[k]?.loading && !lists[k].sessions.length);
  const total = shown.reduce((n, k) => n + lists[k].sessions.length, 0);
  const now = Date.now();
  return (
    <Section
      id="chat.sessions"
      title={t('chat.sessions.title')}
      count={total || undefined}
      className="agent-sessions"
      actions={
        <button
          type="button"
          className="icon sm"
          title={t('chat.sessions.refresh')}
          aria-label={t('chat.sessions.refresh')}
          onClick={() => setVersion((v) => v + 1)}
        >
          <RefreshCw />
        </button>
      }
    >
      <div className="agent-sessions-dir ellipsis" title={t('chat.sessions.dir', { dir })}>
        <bdi>{shortPath(dir, home)}</bdi>
      </div>
      {shown.map((kind) => {
        const list = lists[kind];
        const title = agentKind(kind)?.title ?? kind;
        return (
          <div key={kind} className="agent-sessions-kind" role="tree" aria-label={title}>
            <div className="agent-sessions-kind-title">{title}</div>
            {list.sessions.map((s) => {
              const label = s.title || t('chat.sessions.untitled', { id: s.sessionId.slice(0, 8) });
              const when = s.updated ? relativeTime(s.updated / 1000, now, locale) : undefined;
              const chat = chatOf(s);
              const archived = archivedChat(chat);
              const action = archived ? t('chat.restore') : chat ? t('chat.sessions.showChat') : t('chat.sessions.open');
              const disabled = !!opening || (readOnly && !chat);
              const note = archived ? t('chat.sessions.archived') : chat ? t('chat.sessions.inChat') : undefined;
              return (
                <TreeRow
                  key={s.sessionId}
                  depth={0}
                  className="agent-session"
                  data-session={s.sessionId}
                  icon={
                    archived ? (
                      <Archive className="agent-session-icon" />
                    ) : chat ? (
                      <MessagesSquare className="agent-session-icon" />
                    ) : (
                      <History className="agent-session-icon" />
                    )
                  }
                  label={label}
                  description={[when, note].filter(Boolean).join(' · ') || undefined}
                  title={[label, s.sessionId, s.updated ? new Date(s.updated).toLocaleString() : ''].filter(Boolean).join('\n')}
                  dimmed={opening === s.sessionId}
                  tabIndex={0}
                  onClick={() => !disabled && void open(kind, s)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
                    e.preventDefault();
                    if (!disabled) void open(kind, s);
                  }}
                  actions={
                    <button
                      type="button"
                      className="icon sm"
                      title={action}
                      aria-label={action}
                      disabled={disabled}
                      onClick={() => void open(kind, s)}
                    >
                      {archived ? <Archive /> : chat ? <MessagesSquare /> : <MessageSquareShare />}
                    </button>
                  }
                />
              );
            })}
            {list.error && <div className="agent-sessions-note">{t('chat.sessions.failed', { error: list.error })}</div>}
            {list.next && list.sessions.length < MAX_SESSIONS && (
              <button type="button" className="btn sm agent-sessions-more" disabled={list.loading} onClick={() => more(kind)}>
                {t('chat.sessions.more')}
              </button>
            )}
          </div>
        );
      })}
      {loading ? (
        <div className="agent-sessions-note">{t('chat.sessions.loading')}</div>
      ) : (
        !shown.length && <div className="agent-sessions-note">{t('chat.sessions.none')}</div>
      )}
    </Section>
  );
}
