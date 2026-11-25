// The entry of the desktop app's utility process (Electron's
// utilityProcess, which the app's main process forks and restarts after a
// crash): the hub of the app, served to the main process over
// MessagePorts (serve.ts), without a listener.
import { HUB_BIN } from '#shared/lib/brand.ts';
import { stderrLogger } from '#shared/lib/log.ts';
import { useEnvProxy } from '#shared/lib/proxy.ts';
import { electronPort, type ElectronPort } from './bridge.ts';
import { nodePty } from './pty.ts';
import { serveParent, type Parent } from './serve.ts';
import { startHub } from './start.ts';

const logger = stderrLogger(`${HUB_BIN}: `);
// The hub's downloads through the user's proxy, in this process only.
if (useEnvProxy()) logger('fetch goes through the proxy of HTTPS_PROXY and HTTP_PROXY (NO_PROXY and loopback excepted)');
const parent = (process as unknown as { parentPort?: Parent<ElectronPort> }).parentPort;
if (!parent) {
  logger('the desktop app runs this in its utility process');
  process.exit(2);
}
serveParent(parent, {
  start: (s) => startHub(s, { logger, pty: nodePty }),
  port: electronPort,
  logger,
  exit: (code) => process.exit(code),
});
