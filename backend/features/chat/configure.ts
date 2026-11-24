// Giving the machines' chat hosts their settings (Op.Configure). A host
// starts with the defaults, without full access: before a request that may
// start an agent (a new chat, a prompt, a listing that runs the agent) the
// host the core reaches takes the machine's settings unless that host
// process took them as they are (prepare, ensure), and a watched host takes
// them when they change (configure). A read-only core configures nothing.
import type { Logger } from '#shared/lib/log.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { asChatError } from './errors.ts';
import type { HostConn, HostLink } from './hostconn.ts';
import { sameSettings } from './settings.ts';

export interface ConfigurerOptions {
  link: HostLink;
  readOnly: boolean;
  /** Machine m's settings for its host. */
  settings: (m: string) => chat.ClampedHostSettings;
  logger: Logger;
  /** Bounds one configure. */
  shortMs: number;
}

interface Machine {
  /** A configure runs; again: the settings changed meanwhile. */
  configuring: boolean;
  again: boolean;
  /** The host process (hostID) that took the machine's settings as they
   * are; "" for none. A host started again takes them anew. */
  host: string;
}

const bounded = (signal: AbortSignal, ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

export class Configurer {
  private readonly o: ConfigurerOptions;
  private readonly machines = new Map<string, Machine>();

  constructor(o: ConfigurerOptions) {
    this.o = o;
  }

  private record(m: string): Machine {
    let r = this.machines.get(m);
    if (!r) this.machines.set(m, (r = { configuring: false, again: false, host: '' }));
    return r;
  }

  /** The host process that took machine m's settings ("" for none). */
  configured(m: string): string {
    return this.machines.get(m)?.host ?? '';
  }

  /** Sends machine m's host the settings s; with start, to a host the
   * machine starts when none serves. The host took them when it answered:
   * that host process is the machine's configured one while the settings
   * stay as they are. */
  async once(m: string, s: chat.ClampedHostSettings, start: boolean, signal: AbortSignal): Promise<void> {
    const c = await this.o.link.dial(m, { start, reserved: true, signal });
    try {
      await c.send({ op: chat.Op.Configure, settings: s });
      // Settings that changed meanwhile are configured again.
      if (sameSettings(this.o.settings(m), s)) this.record(m).host = c.id;
    } finally {
      c.close();
    }
  }

  /** Gives machine m's host its settings in the background until signal
   * ends: one configure at a time per machine, again when they changed
   * meanwhile. */
  configure(m: string, signal: AbortSignal): void {
    if (this.o.readOnly) return;
    const r = this.record(m);
    if (r.configuring) {
      r.again = true;
      return;
    }
    r.configuring = true;
    void (async () => {
      for (;;) {
        try {
          await this.once(m, this.o.settings(m), false, bounded(signal, this.o.shortMs));
        } catch (e) {
          const code = asChatError(e).code;
          if (!signal.aborted && code !== 'offline') this.o.logger(`chat: configure ${m}: ${code}`);
        }
        const again = r.again && !signal.aborted;
        r.again = false;
        if (!again) {
          r.configuring = false;
          return;
        }
      }
    })();
  }

  /** Configures machine m's host before a request that may start an agent,
   * with start starting the host, unless a host took the machine's
   * settings as they are since the core started. A failure is left to the
   * request that follows. */
  async prepare(m: string, start: boolean, signal: AbortSignal): Promise<void> {
    if (this.o.readOnly || this.configured(m)) return;
    await this.once(m, this.o.settings(m), start, bounded(signal, this.o.shortMs)).catch(() => {});
  }

  /** Configures the host c is connected to when it is not the one that took
   * the machine's settings (a host started again since, another build's),
   * before c's request. A failure is left to the request. */
  async ensure(m: string, c: HostConn, signal: AbortSignal): Promise<void> {
    if (this.o.readOnly || this.configured(m) === c.id) return;
    await this.once(m, this.o.settings(m), false, bounded(signal, this.o.shortMs)).catch(() => {});
  }

  /** Forgets which hosts took the settings of the machines named (all
   * without); they take them anew. */
  invalidate(machines?: ReadonlySet<string>): void {
    for (const [m, r] of this.machines) if (!machines || machines.has(m)) r.host = '';
  }

  forget(m: string): void {
    this.machines.delete(m);
  }
}
