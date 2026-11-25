// A machine's node: the agent as a service, a process of its own that
// listens on the instance's <run>/node.sock and serves every client that
// connects as a session of one agent (agent.ts): the local core as well as
// cores that came over ssh (`node dial`). It runs detached from its
// clients, in a session of its own, and ends once it has had no client for
// NodeIdle.
//
// One node serves an instance (run/node.lock, flock). A client of a newer
// build (agentproto.newer) starts a node of its own build, which takes the
// socket over (NodeOp.Takeover): the old node gives up socket and lock,
// tells its sessions' cores to move (Op.NodeDrain), and ends once they
// left, at the latest after DRAIN_MAX_MS. A client of an older build uses
// the node as it is: the protocol only grows. Go and TypeScript builds of
// the machine side speak the same, so either takes over from the other.
import { closeSync, existsSync, openSync, rmSync } from 'node:fs';
import type { Server, Socket } from 'node:net';
import { posix } from 'node:path';
import { dirsFor, makeDirs } from '#shared/host/hostdirs.ts';
import type { Logger } from '#shared/lib/log.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { NodeOp, readLine, writeLine, type NodeHello, type NodeInfo, type Reply } from '#shared/proto/agentproto/index.ts';
import { pairDuplex } from '#shared/proto/yamux.ts';
import { Agent } from './agent.ts';
import { askTakeover, nodeSocket } from './dial.ts';
import type { MachineSide } from './feature.ts';
import { selfInfo } from './self.ts';
import { inode, listenUnix } from './sockets.ts';
import { tryLock } from './sys/fs.ts';
import { peerCred, socketFd } from './sys/proc.ts';

export interface NodeTiming {
  /** How long a node runs without a client. */
  idleMs: number;
  /** How long a node taking over waits for the lock the old one gives up. */
  takeoverWaitMs: number;
  /** How long a node that was taken over serves the sessions that have
   * not moved: the longest bounded request. */
  drainMaxMs: number;
  /** How often a node checks that its build is still there. */
  buildCheckMs: number;
  /** How long a client has to say hello. */
  helloMs: number;
}

export const NODE_TIMING: NodeTiming = {
  idleMs: 15_000,
  takeoverWaitMs: 5000,
  drainMaxMs: 10 * 60_000,
  buildCheckMs: 5000,
  helloMs: 10_000,
};

export interface NodeOptions {
  instance: string;
  logger: Logger;
  features: MachineSide[];
  /** Ask the running node to give way. */
  takeover?: boolean;
  /** Ends the node (SIGTERM, SIGINT). */
  signal?: AbortSignal;
  timing?: Partial<NodeTiming>;
  /** This build (tests give another). */
  me?: NodeInfo;
  /** The file this build runs from; the node retires once it is gone. */
  build?: string;
}

/** Serves the instance's node until it has had no client for idleMs, a
 * client asks it to stop, it was taken over and its clients left, or
 * signal ends. Returns at once when another node serves the instance,
 * unless takeover, which asks that node to give way. */
export async function runNode(o: NodeOptions): Promise<void> {
  const t = { ...NODE_TIMING, ...o.timing };
  const log = o.logger;
  const dirs = dirsFor(o.instance);
  makeDirs(dirs);
  const me = o.me ?? selfInfo();
  const sock = nodeSocket(dirs.run);
  let lock: number | null = openSync(posix.join(dirs.run, 'node.lock'), 'a+', 0o600);
  const releaseLock = () => {
    if (lock !== null) closeSync(lock);
    lock = null;
  };
  try {
    if (!tryLock(lock)) {
      if (!o.takeover) return;
      try {
        await askTakeover(sock, me);
      } catch (e) {
        throw new Error(`take over: ${(e as Error).message}`);
      }
      const deadline = Date.now() + t.takeoverWaitMs;
      while (!tryLock(lock)) {
        if (Date.now() > deadline) throw new Error('take over: the running node keeps its lock');
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  } catch (e) {
    releaseLock();
    throw e;
  }

  const stopped = new AbortController();
  const stop = () => stopped.abort();
  o.signal?.addEventListener('abort', stop, { once: true });
  let clients = 0;
  let gone = false;
  let draining = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const idleFrom = () => {
    clearTimeout(idle);
    idle = setTimeout(() => clients === 0 && stop(), t.idleMs);
  };
  let server: Server | null = null;
  let ino = 0n;
  /** Gives the socket (removed when unlink: nobody takes it over) and the
   * lock up: no new client reaches this node, which ends once its clients
   * have left. */
  const leave = (unlink: boolean) => {
    if (gone) return;
    gone = true;
    server?.close();
    if (unlink) {
      // Only while it is this node's: a node that took over has its own.
      try {
        if (inode(sock) === ino) rmSync(sock, { force: true });
      } catch {
        // gone
      }
    }
    releaseLock();
  };

  let agent: Agent | null = null;
  const serving = new Set<Promise<void>>();
  const accept = (c: Socket) => {
    if (gone) return void c.destroy();
    clients++;
    clearTimeout(idle);
    const p = serveClient(c)
      .catch((e) => log(`client: ${(e as Error).message}`))
      .finally(() => {
        serving.delete(p);
        if (--clients > 0) return;
        if (draining) stop();
        else idleFrom();
      });
    serving.add(p);
  };

  const serveClient = async (c: Socket) => {
    c.on('error', () => {});
    try {
      let uid = -1;
      try {
        uid = peerCred(socketFd(c)).uid;
      } catch (e) {
        log(`refused a connection (${(e as Error).message})`);
        return;
      }
      if (uid !== process.getuid!()) {
        log(`refused a connection of uid ${uid}`);
        return;
      }
      const reader = new Reader(c);
      const timer = setTimeout(() => c.destroy(), t.helloMs);
      let hello: NodeHello;
      try {
        hello = await readLine<NodeHello>(reader);
      } catch {
        return;
      } finally {
        clearTimeout(timer);
      }
      if (hello.op !== NodeOp.Serve && hello.op !== NodeOp.Stop && hello.op !== NodeOp.Takeover) {
        await writeLine(c, { ok: false, error: `unknown node op ${JSON.stringify(hello.op)}` } satisfies Reply).catch(() => {});
        return;
      }
      await writeLine(c, { ok: true, node: me } satisfies Reply);
      switch (hello.op) {
        case NodeOp.Serve: {
          const rest = reader.release();
          await agent!.serve(rest === c ? c : pairDuplex(rest, c), hello.client ?? '', hello.ssh_connection ?? '');
          return;
        }
        case NodeOp.Stop:
          log('asked to stop');
          stop();
          return;
        case NodeOp.Takeover:
          if (hello.node) takenOver(hello.node);
          return;
      }
    } finally {
      c.destroy();
    }
  };

  /** Gives way to the node next: the socket and lock are its, and the cores
   * are told to move. */
  const takenOver = (next: NodeInfo) => {
    log(`taken over by build ${next.build} (version ${next.version}, pid ${next.pid ?? 0}); draining`);
    leave(false);
    agent?.drain();
    // Ends once its clients left: the one that asked is one of them.
    draining = true;
    setTimeout(stop, t.drainMaxMs).unref();
  };

  try {
    // Holding the lock, what is at the path is a dead node's or the one a
    // node taking leave left for this one.
    ({ server, ino } = await listenUnix(sock, accept));
    log(`serving ${sock} (build ${me.build}, version ${me.version}, pid ${me.pid ?? process.pid})`);
    agent = new Agent({ instance: o.instance, dirs, logger: log, features: o.features });
    idleFrom();
    const build = o.build;
    const retire = build
      ? setInterval(() => {
          if (!existsSync(build)) {
            // A build removed (a development build, an uninstalled one):
            // a node started from another file takes the new clients.
            log(`${build} is gone; taking no new client`);
            leave(true);
            if (clients === 0) stop();
            else draining = true;
          }
        }, t.buildCheckMs)
      : undefined;
    await new Promise<void>((r) => (stopped.signal.aborted ? r() : stopped.signal.addEventListener('abort', () => r(), { once: true })));
    clearInterval(retire);
    clearTimeout(idle);
  } finally {
    leave(true);
    o.signal?.removeEventListener('abort', stop);
    await agent?.close();
    await Promise.race([Promise.allSettled([...serving]), new Promise((r) => setTimeout(r, 5000))]);
    log('stopped');
  }
}
