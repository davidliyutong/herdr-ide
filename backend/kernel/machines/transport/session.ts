// Yamux sessions to machines' agents, which machines' nodes serve: through
// the node's socket for the local machine (local.ts), over ssh stdio and
// `node dial` for remote machines (ssh.ts).
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { MAX_BODY, readBody, readLine, writeLine, type Header, type Reply, type Stat } from '#shared/proto/agentproto/index.ts';
import { write } from '#shared/lib/streamio.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { Session as Yamux, closeStream, type Stream } from '#shared/proto/yamux.ts';

/** Names this hub to the nodes it reaches (NodeHello.client): random, the
 * same for all its sessions while the process runs. */
export const CLIENT_ID = randomBytes(8).toString('hex');

/** How long a reply may take when the caller gives no deadline of its own,
 * so a stream whose reply never comes ends. */
export let replyTimeoutMs = 60_000;
/** For tests. */
export function setReplyTimeout(ms: number): void {
  replyTimeoutMs = ms;
}

/** A stream the agent answered: write to stream; read what follows the
 * reply from reader (reader.release() hands the rest on to a pipe). */
export interface AgentStream {
  stream: Stream;
  reader: Reader;
}

export { closeStream };

export class AgentError extends Error {
  /** The agent's reply when it refused. */
  readonly reply?: Reply;

  constructor(message: string, reply?: Reply) {
    super(message);
    this.reply = reply;
  }
}

/** A live connection to one agent. */
export class Session {
  private readonly ys: Yamux;
  private ended = false;
  private reason: Error | null = null;
  private waiters: Array<() => void> = [];

  private readonly closer?: () => void;

  /** Starts yamux over conn. lost runs when the session ends on its own (the
   * connection failed or the keepalive timed out), before closer; not when
   * it is closed with close(). */
  constructor(conn: Duplex, closer?: () => void, lost?: () => void | Promise<void>) {
    this.closer = closer;
    this.ys = new Yamux(conn, true);
    this.ys.onClose(() => void this.finish(new Error('agent session closed'), lost));
  }

  /** Ends the session once; before runs only for the call that ends it. */
  async finish(err: Error, before?: () => void | Promise<void>): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.reason = err;
    if (before) await before();
    this.ys.close();
    this.closer?.();
    for (const w of this.waiters) w();
    this.waiters = [];
  }

  /** Tears the session down. */
  close(): void {
    void this.finish(new Error('closed'));
  }

  /** Resolves when the session ends. */
  done(): Promise<void> {
    return this.ended ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }

  /** Why the session ended; null while it is open. */
  get err(): Error | null {
    return this.reason;
  }

  get closed(): boolean {
    return this.ended;
  }

  /** Opens a stream with header h and waits for the agent's reply. body is
   * written right after the header line, before the reply is read: an op's
   * data that does not fit the line (a plugin's params, params_length). The
   * reply comes within replyTimeoutMs unless timeoutMs says otherwise:
   * actions that answer only after their work (a scan, a push) give a
   * longer one. */
  async open(
    h: Header,
    opts: { signal?: AbortSignal; timeoutMs?: number; body?: Uint8Array } = {},
  ): Promise<{ conn: AgentStream; reply: Reply }> {
    const { signal } = opts;
    if (signal?.aborted) throw signal.reason;
    const st = await this.ys.open();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      st.destroy(new Error('timeout'));
    }, opts.timeoutMs ?? replyTimeoutMs);
    const onAbort = () => st.destroy(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const reader = new Reader(st);
    const failed = (e: unknown): never => {
      reader.release();
      closeStream(st);
      if (signal?.aborted) throw signal.reason;
      if (timedOut) throw new AgentError(`agent ${h.op}: no reply in time`);
      throw new AgentError(`agent ${h.op}: ${(e as Error).message}`);
    };
    try {
      if (signal?.aborted) failed(signal.reason);
      await writeLine(st, h).catch(failed);
      if (opts.body?.length) await write(st, opts.body).catch(failed);
      const rep = await readLine<Reply>(reader).catch(failed);
      if (!rep.ok) {
        reader.release();
        closeStream(st);
        throw new AgentError(`agent ${h.op}: ${rep.error ?? ''}`, rep);
      }
      if (rep.entries_length && rep.entries_length > 0) {
        // A listing too large for the line follows it (fs.list).
        if (rep.entries_length > MAX_BODY) failed(new Error(`agentproto: body of ${rep.entries_length} bytes`));
        rep.entries = (await readBody(reader, rep.entries_length).catch(failed)) as Stat[];
        rep.entries_length = 0;
      }
      return { conn: { stream: st, reader }, reply: rep };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Opens a stream, returns the reply and closes the stream. */
  async request(h: Header, opts: { signal?: AbortSignal; timeoutMs?: number; body?: Uint8Array } = {}): Promise<Reply> {
    const { conn, reply } = await this.open(h, opts);
    conn.reader.release();
    closeStream(conn.stream);
    return reply;
  }

  /** Streams the agent opens (VS Code bridge connections, vault requests,
   * a node's drain). */
  accept(): Promise<Stream> {
    return this.ys.accept();
  }
}
