// The hub process's side of the desktop bridge (bridge.ts): it starts the
// hub when the main process says so, answers each request and adopts each
// channel the main process hands it, and stops the hub when told (or when
// its stdin pipe closes). Nothing here listens on TCP: the app's windows
// reach the hub only through its main process.
import type { Hub } from '#kernel/hub.ts';
import type { Composed } from '#hosts/common/compose.ts';
import { serveChannel, serveRequest, type HubStart, type FromHub, type Port, type ToHub } from './bridge.ts';

/** What the parent control channel gives: a message's data and the virtual
 * ports sent with it (muxChild on stdio, or a test's stand-in). */
export interface Parent<P> {
  on(event: 'message', fn: (e: { data: unknown; ports: readonly P[] }) => void): unknown;
  postMessage(m: FromHub): void;
}

export interface ServeOptions<P> {
  start(s: HubStart): Composed | Promise<Composed>;
  /** The bridge's view of a port the main process sent. */
  port(p: P): Port;
  logger: (line: string) => void;
  /** Ends the process once the hub stopped. */
  exit(code: number): void;
  /** Optional external abort signal (such as stdin EOF). */
  stop?: AbortController;
  /** Optional override of the per-message channel limit (tests). */
  maxMessage?: number;
}

const isToHub = (m: unknown): m is ToHub => typeof m === 'object' && m !== null && typeof (m as { t?: unknown }).t === 'string';

/** Serves the main process on parent; the hub it starts ends with stop. */
export function serveParent<P>(parent: Parent<P>, o: ServeOptions<P>): void {
  let hub: Hub | undefined;
  let starting = false;
  const stop = o.stop ?? new AbortController();
  // Requests of the app's windows: the main process vouches that they are
  // its windows' (the client is the desktop app's); none came over a
  // network.
  const answer = (req: Request) =>
    hub ? hub.fetch(req, { desktop: true }) : Promise.resolve(Response.json({ error: 'starting' }, { status: 503 }));
  parent.on('message', (e) => {
    const m = e.data;
    if (!isToHub(m)) return;
    const port = e.ports[0];
    switch (m.t) {
      case 'start': {
        if (hub || starting || stop.signal.aborted) return;
        starting = true;
        void Promise.resolve()
          .then(() => o.start(m.start))
          .then(
            (composed) => {
              hub = composed.hub;
              parent.postMessage({ t: 'ready' });
              return composed.run(stop.signal).then(
                () => o.exit(0),
                (err) => {
                  o.logger(`hub: ${(err as Error).message}`);
                  o.exit(1);
                },
              );
            },
            (err) => {
              parent.postMessage({ t: 'failed', message: (err as Error).message });
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
          void serveChannel(o.port(port), m.head, (req, upgrade) => (hub ? hub.fetch(req, { desktop: true, upgrade }) : answer(req)), {
            maxMessage: o.maxMessage,
          }).catch((err) => o.logger(`channel: ${(err as Error).message}`));
        return;
      case 'stop':
        if (!hub && !starting) return o.exit(0);
        stop.abort();
        return;
    }
  });
}
