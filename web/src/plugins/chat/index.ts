// The chat plugin: conversations with coding agents that a machine's chat
// host runs headless (Claude Code, Codex, and Kimi Code and Grok through
// the Agent Client Protocol), drawn by the app. Its core side is
// internal/plugins/chat, its protocol protocol.ts. A chat is a pane of the
// kind chat (view.ts); this version has no chat host and the pane says so.
import { BotMessageSquare } from 'lucide-react';
import { agentKind } from '../../conversation/kinds';
import { t } from '../../i18n';
import type { PluginDef } from '../api';
import { ChatPane } from './ChatPane';
import { CHAT_PLUGIN, CHAT_VIEW, chatRef } from './view';

export const chatPlugin: PluginDef = {
  id: CHAT_PLUGIN,
  title: 'chat.title',
  description: 'chat.description',
  icon: BotMessageSquare,
  settings: { section: 'chat' },
  paneViews: {
    [CHAT_VIEW]: {
      icon: BotMessageSquare,
      title: (_m, v) => agentKind(chatRef(v).agent)?.title ?? t('chat.pane'),
      component: ChatPane,
    },
  },
  newTabItems: () => [],
};
