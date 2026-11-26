// The agents plugin's Chinese messages.
import type { en } from './en';

export const zhCN: Record<keyof typeof en, string> = {
  'agents.title': '编程智能体',
  'agents.description':
    '在机器上找出终端中每个编程智能体（Claude Code、Codex）所在的会话：状态栏显示该会话的用量，终端核心重新启动后，智能体会回到它自己的对话中。',
  'agents.continueInChat': '在对话中继续',
  'agents.continueInChat.title': '在对话中继续这个 {agent} 会话',
};
