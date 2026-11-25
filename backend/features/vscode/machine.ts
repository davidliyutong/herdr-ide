// VS Code's machine side (docs/features/05-vscode-panes.md): code-server of
// the instance, installed from a release the core uploads or the machine
// downloads (checked against the digest the core knows before it is
// unpacked) or found on the machine, started on a unix socket of the run
// directory and ended by its owner (op code-server: machine/op.ts,
// machine/server.ts, machine/release.ts), and the bridge extension's socket,
// tunnelled to a core (machine/bridge.ts). The core reaches code-server's
// socket through op dial-unix, which the agent counts per session: a core's
// idle end (release) keeps a code-server another core's windows use, and
// the bridge leads to the core that opened VS Code last.
import { posix } from 'node:path';
import { Op } from '#shared/proto/agentproto/index.ts';
import { defineMachine } from '#machine/feature.ts';
import { serveBridge } from './machine/bridge.ts';
import { layoutOf, releaseDir, validVersion, type Layout } from './machine/layout.ts';
import { serveCodeServer, type OpOptions } from './machine/op.ts';
import { pruneReleases, type ReleaseLimits } from './machine/release.ts';
import { CodeServer, type ServerOptions, type ServerTiming } from './machine/server.ts';
import { vscodeProtocol } from './protocol.ts';

export interface VscodeMachineOptions {
  timing?: Partial<ServerTiming>;
  limits?: Partial<ReleaseLimits>;
  installExtMs?: number;
  /** How often the bridge's socket is checked (#machine/sockets.ts). */
  socketWatchMs?: number;
  /** The layout of a machine (tests give another platform). */
  layout?: (env: { home: string; run: string; host: string }) => Layout;
  installedDirs?: ServerOptions['installedDirs'];
}

export function vscodeMachine(o: VscodeMachineOptions = {}) {
  return defineMachine(vscodeProtocol, (env) => {
    const l = (o.layout ?? layoutOf)(env);
    const cs = new CodeServer(l, {
      home: env.home,
      logger: env.logger,
      environ: env.environ,
      timing: o.timing,
      installedDirs: o.installedDirs,
    });
    // A code-server whose node was killed is ended by the next one.
    void cs.reapOrphan().catch((e) => env.logger(`code-server: ${(e as Error).message}`));
    const bridge = serveBridge(l, { sessions: env.sessions, signal: env.signal, logger: env.logger, everyMs: o.socketWatchMs }).catch((e) =>
      env.logger(`bridge: ${(e as Error).message}`),
    );
    const op: OpOptions = { logger: env.logger, limits: o.limits, installExtMs: o.installExtMs };
    return {
      actions: {},
      ops: { [Op.CodeServer]: (conn, h, ctx) => serveCodeServer(cs, conn, h, ctx, op) },
      async housekeep(now: Date) {
        // The running code-server's release is in use, and the others go
        // after their retention.
        await cs.touchRunning(now);
        const p = await cs.readPid();
        await pruneReleases(l, p && validVersion(p.version) ? posix.basename(releaseDir(l, p.version)) : '', now, env.logger);
      },
      handOver: (next) => void cs.handOver(next.pid ?? 0).catch(() => {}),
      async close() {
        await bridge;
        await cs.close();
      },
    };
  });
}
