// The chat host: the long-lived process of a machine that runs coding
// agents headless, each through its adapter (../adapter.ts), keeps what
// their conversations did in its journal (journal.ts) and serves them on a
// unix socket in the protocol of #shared/proto/chatproto
// (docs/features/37-agent-chats.md).
//
// One host serves an instance of a machine: the socket SOCKET_NAME in the
// instance's run directory, taken under a lock of that directory, a socket
// nobody answers on replaced. It runs as a hidden terminal of the
// instance's terminal core, so neither ssh nor the machine's agent going
// away ends it. It ends when it is told to (Op.Shutdown, for a host of
// another version to take over, refused while an agent works or waits), on
// a signal of the terminal core (SIGHUP, then SIGTERM, then SIGKILL), or
// when it has had no agent process and no connection for a minute; the
// chats stay in the journal, and their agents resume their sessions by id
// at the next prompt. A host that has not ended STOP_GRACE_MS after it
// began to stop kills its agents' groups and exits (HostOptions.exit).
//
// Full access (HostSettings.allowFull) is off until a configure of the
// host's own process allows it; once it is off, a chat whose agent runs
// with it starts its agent again in the default mode, and an agent that
// takes it by itself is set back. A session another process runs (a
// terminal's, Adapter.inTerminal) is neither resumed nor imported.
//
// What runs is the machine's to decide: requests name agent kinds, whose
// chat spec gives the command, looked up in the PATH of the user's login
// shell, and the agents get that shell's environment without the variables
// of the host's terminal, of ssh and of the agents' own sessions. Every
// process the host and its adapters start is in AgentProcesses, a process
// group of its own that the host can end.
//
// The journal keeps every stored event of every chat, within the settings'
// bounds: a chat's events beyond maxChatBytes go oldest first; beyond
// maxTotalBytes, maxChats and retentionDays closed chats go, the archived
// ones first, each the one kept the longest first. The agents' own session
// files are never touched.
//
// One thread serves everything: nothing the host waits for (a journal's
// write, an agent's answer, the login shell, a client) holds it.
import { connect, type Server, type Socket } from 'node:net';
import { posix } from 'node:path';
import { Reader } from '#shared/lib/streamio.ts';
import type { Logger } from '#shared/lib/log.ts';
import { Notice, VERSION, noticeMethod } from '#shared/proto/agentproto/index.ts';
import type { ChatSpec } from '#shared/agents/kinds.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { closeQuietly, tryLock } from '#machine/sys/fs.ts';
import { inode, listenUnix } from '#machine/sockets.ts';
import { rmSync, lstatSync, openSync, statSync, constants as fsc } from 'node:fs';
import type { Adapter, Adapters, ClientInfo, Session } from '../adapter.ts';
import { AgentProcesses, signalGroup } from '../agentproc.ts';
import { Chat, SESSION_ID, errorOf, isUserTurn, now, perr, transcriptUuid, turnBoundaryIdx, validOption } from './chat.ts';
import { Environment, agentEnv, isDir, lookPath, userHome, type Env } from './env.ts';
import { AGENT_TITLE_RUNES, clip } from './events.ts';
import { exportMarkdown } from './export.ts';
import { Journal, timeOf, type Row, emptyCapabilities } from './journal.ts';
import { parseCommand, parseRequest, type Request } from './requests.ts';
import { Subscriber, SUBSCRIBER_LIMITS, type SubscriberLimits } from './subscriber.ts';
import { cleanAbs, sameID, trustable } from './trust.ts';

/** The host's times, in ms, which tests shorten. */
export interface HostTiming {
  /** How long the host stays without an agent process and a connection. */
  idleExit: number;
  /** How long an agent has to make its session or list its sessions. */
  startTimeout: number;
  /** How long an agent has to answer a command. */
  callTimeout: number;
  /** How long an adapter has to end its agent gracefully. */
  closeGrace: number;
  /** How long the agents have after SIGTERM on a signal. */
  killAfter: number;
  /** The unit of idleStopMinutes. */
  minute: number;
  /** The unit of retentionDays. */
  day: number;
  /** How often the journal's bounds are checked. */
  enforceEvery: number;
  /** How long changes of a chat its adapter states wait to be told
   * together. */
  infoDelay: number;
  /** How long after it began to stop a host is ended by exit. */
  stopDeadline: number;
  /** How long a connection has to send its request, and to take an answer. */
  requestTimeout: number;
  /** How long the attached connections have to take the end of their chats
   * when the host stops. */
  stopFlush: number;
}

export const HOST_TIMING: HostTiming = {
  idleExit: 60_000,
  startTimeout: 60_000,
  callTimeout: 30_000,
  closeGrace: 10_000,
  killAfter: 300,
  minute: 60_000,
  day: 24 * 3600_000,
  enforceEvery: 3600_000,
  infoDelay: 250,
  stopDeadline: chat.STOP_GRACE_MS,
  requestTimeout: 10_000,
  stopFlush: 2000,
};

/** The connections served at a time. */
const MAX_CONNS = 256;
const MAX_REFUSING = 8;
/** The session listings that may run at a time, and the commands one
 * attached connection may have waiting for an agent. */
const MAX_PROBES = 4;
const MAX_CALLS = 8;
/** The most kinds Op.Agents asks about. */
const MAX_KINDS = 64;
const MAX_CHAT_ENV = 1000;
const MAX_CHAT_ENV_NAME = 128;
const MAX_CHAT_ENV_VALUE = 64 << 10;
const CHAT_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validates optional extra env variables for a new chat; undefined for none,
 * null when invalid. Kept in memory only (never logged or written to disk). */
function validateEnv(raw: Record<string, string> | undefined): Record<string, string> | undefined | null {
  if (!raw) return undefined;
  const entries = Object.entries(raw);
  if (!entries.length) return undefined;
  if (entries.length > MAX_CHAT_ENV) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || k.length > MAX_CHAT_ENV_NAME || !CHAT_ENV_NAME.test(k)) return null;
    if (typeof v !== 'string' || Buffer.byteLength(v) > MAX_CHAT_ENV_VALUE || v.includes('\0')) return null;
    out[k] = v;
  }
  return out;
}
/** How much of a line that is too long is read before the answer that
 * says so, for the answer to reach a client still writing. */
const MAX_DISCARD = 4 * chat.MAX_LINE;
/** How many bytes of events are written between two checks of the
 * journal's bounds; they are checked every enforceEvery besides. */
const ENFORCE_BYTES = 1 << 20;
/** How long a host that starts waits for one that may serve the socket
 * already. */
const DIAL_MS = 1000;

/** Serve's error when another host serves the run directory's socket. */
export class RunningError extends Error {
  constructor(detail = '') {
    super(`chathost: another chat host serves the socket${detail ? `: ${detail}` : ''}`);
    this.name = 'RunningError';
  }
}

export interface HostOptions {
  /** The instance's data directory: the journal is this host's DB_NAME in
   * it. */
  base: string;
  /** The instance's run directory, which exists and is the user's alone
   * (0700): the host serves SOCKET_NAME in it. */
  run: string;
  logger: Logger;
  /** The adapters, by name (hosts/machine/features.ts chatAdapters). */
  adapters: Adapters;
  /** The chat spec of a kind (#shared/agents/kinds.ts chatSpec). */
  spec: (kind: string) => ChatSpec | undefined;
  /** Who the agents are told their client is. */
  client: ClientInfo;
  /** Ends the host gracefully. */
  signal?: AbortSignal;
  /** Subscribes to the signals the terminal core sends to end the host
   * (SIGHUP, SIGTERM, SIGINT): on the first, every agent's process group
   * gets SIGTERM and the adapters end their agents; what is left gets
   * SIGKILL at the next signal, or killAfter later at the latest. Returns
   * the unsubscription. */
  signals?: (on: (sig: string) => void) => () => void;
  /** Ends the process of a host that has not ended stopDeadline after it
   * began to stop (something of it hangs): its children's groups are
   * killed, and exit(1) is called. */
  exit?: (code: number) => void;
  timing?: Partial<HostTiming>;
  /** Replaces the settings, not clamped, until a configure (tests). */
  settings?: chat.HostSettings;
  /** Replaces the login shell that tells the user's environment (tests). */
  environ?: (signal: AbortSignal) => Promise<Env>;
  /** The host's own environment (process.env by default). */
  hostEnv?: Env;
  /** Is told the host once it serves (tests). */
  onHost?: (h: Host) => void;
  subscriberLimits?: SubscriberLimits;
}

/** A chat the bounds may remove, and since when it is kept. */
interface Removable {
  c: Chat;
  archived: boolean;
  since: number;
}

/** Serves a chat host on the socket of o.run until o.signal ends, a client
 * asks it to stop, a signal comes, or it had neither an agent process nor a
 * connection for idleExit. Rejects with RunningError without serving when
 * another host answers on the socket, and replaces a socket nobody listens
 * on. Before it settles, every agent is ended and the socket removed. */
export async function serveHost(o: HostOptions): Promise<void> {
  if (!posix.isAbsolute(o.base) || !posix.isAbsolute(o.run))
    throw new Error('chathost: the data and run directories must be absolute paths');
  const h = new Host(o);
  await h.serve();
}

export class Host {
  readonly o: HostTiming;
  readonly opts: HostOptions;
  readonly logger: Logger;
  readonly procs = new AgentProcesses();
  readonly client: ClientInfo;
  journal!: Journal;
  private readonly environment: Environment;
  private readonly abort = new AbortController();
  /** Ends when the host stops: the starts and calls that wait end with it. */
  readonly signal = this.abort.signal;
  stopping = false;
  /** The host stops on a signal of the terminal core. */
  private fast = false;
  private quit!: () => void;
  private readonly quitting = new Promise<string>((r) => (this.quit = () => r('')));
  private ended = false;
  private readonly startedAt = now();
  private current: chat.ClampedHostSettings;
  private written = 0;
  private probes = 0;
  readonly chats = new Map<string, Chat>();
  /** The connections served: true for one attached to a chat or watching,
   * which ends when it wrote what it still had. */
  private readonly conns = new Map<Socket, boolean>();
  private readonly refusing = new Set<Socket>();
  private quietSince = 0;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private quietPoke = false;
  /** The state each chat's watchers were told last: what a watcher that
   * comes is told first. */
  private readonly watchers = new Set<Subscriber>();
  private readonly states = new Map<string, chat.ChatState>();
  /** The sessions whose agents are being ended. */
  private readonly ending = new Map<Session, Promise<void>>();
  /** What runs for the host and has to end before it does. */
  private readonly tracked = new Set<Promise<unknown>>();
  /** New chats take turns: a chat's check of the session it resumes and
   * its entry in chats are one step. */
  private newTurn: Promise<unknown> = Promise.resolve();
  private enforcing: Promise<void> | null = null;
  private enforceAgain = false;
  private lastSignal: (() => void) | null = null;
  /** Per-kind cached model lists (backed by journal settings table models:<kind>). */
  private readonly modelCache = new Map<string, { models: chat.ModelOption[]; fetchedAt: string }>();

  constructor(o: HostOptions) {
    this.opts = o;
    this.o = { ...HOST_TIMING, ...o.timing };
    this.logger = o.logger;
    this.client = o.client;
    const hostEnv = o.hostEnv ?? (process.env as Env);
    this.environment = new Environment({
      logger: o.logger,
      procs: this.procs,
      hostEnv,
      home: userHome(hostEnv),
      ...(o.environ ? { lookup: o.environ } : {}),
    });
    this.current = chat.defaultHostSettings();
  }

  private logf(line: string): void {
    this.logger(line);
  }

  /** The settings, clamped. */
  settings(): chat.ClampedHostSettings {
    return this.current;
  }

  /** Has p end before the host does. */
  track(p: Promise<unknown>): void {
    const q = p.catch((e: Error) => this.logf(`unexpected: ${e?.stack ?? e}`));
    this.tracked.add(q);
    void q.finally(() => this.tracked.delete(q));
  }

  /** The user's environment (the login shell's). */
  env(signal: AbortSignal): Promise<Env> {
    return this.environment.get(AbortSignal.any([signal, this.signal]));
  }

  async serve(): Promise<void> {
    const o = this.opts;
    const path = posix.join(o.run, chat.SOCKET_NAME);
    // Connections wait until the journal is read: the hello comes then.
    let loaded = false;
    const starting = new Set<Socket>();
    const served = await listen(o.run, path, (c) => {
      c.on('error', () => {});
      if (loaded) {
        this.accept(c);
      } else if (starting.size >= MAX_CONNS) {
        c.destroy();
      } else {
        starting.add(c);
        c.once('close', () => starting.delete(c));
      }
    });
    const removeSocket = () => {
      // The socket goes first: a host that starts now finds the path free.
      // It is removed only while it is this host's own.
      if (inode(path) === served.ino) rmSync(path, { force: true });
    };
    try {
      const { journal, pruned, pruneError } = await Journal.open({ base: o.base });
      this.journal = journal;
      if (pruneError) this.logf(`removing other hosts' journals: ${pruneError.message}`);
      else if (pruned.length > 0) this.logf(`removed the journals nobody used for 30 days: ${pruned.join(', ')}`);
      // Full access is the hub's to allow, in this process: a host does
      // not take it from what an earlier one stored.
      const stored = (await journal.settings()) ?? {};
      this.current = chat.clampHostSettings({ ...stored, allowFull: false });
      if (o.settings) this.current = o.settings as chat.ClampedHostSettings;
      await this.load();
    } catch (e) {
      for (const conn of starting) conn.destroy();
      starting.clear();
      served.server.close();
      removeSocket();
      if (this.journal) await this.journal.close();
      throw e;
    }
    this.logf(`serving ${path} for ${o.base} (version ${VERSION}, pid ${process.pid}, ${this.chats.size} chats)`);
    o.onHost?.(this);
    loaded = true;
    for (const conn of starting) if (!conn.destroyed) this.accept(conn);
    starting.clear();

    const enforcer = setInterval(() => this.enforceSoon(), this.o.enforceEvery);
    this.enforceSoon();
    this.pokeQuiet();

    const unsubscribe = o.signals?.((sig) => {
      if (this.lastSignal) return this.lastSignal();
      this.logf(`stopping: ${sig}`);
      this.fast = true;
      this.end(sig);
    });
    const onAbort = () => this.end('the host was asked to end');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    if (o.signal?.aborted) onAbort();

    await this.quitting;
    this.stopping = true;
    let hard: ReturnType<typeof setTimeout> | undefined;
    if (o.exit) {
      const exit = o.exit;
      hard = setTimeout(() => {
        this.logf(`did not stop within ${this.o.stopDeadline / 1000} s: its agents are killed, and it exits`);
        this.killAll();
        exit(1);
      }, this.o.stopDeadline);
    }
    clearInterval(enforcer);
    served.server.close();
    removeSocket();
    await this.stopAgents(this.fast);
    this.abort.abort();
    if (this.quietTimer) clearTimeout(this.quietTimer);
    for (const conn of this.refusing) conn.destroy();
    for (const [conn, attached] of this.conns) {
      // An attached one is told how its chat ended, if it reads that soon.
      if (attached) setTimeout(() => conn.destroy(), this.o.stopFlush).unref?.();
      else conn.destroy();
    }
    for (const c of this.chats.values()) {
      // What the adapter changed last is stored now: no timer of the chat
      // writes once the journal is closed.
      if (c.infoDirty && !c.deleted) c.emitInfo();
      if (c.infoTimer) clearTimeout(c.infoTimer);
      c.infoTimer = null;
      if (c.idleTimer) clearTimeout(c.idleTimer);
      c.stopped = true;
      for (const s of c.subs) s.finish();
    }
    for (const s of this.watchers) s.finish();
    while (this.tracked.size > 0) await Promise.all([...this.tracked]);
    await this.journal.close();
    unsubscribe?.();
    o.signal?.removeEventListener('abort', onAbort);
    clearTimeout(hard);
    this.logf('stopped');
  }

  /** Makes serve end. */
  end(why: string): void {
    if (this.ended) return;
    this.ended = true;
    this.logf(`stopping: ${why}`);
    this.quit();
  }

  /** Kills every agent's group at once. */
  private killAll(): void {
    this.procs.signal('SIGKILL');
    for (const c of this.chats.values()) if (c.sess) signalGroup(c.sess.pid, 'SIGKILL');
    for (const s of this.ending.keys()) signalGroup(s.pid, 'SIGKILL');
  }

  /** Reads the journal's chats. A chat whose agent ran when the last host
   * ended sleeps now: what waited was cancelled with it, and its turn ended
   * in an error. */
  private async load(): Promise<void> {
    for (const r of await this.journal.loadChats()) {
      const c = new Chat(this, r, true);
      c.first = r.first === 0 ? r.chat.seq + 1 : r.first;
      this.chats.set(r.chat.id, c);
      switch (r.chat.state) {
        case chat.State.Starting:
        case chat.State.Idle:
        case chat.State.Working:
        case chat.State.Waiting:
          await c.recover();
          break;
        default:
          c.rest = r.chat.state;
      }
      const st = chat.stateOf(c.snapshot());
      c.setLastState(st);
      this.states.set(r.chat.id, st);
    }
  }

  // ---- connections

  private accept(sock: Socket): void {
    sock.on('error', () => {});
    if (this.stopping) {
      sock.destroy();
      return;
    }
    if (this.conns.size >= MAX_CONNS) {
      if (this.refusing.size >= MAX_REFUSING) {
        sock.destroy();
        return;
      }
      this.refusing.add(sock);
      this.track(
        (async () => {
          try {
            if (await this.hello(sock)) await this.reply(sock, refusal(chat.Code.TooMany, 'too many connections'));
          } finally {
            this.refusing.delete(sock);
            sock.destroy();
          }
        })(),
      );
      return;
    }
    this.conns.set(sock, false);
    this.pokeQuiet();
    this.track(
      this.serveConn(sock).finally(() => {
        sock.destroy();
        this.conns.delete(sock);
        this.pokeQuiet();
      }),
    );
  }

  /** Writes the host's first line. */
  private hello(sock: Socket): Promise<boolean> {
    return this.write(sock, { host: { proto: chat.PROTO, version: VERSION, pid: process.pid } });
  }

  private reply(sock: Socket, res: chat.Response): Promise<boolean> {
    return this.write(sock, res);
  }

  private write(sock: Socket, v: unknown): Promise<boolean> {
    let b: string;
    try {
      b = chat.line(v);
    } catch {
      b = '';
    }
    if (b === '' || Buffer.byteLength(b) > chat.MAX_LINE + 1) b = chat.line(refusal(chat.Code.TooLarge, 'the answer does not fit a line'));
    return new Promise((resolve) => {
      if (sock.destroyed) return resolve(false);
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, this.o.requestTimeout);
      sock.write(b, (e) => {
        clearTimeout(timer);
        resolve(!e);
      });
    });
  }

  /** Speaks the protocol on a connection: the hello, one request and its
   * answer, and for an attach or a watch what follows. */
  private async serveConn(sock: Socket): Promise<void> {
    if (!(await this.hello(sock))) return;
    const r = new Reader(sock);
    const timer = setTimeout(() => sock.destroy(), this.o.requestTimeout);
    let b: Buffer;
    try {
      b = await chat.readLine(r);
    } catch (e) {
      if (e === chat.ERR_TOO_LARGE) {
        await chat.skipLine(r, MAX_DISCARD).catch(() => {});
        clearTimeout(timer);
        await this.reply(sock, refusal(chat.Code.TooLarge, 'a line of more than 16 MiB'));
      }
      clearTimeout(timer);
      return;
    }
    clearTimeout(timer);
    const req = parseRequest(b);
    if (!req) {
      await this.reply(sock, refusal(chat.Code.BadRequest, 'the request is not a JSON object of the protocol'));
      return;
    }
    switch (req.op) {
      case chat.Op.Agents:
        return void (await this.reply(sock, await this.agents(req)));
      case chat.Op.Chats:
        return void (await this.reply(sock, { ok: true, chats: this.sorted().map((c) => c.snapshot()) }));
      case chat.Op.New:
        return void (await this.reply(sock, await this.newChat(req)));
      case chat.Op.Attach:
        return this.attach(sock, r, req);
      case chat.Op.Close:
        return void (await this.reply(sock, await this.closeChat(req.chat)));
      case chat.Op.Delete:
        return void (await this.reply(sock, await this.deleteChat(req.chat)));
      case chat.Op.Archive:
        return void (await this.reply(sock, await this.archiveChat(req.chat, true)));
      case chat.Op.Unarchive:
        return void (await this.reply(sock, await this.archiveChat(req.chat, false)));
      case chat.Op.Sessions:
        return void (await this.reply(sock, await this.sessions(req)));
      case chat.Op.Watch:
        return this.watch(sock, r);
      case chat.Op.Seen:
        return void (await this.reply(sock, this.seen(req)));
      case chat.Op.Configure:
        return void (await this.reply(sock, await this.configure(req)));
      case chat.Op.Shutdown:
        return void (await this.reply(sock, this.shutdown()));
      case chat.Op.Trust:
        return void (await this.reply(sock, await this.trust(req)));
      case chat.Op.Untrust:
        return void (await this.reply(sock, await this.untrust(req)));
      case chat.Op.Trusted:
        return void (await this.reply(sock, await this.listTrusted()));
      case chat.Op.HostStatus:
        return void (await this.reply(sock, this.hostStatus()));
      case chat.Op.Models:
        return void (await this.reply(sock, await this.models(req)));
      case chat.Op.Fork:
        return void (await this.reply(sock, await this.forkChat(req)));
      case chat.Op.Switch:
        return void (await this.reply(sock, await this.switchChat(req)));
      case chat.Op.Export:
        return void (await this.reply(sock, await this.exportChat(req)));
    }
    await this.reply(sock, refusal(chat.Code.BadRequest, 'unknown op'));
  }

  // ---- what chats share

  /** The chat spec of a kind and its adapter, or why there is none. */
  spec(kind: string | undefined): { spec: ChatSpec; adapter: Adapter } | chat.ChatError {
    const spec = kind ? this.opts.spec(kind) : undefined;
    if (!spec || spec.argv.length === 0) return perr(chat.Code.Unsupported, 'the kind has no chat');
    const adapter = Object.hasOwn(this.opts.adapters, spec.adapter) ? this.opts.adapters[spec.adapter] : undefined;
    if (!adapter) return perr(chat.Code.Unsupported, `this host has no adapter ${spec.adapter}`);
    return { spec, adapter };
  }

  /** What is wrong with a chat's directory; undefined when it is the clean
   * absolute path of a directory that exists. */
  async checkCwd(cwd: string | undefined): Promise<chat.ChatError | undefined> {
    if (!cwd || !cleanAbs(cwd)) return perr(chat.Code.BadRequest, 'cwd is not a clean absolute path');
    if (!(await isDir(cwd))) return perr(chat.Code.BadRequest, 'cwd is not a directory');
    return undefined;
  }

  /** The in_terminal error when a process other than the host's runs an
   * agent's session (Adapter.inTerminal), so that the host neither resumes
   * nor imports it; null otherwise, or when the adapter cannot tell. */
  async inTerminal(kind: string, cwd: string, session: string): Promise<chat.ChatError | null> {
    const found = this.spec(kind);
    if ('code' in found || !found.adapter.inTerminal) return null;
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.o.startTimeout)]);
    try {
      const env = agentEnv(await this.env(signal), found.spec.env, cwd);
      const e = await found.adapter.inTerminal(
        { kind, argv: [], env, cwd, sessionId: session, after: '', procs: this.procs, logger: this.logger },
        signal,
      );
      return e && e.code === chat.Code.InTerminal ? e : null;
    } catch (e) {
      const ce = errorOf(e, signal);
      return ce.code === chat.Code.InTerminal ? ce : null;
    }
  }

  /** Whether the user trusted dir, or a directory above it, and that
   * directory still may be trusted and is the one that was: a trusted
   * directory that is another one now, or that is no longer safe to trust,
   * is taken off the list. */
  async trusted(dir: string): Promise<boolean> {
    let rows;
    try {
      rows = await this.journal.trustedAbove(dir);
    } catch (e) {
      this.logf(`trusted ${dir}: ${(e as Error).message}`);
      return false;
    }
    const home = userHome(this.opts.hostEnv ?? (process.env as Env));
    const gone: string[] = [];
    let ok = false;
    for (const t of rows) {
      try {
        if (sameID(await trustable(t.path, home), t.id)) {
          ok = true;
          break;
        }
        this.logf(`${t.path} is trusted no more: it is another directory now`);
      } catch (e) {
        this.logf(`${t.path} is trusted no more: ${(e as Error).message}`);
      }
      gone.push(t.path);
    }
    await this.journal.untrust(gone).catch((e: Error) => this.logf(`untrust ${gone.join(', ')}: ${e.message}`));
    return ok;
  }

  /** Counts bytes of events written, and has the journal's bounds checked
   * after ENFORCE_BYTES of them. */
  wrote(n: number): void {
    this.written += n;
    if (this.written >= ENFORCE_BYTES) {
      this.written = 0;
      this.enforceSoon();
    }
  }

  /** Tells that the host's quiet may have changed. */
  pokeQuiet(): void {
    if (this.quietPoke) return;
    this.quietPoke = true;
    setImmediate(() => {
      this.quietPoke = false;
      this.checkQuiet();
    });
  }

  /** Ends a host that had no agent process and no connection for idleExit. */
  private checkQuiet(): void {
    const live = this.liveAgents(null) > 0 || this.ending.size > 0;
    if (live || this.conns.size > 0 || this.stopping) {
      this.quietSince = 0;
      if (this.quietTimer) clearTimeout(this.quietTimer);
      this.quietTimer = null;
      return;
    }
    const t = now();
    if (this.quietSince === 0) this.quietSince = t;
    const wait = this.o.idleExit - (t - this.quietSince);
    if (wait > 0) {
      this.quietTimer ??= setTimeout(() => {
        this.quietTimer = null;
        this.pokeQuiet();
      }, wait);
      return;
    }
    this.end(`no agent and no connection for ${this.o.idleExit / 1000} s`);
  }

  /** The chats as Op.Chats orders them: the most recently updated first. */
  private sorted(): Chat[] {
    return [...this.chats.values()].sort((a, b) => {
      const x = Date.parse(a.r.chat.updated) || 0;
      const y = Date.parse(b.r.chat.updated) || 0;
      if (x !== y) return y - x;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /** Counts the chats whose agent runs or starts, but not except. */
  liveAgents(except: Chat | null): number {
    let n = 0;
    for (const c of this.chats.values()) if (c !== except && (c.sess || c.starting)) n++;
    return n;
  }

  /** Sends a chat's state to every watcher, and keeps it for the watchers
   * that come. */
  broadcast(st: chat.ChatState): void {
    let b: string;
    try {
      b = chat.line(st);
    } catch {
      return;
    }
    if (st.state === chat.State.Deleted) this.states.delete(st.id);
    else this.states.set(st.id, st);
    for (const s of this.watchers) if (!s.push(b)) this.watchers.delete(s);
  }

  /** Ends a session whose start its chat no longer waited for. While the
   * host stops, it settles once the agent is gone (killed at once on a
   * signal of the terminal core): no agent outlives the host. */
  async endLate(sess: Session): Promise<void> {
    if (this.stopping && this.fast) signalGroup(sess.pid, 'SIGKILL');
    await this.endSession(sess, this.stopping);
  }

  /** Ends an agent session the host let go of: gracefully, within
   * closeGrace, and whatever is left of its process group is killed. With
   * wait, it settles once the agent is gone. */
  endSession(sess: Session | null, wait: boolean): Promise<void> {
    if (!sess) return Promise.resolve();
    let p = this.ending.get(sess);
    if (!p) {
      p = (async () => {
        let gone = false;
        void sess.done.then(() => (gone = true));
        const signal = AbortSignal.timeout(this.o.closeGrace);
        let err = '';
        try {
          await sess.close(signal);
        } catch (e) {
          err = (e as Error).message;
        }
        await Promise.race([sess.done, new Promise((r) => (signal.aborted ? r(0) : signal.addEventListener('abort', r, { once: true })))]);
        if (!gone) {
          this.logf(`an agent did not end in ${this.o.closeGrace / 1000} s${err ? ` (${err})` : ''}: killed`);
          signalGroup(sess.pid, 'SIGKILL');
        }
        this.ending.delete(sess);
        this.pokeQuiet();
      })();
      this.ending.set(sess, p);
    }
    return wait ? p : Promise.resolve();
  }

  /** Stops the agents idle the longest while more run than maxLive,
   * counting except as one that runs. False when the agents that run all
   * work, wait or start. */
  makeRoom(except: Chat | null): boolean {
    const max = this.current.maxLive;
    for (;;) {
      const n = this.liveAgents(except) + (except ? 1 : 0);
      if (n <= max) return true;
      let victim: Chat | null = null;
      for (const c of this.chats.values()) {
        if (c === except) continue;
        const idle = c.sess && c.r.chat.state === chat.State.Idle;
        if (idle && (!victim || c.idleSince < victim.idleSince)) victim = c;
      }
      if (!victim) return false;
      this.logf(`chat ${victim.id}: its agent stopped, idle the longest of ${n}`);
      const sess = victim.stopAgent(chat.State.Sleeping);
      void this.endSession(sess, false);
    }
  }

  /** Ends every agent as the host stops; the chats sleep. Fast, on a signal
   * of the terminal core, which kills the host a second later: every
   * agent's process group gets SIGTERM at once while the adapters end their
   * agents, and SIGKILL at the next signal or after killAfter. Otherwise the
   * adapters have closeGrace to end their agents, and what is left of them
   * is killed. */
  private async stopAgents(fast: boolean): Promise<void> {
    const sessions: Session[] = [];
    for (const c of this.chats.values()) {
      if (!c.sess && !c.starting) continue;
      const noSession = c.r.chat.sessionId === '';
      const sess = c.stopAgent(
        noSession ? chat.State.Failed : chat.State.Sleeping,
        noSession ? perr(chat.Code.Ended, 'the chat host stopped before the session existed') : undefined,
        perr(chat.Code.Ended, 'the chat host stopped'),
      );
      if (sess) sessions.push(sess);
    }
    for (const s of this.ending.keys()) if (!sessions.includes(s)) sessions.push(s);
    const killAll = () => {
      for (const s of sessions) signalGroup(s.pid, 'SIGKILL');
      this.procs.signal('SIGKILL');
    };
    if (!fast) {
      for (const s of sessions) void this.endSession(s, false);
      await Promise.race([Promise.all([...this.ending.values()]), new Promise((r) => setTimeout(r, this.o.closeGrace + 1000))]);
      killAll();
      return;
    }
    for (const s of sessions) signalGroup(s.pid, 'SIGTERM');
    this.procs.signal('SIGTERM');
    const signal = AbortSignal.timeout(this.o.killAfter);
    const all = Promise.all(
      sessions.map((s) =>
        s.close(signal).then(
          () => s.done,
          () => s.done,
        ),
      ),
    );
    await Promise.race([
      all,
      new Promise((r) => signal.addEventListener('abort', r, { once: true })),
      new Promise<void>((r) => (this.lastSignal = r)),
    ]);
    // What started meanwhile goes too.
    killAll();
  }

  // ---- requests

  /** Tells which kinds' programs the user's PATH has. */
  private async agents(req: Request): Promise<chat.Response> {
    const kinds = req.kinds ?? [];
    if (kinds.length > MAX_KINDS) return refusal(chat.Code.BadRequest, 'too many kinds');
    const user = await this.env(this.signal);
    const agents: chat.AgentStatus[] = [];
    for (const kind of kinds) {
      const found = this.spec(kind);
      if ('code' in found) agents.push({ kind, available: false, reason: chat.Reason.Unsupported });
      else if (!(await lookPath(found.spec.argv[0]!, agentEnv(user, found.spec.env, ''))))
        agents.push({ kind, available: false, reason: chat.Reason.NotFound });
      else agents.push({ kind, available: true });
    }
    return { ok: true, agents };
  }

  /** Makes a chat and starts its agent; the answer does not wait for that. */
  private async newChat(req: Request): Promise<chat.Response> {
    const found = this.spec(req.kind);
    if ('code' in found) return { error: found };
    const bad = await this.checkCwd(req.cwd);
    if (bad) return { error: bad };
    const resume = req.resume ?? '';
    if (resume !== '' && !SESSION_ID.test(resume)) return refusal(chat.Code.BadRequest, 'resume is no session id');
    if (req.import && resume === '') return refusal(chat.Code.BadRequest, 'import needs a session to resume');
    const opts: chat.Options = {};
    if (req.options?.model) opts.model = req.options.model;
    if (req.options?.effort) opts.effort = req.options.effort;
    if (req.options?.mode) opts.mode = req.options.mode;
    if (
      !validOption(opts.model ?? '') ||
      !validOption(opts.effort ?? '') ||
      (opts.mode !== undefined && !(chat.MODES as readonly string[]).includes(opts.mode))
    )
      return refusal(chat.Code.BadRequest, 'options out of their bounds');
    if (opts.mode === chat.Mode.Full && !this.current.allowFull)
      return refusal(chat.Code.NotAllowed, 'full access is not allowed on this machine');
    const env = validateEnv(req.env);
    if (env === null) return refusal(chat.Code.BadRequest, 'env: valid environment variable names and string values');
    if (this.stopping) return refusal(chat.Code.Ended, 'the host stops');
    if (resume !== '') {
      const e = await this.inTerminal(req.kind!, req.cwd!, resume);
      if (e) return { error: e };
    }
    const turn = this.newTurn.then(() => this.newChatTurn(req, resume, opts, env));
    this.newTurn = turn.catch(() => {});
    return turn;
  }

  private async newChatTurn(req: Request, resume: string, opts: chat.Options, env?: Record<string, string>): Promise<chat.Response> {
    if (resume !== '') {
      const other = this.chatOfSession(req.kind!, resume);
      if (other) return refusal(chat.Code.BadRequest, `chat ${other} has the session`);
    }
    const room = await this.roomForChat();
    if (room) return { error: room };
    if (this.stopping) return refusal(chat.Code.Ended, 'the host stops');
    const t = timeOf(now());
    // A session taken up is the chat's from the start; one made for it is
    // fresh until it had a turn.
    const r: Row = {
      chat: {
        id: chat.newChatID(),
        kind: req.kind!,
        title: '',
        cwd: req.cwd!,
        sessionId: resume,
        state: chat.State.Starting,
        status: chat.Status.Idle,
        created: t,
        updated: t,
        seq: 0,
        seen: 0,
        capabilities: emptyCapabilities(),
      },
      turnEnd: 0,
      options: opts,
      historyAfter: '',
      bytes: 0,
      fresh: resume === '',
      renamed: false,
      untrustedTold: false,
    };
    try {
      await this.journal.insertChat(r);
    } catch (e) {
      this.logf(`new chat: ${(e as Error).message}`);
      return refusal(chat.Code.Failed, 'the journal did not take the chat');
    }
    const c = new Chat(this, r, false, env);
    c.first = 1;
    this.chats.set(r.chat.id, c);
    const st = c.beginStart();
    const view = c.snapshot();
    c.notify();
    this.pokeQuiet();
    this.track(c.importAndLaunch(st, resume, !!req.import));
    return { ok: true, chat: view };
  }

  /** The chat of a kind that has a session, "" for none. */
  private chatOfSession(kind: string, session: string): string {
    for (const c of this.chats.values()) if (c.r.chat.kind === kind && c.r.chat.sessionId === session && !c.deleted) return c.id;
    return '';
  }

  /** A chat by its id; undefined for none. */
  private lookup(id: string | undefined): Chat | undefined {
    if (!id || !chat.validChatID(id)) return undefined;
    return this.chats.get(id);
  }

  /** Subscribes the connection to a chat and takes its commands until
   * either side closes. */
  private async attach(sock: Socket, r: Reader, req: Request): Promise<void> {
    const c = this.lookup(req.chat);
    const s = new Subscriber(sock, this.journal, this.opts.subscriberLimits ?? SUBSCRIBER_LIMITS);
    if (!c || !c.subscribe(s, req.from ?? 0)) {
      await this.reply(sock, refusal(chat.Code.UnknownChat, 'no such chat'));
      return;
    }
    if (this.conns.has(sock)) this.conns.set(sock, true);
    // The host's end found the connection before it was attached.
    if (this.stopping) setTimeout(() => sock.destroy(), this.o.stopFlush).unref?.();
    const running = s.run();
    if (!req.noCatchUp) c.catchUpLater();
    const calls = { n: 0 };
    // The connection is closed at once when it ends for any reason but a
    // line the client must be told of.
    let finish = false;
    for (;;) {
      let b: Buffer;
      try {
        b = await chat.readLine(r);
      } catch (e) {
        if (e === chat.ERR_TOO_LARGE) {
          const t = setTimeout(() => sock.destroy(), this.o.requestTimeout);
          await chat.skipLine(r, MAX_DISCARD).catch(() => {});
          clearTimeout(t);
          s.ack('', perr(chat.Code.TooLarge, 'a line of more than 16 MiB'));
          finish = true;
        }
        break;
      }
      if (b.length === 0) continue;
      const cmd = parseCommand(b);
      if (!cmd) {
        s.ack('', perr(chat.Code.BadRequest, 'the command is not a JSON object of the protocol'));
        continue;
      }
      this.command(c, s, cmd, calls);
    }
    c.unsubscribe(s);
    if (finish) s.finish();
    else s.drop();
    await running;
  }

  /** Runs a command of an attached connection and acks it. A command that
   * waits for the agent does not hold up the ones after it. */
  private command(c: Chat, s: Subscriber, cmd: chat.Command, calls: { n: number }): void {
    let call: (() => Promise<chat.ChatError | undefined>) | null = null;
    switch (cmd.op) {
      case chat.CommandOp.Prompt:
        call = () => c.prompt(cmd);
        break;
      case chat.CommandOp.Cancel:
        call = () => c.cancelTurn();
        break;
      case chat.CommandOp.Permission:
        return s.ack(cmd.id, c.answerPermission(cmd));
      case chat.CommandOp.Answer:
        return s.ack(cmd.id, c.answerQuestion(cmd));
      case chat.CommandOp.SetConfig:
        call = () => c.setConfig(cmd.config ?? '', cmd.value ?? '');
        break;
      case chat.CommandOp.CancelQueued:
        call = () => c.cancelQueued(cmd.message);
        break;
      case chat.CommandOp.SteerQueued:
        call = () => c.steerQueued(cmd.message, cmd.delivery);
        break;
      case chat.CommandOp.Compact:
        call = () => c.compact(cmd.instructions);
        break;
      case chat.CommandOp.Rename:
        return s.ack(cmd.id, c.rename(cmd.title));
      case chat.CommandOp.Handoff:
        call = () => c.handoff();
        break;
      case chat.CommandOp.StopTask:
        call = () => c.stopTask(cmd.task);
        break;
      case chat.CommandOp.Rewind: {
        if (calls.n >= MAX_CALLS) return s.ack(cmd.id, perr(chat.Code.Busy, 'too many commands wait for the agent'));
        calls.n++;
        this.track(
          (async () => {
            let afterAck: (() => Promise<void>) | undefined;
            try {
              const res = await c.rewind(cmd);
              afterAck = res.afterAck;
              s.ack(cmd.id, res.err);
            } catch (e) {
              s.ack(cmd.id, errorOf(e));
            } finally {
              calls.n--;
            }
            if (afterAck) await afterAck();
          })(),
        );
        return;
      }
      default:
        return s.ack(cmd.id, perr(chat.Code.BadRequest, 'unknown op'));
    }
    if (calls.n >= MAX_CALLS) return s.ack(cmd.id, perr(chat.Code.Busy, 'too many commands wait for the agent'));
    calls.n++;
    const f = call;
    this.track(
      (async () => {
        try {
          s.ack(cmd.id, await f());
        } catch (e) {
          s.ack(cmd.id, errorOf(e));
        } finally {
          calls.n--;
        }
      })(),
    );
  }

  /** Ends a chat's agent and keeps the chat, closed. */
  private async closeChat(id: string | undefined): Promise<chat.Response> {
    const c = this.lookup(id);
    if (!c || c.deleted) return refusal(chat.Code.UnknownChat, 'no such chat');
    if (c.r.chat.state !== chat.State.Closed || !c.r.chat.closed) c.r.chat.closed = timeOf(now());
    const sess = c.stopAgent(chat.State.Closed, undefined, perr(chat.Code.Ended, 'the chat was closed'));
    c.save();
    await this.endSession(sess, true);
    return { ok: true };
  }

  /** Archives a chat (on) or takes it back. Archiving ends its agent and
   * keeps it closed, what it ended with seen; the bounds remove archived
   * chats before the other closed ones. */
  private async archiveChat(id: string | undefined, on: boolean): Promise<chat.Response> {
    const c = this.lookup(id);
    if (!c || c.deleted) return refusal(chat.Code.UnknownChat, 'no such chat');
    if (!on) {
      if (c.r.chat.archived) {
        delete c.r.chat.archived;
        c.save();
        c.notify();
      }
      return { ok: true };
    }
    if (c.r.chat.state !== chat.State.Closed || !c.r.chat.closed) c.r.chat.closed = timeOf(now());
    const sess = c.stopAgent(chat.State.Closed, undefined, perr(chat.Code.Ended, 'the chat was archived'));
    c.r.chat.archived ??= timeOf(now());
    // Put away: nothing of it waits for the user.
    c.r.chat.seen = c.madeSeq();
    c.save();
    c.notify();
    await this.endSession(sess, true);
    return { ok: true };
  }

  /** Forgets a chat and its log, its agent ended first. */
  private async deleteChat(id: string | undefined): Promise<chat.Response> {
    const c = this.lookup(id);
    if (!c || c.deleted) return refusal(chat.Code.UnknownChat, 'no such chat');
    const sess = c.stopAgent(chat.State.Closed, undefined, perr(chat.Code.Ended, 'the chat was deleted'));
    // From here on no prompt starts its agent again.
    c.deleted = true;
    await this.endSession(sess, true);
    try {
      await this.forget(c);
    } catch (e) {
      this.logf(`chat ${c.id}: delete: ${(e as Error).message}`);
      return refusal(chat.Code.Failed, 'the journal did not delete the chat');
    }
    this.enforceSoon();
    return { ok: true };
  }

  /** Removes a chat: from the host, its agent ended and its attached
   * connections closed, then from the journal. */
  private async forget(c: Chat): Promise<void> {
    if (this.chats.get(c.id) === c) this.chats.delete(c.id);
    c.deleted = true;
    const sess = c.stopAgent(chat.State.Closed);
    for (const s of c.subs) s.finish();
    c.subs.clear();
    if (c.infoTimer) clearTimeout(c.infoTimer);
    if (c.idleTimer) clearTimeout(c.idleTimer);
    const st = chat.stateOf(c.snapshot());
    st.state = chat.State.Deleted;
    st.status = chat.Status.Idle;
    void this.endSession(sess, false);
    this.broadcast(st);
    this.pokeQuiet();
    await this.journal.deleteChat(c.id);
  }

  /** Lists the sessions an agent kept for a directory, and which chat has
   * each. */
  private async sessions(req: Request): Promise<chat.Response> {
    const found = this.spec(req.kind);
    if ('code' in found) return { error: found };
    if (!req.cwd || !cleanAbs(req.cwd)) return refusal(chat.Code.BadRequest, 'cwd is not a clean absolute path');
    if ((req.cursor ?? '').length > 4096) return refusal(chat.Code.BadRequest, 'cursor too long');
    if (this.probes >= MAX_PROBES) return refusal(chat.Code.Busy, 'too many session listings run');
    this.probes++;
    try {
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.o.startTimeout)]);
      const env = agentEnv(await this.env(signal), found.spec.env, req.cwd);
      const path = await lookPath(found.spec.argv[0]!, env);
      if (!path) return refusal(chat.Code.NotFound, `${found.spec.argv[0]} is not in the user's PATH`);
      let list: { sessions: chat.Session[]; next: string };
      try {
        list = await found.adapter.sessions(
          {
            kind: req.kind!,
            argv: [path, ...found.spec.argv.slice(1)],
            env,
            cwd: req.cwd,
            cursor: req.cursor ?? '',
            procs: this.procs,
            logger: this.logger,
          },
          signal,
        );
      } catch (e) {
        return { error: errorOf(e, signal) };
      }
      const have = new Map<string, string>();
      for (const c of this.chats.values())
        if (c.r.chat.kind === req.kind && c.r.chat.sessionId !== '' && !c.deleted) have.set(c.r.chat.sessionId, c.id);
      const sessions = list.sessions.map((s) => {
        const out: chat.Session = { ...s };
        const id = have.get(s.sessionId);
        if (id) out.chat = id;
        else delete out.chat;
        return out;
      });
      return { ok: true, sessions, ...(list.next ? { nextCursor: list.next } : {}) };
    } finally {
      this.probes--;
    }
  }

  /** Sends the states of every chat, then each change, until either side
   * closes. The states are those the other watchers were told last, and the
   * watcher is listed at once: every change after them comes after them,
   * none before. */
  private async watch(sock: Socket, r: Reader): Promise<void> {
    const s = new Subscriber(sock, null, this.opts.subscriberLimits ?? SUBSCRIBER_LIMITS);
    if (this.conns.has(sock)) this.conns.set(sock, true);
    const states = [...this.states.values()].sort((a, b) => {
      const x = Date.parse(a.updated) || 0;
      const y = Date.parse(b.updated) || 0;
      if (x !== y) return y - x;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    let head = chat.line({ ok: true, states });
    if (Buffer.byteLength(head) > chat.MAX_LINE + 1) head = chat.line(refusal(chat.Code.TooLarge, 'the answer does not fit a line'));
    s.head = [head];
    this.watchers.add(s);
    const running = s.run();
    // The client sends nothing more: what it reads tells that it left.
    let read = 0;
    for (;;) {
      const b = await r.chunk(64 << 10).catch(() => null);
      if (b === null) break;
      read += b.length;
      if (read > 1 << 20) break;
    }
    this.watchers.delete(s);
    s.drop();
    await running;
  }

  /** Notes what the user saw of a chat. */
  private seen(req: Request): chat.Response {
    const c = this.lookup(req.chat);
    if (!c || c.deleted) return refusal(chat.Code.UnknownChat, 'no such chat');
    const seq = Math.min(req.seq ?? 0, c.r.chat.seq);
    if (seq > c.r.chat.seen) {
      c.r.chat.seen = seq;
      c.save();
      c.notify();
    }
    return { ok: true };
  }

  /** Takes the hub's settings. Without full access, a chat whose agent
   * runs in a mode of full access starts it again in the default mode
   * (revokeFull). */
  private async configure(req: Request): Promise<chat.Response> {
    if (!req.settings) return refusal(chat.Code.BadRequest, 'configure needs settings');
    const s = chat.clampHostSettings(req.settings as chat.HostSettings);
    this.current = s;
    await this.journal.putSettings(s).catch((e: Error) => this.logf(`settings: ${e.message}`));
    for (const c of [...this.chats.values()]) {
      c.armIdle();
      if (!s.allowFull) void this.endSession(c.revokeFull(), false);
    }
    this.makeRoom(null);
    this.enforceSoon();
    return { ok: true };
  }

  /** Ends the host for another version to take over, unless an agent works,
   * waits or starts. */
  private shutdown(): chat.Response {
    for (const c of this.chats.values()) {
      if (c.starting || c.r.chat.state === chat.State.Working || c.r.chat.state === chat.State.Waiting)
        return refusal(chat.Code.Busy, 'a chat works, waits or starts');
    }
    // No chat starts an agent from here on.
    this.stopping = true;
    setImmediate(() => this.end('asked to'));
    return { ok: true };
  }

  /** Adds a directory to the ones the user trusts. */
  private async trust(req: Request): Promise<chat.Response> {
    if ((req.cwd ?? '').length > 4096) return refusal(chat.Code.BadRequest, 'cwd too long');
    const bad = await this.checkCwd(req.cwd);
    if (bad) return { error: bad };
    let id;
    try {
      id = await trustable(req.cwd!, userHome(this.opts.hostEnv ?? (process.env as Env)));
    } catch (e) {
      return { error: errorOf(e) };
    }
    try {
      await this.journal.trust(req.cwd!, now(), id);
    } catch (e) {
      this.logf(`trust ${req.cwd}: ${(e as Error).message}`);
      return refusal(chat.Code.Failed, 'the journal did not take the directory');
    }
    this.logf(`trusted ${req.cwd}`);
    return { ok: true };
  }

  /** Takes back the trust that covers a directory: its own and that of the
   * directories above it. */
  private async untrust(req: Request): Promise<chat.Response> {
    if ((req.cwd ?? '').length > 4096) return refusal(chat.Code.BadRequest, 'cwd too long');
    if (!req.cwd || !cleanAbs(req.cwd)) return refusal(chat.Code.BadRequest, 'cwd is not a clean absolute path');
    let paths: string[];
    try {
      paths = (await this.journal.trustedAbove(req.cwd)).map((t) => t.path);
      await this.journal.untrust(paths);
    } catch (e) {
      this.logf(`untrust ${req.cwd}: ${(e as Error).message}`);
      return refusal(chat.Code.Failed, 'the journal did not take it');
    }
    if (paths.length > 0) this.logf(`trusted no more: ${paths.join(', ')}`);
    return { ok: true };
  }

  /** Every trusted folder that remains valid and safe; the others are taken
   * off the list. */
  private async listTrusted(): Promise<chat.Response> {
    let rows;
    try {
      rows = await this.journal.listTrusted();
    } catch (e) {
      this.logf(`list trusted: ${(e as Error).message}`);
      return refusal(chat.Code.Failed, 'the journal did not answer');
    }
    const home = userHome(this.opts.hostEnv ?? (process.env as Env));
    const gone: string[] = [];
    const trusted: chat.TrustedFolder[] = [];
    for (const t of rows) {
      try {
        if (sameID(await trustable(t.path, home), t.id)) {
          trusted.push({ cwd: t.path, at: timeOf(t.at) });
          continue;
        }
        this.logf(`${t.path} is trusted no more: it is another directory now`);
      } catch (e) {
        this.logf(`${t.path} is trusted no more: ${(e as Error).message}`);
      }
      gone.push(t.path);
    }
    await this.journal.untrust(gone).catch((e: Error) => this.logf(`untrust ${gone.join(', ')}: ${e.message}`));
    return { ok: true, trusted };
  }

  private hostStatus(): chat.Response {
    const sessions: chat.HostSessionInfo[] = [];
    let totalBytes = 0;
    let liveAgents = 0;
    for (const c of this.chats.values()) {
      totalBytes += c.r.bytes;
      if ((!c.sess && !c.starting) || c.deleted) continue;
      liveAgents++;
      const s = c.snapshot();
      const info: chat.HostSessionInfo = {
        chat: s.id,
        kind: s.kind,
        title: s.title,
        cwd: s.cwd,
        sessionId: s.sessionId,
        state: s.state,
        status: s.status,
        updated: s.updated,
        bytes: c.r.bytes,
      };
      if (c.sess?.pid) info.pid = c.sess.pid;
      if (c.starting) info.starting = true;
      if (s.state === chat.State.Idle && c.idleSince) info.idleSince = timeOf(c.idleSince);
      if (s.agentVersion) info.agentVersion = s.agentVersion;
      sessions.push(info);
    }
    sessions.sort((a, b) => {
      const x = Date.parse(a.updated) || 0;
      const y = Date.parse(b.updated) || 0;
      if (x !== y) return y - x;
      return a.chat < b.chat ? -1 : a.chat > b.chat ? 1 : 0;
    });
    const terminalId = (this.opts.hostEnv ?? (process.env as Env)).HC_TERMINAL_ID;
    return {
      ok: true,
      hostStatus: {
        proto: chat.PROTO,
        version: VERSION,
        pid: process.pid,
        ...(terminalId ? { terminalId } : {}),
        startedAt: timeOf(this.startedAt),
        socket: posix.join(this.opts.run, chat.SOCKET_NAME),
        base: this.opts.base,
        conns: this.conns.size,
        watchers: this.watchers.size,
        liveAgents,
        totalChats: this.chats.size,
        totalBytes,
        ending: this.ending.size,
        settings: this.current,
        sessions,
      },
    };
  }

  /** Lists or refreshes the models available for req.kind. */
  private async models(req: Request): Promise<chat.Response> {
    const found = this.spec(req.kind);
    if ('code' in found) return { error: found };
    const kind = req.kind!;
    const key = `models:${kind}`;
    if (!req.refresh) {
      let cached = this.modelCache.get(kind);
      if (!cached) {
        const stored = await this.journal.getSetting<{ models?: chat.ModelOption[]; fetchedAt?: string }>(key).catch(() => undefined);
        if (stored && Array.isArray(stored.models)) {
          cached = { models: stored.models, fetchedAt: typeof stored.fetchedAt === 'string' ? stored.fetchedAt : '' };
          this.modelCache.set(kind, cached);
        }
      }
      return { ok: true, models: cached?.models ?? [], ...(cached?.fetchedAt ? { fetchedAt: cached.fetchedAt } : {}) };
    }
    if (this.probes >= MAX_PROBES) return refusal(chat.Code.Busy, 'too many probes run');
    const cwd = req.cwd || userHome(this.opts.hostEnv ?? (process.env as Env));
    const bad = await this.checkCwd(cwd);
    if (bad) return { error: bad };
    this.probes++;
    try {
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.o.startTimeout)]);
      let list: chat.ModelOption[];
      if (found.adapter.models) {
        const env = agentEnv(await this.env(signal), found.spec.env, cwd);
        const path = await lookPath(found.spec.argv[0]!, env);
        if (!path) return refusal(chat.Code.NotFound, `${found.spec.argv[0]} is not in the user's PATH`);
        try {
          list = await found.adapter.models(
            {
              kind,
              argv: [path, ...found.spec.argv.slice(1)],
              env,
              cwd,
              procs: this.procs,
              logger: this.logger,
              client: this.client,
            },
            signal,
          );
        } catch (e) {
          return { error: errorOf(e, signal) };
        }
      } else {
        // Fallback: read from a live chat of this kind if any has discovered models.
        const live = [...this.chats.values()].find((c) => !c.deleted && c.r.chat.kind === kind && c.r.chat.config?.length);
        const opt = live?.r.chat.config?.find((o) => o.category === chat.Category.Model);
        if (!opt?.options?.length) return refusal(chat.Code.Unsupported, 'the adapter does not list models');
        list = opt.options.map((v) => ({ value: v.value, name: v.name, ...(v.description ? { description: v.description } : {}) }));
      }
      const fetchedAt = timeOf(now());
      const entry = { models: list, fetchedAt };
      this.modelCache.set(kind, entry);
      await this.journal.putSetting(key, entry).catch((e: Error) => this.logf(`save models ${kind}: ${e.message}`));
      for (const c of this.chats.values()) if (!c.deleted && c.r.chat.kind === kind && c.sess) c.updateModels(list);
      return { ok: true, models: list, fetchedAt };
    } finally {
      this.probes--;
    }
  }

  /** Forks a chat (optionally up to req.upToSeq) using native adapter.fork
   * where supported and falling back to a context-seeded session otherwise. */
  private async forkChat(req: Request): Promise<chat.Response> {
    const src = this.lookup(req.chat);
    if (!src || src.deleted) return refusal(chat.Code.UnknownChat, 'no such chat');
    if (src.starting || src.held || src.busy()) return refusal(chat.Code.Busy, 'a turn runs');
    if (this.stopping) return refusal(chat.Code.Ended, 'the host stops');
    const found = this.spec(src.r.chat.kind);
    if ('code' in found) return { error: found };
    await src.flush();
    const upToSeq = req.upToSeq;
    if (upToSeq !== undefined && (upToSeq < 1 || upToSeq > src.r.chat.seq)) return refusal(chat.Code.BadRequest, 'upToSeq out of range');

    const storedAll = await this.journal.allEvents(src.id);
    const parsedAll: chat.Event[] = [];
    for (const row of storedAll) {
      try {
        parsedAll.push(JSON.parse(row.line) as chat.Event);
      } catch {
        // skip
      }
    }
    const lastSeq = parsedAll.at(-1)?.seq ?? src.r.chat.seq;
    // Normalize upToSeq: when pointing at a user turn (User or Queued(taken)),
    // extend to the end of that turn (right before the next user turn, or full
    // session if it is the last turn) so journal and native session stay aligned.
    let resolvedUpToSeq = upToSeq;
    if (resolvedUpToSeq !== undefined) {
      const targetIdx = parsedAll.findIndex((e) => e.seq === resolvedUpToSeq);
      if (targetIdx >= 0 && isUserTurn(parsedAll[targetIdx]!)) {
        let nextUserIdx = -1;
        for (let i = targetIdx + 1; i < parsedAll.length; i++) {
          if (isUserTurn(parsedAll[i]!)) {
            nextUserIdx = i;
            break;
          }
        }
        if (nextUserIdx < 0) {
          resolvedUpToSeq = lastSeq;
        } else {
          const nextBoundary = turnBoundaryIdx(parsedAll, nextUserIdx);
          const endIdx = Math.max(targetIdx, nextBoundary - 1);
          resolvedUpToSeq = parsedAll[endIdx]!.seq ?? resolvedUpToSeq;
        }
      }
    }

    const partial = resolvedUpToSeq !== undefined && resolvedUpToSeq < lastSeq;
    const kept = partial ? parsedAll.filter((e) => (e.seq ?? 0) <= resolvedUpToSeq!) : parsedAll;

    // Extract native turn/message boundary hints for partial forks.
    let upToMessageId: string | undefined;
    let lastTurnId: string | undefined;
    let beforeTurnId: string | undefined;
    if (partial) {
      for (let i = kept.length - 1; i >= 0; i--) {
        const ev = kept[i]!;
        if (ev.parent) continue;
        if (!upToMessageId) {
          const uid = transcriptUuid(ev);
          if (uid) upToMessageId = uid;
        }
        if (!lastTurnId && ev.t === chat.EventType.Turn && ev.item) lastTurnId = ev.item;
        if (upToMessageId && lastTurnId) break;
      }
      for (const ev of parsedAll) {
        if ((ev.seq ?? 0) <= resolvedUpToSeq! || ev.parent || !ev.item) continue;
        if (ev.t === chat.EventType.Turn) {
          beforeTurnId = ev.item;
          break;
        }
      }
    }

    const customTitle = req.title ? clip(req.title, AGENT_TITLE_RUNES).trim() : '';
    const title = customTitle || (src.r.chat.title ? clip(`${src.r.chat.title} (fork)`, AGENT_TITLE_RUNES) : '');

    let nativeSessionId = '';
    const hasNativeSlice =
      !partial ||
      (found.spec.adapter === 'claude'
        ? !!upToMessageId
        : found.spec.adapter === 'codex'
          ? !!(beforeTurnId || lastTurnId)
          : !!(upToMessageId || beforeTurnId || lastTurnId));
    if (found.adapter.fork && src.r.chat.sessionId !== '' && !src.r.fresh && hasNativeSlice) {
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.o.startTimeout)]);
      const env = agentEnv(await this.env(signal), found.spec.env, src.r.chat.cwd);
      const path = await lookPath(found.spec.argv[0]!, env);
      if (path) {
        try {
          const res = await found.adapter.fork(
            {
              kind: src.r.chat.kind,
              argv: [path, ...found.spec.argv.slice(1)],
              env,
              cwd: src.r.chat.cwd,
              sessionId: src.r.chat.sessionId,
              ...(partial ? { partial: true } : {}),
              ...(upToMessageId ? { upToMessageId } : {}),
              ...(lastTurnId ? { lastTurnId } : {}),
              ...(beforeTurnId ? { beforeTurnId } : {}),
              ...(title ? { title } : {}),
              procs: this.procs,
              logger: this.logger,
              client: this.client,
            },
            signal,
          );
          if (res?.sessionId && SESSION_ID.test(res.sessionId)) nativeSessionId = res.sessionId;
        } catch (e) {
          const ce = errorOf(e, signal);
          if (ce.code !== chat.Code.Unsupported) return { error: ce };
        }
      }
    }

    const native = nativeSessionId !== '';
    const turn = this.newTurn.then(async (): Promise<chat.Response> => {
      const room = await this.roomForChat();
      if (room) return { error: room };
      if (this.stopping) return refusal(chat.Code.Ended, 'the host stops');
      const t = timeOf(now());
      const newId = chat.newChatID();
      const opts: chat.Options = { ...src.r.options };
      if (opts.mode === chat.Mode.Full && !this.current.allowFull) opts.mode = chat.Mode.Default;
      const r: Row = {
        chat: {
          id: newId,
          kind: src.r.chat.kind,
          title,
          cwd: src.r.chat.cwd,
          sessionId: nativeSessionId,
          state: chat.State.Starting,
          status: chat.Status.Idle,
          created: t,
          updated: t,
          seq: 0,
          seen: 0,
          capabilities: emptyCapabilities(),
        },
        turnEnd: 0,
        options: opts,
        historyAfter: '',
        bytes: 0,
        fresh: !native,
        renamed: !!(customTitle || src.r.renamed || title),
        untrustedTold: false,
      };
      try {
        await this.journal.insertChat(r);
        const copied = await this.journal.copyEventsUpTo(src.id, newId, partial ? resolvedUpToSeq : undefined);
        r.chat.seq = copied.seq;
        r.chat.seen = copied.seq;
        r.bytes = copied.bytes;
        r.turnEnd = copied.turnEnd;
        r.historyAfter = copied.historyAfter;
        if (copied.lastAt) r.chat.updated = timeOf(copied.lastAt);
        await this.journal.saveChat(r);
      } catch (e) {
        this.logf(`fork chat ${src.id}: ${(e as Error).message}`);
        await this.journal.deleteChat(newId).catch(() => {});
        return refusal(chat.Code.Failed, 'the journal did not fork the chat');
      }
      const c = new Chat(this, r, false, src.envOverrides());
      c.first = 1;
      if (!native && kept.length > 0) {
        const seed = exportMarkdown(kept, { title: src.r.chat.title, kind: src.r.chat.kind, cwd: src.r.chat.cwd });
        c.setSeed(seed);
        await this.journal.putSetting(`seed:${newId}`, seed).catch(() => {});
      }
      this.chats.set(newId, c);
      c.emit({
        t: chat.EventType.Notice,
        method: noticeMethod(Notice.Forked),
        params: { fromChat: src.id, native, ...(partial ? { upToSeq: resolvedUpToSeq } : {}) },
      });
      c.r.chat.seen = c.madeSeq();
      const st = c.beginStart();
      const view = c.snapshot();
      c.save();
      c.notify();
      this.pokeQuiet();
      this.track(c.launch(st, nativeSessionId));
      return { ok: true, chat: view };
    });
    this.newTurn = turn.catch(() => {});
    return turn;
  }

  /** Exports conversation context from req.chat and creates a new chat of
   * req.targetKind in the same cwd seeded with that handoff. */
  private async switchChat(req: Request): Promise<chat.Response> {
    const src = this.lookup(req.chat);
    if (!src || src.deleted) return refusal(chat.Code.UnknownChat, 'no such chat');
    const found = this.spec(req.targetKind);
    if ('code' in found) return { error: found };
    const opts: chat.Options = {};
    if (req.options?.model) opts.model = req.options.model;
    if (req.options?.effort) opts.effort = req.options.effort;
    if (req.options?.mode) opts.mode = req.options.mode;
    if (
      !validOption(opts.model ?? '') ||
      !validOption(opts.effort ?? '') ||
      (opts.mode !== undefined && !(chat.MODES as readonly string[]).includes(opts.mode))
    )
      return refusal(chat.Code.BadRequest, 'options out of their bounds');
    if (opts.mode === chat.Mode.Full && !this.current.allowFull)
      return refusal(chat.Code.NotAllowed, 'full access is not allowed on this machine');
    if (this.stopping) return refusal(chat.Code.Ended, 'the host stops');
    await src.flush();
    const upToSeq = req.upToSeq;
    if (upToSeq !== undefined && (upToSeq < 1 || upToSeq > src.r.chat.seq)) return refusal(chat.Code.BadRequest, 'upToSeq out of range');
    const stored = await this.journal.allEvents(src.id, upToSeq);
    const parsed: chat.Event[] = [];
    for (const row of stored) {
      try {
        parsed.push(JSON.parse(row.line) as chat.Event);
      } catch {
        // skip
      }
    }
    const seed = exportMarkdown(parsed, { title: src.r.chat.title, kind: src.r.chat.kind, cwd: src.r.chat.cwd });

    const turn = this.newTurn.then(async (): Promise<chat.Response> => {
      const room = await this.roomForChat();
      if (room) return { error: room };
      if (this.stopping) return refusal(chat.Code.Ended, 'the host stops');
      const t = timeOf(now());
      const newId = chat.newChatID();
      const title = src.r.chat.title;
      const r: Row = {
        chat: {
          id: newId,
          kind: req.targetKind!,
          title,
          cwd: src.r.chat.cwd,
          sessionId: '',
          state: chat.State.Starting,
          status: chat.Status.Idle,
          created: t,
          updated: t,
          seq: 0,
          seen: 0,
          capabilities: emptyCapabilities(),
        },
        turnEnd: 0,
        options: opts,
        historyAfter: '',
        bytes: 0,
        fresh: true,
        renamed: !!title,
        untrustedTold: false,
      };
      try {
        await this.journal.insertChat(r);
        await this.journal.putSetting(`seed:${newId}`, seed);
      } catch (e) {
        this.logf(`switch chat ${src.id}: ${(e as Error).message}`);
        await this.journal.deleteChat(newId).catch(() => {});
        return refusal(chat.Code.Failed, 'the journal did not create the switched chat');
      }
      const c = new Chat(this, r, false, src.envOverrides());
      c.first = 1;
      c.setSeed(seed);
      this.chats.set(newId, c);
      c.emit({
        t: chat.EventType.Notice,
        method: noticeMethod(Notice.Switched),
        params: { fromChat: src.id, fromKind: src.r.chat.kind, ...(upToSeq !== undefined ? { upToSeq } : {}) },
      });
      c.r.chat.seen = c.madeSeq();
      const st = c.beginStart();
      const view = c.snapshot();
      c.save();
      c.notify();
      this.pokeQuiet();
      this.track(c.launch(st, ''));
      return { ok: true, chat: view };
    });
    this.newTurn = turn.catch(() => {});
    return turn;
  }

  /** Exports req.chat's conversation up to optional req.upToSeq as Markdown. */
  private async exportChat(req: Request): Promise<chat.Response> {
    const src = this.lookup(req.chat);
    if (!src || src.deleted) return refusal(chat.Code.UnknownChat, 'no such chat');
    await src.flush();
    const upToSeq = req.upToSeq;
    if (upToSeq !== undefined && (upToSeq < 1 || upToSeq > src.r.chat.seq)) return refusal(chat.Code.BadRequest, 'upToSeq out of range');
    const stored = await this.journal.allEvents(src.id, upToSeq);
    const parsed: chat.Event[] = [];
    for (const row of stored) {
      try {
        parsed.push(JSON.parse(row.line) as chat.Event);
      } catch {
        // skip
      }
    }
    const markdown = exportMarkdown(parsed, { title: src.r.chat.title, kind: src.r.chat.kind, cwd: src.r.chat.cwd });
    return { ok: true, markdown };
  }

  // ---- bounds

  /** Has the journal's bounds checked soon. */
  enforceSoon(): void {
    if (this.enforcing) {
      this.enforceAgain = true;
      return;
    }
    this.enforcing = (async () => {
      do {
        this.enforceAgain = false;
        try {
          await this.enforceBounds();
          await this.journal.reclaim();
        } catch (e) {
          this.logf(`bounds: ${(e as Error).message}`);
        }
      } while (this.enforceAgain && !this.stopping);
    })().finally(() => (this.enforcing = null));
    this.track(this.enforcing);
  }

  /** Makes room for one more chat within maxChats: the first removable chat
   * goes; too_many when none can. */
  private async roomForChat(): Promise<chat.ChatError | undefined> {
    const max = this.current.maxChats;
    while (this.chats.size >= max) {
      const [victim] = this.removable();
      if (!victim) return perr(chat.Code.TooMany, `the host keeps ${this.chats.size} chats, none closed`);
      this.logf(`chat ${victim.c.id}: removed, the first to go of ${this.chats.size} chats`);
      try {
        await this.forget(victim.c);
      } catch (e) {
        this.logf(`chat ${victim.c.id}: remove: ${(e as Error).message}`);
        return perr(chat.Code.Failed, 'the journal did not remove a chat');
      }
    }
    return undefined;
  }

  /** The closed chats in the order the bounds remove them: the archived ones
   * first, then the others, each the one kept the longest first. */
  private removable(): Removable[] {
    const out: Removable[] = [];
    for (const c of this.chats.values()) {
      if (c.r.chat.state !== chat.State.Closed || c.sess || c.starting || c.deleted) continue;
      const closed = Date.parse(c.r.chat.closed ?? '') || 0;
      const archived = Date.parse(c.r.chat.archived ?? '') || 0;
      out.push({ c, archived: archived > 0, since: Math.max(closed, archived) });
    }
    return out.sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? -1 : 1;
      if (a.since !== b.since) return a.since - b.since;
      return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
    });
  }

  /** Keeps the journal within the settings: closed chats past their
   * retention go, then the removable chats in their order while there are
   * more chats than maxChats or more bytes than maxTotalBytes; when none is
   * left and the bytes are still too many, the largest chats lose their
   * oldest events. */
  private async enforceBounds(): Promise<void> {
    const s = this.current;
    const cutoff = now() - s.retentionDays * this.o.day;
    for (const v of this.removable()) {
      if (v.since >= cutoff) continue;
      this.logf(`chat ${v.c.id}: removed, kept closed more than ${s.retentionDays} days`);
      await this.forget(v.c);
    }
    for (;;) {
      let total = 0;
      let largest: Chat | null = null;
      for (const c of this.chats.values()) {
        total += c.r.bytes;
        if (!largest || c.r.bytes > largest.r.bytes) largest = c;
      }
      if (this.chats.size <= s.maxChats && total <= s.maxTotalBytes) return;
      const [victim] = this.removable();
      if (victim) {
        this.logf(`chat ${victim.c.id}: removed, the first to go (${this.chats.size} chats, ${total} bytes)`);
        await this.forget(victim.c);
        continue;
      }
      if (total <= s.maxTotalBytes || !largest) return;
      const before = largest.r.bytes;
      await largest.trim(Math.max(before - (total - s.maxTotalBytes), 0));
      if (largest.r.bytes >= before) return;
    }
  }
}

/** A refusal of a request. */
const refusal = (code: string, message: string): chat.Response => ({ error: { code, message } });

/** Makes the host's socket (0600) in the run directory, served by accept.
 * Hosts that start at the same time take turns, by a lock on the
 * directory: the second one finds the first one's socket answering. The
 * directory must be the user's alone (0700). */
async function listen(run: string, path: string, accept: (c: Socket) => void): Promise<{ server: Server; ino: bigint }> {
  let fd: number;
  try {
    fd = openSync(run, fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW);
  } catch (e) {
    throw new Error(`chathost: ${run}: ${(e as Error).message}`);
  }
  try {
    const st = statSync(run);
    if (!st.isDirectory() || (st.mode & 0o077) !== 0) throw new Error(`chathost: ${run} is not a directory of the user alone (0700)`);
    if (st.uid !== process.getuid!()) throw new Error(`chathost: ${run} is another user's`);
    const deadline = Date.now() + 10_000;
    while (!tryLock(fd)) {
      if (Date.now() > deadline) throw new Error(`chathost: lock ${run}: another host holds it`);
      await new Promise((r) => setTimeout(r, 50));
    }
    let there = false;
    try {
      const l = lstatSync(path);
      there = true;
      if (!l.isSocket()) throw new Error(`chathost: ${path} is not a socket`);
    } catch (e) {
      if (there) throw e;
    }
    if (there) {
      const answer = await dial(path);
      if (answer === 'connected') throw new RunningError();
      if (answer !== 'refused') throw new RunningError(answer);
      // Nobody listens: the socket of a host that was killed. Renamed over
      // by the new one.
    }
    return await listenUnix(path, accept);
  } finally {
    closeQuietly(fd);
  }
}

/** Whether something answers on the socket at path: connected, refused
 * (nobody listens, or nothing is there), or why it did not answer. */
function dial(path: string): Promise<string> {
  return new Promise((resolve) => {
    const c = connect(path);
    const t = setTimeout(() => {
      c.destroy();
      resolve('no answer in time');
    }, DIAL_MS);
    c.once('connect', () => {
      clearTimeout(t);
      c.destroy();
      resolve('connected');
    });
    c.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(t);
      resolve(e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? 'refused' : e.message);
    });
  });
}
