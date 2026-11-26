// The hub's event channel (/ws): machines, program windows, agent states,
// downloads, the VS Code bridge, settings and keybindings. Terminals use
// their own protocol (term/connection.ts).

import type { AgentStatusEvent, MachineState } from './machine';
import type { GuiState } from '../gui/state';
import type { DownloadEvent } from '../download';
import { RETRY_RESET_MS, retryDelay } from './retry';
import { openChannel } from './transport';

type Listener = {
  onMachines(list: MachineState[]): void;
  onMachine(st: MachineState): void;
  /** sound: this page plays notification sounds (it was used most recently). */
  onAgent(machine: string, data: AgentStatusEvent, sound: boolean): void;
  onConnection(connected: boolean): void;
  /** window and folders: the id and folders of the VS Code window that sent it. */
  onBridgeSend(machine: string, text: string, window?: string, folders?: string[]): void;
  /** Files chosen in VS Code's explorer to download. */
  onBridgeDownload(machine: string, paths: string[], window?: string): void;
  /** A VS Code window got the keyboard. */
  onBridgeFocus(machine: string, window: string, folders?: string[]): void;
  /** VS Code's key for closing was pressed in a window without editors. */
  onBridgeClose?(machine: string, window: string, folders?: string[]): void;
  /** The extension's key for giving the keyboard back to the page. */
  onBridgeLeave?(machine: string, window: string, folders?: string[]): void;
  /** Progress or end of a download a page started (download.ts). */
  onDownload(ev: DownloadEvent): void;
  onGui(st: GuiState): void;
  /** The settings or keybindings changed: their new state. */
  onSettings?(m: Record<string, unknown>): void;
  onKeybindings?(m: Record<string, unknown>): void;
  /** A message of a plugin's hub side, for machine m ("" for the hub's). */
  onPlugin?(plugin: string, m: string, data: unknown): void;
};

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : undefined);
const BACKOFF_MIN_MS = 300;
const MAX_OFFLINE_MESSAGES = 256;
const MAX_OFFLINE_LENGTH = 256 << 10;

class Conn {
  private ws?: WebSocket;
  private listener?: Listener;
  private backoff = BACKOFF_MIN_MS;
  private retryTimer?: ReturnType<typeof setTimeout>;
  // Messages sent while disconnected, sent once connected.
  private queue: string[] = [];
  private queuedLength = 0;
  private theme?: string;
  // When the user last used the page (opening it counts) and when the hub
  // was last told; the hub lets the most recently used page play sounds.
  private lastInput = Date.now();
  private lastActiveSent = 0;
  connected = false;

  start(listener: Listener) {
    this.listener = listener;
    if (!this.ws && this.retryTimer === undefined) this.connect();
  }

  private connect() {
    // The event channel; the page's terminals have their own (term/connection.ts).
    const ws = openChannel('/ws');
    this.ws = ws;
    let openedAt: number | undefined;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      openedAt = performance.now();
      this.listener?.onConnection(true);
      this.rawSend({ t: 'active', idle: Date.now() - this.lastInput });
      if (this.theme) this.rawSend({ t: 'theme', kind: this.theme });
      this.queuedLength = 0;
      for (const q of this.queue.splice(0)) ws.send(q);
    };
    ws.onmessage = (e) => {
      if (this.ws === ws) this.onMessage(e);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (openedAt !== undefined && performance.now() - openedAt >= RETRY_RESET_MS) this.backoff = BACKOFF_MIN_MS;
      const was = this.connected;
      this.connected = false;
      this.ws = undefined;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.connect();
      }, retryDelay(this.backoff));
      this.backoff = Math.min(this.backoff * 2, 5000);
      if (was) this.listener?.onConnection(false);
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
        this.listener?.onBridgeSend(m.m, m.text, text(m.window), strings(m.folders));
        break;
      case 'bridge.download':
        this.listener?.onBridgeDownload(m.m, m.paths, text(m.window));
        break;
      case 'bridge.focus':
        if (text(m.window)) this.listener?.onBridgeFocus(m.m, m.window, strings(m.folders));
        break;
      case 'bridge.close':
        if (text(m.window)) this.listener?.onBridgeClose?.(m.m, m.window, strings(m.folders));
        break;
      case 'bridge.leave':
        if (text(m.window)) this.listener?.onBridgeLeave?.(m.m, m.window, strings(m.folders));
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
      case 'plugin':
        if (text(m.plugin)) this.listener?.onPlugin?.(m.plugin, typeof m.m === 'string' ? m.m : '', m.data);
        break;
    }
  }

  private rawSend(obj: unknown) {
    const s = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
  }

  send(obj: unknown) {
    const s = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(s);
    } else if (s.length <= MAX_OFFLINE_LENGTH) {
      while (this.queue.length >= MAX_OFFLINE_MESSAGES || this.queuedLength + s.length > MAX_OFFLINE_LENGTH) {
        this.queuedLength -= this.queue.shift()!.length;
      }
      this.queue.push(s);
      this.queuedLength += s.length;
    }
  }

  /** Sends a message only while connected (never replayed). */
  sendNow(obj: unknown) {
    this.rawSend(obj);
  }

  /** Tells the hub the light/dark theme in use, now and after reconnects;
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
