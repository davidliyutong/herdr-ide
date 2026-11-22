// The agents plugin: the sessions of the coding agents in the machines'
// terminals (Claude Code, Codex). Its switch, plugins.agents.enabled,
// turns on that each machine finds the session every agent terminal runs
// (docs/features/25-agent-detection.md), which the terminal's record
// carries (agent_session), and which a restore resumes the agent in once
// the machine confirmed it (the core's route
// /api/m/{id}/p/agents/resolve, restore.ts). Its core side is
// internal/plugins/agents. A terminal whose agent quit can continue that
// session in a chat (ContinueInChat.tsx, through the chat plugin's
// plugins/chat/imports.ts), with the chat plugin on.
import { Bot } from 'lucide-react';
import type { PluginDef } from '../api';
import { ContinueInChat } from './ContinueInChat';

export const agentsPlugin: PluginDef = {
  id: 'agents',
  title: 'agents.title',
  description: 'agents.description',
  icon: Bot,
  headerActions: [ContinueInChat],
};
