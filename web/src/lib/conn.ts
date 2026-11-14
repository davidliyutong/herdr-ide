// The core's event channel (/ws): machines, program windows, agent states,
// downloads, the VS Code bridge, settings and keybindings. Terminals use
// their own protocol (term/connection.ts).

import type { AgentStatusEvent, MachineState } from './machine';
import type { GuiState } from '../gui/state';
import type { DownloadEvent } from '../download';

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
  /** Progress or end of a download a page started (download.ts). */
  onDownload(ev: DownloadEvent): void;
  onGui(st: GuiState): void;
  /** The settings or keybindings changed: their new state. */
  onSettings?(m: Record<string, unknown>): void;
  onKeybindings?(m: Record<string, unknown>): void;
};

class Conn {
  private ws?: WebSocket;
  private listener?: Listener;
  private backoff = 300;
  // Messages sent while disconnected, sent once connected.
  private queue: string[] = [];
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
    // The event channel; the page's terminals have their own (term/connection.ts).
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 300;
      this.listener?.onConnection(true);
      this.rawSend({ t: 'active', idle: Date.now() - this.lastInput });
      if (this.theme) this.rawSend({ t: 'theme', kind: this.theme });
      for (const q of this.queue.splice(0)) ws.send(q);
    };
    ws.onmessage = (e) => this.onMessage(e);
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      if (was) this.listener?.onConnection(false);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
  }

  private onMessage(e: MessageEvent) {
    if (typeof e.data !== 'string') return;
    const m = JSON.parse(e.data);
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
      case 'download':
        this.listener?.onDownload(m);
        break;
      case 'gui':
        this.listener?.onGui(m.state);
        break;
      case 'settings':
        this.listener?.onSettings?.(m);
        break;
      case 'keybindings':
        this.listener?.onKeybindings?.(m);
        break;
    }
  }

  private rawSend(obj: unknown) {
    const s = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
  }

  send(obj: unknown) {
    const s = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }

  /** Sends a message only while connected (never replayed). */
  sendNow(obj: unknown) {
    this.rawSend(obj);
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
