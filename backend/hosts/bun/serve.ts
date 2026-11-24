// `serve`: the core on the command line. It listens on loopback (or behind
// an authenticating proxy with its secret), connects to the machines and
// serves the web UI. With --parent-stdio a launcher (the desktop app, the
// end-to-end tests) owns it: the first line on stdin is its hello, the core
// answers a ready line on stdout and stops when stdin closes.
import { appendFileSync, openSync, readFileSync, closeSync } from 'node:fs';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import type { Server, ServerWebSocket } from 'bun';
import { CORE_BIN, NAME, SLUG, validInstance } from '#shared/lib/brand.ts';
import { stderrLogger, type Logger } from '#shared/lib/log.ts';
import { userConfigDir, userHomeDir } from '#shared/host/hostdirs.ts';
import { other as otherLoopback, inUse } from '#shared/host/loopback.ts';
import { VERSION } from '#shared/proto/agentproto/index.ts';
import { parseDuration } from '#shared/lib/gotime.ts';
import { auditLog, noAudit } from '#kernel/audit.ts';
import type { Channel, ChannelHandlers, ChannelOpen, Message } from '#kernel/channel.ts';
import { Keybindings } from '#kernel/config/keybindings/index.ts';
import { besideSettings, settingsPath } from '#kernel/config/paths.ts';
import { coreModules } from '#kernel/config/registry.ts';
import { settingsRoutes } from '#kernel/config/routes.ts';
import { Settings, settingFlags } from '#kernel/config/settings/index.ts';
import type { FeatureDef } from '#kernel/feature.ts';
import { createCore } from '#kernel/core.ts';
import { Guard, isLoopbackHost } from '#kernel/http/guard.ts';
import type { Peer } from '#kernel/http/env.ts';
import { serveUI } from '#kernel/http/static.ts';
import { isBreakable } from '#kernel/http/breakable.ts';
import { Machines } from '#kernel/machines/manager.ts';
import { Registry } from '#kernel/machines/registry.ts';
import { loadSpecs, validTarget, MAX_TARGET_LEN, type Spec } from '#kernel/machines/spec.ts';
import { controlDir as makeControlDir } from '#kernel/machines/transport/controldir.ts';
import { dialNode } from '#kernel/machines/transport/local.ts';
import { dialSSH } from '#kernel/machines/transport/ssh.ts';
import { machinesFeature } from '#features/machines/core.ts';
import { terminalsFeature } from '#features/terminals/core.ts';
import { guiFeature } from '#features/gui/core.ts';
import { browserFeature } from '#features/browser/core.ts';
import { searchFeature } from '#features/search/core.ts';
import { gitFeature } from '#features/git/core.ts';
import { monitorFeature } from '#features/monitor/core.ts';
import { usageFeature } from '#features/usage/core.ts';
import { vaultFeature } from '#features/vault/core.ts';
import { agentsFeature } from '#features/agents/core.ts';
import { historyFeature } from '#features/history/core.ts';
import { fileTransfersFeature, filesFeature } from '#features/files/core.ts';
import { chatFeature } from '#features/chat/core.ts';
import { vscodeFeatures } from '#features/vscode/core.ts';
import { readHello, desktopClient } from './parent.ts';
import { openPayloads } from './payloads.ts';
import { abortable } from './abortable.ts';
import { bunPty } from './pty.ts';

const OPTIONS = {
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
} as const;

function fatal(logger: Logger, msg: string): never {
  logger(msg);
  process.exit(1);
}

/** --local-only and --machine: which machines this run connects. */
export function selectSpecs(specs: Spec[], localOnly: boolean, extraSSH: readonly string[], only: readonly string[]): Spec[] {
  return specs.filter((s, i) => {
    const named = (list: readonly string[]) => list.some((v) => v === s.id || v === s.label || v === s.target);
    if (localOnly && i !== 0 && !named(extraSSH)) return false;
    return only.length === 0 || named(only);
  });
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

  let desktop = { token: '', verifyKey: '' };
  if (f['parent-stdio']) {
    // A launcher that is gone makes writes fail instead of killing us.
    process.on('SIGPIPE', () => {});
    try {
      desktop = await readHello(process.stdin);
    } catch (e) {
      fatal(logger, `--parent-stdio: ${(e as Error).message}`);
    }
  }
  const instance = f.instance;
  if (!validInstance(instance)) fatal(logger, '--instance must be lowercase letters, digits and dashes');
  const nodeInstance = f['node-instance'] ?? instance;
  if (!validInstance(nodeInstance)) fatal(logger, '--node-instance must be lowercase letters, digits and dashes');
  for (const t of f.ssh)
    if (!validTarget(t))
      fatal(
        logger,
        `--ssh ${JSON.stringify(t)}: a target is [user@]host, an ssh:// URL or a ~/.ssh/config alias of at most ${MAX_TARGET_LEN} bytes, not starting with -, without whitespace, control characters or any of ! " $ & ' ( ) * ; < > ? \\ \` { | }`,
      );

  const controlDir = process.platform === 'win32' ? '' : makeControlDir(instance);
  const payloads = await openPayloads({ agentDir: f['agent-dir'], extDir: f['ext-dir'], webDir: f['web-dir'] });
  const agents = payloads.agent.bind(payloads);
  let codeServerIdle: number;
  try {
    codeServerIdle = parseDuration(f['code-server-idle']);
  } catch (e) {
    fatal(logger, `--code-server-idle: ${(e as Error).message}`);
  }
  // Program windows give new terminals their display and follow the
  // terminal cores; they type into the terminals' shells.
  const gui = guiFeature({ encoder: (os, arch) => payloads.encoder(os, arch), shells: (m) => terminals.shells(m) });
  const terminals = terminalsFeature({ hc: (os, arch) => payloads.hc(os, arch), paneEnv: gui.paneEnv, onReady: gui.terminalReady });
  const features: FeatureDef[] = [
    machinesFeature({ home: () => userHomeDir(), controlDir, pty: bunPty }),
    terminals,
    gui,
    browserFeature(),
    fileTransfersFeature(),
    filesFeature(),
    searchFeature(),
    gitFeature(),
    monitorFeature(),
    usageFeature(),
    vaultFeature({ verifyKey: desktop.verifyKey }),
    agentsFeature(),
    chatFeature(),
    historyFeature(),
    ...vscodeFeatures({
      version: f['code-server-version'],
      tarballURL: f['code-server-url'],
      extensionURL: f['extension-url'],
      seedDirs: f['seed-dir'],
      offline: f.offline,
      idle: codeServerIdle,
      bridgeVSIX: () => payloads.bridgeVSIX(),
    }),
  ];

  const modules = coreModules(features);
  const flagDefs = settingFlags(modules);
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
  const settingValues = Object.fromEntries(flagDefs.filter((d) => typeof flags[d.name] === 'string').map((d) => [d.name, flags[d.name]]));

  let settingsFile = '';
  try {
    settingsFile = settingsPath(userConfigDir(), instance);
  } catch (e) {
    logger(`settings are not saved: ${(e as Error).message}`);
  }
  const settings = new Settings(settingsFile, { modules, flags: settingValues });
  const keybindings = new Keybindings(settingsFile && besideSettings(settingsFile, 'keybindings'));
  try {
    keybindings.load();
  } catch (e) {
    logger(`ignoring keybindings: ${(e as Error).message}`);
  }
  try {
    settings.load();
  } catch (e) {
    logger(`ignoring settings: ${(e as Error).message}`);
  }
  const machinesFile = settingsFile && besideSettings(settingsFile, 'machines');

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

  let registry: Registry;
  try {
    registry = machinesFile ? Registry.open(machinesFile) : Registry.memory();
  } catch (e) {
    logger(`machines are not stored: ${(e as Error).message}`);
    registry = Registry.memory();
  }
  if (registry.kept() > 0)
    logger(`${machinesFile}: ${registry.kept()} entries are not machines this version can use; they are kept in the file as they are`);
  for (const s of registry.specs())
    if (s.kind === 'ssh' && !validTarget(s.target ?? ''))
      logger(`machine ${s.id}: its ssh target is refused (invalid_target); it is shown in error and never connected`);
  const extra = f.ssh.map((t) => ({ id: t, label: t, target: t, enabled: true }));
  const specs = selectSpecs(loadSpecs(registry.specs(), extra, hostname()), f['local-only'], f.ssh, f.machine);

  const machines = new Machines({
    specs,
    registry,
    logger,
    dial: async (spec, signal) => {
      if (spec.kind === 'local') {
        const session = await dialNode({ instance: nodeInstance, agents, sshConnection: process.env.SSH_CONNECTION, logger, signal });
        return { session, platform: `${process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}` };
      }
      const { session, platform } = await dialSSH(
        { target: spec.target ?? '', controlDir, agents, logger, instance: nodeInstance },
        signal,
      );
      return { session, platform: `${platform.os}/${platform.arch}` };
    },
  });

  let audit = noAudit;
  if (f['audit-log']) {
    closeSync(openSync(f['audit-log'], 'a', 0o600));
    const path = f['audit-log'];
    audit = auditLog((line) => appendFileSync(path, line));
  }
  const guard = new Guard({ allowedOrigins: f['allowed-origin'], proxySecret: secret, logger });
  const core = createCore({
    guard,
    audit,
    readOnly: f['read-only'],
    userHeader: f['user-header'],
    logger,
    machines,
    settings,
    features,
  });
  const stopSettingsPush = settingsRoutes(core.http, { settings, keybindings, pages: core.pages });
  core.http.app.get('/api/config', (c) =>
    c.json({ name: NAME, slug: SLUG, version: VERSION, read_only: f['read-only'], ssh_login: controlDir !== '', client: c.var.client }),
  );
  serveUI(core.http.app, payloads.web);

  const stop = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop.abort());
  if (f['parent-stdio']) {
    // The pipe belongs to the launcher: its end, also a crash, stops us.
    process.stdin
      .on('end', () => stop.abort())
      .on('close', () => stop.abort())
      .resume();
  }
  // Edits of the files by hand apply without a restart.
  const watching = Promise.all([settings.watch(stop.signal), keybindings.watch(stop.signal)]).catch(() => {});

  // Bind before connecting to machines: a failed launch must not start agents.
  const fetch = (req: Request, server: Server<WSData>): Promise<Response> | Response | undefined => {
    const remote = server.requestIP(req)?.address;
    const peer: Peer = { remote, desktop: desktopClient(req.headers, desktop.token) };
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

  const running = core.run(stop.signal);
  logger(`${NAME} ${VERSION} listening on http://${address} (${specs.length} machines)${f['read-only'] ? ' (read-only)' : ''}`);
  if (f['parent-stdio']) process.stdout.write(JSON.stringify({ event: 'ready', url: `http://${address}` }) + '\n');

  await new Promise<void>((r) => (stop.signal.aborted ? r() : stop.signal.addEventListener('abort', () => r(), { once: true })));
  void server.stop(true);
  void o.other?.stop(true);
  // Machine sessions end with the signal; wait for them so that the local
  // agent stops what it started instead of leaving it behind.
  const late = await Promise.race([running.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 15_000))]);
  if (late) logger('machines did not disconnect within 15s');
  await watching;
  stopSettingsPush();
  process.exit(0);
}
