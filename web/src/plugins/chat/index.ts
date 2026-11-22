// The chat plugin: conversations with coding agents that a machine's chat
// host runs headless (Claude Code, Codex, and Kimi Code and Grok through
// the Agent Client Protocol), drawn by the app. Its core side is
// internal/plugins/chat, its protocol protocol.ts. A chat is a pane of the
// kind chat (view.ts, ChatPane.tsx) whose events come over the page's one
// WebSocket (connection.ts, source.ts); the chats' states come with the
// core's messages (state.ts) and give the panes their agent statuses
// (status.ts). New chats start from the new-tab menu, the Chats panel and
// the command chat.new; the status bar's chat.usage shows the focused
// chat's cost, context and limit.
import { BotMessageSquare, MessagesSquare } from 'lucide-react';
import { actions } from '../../actions';
import { openMenu } from '../../contextMenu';
import { t } from '../../i18n';
import { useStore } from '../../state/store';
import type { PluginDef } from '../api';
import { ChatPane } from './ChatPane';
import { ChatsPanel } from './ChatsPanel';
import { agentName, chatMenu, kindIcon, kindsMenu, newChat, newTabTitle } from './ops';
import { chatCwd } from './source';
import { chatViewStatus } from './status';
import { applyMessage, chatGone, follow, loadAgents, offeredKinds, useChats } from './state';
import { ChatUsageItem } from './UsageItem';
import { CHAT_PLUGIN, CHAT_VIEW, chatRef } from './view';

/** Starts a chat on the focused pane's machine: with its agent when the
 * machine offers one, else from a menu of them at the focused pane. */
function newChatCommand() {
  const c = actions.focusedContext();
  if (!c) return;
  const kinds = offeredKinds(c.m);
  if (kinds.length === 1) return void newChat(c.m, kinds[0].id);
  const header = c.pane ? document.querySelector(`.pane-header[data-m="${CSS.escape(c.m)}"][data-pane="${CSS.escape(c.pane)}"]`) : null;
  const r = header?.getBoundingClientRect();
  openMenu(
    {
      clientX: r ? r.left + 8 : window.innerWidth / 2,
      clientY: r ? r.bottom : window.innerHeight / 3,
      preventDefault() {},
      stopPropagation() {},
    },
    kindsMenu(c.m),
  );
}

export const chatPlugin: PluginDef = {
  id: CHAT_PLUGIN,
  title: 'chat.title',
  description: 'chat.description',
  icon: BotMessageSquare,
  settings: { section: 'chat' },
  panels: [{ id: CHAT_PLUGIN, title: 'chat.panel.chats', icon: MessagesSquare, component: ChatsPanel }],
  paneViews: {
    [CHAT_VIEW]: {
      icon: BotMessageSquare,
      title(m, v) {
        const ref = chatRef(v);
        const st = ref.chat ? useChats.getState().states[m]?.[ref.chat] : undefined;
        // The leaf's copy (ChatPane keeps it) while the states have none.
        const kept = typeof v.title === 'string' ? v.title.slice(0, 500) : '';
        return st?.title || kept || (ref.agent ? agentName(ref.agent) : t('chat.pane'));
      },
      directory: (m, v) => {
        const chat = chatRef(v).chat;
        return chat ? chatCwd(m, chat) : undefined;
      },
      useGone(m, v) {
        const chat = chatRef(v).chat;
        const gone = useChats((s) => !!chat && chatGone(s, m, chat));
        return gone ? t('chat.gone') : undefined;
      },
      menu: chatMenu,
      component: ChatPane,
    },
  },
  commands: {
    'chat.new': {
      enabled: () => !useStore.getState().readOnly && !!actions.focusedContext(),
      run: newChatCommand,
    },
  },
  statusItems: [{ id: 'chat.usage', title: 'chat.usage.title', component: ChatUsageItem }],
  newTabItems(m) {
    follow();
    void loadAgents(m);
    return offeredKinds(m).map((k) => ({
      id: `chat.${k.id}`,
      title: newTabTitle(k.id),
      icon: kindIcon(k.id),
      run: (machine: string) => void newChat(machine, k.id),
    }));
  },
  onMessage: applyMessage,
  viewStatus: chatViewStatus,
};
