// `serve`: the core on the command line. It listens on loopback (or behind
// an authenticating proxy with its secret), connects to the machines and
// serves the web UI to browsers. With --parent-stdio a launcher (the
// end-to-end tests) owns it: the core answers a ready line on stdout and
// stops when stdin closes. The desktop app runs the core in process
// instead (hosts/electron).
import { appendFileSync, openSync, readFileSync, closeSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Server, ServerWebSocket } from 'bun';
import { CORE_BIN, NAME, validInstance } from '#shared/lib/brand.ts';
import { stderrLogger, type Logger } from '#shared/lib/log.ts';
import { other as otherLoopback, inUse } from '#shared/host/loopback.ts';
import { VERSION } from '#shared/proto/agentproto/index.ts';
import { parseDuration } from '#shared/lib/gotime.ts';
import { downloadURLRefusal } from '#shared/lib/urls.ts';
import { auditLog, noAudit } from '#kernel/audit.ts';
import type { Channel, ChannelHandlers, ChannelOpen, Message } from '#kernel/channel.ts';
import { coreModules } from '#kernel/config/registry.ts';
import { settingFlags } from '#kernel/config/settings/index.ts';
import { Guard, isLoopbackHost } from '#kernel/http/guard.ts';
import type { Peer } from '#kernel/http/env.ts';
import { isBreakable } from '#kernel/http/breakable.ts';
import { validTarget, MAX_TARGET_LEN } from '#kernel/machines/spec.ts';
import { controlDir as makeControlDir } from '#kernel/machines/transport/controldir.ts';
import { composeCore, coreFeatures } from '#hosts/common/compose.ts';
import { openPayloads } from './payloads.ts';
import { abortable } from './abortable.ts';
import { bunPty } from './pty.ts';

/** The flags of serve besides the settings' (settingFlags). */
export const OPTIONS = {
  listen: { type: 'string', default: '127.0.0.1:7780' },
  'parent-stdio': { type: 'boolean', default: false },
  'insecure-listen': { type: 'boolean', default: false },
  'proxy-secret-file': { type: 'string', default: '' },
  'read-only': { type: 'boolean', default: false },
  'audit-log': { type: 'string', default: '' },
  'user-header': { type: 'string', default: '' },
  instance: { type: 'string', default: '' },
  'node-instance': { type: 'string' },
  'local-only': { type: 'boolean', default: false },
  'code-server-idle': { type: 'string', default: '20m' },
  'agent-dir': { type: 'string', default: '' },
  'ext-dir': { type: 'string', default: '' },
  'web-dir': { type: 'string', default: '' },
  'allowed-origin': { type: 'string', multiple: true, default: [] as string[] },
  machine: { type: 'string', multiple: true, default: [] as string[] },
  ssh: { type: 'string', multiple: true, default: [] as string[] },
  'code-server-version': { type: 'string' },
  'code-server-url': { type: 'string' },
  'extension-url': { type: 'string' },
  'seed-dir': { type: 'string', multiple: true, default: [] as string[] },
  offline: { type: 'boolean', default: false },
  'npm-registry': { type: 'string', default: '' },
} as const;

/** The flags naming where the core and the machines download from: the
 * machines get these URLs on their command lines, which every local user
 * there can read, so they hold no credentials (shared/lib/urls.ts). */
const URL_FLAGS = ['npm-registry', 'code-server-url'] as const;

/** Why the download URLs of flags f are refused, "" when they are not: each
 * http or https with a host, without user information, query or fragment.
 * A mirror that needs credentials is served through a --seed-dir. */
export function urlFlagsRefusal(f: Partial<Record<(typeof URL_FLAGS)[number], unknown>>): string {
  for (const name of URL_FLAGS) {
    const v = f[name];
    if (v === undefined || v === '') continue;
    const why = typeof v === 'string' ? downloadURLRefusal(v) : 'no value';
    if (why)
      return `--${name}: ${why}; it must be an http or https URL without user information, query or fragment (put what a mirror that needs credentials serves into a --seed-dir instead)`;
  }
  return '';
}

function fatal(logger: Logger, msg: string): never {
  logger(msg);
  process.exit(1);
}

/** A WebSocket of Bun.serve as a channel. */
interface WSData {
  open: ChannelOpen;
  compress: boolean;
  handlers?: ChannelHandlers;
}
function wsChannel(ws: ServerWebSocket<WSData>): Channel {
  return {
    send: (d: Message) => void ws.send(d, ws.data.compress),
    get buffered() {
      return ws.getBufferedAmount();
    },
    close: (code, reason) => ws.close(code, reason),
  };
}

export async function serve(argv: string[]): Promise<void> {
  const logger = stderrLogger(`${CORE_BIN}: `);
  // The settings' flags depend on the features, which depend on the
  // instance: a first pass reads the command line's own flags, the second
  // checks every flag, the settings' too.
  const { values: f } = parseArgs({ args: argv, options: OPTIONS, strict: false, allowPositionals: true }) as unknown as {
    values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values'];
  };

  // A launcher that is gone makes writes fail instead of killing us.
  if (f['parent-stdio']) process.on('SIGPIPE', () => {});
  const instance = f.instance;
  if (!validInstance(instance)) fatal(logger, '--instance must be lowercase letters, digits and dashes');
  const nodeInstance = f['node-instance'] ?? instance;
  if (!validInstance(nodeInstance)) fatal(logger, '--node-instance must be lowercase letters, digits and dashes');
  const badURL = urlFlagsRefusal(f);
  if (badURL) fatal(logger, badURL);
  for (const t of f.ssh)
    if (!validTarget(t))
      fatal(
        logger,
        `--ssh ${JSON.stringify(t)}: a target is [user@]host, an ssh:// URL or a ~/.ssh/config alias of at most ${MAX_TARGET_LEN} bytes, not starting with -, without whitespace, control characters or any of ! " $ & ' ( ) * ; < > ? \\ \` { | }`,
      );

  const controlDir = process.platform === 'win32' ? '' : makeControlDir(instance);
  const payloads = await openPayloads({ agentDir: f['agent-dir'], extDir: f['ext-dir'], webDir: f['web-dir'], logger });
  let codeServerIdle: number;
  try {
    codeServerIdle = parseDuration(f['code-server-idle']);
  } catch (e) {
    fatal(logger, `--code-server-idle: ${(e as Error).message}`);
  }
  const features = coreFeatures({
    payloads,
    controlDir,
    // The desktop app's proofs are its own core's (hosts/electron).
    verifyKey: '',
    pty: bunPty,
    codeServer: {
      version: f['code-server-version'],
      tarballURL: f['code-server-url'],
      extensionURL: f['extension-url'],
      seedDirs: f['seed-dir'],
      offline: f.offline,
      idle: codeServerIdle,
    },
    chatSdk: { seedDirs: f['seed-dir'], offline: f.offline, registry: f['npm-registry'] },
  });

  const flagDefs = settingFlags(coreModules(features));
  let flags: Record<string, string | boolean | undefined>;
  try {
    flags = parseArgs({
      args: argv,
      options: { ...OPTIONS, ...Object.fromEntries(flagDefs.map((d) => [d.name, { type: 'string' as const }])) },
      strict: true,
      allowPositionals: false,
    }).values as unknown as Record<string, string | boolean | undefined>;
  } catch (e) {
    fatal(logger, (e as Error).message);
  }
  const settingValues = Object.fromEntries(
    flagDefs.flatMap((d) => (typeof flags[d.name] === 'string' ? [[d.name, flags[d.name] as string]] : [])),
  );

  let secret = '';
  if (f['proxy-secret-file']) {
    secret = readFileSync(f['proxy-secret-file'], 'utf8').trim();
    if (secret.length < 16) fatal(logger, `${f['proxy-secret-file']}: secret must be at least 16 characters`);
  }
  const m = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(f.listen);
  if (!m) fatal(logger, `--listen ${f.listen}: want host:port`);
  const listenHost = m[1] ?? m[2];
  const listenPort = Number(m[3]);
  if (!isLoopbackHost(listenHost) || listenHost.endsWith('.localhost')) {
    if (secret) {
      // the proxy's secret guards it
    } else if (f['insecure-listen'])
      logger(
        `WARNING: listening on ${f.listen} without authentication (--insecure-listen); anyone reaching it gets shell access to every machine`,
      );
    else
      fatal(
        logger,
        `refusing to listen on ${f.listen}: the server has no authentication of its own. Keep it on loopback behind an authenticating reverse proxy, or pass --proxy-secret-file (or --insecure-listen to accept the risk)`,
      );
  }

  let audit = noAudit;
  if (f['audit-log']) {
    closeSync(openSync(f['audit-log'], 'a', 0o600));
    const path = f['audit-log'];
    audit = auditLog((line) => appendFileSync(path, line));
  }
  const guard = new Guard({ allowedOrigins: f['allowed-origin'], proxySecret: secret, logger });
  const { core, specs, run } = composeCore({
    instance,
    nodeInstance,
    features,
    flags: settingValues,
    payloads,
    controlDir,
    localOnly: f['local-only'],
    ssh: f.ssh,
    only: f.machine,
    guard,
    audit,
    readOnly: f['read-only'],
    userHeader: f['user-header'],
    logger,
  });

  const stop = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop.abort());
  if (f['parent-stdio']) {
    // The pipe belongs to the launcher: its end, also a crash, stops us.
    process.stdin
      .on('end', () => stop.abort())
      .on('close', () => stop.abort())
      .resume();
  }

  // Bind before connecting to machines: a failed launch must not start agents.
  const fetch = (req: Request, server: Server<WSData>): Promise<Response> | Response | undefined => {
    const remote = server.requestIP(req)?.address;
    // Every client of the command line's core is a browser: the desktop
    // app runs its own core in process (hosts/electron).
    const peer: Peer = { remote, desktop: false };
    if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket')
      peer.upgrade = (open, opts) =>
        server.upgrade(req, { data: { open, compress: !!opts?.compress } })
          ? new Response(null, { status: 200 })
          : new Response('upgrade failed', { status: 400 });
    return core.fetch(req, peer).then((res) => (isBreakable(res) ? abortable(res) : res));
  };
  const websocket = {
    open(ws: ServerWebSocket<WSData>) {
      ws.data.handlers = ws.data.open(wsChannel(ws));
    },
    message(ws: ServerWebSocket<WSData>, data: string | Buffer) {
      ws.data.handlers?.message(typeof data === 'string' ? data : new Uint8Array(data));
    },
    close(ws: ServerWebSocket<WSData>, code: number, reason: string) {
      ws.data.handlers?.close?.(code, reason);
    },
    drain(ws: ServerWebSocket<WSData>) {
      ws.data.handlers?.drain?.();
    },
    maxPayloadLength: 64 << 20,
    perMessageDeflate: true,
  };
  // Bun answers a body over maxRequestBodySize with a bare 413 before the
  // core sees it: a little over the largest upload (4 GiB), so that the
  // files feature answers its own too_large.
  const maxRequestBodySize = 4 * 2 ** 30 + (1 << 20);
  const listen = (hostname: string, port: number) =>
    Bun.serve<WSData>({ hostname, port, ipv6Only: hostname.includes(':'), fetch, websocket, idleTimeout: 0, maxRequestBodySize });
  let server: Server<WSData>;
  try {
    server = listen(listenHost, listenPort);
  } catch (e) {
    fatal(logger, (e as Error).message);
  }
  const address = `${server.hostname?.includes(':') ? `[${server.hostname}]` : server.hostname}:${server.port}`;
  // "localhost" names 127.0.0.1 and ::1, and a browser tries either first:
  // the core takes the other one's port too, so that the name leads to it.
  // Only then does it vouch for http://localhost:<port>.
  const o = await otherLoopback({ address: server.hostname ?? '', port: server.port ?? 0, family: '' }, async (host, port) =>
    listen(host, port),
  );
  if (o.err) {
    const why = inUse(o.err) ? 'another program listens on' : 'could not take';
    logger(
      `${why} the other loopback address of this port (${(o.err as Error).message}): http://localhost:${server.port} may lead to another program; use http://${address}`,
    );
  }
  if (o.owned) guard.ownLocalhost(String(server.port));

  const running = run(stop.signal);
  logger(`${NAME} ${VERSION} listening on http://${address} (${specs.length} machines)${f['read-only'] ? ' (read-only)' : ''}`);
  if (f['parent-stdio']) process.stdout.write(JSON.stringify({ event: 'ready', url: `http://${address}` }) + '\n');

  await new Promise<void>((r) => (stop.signal.aborted ? r() : stop.signal.addEventListener('abort', () => r(), { once: true })));
  void server.stop(true);
  void o.other?.stop(true);
  await running;
  process.exit(0);
}
