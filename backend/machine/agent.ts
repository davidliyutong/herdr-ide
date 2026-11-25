// The agent of an instance on a machine: what the sessions of a node share
// (its terminal core, its sockets, its features' machine sides), each
// session serving the streams of one core over yamux (serve). A node
// (node.ts) runs one agent and hands it every client that connects.
import { hostname, userInfo } from 'node:os';
import { posix } from 'node:path';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Dirs } from '#shared/host/hostdirs.ts';
import { Fail } from '#shared/lib/fail.ts';
import type { Logger } from '#shared/lib/log.ts';
import { Reader } from '#shared/lib/streamio.ts';
import {
  Op,
  VERSION,
  readLine,
  writeLine,
  yamuxConfig,
  type Header,
  type Info,
  type NodeInfo,
  type Reply,
} from '#shared/proto/agentproto/index.ts';
import { Session as Yamux, closeStream, type Stream } from '#shared/proto/yamux.ts';
import { servePlugin, type Running } from './dispatch.ts';
import { cleanEnv } from './env.ts';
import type { ActionContext, MachineEnv, MachineSession, MachineSide, OpHandler } from './feature.ts';
import { FS_CALLS, serveArchive, serveFS, type FsCalls } from './fsops.ts';
import { TerminalCore } from './hc.ts';
import { serveHC, pipeUnix } from './hcop.ts';
import { killHidden, runHidden } from './hidden.ts';
import { housekeep } from './housekeeping.ts';
import { privacyStatus } from './privacy.ts';
import { serveVault } from './vault.ts';
import type { Conn } from './stream.ts';

/** How long a stream's header may take. */
const HEADER_MS = 30_000;
/** How long a session that ended waits for its requests, and the agent's
 * close for what it runs. */
export const DRAIN_MS = 5000;

/** The ops of features, refused as an unknown plugin is when no feature of
 * the agent serves them (the build does not, or a test's agent has not
 * the feature). */
const FEATURE_OPS = new Map<string, string>([
  [Op.CodeServer, 'vscode'],
  [Op.GUI, 'gui'],
  [Op.Detect, 'agents'],
]);

/** The refusal of a feature this build does not serve. */
export const unknownPlugin = (id: string): Reply => ({
  ok: false,
  code: 'unknown_plugin',
  error: `unknown_plugin: unknown plugin ${JSON.stringify(id)}`,
});

/** One core's session of the agent. */
export class AgentSession implements MachineSession {
  readonly id: number;
  /** Names the core (its process), the same for its sessions after
   * reconnects. */
  readonly client: string;
  /** SSH_CONNECTION of the ssh session the core came through; "" for the
   * local machine. */
  readonly sshConn: string;
  readonly ys: Yamux;
  /** Its pipes to unix sockets (dial-unix), by path. */
  private readonly pipes = new Map<string, { open: number; last: number }>();

  constructor(id: number, ys: Yamux, client: string, sshConn: string) {
    this.id = id;
    this.ys = ys;
    this.client = client;
    this.sshConn = sshConn;
  }

  get live(): boolean {
    return !this.ys.closed;
  }

  dialed(path: string): { open: number; last: number } {
    const p = this.pipes.get(path);
    return p ? { ...p } : { open: 0, last: 0 };
  }

  /** Counts a pipe to path opened; the function returned counts it closed. */
  piped(path: string): () => void {
    const p = this.pipes.get(path) ?? { open: 0, last: 0 };
    p.open++;
    p.last = performance.now();
    this.pipes.set(path, p);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      p.open--;
    };
  }

  /** Opens a stream towards the core with header h and reads its reply
   * within timeoutMs; the stream and its reader after the reply. */
  async ask(h: Header, timeoutMs: number, signal?: AbortSignal): Promise<{ conn: Conn; reply: Reply }> {
    const stream = await this.ys.open();
    const reader = new Reader(stream);
    const kill = () => stream.destroy(new Error('no answer'));
    const t = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    try {
      await writeLine(stream, h);
      return { conn: { stream, reader }, reply: await readLine<Reply>(reader) };
    } catch (e) {
      stream.destroy();
      throw e;
    } finally {
      clearTimeout(t);
      signal?.removeEventListener('abort', kill);
    }
  }
}

export interface AgentOptions {
  instance: string;
  dirs: Dirs;
  logger: Logger;
  /** The machine sides of the features this build serves. */
  features: MachineSide[];
  /** How often the agent applies its retention rules. */
  housekeepMs?: number;
  /** How often its sockets are checked (sockets.ts). */
  socketWatchMs?: number;
  /** The file system calls of the fs ops (tests replace them). */
  fs?: Partial<FsCalls>;
  /** Reads a connection's peer credentials (tests give another). */
  peerCred?: (c: Socket) => { pid: number; uid: number };
  /** The herdr-core this build carries (tests give one). */
  carryHC?: () => { gz: Buffer; digest: string } | null;
}

export class Agent {
  readonly instance: string;
  readonly dirs: Dirs;
  readonly logger: Logger;
  readonly hc: TerminalCore;
  private readonly features = new Map<string, Running>();
  /** The ops features serve (Served.ops). */
  private readonly ops = new Map<string, OpHandler>();
  private readonly stop = new AbortController();
  private readonly running = new Set<Promise<unknown>>();
  private readonly sessions = new Set<AgentSession>();
  private seq = 0;
  private privacyOp: Promise<unknown> = Promise.resolve();
  private readonly fs: FsCalls;

  constructor(o: AgentOptions) {
    this.instance = o.instance;
    this.dirs = o.dirs;
    this.logger = o.logger;
    this.hc = new TerminalCore(o.instance, o.dirs, o.carryHC);
    this.fs = { ...FS_CALLS, ...o.fs };
    const env = this.env();
    for (const side of o.features) {
      const served = side.start(env);
      this.features.set(side.protocol.id, { protocol: side.protocol, served });
      for (const [op, handler] of Object.entries(served.ops ?? {})) this.ops.set(op, handler);
    }
    const signal = this.stop.signal;
    this.spawn(
      housekeep({
        base: o.dirs.base,
        host: o.dirs.host,
        logger: o.logger,
        signal,
        everyMs: o.housekeepMs,
        extra: [...this.features.values()].flatMap((f) => (f.served.housekeep ? [f.served.housekeep.bind(f.served)] : [])),
      }),
    );
    this.spawn(serveVault(this, { signal, everyMs: o.socketWatchMs, peerCred: o.peerCred }));
  }

  private spawn(p: Promise<unknown>): void {
    const q = p.catch((e) => this.logger(`agent: ${(e as Error).message}`)).finally(() => this.running.delete(q));
    this.running.add(q);
  }

  /** Ends what the agent runs, waiting at most DRAIN_MS, then what its
   * features own (Served.close). */
  async close(): Promise<void> {
    this.stop.abort();
    for (const s of this.sessions) s.ys.close();
    await Promise.race([Promise.allSettled([...this.running]), new Promise((r) => setTimeout(r, DRAIN_MS))]);
    for (const [id, f] of this.features)
      try {
        await f.served.close?.();
      } catch (e) {
        this.logger(`${id}: close: ${(e as Error).message}`);
      }
  }

  get signal(): AbortSignal {
    return this.stop.signal;
  }

  /** p with "~" resolved and made absolute relative to the home directory. */
  expand(p: string): string {
    if (!p || p.includes('\0')) throw new Fail('bad_params', 400, 'empty path');
    const home = this.dirs.home;
    if (p === '~') return home;
    if (p.startsWith('~/')) return posix.join(home, p.slice(2));
    if (!p.startsWith('/')) return posix.join(home, p);
    return posix.normalize(p).replace(/(.)\/+$/, '$1');
  }

  /** What the machine sides of features get. */
  env(): MachineEnv {
    const hidden = (signal?: AbortSignal) => ({
      sock: this.hc.socket,
      home: this.dirs.home,
      environ: cleanEnv(),
      logger: this.logger,
      signal,
    });
    return {
      instance: this.instance,
      home: this.dirs.home,
      base: this.dirs.base,
      host: this.dirs.host,
      run: this.dirs.run,
      logger: this.logger,
      expand: (p) => this.expand(p),
      environ: () => cleanEnv(),
      hcSocket: this.hc.socket,
      runHidden: (name, argv, signal) => runHidden(name, argv, hidden(signal)),
      killHidden: (name, argv, kill, signal) => killHidden(name, argv, kill, hidden(signal)),
      sessions: () => this.liveSessions(),
      signal: this.stop.signal,
    };
  }

  info(): Info {
    let user = process.env.USER ?? '';
    try {
      user = userInfo().username || user;
    } catch {
      // as the environment says
    }
    return {
      version: VERSION,
      os: process.platform,
      arch: process.arch === 'x64' ? 'amd64' : process.arch,
      hostname: hostname(),
      home: this.dirs.home,
      user,
      data_dir: this.dirs.base,
      run_dir: this.dirs.run,
      upload_dir: posix.join(this.dirs.base, 'uploads'),
    };
  }

  /** The live sessions, oldest first. */
  liveSessions(): AgentSession[] {
    return [...this.sessions].filter((s) => s.live).sort((a, b) => a.id - b.id);
  }

  /** Serves one core's session over conn until it ends: the core's process
   * is client ("" when unknown), and it came through the ssh session
   * sshConn ("" for the local machine). */
  async serve(conn: Duplex, client: string, sshConn: string): Promise<void> {
    const ys = new Yamux(conn, false, yamuxConfig);
    const s = new AgentSession(++this.seq, ys, client, sshConn);
    this.sessions.add(s);
    const ended = new AbortController();
    const onStop = () => ys.close();
    this.stop.signal.addEventListener('abort', onStop, { once: true });
    const requests = new Set<Promise<void>>();
    try {
      for (;;) {
        let st: Stream;
        try {
          st = await ys.accept();
        } catch {
          break;
        }
        const p = this.handle(s, st, ended.signal).catch((e) => this.logger(`stream: ${(e as Error).message}`));
        requests.add(p);
        void p.finally(() => requests.delete(p));
      }
    } finally {
      // The requests still running fail with their streams; they are waited
      // for, so that what they staged is gone.
      ended.abort();
      ys.close();
      this.stop.signal.removeEventListener('abort', onStop);
      await Promise.race([Promise.allSettled([...requests]), new Promise((r) => setTimeout(r, DRAIN_MS))]);
      this.sessions.delete(s);
    }
  }

  /** Tells the cores of the agent's sessions that the node next serves the
   * instance now (op node.drain), after giving it what the features run
   * for the instance (Served.handOver). */
  drain(next?: NodeInfo): void {
    if (next)
      for (const [id, f] of this.features)
        try {
          f.served.handOver?.(next);
        } catch (e) {
          this.logger(`${id}: hand over: ${(e as Error).message}`);
        }
    for (const s of this.liveSessions())
      void s
        .ask({ op: Op.NodeDrain }, 15_000)
        .then(({ conn }) => closeStream(conn.stream))
        .catch(() => {});
  }

  private ctx(s: AgentSession, signal: AbortSignal): ActionContext {
    const { signal: _, ...env } = this.env();
    return { ...env, client: s.client, session: s, signal };
  }

  private async handle(s: AgentSession, stream: Stream, ended: AbortSignal): Promise<void> {
    const reader = new Reader(stream);
    const conn: Conn = { stream, reader };
    const t = setTimeout(() => stream.destroy(new Error('no header in time')), HEADER_MS);
    let h: Header;
    try {
      h = await readLine<Header>(reader);
    } catch {
      closeStream(stream);
      return;
    } finally {
      clearTimeout(t);
    }
    const signal = AbortSignal.any([ended, this.stop.signal]);
    const fail = (e: unknown) => writeLine(stream, { ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Reply);
    let close = true;
    try {
      switch (h.op) {
        case Op.Hello:
          await writeLine(stream, { ok: true, info: this.info(), ...(s.sshConn ? { ssh: s.sshConn } : {}) } satisfies Reply);
          break;
        case Op.FsStat:
        case Op.FsList:
        case Op.FsRead:
        case Op.FsWrite: {
          let path: string;
          try {
            path = this.expand(h.path ?? '');
          } catch (e) {
            await fail(e);
            break;
          }
          await serveFS(conn, h, path, this.fs);
          break;
        }
        case Op.FsArchive:
          await serveArchive(conn, h, (p) => this.expand(p));
          break;
        case Op.DialUnix:
          close = false;
          await this.dialUnix(s, conn, h);
          break;
        case Op.HC:
          await serveHC(conn, h, this.hc, signal);
          break;
        case Op.HCAPI:
          close = false;
          await pipeUnix(conn, this.hc.socket);
          break;
        case Op.Privacy: {
          const run = () => privacyStatus(this.dirs.home, this.hc, signal);
          const p = this.privacyOp.then(run, run);
          this.privacyOp = p.catch(() => {});
          await writeLine(stream, { ok: true, privacy: await p } satisfies Reply);
          break;
        }
        case Op.Plugin:
          close = false;
          await servePlugin(conn, h, this.features, (sig) => this.ctx(s, sig), signal, this.logger);
          break;
        default: {
          const op = this.ops.get(h.op);
          if (op) await op(conn, h, this.ctx(s, signal));
          else if (FEATURE_OPS.has(h.op)) await writeLine(stream, unknownPlugin(FEATURE_OPS.get(h.op)!));
          else await fail(`unknown op ${JSON.stringify(h.op)}`);
        }
      }
    } catch (e) {
      if (!closedErr(e)) this.logger(`op ${h.op}: ${(e as Error).message}`);
    } finally {
      if (close) {
        reader.release();
        closeStream(stream);
      }
    }
  }

  /** dial-unix: pipes a socket below the run directory (a bare name is one
   * in it), counted for the session while it lasts (MachineSession.dialed:
   * VS Code's code-server is kept for the sessions that show it, and its
   * bridge leads to the one that opened it last). */
  private async dialUnix(s: AgentSession, conn: Conn, h: Header): Promise<void> {
    let path = h.path ?? '';
    try {
      if (path !== '' && !path.includes('/')) path = posix.join(this.dirs.run, path);
      path = this.expand(path);
      const rel = posix.relative(this.dirs.run, path);
      if (rel.startsWith('..') || posix.isAbsolute(rel)) throw new Error(`dial-unix: ${path} is outside ${this.dirs.run}`);
    } catch (e) {
      await writeLine(conn.stream, { ok: false, error: (e as Error).message } satisfies Reply).catch(() => {});
      closeStream(conn.stream);
      return;
    }
    await pipeUnix(conn, path, () => s.piped(path));
  }
}

/** Whether e is a stream that went away. */
export function closedErr(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string })?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ESTREAMCLOSED' ||
    code === 'ESESSIONSHUTDOWN' ||
    m === 'stream closed' ||
    m.includes('EOF') ||
    m.includes('broken pipe')
  );
}
