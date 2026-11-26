// An attached or watching connection: the lines it still has to get, and
// the loop that writes them. Nothing waits for one: a line goes into its
// queue or, when the connection fell too far behind, the connection is
// closed, and its client attaches again with the last sequence number it
// has. An attached connection gets the answer to its attach first, then
// the chat's log after its from (read from the journal a page at a time,
// while the queue fills), then what came since.
import type { Socket } from 'node:net';
import * as chat from '#shared/proto/chatproto/index.ts';
import type { Journal } from './journal.ts';

/** How far a connection may fall behind before it is closed, and how a
 * write goes. */
export interface SubscriberLimits {
  /** Lines queued at most. */
  events: number;
  /** Bytes queued at most. */
  bytes: number;
  /** The bytes of lines one write takes. */
  batch: number;
  /** How long a connection has to take a write. */
  writeMs: number;
}

export const SUBSCRIBER_LIMITS: SubscriberLimits = { events: 8192, bytes: 16 << 20, batch: 64 << 10, writeMs: 30_000 };

/** The log an attached connection gets before what comes after it
 * attached: the stored events with a sequence number in (after, upTo]. */
export interface Replay {
  chat: string;
  after: number;
  upTo: number;
}

export class Subscriber {
  /** The answer to the request; not counted. */
  head: string[] = [];
  /** The log before the queue; not counted. */
  replay: Replay | null = null;
  private queue: string[] = [];
  private queueHead = 0;
  private queued = 0;
  /** Nothing more comes: run ends once all is written. */
  private closing = false;
  /** The connection was given up. */
  private dead = false;
  private wake: (() => void) | null = null;
  /** Something came since take began: run looks again before it waits. */
  private signaled = false;
  /** Settles once run ended and the connection is closed. */
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private readonly sock: Socket;
  private readonly journal: Journal | null;
  private readonly limits: SubscriberLimits;

  constructor(sock: Socket, journal: Journal | null, limits: SubscriberLimits = SUBSCRIBER_LIMITS) {
    this.sock = sock;
    this.journal = journal;
    this.limits = limits;
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  /** Whether the connection was given up. */
  get gone(): boolean {
    return this.dead;
  }

  /** Queues a line (with its newline). False when that put the connection
   * too far behind: it is closed then, and gets nothing more. A line of any
   * size is taken by a connection that waits for nothing else: one event may
   * be larger than the queue. */
  push(line: string): boolean {
    if (this.dead || this.closing) return true;
    const n = Buffer.byteLength(line);
    const count = this.queue.length - this.queueHead;
    if (count >= this.limits.events || (count > 0 && this.queued + n > this.limits.bytes)) {
      this.drop();
      return false;
    }
    this.queue.push(line);
    this.queued += n;
    this.signal();
    return true;
  }

  /** Queues the answer to a command. */
  ack(id: string, e?: chat.ChatError): void {
    this.push(chat.line({ t: chat.EventType.Ack, id, ...(e ? { error: e } : {}) }));
  }

  /** Closes the connection once everything queued is written. */
  finish(): void {
    this.closing = true;
    this.signal();
  }

  /** Closes the connection at once. */
  drop(): void {
    this.dead = true;
    this.head = [];
    this.replay = null;
    this.queue = [];
    this.queueHead = 0;
    this.queued = 0;
    this.sock.destroy();
    this.signal();
  }

  private signal(): void {
    this.signaled = true;
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /** Writes the lines, the head first, then the replay, then the queue, and
   * closes the connection when it ends: after finish or drop, or when a
   * write failed or was not taken in time. */
  async run(): Promise<void> {
    try {
      for (;;) {
        const batch = await this.take();
        if (batch === null) return;
        if (batch === '') {
          if (!this.signaled) await new Promise<void>((r) => (this.wake = r));
          continue;
        }
        if (!(await this.write(batch))) return;
      }
    } finally {
      if (!this.dead && this.closing) {
        // What was written reaches the client before the end.
        this.sock.end();
        setTimeout(() => this.sock.destroy(), this.limits.writeMs).unref?.();
      } else this.sock.destroy();
      this.dead = true;
      this.resolveDone();
    }
  }

  private write(b: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.dead || this.sock.destroyed) return resolve(false);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.sock.off('drain', drained);
        this.sock.off('close', closed);
        resolve(ok);
      };
      const drained = () => done(true);
      const closed = () => done(false);
      const timer = setTimeout(() => {
        this.sock.destroy();
        done(false);
      }, this.limits.writeMs);
      this.sock.once('close', closed);
      if (this.sock.write(b)) done(true);
      else this.sock.once('drain', drained);
    });
  }

  /** The next lines: at least one when there is one, and more while they
   * fit a write; "" when there is none now; null when there is nothing more
   * to write, ever. */
  private async take(): Promise<string | null> {
    this.signaled = false;
    if (this.dead) return null;
    let buf = '';
    let n = 0;
    while (this.head.length > 0) {
      const l = this.head[0]!;
      const b = Buffer.byteLength(l);
      if (n > 0 && n + b > this.limits.batch) return buf;
      buf += l;
      n += b;
      this.head.shift();
    }
    if (n > 0) return buf;
    const r = this.replay;
    if (r) {
      // The log is read while the queue fills.
      let page: { lines: string[]; last: number } | null = null;
      try {
        page = this.journal ? await this.journal.events(r.chat, r.after, r.upTo, this.limits.batch) : null;
      } catch {
        page = null;
      }
      if (this.dead) return null;
      if (!page || page.lines.length === 0) this.replay = null;
      else {
        r.after = page.last;
        return page.lines.join('');
      }
    }
    while (this.queueHead < this.queue.length) {
      const l = this.queue[this.queueHead]!;
      const b = Buffer.byteLength(l);
      if (n > 0 && n + b > this.limits.batch) break;
      buf += l;
      n += b;
      this.queue[this.queueHead++] = '';
      this.queued -= b;
    }
    if (this.queueHead === this.queue.length) {
      this.queue = [];
      this.queueHead = 0;
    } else if (this.queueHead >= 1024 && this.queueHead * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }
    if (n > 0) return buf;
    return this.closing ? null : '';
  }
}
