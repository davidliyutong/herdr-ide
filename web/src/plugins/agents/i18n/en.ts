// The agents plugin's English messages: the source of its message keys
// (web/src/i18n/en.ts gathers every plugin's). Placeholders: {name}.

export const en = {
  'agents.title': 'Coding Agents',
  'agents.description':
    'A coding agent’s conversation in its terminal’s pane (Claude Code, Codex), read from the agent’s session on its machine, and its own interface back in one step.',
  'command.agents.toggleView': 'Toggle Agent Conversation View',
  'command.agents.newTab': 'New Agent Tab',
  // The new-tab menu's items, by the agent's kind (its registry id).
  'agents.newTab.claude': 'Agent: Claude Code',
  'agents.newTab.codex': 'Agent: Codex',
  'agents.view.label': '{agent} conversation view',
  'agents.view.toConversation': 'Show {agent}’s conversation',
  'agents.view.toTerminal': 'Show {agent}’s terminal',
  'agents.view.onReadOnly': '{agent} is shown as its conversation (read-only page)',
  'agents.view.offReadOnly': '{agent} is shown in its terminal (read-only page)',
  'agents.loading': 'Reading {agent}’s conversation…',
  'agents.stale': 'The conversation cannot be read right now and may not be current; trying again.',
  'agents.strip.session': 'The conversation shows here once {agent}’s session is found (for some agents, after the first message).',
  'agents.strip.loading': 'Reading {agent}’s conversation…',
  'agents.strip.notFound': '{agent} has not written this conversation yet: it shows here after the first message.',
  'agents.strip.compressed': 'This conversation is stored compressed and cannot be shown here.',
  'agents.strip.error': 'The conversation cannot be read right now; trying again.',
  'agents.strip.bad': 'This conversation cannot be shown here.',
  'agents.strip.terminalView': 'Terminal View',
  'agents.strip.terminalViewHint': 'Show {agent} in its terminal only',
  // While the agent waits with its question where the conversation's upper
  // part would cover it, and the terminal is shown whole.
  'agents.waiting.showConversation': 'Show Conversation',
  'agents.waiting.showConversationHint': 'Show {agent}’s conversation over the terminal’s upper part while it waits',
} as const;
