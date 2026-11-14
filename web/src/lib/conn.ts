// WebSocket connection to the core.
//
// Text messages are JSON; binary messages are pane surface updates (see
// surface/protocol.ts), handled with the surface messages by surface/session.ts.

import type { AgentStatusEvent, MachineState } from './herdr';
import type { GuiState } from '../gui/state';

/** Receives the surface stream: session, surf* , clip and bell messages, and
 * binary updates. */
export interface SurfaceHandler {
  json(m: { t: string } & Record<string, unknown>): void;
  binary(buf: ArrayBuffer): void;
}

const surfaceTypes = new Set(['session', 'surf', 'surf.meta', 'surf.tab', 'clip', 'bell']);

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
  /** sound: this page plays notification sounds (it was used most recently). */
  onAgent(machine: string, data: AgentStatusEvent, sound: boolean): void;
  onConnection(connected: boolean): void;
  /** folders: those of the VS Code window that sent it. */
  onBridgeSend(machine: string, text: string, folders?: string[]): void;
  /** Files chosen in VS Code's explorer to download. */
  onBridgeDownload(machine: string, paths: string[]): void;
  onGui(st: GuiState): void;
};

class Conn {
  private ws?: WebSocket;
  private nextRid = 1;
  private surface?: SurfaceHandler;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listener?: Listener;
  private backoff = 300;
  // Messages sent while disconnected; api requests carry their rid so that a
  // request rejected on disconnect is never replayed after reconnecting.
  private queue: { data: string; rid?: number }[] = [];
  private theme?: string;
  // When the user last used the page (opening it counts) and when the core
  // was last told; the core lets the most recently used page play sounds.
  private lastInput = Date.now();
  private lastActiveSent = 0;
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
      this.rawSend({ t: 'active', idle: Date.now() - this.lastInput });
      if (this.theme) this.rawSend({ t: 'theme', kind: this.theme });
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
      this.surface?.binary(e.data as ArrayBuffer);
      return;
    }
    const m = JSON.parse(e.data);
    if (surfaceTypes.has(m.t)) {
      this.surface?.json(m);
      return;
    }
    switch (m.t) {
      case 'machines':
        this.listener?.onMachines(m.list);
        break;
      case 'machine':
        this.listener?.onMachine(m.state);
        break;
      case 'agent':
        this.listener?.onAgent(m.m, m.data, m.sound === true);
        break;
      case 'bridge.send':
        this.listener?.onBridgeSend(
          m.m,
          m.text,
          Array.isArray(m.folders) ? m.folders.filter((f: unknown) => typeof f === 'string') : undefined,
        );
        break;
      case 'bridge.download':
        this.listener?.onBridgeDownload(m.m, m.paths);
        break;
      case 'gui':
        this.listener?.onGui(m.state);
        break;
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

  /** Sets the receiver of the surface stream. */
  setSurfaceHandler(h: SurfaceHandler | undefined) {
    this.surface = h;
  }

  /** Sends a message only while connected (surface messages are recomputed
   * after a reconnect, never replayed). */
  sendNow(obj: unknown) {
    this.rawSend(obj);
  }

  api<T = any>(machine: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const rid = this.nextRid++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(rid, { resolve, reject });
      this.send({ t: 'api', rid, m: machine, method, params }, rid);
    });
  }

  /** Tells the core the light/dark theme in use, now and after reconnects;
   * VS Code windows follow it. */
  setTheme(kind: string) {
    if (kind === this.theme) return;
    this.theme = kind;
    this.rawSend({ t: 'theme', kind });
  }

  /** Records that the user is using the page (input or focus). */
  markActive() {
    const now = Date.now();
    this.lastInput = now;
    if (now - this.lastActiveSent < 2000) return;
    this.lastActiveSent = now;
    this.rawSend({ t: 'active', idle: 0 });
  }

  retry(machine: string) {
    this.send({ t: 'retry', m: machine });
  }
}

export const conn = new Conn();
