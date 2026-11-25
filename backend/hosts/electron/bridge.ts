// The desktop app's bridge between its main process and the hub in its
// utility process: the requests of the app's windows, which the main
// process intercepts at the app's origin (desktop/src/protocol.ts), and
// channels, the WebSockets of a browser, as MessagePorts.
//
// A request has a MessagePort of its own. The main process sends the
// request's head on the utility process's parent port with the port, then
// the body in chunks; the hub answers the response's head, then its body
// in chunks. Either side sends at most WINDOW chunks the other has not
// taken yet: a receiver gives credit back as the chunks are read, so a
// stalled reader stalls the writer instead of filling memory. A response
// body that fails ends with an error, which the main process passes on as
// a failed transfer.
//
// A channel is a MessagePort too, between the hub and its client (a
// page's frame, which gets the other end from the main process, or the
// main process itself). Data are strings (text messages) and binary
// messages; the rest are control frames (ChannelControl). The client acks
// what it took in, so the hub sees what is buffered as on a WebSocket.
//
// Without imports: the desktop shell's main process, the utility process,
// the web UI's tests and the tests of both import it as it is.

/** One end of a MessagePort, whichever runtime gives it (Electron's
 * MessagePortMain, Node's worker_threads MessagePort). */
export interface Port {
  post(msg: unknown): void;
  /** Starts delivering: each message's data to message, then closed once
   * the port is closed (by either side, or the other side's process
   * ending). */
  listen(message: (data: unknown) => void, closed: () => void): void;
  close(): void;
}

/** What the bridge uses of Electron's MessagePortMain. */
export interface ElectronPort {
  on(event: 'message', fn: (e: { data: unknown }) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
  start(): void;
  close(): void;
  postMessage(msg: unknown): void;
}

/** What the bridge uses of a worker_threads MessagePort. */
export interface NodePort {
  on(event: 'message', fn: (data: unknown) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
  close(): void;
  postMessage(msg: unknown): void;
}

export function electronPort(p: ElectronPort): Port {
  return {
    post: (m) => p.postMessage(m),
    listen(message, closed) {
      p.on('message', (e) => message(e.data));
      p.on('close', once(closed));
      p.start();
    },
    close: () => p.close(),
  };
}

export function nodePort(p: NodePort): Port {
  return {
    post: (m) => p.postMessage(m),
    listen(message, closed) {
      p.on('message', message);
      p.on('close', once(closed));
    },
    close: () => p.close(),
  };
}

/** A timer that does not keep a Node process alive; typed alike under
 * Node's and the DOM's types. */
type Timer = Parameters<typeof clearTimeout>[0];
function later(fn: () => void, ms: number): Timer {
  const t: unknown = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return t as Timer;
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

// ---- the utility process's parent port

/** What the hub of the desktop app is started with: what the command
 * line's hub gets as flags, and what the app holds for it. */
export interface HubStart {
  /** The hub's instance (`desktop`, or a development one). */
  instance: string;
  /** The instance of the machines' nodes. */
  nodeInstance: string;
  /** Connects the local machine only (development). */
  localOnly: boolean;
  /** The app's origin, https://<slug>.localhost: the one origin the
   * hub's guard allows besides its own. */
  origin: string;
  /** The key with which the shell signs the user's answers to the
   * system's prompts (the vault's desktop proofs). */
  verifyKey: string;
  /** The payloads laid out as scripts/build.sh stages them: agents/,
   * hc/, encoder/, ext/. */
  payload: string;
  /** The web UI's built files. */
  web: string;
  /** Uncompressed machine builds searched first (development). */
  agentDir?: string;
  /** Directories with code-server releases and extensions (offline). */
  seedDirs?: string[];
}

/** The main process's messages on the parent port; request and channel
 * carry their port. */
export type ToHub =
  { t: 'start'; start: HubStart } | { t: 'request'; head: RequestHead } | { t: 'channel'; head: ChannelHead } | { t: 'stop' };

/** The utility process's: started, or why not. */
export type FromHub = { t: 'ready' } | { t: 'failed'; message: string };

// ---- requests

/** Chunks a side may send that the other has not taken yet. */
export const WINDOW = 8;

export interface RequestHead {
  method: string;
  url: string;
  headers: [string, string][];
  /** A body follows. */
  body: boolean;
}

export interface ResponseHead {
  status: number;
  statusText: string;
  headers: [string, string][];
}

/** Frames on a request's port (both ways): its body or the response's,
 * credit for chunks taken, the request's end. */
type Frame =
  | { t: 'head'; head: ResponseHead }
  | { t: 'chunk'; data: Uint8Array }
  | { t: 'end' }
  | { t: 'error'; message: string }
  | { t: 'credit'; n: number }
  | { t: 'abort' };

const isFrame = (m: unknown): m is Frame => typeof m === 'object' && m !== null && typeof (m as { t?: unknown }).t === 'string';

/** Statuses whose responses have no body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** Credit for chunks to send: take waits for one, end gives up waiting. */
class Credit {
  private n: number;
  private ended = false;
  private waiter?: () => void;

  constructor(n: number) {
    this.n = n;
  }

  give(n: number): void {
    if (!Number.isInteger(n) || n <= 0) return;
    this.n += n;
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  /** Whether a chunk may go: false once ended. */
  async take(): Promise<boolean> {
    while (this.n <= 0 && !this.ended) await new Promise<void>((r) => (this.waiter = r));
    if (this.ended) return false;
    this.n--;
    return true;
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }
}

/** A body arriving in chunks as a stream; credit goes back to the sender
 * as its reader takes them. */
class Inbound {
  readonly stream: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private received = 0;
  private credited = 0;
  private done = false;

  constructor(credit: (n: number) => void, cancel: () => void) {
    this.stream = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          this.controller = c;
        },
        // Called while fewer than half the window are queued.
        pull: () => {
          if (this.received > this.credited && !this.done) {
            credit(this.received - this.credited);
            this.credited = this.received;
          }
        },
        cancel: () => {
          this.done = true;
          cancel();
        },
      },
      { highWaterMark: WINDOW / 2 },
    );
  }

  push(data: unknown): void {
    if (this.done) return;
    this.received++;
    this.controller.enqueue(bytes(data));
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    this.controller.close();
  }

  fail(e: Error): void {
    if (this.done) return;
    this.done = true;
    this.controller.error(e);
  }
}

/** Data that came through a port as bytes: a Uint8Array (Node and
 * Electron keep the view), an ArrayBuffer, or another view. */
function bytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(0);
}

/** A copy of exactly the view's bytes: a port clones a view's whole
 * buffer (a pooled Buffer's slab, say), not just its part. */
function compact(b: Uint8Array): Uint8Array {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice();
}

/** Sends a stream's chunks as credit allows; false when it ended early
 * (credit ended: the other side is gone or cancelled). */
async function pump(body: ReadableStream<Uint8Array>, credit: Credit, send: (chunk: Uint8Array) => void): Promise<boolean> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (value.byteLength === 0) continue;
      if (!(await credit.take())) {
        void reader.cancel().catch(() => {});
        return false;
      }
      send(compact(value));
    }
  } finally {
    reader.releaseLock();
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The main process's side of a request: sends it on port (whose other
 * end went to the utility process with the head) and resolves with the
 * hub's response, whose body streams as it is read. A response body that
 * breaks off errors; cancelling it tells the hub. */
export function request(port: Port, head: RequestHead, body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const credit = new Credit(WINDOW);
    let inbound: Inbound | undefined;
    let settled = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      credit.end();
      signal?.removeEventListener('abort', abort);
      port.close();
    };
    const abort = () => {
      if (finished) return;
      port.post({ t: 'abort' } satisfies Frame);
      const e = new Error('aborted');
      inbound?.fail(e);
      if (!settled) {
        settled = true;
        reject(e);
      }
      finish();
    };
    port.listen(
      (m) => {
        if (!isFrame(m)) return;
        switch (m.t) {
          case 'head': {
            if (settled) return;
            settled = true;
            const empty = head.method === 'HEAD' || NULL_BODY.has(m.head.status);
            if (!empty)
              inbound = new Inbound(
                (n) => port.post({ t: 'credit', n } satisfies Frame),
                () => abort(),
              );
            resolve(
              new Response(inbound?.stream ?? null, { status: m.head.status, statusText: m.head.statusText, headers: m.head.headers }),
            );
            if (empty) finish();
            return;
          }
          case 'chunk':
            inbound?.push(m.data);
            return;
          case 'end':
            inbound?.end();
            finish();
            return;
          case 'error': {
            const e = new Error(m.message);
            inbound?.fail(e);
            if (!settled) {
              settled = true;
              reject(e);
            }
            finish();
            return;
          }
          case 'credit':
            credit.give(m.n);
            return;
        }
      },
      () => {
        if (finished) return;
        const e = new Error('the hub is gone');
        inbound?.fail(e);
        if (!settled) {
          settled = true;
          reject(e);
        }
        finish();
      },
    );
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (!body) return;
    void pump(body, credit, (data) => port.post({ t: 'chunk', data } satisfies Frame))
      .then((complete) => {
        if (complete && !finished) port.post({ t: 'end' } satisfies Frame);
      })
      .catch(() => {
        // The body broke off (the page cancelled an upload): the hub sees
        // the request aborted, not a short body.
        abort();
      });
  });
}

/** The utility process's side of a request on port: the request as
 * handle gets it (its signal aborts when the client goes), and the
 * response sent back as it is read. */
export async function serveRequest(port: Port, head: RequestHead, handle: (req: Request) => Promise<Response>): Promise<void> {
  const aborted = new AbortController();
  const credit = new Credit(WINDOW);
  let closed = false;
  const body = head.body
    ? new Inbound(
        (n) => port.post({ t: 'credit', n } satisfies Frame),
        () => {},
      )
    : undefined;
  const gone = () => {
    aborted.abort();
    body?.fail(new Error('aborted'));
    credit.end();
  };
  port.listen(
    (m) => {
      if (!isFrame(m)) return;
      switch (m.t) {
        case 'chunk':
          body?.push(m.data);
          return;
        case 'end':
          body?.end();
          return;
        case 'abort':
          gone();
          return;
        case 'credit':
          credit.give(m.n);
          return;
      }
    },
    () => {
      closed = true;
      gone();
    },
  );
  let res: Response;
  try {
    const req = new Request(head.url, {
      method: head.method,
      headers: head.headers,
      body: body?.stream,
      signal: aborted.signal,
      // A streamed body (Node's fetch types know the member).
      ...({ duplex: 'half' } as object),
    });
    res = await handle(req);
  } catch (e) {
    res = Response.json({ error: 'internal', message: message(e) }, { status: 500 });
  }
  if (closed || aborted.signal.aborted) {
    void res.body?.cancel().catch(() => {});
    return;
  }
  // Set-Cookie lines go one by one (Headers.forEach joins them in some
  // runtimes).
  const headers: [string, string][] = [];
  res.headers.forEach((v, k) => {
    if (k !== 'set-cookie') headers.push([k, v]);
  });
  for (const c of res.headers.getSetCookie()) headers.push(['set-cookie', c]);
  port.post({ t: 'head', head: { status: res.status, statusText: res.statusText, headers } } satisfies Frame);
  if (!res.body || head.method === 'HEAD' || NULL_BODY.has(res.status)) {
    void res.body?.cancel().catch(() => {});
    return;
  }
  try {
    if (await pump(res.body, credit, (data) => port.post({ t: 'chunk', data } satisfies Frame))) port.post({ t: 'end' } satisfies Frame);
  } catch (e) {
    if (!closed) port.post({ t: 'error', message: message(e) } satisfies Frame);
  }
}

// ---- channels

export interface ChannelHead {
  url: string;
  headers: [string, string][];
}

/** The control frames of a channel; anything else on its port is a
 * message: a string, or bytes. open is the hub's word that the channel
 * is up (protocol: the subprotocol chosen); close ends it (from either
 * side; the other side answers with its own close, then the client closes
 * the port); ack counts what the client took in (strings by their length,
 * bytes by theirs). */
export type ChannelControl = { t: 'open'; protocol: string } | { t: 'close'; code: number; reason: string } | { t: 'ack'; n: number };

/** The client acks once it took in this much, and what it took in less
 * than that at its next turn. */
export const ACK_BYTES = 64 << 10;

/** A close code for a channel the hub refused or lost, as a browser
 * reports a failed WebSocket. */
export const ABNORMAL = 1006;

/** The close code of a channel whose handlers failed in the hub. */
const INTERNAL = 1011;
/** WebSocket's close code for a message too big to take. */
export const TOO_BIG = 1009;
/** The largest message a channel takes from a client, as the command line
 * takes over a WebSocket (Bun.serve's maxPayloadLength, hosts/bun/serve.ts),
 * and the most a client may send before the hub takes the channel. */
export const MAX_MESSAGE = 64 << 20;

const isControl = (m: unknown): m is ChannelControl =>
  typeof m === 'object' && m !== null && !ArrayBuffer.isView(m) && !(m instanceof ArrayBuffer);

/** The size a message counts for in acks. */
export const channelSize = (d: string | Uint8Array | ArrayBuffer): number => (typeof d === 'string' ? d.length : d.byteLength);

/** A channel as the hub's kernel takes it (kernel/channel.ts Channel). */
export interface HubChannel {
  send(data: string | Uint8Array): void;
  readonly buffered: number;
  close(code?: number, reason?: string): void;
}

/** What the hub does with a channel (kernel/channel.ts ChannelHandlers). */
export interface HubChannelHandlers {
  message(data: string | Uint8Array): void;
  close?(code: number, reason: string): void;
  drain?(): void;
}

/** How a host upgrades a request to a channel (kernel/http/env.ts
 * Peer.upgrade). */
export type Upgrade = (open: (ch: HubChannel) => HubChannelHandlers, opts?: { compress?: boolean }) => Response;

/** How long a side that closed waits for the other's close before it
 * closes the port itself. */
const CLOSE_WAIT_MS = 5000;

/** The utility process's side of a channel on port: the request with the
 * channel's head as handle gets it, with the upgrade that adopts port as
 * the channel. A request the hub answers without upgrading is refused:
 * the client sees an abnormal close, with the status and the error code. */
export async function serveChannel(
  port: Port,
  head: ChannelHead,
  handle: (req: Request, upgrade: Upgrade) => Promise<Response>,
): Promise<void> {
  let open: ((ch: HubChannel) => HubChannelHandlers) | undefined;
  // What the client sends before the hub takes the channel, up to
  // MAX_MESSAGE; more ends the channel once it opens.
  const early: unknown[] = [];
  let earlyBytes = 0;
  let receive: (m: unknown) => void = (m) => {
    if (typeof m === 'string') earlyBytes += m.length;
    else if (m instanceof ArrayBuffer || ArrayBuffer.isView(m)) earlyBytes += m.byteLength;
    if (earlyBytes <= MAX_MESSAGE) early.push(m);
  };
  let gone: () => void = () => {};
  let closedEarly = false;
  port.listen(
    (m) => receive(m),
    () => {
      closedEarly = true;
      gone();
    },
  );
  const upgrade: Upgrade = (o) => {
    open = o;
    return new Response(null, { status: 200 });
  };
  let res: Response | undefined;
  try {
    res = await handle(new Request(head.url, { headers: head.headers }), upgrade);
  } catch {
    res = undefined;
  }
  if (!open) {
    let reason = `refused ${res?.status ?? 500}`;
    try {
      const j = (await res?.json()) as { error?: unknown } | undefined;
      if (typeof j?.error === 'string') reason += ` ${j.error}`;
    } catch {
      // no JSON answer
    }
    port.post({ t: 'close', code: ABNORMAL, reason: reason.slice(0, 120) } satisfies ChannelControl);
    later(() => port.close(), CLOSE_WAIT_MS);
    return;
  }
  let sent = 0;
  let acked = 0;
  let closed = false;
  let timer: Timer;
  let handlers: HubChannelHandlers | undefined;
  const end = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => {
      try {
        handlers?.close?.(code, reason);
      } catch {
        // The channel is over; what its handler threw ends nothing else.
      }
    });
  };
  const ch: HubChannel = {
    send(data) {
      if (closed) return;
      sent += channelSize(data);
      port.post(typeof data === 'string' ? data : compact(data));
    },
    get buffered() {
      return sent - acked;
    },
    close(code = 1000, reason = '') {
      if (closed) return;
      port.post({ t: 'close', code, reason } satisfies ChannelControl);
      timer = later(() => port.close(), CLOSE_WAIT_MS);
      end(code, reason);
    },
  };
  gone = () => {
    clearTimeout(timer);
    end(ABNORMAL, '');
  };
  // What the hub's handlers throw ends their channel, not the process.
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      ch.close(INTERNAL, 'internal error');
    }
  };
  const take = (d: string | Uint8Array) => {
    if (closed) return;
    if (channelSize(d) > MAX_MESSAGE) return ch.close(TOO_BIG, 'message too big');
    safely(() => handlers?.message(d));
  };
  receive = (m) => {
    if (typeof m === 'string') return take(m);
    if (m instanceof ArrayBuffer || ArrayBuffer.isView(m)) return take(bytes(m));
    if (!isControl(m)) return;
    if (m.t === 'ack') {
      if (Number.isFinite(m.n) && m.n > 0) acked = Math.min(sent, acked + m.n);
      safely(() => handlers?.drain?.());
    } else if (m.t === 'close') {
      // The client's close: answered, then the client closes the port, or
      // this side once it waited for that.
      if (!closed) {
        port.post({ t: 'close', code: m.code, reason: m.reason } satisfies ChannelControl);
        timer = later(() => port.close(), CLOSE_WAIT_MS);
      }
      end(typeof m.code === 'number' ? m.code : 1005, typeof m.reason === 'string' ? m.reason : '');
    }
  };
  try {
    handlers = open(ch);
  } catch (e) {
    // The hub could not take the channel (a program it starts failed):
    // the client sees it end as a server's failure.
    closed = true;
    port.post({ t: 'close', code: INTERNAL, reason: message(e).slice(0, 120) } satisfies ChannelControl);
    later(() => port.close(), CLOSE_WAIT_MS);
    return;
  }
  port.post({ t: 'open', protocol: '' } satisfies ChannelControl);
  for (const m of early.splice(0)) receive(m);
  if (earlyBytes > MAX_MESSAGE) ch.close(TOO_BIG, 'message too big');
  if (closedEarly) gone();
}

/** A channel's client in the main process (the shell following its hub,
 * and tests): what the web UI's PortSocket is in a page. */
export interface ChannelClient {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export function channelClient(
  port: Port,
  on: { open?(): void; message(data: string | Uint8Array): void; close?(code: number, reason: string): void },
): ChannelClient {
  let state: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  let unacked = 0;
  let ackTimer: Timer;
  const ack = () => {
    clearTimeout(ackTimer);
    ackTimer = undefined;
    if (unacked > 0 && state !== 'closed') port.post({ t: 'ack', n: unacked } satisfies ChannelControl);
    unacked = 0;
  };
  const ended = (code: number, reason: string) => {
    if (state === 'closed') return;
    state = 'closed';
    clearTimeout(ackTimer);
    port.close();
    on.close?.(code, reason);
  };
  port.listen(
    (m) => {
      if (state === 'closed') return;
      if (typeof m === 'string' || m instanceof ArrayBuffer || ArrayBuffer.isView(m)) {
        const d = typeof m === 'string' ? m : bytes(m);
        unacked += channelSize(d);
        if (unacked >= ACK_BYTES) ack();
        else ackTimer ??= later(ack, 0);
        on.message(d);
        return;
      }
      if (!isControl(m)) return;
      if (m.t === 'open' && state === 'connecting') {
        state = 'open';
        on.open?.();
      } else if (m.t === 'close') ended(m.code, m.reason);
    },
    () => ended(ABNORMAL, ''),
  );
  return {
    send(data) {
      if (state === 'open') port.post(typeof data === 'string' ? data : compact(data));
    },
    close(code = 1000, reason = '') {
      if (state === 'closed' || state === 'closing') return;
      state = 'closing';
      port.post({ t: 'close', code, reason } satisfies ChannelControl);
      // The hub answers; one that does not is not waited for.
      later(() => ended(code, reason), CLOSE_WAIT_MS);
    },
  };
}
