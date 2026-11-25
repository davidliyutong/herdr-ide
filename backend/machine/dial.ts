// A node's clients: `node dial` (what ssh runs for a hub: standard input
// and output piped to the node, which it starts when none answers, or
// takes over from when the one that answers is of an older build), `node
// stop` and the takeover's hello.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readdirSync, renameSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { posix } from 'node:path';
import type { Duplex } from 'node:stream';
import { dirsFor, makeDirs, type Dirs } from '#shared/host/hostdirs.ts';
import type { Logger } from '#shared/lib/log.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { NodeOp, newer, readLine, writeLine, type NodeHello, type NodeInfo, type Reply } from '#shared/proto/agentproto/index.ts';
import { pairDuplex } from '#shared/proto/yamux.ts';
import { selfCommand, selfInfo } from './self.ts';

export const nodeSocket = (run: string): string => posix.join(run, 'node.sock');

/** A node's log moves to node.old.log at this size when a node starts. */
const NODE_LOG_MAX = 1 << 20;

/** Connects to the node on sock, says hello and returns the connection
 * (what follows the reply) and the node's build. */
export function dialNodeSocket(sock: string, hello: NodeHello, timeoutMs = 10_000): Promise<{ conn: Duplex; node?: NodeInfo }> {
  return new Promise((resolve, reject) => {
    const c: Socket = connect(sock);
    const timer = setTimeout(() => c.destroy(new Error('node: no answer')), timeoutMs);
    c.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    c.once('connect', async () => {
      try {
        await writeLine(c, hello);
        const r = new Reader(c);
        const rep = await readLine<Reply>(r);
        clearTimeout(timer);
        if (!rep.ok) {
          c.destroy();
          return reject(new Error(`node: ${rep.error ?? ''}`));
        }
        const rest = r.release();
        c.removeAllListeners('error');
        c.on('error', () => {});
        resolve({ conn: rest === c ? c : pairDuplex(rest, c), node: rep.node });
      } catch (e) {
        clearTimeout(timer);
        c.destroy();
        reject(e);
      }
    });
  });
}

/** Asks the node on sock to give way to me. */
export async function askTakeover(sock: string, me: NodeInfo): Promise<void> {
  const { conn } = await dialNodeSocket(sock, { op: NodeOp.Takeover, node: me });
  conn.destroy();
}

/** Starts `node` of this build in a session of its own, its output in the
 * host directory's node.log, and does not wait for it. */
export function startNode(instance: string, dirs: Dirs, takeover: boolean, command = selfCommand()): void {
  const hostDir = dirs.host;
  const log = posix.join(hostDir, 'node.log');
  try {
    if (statSync(log).size > NODE_LOG_MAX) renameSync(log, posix.join(hostDir, 'node.old.log'));
  } catch {
    // no log yet
  }
  const fd = openSync(log, 'a', 0o600);
  try {
    const [exe, ...args] = command;
    const p = spawn(exe, [...args, 'node', '--instance', instance, ...(takeover ? ['--takeover'] : [])], {
      detached: true,
      stdio: ['ignore', fd, fd],
      cwd: dirs.home,
    });
    p.on('error', () => {});
    p.unref();
  } finally {
    closeSync(fd);
  }
}

/** How long a client waits for a node it started. */
const NODE_START_WAIT_MS = 15_000;

/** Connects to the instance's node and asks it to serve the connection as
 * an agent session for the hub client that came through sshConn
 * (SSH_CONNECTION; "" for the local machine). With no node, or one of an
 * older build, it starts one of this build (which takes over from the
 * older one) and connects to that. */
export async function dialNode(o: {
  instance: string;
  client: string;
  sshConn: string;
  logger: Logger;
  signal?: AbortSignal;
  me?: NodeInfo;
  command?: string[];
  startWaitMs?: number;
}): Promise<Duplex> {
  const dirs = dirsFor(o.instance);
  makeDirs(dirs);
  const me = o.me ?? selfInfo();
  const sock = nodeSocket(dirs.run);
  const hello: NodeHello = {
    op: NodeOp.Serve,
    node: me,
    ...(o.client ? { client: o.client } : {}),
    ...(o.sshConn ? { ssh_connection: o.sshConn } : {}),
  };
  // usable: this build's node, or a newer one.
  const usable = (n?: NodeInfo) => !!n && (n.build === me.build || !newer(me, n));
  let first: { conn: Duplex; node?: NodeInfo } | null = null;
  try {
    first = await dialNodeSocket(sock, hello);
  } catch {
    // none answers
  }
  if (first && usable(first.node)) return first.conn;
  if (first) {
    first.conn.destroy();
    if (first.node) o.logger(`node: build ${me.build} (${me.version}) takes over from ${first.node.build} (${first.node.version})`);
  }
  try {
    startNode(o.instance, dirs, first !== null, o.command);
  } catch (e) {
    throw new Error(`start the node: ${(e as Error).message}`);
  }
  const deadline = Date.now() + (o.startWaitMs ?? NODE_START_WAIT_MS);
  let last: unknown;
  for (;;) {
    if (o.signal?.aborted) throw o.signal.reason;
    try {
      const c = await dialNodeSocket(sock, hello);
      if (usable(c.node)) return c.conn;
      c.conn.destroy(); // the old node, still giving way
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) {
      // The node that would not give way still serves.
      try {
        return (await dialNodeSocket(sock, hello)).conn;
      } catch (e) {
        throw new Error(`no node answers on ${sock}; see ${posix.join(dirs.host, 'node.log')}: ${((e ?? last) as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Asks every node of the instance to stop (also those of earlier builds,
 * on node-<build>.sock); how many did. */
export async function stopNodes(instance: string): Promise<number> {
  const dirs = dirsFor(instance);
  let names: string[] = [];
  try {
    names = readdirSync(dirs.run).filter((n) => /^node.*\.sock$/.test(n));
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    try {
      const { conn } = await dialNodeSocket(posix.join(dirs.run, name), { op: NodeOp.Stop }, 5000);
      conn.destroy();
      n++;
    } catch {
      // nothing answers there
    }
  }
  return n;
}
