// What the page knows of each machine's chats: their states (the chat
// host's watch, which the core sends every page as the chat plugin's
// message, protocol.ts StatesData, after the snapshot GET STATES_PATH the
// page reads when it starts and each time its event channel comes back),
// the chats that are no more, the agents each machine can start (GET
// agents, kept AGENTS_TTL_MS), and what the attached chats state
// (source.ts: their state, configuration and usage). The pane, the panel,
// the status widget and the panes' statuses (status.ts) read it.
//
// A machine's messages are numbered (rev): one at or below the rev the
// page has is passed over; one that changes chats while the page has no
// full list of the machine (before the snapshot came, or after a gap)
// waits for the snapshot, which is read again then.
import { create } from 'zustand';
import { chatKinds, type AgentKind } from '../../conversation/kinds';
import type { ChatInfo, Usage } from '../../conversation/model';
import { isPluginOn } from '../registry';
import { useSettings } from '../../settings';
import { useStore } from '../../state/store';
import { chatApi, MAX_CHATS, readStates, type States } from './api';
import { CHAT_PLUGIN } from './view';
import { STATE_DELETED, type AgentStatus, type ChatError, type ChatState } from './protocol';

/** How long a machine's list of agents is used before it is asked again. */
export const AGENTS_TTL_MS = 5 * 60_000;
/** The most chats that are no more remembered per machine. */
const MAX_DELETED = 500;
/** The most messages of a machine kept while its snapshot is read. */
const MAX_WAITING = 200;
/** The least time between two reads of the snapshot after a gap. */
export const SNAPSHOT_GAP_MS = 2_000;

/** Where an attached chat's subscription is: attaching, attached, waiting
 * for the page's connection or the machine (offline), the chat is no more
 * (gone), or the core refused it (failed, with the error). */
export type Link = 'attaching' | 'attached' | 'offline' | 'gone' | 'failed';

/** What an attached chat states (source.ts). */
export interface LiveChat {
  link: Link;
  linkError?: ChatError;
  /** The chat as the host stated it last (attach, info events). */
  info?: ChatInfo;
  /** Its state and why it failed (info and state events). */
  state?: string;
  error?: ChatError;
  usage?: Usage;
}

export interface ChatsState {
  /** By machine, then chat id. */
  states: Record<string, Record<string, ChatState>>;
  /** The machines whose every chat is in states (a full list came). */
  full: Record<string, true>;
  /** Chats that are no more (deleted, or removed by the host's limits), by
   * machine. */
  deleted: Record<string, Record<string, true>>;
  /** The agents each machine can start, and when that was asked. */
  agents: Record<string, { list: AgentStatus[]; at: number }>;
  /** What the attached chats state, by liveKey. */
  live: Record<string, LiveChat>;
}

const empty = (): ChatsState => ({ states: {}, full: {}, deleted: {}, agents: {}, live: {} });

export const useChats = create<ChatsState>(empty);

/** The key of a chat in ChatsState.live. */
export const liveKey = (m: string, chat: string) => `${m}\n${chat}`;

/** A chat's state as the page knows it. */
export function chatState(m: string, chat: string | undefined): ChatState | undefined {
  return chat === undefined ? undefined : useChats.getState().states[m]?.[chat];
}

/** Whether a chat is no more: the host said so, a full list came without
 * it, or attaching it found none. */
export function chatGone(s: ChatsState, m: string, chat: string): boolean {
  if (s.deleted[m]?.[chat]) return true;
  if (s.live[liveKey(m, chat)]?.link === 'gone') return true;
  return !!s.full[m] && !s.states[m]?.[chat];
}

function forget(deleted: Record<string, true> | undefined, ids: string[]): Record<string, true> {
  const out = { ...deleted };
  for (const id of ids) out[id] = true;
  const keys = Object.keys(out);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DELETED))) delete out[k];
  return out;
}

/** Takes states of machine m: every chat of it (full; one not among them
 * is gone), or those that changed; one in STATE_DELETED is no more. */
export function applyStates(m: string, list: readonly ChatState[], full: boolean) {
  useChats.setState((s) => {
    const next: Record<string, ChatState> = full ? {} : { ...s.states[m] };
    const gone: string[] = [];
    const back: string[] = [];
    for (const st of list) {
      if (st.state === STATE_DELETED) {
        delete next[st.id];
        gone.push(st.id);
      } else {
        next[st.id] = st;
        back.push(st.id);
      }
    }
    if (full) for (const id of Object.keys(s.states[m] ?? {})) if (!next[id]) gone.push(id);
    const ids = Object.keys(next);
    // Within the host's own bound: the oldest go.
    if (ids.length > MAX_CHATS)
      for (const id of ids.sort((a, b) => next[a].updated.localeCompare(next[b].updated)).slice(0, ids.length - MAX_CHATS)) delete next[id];
    let deleted = s.deleted;
    if (gone.length) deleted = { ...deleted, [m]: forget(deleted[m], gone) };
    // A chat there again is not gone.
    if (back.some((id) => deleted[m]?.[id])) {
      const d = { ...deleted[m] };
      for (const id of back) delete d[id];
      deleted = { ...deleted, [m]: d };
    }
    return { states: { ...s.states, [m]: next }, deleted, full: full ? { ...s.full, [m]: true } : s.full };
  });
}

/** Puts a chat the page made or opened into the states (until the host's
 * watch tells of it). */
export function upsertState(m: string, st: ChatState) {
  if (!useChats.getState().states[m]?.[st.id]) applyStates(m, [st], false);
}

// ---- the states messages and the snapshot ----

/** The rev of each machine's states the page has; none while it has no
 * full list of the machine. */
const revs = new Map<string, number>();
/** The messages of machines without a full list, until the snapshot. */
const waiting = new Map<string, States[]>();
let snapshot: Promise<void> | undefined;
let snapshotAt = 0;
/** Another read is owed once the one under way ended. */
let owed = false;
let owedTimer: ReturnType<typeof setTimeout> | undefined;

/** Reads the snapshot again: after the one under way, at most once in
 * SNAPSHOT_GAP_MS. */
function wantSnapshot() {
  if (snapshot) {
    owed = true;
    return;
  }
  const wait = SNAPSHOT_GAP_MS - (Date.now() - snapshotAt);
  if (wait <= 0) void loadSnapshot();
  else
    owedTimer ??= setTimeout(() => {
      owedTimer = undefined;
      void loadSnapshot();
    }, wait);
}

function take(m: string, st: States) {
  const have = revs.get(m);
  if (have !== undefined && st.rev !== 0 && st.rev <= have) return;
  if (have === undefined && !st.full) {
    const list = waiting.get(m) ?? [];
    list.push(st);
    waiting.set(m, list.slice(-MAX_WAITING));
    wantSnapshot();
    return;
  }
  if (have !== undefined && !st.full && st.rev > have + 1) {
    // A gap: what changed meanwhile is not known. This message holds, and
    // the snapshot tells the rest.
    applyStates(m, st.states, false);
    revs.set(m, st.rev);
    wantSnapshot();
    return;
  }
  applyStates(m, st.states, st.full);
  revs.set(m, st.rev);
}

/** Takes the chat plugin's message for machine m (StatesData). */
export function applyMessage(m: string, data: unknown) {
  follow();
  const st = readStates(data);
  if (st) take(m, st);
}

/** Reads every machine's states (GET STATES_PATH) and applies them, then
 * the messages that came meanwhile with a higher rev. */
export function loadSnapshot(): Promise<void> {
  snapshot ??= (async () => {
    snapshotAt = Date.now();
    try {
      const machines = await chatApi.states();
      for (const [m, st] of Object.entries(machines)) {
        const have = revs.get(m);
        if (have === undefined || st.rev >= have || st.rev === 0) {
          applyStates(m, st.states, true);
          revs.set(m, st.rev);
        }
      }
    } catch {
      // The messages that come keep what the page has.
    } finally {
      snapshot = undefined;
      for (const [m, list] of [...waiting]) {
        if (!revs.has(m)) continue;
        waiting.delete(m);
        for (const st of list) take(m, st);
      }
      if (owed) {
        owed = false;
        wantSnapshot();
      }
    }
  })();
  return snapshot;
}

/** Changes what an attached chat states (undefined: forgets it). */
export function setLive(m: string, chat: string, patch: Partial<LiveChat> | undefined) {
  const k = liveKey(m, chat);
  useChats.setState((s) => {
    if (!patch) {
      if (!(k in s.live)) return s;
      const live = { ...s.live };
      delete live[k];
      return { live };
    }
    const prev = s.live[k] ?? { link: 'attaching' };
    return { live: { ...s.live, [k]: { ...prev, ...patch } } };
  });
}

// ---- the agents ----

const asking = new Map<string, Promise<void>>();

/** Reads the agents machine m can start, unless asked within
 * AGENTS_TTL_MS (force: anyway). */
export function loadAgents(m: string, force = false): Promise<void> {
  const known = useChats.getState().agents[m];
  if (!force && known && Date.now() - known.at < AGENTS_TTL_MS) return Promise.resolve();
  let p = asking.get(m);
  if (!p) {
    p = chatApi
      .agents(m)
      .then((list) => useChats.setState((s) => ({ agents: { ...s.agents, [m]: { list, at: Date.now() } } })))
      .catch(() => {})
      .finally(() => asking.delete(m));
    asking.set(m, p);
  }
  return p;
}

/** The chat kinds to offer on machine m: those it can start once it said
 * which; every kind with a chat until then. */
export function offeredKinds(m: string): AgentKind[] {
  const known = useChats.getState().agents[m];
  const all = chatKinds();
  if (!known) return all;
  const ok = new Set(known.list.filter((a) => a.available).map((a) => a.kind));
  return all.filter((k) => ok.has(k.id));
}

// ---- following the page's connection and the machines ----

let following: (() => void) | undefined;

/** Starts, once per page: reads the snapshot now and each time the
 * page's event channel comes back (the revs start over with a core that
 * started again) or the plugin is turned on, and each machine's agents
 * when it is ready; all of it while the plugin is on. */
export function follow() {
  if (following) return;
  const ready = new Set<string>();
  let on = isPluginOn(CHAT_PLUGIN);
  const machines = () => {
    const all = useStore.getState().machines;
    for (const [m, st] of Object.entries(all)) {
      const now = on && st.status === 'ready';
      if (now && !ready.has(m)) {
        ready.add(m);
        void loadAgents(m, true);
      } else if (!now) ready.delete(m);
    }
    for (const m of [...ready]) if (!all[m]) ready.delete(m);
  };
  const again = () => {
    revs.clear();
    if (on) void loadSnapshot();
  };
  const offs = [
    useStore.subscribe((s, prev) => {
      if (s.machines !== prev.machines) machines();
      if (s.connected && !prev.connected) again();
    }),
    useSettings.subscribe(() => {
      const now = isPluginOn(CHAT_PLUGIN);
      if (now === on) return;
      on = now;
      machines();
      again();
    }),
  ];
  following = () => offs.forEach((off) => off());
  machines();
  if (on) void loadSnapshot();
}

/** Stops following and forgets everything (tests). */
export function resetChats() {
  following?.();
  following = undefined;
  revs.clear();
  waiting.clear();
  asking.clear();
  snapshot = undefined;
  snapshotAt = 0;
  owed = false;
  clearTimeout(owedTimer);
  owedTimer = undefined;
  useChats.setState(empty());
}
