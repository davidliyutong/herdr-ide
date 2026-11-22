// The chat panes' agent statuses (plugins/api.ts ViewStatusDef), from the
// chats' states (state.ts): a pane is working, blocked (a permission or a
// question waits), done (a turn ended that nobody saw) or idle as its chat
// is. An agent notification of a chat (the core's, with member chat)
// points to the pane that shows that chat; seeing a pane whose chat is
// done tells the host (POST seen with the chat's last seq), which ends
// done for every page.
import { useStore } from '../../state/store';
import { useTerms } from '../../state/terms';
import * as L from '../../term/layout';
import type { AgentStatus } from '../../lib/machine';
import type { ViewStatusDef } from '../api';
import { chatApi } from './api';
import { CHAT_STATUSES, isChatId } from './protocol';
import { follow, useChats } from './state';
import { CHAT_PLUGIN, CHAT_VIEW, chatRef } from './view';

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

/** The seq up to which each chat was said to be seen, by machine and chat;
 * the oldest forgotten past MAX_TOLD. */
const told = new Map<string, number>();
const MAX_TOLD = 4000;

export const chatViewStatus: ViewStatusDef = {
  status(m, view) {
    const chat = chatRef(view).chat;
    const st = chat ? useChats.getState().states[m]?.[chat] : undefined;
    return st && (CHAT_STATUSES as readonly string[]).includes(st.status) ? (st.status as AgentStatus) : undefined;
  },
  subscribe(fn) {
    follow();
    return useChats.subscribe((s, prev) => {
      if (s.states !== prev.states) fn();
    });
  },
  paneOf(m, data) {
    return isChatId(data.chat) ? chatPane(m, data.chat) : undefined;
  },
  seen(m, view) {
    const chat = chatRef(view).chat;
    const st = chat ? useChats.getState().states[m]?.[chat] : undefined;
    if (!chat || !st || st.status !== 'done' || useStore.getState().readOnly) return;
    const k = `${m}\n${chat}`;
    if ((told.get(k) ?? -1) >= st.seq) return;
    told.set(k, st.seq);
    // Done ends here at once; the host's watch says so to every page.
    useChats.setState((s) => {
      const cur = s.states[m]?.[chat];
      return cur?.status === 'done' ? { states: { ...s.states, [m]: { ...s.states[m], [chat]: { ...cur, status: 'idle' } } } } : s;
    });
    if (told.size > MAX_TOLD) told.delete(told.keys().next().value!);
    chatApi.seen(m, chat, st.seq).catch(() => {
      // Not told: done again, as the host still has it.
      told.delete(k);
      useChats.setState((s) => {
        const cur = s.states[m]?.[chat];
        return cur?.status === 'idle' && cur.seq === st.seq
          ? { states: { ...s.states, [m]: { ...s.states[m], [chat]: { ...cur, status: 'done' } } } }
          : s;
      });
    });
  },
};

/** Forgets what was said to be seen (tests). */
export function resetSeen() {
  told.clear();
}
