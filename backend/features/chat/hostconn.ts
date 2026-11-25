// Connections to a machine's chat host: each a stream the machine side's
// open action gives (protocol.ts), on which the host's Hello comes first,
// then one request and its answer, and for an attach or a watch what
// follows. The hub keeps at most Limits.maxHostConns of them open to one
// machine's host, the last reservedConns only for the watch and the
// configures, so that pages cannot take the watch's place.
import { z } from 'zod';
import { write } from '#shared/lib/streamio.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { broken, chatError, protocolError } from './errors.ts';
import { chatState } from './wire.ts';

/** Opens a stream to machine m's chat host through its agent: the stream
 * after the machine's reply, the host's Hello first. Without start, only
 * to a host that serves already (else not_running). The stream is
 * destroyed when signal ends. Fails with the machine's code (a Fail). */
export type Opener = (machine: string, start: boolean, signal: AbortSignal) => Promise<AgentStream>;

const hello = z.object({
  host: z.object({ proto: z.number().nullish(), version: z.string().nullish(), pid: z.number().nullish() }).nullish(),
});

const chatErr = z.object({ code: z.string(), message: z.string().nullish(), stderr: z.string().nullish() });

/** What a ChatError of the host is, as the hub passes it on. */
export function readError(v: unknown): chat.ChatError | undefined {
  const r = chatErr.safeParse(v);
  if (!r.success) return undefined;
  return { code: r.data.code, message: r.data.message ?? '', ...(r.data.stderr ? { stderr: r.data.stderr } : {}) };
}

const object = z.record(z.string(), z.unknown());

/** The host's answer as the hub reads it: what it checks has its type;
 * what it passes on as it is (chats, sessions, the trusted folders, the
 * host's status) is only an object or a list. */
const response = z.object({
  ok: z.boolean().nullish(),
  error: chatErr.nullish(),
  agents: z
    .array(z.object({ kind: z.string(), available: z.boolean().nullish(), version: z.string().nullish(), reason: z.string().nullish() }))
    .nullish(),
  chats: z.array(object).nullish(),
  chat: object.nullish(),
  first: z.number().nullish(),
  sessions: z.array(object).nullish(),
  nextCursor: z.string().nullish(),
  states: z.array(chatState).nullish(),
  trusted: z.array(object).nullish(),
  hostStatus: object.nullish(),
});
export type Response = z.output<typeof response>;

/** Names the process of a chat host by its hello: another process (a host
 * started again, another build's) has another. */
export const hostID = (info: chat.HostInfo): string => `${info.version}/${info.pid}`;

/** Writes text to a stream within ms; a write that does not go through by
 * then destroys the stream. */
async function writeWithin(conn: AgentStream, text: string, ms: number): Promise<void> {
  const timer = setTimeout(() => conn.stream.destroy(new Error('write timed out')), ms);
  try {
    await write(conn.stream, text);
  } finally {
    clearTimeout(timer);
  }
}

/** A connection to a machine's chat host after its Hello. */
export class HostConn {
  /** What the host's Hello said. */
  info: chat.HostInfo = { proto: 0, version: '', pid: 0 };
  private readonly conn: AgentStream;
  private readonly signal: AbortSignal;
  private readonly writeMs: number;
  private readonly release: () => void;

  constructor(conn: AgentStream, o: { signal: AbortSignal; writeMs: number; release: () => void }) {
    this.conn = conn;
    this.signal = o.signal;
    this.writeMs = o.writeMs;
    this.release = o.release;
    conn.stream.once('close', o.release);
  }

  /** Reads the host's Hello within ms; the connection is closed when it is
   * none, or of another version of the protocol. */
  async hello(ms: number): Promise<void> {
    const timer = setTimeout(() => this.conn.stream.destroy(new Error('no hello in time')), ms);
    let line: Buffer;
    try {
      line = await this.readLine();
    } catch (e) {
      this.close();
      throw this.broken(e);
    } finally {
      clearTimeout(timer);
    }
    let h: z.output<typeof hello>;
    try {
      const r = hello.safeParse(JSON.parse(line.toString('utf8')));
      if (!r.success) throw r.error;
      h = r.data;
    } catch {
      this.close();
      throw protocolError("the chat host's first line is no hello");
    }
    if ((h.host?.proto ?? 0) !== chat.PROTO) {
      this.close();
      throw protocolError('the chat host speaks another version of the protocol');
    }
    this.info = { proto: chat.PROTO, version: h.host?.version ?? '', pid: h.host?.pid ?? 0 };
  }

  get id(): string {
    return hostID(this.info);
  }

  /** The next line of the host; it throws at the end of the stream (and a
   * line over MAX_LINE). */
  readLine(): Promise<Buffer> {
    return chat.readLine(this.conn.reader);
  }

  /** Writes a line (with its newline) within the time limit. */
  write(line: string): Promise<void> {
    return writeWithin(this.conn, line, this.writeMs);
  }

  /** The error of the connection that broke with e. */
  broken(e: unknown): unknown {
    return broken(this.signal, e);
  }

  /** Writes req and reads the host's answer: its error when it refused. */
  send(req: chat.Request): Promise<Response> {
    return this.sendLine(chat.line(req));
  }

  /** send with the request's line as it is. */
  async sendLine(text: string): Promise<Response> {
    if (Buffer.byteLength(text) > chat.MAX_LINE + 1) throw chatError(chat.Code.TooLarge, 'a line longer than the protocol takes');
    let raw: Buffer;
    try {
      await this.write(text);
      raw = await this.readLine();
    } catch (e) {
      throw this.broken(e);
    }
    let res: Response;
    try {
      const r = response.safeParse(JSON.parse(raw.toString('utf8')));
      if (!r.success) throw r.error;
      res = r.data;
    } catch {
      throw protocolError("the chat host's answer is not of the protocol");
    }
    if (res.error) throw new chat.ChatProtoError(readError(res.error)!);
    if (!res.ok) throw protocolError("the chat host's answer is neither OK nor an error");
    return res;
  }

  /** Breaks the connection (a reset), as a time limit does. */
  destroy(): void {
    this.conn.stream.destroy();
  }

  /** Ends the connection and gives its slot back. */
  close(): void {
    this.release();
    const rest = this.conn.reader.release();
    if (rest !== this.conn.stream) rest.resume();
    closeStream(this.conn.stream);
  }
}

export interface HostLinkOptions {
  open: Opener;
  helloMs: number;
  writeMs: number;
  maxHostConns: number;
  reservedConns: number;
}

/** The connections of the hub to the machines' chat hosts. */
export class HostLink {
  private readonly o: HostLinkOptions;
  /** By machine: every connection open, and those that are not the watch's
   * or a configure's. */
  private readonly conns = new Map<string, { all: number; open: number }>();

  constructor(o: HostLinkOptions) {
    this.o = o;
  }

  /** How many connections are open to machine m's host (tests). */
  count(m: string): { all: number; open: number } {
    return { ...(this.conns.get(m) ?? { all: 0, open: 0 }) };
  }

  /** Takes a slot of machine m's connections: of the first
   * maxHostConns-reservedConns that every connection may take, or
   * (reserved) of all of them; the function gives it back, once. */
  private acquire(m: string, reserved: boolean): () => void {
    const n = this.conns.get(m) ?? { all: 0, open: 0 };
    if (n.all >= this.o.maxHostConns || (!reserved && n.open >= this.o.maxHostConns - this.o.reservedConns))
      throw chatError(chat.Code.TooMany, "too many connections to the machine's chat host");
    n.all++;
    if (!reserved) n.open++;
    this.conns.set(m, n);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const c = this.conns.get(m)!;
      c.all--;
      if (!reserved) c.open--;
      if (c.all <= 0) this.conns.delete(m);
    };
  }

  /** Connects to machine m's chat host (with start, one the machine starts
   * when none serves) and reads its Hello; the connection is destroyed when
   * signal ends. It takes one of the machine's slots (reserved: the
   * watch's and the configures'), refused with too_many when none is left. */
  async dial(m: string, o: { start: boolean; reserved: boolean; signal: AbortSignal }): Promise<HostConn> {
    const release = this.acquire(m, o.reserved);
    let conn: AgentStream;
    try {
      conn = await this.o.open(m, o.start, o.signal);
    } catch (e) {
      release();
      throw e;
    }
    const c = new HostConn(conn, { signal: o.signal, writeMs: this.o.writeMs, release });
    await c.hello(this.o.helloMs);
    return c;
  }
}
