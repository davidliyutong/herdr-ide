// What VS Code's work follows: per kind of client, its proxied requests,
// WebSockets and bridge commands, which end when that client's switch is
// turned off (its VS Code windows open elsewhere stop working, and
// code-server, without connections, is released once idle); and preparing
// code-server on machines, which serves every client and ends when VS Code
// is off for all of them. The next use takes a new signal.
import type { Logger } from '#shared/lib/log.ts';
import type { Client } from '#kernel/http/env.ts';

const CLIENTS: readonly Client[] = ['browser', 'desktop'];

/** A client's own work, or preparations ("prepare"), which serve all. */
type Key = Client | 'prepare';

export class Work {
  private readonly controllers = new Map<Key, AbortController>();
  private readonly on: (c: Client) => boolean;
  private readonly logger: Logger;

  constructor(on: (c: Client) => boolean, logger: Logger) {
    this.on = on;
    this.logger = logger;
  }

  /** The signal of client c's VS Code work (own), or of preparing
   * code-server for it (!own), taken only while c's switch is on:
   * undefined when it is off. The switch is read after the signal is
   * taken, and follow() aborts only after the setting changed: a switch
   * turned off meanwhile has either aborted this signal or is seen here,
   * so no request holds a signal that nothing would abort. */
  signal(c: Client, own: boolean): AbortSignal | undefined {
    const key: Key = own ? c : 'prepare';
    let ac = this.controllers.get(key);
    if (!ac) {
      ac = new AbortController();
      this.controllers.set(key, ac);
    }
    return this.on(c) ? ac.signal : undefined;
  }

  /** Ends the work of each client whose switch is off, and preparations
   * when every switch is (after a change of the switches). */
  follow(): void {
    let any = false;
    for (const c of CLIENTS) {
      if (this.on(c)) any = true;
      else this.stop(c);
    }
    if (!any) this.stop('prepare');
  }

  /** Ends all work (the hub stops). */
  stopAll(): void {
    for (const k of [...this.controllers.keys()]) this.stop(k, true);
  }

  private stop(key: Key, quiet = false): void {
    const ac = this.controllers.get(key);
    if (!ac) return;
    this.controllers.delete(key);
    if (!quiet)
      this.logger(
        key === 'prepare' ? 'VS Code turned off: its preparations end' : `VS Code turned off for ${key} clients: their connections end`,
      );
    ac.abort(new Error('VS Code turned off'));
  }
}

/** VS Code's use of each machine, so that an idle code-server is released:
 * its open WebSockets and when it was last used. */
export class Activity {
  private readonly uses = new Map<string, { open: number; last: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private use(machine: string): { open: number; last: number } {
    const a = this.uses.get(machine) ?? { open: 0, last: 0 };
    a.last = this.now();
    this.uses.set(machine, a);
    return a;
  }

  touch(machine: string): void {
    this.use(machine);
  }

  /** A WebSocket keeps this instance active until its disposer runs. */
  connected(machine: string): () => void {
    const a = this.use(machine);
    a.open++;
    let closed = false;
    return () => {
      if (closed || this.uses.get(machine) !== a) return;
      closed = true;
      a.open--;
      a.last = this.now();
    };
  }

  /** The machines among running whose code-server had no open connection
   * and no request for longer than ms. One without any use yet (started
   * by a bridge command) starts its clock now. */
  idleAmong(running: readonly string[], ms: number): string[] {
    const out: string[] = [];
    for (const id of running) {
      const a = this.uses.get(id);
      if (!a) {
        this.use(id);
        continue;
      }
      if (a.open === 0 && this.now() - a.last > ms) {
        out.push(id);
        this.uses.delete(id);
      }
    }
    return out;
  }

  /** For tests: when the machine was last used. */
  setLast(machine: string, at: number): void {
    this.use(machine).last = at;
  }

  forget(machine: string): void {
    this.uses.delete(machine);
  }
}
