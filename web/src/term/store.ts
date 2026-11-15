import type { BackendState, TerminalRecord } from './protocol';

/**
 * The terminals of the machines a client subscribed to, kept current from
 * the core's backend, snapshot and event messages. Events are applied as
 * herdr-core's API describes, as the core does.
 */
export class TerminalStore {
  readonly backends = new Map<string, BackendState>();
  private readonly records = new Map<string, Map<string, TerminalRecord>>();

  /** Drops what is known of a machine that was removed. */
  forget(machine: string) {
    this.backends.delete(machine);
    this.records.delete(machine);
  }

  /** A machine's terminals, oldest first. */
  terminals(machine: string): TerminalRecord[] {
    const created = (t: TerminalRecord) => (typeof t.created_ms === 'number' ? t.created_ms : 0);
    return [...(this.records.get(machine)?.values() ?? [])].sort(
      (a, b) => created(a) - created(b) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
    );
  }

  terminal(machine: string, address: string): TerminalRecord | undefined {
    return this.records.get(machine)?.get(address);
  }

  /** Applies a text message of the protocol; true when it changed something this store holds. */
  apply(msg: Record<string, unknown>): boolean {
    const machine = msg.m;
    if (typeof machine !== 'string') return false;
    switch (msg.t) {
      case 'backend': {
        const phase = msg.state;
        if (phase !== 'starting' && phase !== 'ready' && phase !== 'error') return false;
        this.backends.set(machine, { phase, code: String(msg.code ?? ''), version: String(msg.version ?? '') });
        if (phase !== 'ready') this.records.delete(machine);
        return true;
      }
      case 'snapshot': {
        const terms = new Map<string, TerminalRecord>();
        for (const raw of Array.isArray(msg.terminals) ? (msg.terminals as TerminalRecord[]) : []) {
          if (raw && typeof raw.address === 'string' && raw.address) terms.set(raw.address, raw);
        }
        this.records.set(machine, terms);
        return true;
      }
      case 'event':
        return this.event(machine, msg);
      default:
        return false;
    }
  }

  private event(machine: string, msg: Record<string, unknown>): boolean {
    const kind = msg.type;
    const address = msg.terminal;
    if (typeof kind !== 'string' || typeof address !== 'string') return false;
    const data = (msg.data ?? null) as Record<string, unknown> | null;
    let terms = this.records.get(machine);
    if (!terms) this.records.set(machine, (terms = new Map()));
    const term = terms.get(address);
    switch (kind) {
      case 'created':
      case 'restarted':
        if (!data) return false;
        terms.set(address, data as TerminalRecord);
        return true;
      case 'removed':
        return terms.delete(address);
      case 'labels':
        if (data?.record) terms.set(address, data.record as TerminalRecord);
        else if (term) terms.set(address, { ...term, labels: data?.labels });
        return true;
      case 'turn':
        if (!term) return false;
        terms.set(address, { ...term, turn: data?.turn });
        return true;
      case 'foreground': {
        if (!term) return false;
        const next = { ...term };
        if (data) next.foreground = data;
        else delete next.foreground;
        terms.set(address, next);
        return true;
      }
      default: {
        if (!term) return false;
        const next: TerminalRecord = { ...term };
        for (const [key, value] of Object.entries(data ?? {})) {
          if (value === null) delete next[key];
          else next[key] = value;
        }
        if (kind === 'finished') {
          next.state = 'finished';
          delete next.foreground;
        } else if (kind === 'lost') {
          delete next.pid;
          delete next.foreground;
        }
        terms.set(address, next);
        return true;
      }
    }
  }
}
