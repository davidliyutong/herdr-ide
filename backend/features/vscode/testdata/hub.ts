// VS Code's feature in a hub whose machines' agents serve code-server's
// actions as the Go agent does (op code-server: status, install,
// install-ext, marker, download, start, stop, release) and dial-unix to a
// fake code-server: Bun.serve on a unix socket, with HTTP routes and a
// WebSocket that echoes. Settings are real, so that the switches can be
// turned and followed.
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { discard } from '#shared/lib/log.ts';
import { ChunkReader, Op, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { channelPair, type Channel, type Message } from '#kernel/channel.ts';
import { hubModules } from '#kernel/config/registry.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { createHub, type Hub } from '#kernel/hub.ts';
import { Guard } from '#kernel/http/guard.ts';
import type { Peer } from '#kernel/http/env.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import type { Machines } from '#kernel/machines/manager.ts';
import { agentDialer, localSpec, memoryAudit, running, testMachines, waitFor, type FakeAgent } from '#kernel/testing.ts';
import type { Spec } from '#kernel/machines/spec.ts';
import { vscodeFeatures, type VSCodeOptions } from '../hub.ts';

/** The fake code-server: what it was asked, and its WebSockets. */
export interface FakeCodeServer {
  path: string;
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: string }>;
  sockets: Set<ServerWebSocket<unknown>>;
  /** Connections it accepted. */
  connections: number;
  stop(): void;
}

/** A code-server on a unix socket: GET /echo answers what it got, /cookie
 * sets cookies, /big streams n bytes, /hold answers when the request goes
 * away, anything else 200 "ok"; WebSockets echo, "close" makes it close
 * with 4001. */
export function fakeCodeServer(dir: string): FakeCodeServer {
  const path = join(dir, 'cs.sock');
  const cs: FakeCodeServer = { path, requests: [], sockets: new Set(), connections: 0, stop: () => {} };
  const server: Server<unknown> = Bun.serve({
    unix: path,
    async fetch(req, srv) {
      const u = new URL(req.url);
      const headers = Object.fromEntries(req.headers);
      const body = await req.text();
      cs.requests.push({ method: req.method, path: u.pathname + u.search, headers, body });
      if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        if (u.pathname === '/refuse') return new Response('no', { status: 403 });
        return srv.upgrade(req, { data: {} }) ? undefined : new Response('upgrade failed', { status: 400 });
      }
      switch (u.pathname) {
        case '/echo':
          return Response.json({ method: req.method, path: u.pathname + u.search, headers, body });
        case '/cookie': {
          const h = new Headers({ 'Service-Worker-Allowed': '/', 'X-Frame-Options': 'DENY' });
          h.append('Set-Cookie', 'vscode-tkn=1; Path=/');
          h.append('Set-Cookie', 'veldr-desktop=planted; Path=/; HttpOnly');
          h.append('Set-Cookie', 'veldr-desktop-x=kept');
          return new Response('cookies', { headers: h });
        }
        case '/big':
          return new Response(Buffer.alloc(Number(u.searchParams.get('n') ?? '0'), 'x'));
        case '/nothing':
          return new Response(null, { status: 304 });
        case '/hold':
          // Answers once the request goes away, or after 10 s.
          await new Promise((r) => {
            req.signal.addEventListener('abort', r, { once: true });
            setTimeout(r, 10_000);
          });
          return new Response('held');
      }
      return new Response('ok');
    },
    websocket: {
      open(ws) {
        cs.sockets.add(ws);
      },
      message(ws, m) {
        if (m === 'close') return ws.close(4001, 'asked');
        ws.send(m);
      },
      close(ws) {
        cs.sockets.delete(ws);
      },
    },
  });
  cs.stop = () => void server.stop(true);
  return cs;
}

/** What the fake agent's code-server actions do. */
export interface AgentState {
  /** The release is in the agent's directory. */
  installed: boolean;
  /** The machine's own code-server (install mode existing). */
  existing: boolean;
  /** Marker files. */
  markers: Set<string>;
  /** The bytes of each upload (install: the release; install-ext: path). */
  uploads: Map<string, Buffer>;
  /** The digest a machine's download reports. */
  downloadDigest: string;
  /** Fails the machine's download. */
  downloadFails: boolean;
  /** The code-server headers, in order. */
  headers: Header[];
  /** code-server's socket path for dial-unix; "" refuses. */
  socket: string;
  /** Holds the answer to start until it resolves. */
  hold?: Promise<void>;
}

export const agentState = (socket = ''): AgentState => ({
  installed: false,
  existing: false,
  markers: new Set(),
  uploads: new Map(),
  downloadDigest: '',
  downloadFails: false,
  headers: [],
  socket,
});

async function readChunks(conn: AgentStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of new ChunkReader(conn.reader)) parts.push(b);
  return Buffer.concat(parts);
}

/** Serves the agent's op code-server and dial-unix as the Go agent does. */
export function codeServerAgent(st: AgentState) {
  return async (h: Header, conn: AgentStream): Promise<void> => {
    const reply = (r: Reply) => writeLine(conn.stream, r);
    const done = () => {
      conn.reader.release();
      closeStream(conn.stream);
    };
    if (h.op === Op.DialUnix) {
      if (!st.socket || h.path !== 'cs.sock') {
        await reply({ ok: false, error: 'no socket' });
        return done();
      }
      const sock = connect(st.socket);
      sock.once('error', async () => {
        await reply({ ok: false, error: 'socket cs.sock: connection refused' }).catch(() => {});
        done();
      });
      sock.once('connect', async () => {
        sock.removeAllListeners('error');
        await reply({ ok: true });
        const rest = conn.reader.release();
        // Either side's end ends both, as the agent's pipe does.
        const closeBoth = () => {
          sock.destroy();
          closeStream(conn.stream);
        };
        sock.on('error', closeBoth).on('close', closeBoth);
        conn.stream.on('error', closeBoth).on('close', () => sock.destroy());
        rest.on('end', closeBoth);
        rest.pipe(sock);
        sock.pipe(conn.stream, { end: false });
      });
      return;
    }
    if (h.op !== Op.CodeServer) {
      await reply({ ok: false, error: 'unsupported' });
      return done();
    }
    st.headers.push(h);
    const cs = () => ({ installed: h.bin ? st.existing : st.installed, running: false, version: h.version });
    switch (h.action) {
      case 'status':
        await reply({ ok: true, cs: { ...cs(), ...(h.bin && !st.existing ? { error: 'no code-server on PATH' } : {}) } });
        break;
      case 'install':
      case 'install-ext': {
        await reply({ ok: true });
        const body = await readChunks(conn);
        st.uploads.set(h.action === 'install' ? 'install' : (h.path ?? ''), body);
        if (h.action === 'install') st.installed = true;
        await reply({ ok: true, cs: cs() });
        break;
      }
      case 'marker':
        if (h.args?.[0] === 'set') st.markers.add(h.path ?? '');
        await reply({ ok: st.markers.has(h.path ?? '') });
        break;
      case 'download':
        if (st.downloadFails) await reply({ ok: false, error: 'curl: (6) Could not resolve host' });
        else {
          st.installed = true;
          await reply({ ok: true, cs: { ...cs(), digest: st.downloadDigest } });
        }
        break;
      case 'start':
        await st.hold;
        await reply({ ok: true, cs: cs() }).catch(() => {});
        break;
      case 'stop':
      case 'release':
        await reply({ ok: true, cs: cs() });
        break;
      default:
        await reply({ ok: false, error: `code-server: unknown action "${h.action}"` });
    }
    done();
  };
}

export interface VSCodeHubOptions extends VSCodeOptions {
  readOnly?: boolean;
  specs?: Spec[];
  /** The switches: plugins.vscode.enabled (desktop) and .browser. */
  desktopOn?: boolean;
  browserOn?: boolean;
  agent?: AgentState;
}

export interface VSCodeHub {
  hub: Hub;
  settings: Settings;
  machines: Machines;
  audit: ReturnType<typeof memoryAudit>;
  agent: AgentState;
  agents: FakeAgent[];
  cs: FakeCodeServer;
  dir: string;
  request(
    method: string,
    path: string,
    o?: {
      body?: string;
      headers?: Record<string, string>;
      desktop?: boolean;
      remote?: string;
      upgrade?: Peer['upgrade'];
      signal?: AbortSignal;
    },
  ): Promise<Response>;
  /** Opens a WebSocket of the proxy; messages arrive on got. */
  websocket(
    path: string,
    o?: { desktop?: boolean; headers?: Record<string, string> },
  ): Promise<{ res: Response; ch?: Channel; got: Message[]; closed: () => { code: number; reason: string } | null }>;
  stop(): Promise<void>;
}

export async function vscodeHub(o: VSCodeHubOptions = {}): Promise<VSCodeHub> {
  const dir = mkdtempSync(join(tmpdir(), 'vsc-'));
  const cs = fakeCodeServer(dir);
  const agent = o.agent ?? { ...agentState(cs.path), installed: true };
  const dial = agentDialer({ serve: codeServerAgent(agent) });
  const machines = testMachines(o.specs ?? [localSpec()], { dial });
  // Tests never reach the network.
  const noNetwork = (() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch;
  const features = vscodeFeatures({ cacheDir: join(dir, 'cache'), extensions: [], fetch: noNetwork, ...o });
  const settings = new Settings('', { modules: hubModules(features) });
  settings.set('plugins.vscode.enabled', '', o.desktopOn ?? true);
  settings.set('plugins.vscode.browser', '', o.browserOn ?? true);
  const audit = memoryAudit();
  const hub = createHub({
    guard: new Guard(),
    audit: audit.audit,
    readOnly: o.readOnly ?? false,
    logger: discard,
    machines,
    settings,
    features,
  });
  const stopHub = running(hub);
  for (const m of machines.list()) if (m.state().enabled) await waitFor(`${m.id} ready`, () => m.ready);
  const request: VSCodeHub['request'] = (method, path, r = {}) => {
    const headers = new Headers(r.headers);
    headers.set('Host', '127.0.0.1:7780');
    const req = new Request(`http://127.0.0.1:7780${path}`, { method, headers, body: r.body, signal: r.signal });
    return hub.fetch(req, { remote: r.remote ?? '127.0.0.1', desktop: r.desktop ?? false, upgrade: r.upgrade });
  };
  return {
    hub: hub,
    settings,
    machines,
    audit,
    agent,
    agents: dial.agents,
    cs,
    dir,
    request,
    async websocket(path, w = {}) {
      const { a, b } = channelPair();
      let adopted = false;
      const res = await request('GET', path, {
        desktop: w.desktop,
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          ...w.headers,
        },
        upgrade: (open) => {
          adopted = true;
          b.adopt(open);
          return new Response(null);
        },
      });
      const got: Message[] = [];
      let closed: { code: number; reason: string } | null = null;
      let ch: Channel | undefined;
      if (adopted)
        a.adopt((c) => {
          ch = c;
          return {
            message: (d) => void got.push(d),
            close: (code, reason) => void (closed = { code, reason }),
          };
        });
      return { res, ch, got, closed: () => closed };
    },
    async stop() {
      await stopHub();
      cs.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
