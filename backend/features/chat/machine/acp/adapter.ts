// The chat host's adapter for the agents that speak the Agent Client
// Protocol on their standard input and output: Antigravity (`agy acp --stdio`),
// Kimi Code (`kimi acp`) and Grok (`grok agent --no-leader stdio`), the kinds
// whose chat spec names the adapter acp.
//
// A chat's agent runs as one process with one session: a new one
// (session/new, with the chat spec's _meta), or the chat's earlier one
// taken up by its id: session/resume, which replays nothing, where the
// agent has it (falling back to session/load if resume reports an internal
// read error), else session/load, whose replay the adapter drops (the
// chat's log has it). The client states neither the fs nor the terminal
// capability and answers every other request of the agent with "method not
// found"; a permission's options that allow or reject for good are not
// offered (an agent may keep them in its own settings). The protocol has a
// turn per prompt: a prompt while a turn runs waits in the adapter and is
// sent when the turn ends.
//
// Sessions, models, fork and history ask an agent process of their own (a
// probe), which ends once it answered: session/list (filtered by cwd for
// agents that return every workspace's sessions), session/new + session/close
// for Op.Models, session/fork where supported, and session/load, whose replay
// is an import's events. A replay is the agent's own account of the session:
// what it injected into the user's messages, merged or left out (Kimi Code's
// leaves images out, merges a cancelled prompt with the next, and numbers
// tool calls anew), so an import starts with a notice that it is one. An
// ACP agent cannot tell that a terminal runs a session (no inTerminal).
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { NAME } from '#shared/lib/brand.ts';
import { discard, type Logger } from '#shared/lib/log.ts';
import { formatRFC3339, parseRFC3339 } from '#shared/lib/gotime.ts';
import { Notice, VERSION, noticeMethod } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ChatProtoError, Code, EventType, TurnState, type Event } from '#shared/proto/chatproto/index.ts';
import type {
  Adapter,
  ForkParams,
  ForkResult,
  HistoryParams,
  ModelsParams,
  RunParams,
  Session,
  SessionsParams,
  Sink,
  StartParams,
} from '../adapter.ts';
import type { AgentProcess } from '../agentproc.ts';
import { Items, contentUpdate } from './items.ts';
import { Conn, initialize, permissionCancelled, RequestError, type Handler, type InitializeResult } from './rpc.ts';
import { ACP_TIMING, AcpSession, callError, startError, type AcpTiming } from './session.ts';
import { clip, isObj, modelOptions, str, type Obj } from './state.ts';

export { ACP_TIMING, type AcpTiming } from './session.ts';

/** The most sessions a page of sessions lists. */
export const MAX_SESSIONS = 1000;
/** The most of an import held before it is handed on, in bytes: the events
 * of a turn wait for its end, so that a tool call is stored once, with its
 * last state, unless a turn is longer than this. */
export const HISTORY_BYTES = 32 << 20;
/** Bounds the pages of session/list a title is looked for in. */
const TITLE_PAGES = 10;
const TITLE_RUNES = 200;

export interface AcpAdapterOptions {
  timing?: Partial<AcpTiming>;
  /** The start of the ids of a session's items: random by default, so that
   * those of the processes a chat runs one after the other differ (tests
   * fix it). */
  itemPrefix?: () => string;
}

const randomPrefix = () => randomBytes(4).toString('hex');

/** Refuses a command or a directory that is not what the host promises. */
function checkRun(argv: string[], cwd: string): void {
  if (argv.length === 0 || !argv[0]!.startsWith('/') || !cwd.startsWith('/'))
    throw new ChatProtoError({ code: Code.BadRequest, message: "the agent's command or directory is no absolute path" });
}

const logger = (l: Logger | undefined): Logger => l ?? discard;

/** Cleans a POSIX directory path for comparison. */
function cleanDir(p: string): string {
  const n = posix.normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

/** Resolves a directory path to its canonical form (with clean fallback if
 * the path does not exist on disk). */
async function canonicalDir(p: string): Promise<string> {
  if (!p) return '';
  const c = cleanDir(p);
  try {
    return cleanDir(await realpath(c));
  } catch {
    return c;
  }
}

/** An agent process that answers a question (sessions, history) and ends. */
class Probe {
  readonly proc: AgentProcess;
  readonly conn: Conn;
  private readonly t: AcpTiming;

  constructor(proc: AgentProcess, conn: Conn, t: AcpTiming) {
    this.proc = proc;
    this.conn = conn;
    this.t = t;
  }

  /** Ends the probe's agent gracefully and resolves once it is gone. */
  async end(): Promise<void> {
    await this.proc.stop(this.t);
    this.conn.close();
  }
}

/** A probe's handler: its notifications to notify; the agent's requests
 * get nothing but a cancelled permission and "method not found". */
function probeHandler(notify?: (method: string, params: unknown) => void): Handler {
  return {
    notification: (method, params) => notify?.(method, params),
    request: async (method) => {
      if (method === 'session/request_permission') return permissionCancelled();
      throw RequestError.methodNotFound(method);
    },
  };
}

/** The ACP adapter. */
export function acpAdapter(o: AcpAdapterOptions = {}): Adapter {
  const t: AcpTiming = { ...ACP_TIMING, ...o.timing };
  const itemPrefix = o.itemPrefix ?? randomPrefix;

  /** Runs the agent and initializes it. */
  async function startProbe(p: RunParams, h: Handler, signal: AbortSignal): Promise<{ pr: Probe; init: InitializeResult }> {
    checkRun(p.argv, p.cwd);
    let proc: AgentProcess;
    try {
      proc = await p.procs.spawn(p.argv, { cwd: p.cwd, env: p.env });
    } catch (e) {
      throw new ChatProtoError({ code: Code.StartFailed, message: (e as Error).message });
    }
    const pr = new Probe(proc, new Conn(proc, h, { name: NAME, logger: logger(p.logger) }), t);
    try {
      const init = await initialize(pr.conn, { name: NAME, version: VERSION }, t.initialize, signal);
      return { pr, init };
    } catch (e) {
      await pr.end();
      const err = startError(signal, e);
      const stderr = proc.stderr();
      throw new ChatProtoError({ ...err, ...(stderr ? { stderr } : {}) });
    }
  }

  return {
    async start(p: StartParams, sink: Sink, signal: AbortSignal): Promise<Session> {
      checkRun(p.argv, p.cwd);
      const s = new AcpSession(p.kind, logger(p.logger), sink, t, itemPrefix());
      let proc: AgentProcess;
      try {
        proc = await p.procs.spawn(p.argv, { cwd: p.cwd, env: p.env });
      } catch (e) {
        throw new ChatProtoError({ code: Code.StartFailed, message: (e as Error).message });
      }
      s.attach(proc, p.client.name);
      try {
        await s.open(p, signal);
      } catch (err) {
        s.markClosing();
        void proc.stop(t);
        await s.done;
        const e = startError(signal, err);
        const stderr = proc.stderr();
        if (stderr) e.stderr = stderr;
        if (e.code === Code.StartFailed && e.message === '') {
          e.message = 'the agent exited before its session existed';
          const st = proc.status();
          if (st) e.message += ` (${st})`;
        }
        throw new ChatProtoError(e);
      }
      return s;
    },

    /** Lists the sessions the agent kept for a directory (session/list),
     * filtering out sessions from other workspaces for agents (like agy) whose
     * session/list ignores the cwd parameter. */
    async sessions(p: SessionsParams, signal: AbortSignal) {
      const { pr, init } = await startProbe(p, probeHandler(), signal);
      try {
        if (!init.capabilities.list) throw new ChatProtoError({ code: Code.Unsupported, message: 'the agent cannot list its sessions' });
        let res: unknown;
        try {
          res = await pr.conn.call('session/list', { cwd: p.cwd, ...(p.cursor ? { cursor: p.cursor } : {}) }, { ms: t.session, signal });
        } catch (e) {
          throw new ChatProtoError(callError(e));
        }
        const page = listPage(res);
        if (!page) throw new ChatProtoError({ code: Code.Failed, message: 'acp: session/list: a malformed answer' });
        const wantClean = cleanDir(p.cwd);
        const wantReal = await canonicalDir(p.cwd);
        const dirCache = new Map<string, Promise<string>>();
        const matchesCwd = async (dir: string): Promise<boolean> => {
          if (dir === '') return true;
          const dc = cleanDir(dir);
          if (dc === wantClean || dc === wantReal) return true;
          let prDir = dirCache.get(dc);
          if (!prDir) {
            prDir = canonicalDir(dc);
            dirCache.set(dc, prDir);
          }
          const dr = await prDir;
          return dr === wantClean || dr === wantReal;
        };
        const out: Array<{ s: chat.Session; at: number }> = [];
        for (const si of page.sessions) {
          if (si.sessionId === '' || out.length === MAX_SESSIONS) continue;
          if (!(await matchesCwd(si.cwd))) continue;
          const at = parseRFC3339(si.updatedAt);
          const s: chat.Session = { sessionId: si.sessionId, cwd: si.cwd };
          const title = clip(si.title, TITLE_RUNES);
          if (title) s.title = title;
          if (at) s.updatedAt = formatRFC3339(at);
          out.push({ s, at: at ? at.getTime() : -Infinity });
        }
        // The most recent first, those without a time last.
        out.sort((x, y) => (y.at === x.at ? 0 : y.at > x.at ? 1 : -1));
        return { sessions: out.map((x) => x.s), next: page.nextCursor };
      } finally {
        await pr.end();
      }
    },

    /** Probes available models via initialize -> session/new -> session/close. */
    async models(p: ModelsParams, signal: AbortSignal): Promise<chat.ModelOption[]> {
      const { pr, init } = await startProbe(p, probeHandler(), signal);
      let sid = '';
      try {
        let res: unknown;
        try {
          res = await pr.conn.call('session/new', { cwd: p.cwd, mcpServers: [] }, { ms: t.session, signal });
        } catch (e) {
          throw new ChatProtoError(callError(e));
        }
        const r: Obj = isObj(res) ? res : {};
        if (typeof r.sessionId === 'string') sid = r.sessionId;
        return modelOptions(r.configOptions, r.models, init.capabilities.image);
      } finally {
        if (sid && init.capabilities.close && !pr.conn.ended) {
          try {
            await pr.conn.call('session/close', { sessionId: sid }, { ms: Math.min(t.grace, 2000) });
          } catch {
            // best-effort graceful close
          }
        }
        await pr.end();
      }
    },

    /** Forks an existing session via session/fork where the agent advertises
     * sessionCapabilities.fork; throws Unsupported for partial forks (ACP
     * session/fork always clones the full session) or agents without fork so
     * the host falls back to a consistent context-seeded fork. */
    async fork(p: ForkParams, signal: AbortSignal): Promise<ForkResult> {
      if (p.partial || p.upToMessageId || p.beforeTurnId || p.lastTurnId) {
        throw new ChatProtoError({ code: Code.Unsupported, message: 'ACP session/fork does not support partial history forks' });
      }
      const { pr, init } = await startProbe(p, probeHandler(), signal);
      try {
        if (!init.capabilities.fork) throw new ChatProtoError({ code: Code.Unsupported, message: 'the agent cannot fork a session' });
        let res: unknown;
        try {
          res = await pr.conn.call('session/fork', { sessionId: p.sessionId, cwd: p.cwd, mcpServers: [] }, { ms: t.session, signal });
        } catch (e) {
          throw new ChatProtoError(callError(e));
        }
        if (!isObj(res) || typeof res.sessionId !== 'string' || res.sessionId === '') {
          throw new ChatProtoError({ code: Code.Failed, message: 'acp: session/fork: an answer without a sessionId' });
        }
        if (init.capabilities.close && !pr.conn.ended) {
          try {
            await pr.conn.call('session/close', { sessionId: res.sessionId }, { ms: Math.min(t.grace, 2000) });
          } catch {
            // best-effort graceful close
          }
        }
        return { sessionId: res.sessionId };
      } finally {
        await pr.end();
      }
    },

    /** Emits a session's earlier conversation from the agent's replay of it
     * (session/load), after a notice that it is an import and an info event
     * of the title the agent lists the session with (none of either when
     * p.after names where an earlier import ended). Items are numbered by
     * their place in the replay, so that p.after finds where an earlier
     * import of the session ended: what comes after the turn that holds it
     * is emitted; nothing when the replay has no such item. */
    async history(p: HistoryParams, emit: (ev: Event) => void, signal: AbortSignal): Promise<void> {
      const h = new History(p.after, emit);
      const { pr, init } = await startProbe(
        p,
        probeHandler((method, params) => {
          if (method !== 'session/update' || !isObj(params) || params.sessionId !== p.sessionId) return;
          const u = params.update;
          if (!isObj(u) || typeof u.sessionUpdate !== 'string' || !contentUpdate(u.sessionUpdate)) return;
          h.update(u.sessionUpdate, u);
        }),
        signal,
      );
      try {
        if (!init.capabilities.loadSession)
          throw new ChatProtoError({ code: Code.Unsupported, message: 'the agent cannot load a session' });
        if (p.after === '') {
          emit({ t: EventType.Notice, method: noticeMethod(Notice.Imported), params: { lossy: true } });
          const title = await sessionTitle(pr, init, p, logger(p.logger), signal);
          if (title) emit({ t: EventType.Info, chat: { title } as chat.Chat });
        }
        try {
          await pr.conn.call('session/load', { sessionId: p.sessionId, cwd: p.cwd, mcpServers: [] }, { ms: t.load, signal });
        } catch (e) {
          throw new ChatProtoError(callError(e));
        }
        if (!h.finish())
          logger(p.logger)(
            `acp ${p.kind}: the import's last item ${JSON.stringify(p.after)} is not in the replay of ${p.sessionId}: nothing imported`,
          );
      } finally {
        h.close();
        await pr.end();
      }
    },
  };

  /** The title the agent lists a session with (session/list of the
   * session's directory, until the page that has it); "" for none, for an
   * agent that cannot list its sessions, or when listing fails. */
  async function sessionTitle(pr: Probe, init: InitializeResult, p: HistoryParams, log: Logger, signal: AbortSignal): Promise<string> {
    if (!init.capabilities.list) return '';
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(t.session)]);
    let cursor = '';
    for (let i = 0; i < TITLE_PAGES; i++) {
      let page;
      try {
        page = listPage(await pr.conn.call('session/list', { cwd: p.cwd, ...(cursor ? { cursor } : {}) }, { signal: deadline }));
      } catch (e) {
        log(`acp ${p.kind}: the title of ${p.sessionId}: ${(e as Error).message}`);
        return '';
      }
      if (!page) return '';
      for (const si of page.sessions) if (si.sessionId === p.sessionId) return clip(si.title.trim(), TITLE_RUNES);
      if (page.nextCursor === '' || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
    return '';
  }
}

interface SessionInfo {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: string;
}

/** A page of session/list's answer; null for a malformed one. */
function listPage(res: unknown): { sessions: SessionInfo[]; nextCursor: string } | null {
  if (!isObj(res)) return null;
  const nextCursor = str(res.nextCursor);
  if (nextCursor === undefined || (res.sessions !== undefined && res.sessions !== null && !Array.isArray(res.sessions))) return null;
  const sessions: SessionInfo[] = [];
  for (const si of (res.sessions as unknown[] | null | undefined) ?? []) {
    if (si === null) continue;
    if (!isObj(si)) return null;
    const f = [str(si.sessionId), str(si.cwd), str(si.title), str(si.updatedAt)];
    if (f.some((v) => v === undefined)) return null;
    sessions.push({ sessionId: f[0]!, cwd: f[1]!, title: f[2]!, updatedAt: f[3]! });
  }
  return { sessions, nextCursor };
}

/** A session's replay as an import's events: a turn from each user message
 * to the next, its items stored once each. */
export class History {
  private readonly it: Items;
  private readonly emit: (ev: Event) => void;
  private readonly after: string;
  /** after was met, and the rest of its turn is being passed over. */
  private found = false;
  private skip = false;
  private inTurn = false;
  private closed = false;
  private buf: Event[] = [];
  /** A tool call's event in buf. */
  private tools = new Map<string, number>();
  private bytes = 0;

  constructor(after: string, emit: (ev: Event) => void) {
    this.after = after;
    this.emit = emit;
    this.it = new Items('h', false, (ev, tool) => this.store(ev, tool));
    this.it.user = (content) => this.user(content);
  }

  update(kind: string, raw: Obj): void {
    if (!this.closed) this.it.update(kind, raw);
  }

  /** Holds an event of the turn; a tool call's replaces the one of the same
   * call. */
  private store(ev: Event, tool: string): void {
    const size = JSON.stringify(ev.update ?? null).length;
    if (tool !== '') {
      const i = this.tools.get(tool);
      if (i !== undefined) {
        this.bytes += size - JSON.stringify(this.buf[i]!.update ?? null).length;
        this.buf[i] = ev;
        return;
      }
      this.tools.set(tool, this.buf.length);
    }
    this.buf.push(ev);
    this.bytes += size;
    if (this.bytes > HISTORY_BYTES) this.flush();
  }

  /** Starts a turn with a user's message. */
  private user(content: unknown[]): void {
    this.endTurn();
    if (content.length > 0) this.deliver({ t: EventType.User, content });
    this.deliver({ t: EventType.Turn, state: TurnState.Start });
    this.inTurn = true;
  }

  private endTurn(): void {
    this.it.endTurn();
    if (this.inTurn) {
      this.buf.push({ t: EventType.Turn, state: TurnState.End, stopReason: 'end_turn' });
      this.inTurn = false;
    }
    this.flush();
  }

  private flush(): void {
    const buf = this.buf;
    this.buf = [];
    this.tools = new Map();
    this.bytes = 0;
    for (const ev of buf) this.deliver(ev);
  }

  /** Hands an event on, but for what an earlier import has: up to after,
   * and the rest of its turn. */
  private deliver(ev: Event): void {
    if (this.after !== '' && !this.found) {
      if (ev.item === this.after) {
        this.found = true;
        this.skip = true;
      }
      return;
    }
    if (this.skip) {
      if (ev.t !== EventType.User && !(ev.t === EventType.Turn && ev.state === TurnState.Start)) return;
      this.skip = false;
    }
    this.emit(ev);
  }

  /** Ends the replay; false when after was not met. */
  finish(): boolean {
    if (!this.closed) {
      this.it.close();
      this.endTurn();
      this.closed = true;
    }
    return this.after === '' || this.found;
  }

  /** Takes nothing more. */
  close(): void {
    this.closed = true;
  }
}
