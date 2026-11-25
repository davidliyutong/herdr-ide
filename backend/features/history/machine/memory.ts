// What an agent remembers of the live terminals between captures, by
// address: lost when the agent ends, which costs one capture of each
// terminal again. One Memory per agent (the feature's start).

/** A terminal's screen that a capture did not store for good reason, and
 * that reason's code. */
export interface Refusal {
  key: string;
  code: string;
}

/** Values by address. */
export class Memo<V> {
  private readonly m = new Map<string, V>();

  get(addr: string): V | undefined {
    return this.m.get(addr);
  }

  set(addr: string, v: V): void {
    this.m.set(addr, v);
  }

  has(addr: string): boolean {
    return this.m.has(addr);
  }

  /** Drops addr ("" for all). */
  forget(addr: string): void {
    if (addr === '') this.m.clear();
    else this.m.delete(addr);
  }

  /** Drops the terminals not in live. */
  keepOnly(live: ReadonlySet<string>): void {
    for (const a of [...this.m.keys()]) if (!live.has(a)) this.m.delete(a);
  }
}

export class Memory {
  /** The screen of each terminal whose snapshot the limits evicted
   * (screenKey): such a terminal is captured again only once its program
   * or its screen changed, so that the terminals beyond the limits do not
   * take each other's place at every capture. */
  readonly evictions = new Memo<string>();
  /** The screen of each terminal that the limits had no room for (limit)
   * or whose paint exceeds a generation's size with the fewest lines
   * (too_large), with the limits it was refused under: it is not read
   * again until its program, its screen or the limits changed. */
  readonly refusals = new Memo<Refusal>();
  /** When a capture last tried a terminal and stored nothing (ms since the
   * epoch): it then comes after the terminals captured longer ago, so a
   * terminal that keeps failing slowly does not hold back the others. */
  readonly tried = new Memo<number>();
  /** When a capture first saw a terminal with snapshots missing from the
   * terminal core's records (ms since the epoch): its snapshots go once it
   * has been gone for the grace. An agent that starts again starts the
   * grace again. */
  readonly vanished = new Memo<number>();
  /** The core (NodeHello.client) whose capture ended last, and when (ms):
   * a capture of another core of the node in the share's time does
   * nothing (busy). */
  last: { client: string; at: number } | null = null;

  /** Drops what is remembered of addr ("" for all terminals). */
  forgetTerminal(addr: string): void {
    this.evictions.forget(addr);
    this.refusals.forget(addr);
    this.tried.forget(addr);
    this.vanished.forget(addr);
  }

  /** Drops what is remembered of the terminals not in live. */
  keepOnlyLive(live: ReadonlySet<string>): void {
    this.evictions.keepOnly(live);
    this.refusals.keepOnly(live);
    this.tried.keepOnly(live);
  }
}
