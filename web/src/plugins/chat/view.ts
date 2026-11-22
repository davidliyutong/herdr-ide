// The chat pane's leaf: {view: {id, plugin: 'chat', kind: 'chat', chat,
// agent}}, the host's chat id and the agent's kind. A layout comes from a
// machine's document and is not trusted: the chat id is taken only in the
// host's form (protocol.ts isChatId), the agent only when it is a kind the
// chat host runs.
import { chatAdapter } from '../../conversation/kinds';
import type { PluginView } from '../../term/layout';
import { isChatId } from './protocol';

/** The plugin's id, and the kind of its pane. */
export const CHAT_PLUGIN = 'chat';
export const CHAT_VIEW = 'chat';

/** What a chat pane's leaf names. */
export interface ChatRef {
  /** The host's chat id; undefined when the leaf holds none that is one. */
  chat?: string;
  /** The agent's kind; undefined when it is no kind the host runs. */
  agent?: string;
}

/** What a chat pane's view names, each member checked. */
export function chatRef(view: PluginView): ChatRef {
  const agent = typeof view.agent === 'string' && chatAdapter(view.agent) ? view.agent : undefined;
  return { chat: isChatId(view.chat) ? view.chat : undefined, agent };
}
