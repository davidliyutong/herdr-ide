// A channel is a WebSocket as the core sees it, whichever host carries it:
// a WebSocket of Bun.serve on the command line, a MessagePort in the
// desktop app. Messages are text or binary, in order; the host frames
// them.

export type Message = string | Uint8Array;

export interface Channel {
  send(data: Message): void;
  /** Bytes given to send that the host has not passed on yet: a client
   * that does not read lets it grow. */
  readonly buffered: number;
  /** Ends the channel; the handlers' close follows. */
  close(code?: number, reason?: string): void;
}

/** What a channel's owner does with what arrives. */
export interface ChannelHandlers {
  message(data: Message): void;
  /** The channel ended, by either side. */
  close?(code: number, reason: string): void;
  /** What was buffered has gone out (backpressure eased). */
  drain?(): void;
}

/** Adopts a channel once it is open: the handlers of its messages. */
export type ChannelOpen = (ch: Channel) => ChannelHandlers;

/** Close codes. */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  PolicyViolation: 1008,
  TooBig: 1009,
  Internal: 1011,
  /** The client is too far behind to catch up; it reconnects. */
  Overflow: 4008,
} as const;

/** Decodes a text message as JSON; undefined for binary or invalid JSON. */
export function parseJSON(data: Message): unknown {
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** Two channels joined to each other in memory (tests, and a host that
 * joins a port to the core in the same process): what one sends the other
 * receives. Each side is adopted with its open. */
export function channelPair(): {
  a: Channel & { adopt(open: ChannelOpen): void };
  b: Channel & { adopt(open: ChannelOpen): void };
} {
  type Side = Channel & { adopt(open: ChannelOpen): void; handlers?: ChannelHandlers; queue: Message[]; peer?: Side; closed: boolean };
  const side = (): Side => {
    const s: Side = {
      queue: [],
      closed: false,
      buffered: 0,
      send(data) {
        if (s.closed) return;
        const p = s.peer!;
        queueMicrotask(() => (p.handlers ? p.handlers.message(data) : p.queue.push(data)));
      },
      close(code = CloseCode.Normal, reason = '') {
        if (s.closed) return;
        s.closed = true;
        s.peer!.closed = true;
        queueMicrotask(() => {
          s.handlers?.close?.(code, reason);
          s.peer!.handlers?.close?.(code, reason);
        });
      },
      adopt(open) {
        s.handlers = open(s);
        for (const m of s.queue.splice(0)) s.handlers.message(m);
      },
    };
    return s;
  };
  const a = side();
  const b = side();
  a.peer = b;
  b.peer = a;
  return { a, b };
}
