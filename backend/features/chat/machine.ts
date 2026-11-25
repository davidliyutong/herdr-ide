// The chat feature's machine side (docs/features/37-agent-chats.md): the
// relay between the core and this machine's chat host (machine/host/), which
// runs coding agents headless and keeps their conversations. Its one action:
//
//   - open {start?}: a connection to the chat host's socket (<run
//     dir>/chat.sock) for the core. After the reply the stream carries the
//     host's bytes both ways, the host's hello first, until either side
//     closes; one open is one connection to the host.
//
// The host is no child of the agent: when no host serves the socket, the
// agent has the instance's terminal core run one, this build's own
// executable, as a terminal no client shows (MachineEnv.runHidden). It then
// lives as the user's terminals do, while agents, ssh sessions and cores
// come and go, and ends by itself when it has had nothing to do for a
// while, when the terminal core stops, or when the agent of a newer build
// asks it to make way (never one of an older build: two cores of different
// builds that reach one machine do not take turns). A host's terminal that
// holds the host's name while nothing serves the socket for longer than a
// host takes to end is stuck: the agent has the terminal core kill it
// (MachineEnv.killHidden) and starts another. Nothing listens on the
// machine for the core: the core opens a stream per connection.
import { connect, type Socket } from 'node:net';
import { posix } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import { Reader, write } from '#shared/lib/streamio.ts';
import { CHAT_HOST_NAME, VERSION, olderVersion } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { ChunkReader, writeLine } from '#shared/proto/agentproto/index.ts';
import { defineMachine, type ActionStream } from '#machine/feature.ts';
import { selfCommand } from '#machine/self.ts';
import type { NpmTarball } from './claudesdk.ts';
import { SdkStore } from './machine/sdkstore.ts';
import { NOT_RUNNING, chatProtocol } from './protocol.ts';

/** The codes of an open that made no connection. */
export const OpenCode = {
  /** No chat host serves, and the open was not to start one. */
  NotRunning: NOT_RUNNING,
  /** The instance's terminal core does not run, and the chat host runs as
   * one of its terminals. */
  NoTerminalCore: 'no_terminal_core',
  /** The chat host did not start, or did not serve in time. */
  StartFailed: 'start_failed',
  /** A chat host of another build serves, speaks another protocol than
   * this agent, and does not make way while a chat works or waits; a later
   * open finds this build's host. */
  Upgrading: 'upgrading',
} as const;

/** The times of open, which tests shorten. */
export interface ChatMachineTiming {
  /** How long a host has to serve once the terminal core was asked to run
   * it, and how often its socket is tried. */
  startMs: number;
  pollMs: number;
  /** How long after the terminal core was asked it is asked again, each
   * time twice as long up to askMaxMs: the host's name may still be that of
   * a host that ends, and the terminal core then starts nothing. */
  askAgainMs: number;
  askMaxMs: number;
  /** How long a host takes to end at the most: an old host that makes way
   * is waited for this long, and a name taken this long past startMs while
   * nothing serves is a stuck host's. */
  stopGraceMs: number;
  /** How often an old host's process is looked for. */
  goneMs: number;
  /** How long the socket has to take a connection, and a host to say who
   * it is. */
  dialMs: number;
  helloMs: number;
  /** How long a host has to answer that it ends. */
  shutdownMs: number;
}

export const CHAT_MACHINE_TIMING: ChatMachineTiming = {
  startMs: 15_000,
  pollMs: 100,
  askAgainMs: 500,
  askMaxMs: 2000,
  stopGraceMs: chat.STOP_GRACE_MS,
  goneMs: 50,
  dialMs: 1000,
  helloMs: 5000,
  shutdownMs: 10_000,
};

/** The longest first line taken from a host. */
const MAX_HELLO = 64 << 10;

export interface ChatMachineOptions {
  timing?: Partial<ChatMachineTiming>;
  /** The command that runs this build (selfCommand): the host is its
   * chat-host command. */
  command?: () => string[];
  /** This build's version (VERSION). */
  version?: string;
  /** The Agent SDK's pinned tarball (tests pin their own), and how long the
   * machine's download of it may take. */
  sdkPin?: NpmTarball;
  sdkDownloadMs?: number;
}

/** A connection to a chat host that said who it is. */
interface HostConn {
  sock: Socket;
  /** What came after the hello (the rest of the socket's stream). */
  reader: Reader;
  /** The host's first line with its newline, as it came. */
  hello: Buffer;
  info: chat.HostInfo;
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

/** Connects to the chat host on sock and reads its first line. */
function dial(path: string, t: ChatMachineTiming): Promise<HostConn> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    sock.on('error', () => {});
    let done = false;
    const fail = (e: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    };
    let timer = setTimeout(() => fail(new Error('the socket took no connection in time')), t.dialMs);
    sock.once('error', fail);
    sock.once('connect', () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error("the chat host's first line did not come in time")), t.helloMs);
      const reader = new Reader(sock);
      reader.line(MAX_HELLO).then(
        (line) => {
          if (done) return;
          let hello: { host?: { proto?: unknown; version?: unknown; pid?: unknown } } | null = null;
          try {
            hello = JSON.parse(line);
          } catch {
            hello = null;
          }
          const h = hello?.host;
          if (!h || typeof h.proto !== 'number' || h.proto < 1)
            return fail(new Error(`the chat host's first line is no hello: ${JSON.stringify(line.slice(0, 120))}`));
          done = true;
          clearTimeout(timer);
          sock.off('error', fail);
          resolve({
            sock,
            reader,
            hello: Buffer.from(line + '\n', 'utf8'),
            info: { proto: h.proto, version: typeof h.version === 'string' ? h.version : '', pid: typeof h.pid === 'number' ? h.pid : 0 },
          });
        },
        (e: Error) => fail(new Error(`the chat host's first line: ${e.message}`)),
      );
    });
  });
}

function upgrading(info: chat.HostInfo): Fail {
  return new Fail(
    OpenCode.Upgrading,
    503,
    `the chat host (version ${info.version}, pid ${info.pid}) speaks protocol ${info.proto}, this agent ${chat.PROTO}, and a chat keeps it running`,
  );
}

/** Asks the host on path to end, on a connection of its own; whether it
 * does: a host with a chat that works or waits answers that it is busy. */
async function shutdown(path: string, t: ChatMachineTiming): Promise<boolean> {
  let h: HostConn;
  try {
    h = await dial(path, t);
  } catch {
    return false;
  }
  const timer = setTimeout(() => h.sock.destroy(), t.shutdownMs);
  try {
    await write(h.sock, chat.line({ op: chat.Op.Shutdown }));
    const res = JSON.parse((await chat.readLine(h.reader)).toString('utf8')) as chat.Response;
    return res.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    h.sock.destroy();
  }
}

/** Waits until process pid is no more, for at most ms; whether it is gone.
 * A pid that is not a process of the user's is none of a host's. */
async function gone(pid: number, ms: number, t: ChatMachineTiming, signal: AbortSignal): Promise<boolean> {
  if (pid <= 1) return true;
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline || signal.aborted) return false;
    await sleep(t.goneMs, signal);
  }
}

/** Copies both ways between the core's stream (after the reply) and the
 * host's connection, and closes both once either side ends. */
function relay(s: ActionStream, h: HostConn, signal: AbortSignal): Promise<void> {
  const st = s.stream;
  const fromCore = s.reader.release();
  const fromHost = h.reader.release();
  return new Promise((resolve) => {
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', end);
      fromCore.unpipe(h.sock);
      fromHost.unpipe(st);
      h.sock.destroy();
      closeStream(st);
      resolve();
    };
    signal.addEventListener('abort', end, { once: true });
    h.sock.on('error', end).on('end', end).on('close', end);
    fromHost.on('error', end).on('end', end);
    fromCore.on('error', end).on('end', end);
    st.on('close', end);
    fromCore.pipe(h.sock, { end: false });
    fromHost.pipe(st, { end: false });
    if (signal.aborted) end();
  });
}

export function chatMachine(o: ChatMachineOptions = {}) {
  const t: ChatMachineTiming = { ...CHAT_MACHINE_TIMING, ...o.timing };
  const version = () => o.version ?? VERSION;
  return defineMachine(chatProtocol, (env) => {
    const path = posix.join(env.run, chat.SOCKET_NAME);
    // Anthropic's Agent SDK in the instance's data directory, which this
    // build's chat host loads for Claude Code's chats.
    const sdk = new SdkStore({ base: env.base, logger: env.logger, pin: o.sdkPin, downloadMs: o.sdkDownloadMs });
    // Held while a host is started or replaced: the streams the core opens
    // at the same time find the host the first of them started, instead
    // of each asking the terminal core for one. One start at a time.
    let connecting: Promise<unknown> = Promise.resolve();

    /** A connection to the chat host that serves, of any build that speaks
     * this agent's protocol; starts none. */
    async function serving(): Promise<HostConn> {
      let h: HostConn;
      try {
        h = await dial(path, t);
      } catch {
        throw new Fail(OpenCode.NotRunning, 404, 'no chat host serves');
      }
      if (h.info.proto !== chat.PROTO) {
        h.sock.destroy();
        throw upgrading(h.info);
      }
      return h;
    }

    /** A connection to the machine's chat host, which it starts when none
     * serves. A host of an older build than this agent's is asked to make
     * way, which it does when no chat works or waits: once its process is
     * gone, a host of this build takes its place. A host that does not make
     * way, and one of a newer build or of a build whose age is not known (a
     * development build), is used as it is while it speaks this agent's
     * protocol; otherwise upgrading. */
    async function connectHost(signal: AbortSignal): Promise<HostConn> {
      const v = version();
      try {
        const h = await dial(path, t);
        if (h.info.version === v || (!olderVersion(h.info.version, v) && h.info.proto === chat.PROTO)) return h;
        h.sock.destroy();
      } catch {
        // none serves: one is started
      }
      const turn = connecting.then(() => connectTurn(signal, v));
      connecting = turn.catch(() => {});
      return turn;
    }

    async function connectTurn(signal: AbortSignal, v: string): Promise<HostConn> {
      let h: HostConn;
      try {
        h = await dial(path, t);
      } catch {
        return start(signal, 0);
      }
      if (h.info.version === v) return h;
      if (!olderVersion(h.info.version, v)) {
        // Never a downgrade, nor a guess.
        if (h.info.proto !== chat.PROTO) {
          h.sock.destroy();
          throw upgrading(h.info);
        }
        return h;
      }
      // An older build's host. Its connection is not kept while it is
      // asked: a host closes a connection that sends no request in time.
      h.sock.destroy();
      if (await shutdown(path, t)) {
        env.logger(`chat: the host of version ${h.info.version} (pid ${h.info.pid}) ends for one of version ${v}`);
        if (!(await gone(h.info.pid, t.stopGraceMs, t, signal)))
          env.logger(`chat: the host of pid ${h.info.pid} did not end within ${t.stopGraceMs / 1000} s`);
        return start(signal, h.info.pid);
      }
      if (h.info.proto !== chat.PROTO) throw upgrading(h.info);
      let again: HostConn;
      try {
        again = await dial(path, t);
      } catch {
        // It ended meanwhile.
        return start(signal, 0);
      }
      if (again.info.proto !== chat.PROTO) {
        again.sock.destroy();
        throw upgrading(again.info);
      }
      return again;
    }

    /** Has the terminal core run a chat host of this build and returns a
     * connection to it once it serves: once a host says hello that is not
     * the one of pid old, which made way and may still answer while it
     * ends. A name that stays taken past startMs while nothing serves is
     * waited for until a host that ends would have ended (stopGraceMs);
     * then the terminal that holds it is killed (killHidden), and the
     * terminal core asked again. */
    async function start(signal: AbortSignal, old: number): Promise<HostConn> {
      const argv = [...(o.command ?? selfCommand)(), 'chat-host', '--base', env.base, '--run', env.run];
      const began = Date.now();
      let deadline = began + t.startMs;
      let ask = Date.now();
      let wait = t.askAgainMs;
      let phase: 'starting' | 'held' | 'killed' = 'starting';
      for (;;) {
        if (Date.now() >= ask) {
          try {
            await env.runHidden(CHAT_HOST_NAME, argv, signal);
          } catch (e) {
            if (e instanceof Fail && e.code === OpenCode.NoTerminalCore) throw e;
            throw new Fail(OpenCode.StartFailed, 500, (e as Error).message);
          }
          ask = Date.now() + wait;
          wait = Math.min(2 * wait, t.askMaxMs);
        }
        let last: Error | null = null;
        try {
          const h = await dial(path, t);
          // The host that made way, still ending.
          if (old > 0 && h.info.pid === old) h.sock.destroy();
          else {
            // Another agent (of another build) may have started it.
            if (h.info.proto !== chat.PROTO) {
              h.sock.destroy();
              throw upgrading(h.info);
            }
            return h;
          }
        } catch (e) {
          if (e instanceof Fail) throw e;
          last = e as Error;
        }
        if (Date.now() >= deadline) {
          let next = 0;
          if (phase === 'starting') {
            try {
              if (await env.killHidden(CHAT_HOST_NAME, argv, false, signal)) {
                phase = 'held';
                next = began + t.startMs + t.stopGraceMs - Date.now();
              }
            } catch {
              // not the host's: nothing to wait for
            }
          } else if (phase === 'held') {
            let ok = false;
            let failed: Error | null = null;
            try {
              ok = await env.killHidden(CHAT_HOST_NAME, argv, true, signal);
            } catch (e) {
              failed = e as Error;
            }
            if (ok)
              env.logger(
                `chat: the host's terminal held its name and served nothing for ${Math.round((Date.now() - began) / 1000)} s: killed`,
              );
            else if (failed) env.logger(`chat: a stuck host's terminal: ${failed.message}`);
            if (ok || !failed) {
              // The name is free: once more.
              phase = 'killed';
              next = t.startMs;
              ask = Date.now();
              wait = t.askAgainMs;
            }
          }
          if (next <= 0) {
            env.logger(`chat: the host does not serve ${path}: ${last?.message ?? 'no answer'}`);
            throw new Fail(OpenCode.StartFailed, 500, `the chat host did not serve within ${Math.round((Date.now() - began) / 1000)} s`);
          }
          deadline = Date.now() + next;
        }
        if (signal.aborted) throw new Fail(OpenCode.StartFailed, 500, 'the agent stops');
        await sleep(t.pollMs, signal);
      }
    }

    return {
      actions: {
        // Makes sure a chat host serves (with start, else it takes one that
        // serves), answers, and then carries bytes both ways between the
        // stream and a connection to the host until either side ends: the
        // host's first line, which says who it is, comes first, as the host
        // wrote it.
        open: async (p, ctx, s) => {
          const h = p.start === false ? await serving() : await connectHost(ctx.signal);
          try {
            await s.reply();
            await write(s.stream, h.hello);
          } catch {
            h.sock.destroy();
            closeStream(s.stream);
            return;
          }
          await relay(s, h, ctx.signal);
        },
        // Whether the Agent SDK is installed; with url, the machine's own
        // download of it, checked as an upload is (fetched when it was).
        sdk: async (p, ctx) => {
          if (await sdk.installed()) return { installed: true };
          if (!p.url) return { installed: false };
          try {
            return (await sdk.fetch(p.url, { env: ctx.environ(), signal: ctx.signal }))
              ? { installed: true, fetched: true }
              : { installed: true };
          } catch (e) {
            if (e instanceof Fail) throw e;
            return { installed: false, error: (e as Error).message };
          }
        },
        // The tarball in chunks after the reply, installed, then a second
        // line. An upload that failed before its end is read on and dropped,
        // so that the core, which reads that line after its last chunk, gets
        // it.
        sdkUpload: async (_p, _ctx, s) => {
          await s.reply();
          let out: { ok: boolean; error?: string } = { ok: true };
          try {
            await sdk.receive(new ChunkReader(s.reader));
          } catch (e) {
            out = { ok: false, error: (e as Error).message };
            s.reader.release().resume();
          }
          await writeLine(s.stream, out);
        },
      },
      // A version of the Agent SDK unused for 14 days goes.
      housekeep: (now) => sdk.prune(now),
    };
  });
}
