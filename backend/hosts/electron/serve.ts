// The utility process's side of the bridge (bridge.ts): it starts the
// core when the main process says so, answers each request and adopts
// each channel the main process hands it, and stops the core when told
// (the app quits; Electron ends its utility processes with it). Nothing
// here listens: the app's windows reach the core only through its main
// process.
import type { Core } from '#kernel/hub.ts';
import type { Composed } from '#hosts/common/compose.ts';
import { serveChannel, serveRequest, type CoreStart, type FromCore, type Port, type ToCore } from './bridge.ts';

/** What the parent port gives: a message's data and the ports sent
 * with it (Electron's process.parentPort, a test's stand-in). */
export interface Parent<P> {
  on(event: 'message', fn: (e: { data: unknown; ports: readonly P[] }) => void): unknown;
  postMessage(m: FromCore): void;
}

export interface ServeOptions<P> {
  start(s: CoreStart): Composed;
  /** The bridge's view of a port the main process sent. */
  port(p: P): Port;
  logger: (line: string) => void;
  /** Ends the process once the core stopped. */
  exit(code: number): void;
}

const isToCore = (m: unknown): m is ToCore => typeof m === 'object' && m !== null && typeof (m as { t?: unknown }).t === 'string';

/** Serves the main process on parent; the core it starts ends with stop. */
export function serveParent<P>(parent: Parent<P>, o: ServeOptions<P>): void {
  let core: Core | undefined;
  const stop = new AbortController();
  // Requests of the app's windows: the main process vouches that they are
  // its windows' (the client is the desktop app's); none came over a
  // network.
  const answer = (req: Request) =>
    core ? core.fetch(req, { desktop: true }) : Promise.resolve(Response.json({ error: 'starting' }, { status: 503 }));
  parent.on('message', (e) => {
    const m = e.data;
    if (!isToCore(m)) return;
    const port = e.ports[0];
    switch (m.t) {
      case 'start': {
        if (core || stop.signal.aborted) return;
        let composed: Composed;
        try {
          composed = o.start(m.start);
        } catch (err) {
          parent.postMessage({ t: 'failed', message: (err as Error).message });
          o.exit(1);
          return;
        }
        core = composed.core;
        parent.postMessage({ t: 'ready' });
        void composed.run(stop.signal).then(
          () => o.exit(0),
          (err) => {
            o.logger(`core: ${(err as Error).message}`);
            o.exit(1);
          },
        );
        return;
      }
      case 'request':
        if (port) void serveRequest(o.port(port), m.head, answer).catch((err) => o.logger(`request: ${(err as Error).message}`));
        return;
      case 'channel':
        if (port)
          void serveChannel(o.port(port), m.head, (req, upgrade) =>
            core ? core.fetch(req, { desktop: true, upgrade }) : answer(req),
          ).catch((err) => o.logger(`channel: ${(err as Error).message}`));
        return;
      case 'stop':
        if (!core) return o.exit(0);
        stop.abort();
        return;
    }
  });
}
