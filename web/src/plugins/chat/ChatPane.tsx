// The chat pane: a chat of a machine's chat host (view.ts), drawn by the
// conversation view (conversation/Conversation.tsx) from the chat's source
// (source.ts). Its heading, inline title rename, quick actions and state live
// in the pane's single header bar (ChatHeader.tsx); below that sit any banners
// that keep the chat from going on (deleted, offline, attach failure, failed
// agent stderr) and the conversation itself.
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TriangleAlert, WifiOff } from 'lucide-react';
import { actions } from '../../actions';
import { Conversation, type ConversationHandle } from '../../conversation/Conversation';
import type { ModelPickerConfig } from '../../conversation/source';
import { t } from '../../i18n';
import { useSettings } from '../../settings';
import { useStore } from '../../state/store';
import { terms } from '../../state/terms';
import * as L from '../../term/layout';
import type { PluginView } from '../../term/layout';
import type { PaneViewProps } from '../api';
import { useRepo, useReposOf } from '../git/state';
import { pluginOn, usePluginList } from '../registry';
import { failureText, fullAccessAllowed, visibleModelsFor } from './api';
import { stateLabel, useChatKind } from './ChatHeader';
import { agentName, brandKindIcon, forkChat, openChat, useChatUi } from './ops';
import { useChatSource } from './source';
import { chatGone, follow, liveKey, useChats } from './state';
import { chatRef } from './view';
import './chat.css';

export { stateLabel, useChatKind };

export function ChatPane({ m, pane, view, shown = true }: PaneViewProps) {
  const chat = chatRef(view).chat;
  useEffect(() => follow(), []);
  if (!chat)
    return (
      <div className="empty-state">
        <div>{t('chat.noChat')}</div>
      </div>
    );
  return <ChatBody key={`${m}\n${chat}`} m={m} pane={pane} view={view} chat={chat} shown={shown} />;
}

function ChatBody({ m, pane, view, chat, shown }: { m: string; pane: string; view: PluginView; chat: string; shown: boolean }) {
  const source = useChatSource(m, chat);
  const kind = useChatKind(m, view);
  const agent = agentName(kind);
  const live = useChats((s) => s.live[liveKey(m, chat)]);
  const st = useChats((s) => s.states[m]?.[chat]);
  const gone = useChats((s) => chatGone(s, m, chat));
  const readOnly = useStore((s) => s.readOnly);
  const allowFull = useSettings((s) => fullAccessAllowed(s.values, m));
  const visibleModels = useSettings((s) => (kind ? s.values[`chat.visibleModels.${kind}`] : undefined));
  const rewindReq = useChatUi((s) => (s.rewind?.pane === `${m}\n${view.id}` ? s.rewind : undefined));
  const rewindRequest = useMemo(() => (rewindReq ? { seq: rewindReq.seq, nonce: rewindReq.nonce } : undefined), [rewindReq]);
  const conv = useRef<ConversationHandle>(null);

  const title = live?.info?.title || st?.title || '';
  const cwd = live?.info?.cwd || st?.cwd || '';
  const mdBase = useMemo(() => (cwd ? { m, dir: cwd } : undefined), [m, cwd]);
  const gitPluginDef = usePluginList((s) => s.list.find((p) => p.id === 'git'));
  const gitEnabled = useSettings((s) => !!gitPluginDef && pluginOn(gitPluginDef, s.values, s.client));
  const { roots: gitRoots } = useReposOf(gitEnabled && cwd ? m : undefined, gitEnabled && cwd ? cwd : undefined);
  const gitRoot = gitRoots?.[0];
  const gitRepo = useRepo(gitEnabled ? m : undefined, gitRoot);
  const branch = useMemo(() => {
    const b = gitRepo?.status?.branch ?? gitRepo?.info?.branch;
    if (b) return b;
    const head = gitRepo?.status?.head ?? gitRepo?.info?.head;
    return head ? head.slice(0, 7) : undefined;
  }, [gitRepo?.status?.branch, gitRepo?.info?.branch, gitRepo?.status?.head, gitRepo?.info?.head]);
  const state = live?.state ?? st?.state;
  const offline = live?.link === 'offline' || (!!st?.stale && st.state !== 'closed');
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

  const onOpenChat = useCallback(
    (chatId: string, chatKind?: string) => {
      void openChat(m, chatId, chatKind ?? '', pane);
    },
    [m, pane],
  );

  return (
    <div className="chat-pane" data-state={state} data-link={live?.link}>
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
            shown={shown}
            rewindRequest={rewindRequest}
            base={mdBase}
            branch={branch}
            readOnly={readOnly}
            allowFull={allowFull}
            agentIcon={agentIcon}
            modelPicker={modelPicker}
            onFork={readOnly ? undefined : onFork}
            onOpenChat={onOpenChat}
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
