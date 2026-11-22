// The chat pane's leaf: {view: {id, plugin: 'chat', kind: 'chat', chat,
// agent, title?}}, the host's chat id, the agent's kind and the chat's
// title as the pane last saw it (shown before the chats' states come). A
// layout comes from a machine's document and is not trusted: the chat id
// is taken only in the host's form (protocol.ts isChatId), the agent only
// when it is a kind the chat host runs, the title as text.
import { chatAdapter } from '../../conversation/kinds';
import { useTerms } from '../../state/terms';
import * as L from '../../term/layout';
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

/** The pane of machine m's layout that shows a chat: the selected
 * workspace's first, then any other's. */
export function chatPane(m: string, chat: string): string | undefined {
  const layout = useTerms.getState().machines[m]?.layout;
  if (!layout) return undefined;
  const order = [layout.workspaces[layout.selected], ...layout.workspaces.filter((_, i) => i !== layout.selected)];
  for (const ws of order) {
    if (!ws) continue;
    const found = L.pluginViews(ws, CHAT_PLUGIN, CHAT_VIEW).find((v) => chatRef(v.view).chat === chat);
    if (found) return found.key;
  }
  return undefined;
}
