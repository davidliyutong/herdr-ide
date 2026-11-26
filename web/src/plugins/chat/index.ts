// The chat plugin: conversations with coding agents that a machine's chat
// host runs headless (Claude Code, Codex, and Kimi Code and Grok through
// the Agent Client Protocol), drawn by the app. Its hub side is
// backend/features/chat, its protocol protocol.ts. A chat is a pane of the
// kind chat (view.ts, ChatPane.tsx) whose events come over the page's one
// WebSocket (connection.ts, source.ts); the chats' states come with the
// hub's messages (state.ts) and give the panes their agent statuses
// (status.ts). New chats start from the new-tab menu, the Chats panel and
// the command chat.new; the status bar's chat.usage shows the focused
// chat's cost, context and limit.
import { ChatPane } from './ChatPane';
import { ChatsPanel } from './ChatsPanel';
import { ChatSettingsExtra } from './SettingsExtra';
import { ChatSettingsPage } from './SettingsPage';
import { ChatUsageItem } from './UsageItem';
import { makeChatPlugin } from './plugin';

export const chatPlugin = makeChatPlugin({
  ChatPane,
  ChatsPanel,
  ChatSettingsLayout: ChatSettingsPage,
  ChatSettingsExtra,
  ChatUsageItem,
});
