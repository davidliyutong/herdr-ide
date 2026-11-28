// The chat pane's single-row header content (PaneViewDef.header), rendered
// directly inside PaneHeader before PaneActions: status dot, agent brand icon,
// agent name, inline-editable title, working directory, state label, and quick
// actions (Fork, Switch Agent, Export Markdown). Kept lightweight so plugin.ts
// can render chat pane headers synchronously without loading Conversation.
import { createElement, useCallback, type MouseEvent } from 'react';
import { ArrowLeftRight, BotMessageSquare, Download, GitFork, RotateCcw } from 'lucide-react';
import { InlineEdit } from '../../components/InlineEdit';
import { StatusDot } from '../../components/StatusDot';
import { openMenu, type MenuEntry } from '../../contextMenu';
import { chatAdapter } from '../../conversation/kinds';
import { t, type MessageKey } from '../../i18n';
import { shortPath, type AgentStatus } from '../../lib/machine';
import { useStore } from '../../state/store';
import type { PluginView } from '../../term/layout';
import type { PaneHeaderViewProps } from '../api';
import {
  agentName,
  brandKindIcon,
  confirmLossyFork,
  exportChatMenu,
  forkChat,
  renameChat,
  requestRewind,
  switchAgentMenu,
  useChatUi,
} from './ops';
import { CHAT_STATES } from './protocol';
import { chatUserTurns } from './source';
import { chatGone, liveKey, useChats } from './state';
import { chatRef } from './view';

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

export function ChatHeader({ m, pane, view, home }: PaneHeaderViewProps) {
  const chat = chatRef(view).chat;
  const kind = useChatKind(m, view);
  const agent = agentName(kind);
  const live = useChats((s) => (chat ? s.live[liveKey(m, chat)] : undefined));
  const st = useChats((s) => (chat ? s.states[m]?.[chat] : undefined));
  const gone = useChats((s) => !!chat && chatGone(s, m, chat));
  const readOnly = useStore((s) => s.readOnly);
  const renaming = useChatUi((s) => s.renaming === `${m}\n${view.id}`);

  const kept = typeof view.title === 'string' ? view.title.slice(0, 500) : '';
  const title = live?.info?.title || st?.title || kept || '';
  const cwd = live?.info?.cwd || st?.cwd || '';
  const state = live?.state ?? st?.state;
  const status = (st?.status as AgentStatus | undefined) ?? undefined;
  const offline = live?.link === 'offline' || (!!st?.stale && st.state !== 'closed');
  const label = gone ? t('chat.state.deleted') : stateLabel(state, { handedOff: live?.info?.handedOff, offline });
  const Icon = kind ? brandKindIcon(kind) : BotMessageSquare;

  const doneRenaming = (value: string | undefined) => {
    useChatUi.setState({ renaming: undefined });
    if (chat && value !== undefined && value !== title && !readOnly) void renameChat(m, chat, value);
  };

  const onSwitchClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (!chat) return;
      const entries = switchAgentMenu(m, chat, kind, pane, view);
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
    [m, chat, kind, pane, view],
  );

  const rewindUnsupported = !!live?.info && !live.info.capabilities?.rewind;
  const lossyFork = !!live?.info && !live.info.capabilities?.fork;

  const onRewindClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (!chat) return;
      const entries: MenuEntry[] = rewindUnsupported
        ? [{ label: t('chat.rewindUnsupported', { agent }), disabled: true, run: () => {} }]
        : (() => {
            const turns = chatUserTurns(m, chat);
            return turns.length
              ? turns
                  .map((turn, idx) => ({ turn, num: idx + 1 }))
                  .reverse()
                  .slice(0, 30)
                  .map(({ turn, num }) => {
                    const preview = turn.text.length > 60 ? `${turn.text.slice(0, 59)}…` : turn.text;
                    return {
                      label: preview ? t('chat.rewindTurn', { n: num, text: preview }) : t('chat.rewindTurnEmpty', { n: num }),
                      icon: createElement(RotateCcw),
                      run: () => requestRewind(m, view.id, turn.seq),
                    };
                  })
              : [{ label: t('chat.rewindEmpty'), disabled: true, run: () => {} }];
          })();
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
    [m, chat, view.id, rewindUnsupported, agent],
  );

  const onForkClick = useCallback(async () => {
    if (!chat) return;
    if (!(await confirmLossyFork(m, chat, kind))) return;
    void forkChat(m, chat, { from: pane });
  }, [m, chat, kind, pane]);

  const onExportClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (!chat) return;
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(
        {
          clientX: r.left,
          clientY: r.bottom + 2,
          preventDefault: () => e.preventDefault(),
          stopPropagation: () => e.stopPropagation(),
        },
        exportChatMenu(m, chat, { kind }),
      );
    },
    [m, chat, kind],
  );

  if (!chat) {
    return (
      <>
        <Icon className="pane-kind" />
        <span className="pane-title">{t('chat.pane')}</span>
      </>
    );
  }

  const canEdit = !readOnly && !gone;
  const canExport = !gone && !offline;
  const working = state === 'working' || state === 'waiting' || state === 'starting';
  const rewindDisabled = working || !!live?.info?.handedOff;
  const dotStatus: AgentStatus | undefined = !gone && status ? status : label ? 'idle' : undefined;

  return (
    <>
      {dotStatus && <StatusDot status={dotStatus} />}
      <Icon className="pane-kind" />
      <span className="chat-agent">{agent}</span>
      {renaming && canEdit ? (
        <InlineEdit value={title} className="pane-title-edit chat-title-edit" onDone={doneRenaming} />
      ) : (
        <span
          className={`pane-title chat-title ${canEdit ? 'editable' : ''} ${gone ? 'is-gone' : ''}`}
          tabIndex={canEdit ? -1 : undefined}
          title={
            canEdit ? t('chat.renameHint', { title: title || agent }) : [title || agent, gone && t('chat.gone')].filter(Boolean).join(' · ')
          }
          onDoubleClick={() => canEdit && useChatUi.setState({ renaming: `${m}\n${view.id}` })}
        >
          {title || t('chat.untitled')}
        </span>
      )}
      {cwd && (
        <span className="pane-cwd chat-cwd" title={cwd}>
          <bdi>{shortPath(cwd, home)}</bdi>
        </span>
      )}
      {label && (
        <span
          className="chat-state"
          role="status"
          title={state === 'sleeping' && !gone && !offline ? t('chat.sleepingHint', { agent }) : undefined}
        >
          {label}
        </span>
      )}
      {(canEdit || canExport) && (
        <span
          className="pane-plugin-actions chat-head-actions"
          onMouseDown={(e) => (e.target as HTMLElement).closest('button') && e.preventDefault()}
        >
          {canEdit && (
            <>
              <button
                type="button"
                className={rewindUnsupported ? 'chat-action-rewind is-unsupported' : 'chat-action-rewind'}
                title={rewindUnsupported ? t('chat.rewindUnsupportedHint', { agent }) : t('chat.rewindHint')}
                aria-label={rewindUnsupported ? t('chat.rewindUnsupported', { agent }) : t('chat.rewind')}
                aria-haspopup="menu"
                aria-disabled={rewindUnsupported || undefined}
                disabled={rewindDisabled}
                onClick={onRewindClick}
              >
                <RotateCcw aria-hidden />
              </button>
              <button
                type="button"
                className="chat-action-fork"
                data-lossy={lossyFork || undefined}
                title={lossyFork ? t('chat.forkLossyHint', { agent }) : t('chat.forkHint')}
                aria-label={t('chat.fork')}
                disabled={working}
                onClick={() => void onForkClick()}
              >
                <GitFork aria-hidden />
              </button>
              <button
                type="button"
                className="chat-action-switch"
                title={t('chat.switchAgentHint')}
                aria-label={t('chat.switchAgent')}
                disabled={working}
                onClick={onSwitchClick}
              >
                <ArrowLeftRight aria-hidden />
              </button>
            </>
          )}
          {canExport && (
            <button
              type="button"
              className="chat-action-export"
              title={t('chat.exportHint')}
              aria-label={t('chat.export')}
              aria-haspopup="menu"
              onClick={onExportClick}
            >
              <Download aria-hidden />
            </button>
          )}
          <span className="sep" />
        </span>
      )}
    </>
  );
}
