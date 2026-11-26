// The Agent Client Protocol (protocol version 1) to an agent the host
// started, on @agentclientprotocol/sdk: JSON-RPC 2.0 messages, one per line,
// on the agent's standard input and output (ndJsonStream: lines of at most
// MAX_MESSAGE bytes, a longer one ends the connection), the calls of the
// client and their answers (the SDK's client app: ids, the pending calls,
// error objects), and the agent's requests (served by Handler.request, every
// method but session/request_permission answered "method not found").
//
// Notifications never reach the SDK: its client app parses every
// session/update with the protocol's stable schema (dropping one it does
// not take, an agent's newer kind or value) and dispatches incoming messages
// through asynchronous handlers, whose order against the answers that
// follow is not kept. Here each notification is handed to the Handler as
// the agent sent it, synchronously, in the order of the agent's output,
// before any message after it reaches the SDK: a call's answer is seen only
// after the notifications that came before it (a turn's updates before the
// answer that ends it). A vendor's own notifications ("_…") are counted and
// passed over, and answers to calls this client did not make are dropped.
import { RequestError, client, ndJsonStream, type AnyMessage } from '@agentclientprotocol/sdk';
import type { Logger } from '#shared/lib/log.ts';
import { isObj, type Obj } from './state.ts';

/** The protocol's version this client speaks. */
export const PROTOCOL_VERSION = 1;
/** The longest line taken from an agent, in bytes. */
export const MAX_MESSAGE = 16 << 20;

/** The JSON-RPC error codes the adapter reads or sends. */
export const RpcCode = {
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** The protocol's error of a request that needs the user to sign in first. */
  AuthRequired: -32000,
  /** The protocol's error for what is not there: a session that
   * session/load or session/resume names. */
  ResourceNotFound: -32002,
} as const;

export { RequestError };

/** A call on a connection that ended, whatever ended it. */
export class ClosedError extends Error {
  constructor() {
    super('acp: connection closed');
    this.name = 'ClosedError';
  }
}

/** A call the agent did not answer in time. */
export class TimeoutError extends Error {
  constructor(method: string) {
    super(`acp: ${method}: no answer in time`);
    this.name = 'TimeoutError';
  }
}

/** A call given up because its signal ended. */
export class AbortedError extends Error {
  constructor() {
    super('acp: the call was given up');
    this.name = 'AbortedError';
  }
}

/** What an agent sends without being asked. */
export interface Handler {
  /** Every notification but a vendor's, in the order received, before any
   * message after it is read on: it must not wait. */
  notification(method: string, params: unknown): void;
  /** A request of the agent: resolves with the result, or rejects with a
   * RequestError to answer (RequestError.methodNotFound for a method not
   * served). Any other rejection is answered as an internal error without
   * its text, which may name paths of the machine. signal ends with the
   * connection or the agent's $/cancel_request. */
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
}

/** The pipes of the agent's process. */
export interface Pipes {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
}

/** A JSON-RPC id as a key. */
const idKey = (id: unknown): string => JSON.stringify(id) ?? '';

/** A connection to an agent: calls and notifications to it, its
 * notifications and requests to a Handler. It does not own the agent's
 * process: whoever started the agent ends it. */
export class Conn {
  /** The vendor notifications passed over. */
  vendor = 0;
  /** Settles once the connection ended: the agent's output ended, a write
   * failed, a line was too long, or close(). */
  readonly closed: Promise<void>;
  private readonly conn: ReturnType<ReturnType<typeof client>['connect']>;
  /** The ids of the calls written and not answered. */
  private readonly sent = new Set<string>();
  private readonly logger: Logger;
  private loggedStray = false;

  constructor(pipes: Pipes, h: Handler, o: { name: string; logger: Logger }) {
    this.logger = o.logger;
    const lines = ndJsonStream(pipes.stdin, pipes.stdout, { maxMessageBytes: MAX_MESSAGE });
    const inbound = new TransformStream<AnyMessage, AnyMessage>({
      transform: (m, out) => {
        const msg = m as Obj;
        if (typeof msg.method === 'string' && !('id' in msg)) {
          if (msg.method.startsWith('_')) {
            this.vendor++;
            return;
          }
          try {
            h.notification(msg.method, msg.params);
          } catch (e) {
            this.logger(`acp: a notification ${msg.method}: ${(e as Error).message}`);
          }
          return;
        }
        if (!('method' in msg) && 'id' in msg) {
          // An answer: only to a call of this client's.
          if (!this.sent.delete(idKey(msg.id))) {
            if (!this.loggedStray) this.logger('acp: passed over an answer to a call this client did not make');
            this.loggedStray = true;
            return;
          }
        }
        out.enqueue(m);
      },
    });
    const writer = lines.writable.getWriter();
    const outbound = new WritableStream<AnyMessage>({
      write: (m) => {
        const msg = m as Obj;
        if (typeof msg.method === 'string' && 'id' in msg) this.sent.add(idKey(msg.id));
        return writer.write(m);
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    });
    const app = client({ name: o.name }).onRequest('*', async (ctx) => {
      try {
        return await h.request(ctx.method, ctx.params, ctx.signal);
      } catch (e) {
        if (e instanceof RequestError) throw e;
        throw new RequestError(RpcCode.InternalError, 'Internal error');
      }
    });
    this.conn = app.connect({ readable: lines.readable.pipeThrough(inbound), writable: outbound });
    this.closed = this.conn.closed;
  }

  /** Whether the connection ended. */
  get ended(): boolean {
    return this.conn.signal.aborted;
  }

  /** Calls method with params and resolves with the agent's result, as it
   * sent it. Rejects with a RequestError for the agent's error, ClosedError
   * when the connection ends first, TimeoutError after ms (when given),
   * AbortedError when signal ends. The call is written before call returns,
   * so a notification sent after it goes after it. */
  call(method: string, params: unknown, o: { ms?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.ended) return Promise.reject(new ClosedError());
    if (o.signal?.aborted) return Promise.reject(new AbortedError());
    const answer = this.conn.agent.request<unknown, unknown>(method, params);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', aborted);
      };
      const aborted = () => {
        done();
        reject(new AbortedError());
      };
      if (o.ms !== undefined) {
        timer = setTimeout(() => {
          done();
          reject(new TimeoutError(method));
        }, o.ms);
      }
      o.signal?.addEventListener('abort', aborted, { once: true });
      answer.then(
        (r) => {
          done();
          resolve(r);
        },
        (e) => {
          done();
          reject(e instanceof RequestError ? e : new ClosedError());
        },
      );
    });
  }

  /** Sends a notification. */
  notify(method: string, params: unknown): Promise<void> {
    if (this.ended) return Promise.reject(new ClosedError());
    return this.conn.agent.notify(method, params).catch(() => {
      throw new ClosedError();
    });
  }

  /** Ends the connection: the calls that wait fail with ClosedError. */
  close(): void {
    this.conn.close();
  }
}

/** The result of initialize, as far as a host reads it. */
export interface InitializeResult {
  protocolVersion: number;
  capabilities: AgentCapabilities;
  /** agentInfo's version, else _meta.agentVersion; "" for none. */
  version: string;
}

/** An agent's capabilities, as far as a host decides by them. A capability
 * left out is one the agent does not have. */
export interface AgentCapabilities {
  loadSession: boolean;
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
  /** session/list and session/resume (sessionCapabilities: any value but
   * null and false). */
  list: boolean;
  resume: boolean;
}

/** The agent spoke another protocol version: the one it named. */
export class ProtocolVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`acp: the agent speaks version ${version} of the protocol`);
    this.version = version;
    this.name = 'ProtocolVersionError';
  }
}

const flag = (v: unknown): boolean => v === true;
const supported = (v: unknown): boolean => v !== undefined && v !== null && v !== false;

/** Opens the protocol: version 1, neither the fs nor the terminal
 * capability (no method they would promise is served), clientInfo. Rejects
 * with ProtocolVersionError for an agent of another version. */
export async function initialize(
  c: Conn,
  clientInfo: { name: string; version: string },
  ms: number,
  signal?: AbortSignal,
): Promise<InitializeResult> {
  const r = await c.call(
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo,
    },
    { ms, signal },
  );
  if (!isObj(r) || typeof r.protocolVersion !== 'number') throw new Error('acp: initialize: no protocol version');
  if (r.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolVersionError(r.protocolVersion);
  const caps = isObj(r.agentCapabilities) ? r.agentCapabilities : {};
  const prompt = isObj(caps.promptCapabilities) ? caps.promptCapabilities : {};
  const session = isObj(caps.sessionCapabilities) ? caps.sessionCapabilities : {};
  let version = isObj(r.agentInfo) && typeof r.agentInfo.version === 'string' ? r.agentInfo.version : '';
  if (version === '' && isObj(r._meta) && typeof r._meta.agentVersion === 'string') version = r._meta.agentVersion;
  return {
    protocolVersion: r.protocolVersion,
    capabilities: {
      loadSession: flag(caps.loadSession),
      image: flag(prompt.image),
      audio: flag(prompt.audio),
      embeddedContext: flag(prompt.embeddedContext),
      list: supported(session.list),
      resume: supported(session.resume),
    },
    version,
  };
}

/** The answer to a permission whose turn was cancelled (or that nobody may
 * answer): a client owes it to every request that still waits when it
 * cancels. */
export const permissionCancelled = () => ({ outcome: { outcome: 'cancelled' } });

/** The answer of a user who chose an option. */
export const permissionSelected = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } });
