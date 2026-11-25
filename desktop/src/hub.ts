// The app's core runs in an Electron utility process
// (backend/hosts/electron), which the main process starts, restarts when
// it crashes (the windows stay) and stops when the app quits. Nothing
// listens: the main process hands the core the requests of the app's
// windows, which it intercepts at the app's origin (protocol.ts), and the
// channels (WebSockets) it brokers between a frame and the core, over the
// bridge of backend/hosts/electron/bridge.ts. The client is the desktop
// app because the main process says so; the verify key of the system's
// prompts goes to the core in its start message only.
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import {
  ABNORMAL,
  channelClient,
  request,
  type ChannelClient,
  type ChannelControl,
  type ChannelHead,
  type HubStart,
  type FromHub,
  type Port,
  type RequestHead,
  type ToHub,
} from '../../backend/hosts/electron/bridge';
import { APP_SLUG } from '../../web/src/brand';
import type { MessageKey } from '../../web/src/i18n/en';
import { APP_HOST, APP_ORIGIN } from './origin';
import type { Platform } from './platform';

export const ENV_PREFIX = APP_SLUG.toUpperCase().replaceAll('-', '_') + '_';

// A failure the launcher explains in the UI language; detail is technical
// (an exit code, the core's message) and shown as is.
export class DesktopError extends Error {
  constructor(
    readonly key: MessageKey,
    readonly detail = '',
  ) {
    super(detail ? `${key} (${detail})` : key);
  }
}

/** The instance of a run: `desktop`, or in development `dev` or the one
 * <prefix>DESKTOP_DEV names (`1` is `dev`), so that a smoke test can run
 * beside a development instance in use; never `desktop` itself. */
export function hubInstance(dev: boolean, devValue: string | undefined): string {
  if (!dev) return 'desktop';
  if (!devValue || devValue === '1') return 'dev';
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(devValue) || devValue === 'desktop') throw new DesktopError('desktop.badInstance', devValue);
  return devValue;
}

/** The instance of the machines' nodes (their data directory and terminal
 * core) a core of instance uses: the app's is the default one, which it
 * shares with every core of the default instance, as a server's UI;
 * a development instance keeps its own. */
export function nodeInstance(instance: string): string {
  return instance === 'desktop' ? '' : instance;
}

/** A new key for the system's prompts (verify.ts): 32 random bytes as hex,
 * for one launch (the core's restarts keep it). It goes to the core in the
 * start message and is kept in the main process: never in a cookie, an
 * environment variable, an argument or a log. */
export function verifyKey(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString('hex');
}

export function hubEnv(env: NodeJS.ProcessEnv, home: string, platform: Platform): NodeJS.ProcessEnv {
  // The core takes the user's proxy (HTTPS_PROXY, HTTP_PROXY, NO_PROXY) for
  // its own fetch itself (backend/shared/lib/proxy.ts): nothing is added
  // here that the programs it starts would inherit.
  // Windows keeps its Path as it is (its name differs in case, which a copy
  // of the environment would duplicate).
  if (platform === 'win32') return env;
  // Finder and desktop launchers do not load shell rc files. Include common
  // installations without executing the user's login shell or interpolating
  // shell commands.
  const paths = [
    env.PATH || '',
    posix.join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return { ...env, PATH: paths.filter(Boolean).join(posix.delimiter) };
}

/** The utility process as the host uses it (Electron's UtilityProcess). */
export interface HubChild {
  postMessage(message: ToHub, transfer?: unknown[]): void;
  on(event: 'message', fn: (message: unknown) => void): unknown;
  on(event: 'exit', fn: (code: number) => void): unknown;
  kill(): boolean;
  readonly stderr: NodeJS.ReadableStream | null;
}

/** What the host needs of Electron (a test gives worker_threads'). */
export interface HubSpawner {
  fork(): HubChild;
  /** A new MessageChannel: the ends as they are sent, and the bridge's
   * view of one. */
  pair(): [unknown, unknown];
  port(end: unknown): Port;
}

export interface HubHostOptions {
  spawner: HubSpawner;
  start: HubStart;
  /** The core keeps crashing: it is not started again. */
  lost(error: DesktopError): void;
  /** How long a start may take. */
  startMs?: number;
  /** How many restarts within restartWindowMs before giving up. */
  maxRestarts?: number;
  restartWindowMs?: number;
  /** Writes the core's log (the app's standard error). */
  log?: (chunk: string) => void;
  now?: () => number;
}

const isFromHub = (m: unknown): m is FromHub => typeof m === 'object' && m !== null && typeof (m as { t?: unknown }).t === 'string';

/** The core in its utility process. */
export class HubHost {
  private child?: HubChild;
  /** The processes that exited. */
  private readonly ended = new WeakSet<HubChild>();
  private ready: Promise<void> = Promise.reject(new DesktopError('desktop.hubExited'));
  private started = false;
  private stopping = false;
  private gone = false;
  private stopped?: Promise<void>;
  private crashes: number[] = [];
  private stderr = '';

  constructor(private readonly o: HubHostOptions) {
    this.ready.catch(() => {});
  }

  /** The end of the core's log, for the failure dialog. */
  get diagnostics(): string {
    return this.stderr;
  }

  /** Starts the core; resolves once it serves, rejects when it could not
   * start (then it is not started again). */
  start(): Promise<void> {
    return this.launch().then(() => {
      this.started = true;
    });
  }

  private launch(): Promise<void> {
    const child = this.o.spawner.fork();
    this.child = child;
    child.stderr?.on('data', (data: Buffer | string) => {
      const text = data.toString();
      this.stderr = (this.stderr + text).slice(-16_384);
      this.o.log?.(text);
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DesktopError('desktop.hubTimeout'));
        // Its exit restarts it, or fails the first start.
        child.kill();
      }, this.o.startMs ?? 30_000);
      child.on('message', (m) => {
        if (!isFromHub(m)) return;
        clearTimeout(timer);
        if (m.t === 'ready') resolve();
        else if (m.t === 'failed') reject(new DesktopError('desktop.hubFailed', m.message));
      });
      child.on('exit', (code) => {
        this.ended.add(child);
        clearTimeout(timer);
        reject(new DesktopError('desktop.hubExited', String(code)));
        this.exited(child, code);
      });
    });
    ready.catch(() => {});
    this.ready = ready;
    child.postMessage({ t: 'start', start: this.o.start });
    return ready;
  }

  /** A crash after the core served: started again, unless it crashed
   * maxRestarts times within the window. */
  private exited(child: HubChild, code: number): void {
    if (child !== this.child || this.stopping || !this.started) return;
    const now = (this.o.now ?? Date.now)();
    const window = this.o.restartWindowMs ?? 60_000;
    this.crashes = this.crashes.filter((t) => now - t < window);
    this.crashes.push(now);
    if (this.crashes.length > (this.o.maxRestarts ?? 3)) {
      this.gone = true;
      this.child = undefined;
      this.o.lost(new DesktopError('desktop.hubLost', String(code)));
      return;
    }
    this.o.log?.(`core exited (${code}); starting it again\n`);
    void this.launch().catch(() => {});
  }

  /** Waits until the core serves (also through a restart). */
  private async serving(): Promise<HubChild> {
    const deadline = (this.o.now ?? Date.now)() + (this.o.startMs ?? 30_000) * 2;
    for (;;) {
      if (this.stopping || this.gone) throw new DesktopError('desktop.hubLost');
      const r = this.ready;
      try {
        await r;
        if (this.child) return this.child;
      } catch (e) {
        if (this.ready === r && (this.o.now ?? Date.now)() > deadline) throw e;
        // A restart is on its way: wait for it.
        if (this.ready === r) await new Promise((ok) => setTimeout(ok, 50));
      }
    }
  }

  /** A request of the app (a window's, intercepted, or the shell's own):
   * the core's response, or 503 while it cannot be reached. origin is the
   * origin of the page that made it (protocol.ts), undefined for one the
   * browser or the shell started; it is the Origin the core sees, in place
   * of any the request carries. */
  async request(req: Request, origin?: string): Promise<Response> {
    let child: HubChild;
    try {
      child = await this.serving();
    } catch {
      return Response.json({ error: 'unavailable', message: 'the core is not running' }, { status: 503 });
    }
    const headers: [string, string][] = [];
    req.headers.forEach((v, k) => {
      if (k !== 'origin') headers.push([k, v]);
    });
    if (origin !== undefined) headers.push(['origin', origin]);
    if (!req.headers.has('host')) headers.push(['host', new URL(req.url).host]);
    const head: RequestHead = { method: req.method, url: req.url, headers, body: req.body !== null };
    const [ours, theirs] = this.o.spawner.pair();
    try {
      child.postMessage({ t: 'request', head }, [theirs]);
      return await request(this.o.spawner.port(ours), head, req.body, req.signal);
    } catch {
      return Response.json({ error: 'unavailable', message: 'the core went away' }, { status: 502 });
    }
  }

  /** The shell's own request of the core at path. */
  fetch(path: string, init?: RequestInit): Promise<Response> {
    return this.request(new Request(new URL(path, APP_ORIGIN), init));
  }

  /** Hands the core one end of a channel (the other is a frame's): once it
   * serves, or the end is told the channel failed. */
  async connect(head: ChannelHead, end: unknown): Promise<void> {
    let child: HubChild;
    try {
      child = await this.serving();
    } catch {
      const port = this.o.spawner.port(end);
      port.post({ t: 'close', code: ABNORMAL, reason: 'the core is not running' } satisfies ChannelControl);
      return;
    }
    try {
      child.postMessage({ t: 'channel', head }, [end]);
    } catch {
      this.o.spawner.port(end).post({ t: 'close', code: ABNORMAL, reason: 'the core is not running' } satisfies ChannelControl);
    }
  }

  /** The shell's own channel to the core at path. */
  channel(path: string, on: Parameters<typeof channelClient>[1]): ChannelClient {
    const [ours, theirs] = this.o.spawner.pair();
    const client = channelClient(this.o.spawner.port(ours), on);
    void this.connect(
      {
        url: new URL(path, APP_ORIGIN).href,
        headers: [
          ['host', APP_HOST],
          ['upgrade', 'websocket'],
          ['connection', 'Upgrade'],
        ],
      },
      theirs,
    );
    return client;
  }

  /** Stops the core: it ends its machines' sessions (up to 15 s); only
   * this owned process is killed if it has not ended within deadline ms,
   * never the terminal cores. */
  stop(deadline = 20_000): Promise<void> {
    if (this.stopped) return this.stopped;
    this.stopping = true;
    const child = this.child;
    if (!child || this.ended.has(child)) return Promise.resolve();
    this.stopped = new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill(), deadline);
      child.on('exit', () => {
        clearTimeout(force);
        resolve();
      });
      try {
        child.postMessage({ t: 'stop' });
      } catch {
        child.kill();
      }
    });
    return this.stopped;
  }
}

/** Why a frame's request for a channel is refused, or its head: the frame
 * of the app's origin asks for a path of it, with WebSocket subprotocols.
 * The main process builds the head from what it knows of the frame (its
 * origin), not from what the page says. */
export function channelHead(frameOrigin: string | undefined, path: unknown, protocols: unknown): ChannelHead | undefined {
  if (frameOrigin !== APP_ORIGIN) return undefined;
  if (typeof path !== 'string' || path.length > 8192 || !path.startsWith('/') || path.startsWith('//')) return undefined;
  let url: URL;
  try {
    url = new URL(path, APP_ORIGIN);
  } catch {
    return undefined;
  }
  if (url.origin !== APP_ORIGIN) return undefined;
  if (
    !Array.isArray(protocols) ||
    protocols.length > 16 ||
    !protocols.every((p) => typeof p === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(p))
  )
    return undefined;
  const headers: [string, string][] = [
    ['host', APP_HOST],
    ['origin', APP_ORIGIN],
    ['upgrade', 'websocket'],
    ['connection', 'Upgrade'],
  ];
  if (protocols.length) headers.push(['sec-websocket-protocol', protocols.join(', ')]);
  return { url: url.href, headers };
}

/** A channel's id as the preload makes it. */
export const isChannelId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
