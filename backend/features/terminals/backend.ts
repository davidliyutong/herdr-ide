// A machine's backend: the core's connection to the machine's terminal
// core, shared by the clients that subscribed to the machine. The first
// subscriber starts it; it brings the terminal core up (lifecycle.ts),
// dials it through the agent (op hc-api), keeps its terminal records as
// the events describe them and passes the events on to the subscribers;
// it retries with backoff after a failure, at once when its machine
// connects, and closes its connection idleMs after its last subscriber
// left (the terminal core and its programs keep running).
import type { Duplex } from 'node:stream';
import type { Logger } from '#shared/lib/log.ts';
import { isChatHostName, Op } from '#shared/proto/agentproto/index.ts';
import { Conn, type CoreInfo, type Events, type Hello, type Notification, type Stream, type Subscribed } from '#shared/proto/hc/index.ts';
import { pairDuplex } from '#shared/proto/yamux.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import type { Machines } from '#kernel/machines/manager.ts';
import type { HCState } from '#kernel/machines/spec.ts';
import { Agents, followAgents, type AgentHost } from './agents.ts';
import { ensure, type LifecycleDeps } from './lifecycle.ts';
import { Code, type BackendState } from './messages.ts';
import { hiddenRecord, indexTerminals, isObject, localName, otherMachine, visibleList, type Rec } from './records.ts';
import type { Timing } from './timing.ts';

/** A client's stream of a terminal, as its backend sees it. */
export interface ClientStream {
  readonly stream: Stream;
  /** The machine it was attached on, and its terminal's address. */
  readonly machine: string;
  readonly terminal: string;
  /** The client's last focus report for it. */
  readonly focused: boolean;
}

/** A client that subscribed to the machine. */
export interface Subscriber {
  /** Sends a text message. */
  send(text: string): void;
  /** Its streams. */
  streams(): Iterable<ClientStream>;
  /** The backend was dropped (its machine was removed): the client no
   * longer follows it. */
  dropped(machine: string, b: Backend): void;
}

export interface BackendDeps extends LifecycleDeps {
  machines: Machines;
  logger: Logger;
  /** Whether the machines resolve the sessions of the agents in their
   * terminals. */
  sessions: () => boolean;
  /** Told whether the machine's terminal core is ready, at each state. */
  onReady?: (m: Machine, ready: boolean) => void;
  timing: Timing;
  /** Ends every backend: the core stops. */
  signal: AbortSignal;
}

/** Why a terminal a client names is none of the clients': a hidden one
 * (also the name kept for the chat host, whether one runs or not), or one
 * of another machine — the terminal core's own machines are the core's,
 * each with a terminal core of its own, and a client reaches none through
 * another's. */
export class NotClients extends Error {
  readonly reason: 'hidden' | 'machine';

  constructor(reason: 'hidden' | 'machine') {
    super(reason === 'hidden' ? 'a hidden terminal' : 'a terminal of another machine');
    this.reason = reason;
  }
}

/** A wait that wake() or an abort ends early; a wake while nobody waits
 * ends the next wait at once. */
class Wake {
  private pending = false;
  private wakeUp: (() => void) | null = null;

  wake(): void {
    if (this.wakeUp) this.wakeUp();
    else this.pending = true;
  }

  until(ms: number, signal: AbortSignal): Promise<'woken' | 'timeout' | 'aborted'> {
    if (signal.aborted) return Promise.resolve('aborted');
    if (this.pending) {
      this.pending = false;
      return Promise.resolve('woken');
    }
    return new Promise((resolve) => {
      const done = (why: 'woken' | 'timeout' | 'aborted') => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.wakeUp = null;
        resolve(why);
      };
      const timer = setTimeout(() => done('timeout'), ms);
      const onAbort = () => done('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      this.wakeUp = () => done('woken');
    });
  }
}

export class Backend implements AgentHost {
  readonly id: string;
  readonly agents: Agents;
  /** The terminal core was stopped from the UI: the backend starts none
   * until it is started again, or until the backend starts anew. */
  stopped = false;

  private state: BackendState = 'starting';
  private code = '';
  private version = '';
  /** The machine was removed: the backend publishes nothing more (a machine
   * added again under the same id has a backend of its own). */
  private gone = false;
  private conn: Conn | null = null;
  /** Counts the connections that became ready, so that what one started
   * (its agent detection) changes nothing of the next. */
  private generation = 0;
  /** How the terminal core calls itself: an address may say its id or its
   * name before a terminal of its own ("box/t7"). */
  private core: CoreInfo = { id: '', name: '' };
  /** The clients' terminals by address, as the core reports them. */
  private terms = new Map<string, Rec>();
  /** The addresses of the hidden terminals, which are not in terms. */
  private hidden = new Set<string>();
  private readonly subs = new Set<Subscriber>();
  /** typing counts, by terminal, the clients' streams that set its size
   * (the ones not observing). parked is the stream of the last of them to
   * leave, kept attached and unread until the next one has attached or the
   * terminal ends: herdr-core gives a terminal without such a viewer its
   * headless size, and a full-screen program would lay itself out for that
   * whenever no page shows it. Both are of the connection now. */
  private readonly typing = new Map<string, number>();
  private readonly parked = new Map<string, Stream>();
  /** The clients' streams attached through the backend, which end when
   * their terminal becomes hidden. */
  private readonly tracked = new Set<ClientStream>();
  /** The running connection loop; null while the backend rests. */
  private run: AbortController | null = null;
  private readonly wakeup = new Wake();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly d: BackendDeps;

  constructor(id: string, d: BackendDeps) {
    this.id = id;
    this.d = d;
    this.agents = new Agents(this);
  }

  /** How the terminal core calls itself (its hello's core). */
  coreInfo(): CoreInfo {
    return { ...this.core };
  }

  /** The connection while the backend is ready. */
  connection(): Conn | null {
    return this.conn;
  }

  // AgentHost

  record(addr: string): Rec | undefined {
    return this.terms.get(addr);
  }

  isHidden(addr: string): boolean {
    return this.hidden.has(addr);
  }

  focused(addr: string): boolean {
    for (const c of this.subs) for (const ts of c.streams()) if (ts.machine === this.id && ts.terminal === addr && ts.focused) return true;
    return false;
  }

  label(addr: string, labels: Record<string, string>): void {
    const conn = this.conn;
    if (!conn) return;
    conn
      .call('terminal.label', { labels, terminal: addr }, { signal: AbortSignal.timeout(this.d.timing.labelMs) })
      .catch((e: Error) => this.d.logger(`term ${this.id}: label ${addr} seen: ${e.message}`));
  }

  broadcast(msg: object): void {
    if (this.subs.size === 0) return;
    const text = JSON.stringify(msg);
    for (const c of this.subs) c.send(text);
  }

  notify(data: object): void {
    this.d.machines.publishAgent({ m: this.id, data });
  }

  // Subscribers

  private stateMsg(): object {
    return { t: 'backend', m: this.id, state: this.state, code: this.code, version: this.version };
  }

  private snapshotMsg(): object {
    return { t: 'snapshot', m: this.id, terminals: [...this.terms.values()] };
  }

  /** Adds c and tells it the backend's state and, when it is ready, its
   * terminals; the first subscriber starts the backend. */
  subscribe(c: Subscriber): void {
    if (this.subs.has(c)) return;
    this.subs.add(c);
    clearTimeout(this.idle);
    this.idle = undefined;
    c.send(JSON.stringify(this.stateMsg()));
    if (this.state === 'ready') c.send(JSON.stringify(this.snapshotMsg()));
    if (!this.run) this.start();
  }

  /** Removes c; a backend without subscribers closes its connection after
   * idleMs. */
  unsubscribe(c: Subscriber): void {
    if (!this.subs.delete(c) || this.subs.size > 0 || !this.run) return;
    this.idle = setTimeout(() => {
      this.idle = undefined;
      if (this.subs.size > 0 || !this.run) return;
      this.run.abort();
      this.run = null;
      this.publish();
    }, this.d.timing.idleMs);
  }

  /** Ends the wait before the next try (the machine connected, or its core
   * was started from the UI). */
  wakeUp(): void {
    this.wakeup.wake();
  }

  /** Drops the backend of a removed machine: its connection closes and its
   * clients no longer count it as subscribed. */
  close(): void {
    this.gone = true;
    clearTimeout(this.idle);
    this.idle = undefined;
    this.run?.abort();
    this.run = null;
    const subs = [...this.subs];
    this.subs.clear();
    for (const c of subs) c.dropped(this.id, this);
  }

  /** Brings the machine's terminal core up from the UI (lifecycle.ensure);
   * "" or the code of why not. */
  ensure(restart: boolean, signal: AbortSignal): Promise<string> {
    const m = this.d.machines.get(this.id);
    if (!m) return Promise.resolve(Code.Offline);
    return ensure(m, { restart, stopped: () => this.stopped, id: this.id, signal, timeoutMs: this.d.timing.ensureMs }, this.d);
  }

  /** Shows the backend's state in its machine's state. */
  private publish(): void {
    if (this.gone) return;
    const st: HCState | undefined = this.run
      ? { state: this.state, ...(this.code ? { code: this.code } : {}), ...(this.version ? { version: this.version } : {}) }
      : undefined;
    const m = this.d.machines.get(this.id);
    if (!m) return;
    m.setHC(st);
    this.d.onReady?.(m, st?.state === 'ready');
  }

  private setState(state: BackendState, code: string): void {
    if (state !== 'ready') this.disconnected();
    if (this.state === state && this.code === code) return;
    this.state = state;
    this.code = code;
    this.broadcast(this.stateMsg());
    this.publish();
  }

  /** Forgets what was of the connection; the streams kept for terminals'
   * sizes went with it. */
  private disconnected(): void {
    this.conn = null;
    this.terms = new Map();
    this.hidden = new Set();
    for (const st of this.parked.values()) st.close();
    this.parked.clear();
    this.typing.clear();
  }

  private start(): void {
    const ac = new AbortController();
    this.run = ac;
    this.stopped = false;
    void this.loop(ac, AbortSignal.any([ac.signal, this.d.signal]));
  }

  private async loop(ac: AbortController, signal: AbortSignal): Promise<void> {
    const t = this.d.timing;
    let backoff = t.backoffMinMs;
    while (!signal.aborted) {
      const started = Date.now();
      const code = await this.serve(signal).catch((e: Error) => {
        this.d.logger(`term ${this.id}: ${e.message}`);
        return Code.Lost;
      });
      if (signal.aborted) break;
      this.setState('error', code);
      if (Date.now() - started > t.stableMs) backoff = t.backoffMinMs;
      const why = await this.wakeup.until(backoff, signal);
      if (why === 'woken') backoff = t.backoffMinMs;
      else if (why === 'timeout') backoff = Math.min(backoff * 2, t.backoffMaxMs);
    }
    // A run that another took the place of leaves the state to it.
    if (this.run !== ac && this.run !== null) return;
    this.run = null;
    this.disconnected();
    this.state = 'starting';
    this.code = '';
    this.publish();
  }

  /** Connects to the machine's terminal core and passes its events on
   * until the connection ends; returns the code of why. */
  private async serve(signal: AbortSignal): Promise<string> {
    const t = this.d.timing;
    const m = this.d.machines.get(this.id);
    if (!m) return Code.Offline;
    this.setState('starting', '');
    const code = await ensure(m, { restart: false, stopped: () => this.stopped, id: this.id, signal, timeoutMs: t.ensureMs }, this.d);
    if (code || signal.aborted) return code;
    const dial = AbortSignal.any([signal, AbortSignal.timeout(t.dialMs)]);
    let rw: Duplex;
    try {
      const { conn } = await m.open({ op: Op.HCAPI }, { signal: dial, timeoutMs: t.dialMs });
      const rest = conn.reader.release();
      rw = rest === conn.stream ? conn.stream : pairDuplex(rest, conn.stream);
    } catch {
      return Code.Connect;
    }
    let conn: Conn;
    let hello: Hello;
    try {
      ({ conn, hello } = await Conn.dial(rw, dial));
    } catch (e) {
      this.d.logger(`term ${this.id}: ${(e as Error).message}`);
      return Code.Connect;
    }
    const detect = new AbortController();
    const quiet = new AbortController();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      let events: Events;
      let subscribed: Subscribed;
      try {
        ({ events, subscribed } = await conn.subscribe({}, { signal: dial }));
      } catch {
        return Code.Connect;
      }
      if (signal.aborted) return '';
      this.conn = conn;
      this.version = hello.version ?? '';
      this.core = hello.core ?? { id: '', name: '' };
      ({ terms: this.terms, hidden: this.hidden } = indexTerminals(subscribed.terminals ?? []));
      this.agents.reset();
      this.state = 'ready';
      this.code = '';
      if (this.subs.size) {
        const state = JSON.stringify(this.stateMsg());
        const snap = JSON.stringify(this.snapshotMsg());
        for (const c of this.subs) {
          c.send(state);
          c.send(snap);
        }
      }
      this.publish();
      // Which coding agents run in the terminals, while this connection
      // lasts.
      const gen = ++this.generation;
      void followAgents(m, this.agents, {
        sessions: this.d.sessions,
        signal: AbortSignal.any([signal, detect.signal]),
        current: () => this.generation === gen && !this.gone,
        timing: t,
      });
      const recv = AbortSignal.any([signal, quiet.signal]);
      watchdog = setTimeout(() => quiet.abort(), t.silenceMs);
      for (;;) {
        let n: Notification;
        try {
          n = await events.recv(recv);
        } catch {
          return Code.Lost;
        }
        // What was queued before the run ended is not the next run's.
        if (signal.aborted) return '';
        watchdog.refresh();
        try {
          this.event(n);
        } catch (e) {
          this.d.logger(`term ${this.id}: event ${n.type || n.method}: ${(e as Error).message}`);
        }
      }
    } finally {
      clearTimeout(watchdog);
      detect.abort();
      conn.close();
    }
  }

  // Terminal records and events

  /** Applies a notification to the terminals, as herdr-core's API
   * describes each type, and passes it on to the subscribers. */
  private event(n: Notification): void {
    if (n.method === 'missed') {
      // The snapshot is the whole state.
      ({ terms: this.terms, hidden: this.hidden } = indexTerminals(n.terminals ?? []));
      for (const addr of this.terms.keys()) this.agents.merge(addr);
      // What runs in a terminal hidden meanwhile is no longer the clients'
      // to know, and their streams of it end.
      for (const addr of this.hidden) {
        this.agents.forget(addr);
        this.closeStreams(addr);
      }
      // The events missed may have ended terminals: a parked stream of one
      // gone or over ends too.
      for (const addr of [...this.parked.keys()]) if (this.terms.get(addr)?.state !== 'live') this.unpark(addr);
      this.broadcast(this.snapshotMsg());
      return;
    }
    if (n.method !== 'event') return;
    // Another machine's terminals and documents are none of the clients'.
    if (otherMachine(n.terminal) || n.machine) return;
    const data = isObject(n.data) ? n.data : null;
    const addr = n.terminal;
    if (addr) {
      if (this.conceal(n, data)) return;
      const t = this.terms.get(addr);
      switch (n.type) {
        case 'created':
        case 'restarted':
          // A copy: what is merged into the record is not in the event.
          this.terms.set(addr, data ? structuredClone(data) : {});
          this.agents.merge(addr);
          break;
        case 'removed':
          this.terms.delete(addr);
          this.unpark(addr);
          break;
        case 'labels':
          if (isObject(data?.record)) {
            this.terms.set(addr, structuredClone(data.record));
            this.agents.merge(addr);
          } else if (t) t.labels = data?.labels ?? null;
          break;
        case 'turn':
          if (!t) break;
          t.turn = data?.turn ?? null;
          this.agents.keepSeen(addr);
          break;
        default: // lost, keep, finished, status, title, size, foreground
          if (!t) break;
          if (n.type === 'foreground') {
            if (n.data === undefined || n.data === null) delete t.foreground;
            else t.foreground = data;
            break;
          }
          if (data) Object.assign(t, data);
          if (n.type === 'finished') {
            t.state = 'finished';
            delete t.foreground;
            this.unpark(addr);
          } else if (n.type === 'lost') {
            delete t.pid;
            delete t.foreground;
          } else if (n.type === 'status') {
            // A done seen before its report reached the core.
            this.agents.keepSeen(addr);
          }
      }
    }
    const msg: Record<string, unknown> = { t: 'event', m: this.id, type: n.type };
    if (addr) msg.terminal = addr;
    if (n.data !== undefined) msg.data = n.data;
    this.broadcast(msg);
    // A record replaced by the event lacks the agent the core knows of:
    // clients get it again right behind.
    if (addr && (n.type === 'created' || n.type === 'restarted' || n.type === 'labels')) {
      const again = this.agents.again(addr);
      if (again) this.broadcast(again);
    }
  }

  /** Whether an event is about a hidden terminal, which is then none of the
   * clients'; keeps the hidden set: a terminal that is created hidden, or
   * becomes so (gets the label), is hidden, and the clients that knew it
   * are told that it was removed and lose their streams of it; one that is
   * hidden stays so until it is removed, whatever becomes of its labels. */
  private conceal(n: Notification, data: Rec | null): boolean {
    const addr = n.terminal;
    if (this.hidden.has(addr)) {
      if (n.type === 'removed') this.hidden.delete(addr);
      return true;
    }
    let rec: unknown = data; // created, restarted: the terminal's record
    switch (n.type) {
      case 'created':
      case 'restarted':
        break;
      case 'labels':
        // All its labels now; its name is in the record the clients have.
        rec = isObject(data?.record) ? data.record : { labels: data?.labels, name: this.terms.get(addr)?.name };
        break;
      default:
        return false;
    }
    if (!hiddenRecord(rec)) return false;
    this.hidden.add(addr);
    this.agents.forget(addr);
    if (this.terms.delete(addr)) this.broadcast({ t: 'event', m: this.id, type: 'removed', terminal: addr, data: {} });
    // Streams attached before it was hidden, while it was not yet known as
    // hidden, or in the instant before.
    this.closeStreams(addr);
    return true;
  }

  /** Marks a terminal's ended turn seen (a client focused it). */
  seen(addr: string): void {
    this.agents.seen(addr);
  }

  // What clients name

  /** target, a terminal as a client names it, as the core names one of the
   * clients' terminals, known without asking the core: null for another
   * machine's or a hidden one (by its address or the chat host's name). */
  localTarget(target: string): string | null {
    const local = localName(target, this.core);
    if (local === null || this.hidden.has(local) || isChatHostName(local)) return null;
    return local;
  }

  /** The address of the terminal target names, as the terminal core reads
   * it. A terminal the clients know is named by its address (also after
   * the core's own id or name); any other target (a name, or the address
   * of a terminal whose creation has not reached the backend yet, or that
   * is hidden and whose event has not) is looked up with terminal.get
   * first, and the call that follows names the terminal found by its
   * address: what a name names can change, an address cannot. Throws
   * NotClients for a terminal that is none of the clients', without asking
   * the core when the backend knows; the core's error when the lookup
   * fails. */
  async resolve(target: string, conn: Conn, signal: AbortSignal): Promise<string> {
    const local = localName(target, this.core);
    if (local === null) throw new NotClients('machine');
    if (this.hidden.has(local) || isChatHostName(local)) throw new NotClients('hidden');
    if (this.terms.has(local)) return local;
    const rec = await conn.call<unknown>('terminal.get', { terminal: local }, { signal });
    const addr = isObject(rec) && typeof rec.address === 'string' ? rec.address : '';
    if (!addr) throw new Error('hc: terminal.get: a record without an address');
    if (otherMachine(addr)) throw new NotClients('machine');
    if (hiddenRecord(rec) || this.hidden.has(addr)) throw new NotClients('hidden');
    return addr;
  }

  /** The result of terminal.list with only the clients' terminals;
   * undefined for a result that is no list of terminals. */
  visible(result: unknown): unknown {
    return visibleList(result, (addr) => this.hidden.has(addr));
  }

  /** The addresses of the clients' live terminals, sorted. */
  live(): string[] {
    return [...this.terms.entries()]
      .filter(([, rec]) => rec.state === 'live')
      .map(([addr]) => addr)
      .sort();
  }

  // Streams

  /** Counts a client's stream that sets terminal's size, attached through
   * conn; the stream parked for the terminal ends now that it has another
   * viewer. */
  joined(conn: Conn, terminal: string): void {
    if (this.conn !== conn) return;
    this.typing.set(terminal, (this.typing.get(terminal) ?? 0) + 1);
    const old = this.parked.get(terminal);
    this.parked.delete(terminal);
    old?.close();
  }

  /** Takes a stream that set terminal's size from the client that had it.
   * With park (the client let go of it, the terminal lives on) the last one
   * of a terminal stays attached, so that the terminal keeps its size; any
   * other is closed. */
  left(conn: Conn, terminal: string, st: Stream, park: boolean): void {
    let keep = false;
    if (this.conn === conn) {
      const n = this.typing.get(terminal) ?? 0;
      if (n > 1) this.typing.set(terminal, n - 1);
      else {
        this.typing.delete(terminal);
        keep = park && this.terms.get(terminal)?.state === 'live';
      }
    }
    if (!keep) {
      st.close();
      return;
    }
    const old = this.parked.get(terminal);
    this.parked.set(terminal, st);
    old?.close();
  }

  /** Ends the stream parked for a terminal that is over. */
  private unpark(terminal: string): void {
    const st = this.parked.get(terminal);
    if (!st) return;
    this.parked.delete(terminal);
    st.close();
  }

  /** Ends the clients' streams of terminal addr, which became hidden, also
   * those of clients that no longer follow the machine: their pumps tell
   * the clients that they closed. */
  private closeStreams(addr: string): void {
    this.unpark(addr);
    for (const ts of this.tracked) if (ts.terminal === addr) ts.stream.close();
  }

  /** Has the backend know a client's stream until untrack; whether its
   * terminal is hidden by now (the stream is to end). */
  track(ts: ClientStream): boolean {
    this.tracked.add(ts);
    return this.hidden.has(ts.terminal);
  }

  /** Forgets a stream that ended or that its client let go of. */
  untrack(ts: ClientStream): void {
    this.tracked.delete(ts);
  }
}
