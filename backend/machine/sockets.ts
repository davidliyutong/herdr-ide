// The unix sockets the agent serves: in the 0700 run directory, 0600, and
// bound under a temporary name that is renamed into place, so a server
// that closes (Bun removes the path it bound) never removes a socket
// another agent put at the path since.
import { chmodSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { posix } from 'node:path';
import type { Logger } from '#shared/lib/log.ts';
import { UNIX_PATH_BYTES } from '#shared/host/hostdirs.ts';

/** How often an agent checks that the socket it serves is still its own,
 * or, its socket taken over, whether the path is free again. */
export const SOCKET_WATCH_MS = 2000;

/** The inode of what is at path, null for nothing. */
export function inode(path: string): bigint | null {
  try {
    return lstatSync(path, { bigint: true }).ino;
  } catch {
    return null;
  }
}

/** Listens on path (0600), replacing what is there (a stale socket, or
 * another agent's, which this one takes over); the server and the
 * socket's inode. */
export async function listenUnix(path: string, accept: (c: Socket) => void): Promise<{ server: Server; ino: bigint }> {
  const dir = posix.dirname(path);
  const available = UNIX_PATH_BYTES - Buffer.byteLength(dir) - 1;
  if (Buffer.byteLength(path) > UNIX_PATH_BYTES || available < 3) throw new Error(`unix socket path is too long: ${path}`);
  const tmp = posix.join(dir, ('.' + randomBytes(7).toString('hex')).slice(0, available));
  const server = createServer({ pauseOnConnect: true }, accept);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(tmp, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    server.close();
    throw e;
  }
  server.on('error', () => {});
  return { server, ino: inode(path) ?? 0n };
}

/** Whether something accepts a connection on path within 1 s (the
 * connection sends nothing and is closed again). */
export function answers(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((res) => {
    const c = connect(path);
    const t = setTimeout(() => {
      c.destroy();
      res(false);
    }, timeoutMs);
    c.once('connect', () => {
      clearTimeout(t);
      c.destroy();
      res(true);
    });
    c.once('error', () => {
      clearTimeout(t);
      res(false);
    });
  });
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    if (signal.aborted) return r();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      r();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/** Serves the socket at path until signal ends, passing each connection to
 * accept; name prefixes the log. The newest agent of the instance takes
 * the socket over: after a reconnect the agent of the old session may
 * linger until it notices, and the socket must lead to the session that
 * works. An agent removes the socket at its end only while it is still its
 * own (the same inode), and one whose socket was taken over serves it
 * again once the path is free (the newer agent gone, or killed and its
 * socket left), so the socket is served while any agent of the instance
 * runs. */
export async function serveSocket(
  name: string,
  path: string,
  accept: (c: Socket) => void,
  o: { signal: AbortSignal; logger: Logger; everyMs?: number; listening?: () => void },
): Promise<void> {
  const every = o.everyMs ?? SOCKET_WATCH_MS;
  let failed = false;
  while (!o.signal.aborted) {
    let served: { server: Server; ino: bigint } | null = null;
    try {
      served = await listenUnix(path, accept);
      failed = false;
    } catch (e) {
      if (!failed) o.logger(`${name}: ${(e as Error).message}`);
      failed = true;
    }
    if (served) {
      o.listening?.();
      let lost = false;
      while (!o.signal.aborted) {
        await sleep(every, o.signal);
        if (o.signal.aborted) break;
        if (inode(path) !== served.ino) {
          lost = true;
          break;
        }
      }
      served.server.close();
      if (!lost) {
        if (inode(path) === served.ino) rmSync(path, { force: true });
        return;
      }
      o.logger(`${name}: ${path} is served by another agent of the instance; served again here once it is free`);
    }
    // Wait until nothing serves the path.
    for (;;) {
      await sleep(every, o.signal);
      if (o.signal.aborted) return;
      if (inode(path) === null || !(await answers(path))) break;
    }
  }
}
