// The agents plugin's English messages: the source of its message keys
// (web/src/i18n/en.ts gathers every plugin's). What its button Continue in
// Chat does is the chat plugin's (plugins/chat/imports.ts), with its
// messages.

export const en = {
  'agents.title': 'Coding Agents',
  'agents.description':
    'Finds the session each coding agent in a terminal runs (Claude Code, Codex) on its machine: the status bar shows what the session used, and the agent comes back in its own conversation after the terminal core starts again.',
  'agents.continueInChat': 'Continue in Chat',
  'agents.continueInChat.title': 'Continue this {agent} session in a chat',
} as const;
