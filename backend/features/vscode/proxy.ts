// /m/<machine>/code/… served from the machine's code-server, which listens
// on a unix socket of the agent's (cs.sock): each connection is a stream of
// the agent (op dial-unix), so nothing listens on a port of the machine.
// HTTP goes through Node's client over a pool of such streams per machine;
// WebSockets are relayed message by message (relay.ts).
//
// What crosses the proxy is limited (SECURITY.md): the proxy's secret and
// the desktop app's cookie stay in the core; code-server's answers may not
// widen a service worker's scope to the UI's pages, nor set the desktop
// app's cookie, and only the UI's own pages frame them. code-server's port
// proxy (/proxy/<port>/, /absproxy/<port>/) is refused: it would serve any
// program of the machine on the UI's origin.
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { Reader } from '#shared/lib/streamio.ts';
import { Op } from '#shared/proto/agentproto/index.ts';
import { breakableResponse } from '#kernel/http/breakable.ts';
import { PROXY_SECRET_HEADER } from '#kernel/http/guard.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { keepSetCookie, stripDesktopCookie } from './cookies.ts';
import type { Timing } from './timing.ts';

/** code-server's socket, below the agent's run directory. */
export const CODE_SOCKET = 'cs.sock';

/** Whether path, below /m/<machine>/code and decoded, is one of
 * code-server's port proxy routes, which Express matches without regard
 * to case. */
export function portProxyPath(path: string): boolean {
  const p = path.toLowerCase();
  return ['/proxy', '/absproxy'].some((r) => p === r || p.startsWith(`${r}/`));
}

/** The part of a request's path below /m/<machine>/code as it was sent
 * (still encoded), "/" for none; null for another path. */
export function belowCode(pathname: string): string | null {
  const m = /^\/m\/[^/]+\/code(\/.*)?$/.exec(pathname);
  return m ? (m[1] ?? '/') : null;
}

/** Opens a stream to code-server's socket on m. */
export async function dialCodeServer(m: Machine, timeoutMs: number, signal?: AbortSignal): Promise<Duplex> {
  const { conn } = await m.open({ op: Op.DialUnix, path: CODE_SOCKET }, { timeoutMs, signal });
  if (conn.reader.release() !== conn.stream) {
    // An HTTP server does not speak first.
    conn.stream.destroy();
    throw new Error('code-server sent data before the request');
  }
  return conn.stream;
}

// Headers of one connection, not passed on (RFC 9110 7.6.1).
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]);

/** The headers a Connection header names, lower case. */
const connectionTokens = (value: string | null | undefined) =>
  new Set(
    (value ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );

/** A request as the proxy passes it on. */
export interface Inbound {
  headers: Headers;
  /** The Host the browser asked for: code-server compares a WebSocket's
   * Origin with it. */
  host: string;
  /** The client's address; undefined in process (the desktop app's
   * windows), whose answers Chromium does not decode: those ask for
   * identity. */
  remote?: string;
  scheme: string;
}

/** The headers sent to code-server: the request's, without those of the
 * connection, the proxy's secret, the desktop app's cookie and the
 * client's X-Forwarded-*, which are set anew (as Go's
 * httputil.ProxyRequest.SetXForwarded). A WebSocket's own headers are the
 * relay's to make. */
export function requestHeaders(i: Inbound, o: { websocket?: boolean } = {}): Record<string, string> {
  const drop = new Set([
    ...HOP_BY_HOP,
    ...connectionTokens(i.headers.get('Connection')),
    'host',
    'cookie',
    PROXY_SECRET_HEADER.toLowerCase(),
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    ...(o.websocket ? ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'] : []),
  ]);
  const out: Record<string, string> = {};
  i.headers.forEach((v, k) => {
    if (!drop.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  });
  out.host = i.host;
  const cookie = stripDesktopCookie(i.headers.get('Cookie'));
  if (cookie) out.cookie = cookie;
  if (i.remote) out['x-forwarded-for'] = i.remote;
  out['x-forwarded-host'] = i.host;
  out['x-forwarded-proto'] = i.scheme;
  if (i.remote === undefined) out['accept-encoding'] = 'identity';
  return out;
}

/** The headers of code-server's answer as the browser gets them (raw:
 * name, value, name, value…): without those of the connection, without
 * Service-Worker-Allowed (a worker of code-server's may not claim a scope
 * above its script's path, where it would control the UI's pages and
 * outlast VS Code's switch) and the desktop app's cookie; only the UI's own
 * pages frame them. */
export function responseHeaders(raw: readonly string[]): Headers {
  let connection = '';
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === 'connection') connection += `,${raw[i + 1]}`;
  const drop = new Set([...HOP_BY_HOP, ...connectionTokens(connection), 'service-worker-allowed', 'x-frame-options']);
  const h = new Headers();
  for (let i = 0; i < raw.length; i += 2) {
    const [k, v] = [raw[i], raw[i + 1]];
    const l = k.toLowerCase();
    if (drop.has(l) || (l === 'set-cookie' && !keepSetCookie(v))) continue;
    try {
      h.append(k, v);
    } catch {
      // not a header Fetch takes
    }
  }
  h.set('X-Frame-Options', 'SAMEORIGIN');
  return h;
}

/** A stream of the agent as the HTTP client's socket: it ends both ways
 * once code-server ended its side (a socket without half-open), and has
 * the socket methods the client calls (keep-alive, timeouts are the
 * pool's). */
function asSocket(st: Duplex): Duplex {
  const self = () => st;
  Object.assign(st, { setKeepAlive: self, setNoDelay: self, ref: self, unref: self, setTimeout: self });
  st.once('end', () => st.end());
  return st;
}

/** Streams of the agent to code-server's socket, kept open between
 * requests for a while (Go's transport kept them 90 s; code-server closes
 * one unused for 5 s). */
class Pool extends http.Agent {
  private readonly dial: () => Promise<Duplex>;
  private readonly freeMs: number;
  private readonly expiry = new WeakMap<Duplex, NodeJS.Timeout>();

  constructor(dial: () => Promise<Duplex>, freeMs: number) {
    super({ keepAlive: true, maxFreeSockets: 32, scheduling: 'lifo' });
    this.dial = dial;
    this.freeMs = freeMs;
  }

  override createConnection(_o: http.ClientRequestArgs, cb?: (err: Error | null, s: Duplex) => void): undefined {
    this.dial().then(
      (s) => cb?.(null, s),
      (e: Error) => cb?.(e, undefined as unknown as Duplex),
    );
    return undefined;
  }

  override keepSocketAlive(socket: Duplex): boolean {
    if (socket.destroyed || socket.readableEnded || socket.writableEnded) return false;
    clearTimeout(this.expiry.get(socket));
    const t = setTimeout(() => socket.destroy(), this.freeMs);
    t.unref?.();
    this.expiry.set(socket, t);
    return true;
  }

  override reuseSocket(socket: Duplex, req: http.ClientRequest): void {
    clearTimeout(this.expiry.get(socket));
    this.expiry.delete(socket);
    super.reuseSocket(socket, req);
  }
}

/** A failure on a stream the pool had kept, before any answer: code-server
 * may have closed it meanwhile, so the request is sent again. */
const staleSocket = (e: unknown, req: http.ClientRequest) =>
  req.reusedSocket === true && ['ECONNRESET', 'EPIPE'].includes((e as NodeJS.ErrnoException).code ?? '');

/** The body of code-server's answer, read as the client takes it; one that
 * breaks off (the machine went away) fails the transfer. */
function bodyOf(res: http.IncomingMessage, req: http.ClientRequest): ReadableStream<Uint8Array> {
  const r = new Reader(res);
  return new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        let b: Buffer | null | undefined;
        try {
          b = await r.chunk();
        } catch {
          b = undefined;
        }
        if (b) return c.enqueue(b);
        if (b === null && res.complete) return c.close();
        req.destroy();
        try {
          c.error();
        } catch {
          // closed already
        }
      },
      cancel() {
        req.destroy();
      },
    },
    { highWaterMark: 0 },
  );
}

/** A machine's code-server as the proxy reaches it. */
export class CodeServerProxy {
  private readonly pool: Pool;
  private readonly timing: Timing;

  constructor(m: Machine, timing: Timing) {
    this.timing = timing;
    this.dial = async (signal) => asSocket(await dialCodeServer(m, timing.dialMs, signal));
    this.pool = new Pool(() => this.dial(), timing.freeSocketMs);
  }

  /** A stream to code-server's socket, as a socket of Node's HTTP client. */
  readonly dial: (signal?: AbortSignal) => Promise<Duplex>;

  /** Passes a request on and answers with code-server's answer; signal
   * ends it, also while its body is sent. Fails when code-server cannot be
   * reached or does not answer in time. */
  async request(
    i: Inbound & { method: string; path: string; body: ReadableStream<Uint8Array> | null },
    signal: AbortSignal,
  ): Promise<Response> {
    const headers = requestHeaders(i);
    for (let attempt = 0; ; attempt++) {
      const req = http.request({ agent: this.pool, host: 'code-server', method: i.method, path: i.path, headers });
      try {
        const res = await this.send(req, i.body, signal);
        const status = res.statusCode ?? 502;
        const empty = i.method === 'HEAD' || status === 204 || status === 304 || status < 200;
        if (empty) res.resume();
        return empty
          ? new Response(null, { status, headers: responseHeaders(res.rawHeaders) })
          : breakableResponse(bodyOf(res, req), { status, headers: responseHeaders(res.rawHeaders) });
      } catch (e) {
        if (!signal.aborted && i.body === null && attempt < 3 && staleSocket(e, req)) continue;
        throw e;
      }
    }
  }

  private send(req: http.ClientRequest, body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const abort = () => req.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => req.destroy(new Error('code-server did not answer in time')), this.timing.responseHeadMs);
      req.once('response', (res) => {
        clearTimeout(timer);
        res.once('close', () => signal.removeEventListener('abort', abort));
        resolve(res);
      });
      req.once('error', (e) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(e);
      });
      if (!body) return void req.end();
      const src = Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
      src.once('error', (e) => req.destroy(e));
      src.pipe(req);
    });
  }

  /** Closes the kept streams. */
  close(): void {
    this.pool.destroy();
  }
}
