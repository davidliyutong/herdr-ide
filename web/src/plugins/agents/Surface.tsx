// What the agents plugin draws over the pane of a terminal that runs a
// coding agent and is shown as its conversation (view.ts): the
// conversation over all of the terminal, which stays attached under it at
// its size; over the upper part while the agent waits for the user in the
// terminal, which then shows in the rest and takes the keyboard; or a strip
// over the terminal's top saying why there is no conversation to show.
//
// While the agent waits, where its question is decides (view.ts
// waitingView): a CLI that draws its dialog at the top of a cleared screen
// (Codex) would have it under the upper part, the rest of the terminal
// blank. The terminal is then shown whole, a strip saying what the agent
// waits for over its blank bottom, and the conversation kept in its place
// unseen; so too when its screen cannot be read. The screen is read again
// as it changes after the status (a CLI draws its dialog a moment later):
// every RECHECK_MS until the answer held for SETTLED_MS, and anew when
// what the agent waits for changes. Neither changes the terminal's size.
//
// The keyboard follows what is drawn, in the pane that has the focus and
// while nothing else on the page has it: the composer (or the list) when
// the conversation covers the terminal, the terminal when it is shown. It
// stays in the composer when the agent begins to wait while the user is
// writing a message there (the next Enter would answer the agent's
// question), and the upper part stays with it; the terminal takes it when
// clicked or shown (Show Terminal).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, MessagesSquare, SquareTerminal } from 'lucide-react';
import { Conversation, type ConversationHandle } from '../../conversation/Conversation';
import { agentKind } from '../../conversation/kinds';
import { t, type MessageKey } from '../../i18n';
import { useSetCover } from '../../state/covers';
import { paneHandle, useSurfaceFocus } from '../../state/panes';
import { useStore } from '../../state/store';
import { terms, useTerms } from '../../state/terms';
import { openLink } from '../../terminal/openLink';
import type { TerminalRecord } from '../../term/protocol';
import type { TerminalSurfaceProps } from '../api';
import { feedFor, hold, sourceOf, useFeedStatus } from './transcript';
import {
  agentView,
  coverOf,
  nativeKind,
  setNative,
  shownSession,
  SURFACE,
  waitingView,
  type Mode,
  type StripReason,
  type WaitingView,
} from './view';
import './agents.css';

/** The most of what the agent waits for that is shown. */
const WAITING_TEXT = 300;

/** While the agent waits, how often its terminal's screen is read again,
 * and how long one way of showing it holds before the reading stops. */
export const RECHECK_MS = 250;
export const SETTLED_MS = 3000;

/** The rows a terminal on screen shows, as text; undefined when it cannot
 * be read. */
function screenOf(m: string, terminal: string): string | undefined {
  try {
    const s: unknown = paneHandle(m, terminal)?.screenText();
    return typeof s === 'string' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Where the conversation's upper part (box) ends over its terminal: the
 * height of the terminal's area, which is the layer the surfaces are drawn
 * in (plugins/registry.ts TerminalSurfaces), and the distance of the box's
 * lower edge from the area's top, in CSS pixels. */
function partEdge(box: HTMLElement | null): { height: number; edge: number } {
  const area = box?.parentElement?.getBoundingClientRect();
  const part = box?.getBoundingClientRect();
  return area && part ? { height: area.height, edge: part.bottom - area.top } : { height: NaN, edge: NaN };
}

/** What the agent waits for, as its terminal reports it ("approve Write:
 * /path"). */
function waitingFor(record: TerminalRecord | undefined): string | undefined {
  const msg = (record?.status as { msg?: unknown } | null | undefined)?.msg;
  if (typeof msg !== 'string' || !msg.trim()) return undefined;
  const s = msg.trim();
  return s.length > WAITING_TEXT ? `${s.slice(0, WAITING_TEXT)}…` : s;
}

const STRIP_TEXT: Record<StripReason, MessageKey> = {
  session: 'agents.strip.session',
  loading: 'agents.strip.loading',
  not_found: 'agents.strip.notFound',
  compressed: 'agents.strip.compressed',
  error: 'agents.strip.error',
  bad: 'agents.strip.bad',
};

/** Opens a path the agent named as a terminal's link opens it: relative to
 * the terminal's directory, beside its pane. */
function openPath(m: string, terminal: string, path: string, line?: number) {
  const home = useStore.getState().machines[m]?.info?.home;
  const text = line && !/:\d+$/.test(path) ? `${path}:${line}` : path;
  openLink({ kind: 'path', text }, { m, pane: terminal, cwd: terms.directory(m, terminal), home });
}

export function AgentSurface({ m, terminal, leaf, focused, onActivate }: TerminalSurfaceProps) {
  const record = useTerms((s) => s.machines[m]?.terminals[terminal]);
  const readOnly = useStore((s) => s.readOnly);
  const kind = nativeKind(record);
  const session = shownSession(record, leaf);
  const status = useFeedStatus(m, kind, session);
  const view = agentView(leaf, record, () => status);
  const shown = view.mode !== 'off' && view.kind && view.session ? { kind: view.kind, session: view.session } : undefined;

  // The session's feed, read while the surface shows it, and its source for
  // this terminal (the same one when the view is drawn again).
  const feed = useMemo(() => (shown ? feedFor(m, shown.kind, shown.session) : undefined), [m, shown?.kind, shown?.session]);
  useEffect(() => (feed ? hold(feed) : undefined), [feed]);
  const source = useMemo(() => (feed ? sourceOf(feed, terminal) : undefined), [feed, terminal]);

  // What is drawn: each mode its own element (key), so that the keyboard
  // does not stay on one drawn for another.
  const mode: Mode = (view.mode === 'native' || view.mode === 'peek') && !source ? 'loading' : view.mode;
  const conv = useRef<ConversationHandle>(null);
  const box = useRef<HTMLDivElement>(null);

  // While the agent waits with a conversation to show: under the upper
  // part, or the terminal whole (the rules at the top of this file), as
  // last read; the user who asked for the conversation over a terminal
  // shown whole has it until the agent stops waiting.
  const waiting = mode === 'peek';
  const what = waiting ? waitingFor(record) : undefined;
  const [shownAs, setShownAs] = useState<WaitingView>('peek');
  const [asked, setAsked] = useState(false);
  const [wasWaiting, setWasWaiting] = useState(waiting);
  if (wasWaiting !== waiting) {
    setWasWaiting(waiting);
    setShownAs('peek');
    setAsked(false);
  }
  const whole = waiting && !asked && shownAs !== 'peek';

  useSetCover(m, terminal, waiting ? (whole ? undefined : 'part') : coverOf(view), SURFACE);

  // The screen read while the agent waits, before the page is painted when
  // the terminal is on screen (one drawn in this commit registers after
  // the surface: its first reading is the timer's). The user writing a
  // message keeps the upper part, the composer in it.
  useLayoutEffect(() => {
    if (!waiting) return;
    let last: WaitingView | undefined;
    let held = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const read = () => {
      const { height, edge } = partEdge(box.current);
      const next = conv.current?.writing() ? 'peek' : waitingView(screenOf(m, terminal), height, edge);
      if (next !== last) {
        last = next;
        held = 0;
        setShownAs(next);
      } else if ((held += RECHECK_MS) >= SETTLED_MS) clearInterval(timer);
    };
    if (paneHandle(m, terminal)) read();
    timer = setInterval(read, RECHECK_MS);
    return () => clearInterval(timer);
  }, [waiting, what, m, terminal]);

  // Over all of the terminal, the surface takes the pane's keyboard;
  // otherwise the terminal does.
  const takes = mode === 'native' || mode === 'loading';
  useSurfaceFocus(m, terminal, takes ? { focus: () => (conv.current ? conv.current.focus() : box.current?.focus()) } : undefined);
  // As what is drawn changes, the keyboard goes with it (the rules at the
  // top of this file); out of the conversation kept unseen too.
  const drawnAs = whole ? 'whole' : mode;
  const drawn = useRef(drawnAs);
  useEffect(() => {
    const was = drawn.current;
    drawn.current = drawnAs;
    if (was === drawnAs || !focused) return;
    // Something else on the page has the keyboard (a field, a dialog,
    // another pane, the terminal itself).
    const a = document.activeElement;
    if (a && a !== document.body && !box.current?.contains(a)) return;
    if (takes) (conv.current ?? box.current)?.focus();
    else if (!(mode === 'peek' && conv.current?.writing())) paneHandle(m, terminal)?.focus();
  }, [drawnAs, mode, takes, focused, m, terminal]);

  if (mode === 'off') return null;
  const agent = agentKind(view.kind)?.title ?? t('conversation.agent');
  // The terminal alone, and the keyboard in it.
  const toTerminal = () => {
    if (setNative(m, terminal, false)) paneHandle(m, terminal)?.focus();
  };

  if (mode === 'strip') {
    const reason = view.reason ?? 'session';
    const Icon = reason === 'loading' ? LoaderCircle : reason === 'error' || reason === 'bad' ? CircleAlert : MessagesSquare;
    return (
      <div key="strip" ref={box} className="agents-strip" role="status" data-reason={reason} onMouseDown={onActivate}>
        <Icon className={reason === 'loading' ? 'agents-spin' : undefined} aria-hidden />
        <span className="agents-strip-text">{t(STRIP_TEXT[reason], { agent })}</span>
        {!readOnly && (
          <button type="button" className="agents-link" title={t('agents.strip.terminalViewHint', { agent })} onClick={toTerminal}>
            {t('agents.strip.terminalView')}
          </button>
        )}
      </div>
    );
  }

  if (mode === 'loading' || !source) {
    return (
      <div key="loading" ref={box} className="agents-surface agents-loading" data-mode="loading" tabIndex={-1} onMouseDown={onActivate}>
        <LoaderCircle className="agents-spin" aria-hidden />
        <span role="status">{t('agents.loading', { agent })}</span>
        {!readOnly && (
          <button type="button" className="agents-link" onClick={toTerminal}>
            {t('conversation.showTerminal')}
          </button>
        )}
      </div>
    );
  }

  const peek = mode === 'peek';
  // Over a terminal that would be shown whole, Show Terminal goes back to
  // it; otherwise it shows the terminal alone.
  const back = peek && asked && shownAs !== 'peek';
  // The same elements in every mode of the conversation, so that it is not
  // drawn anew as the agent waits: unseen while the terminal is shown
  // whole, which leaves its upper part's place to be read against.
  return (
    <>
      <div
        key="conversation"
        ref={box}
        className="agents-surface"
        data-mode={mode}
        data-whole={whole || undefined}
        onMouseDown={onActivate}
      >
        {status?.stale && (
          <div className="agents-stale" role="status">
            <CircleAlert aria-hidden />
            <span>{t('agents.stale')}</span>
          </div>
        )}
        <Conversation
          ref={conv}
          source={source}
          kind={view.kind!}
          status={view.status ?? 'unknown'}
          blockedText={waitingFor(record)}
          readOnly={readOnly}
          peek={peek}
          onShowTerminal={toTerminal}
          onOpenFile={(path, line) => openPath(m, terminal, path, line)}
        />
        {peek && !whole && (
          <div className="agents-waiting" role="status">
            <SquareTerminal aria-hidden />
            <span className="agents-waiting-text">
              {t('conversation.blocked', { agent })}
              {what && <span className="agents-waiting-what"> {what}</span>}
            </span>
            {(back || !readOnly) && (
              <button type="button" className="agents-link" onClick={back ? () => setAsked(false) : toTerminal}>
                {t('conversation.showTerminal')}
              </button>
            )}
          </div>
        )}
      </div>
      {whole && (
        <div
          key="waiting"
          className="agents-strip"
          role="status"
          data-reason="waiting"
          // Over the terminal's blank bottom when its question is above;
          // over its top, as the other strips, when it is not known where.
          data-edge={shownAs === 'under' ? 'bottom' : 'top'}
          onMouseDown={onActivate}
        >
          <SquareTerminal aria-hidden />
          <span className="agents-strip-text">
            {t('conversation.blocked', { agent })}
            {what && <span className="agents-waiting-what"> {what}</span>}
          </span>
          <button
            type="button"
            className="agents-link"
            title={t('agents.waiting.showConversationHint', { agent })}
            onClick={() => setAsked(true)}
          >
            {t('agents.waiting.showConversation')}
          </button>
        </div>
      )}
    </>
  );
}
