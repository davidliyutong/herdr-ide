// What waits to be sent to one browser window: a few messages beyond what
// its channel holds unsent, handed on in order while the channel takes
// them. A message that does not fit is refused (the router then skips
// frames); a window whose channel takes nothing for writeMs is closed.
import { CloseCode, type Channel, type Message } from '#kernel/channel.ts';

export interface OutboxOptions {
  /** Messages kept beyond what the channel holds. */
  maxMessages: number;
  /** Bytes the channel may hold unsent before messages wait here. */
  maxBuffered: number;
  /** How long the channel may take nothing before it is closed. */
  writeMs: number;
  now: () => number;
}

export class Outbox {
  private readonly ch: Channel;
  private readonly o: OutboxOptions;
  private queue: Message[] = [];
  private poll: ReturnType<typeof setInterval> | undefined;
  private blockedSince = 0;
  private closed = false;

  constructor(ch: Channel, o: OutboxOptions) {
    this.ch = ch;
    this.o = o;
  }

  /** Queues a message without blocking; false when the queue is full. */
  push(m: Message): boolean {
    if (this.closed || this.queue.length >= this.o.maxMessages) return false;
    this.queue.push(m);
    this.flush();
    return true;
  }

  /** Hands what waits to the channel while it takes it. */
  flush(): void {
    if (this.closed) return;
    while (this.queue.length) {
      if (this.ch.buffered >= this.o.maxBuffered) return this.blocked();
      this.ch.send(this.queue.shift()!);
      this.blockedSince = 0;
    }
    this.unblocked();
  }

  /** The channel holds as much as it may: look again until it takes more,
   * or close a channel that took nothing for writeMs. */
  private blocked(): void {
    if (!this.blockedSince) this.blockedSince = this.o.now();
    if (this.poll) return;
    const every = Math.max(1, Math.min(100, this.o.writeMs / 4));
    this.poll = setInterval(() => {
      if (this.o.now() - this.blockedSince > this.o.writeMs) {
        this.close();
        this.ch.close(CloseCode.Normal, 'too slow');
      } else this.flush();
    }, every);
  }

  private unblocked(): void {
    this.blockedSince = 0;
    clearInterval(this.poll);
    this.poll = undefined;
  }

  /** Drops what waits and sends nothing more. */
  close(): void {
    this.closed = true;
    this.queue = [];
    this.unblocked();
  }
}
