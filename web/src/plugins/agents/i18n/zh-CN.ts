// The agents plugin's Chinese messages.
import type { en } from './en';

export const zhCN: Record<keyof typeof en, string> = {
  'agents.title': '编程智能体',
  'agents.description':
    '在终端窗格中以对话形式显示编程智能体（Claude Code、Codex）的会话，内容读取自该机器上智能体的会话记录；一步即可切回智能体自己的界面。',
  'command.agents.toggleView': '切换智能体对话视图',
  'command.agents.newTab': '新建智能体标签页',
  'agents.newTab.claude': '智能体：Claude Code',
  'agents.newTab.codex': '智能体：Codex',
  'agents.view.label': '{agent} 对话视图',
  'agents.view.toConversation': '显示 {agent} 的对话',
  'agents.view.toTerminal': '显示 {agent} 的终端',
  'agents.view.onReadOnly': '{agent} 以对话形式显示（只读页面）',
  'agents.view.offReadOnly': '{agent} 在终端中显示（只读页面）',
  'agents.loading': '正在读取 {agent} 的对话…',
  'agents.stale': '暂时无法读取对话，显示的内容可能不是最新的；正在重试。',
  'agents.strip.session': '找到 {agent} 的会话后，对话会显示在这里（有些智能体要在第一条消息之后）。',
  'agents.strip.loading': '正在读取 {agent} 的对话…',
  'agents.strip.notFound': '{agent} 还没有写下这段对话：发出第一条消息后会显示在这里。',
  'agents.strip.compressed': '这段对话以压缩形式保存，无法在这里显示。',
  'agents.strip.error': '暂时无法读取对话；正在重试。',
  'agents.strip.bad': '这段对话无法在这里显示。',
  'agents.strip.terminalView': '终端视图',
  'agents.strip.terminalViewHint': '只在终端中显示 {agent}',
  'agents.waiting.showConversation': '显示对话',
  'agents.waiting.showConversationHint': '在 {agent} 等待期间，把它的对话显示在终端的上半部分',
};
