// `desktop`: the desktop app's hub, run directly from the Stage 1 compiled
// Bun executable (`<slug> desktop`) as a child of Electron's main process.
// It speaks the binary multiplex protocol (hosts/desktop/mux.ts) over
// stdin/stdout without listening on TCP, using the same runtime, pty and
// remote deployment pipeline as `serve`.
import { HUB_BIN } from '#shared/lib/brand.ts';
import { stderrLogger, type Logger } from '#shared/lib/log.ts';
import { noAudit } from '#kernel/audit.ts';
import { Guard } from '#kernel/http/guard.ts';
import { controlDir as makeControlDir } from '#kernel/machines/transport/controldir.ts';
import { composeHub, hubFeatures, type Composed } from '#hosts/common/compose.ts';
import type { HubStart, Port } from '#hosts/desktop/bridge.ts';
import { startProblem } from '#hosts/desktop/check.ts';
import { muxChild } from '#hosts/desktop/mux.ts';
import { serveParent } from '#hosts/desktop/serve.ts';
import { openPayloads } from './payloads.ts';
import { bunPty } from './pty.ts';

async function startDesktopHub(s: HubStart, logger: Logger): Promise<Composed> {
  const problem = startProblem(s);
  if (problem) throw new Error(problem);
  const controlDir = process.platform === 'win32' ? '' : makeControlDir(s.instance);
  const payloads = await openPayloads({
    agentDir: s.agentDir ?? '',
    extDir: '',
    webDir: s.web ?? '',
    payloadDir: s.payload,
    ownDigest: false,
    logger,
  });
  const features = hubFeatures({
    payloads,
    controlDir,
    verifyKey: s.verifyKey,
    pty: process.platform === 'win32' ? undefined : bunPty,
    codeServer: { seedDirs: s.seedDirs ?? [], offline: false, idle: 20 * 60_000 },
    chatSdk: { seedDirs: s.seedDirs ?? [] },
  });
  return composeHub({
    instance: s.instance,
    nodeInstance: s.nodeInstance,
    features,
    payloads,
    controlDir,
    localOnly: s.localOnly,
    // The app's windows are its only clients: its origin is the one the
    // guard lets in, and nothing listens on TCP.
    guard: new Guard({ allowedOrigins: [s.origin], logger }),
    audit: noAudit,
    readOnly: false,
    logger,
  });
}

export async function desktopServe(): Promise<void> {
  const logger = stderrLogger(`${HUB_BIN}: `);
  // stdout carries binary multiplex frames only; send any stray console
  // output to stderr with the hub's logs.
  const redirect = (...args: unknown[]) => logger(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  console.log = redirect;
  console.info = redirect;
  console.warn = redirect;
  process.on('SIGPIPE', () => {});
  process.stdout.on('error', () => {});

  const stop = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop.abort());

  let started = false;
  const parent = muxChild(process.stdin, process.stdout, () => {
    if (!started) process.exit(0);
    stop.abort();
  });
  process.stdin.resume();

  serveParent<Port>(parent, {
    start: (s) => {
      started = true;
      return startDesktopHub(s, logger);
    },
    port: (p) => p,
    logger,
    exit: (code) => process.exit(code),
    stop,
  });
  await new Promise<never>(() => {});
}
