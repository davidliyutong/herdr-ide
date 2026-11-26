// The bridge extension's socket (<run>/bridge.sock, 0600 in the 0700 run
// directory): each connection of a VS Code window is tunnelled to a hub,
// once it sent its first bytes (its hello), as a stream of op bridge the
// agent opens: to the hub whose session last opened a connection to
// code-server (it shows VS Code), else to the newest session's. A
// connection that sends nothing (another agent checking whether the socket
// is served) reaches no hub.
//
// The newest agent of the instance serves the socket and takes it over from
// another (one that lingers after a reconnect, or a node of another hub's
// build); the others serve it again once it is free (#machine/sockets.ts).
import type { Socket } from 'node:net';
import type { Logger } from '#shared/lib/log.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { Op } from '#shared/proto/agentproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import type { MachineSession } from '#machine/feature.ts';
import { pipe } from '#machine/hcop.ts';
import { serveSocket } from '#machine/sockets.ts';
import type { Layout } from './layout.ts';

/** How long a hub has to take a bridge stream. */
export const BRIDGE_REPLY_MS = 15_000;

/** The session a bridge connection goes to: the one whose last pipe to
 * code-server's socket is the latest, the newest one when none is later. */
export function bridgeSession(sessions: MachineSession[], socket: string): MachineSession | null {
  if (sessions.length === 0) return null;
  let best = sessions[sessions.length - 1];
  for (const s of sessions) if (s.dialed(socket).last > best.dialed(socket).last) best = s;
  return best;
}

/** Tunnels the window's connection c to a hub once it sent something. */
export async function relayWindow(c: Socket, sessions: () => MachineSession[], socket: string): Promise<void> {
  c.on('error', () => {});
  const r = new Reader(c);
  let first: Buffer | null;
  try {
    first = await r.chunk();
  } catch {
    first = null;
  }
  r.release();
  if (first === null) return void c.destroy();
  c.unshift(first);
  const s = bridgeSession(sessions(), socket);
  if (!s) return void c.destroy();
  let conn;
  try {
    const asked = await s.ask({ op: Op.Bridge }, BRIDGE_REPLY_MS);
    conn = asked.conn;
    if (!asked.reply.ok) {
      conn.reader.release();
      closeStream(conn.stream);
      return void c.destroy();
    }
  } catch {
    return void c.destroy();
  }
  await pipe(conn, c);
}

/** Serves the bridge's socket until signal ends. */
export function serveBridge(
  l: Layout,
  o: { sessions: () => MachineSession[]; signal: AbortSignal; logger: Logger; everyMs?: number },
): Promise<void> {
  return serveSocket('bridge', l.bridge, (c) => void relayWindow(c, o.sessions, l.socket), {
    signal: o.signal,
    logger: o.logger,
    everyMs: o.everyMs,
  });
}
