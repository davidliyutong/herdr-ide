// A scripted core for the terminal protocol (/api/v1/term) behind the page's
// model (state/terms.ts): machines with terminal records and a layout
// document, calls answered as a terminal core answers them, and every call
// recorded.

import { TermConnection, type Socket } from '../term/connection';
import { TermModel, setTermModel, useTerms } from '../state/terms';
import type { Layout } from '../term/layout';

export interface FakeMachine {
  terminals: Array<Record<string, unknown> & { address: string }>;
  layout?: unknown;
  version: number;
}

export class FakeCore {
  readonly machines = new Map<string, FakeMachine>();
  readonly calls: Array<{ m: string; method: string; params: Record<string, unknown> }> = [];
  readonly sent: Array<Record<string, unknown>> = [];
  private socket?: FakeSocket;
  private next = 1;
  model!: TermModel;

  machine(m: string, terminals: FakeMachine['terminals'] = [], layout?: unknown): FakeMachine {
    const fm = { terminals, layout, version: layout ? 1 : 0 };
    this.machines.set(m, fm);
    return fm;
  }

  /** A live terminal record. */
  static term(address: string, extra: Record<string, unknown> = {}) {
    return { address, state: 'live', argv: ['/bin/zsh'], cwd: '/home/u', pid: 100, labels: {}, created_ms: 1, ...extra };
  }

  /** Installs a model connected to this core as the page's. */
  install(): TermModel {
    const conn = new TermConnection(() => (this.socket = new FakeSocket(this)));
    this.model = new TermModel(conn);
    setTermModel(this.model);
    useTerms.setState({ connected: false, machines: {} });
    this.model.start();
    return this.model;
  }

  push(msg: Record<string, unknown>) {
    this.socket?.deliver(msg);
  }

  /** A terminal's event, as the core forwards it. */
  event(m: string, type: string, terminal: string, data: unknown = null) {
    this.push({ t: 'event', m, type, terminal, data });
  }

  layout(m: string): Layout | undefined {
    return this.machines.get(m)?.layout as Layout | undefined;
  }

  handle(msg: Record<string, unknown>) {
    this.sent.push(msg);
    const m = msg.m as string;
    const fm = this.machines.get(m);
    switch (msg.t) {
      case 'sub':
        if (!fm) return this.push({ t: 'backend', m, state: 'error', code: 'machine_offline' });
        this.push({ t: 'backend', m, state: 'ready' });
        this.push({ t: 'snapshot', m, terminals: fm.terminals });
        return;
      case 'call': {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        this.calls.push({ m, method: msg.method as string, params });
        const res = (result: unknown) => this.push({ t: 'res', rid: msg.rid, result });
        const fail = (kind: string) => this.push({ t: 'res', rid: msg.rid, error: { kind } });
        if (!fm) return fail('unavailable');
        switch (msg.method) {
          case 'doc.get':
            return res({ name: 'layout', version: fm.version, value: fm.layout ?? null });
          case 'doc.set':
            if (params.version !== fm.version) return fail('conflict');
            fm.version++;
            fm.layout = JSON.parse(JSON.stringify(params.value));
            res({ name: 'layout', version: fm.version });
            return this.push({ t: 'event', m, type: 'doc', terminal: '', data: { name: 'layout', version: fm.version } });
          case 'terminal.run': {
            const rec = FakeCore.term(`t${this.next++}`, { cwd: params.cwd ?? '/home/u', argv: params.argv ?? ['/bin/zsh'] });
            fm.terminals.push(rec);
            res(rec);
            return this.event(m, 'created', rec.address, rec);
          }
          case 'terminal.kill': {
            const a = params.terminal as string;
            fm.terminals = fm.terminals.filter((r) => r.address !== a);
            res({});
            return this.event(m, 'removed', a);
          }
          default:
            return res({});
        }
      }
      case 'attach':
        return this.push({ t: 'attached', rid: msg.rid, s: 1, terminal: msg.terminal, cols: msg.cols, rows: msg.rows });
    }
  }
}

class FakeSocket implements Socket {
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(private readonly core: FakeCore) {
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string | Uint8Array) {
    if (typeof data === 'string') this.core.handle(JSON.parse(data));
  }

  deliver(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  close() {
    this.onclose?.();
  }
}

/** Resolves after pending promises and messages ran. */
export const settle = () => new Promise((r) => setTimeout(r, 0));
