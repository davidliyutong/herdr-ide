// Lightweight chat plugin factory: keeps state, status dots, new-tab items,
// commands and hub message handling synchronous while allowing the app entry
// (plugins/index.ts) to supply lazy-loaded ChatPane, ChatsPanel and
// SettingsExtra components so conversation/ and highlight/ stay off the
// startup critical path.
import type { ComponentType } from 'react';
import { BotMessageSquare, MessagesSquare } from 'lucide-react';
import { actions } from '../../actions';
import { openMenu } from '../../contextMenu';
import { t } from '../../i18n';
import { useStore } from '../../state/store';
import type { PaneViewProps, PluginDef, PluginSettingsLayoutProps, PluginSettingsProps } from '../api';
import { ChatHeader } from './ChatHeader';
import { agentName, brandKindIcon, chatMenu, kindIcon, kindsMenu, machineLabel, newChat, newTabTitle, startRename } from './ops';
import { chatViewStatus } from './status';
import { agentsKnown, applyMessage, chatCwd, chatGone, follow, loadAgents, offeredKinds, probeAgents, useChats } from './state';
import { watchHosts } from './hostReminder';
import { CHAT_PLUGIN, CHAT_VIEW, chatRef } from './view';

export interface ChatPluginComponents {
  ChatPane: ComponentType<PaneViewProps>;
  ChatsPanel: ComponentType;
  ChatSettingsLayout?: ComponentType<PluginSettingsLayoutProps>;
  ChatSettingsExtra: ComponentType<PluginSettingsProps>;
  ChatUsageItem: ComponentType;
}

/** Starts a chat on the focused pane's machine: with its agent when the
 * machine offers one, else from a menu of them at the focused pane; a
 * machine that said it can start none is told of in a toast. */
function newChatCommand() {
  const c = actions.focusedContext();
  if (!c) return;
  const kinds = offeredKinds(c.m);
  if (kinds.length === 1) return void newChat(c.m, kinds[0].id);
  if (!kinds.length && agentsKnown(c.m)) return void useStore.getState().toast(t('chat.noAgents', { machine: machineLabel(c.m) }));
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

export function makeChatPlugin(ui: ChatPluginComponents): PluginDef {
  return {
    id: CHAT_PLUGIN,
    title: 'chat.title',
    description: 'chat.description',
    icon: BotMessageSquare,
    settings: { section: 'chat', ...(ui.ChatSettingsLayout ? { layout: ui.ChatSettingsLayout } : {}), extra: ui.ChatSettingsExtra },
    panels: [{ id: CHAT_PLUGIN, title: 'chat.panel.chats', icon: MessagesSquare, component: ui.ChatsPanel }],
    paneViews: {
      [CHAT_VIEW]: {
        icon: BotMessageSquare,
        iconFor(m, v) {
          const ref = chatRef(v);
          const kind = ref.agent ?? (ref.chat ? useChats.getState().states[m]?.[ref.chat]?.kind : undefined);
          return kind ? brandKindIcon(kind) : undefined;
        },
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
        header: ChatHeader,
        startRename(m, v) {
          const chat = chatRef(v).chat;
          if (chat && !chatGone(useChats.getState(), m, chat)) startRename(m, v.id);
        },
        menu: chatMenu,
        component: ui.ChatPane,
      },
    },
    commands: {
      'chat.new': {
        enabled: () => !useStore.getState().readOnly && !!actions.focusedContext(),
        run: newChatCommand,
      },
    },
    statusItems: [{ id: 'chat.usage', title: 'chat.usage.title', component: ui.ChatUsageItem }],
    newTabItems(m) {
      follow();
      void loadAgents(m);
      return offeredKinds(m).map((k) => ({
        id: `chat.${k.id}`,
        title: newTabTitle(k.id),
        icon: kindIcon(k.id),
        run: (machine: string, ws: string) => void newChat(machine, k.id, { workspace: ws }),
      }));
    },
    // A new workspace's agents are known before the user picks one: its
    // machine is asked, starting its chat host (which idles out).
    workspaceCreated(m) {
      void probeAgents(m);
    },
    onMessage(m, data) {
      // A host of another build than the hub's is reminded of.
      watchHosts();
      applyMessage(m, data);
    },
    viewStatus: chatViewStatus,
  };
}
