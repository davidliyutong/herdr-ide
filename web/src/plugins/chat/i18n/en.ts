// The chat plugin's English messages: the source of its message keys
// (web/src/i18n/en.ts gathers every plugin's).

export const en = {
  'chat.title': 'Agent Chats',
  'chat.description':
    'Conversations with coding agents (Claude Code, Codex, Kimi Code, Grok) that a machine runs without a terminal, drawn by the app.',
  'chat.pane': 'Chat',
  'chat.unavailable': 'Chats with coding agents are not available in this version.',
  'settings.section.chat': 'Agent Chats',
  'settings.chat.permissionMode': 'Permission mode of new chats',
  'settings.chat.permissionMode.desc': 'What an agent of a new chat may do without asking. A chat can change it.',
  'settings.chat.permissionMode.default': 'Ask before edits and commands',
  'settings.chat.permissionMode.acceptEdits': 'Make edits without asking',
  'settings.chat.permissionMode.plan': 'Plan first',
  'settings.chat.permissionMode.full': 'Full access',
  'settings.chat.idleStopMinutes': 'Stop idle agents after',
  'settings.chat.idleStopMinutes.desc':
    'An agent that has nothing to do for this long is stopped; its chat continues its session at the next message.',
  'settings.chat.idleStopMinutes.unit': 'min',
  'settings.chat.maxLive': 'Agents running at once',
  'settings.chat.maxLive.desc': 'The most agents a machine runs for chats; one more stops the one idle the longest.',
  'settings.chat.maxChats': 'Chats kept',
  'settings.chat.maxChats.desc': 'The most chats a machine keeps; the oldest closed ones go first.',
  'settings.chat.retentionDays': 'Keep closed chats for',
  'settings.chat.retentionDays.desc': 'Closed chats older than this are removed. The agents’ own sessions stay.',
  'settings.chat.retentionDays.unit': 'days',
  'settings.chat.maxTotalMB': 'Space on disk',
  'settings.chat.maxTotalMB.desc': 'The most space the chats take on a machine; the oldest closed ones go first.',
  'settings.chat.maxTotalMB.unit': 'MB',
  'settings.chat.maxChatMB': 'Space per chat',
  'settings.chat.maxChatMB.desc': 'The most space one chat takes; its oldest events go first.',
  'settings.chat.maxChatMB.unit': 'MB',
} as const;
