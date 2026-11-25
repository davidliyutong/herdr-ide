// Helpers of the kernel's and the features' tests, never used by the
// product: an agent in memory (a yamux session over a duplex pair that
// answers hello), settings that hold what a test gives them, the audit
// records, a core over machines that do not connect, and the walk over a
// core's routes that checks the guards of those that change state.
import { duplexPair } from 'node:stream';
import { discard, type Logger } from '#shared/lib/log.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { Op, readLine, writeLine, type Header, type Info, type Reply } from '#shared/proto/agentproto/index.ts';
import { Session as Yamux, type Stream } from '#shared/proto/yamux.ts';
import { auditLog } from './audit.ts';
import type { Store as Settings } from './config/settings/index.ts';
import { createHub, type Hub } from './hub.ts';
import type { FeatureDef } from './feature.ts';
import type { Peer } from './http/env.ts';
import { Guard, type GuardOptions } from './http/guard.ts';
import type { Dialer } from './machines/machine.ts';
import { Machines } from './machines/manager.ts';
import { Registry } from './machines/registry.ts';
import { LOCAL_ID, type Spec } from './machines/spec.ts';
import { closeStream, Session, type AgentStream } from './machines/transport/session.ts';

/** Polls until ok() holds; fails after timeoutMs. */
export async function waitFor(what: string, ok: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Settings whose booleans are the members of values (false when absent);
 * a test changes values to switch features. Only bool is served. */
export function fakeSettings(values: Record<string, boolean> = {}): Settings {
  return {
    bool: (key: string) => values[key] ?? false,
  } as unknown as Settings;
}

/** An audit log in memory: its records parsed, and their lines. */
export function memoryAudit() {
  const lines: string[] = [];
  const audit = auditLog((l) => void lines.push(l));
  return {
    audit,
    lines,
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    text: () => lines.join(''),
  };
}

export const TEST_INFO: Info = {
  version: 'test',
  os: 'linux',
  arch: 'amd64',
  hostname: 'box',
  home: '/home/u',
  user: 'u',
  data_dir: '/home/u/.local/share/x',
  run_dir: '/run/user/1000/x',
  upload_dir: '/home/u/Uploads',
};

export interface FakeAgentOptions {
  info?: Info;
  /** The ssh session the agent reports in its hello. */
  ssh?: string;
  /** Serves a stream the core opened, after its header; hello is answered
   * by the agent itself. Without it every other op is refused. */
  serve?: (h: Header, conn: AgentStream) => void | Promise<void>;
}

export interface FakeAgent {
  /** The core's side: what a dial returns. */
  readonly session: Session;
  /** The headers of the streams the core opened, in order. */
  readonly headers: Header[];
  /** Opens a stream towards the core and writes its header, if any. */
  open(h?: Header): Promise<AgentStream>;
  /** Breaks the connection, as a lost one does. */
  kill(): void;
}

/** An agent in memory with a core session to it. */
export function fakeAgent(o: FakeAgentOptions = {}): FakeAgent {
  const [a, b] = duplexPair();
  const session = new Session(a);
  const ys = new Yamux(b, false);
  const headers: Header[] = [];
  const serve = async (st: Stream) => {
    const reader = new Reader(st);
    let h: Header;
    try {
      h = await readLine<Header>(reader);
    } catch {
      closeStream(st);
      return;
    }
    headers.push(h);
    if (h.op === Op.Hello) {
      await writeLine(st, { ok: true, info: o.info ?? TEST_INFO, ...(o.ssh ? { ssh: o.ssh } : {}) } satisfies Reply).catch(() => {});
    } else if (o.serve) {
      try {
        await o.serve(h, { stream: st, reader });
      } catch {
        closeStream(st);
      }
      return;
    } else {
      await writeLine(st, { ok: false, error: 'unsupported' } satisfies Reply).catch(() => {});
    }
    reader.release();
    closeStream(st);
  };
  void (async () => {
    for (;;) {
      const st = await ys.accept().catch(() => null);
      if (!st) return;
      void serve(st);
    }
  })();
  return {
    session,
    headers,
    async open(h) {
      const stream = await ys.open();
      if (h) await writeLine(stream, h);
      return { stream, reader: new Reader(stream) };
    },
    kill: () => b.destroy(),
  };
}

/** A Dialer whose every dial reaches a new fake agent (platform
 * "test/test"); agents lists them, one per dial. */
export function agentDialer(o: FakeAgentOptions = {}): Dialer & { agents: FakeAgent[] } {
  const agents: FakeAgent[] = [];
  const dial: Dialer = async () => {
    const agent = fakeAgent(o);
    agents.push(agent);
    return { session: agent.session, platform: 'test/test' };
  };
  return Object.assign(dial, { agents });
}

/** A Dialer that fails at once; machines it serves never connect. */
export const noDial: Dialer = async () => {
  throw new Error('no dial in this test');
};

/** Runs something with a run(signal) until the returned stop is awaited. */
export function running(r: { run(signal: AbortSignal): Promise<void> }): () => Promise<void> {
  const ac = new AbortController();
  const done = r.run(ac.signal);
  return async () => {
    ac.abort();
    await done;
  };
}

export const sshSpec = (id: string, target = id, label = id, enabled = true): Spec => ({ id, label, kind: 'ssh', target, enabled });
export const localSpec = (label = 'local', enabled = true): Spec => ({ id: LOCAL_ID, label, kind: 'local', enabled });

/** Machines over specs and a registry (in memory by default). */
export function testMachines(
  specs: readonly Spec[],
  o: { registry?: Registry; dial?: Dialer; logger?: Logger; localSupported?: boolean } = {},
): Machines {
  return new Machines({
    specs,
    registry: o.registry ?? Registry.memory(),
    dial: o.dial ?? noDial,
    logger: o.logger ?? discard,
    localSupported: o.localSupported ?? true,
    timing: { backoffMinMs: 20, backoffMaxMs: 100, sessionRetryMs: 20, authRetryMs: 100, helloTimeoutMs: 2000 },
    removeWaitMs: 2000,
  });
}

export interface TestHubOptions {
  features: readonly FeatureDef[];
  machines?: Machines;
  readOnly?: boolean;
  guard?: GuardOptions;
  /** The booleans of the settings (fakeSettings). */
  settings?: Record<string, boolean>;
}

export interface RequestOptions {
  body?: string;
  origin?: string;
  /** The Host header (127.0.0.1:7780). */
  host?: string;
  /** The peer's address (127.0.0.1). */
  remote?: string;
  desktop?: boolean;
  headers?: Record<string, string>;
  upgrade?: Peer['upgrade'];
}

export interface TestHub {
  readonly hub: Hub;
  readonly settings: Record<string, boolean>;
  readonly audit: ReturnType<typeof memoryAudit>;
  /** Sends a request as a browser on the core's host would. */
  request(method: string, path: string, o?: RequestOptions): Promise<Response>;
}

/** A core of features over machines that do not connect (the local
 * machine only by default). */
export function testHub(o: TestHubOptions): TestHub {
  const audit = memoryAudit();
  const settings = o.settings ?? {};
  const core = createHub({
    guard: new Guard(o.guard),
    audit: audit.audit,
    readOnly: o.readOnly ?? false,
    logger: discard,
    machines: o.machines ?? testMachines([localSpec()]),
    settings: fakeSettings(settings),
    features: o.features,
  });
  return {
    hub: core,
    settings,
    audit,
    request(method, path, r = {}) {
      const host = r.host ?? '127.0.0.1:7780';
      const headers = new Headers(r.headers);
      headers.set('Host', host);
      if (r.origin) headers.set('Origin', r.origin);
      const req = new Request(`http://${host}${path}`, { method, headers, body: r.body });
      return core.fetch(req, { remote: r.remote ?? '127.0.0.1', desktop: r.desktop ?? false, upgrade: r.upgrade });
    },
  };
}

/** The routes of a core that change state, as "METHOD path": every route
 * whose method is not GET or HEAD, and the GETs writableGET names (they
 * start something, or hand out what only a client that may change things
 * needs). The guard of every request (ALL /*) is not one. */
export function mutatingRoutes(core: Hub, writableGET: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const r of core.http.app.routes) {
    if (r.method === 'ALL' && r.path === '/*') continue;
    const key = `${r.method} ${r.path}`;
    if ((r.method !== 'GET' && r.method !== 'HEAD') || writableGET.includes(key)) out.add(key);
  }
  return [...out];
}

/** Checks each route that changes state (mutatingRoutes) of two cores
 * built alike, one of them read-only: a request from another site is
 * refused by the guard, and so is any request in read-only mode, with 403
 * read_only, unless readOnlyAllowed names the route. Path parameters are
 * filled in with machine, a machine both cores have. Returns what is
 * wrong, and the routes checked. */
export async function checkGuarded(
  rw: TestHub,
  ro: TestHub,
  o: { machine: string; writableGET?: readonly string[]; readOnlyAllowed?: readonly string[] },
): Promise<{ problems: string[]; checked: string[] }> {
  const problems: string[] = [];
  const checked = mutatingRoutes(rw.hub, o.writableGET);
  for (const route of checked) {
    const [m, pattern] = route.split(' ');
    const method = m === 'ALL' ? 'POST' : m;
    const path = pattern
      .replace(/:id\b/g, o.machine)
      .replace(/:[A-Za-z_]+/g, 'x')
      .replace(/\*/g, 'x');
    const body = method === 'GET' || method === 'HEAD' ? undefined : '{}';
    for (const origin of ['https://evil.example', 'null', 'http://ide.example.com']) {
      const res = await rw.request(method, path, { origin, body });
      const text = await res.text();
      if (res.status !== 403 || !text.includes('origin not allowed')) problems.push(`${route} from ${origin}: ${res.status} ${text}`);
    }
    if (o.readOnlyAllowed?.includes(route)) continue;
    const res = await ro.request(method, path, { origin: 'http://127.0.0.1:7780', body });
    const text = await res.text();
    if (res.status !== 403 || !text.includes('"error":"read_only"')) problems.push(`${route} in read-only mode: ${res.status} ${text}`);
  }
  return { problems, checked };
}
