// The hub's machines: their order, the changes the UI makes (add, remove,
// rename, enable, reorder), stored in the machines file, the changes other
// hubs of the namespace make to that file (sync), and the states and agent
// events the pages follow.
import type { Logger } from '#shared/lib/log.ts';
import { Fail, unknownMachine } from '../fail.ts';
import { Machine, type Dialer, type StreamHandler, type Timing } from './machine.ts';
import type { Registry } from './registry.ts';
import { LOCAL_ID, sortByOrder, validTarget, type Spec, type State } from './spec.ts';

/** An event an agent reports for its machine (agent detection), passed on
 * to the pages. */
export interface AgentEvent {
  m: string;
  data: unknown;
}

export interface MachinesOptions {
  specs: readonly Spec[];
  /** The machines this run connects of those stored (with the local
   * machine and the --ssh ones): what sync follows. */
  select?: (stored: readonly Spec[]) => Spec[];
  registry: Registry;
  dial: Dialer;
  logger: Logger;
  localSupported?: boolean;
  timing?: Partial<Timing>;
  /** How long removing a machine waits for its session to end. */
  removeWaitMs?: number;
}

export interface MachinesListener {
  state?(st: State): void;
  agent?(ev: AgentEvent): void;
  /** The list changed by sync; removed are the machines that left it. */
  list?(removed: readonly string[]): void;
}

export class Machines {
  private order: string[] = [];
  private readonly byId = new Map<string, Machine>();
  private readonly stops = new Map<string, () => Promise<void>>();
  private readonly listeners = new Set<MachinesListener>();
  private readonly o: MachinesOptions;
  private streams: StreamHandler | undefined;
  private signal: AbortSignal | null = null;
  private readonly running = new Set<Promise<void>>();

  constructor(o: MachinesOptions) {
    this.o = o;
    for (const s of o.specs) {
      this.order.push(s.id);
      this.byId.set(s.id, this.create(s));
    }
    this.order = sortByOrder(this.order, o.registry.getOrder());
  }

  private create(s: Spec): Machine {
    const m: Machine = new Machine(s, {
      dial: this.o.dial,
      logger: this.o.logger,
      localSupported: this.o.localSupported ?? process.platform !== 'win32',
      timing: this.o.timing,
      streams: () => this.streams,
      publish: (st) => {
        if (this.byId.get(st.id) === m) for (const l of this.listeners) l.state?.(st);
      },
    });
    return m;
  }

  /** Serves the streams agents open towards the hub. */
  setStreamHandler(h: StreamHandler): void {
    this.streams = h;
  }

  /** Keeps every machine connected until signal ends; resolves once their
   * sessions ended. */
  async run(signal: AbortSignal): Promise<void> {
    this.signal = signal;
    for (const id of this.order) this.start(this.byId.get(id)!);
    await new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })));
    await Promise.all(this.running);
  }

  private start(m: Machine): void {
    if (!this.signal || this.signal.aborted) return;
    const ac = new AbortController();
    const parent = this.signal;
    const stop = () => ac.abort();
    parent.addEventListener('abort', stop, { once: true });
    const done = m.run(ac.signal).catch((e) => this.o.logger(`machine ${m.label}: ${(e as Error).message}`));
    const tracked = done.finally(() => {
      parent.removeEventListener('abort', stop);
      this.running.delete(tracked);
    });
    this.running.add(tracked);
    const wait = this.o.removeWaitMs ?? 15_000;
    this.stops.set(m.id, async () => {
      ac.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = await Promise.race([tracked.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), wait)))]);
      clearTimeout(timer);
      if (late) this.o.logger(`machine ${m.label}: session did not end within ${wait / 1000}s`);
    });
  }

  get(id: string): Machine | undefined {
    return this.byId.get(id);
  }

  /** The machine of id; fails unknown_machine. */
  must(id: string): Machine {
    const m = this.byId.get(id);
    if (!m) throw unknownMachine();
    return m;
  }

  list(): Machine[] {
    return this.order.map((id) => this.byId.get(id)!);
  }

  states(): State[] {
    return this.list().map((m) => m.state());
  }

  /** Follows the machines' states and agent events until the returned
   * function is called. */
  subscribe(l: MachinesListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Passes an agent's event on to the listeners. */
  publishAgent(ev: AgentEvent): void {
    if (!this.byId.has(ev.m)) return;
    for (const l of this.listeners) l.agent?.(ev);
  }

  /** Another machine, or a stored record, matches. */
  private taken(id: string, match: (s: Spec) => boolean): boolean {
    return this.list().some((m) => m.id !== id && match(m.spec())) || this.o.registry.specs().some((s) => s.id !== id && match(s));
  }

  /** Stores s when the registry keeps it: a machine added from the UI, and
   * the local machine. */
  private store(s: Spec): void {
    if (this.o.registry.get(s.id) || s.id === LOCAL_ID) this.o.registry.put(s);
  }

  /** Adds an ssh machine and starts connecting to it. */
  add(s: { id: string; label: string; target: string }): Machine {
    if (!validTarget(s.target)) throw new Fail('invalid_target', 400, 'invalid ssh target');
    if (!s.id || this.taken('', (o) => o.id === s.id || (o.kind === 'ssh' && o.target === s.target)))
      throw new Fail('machine_exists', 409, 'machine exists');
    const spec: Spec = { id: s.id, label: s.label, kind: 'ssh', target: s.target, enabled: true };
    this.o.registry.put(spec);
    const m = this.create(spec);
    this.order.push(spec.id);
    this.byId.set(spec.id, m);
    this.start(m);
    return m;
  }

  /** Removes an ssh machine and ends its session. */
  async remove(id: string): Promise<void> {
    const m = this.must(id);
    if (m.local) throw new Fail('local', 400, 'the local machine cannot be removed');
    this.o.registry.delete(id);
    await this.drop(id);
  }

  /** Takes machine id out of the list and ends its session. */
  private drop(id: string): Promise<void> {
    this.byId.delete(id);
    this.order = this.order.filter((x) => x !== id);
    const stop = this.stops.get(id);
    this.stops.delete(id);
    return stop?.() ?? Promise.resolve();
  }

  /** Follows the machines file after another hub of the namespace changed
   * it (Registry.watch): starts the machines it gained, ends the sessions
   * of those it lost (an ssh machine whose target changed is both), takes
   * the labels, flags and order it has, and tells the listeners when the
   * list changed. The local machine stays. */
  sync(): void {
    if (!this.o.select) return;
    const want = new Map(this.o.select(this.o.registry.specs()).map((s) => [s.id, s]));
    const removed: string[] = [];
    for (const id of [...this.order]) {
      const m = this.byId.get(id)!;
      const s = want.get(id);
      if (m.local || (s && s.kind === m.kind && (s.target ?? '') === m.target)) continue;
      void this.drop(id);
      removed.push(id);
    }
    let changed = removed.length > 0;
    for (const s of want.values()) {
      const m = this.byId.get(s.id);
      if (m) {
        if (m.setLabel(s.label)) changed = true;
        if (m.setEnabled(s.enabled)) changed = true;
        continue;
      }
      const n = this.create(s);
      this.order.push(s.id);
      this.byId.set(s.id, n);
      this.start(n);
      changed = true;
    }
    const order = sortByOrder(this.order, this.o.registry.getOrder());
    if (order.some((id, i) => id !== this.order[i])) {
      this.order = order;
      changed = true;
    }
    if (changed) for (const l of this.listeners) l.list?.(removed);
  }

  setLabel(id: string, label: string): void {
    const m = this.must(id);
    if (this.taken(id, (s) => s.label === label)) throw new Fail('label_taken', 409, 'another machine has this label');
    this.store({ ...m.spec(), label });
    m.setLabel(label);
  }

  setEnabled(id: string, on: boolean): void {
    const m = this.must(id);
    const s = { ...m.spec(), enabled: on };
    // The local machine's record keeps only a label the user gave it.
    if (m.local) s.label = this.o.registry.get(id)?.label ?? '';
    this.store(s);
    m.setEnabled(on);
  }

  /** Reorders the machines: ids names each of them once. */
  setOrder(ids: readonly string[]): void {
    if (ids.length !== this.order.length || new Set(ids).size !== ids.length || ids.some((id) => !this.byId.has(id)))
      throw new Fail('invalid', 400, 'the order does not name each machine once');
    this.o.registry.setOrder(ids);
    this.order = [...ids];
  }
}
