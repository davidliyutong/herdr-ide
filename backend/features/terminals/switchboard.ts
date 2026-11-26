// The machines' backends and the clients of /api/v1/term: a backend per
// machine a client followed, kept until the machine is removed or the hub
// stops; a client per channel.
import type { Logger } from '#shared/lib/log.ts';
import type { Audit, Who } from '#kernel/audit.ts';
import { CloseCode, type Channel, type ChannelHandlers } from '#kernel/channel.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import type { Machines } from '#kernel/machines/manager.ts';
import { Backend } from './backend.ts';
import { TermClient } from './client.ts';
import type { HCSource } from './lifecycle.ts';
import type { Timing } from './timing.ts';

export interface SwitchboardDeps {
  machines: Machines;
  logger: Logger;
  audit: Audit;
  readOnly: boolean;
  hc?: HCSource;
  embeddedHC?: (os: string, arch: string) => Promise<string | null>;
  paneEnv: (m: Machine) => Record<string, string> | undefined;
  sshEnv: (m: Machine) => Record<string, string> | null;
  workspaceEnv?: (
    m: Machine,
    workspace: string,
  ) => Promise<{ env: Record<string, string>; names: string[]; presets: string[] } | undefined>;
  sessions: () => boolean;
  onSessionsChange: (changed: () => void) => () => void;
  onReady?: (m: Machine, ready: boolean) => void;
  timing: Timing;
  maxBuffered: number;
}

export class Switchboard {
  private readonly backends = new Map<string, Backend>();
  private readonly clients = new Set<TermClient>();
  /** Ends with the hub: every backend's connection, every client. */
  private readonly life = new AbortController();
  private readonly d: SwitchboardDeps;

  constructor(d: SwitchboardDeps) {
    this.d = d;
  }

  /** A machine's backend, created on first use. */
  backend(id: string): Backend {
    let b = this.backends.get(id);
    if (!b) {
      b = new Backend(id, { ...this.d, signal: this.life.signal });
      this.backends.set(id, b);
    }
    return b;
  }

  /** A machine's backend; undefined when it has none. */
  existing(id: string): Backend | undefined {
    return this.backends.get(id);
  }

  /** Drops the backend of a removed machine: its connection to the
   * terminal core closes and its clients no longer count it as subscribed,
   * so a machine added again under the same id starts afresh. */
  forget(id: string): void {
    const b = this.backends.get(id);
    this.backends.delete(id);
    b?.close();
  }

  /** Ends a backend's wait before its next try (its machine connected). */
  wakeUp(id: string): void {
    this.backends.get(id)?.wakeUp();
  }

  /** Clears a prior UI stop when a disabled machine is enabled again, and
   * wakes its backend. */
  enable(id: string): void {
    this.backends.get(id)?.resetStopped();
  }

  /** Adopts a channel of /api/v1/term. */
  connect(ch: Channel, who: Who): ChannelHandlers {
    const c = new TermClient(ch, who, { ...this.d, backend: (id) => this.backend(id) });
    const h = c.handlers();
    if (this.life.signal.aborted) {
      queueMicrotask(() => c.close());
      return h;
    }
    this.clients.add(c);
    return {
      message: h.message,
      close: (code, reason) => {
        this.clients.delete(c);
        h.close?.(code, reason);
      },
    };
  }

  /** The hub stops: the backends close their connections, the clients
   * their channels. */
  close(): void {
    this.life.abort();
    for (const c of this.clients) c.close(CloseCode.GoingAway);
  }
}
