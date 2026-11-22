// The page's one WebSocket to the core's chat plugin (protocol.ts WS_PATH,
// internal/plugins/chat/wire.go): every chat of every machine this page
// shows goes over it, each as a subscription of its own, and so do their
// commands. It opens with the first subscription or command and closes
// once none is left for IDLE_CLOSE_MS. When it drops it connects again
// (RETRY_MIN_MS, doubling to RETRY_MAX_MS) and attaches every subscription
// again after the last stored event its handler has; the handler hears
// that it attached again (attached with again), so its source can say so
// before the events that follow. A command's promise settles with its ack;
// one sent before the connection dropped (offline), not answered within
// ACK_TIMEOUT_MS (timeout), or whose subscription the core lost meanwhile
// (lost, offline, not_attached) is refused with CommandError.unsure: it
// was sent, and whether the host took it is not known. One that never left
// the page is refused without it.
//
// What the core sends is checked member by member: a message that is no
// JSON object, of a type this version does not know or for a subscription
// or command the page does not have is passed over.

import {
  isChatId,
  MAX_CLIENT_MESSAGE,
  MAX_SUBS,
  MAX_SUBS_PER_MACHINE,
  WS_PATH,
  type ChatError,
  type ClientMessage,
  type Command,
  type Event,
} from './protocol';

/** The part of WebSocket the connection uses, so tests can supply their own. */
export interface Socket {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** What a subscription tells its owner, in the order the core sent it. */
export interface SubHandler {
  /** The last stored seq the owner has: attaching again sends the stored
   * events after it. */
  from(): number;
  /** The core attached the chat: the chat as the host states it, the
   * lowest stored seq; again after the page's connection came back. */
  attached(chat: Record<string, unknown>, first: number | undefined, again: boolean): void;
  event(ev: Event): void;
  /** The core ended the subscription (the machine left, the chat is gone,
   * the plugin was turned off, too many): it is over; the owner may
   * attach again. */
  detached(error: ChatError): void;
  /** The page's connection dropped: the subscription waits for it to come
   * back, when it attaches again by itself. */
  offline?(): void;
}

/** A subscription: ends with detach (also before it attached). */
export interface Subscription {
  readonly id: string;
  detach(): void;
}

/** The error of a command or a subscription, with its code (chatproto's,
 * the core's, or the page's own: offline, timeout, too_many, too_large).
 * unsure: the command was sent and may have been carried out all the
 * same. */
export class CommandError extends Error {
  constructor(
    readonly code: string,
    message = code,
    readonly stderr?: string,
    readonly unsure = false,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

/** The core's codes of a command's answer that say the command was sent
 * on a subscription that ended before the host's answer came. */
const UNSURE_ACKS: ReadonlySet<string> = new Set(['lost', 'offline', 'not_attached']);

/** The page's own code of a subscription whose connection was closed for
 * good (close): nothing attaches it again. */
export const CLOSED = 'closed';

/** How long a command waits for its ack. */
export const ACK_TIMEOUT_MS = 60_000;
/** How long the connection stays open without subscriptions or commands. */
export const IDLE_CLOSE_MS = 60_000;
/** The waits before connecting again: the first, and the most. */
export const RETRY_MIN_MS = 500;
export const RETRY_MAX_MS = 8_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An error of the core, read from what it sent; undefined for none. */
export function readError(v: unknown): ChatError | undefined {
  if (!isObject(v)) return undefined;
  const code = typeof v.code === 'string' && v.code ? v.code.slice(0, 64) : 'failed';
  const out: ChatError = { code, message: typeof v.message === 'string' ? v.message.slice(0, 2000) : '' };
  if (typeof v.stderr === 'string' && v.stderr) out.stderr = v.stderr.slice(-16_000);
  return out;
}

const seqOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

interface Sub {
  id: string;
  m: string;
  chat: string;
  handler: SubHandler;
  /** The core answered its attach on the current connection. */
  attached: boolean;
  /** It attached once already (an attach after that is again). */
  once: boolean;
  /** It was sent on the current connection. */
  sent: boolean;
}

interface Pending {
  resolve(): void;
  reject(e: CommandError): void;
  timer: ReturnType<typeof setTimeout>;
  /** The message, until it is sent. */
  msg?: string;
}

export class ChatConnection {
  /** The connection came (true) or went (false). */
  private readonly listeners = new Set<(up: boolean) => void>();
  private socket: Socket | null = null;
  private up = false;
  private closed = false;
  private retry = RETRY_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;
  private readonly subs = new Map<string, Sub>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly open: () => Socket) {}

  /** A connection to the core that served the page. */
  static toCore(): ChatConnection {
    const url = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;
    return new ChatConnection(() => new WebSocket(url()) as unknown as Socket);
  }

  get connected(): boolean {
    return this.up;
  }

  /** The subscriptions the page has. */
  get size(): number {
    return this.subs.size;
  }

  /** Calls fn when the connection comes (true) or goes (false); returns
   * the stop. */
  onConnection(fn: (up: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Subscribes to a chat's events after handler.from(). Past MAX_SUBS
   * subscriptions, or MAX_SUBS_PER_MACHINE of one machine, it ends at once
   * (too_many). */
  attach(m: string, chat: string, handler: SubHandler): Subscription {
    const id = `s${this.nextId++}`;
    const sub: Sub = { id, m, chat, handler, attached: false, once: false, sent: false };
    const self = this;
    const subscription: Subscription = {
      id,
      detach() {
        self.detach(id);
      },
    };
    const mine = [...this.subs.values()].filter((s) => s.m === m).length;
    if (this.subs.size >= MAX_SUBS || mine >= MAX_SUBS_PER_MACHINE || !isChatId(chat) || this.closed) {
      const code = this.closed ? CLOSED : !isChatId(chat) ? 'bad_request' : 'too_many';
      queueMicrotask(() => handler.detached({ code, message: '' }));
      return subscription;
    }
    this.subs.set(id, sub);
    this.busy();
    if (this.up) this.sendAttach(sub);
    else this.start();
    return subscription;
  }

  /** Sends a command for a chat the page has a subscription to (the core
   * relays it on that subscription; not_attached without one); resolves
   * once the host took it, rejects with a CommandError otherwise. */
  command(m: string, chat: string, cmd: Command): Promise<void> {
    if (this.closed) return Promise.reject(new CommandError('offline'));
    const id = `k${this.nextId++}`;
    const msg: ClientMessage = { op: 'command', id, m, chat, cmd };
    const text = JSON.stringify(msg);
    if (text.length > MAX_CLIENT_MESSAGE) return Promise.reject(new CommandError('too_large'));
    this.busy();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.settle(
            id,
            p.msg === undefined ? new CommandError('timeout', 'no answer', undefined, true) : new CommandError('offline', 'not connected'),
          ),
        ACK_TIMEOUT_MS,
      );
      const p: Pending = { resolve, reject, timer };
      this.pending.set(id, p);
      if (this.up) this.socket?.send(text);
      else {
        p.msg = text;
        this.start();
      }
    });
  }

  /** Ends the connection for good (tests; a page that unloads). */
  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.idleTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.onclose = socket.onmessage = socket.onopen = null;
    socket?.close();
    this.dropped();
    for (const sub of [...this.subs.values()]) sub.handler.detached({ code: CLOSED, message: '' });
    this.subs.clear();
    for (const [id, p] of [...this.pending]) this.settle(id, new CommandError('offline', 'offline', undefined, p.msg === undefined));
  }

  private start(): void {
    if (this.socket || this.closed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    let socket: Socket;
    try {
      socket = this.open();
    } catch {
      this.again();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.up = true;
      this.retry = RETRY_MIN_MS;
      for (const sub of this.subs.values()) this.sendAttach(sub);
      for (const p of this.pending.values()) {
        if (p.msg === undefined) continue;
        socket.send(p.msg);
        delete p.msg;
      }
      for (const fn of [...this.listeners]) fn(true);
      this.idle();
    };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.dropped();
      this.again();
    };
    socket.onmessage = (ev) => {
      if (socket === this.socket && typeof ev.data === 'string') this.text(ev.data);
    };
  }

  /** What the connection's end means for what used it. */
  private dropped(): void {
    const wasUp = this.up;
    this.up = false;
    for (const [id, p] of [...this.pending])
      if (p.msg === undefined) this.settle(id, new CommandError('offline', 'offline', undefined, true));
    for (const sub of this.subs.values()) {
      const was = sub.attached || sub.sent;
      sub.attached = sub.sent = false;
      if (was) sub.handler.offline?.();
    }
    if (wasUp) for (const fn of [...this.listeners]) fn(false);
  }

  /** Connects again later, while anything needs the connection. */
  private again(): void {
    if (this.closed || (!this.subs.size && !this.pending.size)) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start(), this.retry);
    this.retry = Math.min(this.retry * 2, RETRY_MAX_MS);
  }

  private sendAttach(sub: Sub): void {
    const from = sub.handler.from();
    const msg: ClientMessage = { op: 'attach', sub: sub.id, m: sub.m, chat: sub.chat };
    if (from > 0) msg.from = from;
    sub.sent = true;
    this.socket?.send(JSON.stringify(msg));
  }

  private detach(id: string): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    this.subs.delete(id);
    if (this.up && sub.sent) this.socket?.send(JSON.stringify({ op: 'detach', sub: id } satisfies ClientMessage));
    this.idle();
  }

  private settle(id: string, error?: CommandError): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (error) p.reject(error);
    else p.resolve();
    this.idle();
  }

  /** Something uses the connection: it stays. */
  private busy(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Closes the connection once nothing used it for IDLE_CLOSE_MS. */
  private idle(): void {
    if (this.subs.size || this.pending.size || this.idleTimer !== undefined) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.subs.size || this.pending.size) return;
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      const socket = this.socket;
      this.socket = null;
      if (socket) socket.onclose = socket.onmessage = socket.onopen = null;
      socket?.close();
      this.dropped();
    }, IDLE_CLOSE_MS);
  }

  private text(text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(msg)) return;
    switch (msg.t) {
      case 'attached': {
        const sub = typeof msg.sub === 'string' ? this.subs.get(msg.sub) : undefined;
        if (!sub) return;
        const again = sub.once;
        sub.attached = sub.once = true;
        sub.handler.attached(isObject(msg.chat) ? msg.chat : {}, seqOf(msg.first), again);
        return;
      }
      case 'event': {
        const sub = typeof msg.sub === 'string' ? this.subs.get(msg.sub) : undefined;
        if (!sub || !sub.attached || !isObject(msg.ev) || typeof msg.ev.t !== 'string') return;
        sub.handler.event(msg.ev as unknown as Event);
        return;
      }
      case 'detached': {
        const sub = typeof msg.sub === 'string' ? this.subs.get(msg.sub) : undefined;
        if (!sub) return;
        this.subs.delete(sub.id);
        sub.handler.detached(readError(msg.error) ?? { code: 'ended', message: '' });
        this.idle();
        return;
      }
      case 'ack': {
        if (typeof msg.id !== 'string' || !this.pending.has(msg.id)) return;
        const e = readError(msg.error);
        this.settle(msg.id, e && new CommandError(e.code, e.message, e.stderr, UNSURE_ACKS.has(e.code)));
        return;
      }
    }
  }
}

let shared: ChatConnection | undefined;

/** The page's connection, made at its first use. */
export function chatConnection(): ChatConnection {
  shared ??= ChatConnection.toCore();
  return shared;
}

/** Sets the page's connection (tests); the one before is closed. */
export function setChatConnection(c: ChatConnection | undefined) {
  if (shared && shared !== c) shared.close();
  shared = c;
}
