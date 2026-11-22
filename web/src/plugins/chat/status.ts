// The chat panes' agent statuses (plugins/api.ts ViewStatusDef), from the
// chats' states (state.ts): a pane is working, blocked (a permission or a
// question waits), done (a turn ended that nobody saw) or idle as its chat
// is. An agent notification of a chat (the core's, with member chat)
// points to the pane that shows that chat; seeing a pane whose chat is
// done tells the host (POST seen with the chat's last seq), which ends
// done for every page. The pane shows the chat idle from then on; a POST
// that fails is tried again later (SEEN_RETRY_MS, doubling, SEEN_TRIES
// times), never at once: after the last try, the next state of the chat
// done asks again.
import { useStore } from '../../state/store';
import type { AgentStatus } from '../../lib/machine';
import type { UnopenedAgent, ViewStatusDef } from '../api';
import { chatApi } from './api';
import { agentName, openChat } from './ops';
import { CHAT_STATUSES, isChatId } from './protocol';
import { chatState, follow, useChats } from './state';
import { chatPane, chatRef } from './view';

export { chatPane };

/** The seq up to which each chat was said to be seen, by machine and chat;
 * the oldest forgotten past MAX_TOLD. */
const told = new Map<string, number>();
const MAX_TOLD = 4000;

/** The wait before a failed seen is sent again, doubled each time up to
 * SEEN_RETRY_MAX_MS, and how many times it is sent in all. */
export const SEEN_RETRY_MS = 2_000;
export const SEEN_RETRY_MAX_MS = 60_000;
export const SEEN_TRIES = 8;

/** The retries that wait, by machine and chat. */
const retries = new Map<string, ReturnType<typeof setTimeout>>();

/** Tells the host that the user saw the chat up to seq (the tries-th
 * time); a failure is tried again later while it is still what was told. */
function tell(m: string, chat: string, seq: number, tries: number) {
  const k = `${m}\n${chat}`;
  chatApi.seen(m, chat, seq).catch(() => {
    if (told.get(k) !== seq) return;
    if (tries + 1 >= SEEN_TRIES) {
      // Given up: the next state that says done asks again.
      told.delete(k);
      return;
    }
    clearTimeout(retries.get(k));
    retries.set(
      k,
      setTimeout(
        () => {
          retries.delete(k);
          if (told.get(k) === seq && !useStore.getState().readOnly) tell(m, chat, seq, tries + 1);
        },
        Math.min(SEEN_RETRY_MS * 2 ** tries, SEEN_RETRY_MAX_MS),
      ),
    );
  });
}

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
    clearTimeout(retries.get(k));
    retries.delete(k);
    tell(m, chat, st.seq, 0);
  },
  unopened(m) {
    const states = useChats.getState().states[m];
    if (!states) return [];
    const out: UnopenedAgent[] = [];
    for (const st of Object.values(states)) {
      if (st.archived || (st.status !== 'blocked' && st.status !== 'done' && st.status !== 'working')) continue;
      if (chatPane(m, st.id)) continue;
      out.push({
        id: `chat:${st.id}`,
        title: st.title || agentName(st.kind),
        directory: st.cwd || undefined,
        status: st.status as AgentStatus,
        open: () => void openChat(m, st.id, st.kind),
      });
    }
    return out;
  },
  openTarget(target) {
    if (target.kind !== 'chat') return;
    const kind = target.agent || chatState(target.machine, target.chat)?.kind || '';
    return openChat(target.machine, target.chat, kind).then(() => {});
  },
};

/** Forgets what was said to be seen (tests). */
export function resetSeen() {
  told.clear();
  for (const timer of retries.values()) clearTimeout(timer);
  retries.clear();
}
