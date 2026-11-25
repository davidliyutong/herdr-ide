// The local machine (Linux and macOS): its node of this build, reached on
// the node's socket, started from the machine build installed for this
// platform when none answers, as `node dial` does for a core that comes
// over ssh. The node is the same program a remote machine runs; the core
// installs it where an ssh upload would put it (~/<AGENT_DIR>/<version>),
// a TypeScript build's executable from the core's own copy, checked by its
// digest.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { NodeOp, VERSION, newer, readLine, writeLine, type NodeHello, type NodeInfo, type Reply } from '#shared/proto/agentproto/index.ts';
import { AGENT_DIR, CORE_BIN } from '#shared/lib/brand.ts';
import { dirsFor, makeDirs } from '#shared/host/hostdirs.ts';
import { withoutForeignRuntimeVars } from '#shared/lib/bunenv.ts';
import type { Logger } from '#shared/lib/log.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { pairDuplex } from '#shared/proto/yamux.ts';
import { CLIENT_ID, Session } from './session.ts';
import { nodeBuild, type BuildSource, type MachineBuild } from './builds.ts';

/** The agent runs on Linux and macOS; on Windows the core reaches SSH
 * machines only. */
export const LOCAL_SUPPORTED = process.platform === 'linux' || process.platform === 'darwin';

/** How long a client waits for a node it started. */
export let nodeStartWaitMs = 15_000;
/** A node's log moves to node.old.log at this size when a node starts. */
const NODE_LOG_MAX = 1 << 20;

/** This platform as machine builds are named (GOOS/GOARCH). */
export function localPlatform(): { os: string; arch: string } {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return { os: process.platform, arch };
}

const nodeSocket = (run: string) => join(run, 'node.sock');

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Writes b into path (mode 0700) through a temporary file, after checking
 * its SHA-256 when digest is given. */
function place(path: string, b: Uint8Array, digest?: string): void {
  if (digest !== undefined && sha256(b) !== digest) throw new Error(`${path}: sha256 does not match ${digest}`);
  const tmp = `${path}.upload.${process.pid}`;
  try {
    writeFileSync(tmp, b, { mode: 0o700 });
    chmodSync(tmp, 0o700);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Installs a build where an upload would put it, unless it is there; the
 * file to run. A TypeScript build's executable comes from the core's
 * sources (its own copy, for its own platform), checked by its digest. */
export async function installBuild(b: MachineBuild, home: string, signal?: AbortSignal): Promise<string> {
  const dir = join(home, AGENT_DIR, b.version);
  const exe = join(dir, CORE_BIN);
  if (existsSync(exe)) return exe;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (b.kind === 'go') place(exe, b.bin);
  else place(exe, gunzipSync(await b.load(signal)), b.digest);
  return exe;
}

/** Installs the machine build for this platform where an upload would put
 * it, unless it is there; its path and build. */
export async function installLocal(builds: BuildSource, home: string, signal?: AbortSignal): Promise<{ exe: string; info: NodeInfo }> {
  const { os, arch } = localPlatform();
  const b = await builds({ os, arch, ...(os === 'linux' ? { libc: 'glibc' as const } : {}) });
  const exe = await installBuild(b, home, signal);
  const file = exe;
  return {
    exe,
    info: {
      build: nodeBuild(b),
      version: VERSION,
      // Unix nanoseconds, as the nodes write them (precise to about 256 ns
      // as a double: enough to order two builds).
      exe_time: Number(statSync(file, { bigint: true }).mtimeNs),
      pid: process.pid,
    },
  };
}

/** Says hello on the node's socket; the connection and the node's build. */
function dialNodeSocket(sock: string, hello: NodeHello): Promise<{ conn: Socket; node?: NodeInfo }> {
  return new Promise((resolve, reject) => {
    const c = connect(sock);
    const timer = setTimeout(() => c.destroy(new Error('node: no answer')), 10_000);
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
        // The session's first bytes (a keepalive) may have come with the
        // reply: they are read from what the Reader hands on.
        const rest = r.release();
        c.removeAllListeners('error');
        resolve({ conn: rest === c ? c : (pairDuplex(rest, c) as Socket), node: rep.node });
      } catch (e) {
        clearTimeout(timer);
        c.destroy();
        reject(e);
      }
    });
  });
}

/** Starts a node of the installed build in a session of its own, its output
 * in the host directory's node.log. */
function startNode(exe: string, instance: string, hostDir: string, takeover: boolean): void {
  const log = join(hostDir, 'node.log');
  try {
    if (statSync(log).size > NODE_LOG_MAX) renameSync(log, join(hostDir, 'node.old.log'));
  } catch {
    // no log yet
  }
  const fd = openSync(log, 'a', 0o600);
  try {
    const args = ['node', '--instance', instance, ...(takeover ? ['--takeover'] : [])];
    // Nothing that would make the executable run other code (bunenv.ts).
    const p = spawn(exe, args, { detached: true, stdio: ['ignore', fd, fd], env: withoutForeignRuntimeVars(process.env) });
    p.on('error', () => {});
    p.unref();
  } finally {
    closeSync(fd);
  }
}

/** Connects to the local machine's node of this build, starting it when
 * none answers, or taking over from an older one. */
export async function dialNode(opts: {
  instance: string;
  builds: BuildSource;
  sshConnection?: string;
  logger: Logger;
  signal?: AbortSignal;
}): Promise<Session> {
  if (!LOCAL_SUPPORTED) throw new Error('the local machine needs Linux or macOS');
  const dirs = dirsFor(opts.instance);
  makeDirs(dirs);
  const { exe, info: me } = await installLocal(opts.builds, dirs.home, opts.signal);
  const sock = nodeSocket(dirs.run);
  const hello: NodeHello = {
    op: NodeOp.Serve,
    node: me,
    client: CLIENT_ID,
    ...(opts.sshConnection ? { ssh_connection: opts.sshConnection } : {}),
  };
  // usable: this build's node, or a newer one.
  const usable = (n?: NodeInfo) => !!n && (n.build === me.build || !newer(me, n));
  const session = (c: Socket) => new Session(c, () => c.destroy());

  let first: { conn: Socket; node?: NodeInfo } | null = null;
  try {
    first = await dialNodeSocket(sock, hello);
  } catch {
    // none answers
  }
  if (first && usable(first.node)) return session(first.conn);
  if (first) {
    first.conn.destroy();
    if (first.node) opts.logger(`node: build ${me.build} (${me.version}) takes over from ${first.node.build} (${first.node.version})`);
  }
  startNode(exe, opts.instance, dirs.host, first !== null);

  const deadline = Date.now() + nodeStartWaitMs;
  let lastErr: unknown;
  for (;;) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    try {
      const c = await dialNodeSocket(sock, hello);
      if (usable(c.node)) return session(c.conn);
      c.conn.destroy(); // the old node, still giving way
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) {
      // The node that would not give way still serves.
      try {
        return session((await dialNodeSocket(sock, hello)).conn);
      } catch (e) {
        throw new Error(`no node answers on ${sock}; see ${join(dirs.host, 'node.log')}: ${(e as Error).message ?? lastErr}`);
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
