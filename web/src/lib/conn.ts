// WebSocket connection to the core.
//
// Text messages are JSON; binary messages are terminal frames:
// [sid u32][flags u8][width u16][height u16][ansi bytes].

import type { AgentStatusEvent, MachineState } from './herdr';

export interface StreamHandlers {
  onFrame(full: boolean, cols: number, rows: number, data: Uint8Array): void;
  onEvent(ev: {
    ev: 'open' | 'closed' | 'error' | 'notice';
    code?: string;
    mode?: 'control' | 'observe';
    cols?: number;
    rows?: number;
    reason?: string;
    message?: string;
  }): void;
}

export interface AttachParams {
  m: string;
  pane: string;
  cols: number;
  rows: number;
  /** 'auto' lets the core arbitrate between browsers; 'observe' never controls. */
  mode: 'auto' | 'observe';
  takeover?: boolean;
  cw?: number;
  ch?: number;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Listener = {
  onMachines(list: MachineState[]): void;
  onMachine(st: MachineState): void;
  onAgent(machine: string, data: AgentStatusEvent): void;
  onConnection(connected: boolean): void;
  onBridgeSend(machine: string, text: string): void;
};

class Conn {
  private ws?: WebSocket;
  private nextSid = 1;
  private nextRid = 1;
  private streams = new Map<number, { params: AttachParams; handlers: StreamHandlers }>();
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listener?: Listener;
  private backoff = 300;
  // Messages sent while disconnected; api requests carry their rid so that a
  // request rejected on disconnect is never replayed after reconnecting.
  private queue: { data: string; rid?: number }[] = [];
  connected = false;

  start(listener: Listener) {
    this.listener = listener;
    this.connect();
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 300;
      this.listener?.onConnection(true);
      for (const [sid, s] of this.streams) this.rawSend({ t: 'attach', sid, ...s.params });
      for (const q of this.queue.splice(0)) ws.send(q.data);
    };
    ws.onmessage = (e) => this.onMessage(e);
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      if (was) this.listener?.onConnection(false);
      for (const [, p] of this.pending) p.reject(new ApiError('disconnected', 'connection lost'));
      this.pending.clear();
      this.queue = this.queue.filter((q) => q.rid === undefined);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
  }

  private onMessage(e: MessageEvent) {
    if (typeof e.data !== 'string') {
      const buf = e.data as ArrayBuffer;
      const dv = new DataView(buf);
      const sid = dv.getUint32(0);
      const s = this.streams.get(sid);
      if (s) s.handlers.onFrame((dv.getUint8(4) & 1) === 1, dv.getUint16(5), dv.getUint16(7), new Uint8Array(buf, 9));
      return;
    }
    const m = JSON.parse(e.data);
    switch (m.t) {
      case 'machines':
        this.listener?.onMachines(m.list);
        break;
      case 'machine':
        this.listener?.onMachine(m.state);
        break;
      case 'agent':
        this.listener?.onAgent(m.m, m.data);
        break;
      case 'bridge.send':
        this.listener?.onBridgeSend(m.m, m.text);
        break;
      case 'term': {
        const s = this.streams.get(m.sid);
        s?.handlers.onEvent(m);
        break;
      }
      case 'api.res': {
        const p = this.pending.get(m.rid);
        if (!p) break;
        this.pending.delete(m.rid);
        if (m.error) p.reject(new ApiError(m.error.code, m.error.message));
        else p.resolve(m.result);
        break;
      }
    }
  }

  private rawSend(obj: unknown) {
    const s = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
  }

  send(obj: unknown, rid?: number) {
    const s = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push({ data: s, rid });
  }

  attach(params: AttachParams, handlers: StreamHandlers): number {
    const sid = this.nextSid++;
    this.streams.set(sid, { params, handlers });
    this.rawSend({ t: 'attach', sid, ...params });
    return sid;
  }

  /** Update the attach parameters used on reconnect (e.g. after resize). */
  updateAttach(sid: number, patch: Partial<AttachParams>) {
    const s = this.streams.get(sid);
    if (s) s.params = { ...s.params, ...patch };
  }

  reattach(sid: number, patch: Partial<AttachParams>) {
    const s = this.streams.get(sid);
    if (!s) return;
    s.params = { ...s.params, ...patch };
    this.rawSend({ t: 'attach', sid, ...s.params });
  }

  detach(sid: number) {
    if (this.streams.delete(sid)) this.rawSend({ t: 'detach', sid });
  }

  stream(sid: number, msg: Record<string, unknown>) {
    this.rawSend({ ...msg, sid });
  }

  api<T = any>(machine: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const rid = this.nextRid++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(rid, { resolve, reject });
      this.send({ t: 'api', rid, m: machine, method, params }, rid);
    });
  }

  retry(machine: string) {
    this.send({ t: 'retry', m: machine });
  }
}

export const conn = new Conn();
