// The chat pane: a chat of a machine's chat host (view.ts), drawn by the
// conversation view (conversation/Conversation.tsx) from the chat's source
// (source.ts). Above it a line says which agent it is, the chat's title
// (renamed in place: a double click, or Rename in the pane's menu), its
// directory, quick actions (Fork, Switch Agent) and its state; below that what
// keeps the chat from going on: it is no more, the page or the machine is not
// connected, the hub refused it, or its agent failed (with what the agent wrote
// to its error output). The composer says the rest (closed, handed off to a
// terminal, sleeping agents start again with a message).
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ArrowLeftRight, BotMessageSquare, GitFork, TriangleAlert, WifiOff } from 'lucide-react';
import { actions } from '../../actions';
import { InlineEdit } from '../../components/InlineEdit';
import { openMenu } from '../../contextMenu';
import { Conversation, type ConversationHandle } from '../../conversation/Conversation';
import { chatAdapter } from '../../conversation/kinds';
import type { ModelPickerConfig } from '../../conversation/source';
import { t, type MessageKey } from '../../i18n';
import { shortPath } from '../../lib/machine';
import { useSettings } from '../../settings';
import { useStore } from '../../state/store';
import { terms } from '../../state/terms';
import * as L from '../../term/layout';
import type { PluginView } from '../../term/layout';
import type { PaneViewProps } from '../api';
import { failureText, fullAccessAllowed, visibleModelsFor } from './api';
import { agentName, brandKindIcon, forkChat, renameChat, switchAgentMenu, useChatUi } from './ops';
import { CHAT_STATES } from './protocol';
import { useChatSource } from './source';
import { chatGone, follow, liveKey, useChats } from './state';
import { chatRef } from './view';
import './chat.css';

/** The words of a chat's state; handed off and offline are the pane's own. */
export function stateLabel(state: string | undefined, o: { handedOff?: boolean; offline?: boolean } = {}): string | undefined {
  if (o.offline) return t('chat.state.offline');
  if (o.handedOff && state !== 'working' && state !== 'waiting') return t('chat.state.handedOff');
  return state && (CHAT_STATES as readonly string[]).includes(state) ? t(`chat.state.${state}` as MessageKey) : undefined;
}

/** The agent's kind of a chat pane: the leaf's, else the chat's state's,
 * when it is one the host runs. */
export function useChatKind(m: string, view: PluginView): string | undefined {
  const ref = chatRef(view);
  const stated = useChats((s) => (ref.chat ? s.states[m]?.[ref.chat]?.kind : undefined));
  return ref.agent ?? (chatAdapter(stated) ? stated : undefined);
}

export function ChatPane({ m, pane, view }: PaneViewProps) {
  const chat = chatRef(view).chat;
  useEffect(() => follow(), []);
  if (!chat)
    return (
      <div className="empty-state">
        <div>{t('chat.noChat')}</div>
      </div>
    );
  return <ChatBody key={`${m}\n${chat}`} m={m} pane={pane} view={view} chat={chat} />;
}

function ChatBody({ m, pane, view, chat }: { m: string; pane: string; view: PluginView; chat: string }) {
  const source = useChatSource(m, chat);
  const kind = useChatKind(m, view);
  const agent = agentName(kind);
  const live = useChats((s) => s.live[liveKey(m, chat)]);
  const st = useChats((s) => s.states[m]?.[chat]);
  const gone = useChats((s) => chatGone(s, m, chat));
  const readOnly = useStore((s) => s.readOnly);
  const allowFull = useSettings((s) => fullAccessAllowed(s.values, m));
  const visibleModels = useSettings((s) => (kind ? s.values[`chat.visibleModels.${kind}`] : undefined));
  const home = useStore((s) => s.machines[m]?.info?.home);
  const renaming = useChatUi((s) => s.renaming === `${m}\n${view.id}`);
  const conv = useRef<ConversationHandle>(null);

  const title = live?.info?.title || st?.title || '';
  const cwd = live?.info?.cwd || st?.cwd || '';
  const mdBase = useMemo(() => (cwd ? { m, dir: cwd } : undefined), [m, cwd]);
  const state = live?.state ?? st?.state;
  const status = st?.status;
  const offline = live?.link === 'offline' || (!!st?.stale && st.state !== 'closed');
  const label = gone ? t('chat.state.deleted') : stateLabel(state, { handedOff: live?.info?.handedOff, offline });
  const Icon = kind ? brandKindIcon(kind) : BotMessageSquare;
  const failed = !gone && live?.link === 'failed' ? live.linkError : undefined;
  const stderr = state === 'failed' ? live?.error?.stderr : undefined;

  // Keep the leaf's title and agent kind up to date so tabs and headers render
  // the right label and brand icon immediately after reload.
  useEffect(() => {
    if (readOnly || gone) return;
    const patch: Record<string, unknown> = {};
    if (title && view.title !== title) patch.title = title;
    if (kind && view.agent !== kind) patch.agent = kind;
    if (Object.keys(patch).length) terms.mutate(m, (l) => L.setViewFields(l, pane, patch));
  }, [m, pane, title, kind, view.title, view.agent, readOnly, gone]);

  const doneRenaming = (value: string | undefined) => {
    useChatUi.setState({ renaming: undefined });
    if (value !== undefined && value !== title && !readOnly) void renameChat(m, chat, value);
  };

  const agentIcon = useMemo(() => (kind ? createElement(brandKindIcon(kind), { className: 'conv-agent-logo' }) : undefined), [kind]);

  const modelPicker = useMemo<ModelPickerConfig | undefined>(() => {
    if (!kind) return undefined;
    const list = visibleModelsFor({ [`chat.visibleModels.${kind}`]: visibleModels }, kind);
    return {
      visibleModels: list,
      onManageModels: () => useStore.getState().openSettings({ page: 'chat', row: `chat.visibleModels.${kind}` }),
    };
  }, [kind, visibleModels]);

  const onFork = useCallback(
    (upToSeq?: number) => {
      void forkChat(m, chat, { upToSeq, from: pane });
    },
    [m, chat, pane],
  );

  const onSwitchClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      const entries = switchAgentMenu(m, chat, kind, pane);
      if (!entries.length) {
        useStore.getState().toast(t('chat.switchAgentNone'), undefined, undefined, 'info');
        return;
      }
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(
        {
          clientX: r.left,
          clientY: r.bottom + 2,
          preventDefault: () => e.preventDefault(),
          stopPropagation: () => e.stopPropagation(),
        },
        entries,
      );
    },
    [m, chat, kind, pane],
  );

  return (
    <div className="chat-pane" data-state={state} data-link={live?.link}>
      <div className="chat-head">
        <Icon className="chat-head-icon" />
        <span className="chat-agent">{agent}</span>
        {renaming && !readOnly ? (
          <InlineEdit value={title} className="chat-title-edit" onDone={doneRenaming} />
        ) : (
          <span
            className="chat-title ellipsis"
            title={readOnly ? title : t('chat.renameHint', { title: title || agent })}
            onDoubleClick={() => !readOnly && !gone && useChatUi.setState({ renaming: `${m}\n${view.id}` })}
          >
            {title || t('chat.untitled')}
          </span>
        )}
        {cwd && (
          <span className="chat-cwd ellipsis" title={cwd}>
            {shortPath(cwd, home)}
          </span>
        )}
        {!readOnly && !gone && (
          <span className="chat-head-actions">
            <button
              type="button"
              className="icon sm chat-action-fork"
              title={t('chat.forkHint')}
              aria-label={t('chat.fork')}
              onClick={() => void forkChat(m, chat, { from: pane })}
            >
              <GitFork aria-hidden />
            </button>
            <button
              type="button"
              className="icon sm chat-action-switch"
              title={t('chat.switchAgentHint')}
              aria-label={t('chat.switchAgent')}
              onClick={onSwitchClick}
            >
              <ArrowLeftRight aria-hidden />
            </button>
          </span>
        )}
        {label && (
          <span
            className="chat-state"
            role="status"
            title={state === 'sleeping' && !gone && !offline ? t('chat.sleepingHint', { agent }) : undefined}
          >
            <span className={`dot dot-${status && !gone ? status : 'idle'}`} aria-hidden />
            {label}
          </span>
        )}
      </div>
      {gone && (
        <div className="chat-banner" role="alert">
          <span>{t('chat.gone')}</span>
          {!readOnly && (
            <button type="button" className="ghost sm" onClick={() => void actions.closePane(m, pane)}>
              {t('chat.closePane')}
            </button>
          )}
        </div>
      )}
      {!gone && offline && (
        <div className="chat-banner" role="status">
          <WifiOff aria-hidden />
          <span>{t('chat.offline')}</span>
        </div>
      )}
      {failed && (
        <div className="chat-banner error" role="alert">
          <TriangleAlert aria-hidden />
          <span>{failureText(failed, agent, 'chat.attachFailed')}</span>
        </div>
      )}
      {stderr && <Stderr text={stderr} />}
      {!gone && source && (
        <div
          className="chat-body"
          data-autofocus
          tabIndex={-1}
          onFocus={(e) => {
            if (e.target === e.currentTarget) conv.current?.focus();
          }}
        >
          <Conversation
            ref={conv}
            source={source}
            kind={kind ?? ''}
            base={mdBase}
            readOnly={readOnly}
            allowFull={allowFull}
            agentIcon={agentIcon}
            modelPicker={modelPicker}
            onFork={readOnly ? undefined : onFork}
            onOpenFile={(path, line) => void actions.openPath(m, path, line, undefined, pane)}
          />
        </div>
      )}
    </div>
  );
}

/** What a failed agent wrote to its error output, shown on request. */
function Stderr({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="chat-stderr" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{t('chat.stderr')}</summary>
      {open && <pre>{text}</pre>}
    </details>
  );
}
