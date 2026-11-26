// Watching the machines' chat hosts. While a machine is connected, the
// feature is on and its host is in use, the hub watches the host
// (Op.Watch): it keeps the states of the machine's chats, sends them to
// every page (StatesData), tells the pages' notifications when a chat
// becomes blocked or done (an agent event of the machine) and has the host
// configured with the machine's settings. A watch never starts a host, and
// it lets a host go that has nothing to watch (no chat with an agent
// process, no page's subscription, no use for lingerMs), so a machine whose
// chats nobody uses runs no host. A use of the host (a request, a page's
// subscription) makes a watch due again.
import * as agentkinds from '#shared/agents/kinds.ts';
import type { Logger } from '#shared/lib/log.ts';
import { retryDelay } from '#shared/lib/wait.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import type { AgentEvent, Machines } from '#kernel/machines/manager.ts';
import type { Configurer } from './configure.ts';
import { asChatError } from './errors.ts';
import type { HostLink } from './hostconn.ts';
import { NOT_RUNNING } from './protocol.ts';
import type { Timing } from './timing.ts';
import { chatState, DATA_STATES, stateOf, type StatesData, type StatesSnapshot } from './wire.ts';

/** How many watches in a row may fail before the hub waits for the next
 * use of the host, or the machine to connect again. */
export const MAX_FAILURES = 6;
const STABLE_WATCH_MS = 30_000;

/** The wait after the n-th failure in a row: first, doubled each time, at
 * most 5 minutes. */
export function backoff(firstMs: number, n: number): number {
  let d = firstMs;
  for (let i = 1; i < n && d < 300_000; i++) d *= 2;
  return Math.min(d, 300_000);
}

/** Whether a chat in state st has an agent process. */
const live = (st: chat.ChatState): boolean =>
  st.state === chat.State.Starting || st.state === chat.State.Idle || st.state === chat.State.Working || st.state === chat.State.Waiting;

const time = (s: string): number => {
  const t = Date.parse(s);
  return Number.isNaN(t) ? -Infinity : t;
};

/** states ordered as the host lists chats: the most recently updated first. */
const sorted = (states: Iterable<chat.ChatState>): chat.ChatState[] =>
  [...states].sort((a, b) => time(b.updated) - time(a.updated) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** A chat whose agent process is gone: sleeping, the status of a turn that
 * ran gone. */
const asleep = (st: chat.ChatState, stale: boolean): chat.ChatState => {
  const out = { ...st, stale };
  if (live(st)) {
    out.state = chat.State.Sleeping;
    if (st.status !== chat.Status.Done) out.status = chat.Status.Idle;
  }
  return stateOf(out);
};

/** What the hub knows of one machine's chat host and its watch of it. */
export interface Watched {
  readonly id: string;
  /** A watch runs (abort ends it); up: its stream told the states, and
   * they are current; since: when it came up; dropping: the hub ends it
   * because the host has nothing to watch. */
  running: boolean;
  up: boolean;
  dropping: boolean;
  abort?: AbortController;
  since: number;
  /** The states were read at least once since the hub started; stale: the
   * machine disconnected since they were last read; states are every
   * chat's, as last read; rev numbers the messages of them. */
  known: boolean;
  stale: boolean;
  states: Map<string, chat.ChatState>;
  rev: number;
  /** Per chat, the status and sequence number of its last agent
   * notification ("blocked@12"). */
  published: Map<string, string>;
  /** The version of the host the watch read last; "" once none serves. */
  hostVersion: string;
  /** A watch is to be tried, from retryAt on; failures counts those that
   * failed in a row. noChat: the machine has no chat host to give (an
   * agent of an older version): not tried until it connects again. ready:
   * the machine was connected at the last step. lastUse: when the hub
   * last used the host for a route or a page. */
  due: boolean;
  retryAt: number;
  failures: number;
  noChat: boolean;
  ready: boolean;
  lastUse: number;
}

export interface WatcherOptions {
  link: HostLink;
  config: Configurer;
  machines: Machines;
  /** Whether the feature is on (for any client). */
  enabled: () => boolean;
  /** Sends machine m's states to every page. */
  broadcast: (data: StatesData, m: string) => void;
  /** Tells the pages' notifications of a chat (an agent event). */
  publishAgent: (ev: AgentEvent) => void;
  /** The feature was turned off: the pages' subscriptions end. */
  turnedOff: () => void;
  /** This hub's build (agentproto's VERSION). */
  version: () => string;
  now: () => number;
  logger: Logger;
  timing: Timing;
}

export class Watcher {
  private readonly o: WatcherOptions;
  private readonly records = new Map<string, Watched>();
  /** The pages' subscriptions by machine. */
  private readonly inUseCount = new Map<string, number>();
  /** The feature was on at the last step. */
  private on = false;
  private wakeUp: (() => void) | null = null;
  private woken = false;

  constructor(o: WatcherOptions) {
    this.o = o;
  }

  /** The record of machine m, made when there is none. */
  record(m: string): Watched {
    let w = this.records.get(m);
    if (!w)
      this.records.set(
        m,
        (w = {
          id: m,
          running: false,
          up: false,
          dropping: false,
          since: 0,
          known: false,
          stale: false,
          states: new Map(),
          rev: 0,
          published: new Map(),
          hostVersion: '',
          due: false,
          retryAt: 0,
          failures: 0,
          noChat: false,
          ready: false,
          lastUse: 0,
        }),
      );
    return w;
  }

  /** Whether a watch of machine m is up (its states are current). */
  isUp(m: string): boolean {
    return this.records.get(m)?.up ?? false;
  }

  /** The machines whose records the hub keeps. */
  known(): string[] {
    return [...this.records.keys()];
  }

  /** Looks at the watches soon. */
  poke(): void {
    if (this.wakeUp) this.wakeUp();
    else this.woken = true;
  }

  /** Notes that the hub used machine m's chat host for a route or a page:
   * the host serves, so a watch is due if none runs. */
  used(m: string): void {
    const w = this.record(m);
    w.lastUse = this.o.now();
    w.noChat = false;
    if (!w.running) Object.assign(w, { due: true, retryAt: 0, failures: 0 });
    this.poke();
  }

  /** Counts a page's subscription to machine m (n is 1 or -1). */
  inUse(m: string, n: number): void {
    const c = (this.inUseCount.get(m) ?? 0) + n;
    if (c <= 0) this.inUseCount.delete(m);
    else this.inUseCount.set(m, c);
    this.record(m).lastUse = this.o.now();
  }

  /** How many chats of machine m the hub knows (0 before it read them). */
  chatCount(m: string): number {
    const w = this.records.get(m);
    return w?.known ? w.states.size : 0;
  }

  /** A states message of w with states, stamped with its host's build. */
  private data(w: Watched, states: chat.ChatState[], full: boolean): StatesData {
    return {
      t: DATA_STATES,
      states: states.map(stateOf),
      full,
      ...(w.stale ? { stale: true } : {}),
      rev: w.rev,
      ...(w.hostVersion ? { hostVersion: w.hostVersion } : {}),
      ...(w.hostVersion && w.hostVersion !== this.o.version() ? { outdated: true } : {}),
    };
  }

  /** The states of every machine's chats the hub read. */
  snapshot(): StatesSnapshot {
    const machines: Record<string, StatesData> = {};
    for (const [m, w] of this.records) if (w.known) machines[m] = this.data(w, sorted(w.states.values()), true);
    return { machines };
  }

  /** The machines connected now. */
  private ready(): Set<string> {
    return new Set(
      this.o.machines
        .list()
        .filter((m) => m.ready)
        .map((m) => m.id),
    );
  }

  /** Watches until signal ends. */
  async run(signal: AbortSignal): Promise<void> {
    const unsubscribe = this.o.machines.subscribe({ state: () => this.poke() });
    try {
      while (!signal.aborted) {
        this.step(signal);
        await this.wait(signal);
      }
    } finally {
      unsubscribe();
      for (const w of this.records.values()) if (w.running) w.abort?.abort();
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    if (this.woken || signal.aborted) {
      this.woken = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        this.wakeUp = null;
        resolve();
      };
      const timer = setTimeout(done, this.o.timing.tickMs);
      signal.addEventListener('abort', done, { once: true });
      this.wakeUp = done;
    });
  }

  /** Starts the watches that are due and ends those of machines that left,
   * of a feature turned off, and of hosts that have nothing to watch. */
  step(signal: AbortSignal): void {
    const on = this.o.enabled();
    const ready = on ? this.ready() : new Set<string>();
    const now = this.o.now();
    const turnedOn = on && !this.on;
    const turnedOff = !on && this.on;
    this.on = on;
    for (const m of ready) {
      const w = this.record(m);
      if (!w.ready || turnedOn) Object.assign(w, { ready: true, due: true, noChat: false, failures: 0, retryAt: 0 });
    }
    const stale: Array<[string, StatesData]> = [];
    for (const [m, w] of this.records) {
      if (!ready.has(m)) {
        w.ready = false;
        if (w.running) w.abort?.abort();
        if (!this.o.machines.get(m) && !w.running) {
          // A machine the user removed.
          this.records.delete(m);
          continue;
        }
        if (on) {
          const d = this.markStale(w);
          if (d) stale.push([m, d]);
        }
        continue;
      }
      if (w.running) {
        if (w.up && !w.dropping && this.quiet(w, now)) {
          w.dropping = true;
          w.abort?.abort();
        }
        continue;
      }
      if (!w.due || w.noChat || now < w.retryAt) continue;
      w.running = true;
      w.due = false;
      const ac = new AbortController();
      const stop = () => ac.abort();
      signal.addEventListener('abort', stop, { once: true });
      w.abort = ac;
      void this.watch(ac.signal, w).finally(() => signal.removeEventListener('abort', stop));
    }
    for (const [m, d] of stale) this.o.broadcast(d, m);
    if (turnedOff) this.o.turnedOff();
  }

  /** Marks an offline machine's states as stale, so that its chats never
   * appear working or blocked while it is away; the message to send, once. */
  markStale(w: Watched): StatesData | undefined {
    if (!w.known || w.stale) return undefined;
    w.stale = true;
    for (const [id, st] of w.states) w.states.set(id, asleep(st, true));
    w.rev++;
    return this.data(w, sorted(w.states.values()), true);
  }

  /** Whether the hub has nothing to watch on w's host: no chat with an
   * agent process, no page's subscription, and no use for linger. */
  private quiet(w: Watched, now: number): boolean {
    const linger = this.o.timing.lingerMs;
    return (
      ![...w.states.values()].some(live) && (this.inUseCount.get(w.id) ?? 0) === 0 && now - w.lastUse >= linger && now - w.since >= linger
    );
  }

  /** Runs one watch of w's host until it ends, and notes how it ended. */
  private async watch(signal: AbortSignal, w: Watched): Promise<void> {
    let err: unknown;
    try {
      await this.watchOnce(signal, w);
    } catch (e) {
      err = e;
    }
    this.ended(signal, w, err);
    this.poke();
  }

  /** Connects to the host without starting one, reads every chat's state
   * and then each change until the stream ends. */
  private async watchOnce(signal: AbortSignal, w: Watched): Promise<void> {
    const c = await this.o.link.dial(w.id, { start: false, reserved: true, signal });
    try {
      const res = await c.send({ op: chat.Op.Watch });
      if (!this.up(signal, w, c.info, (res.states ?? []).map(stateOf))) throw signal.reason;
      this.o.config.configure(w.id, signal);
      for (;;) {
        let line: Buffer;
        try {
          line = await c.readLine();
        } catch (e) {
          throw c.broken(e);
        }
        let st: chat.ChatState;
        try {
          const r = chatState.safeParse(JSON.parse(line.toString('utf8')));
          if (!r.success) continue;
          st = stateOf(r.data);
        } catch {
          continue;
        }
        if (!chat.validChatID(st.id)) continue;
        if (!this.change(signal, w, st)) throw signal.reason;
      }
    } finally {
      c.close();
    }
  }

  /** Notes how a watch ended and when the next one is due. */
  private ended(signal: AbortSignal, w: Watched, err: unknown): void {
    const code = err === undefined ? '' : asChatError(err).code;
    const { up: wasUp, dropping, hostVersion: wasHost } = w;
    w.running = w.up = w.dropping = false;
    const now = this.o.now();
    let gone: StatesData | undefined;
    if (dropping) {
      // The hub ended it as the host had nothing to watch; a use since
      // makes the next one due.
      if (!this.quiet(w, now)) w.due = true;
    } else if (signal.aborted) {
      // The hub ended it: the machine left, the feature was turned off,
      // the hub stops.
    } else if (code === NOT_RUNNING) {
      // No host serves, so no agent runs: chats the hub still knows with
      // one are sleeping now, the status of a turn that ran gone.
      const wasStale = w.stale;
      w.stale = false;
      w.hostVersion = '';
      const changed: chat.ChatState[] = [];
      for (const [id, st] of w.states) {
        const next = asleep(st, false);
        if ((wasStale && st.stale) || live(st)) changed.push(next);
        w.states.set(id, next);
      }
      if (changed.length > 0 || wasHost !== '') {
        w.rev++;
        gone = this.data(w, sorted(changed), false);
      }
    } else if (code === 'unknown_plugin' || code === chat.Code.Unsupported) {
      w.noChat = true;
    } else if (wasUp && now - w.since >= STABLE_WATCH_MS) {
      // The host ended or the stream broke: look again soon.
      w.due = true;
      w.failures = 0;
      w.retryAt = now + retryDelay(this.o.timing.againMs);
    } else {
      w.failures++;
      if (w.failures < MAX_FAILURES) {
        w.due = true;
        w.retryAt = now + retryDelay(backoff(this.o.timing.retryMs, w.failures));
      }
      if (code !== 'offline') this.o.logger(`chat: watch of ${w.id}: ${asChatError(err).message}`);
    }
    if (gone) this.o.broadcast(gone, w.id);
  }

  /** Whether st, which follows old (had: the hub knew the chat), is a
   * notification: a chat that became blocked or done, never the same
   * status at the same sequence number twice. Of the first states the hub
   * reads of a machine (initial), only the blocked ones are: what ended
   * before the hub started was told by the hub of then, and what waits
   * for the user is to be answered still. After a gap in the watch (gap:
   * the states a watch read first, not the hub's first), a chat done at a
   * later sequence number than it was is a turn that ran and ended
   * meanwhile, done again. */
  private publishes(w: Watched, st: chat.ChatState, old: chat.ChatState | undefined, initial: boolean, gap: boolean): boolean {
    if (st.status !== chat.Status.Blocked && st.status !== chat.Status.Done) return false;
    const key = `${st.status}@${st.seq}`;
    const doneAgain = gap && st.status === chat.Status.Done && st.seq > (old?.seq ?? 0);
    if (w.published.get(st.id) === key) return false;
    if (initial && st.status !== chat.Status.Blocked) return false;
    if (!initial && old && old.status === st.status && !doneAgain) return false;
    w.published.set(st.id, key);
    return true;
  }

  /** Takes the states a watch of host read first: every chat's. False: the
   * watch was ended meanwhile (the machine left, and its states are stale
   * now), and they are not taken. */
  up(signal: AbortSignal, w: Watched, host: chat.HostInfo, states: chat.ChatState[]): boolean {
    if (signal.aborted) return false;
    const initial = !w.known;
    const prev = w.states;
    w.states = new Map();
    const notes: chat.ChatState[] = [];
    for (const raw of states) {
      if (!chat.validChatID(raw.id) || raw.state === chat.State.Deleted) continue;
      const st = stateOf({ ...raw, stale: false });
      w.states.set(st.id, st);
      if (this.publishes(w, st, prev.get(st.id), initial, !initial)) notes.push(st);
    }
    for (const id of w.published.keys()) if (!w.states.has(id)) w.published.delete(id);
    Object.assign(w, { known: true, stale: false, up: true, since: this.o.now(), hostVersion: host.version });
    w.rev++;
    this.tell(w.id, this.data(w, sorted(w.states.values()), true), notes);
    return true;
  }

  /** Takes a chat's new state. False: the watch was ended meanwhile, and it
   * is not taken. */
  change(signal: AbortSignal, w: Watched, st: chat.ChatState): boolean {
    if (signal.aborted) return false;
    const old = w.states.get(st.id);
    const notes: chat.ChatState[] = [];
    if (st.state === chat.State.Deleted) {
      w.states.delete(st.id);
      w.published.delete(st.id);
    } else {
      w.states.set(st.id, st);
      if (this.publishes(w, st, old, false, false)) notes.push(st);
    }
    w.rev++;
    this.tell(w.id, this.data(w, [st], false), notes);
    return true;
  }

  /** Sends machine m's states to the pages, then the notifications. A
   * machine's are sent by its one watch, in the order of their rev. */
  private tell(m: string, data: StatesData, notes: chat.ChatState[]): void {
    this.o.broadcast(data, m);
    for (const st of notes)
      this.o.publishAgent({
        m,
        data: {
          agent: st.kind,
          agent_status: st.status,
          chat: st.id,
          display_agent: agentkinds.byId(st.kind)?.title ?? st.kind,
          terminal: '',
          title: st.title,
        },
      });
  }

  /** Drops what the hub keeps of a removed machine. */
  forget(m: string): void {
    const w = this.records.get(m);
    w?.abort?.abort();
    this.records.delete(m);
    this.inUseCount.delete(m);
  }
}
