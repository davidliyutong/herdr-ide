// A scripted core for the chat plugin's WebSocket (plugins/chat/connection.ts,
// internal/plugins/chat/wire.go): the page's messages recorded, the core's
// sent as a test says, or answered by themselves (auto): an attach with the
// chat the test gave and its events after from, a command with its ack.

import { ChatConnection, setChatConnection, type Socket } from '../plugins/chat/connection';
import type { ChatEvent } from '../conversation/model';

export class FakeChatSocket implements Socket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;

  constructor(private readonly core: FakeChatCore) {}

  send(data: string) {
    this.core.received(this, JSON.parse(data));
  }

  close() {
    this.closed = true;
  }

  deliver(msg: unknown) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
}

export class FakeChatCore {
  readonly sockets: FakeChatSocket[] = [];
  /** Every message of the page, in order. */
  readonly sent: Array<Record<string, unknown>> = [];
  /** auto: sockets open, attaches and commands are answered. */
  auto = false;
  /** The chats an automatic attach answers with, their stored events and
   * the lowest stored seq (1 by default). */
  readonly chats = new Map<string, { chat: Record<string, unknown>; events: ChatEvent[]; first?: number }>();
  /** An automatic ack's error for a command op. */
  readonly refuse = new Map<string, { code: string; message: string }>();
  conn!: ChatConnection;

  install(): ChatConnection {
    this.conn = new ChatConnection(() => {
      const s = new FakeChatSocket(this);
      this.sockets.push(s);
      if (this.auto) queueMicrotask(() => s.onopen?.());
      return s;
    });
    setChatConnection(this.conn);
    return this.conn;
  }

  get socket(): FakeChatSocket | undefined {
    return this.sockets[this.sockets.length - 1];
  }

  /** The latest socket opens. */
  open() {
    this.socket?.onopen?.();
  }

  /** The core ends the latest socket. */
  drop() {
    const s = this.socket;
    if (s) {
      s.closed = true;
      s.onclose?.();
    }
  }

  push(msg: unknown) {
    this.socket?.deliver(msg);
  }

  /** The page's messages of an op. */
  ops(op: string) {
    return this.sent.filter((m) => m.op === op);
  }

  /** Puts a chat an automatic attach answers with. */
  chat(id: string, chat: Record<string, unknown>, events: ChatEvent[] = [], first?: number) {
    this.chats.set(id, { chat: { id, ...chat }, events, first });
  }

  /** A stored event of a chat, to every subscription of it. */
  event(chat: string, ev: ChatEvent) {
    const c = this.chats.get(chat);
    if (c && ev.live !== true) c.events.push(ev);
    for (const m of this.ops('attach'))
      if (m.chat === chat && !this.detached.has(m.sub as string)) this.push({ t: 'event', sub: m.sub, ev });
  }

  private readonly detached = new Set<string>();

  received(socket: FakeChatSocket, msg: Record<string, unknown>) {
    this.sent.push(msg);
    if (msg.op === 'detach') this.detached.add(msg.sub as string);
    if (!this.auto) return;
    if (msg.op === 'attach') {
      const c = this.chats.get(msg.chat as string);
      if (!c) return socket.deliver({ t: 'detached', sub: msg.sub, error: { code: 'unknown_chat', message: 'no such chat' } });
      socket.deliver({ t: 'attached', sub: msg.sub, chat: c.chat, first: c.first ?? 1 });
      const from = typeof msg.from === 'number' ? msg.from : 0;
      for (const ev of c.events) if ((ev.seq ?? 0) > from) socket.deliver({ t: 'event', sub: msg.sub, ev });
    } else if (msg.op === 'command') {
      const cmd = msg.cmd as { op: string };
      const error = this.refuse.get(cmd.op);
      socket.deliver({ t: 'ack', id: msg.id, ...(error ? { error } : {}) });
    }
  }
}
