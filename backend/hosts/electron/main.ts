// The entry of the desktop app's utility process (Electron's
// utilityProcess, which the app's main process forks and restarts after a
// crash): the core of the app, served to the main process over
// MessagePorts (serve.ts), without a listener.
import { CORE_BIN } from '#shared/lib/brand.ts';
import { stderrLogger } from '#shared/lib/log.ts';
import { electronPort, type ElectronPort } from './bridge.ts';
import { nodePty } from './pty.ts';
import { serveParent, type Parent } from './serve.ts';
import { startCore } from './start.ts';

const logger = stderrLogger(`${CORE_BIN}: `);
const parent = (process as unknown as { parentPort?: Parent<ElectronPort> }).parentPort;
if (!parent) {
  logger('the desktop app runs this in its utility process');
  process.exit(2);
}
serveParent(parent, {
  start: (s) => startCore(s, { logger, pty: nodePty }),
  port: electronPort,
  logger,
  exit: (code) => process.exit(code),
});
