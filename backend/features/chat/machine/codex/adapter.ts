// The chat host's adapter for Codex (the kinds whose chat spec names the
// adapter codex): `codex app-server --listen stdio://`, protocol v2 with
// experimentalApi, one app-server process per live chat, its threads,
// turns and items as chat events. The app-server's types are generated
// from the schema Codex prints (appserver.gen.ts, spec/codex-app-server).
//
// What the adapter keeps to beyond adapter.ts's rules:
//
//   - Threads start and resume with sandbox "read-only", approval policy
//     "on-request" and the user as reviewer; each turn carries the chat's
//     mode as policies (config.ts policy): a thread started writable would
//     write its directory into ~/.codex/config.toml as trusted. Model and
//     effort go with every turn: thread/start takes no effort.
//   - Approvals map to accept, acceptForSession, decline and cancel; never
//     to the execpolicy or network amendments Codex offers, which it saves.
//   - Images go as data URLs, never as local files (an item keeps only a
//     local image's path).
//   - Codex does not stop a command of a turn it interrupted: when one still
//     runs interruptGrace after the interrupt, the app-server is ended
//     gracefully and started again on the thread, which ends it.
//   - A plan (plan mode's plan item) is approved through a permission of
//     kind plan after its turn ends; approved, the next turn carries it out
//     ("Implement the plan.") in the mode chosen.
//   - The app-server's requests it does not serve get their refusal, or
//     "method not found" (session.ts refuse).
//
// Sessions and history ask a running chat's app-server, else one started
// for the question (a probe), which ends once it answered. A thread another
// Codex process has open (a terminal's) is refused by the app-server, which
// the adapter maps to in_terminal; it cannot tell before (no inTerminal).
import { stat } from 'node:fs/promises';
import { NAME } from '#shared/lib/brand.ts';
import { discard, type Logger } from '#shared/lib/log.ts';
import { formatRFC3339 } from '#shared/lib/gotime.ts';
import { VERSION } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ChatProtoError, Code, EventType, type Event } from '#shared/proto/chatproto/index.ts';
import type { Adapter, HistoryParams, RunParams, Session, SessionsParams, Sink, StartParams } from '../adapter.ts';
import type { AgentProcess } from '../agentproc.ts';
import type { ClientRequests, ThreadItem, Turn } from './appserver.gen.ts';
import {
  ItemType,
  Mapper,
  SubAgent,
  Tool,
  cancelledCall,
  cutText,
  isObj,
  itemTime,
  subAgentCall,
  timeOf,
  turnEnd,
  updateEvent,
  userContent,
  MAX_SESSION_TITLE,
  type Obj,
} from './mapping.ts';
import { ClosedError, Conn } from './rpc.ts';
import { CODEX_TIMING, CodexSession, callError, initialize, refuse, startError, type CodexTiming } from './session.ts';

export { CODEX_TIMING, type CodexTiming } from './session.ts';

/** How many threads a page of sessions lists. */
export const SESSIONS_PAGE = 50;
/** How many turns a page of thread/turns/list holds, and how many pages a
 * history reads at most. */
export const HISTORY_PAGE = 20;
export const HISTORY_PAGES = 500;

export interface CodexAdapterOptions {
  timing?: Partial<CodexTiming>;
}

const logger = (l: Logger | undefined): Logger => l ?? discard;

/** Refuses a command or a directory that is not what the host promises. */
function checkRun(argv: string[], cwd: string): void {
  if (argv.length === 0 || !argv[0]!.startsWith('/') || !cwd.startsWith('/'))
    throw new ChatProtoError({ code: Code.StartFailed, message: 'codex: no command, or a directory that is no absolute path' });
}

/** An app-server to ask, and how to let go of it. */
interface Client {
  conn: Conn;
  done: () => Promise<void>;
}

/** The Codex adapter. */
export function codexAdapter(o: CodexAdapterOptions = {}): Adapter {
  const t: CodexTiming = { ...CODEX_TIMING, ...o.timing };
  const live = new Set<CodexSession>();

  /** An app-server started to answer questions, which done ends. */
  async function probe(p: RunParams, signal: AbortSignal): Promise<Client> {
    if (p.argv.length === 0 || !p.argv[0]!.startsWith('/'))
      throw new ChatProtoError({ code: Code.StartFailed, message: 'codex: no command' });
    // The directory is a parameter of the questions: a process for them runs
    // anywhere, in it while it is there.
    let cwd = p.cwd;
    try {
      if (!(await stat(cwd)).isDirectory()) cwd = '/';
    } catch {
      cwd = '/';
    }
    let proc: AgentProcess;
    try {
      proc = await p.procs.spawn(p.argv, { cwd, env: p.env });
    } catch (e) {
      throw new ChatProtoError({ code: Code.StartFailed, message: (e as Error).message });
    }
    const conn = new Conn(proc, { notification: () => {}, request: refuse }, logger(p.logger));
    const done = async () => {
      await proc.stop(t);
      conn.close();
    };
    try {
      await initialize(conn, { name: NAME, version: VERSION }, AbortSignal.any([signal, AbortSignal.timeout(t.start)]));
    } catch (e) {
      await done();
      throw new ChatProtoError(startError(proc, e));
    }
    return { conn, done };
  }

  /** A running chat's app-server, else one started for the question. */
  async function client(p: RunParams, signal: AbortSignal): Promise<Client> {
    for (const s of live) {
      const conn = s.liveConn;
      if (conn) return { conn, done: async () => {} };
    }
    return probe(p, signal);
  }

  /** Asks c, or a probe when the running chat whose app-server c is ended
   * meanwhile (a question asked whole: the probe's answer is the one). */
  async function ask<T>(p: RunParams, signal: AbortSignal, c: Client, f: (conn: Conn) => Promise<T>): Promise<{ v: T; c: Client }> {
    try {
      return { v: await f(c.conn), c };
    } catch (e) {
      if (!(e instanceof ClosedError)) throw e;
    }
    await c.done();
    const pc = await probe(p, signal);
    try {
      return { v: await f(pc.conn), c: pc };
    } catch (e) {
      await pc.done();
      throw e;
    }
  }

  return {
    async start(p: StartParams, sink: Sink, signal: AbortSignal): Promise<Session> {
      checkRun(p.argv, p.cwd);
      const s = new CodexSession({ ...p, logger: logger(p.logger) }, sink, t, (x) => live.delete(x));
      // Known from the start (its connection is offered to others once its
      // thread exists); forgotten when it ends, also when it did not start.
      live.add(s);
      try {
        await s.connect(p.resume, true, signal);
      } catch (e) {
        await s.close();
        throw e instanceof ChatProtoError ? e : new ChatProtoError(callError(e));
      }
      sink.update(s.chatUpdate());
      return s;
    },

    /** Lists the threads of a directory, the most recent first
     * (thread/list), the subagents' left out. */
    async sessions(p: SessionsParams, signal: AbortSignal) {
      const params: ClientRequests['thread/list']['params'] = {
        cwd: p.cwd,
        limit: SESSIONS_PAGE,
        ...(p.cursor ? { cursor: p.cursor } : {}),
      };
      let c = await client(p, signal);
      try {
        let res: ClientRequests['thread/list']['result'];
        try {
          ({ v: res, c } = await ask(p, signal, c, (conn) => conn.call('thread/list', params, signal)));
        } catch (e) {
          throw new ChatProtoError(callError(e));
        }
        const sessions: chat.Session[] = [];
        for (const th of Array.isArray(res?.data) ? res.data : []) {
          if (!isObj(th) || typeof th.id !== 'string' || th.id === '' || th.ephemeral || th.parentThreadId) continue;
          let title = typeof th.name === 'string' && th.name !== '' ? th.name : typeof th.preview === 'string' ? th.preview : '';
          title = title.trim().split('\n')[0]!;
          const s: chat.Session = { sessionId: th.id, cwd: typeof th.cwd === 'string' && th.cwd !== '' ? th.cwd : p.cwd };
          const cut = cutText(title, MAX_SESSION_TITLE);
          if (cut) s.title = cut;
          if (typeof th.updatedAt === 'number' && th.updatedAt > 0) s.updatedAt = formatRFC3339(new Date(th.updatedAt * 1000));
          sessions.push(s);
        }
        return { sessions, next: typeof res?.nextCursor === 'string' ? res.nextCursor : '' };
      } finally {
        await c.done();
      }
    },

    /** Emits the settled turns of a thread (thread/turns/list with every
     * item), mapped as a live session maps them; after p.after (an item or a
     * turn id an earlier history or the session emitted) only what came
     * after it. A turn still running is left for a later history. Subagents'
     * own threads are not read: their tool calls are. The whole thread
     * starts with an info event of the thread's name, when it has one. */
    async history(p: HistoryParams, emit: (ev: Event) => void, signal: AbortSignal): Promise<void> {
      const c = await client(p, signal);
      try {
        const h = new History(new Mapper(p.cwd), emit);
        // Not asked again of another app-server when this one ends: what was
        // emitted stays.
        try {
          if (p.after === '') {
            const name = await threadName(c.conn, p.sessionId, logger(p.logger), signal);
            if (name !== '') emit({ t: EventType.Info, chat: { title: name } as chat.Chat });
            await h.forward(c.conn, p.sessionId, signal);
          } else {
            await h.since(c.conn, p.sessionId, p.after, logger(p.logger), signal);
          }
        } catch (e) {
          throw e instanceof ChatProtoError ? e : new ChatProtoError(callError(e));
        }
      } finally {
        await c.done();
      }
    },
  };
}

/** The name a thread was given (by the user, or by Codex), read with
 * thread/list restricted to the thread's id: not its preview, which is its
 * first prompt. "" for none, or when it cannot be read. */
async function threadName(c: Conn, thread: string, log: Logger, signal: AbortSignal): Promise<string> {
  let res: ClientRequests['thread/list']['result'];
  try {
    res = await c.call('thread/list', { includedThreadIds: [thread], limit: 1 }, signal);
  } catch (e) {
    log(`codex: the name of thread ${thread}: ${(e as Error).message}`);
    return '';
  }
  for (const th of Array.isArray(res?.data) ? res.data : [])
    if (isObj(th) && th.id === thread && typeof th.name === 'string')
      return cutText(th.name.trim().split('\n')[0]!.trim(), MAX_SESSION_TITLE);
  return '';
}

/** A thread's settled turns as an import's events. */
export class History {
  private readonly m: Mapper;
  private readonly emit: (ev: Event) => void;

  constructor(m: Mapper, emit: (ev: Event) => void) {
    this.m = m;
    this.emit = emit;
  }

  private async page(c: Conn, thread: string, direction: 'asc' | 'desc', cursor: string, signal: AbortSignal) {
    const res = await c.call(
      'thread/turns/list',
      { threadId: thread, limit: HISTORY_PAGE, sortDirection: direction, itemsView: 'full', ...(cursor ? { cursor } : {}) },
      signal,
    );
    return {
      data: Array.isArray(res?.data) ? res.data.filter(isObj) : [],
      next: typeof res?.nextCursor === 'string' ? res.nextCursor : '',
    };
  }

  /** Emits every settled turn, oldest first. */
  async forward(c: Conn, thread: string, signal: AbortSignal): Promise<void> {
    let cursor = '';
    for (let i = 0; i < HISTORY_PAGES; i++) {
      const res = await this.page(c, thread, 'asc', cursor, signal);
      for (const t of res.data) {
        if (t.status === 'inProgress') return;
        this.turn(t, '');
      }
      if (res.next === '') return;
      cursor = res.next;
    }
  }

  /** Emits what came after the turn or the item after: the turns are read
   * newest first until the one that has it. */
  async since(c: Conn, thread: string, after: string, log: Logger, signal: AbortSignal): Promise<void> {
    const later: Turn[] = [];
    let cursor = '';
    for (let i = 0; i < HISTORY_PAGES; i++) {
      const res = await this.page(c, thread, 'desc', cursor, signal);
      for (const t of res.data) {
        if (t.id === after) return this.replay(later, '');
        if (hasItem(t, after)) return this.replay([...later, t], after);
        later.push(t);
      }
      if (res.next === '') break;
      cursor = res.next;
    }
    log(`codex: history of ${thread}: ${JSON.stringify(cutText(after, 64))} is not in the thread; nothing emitted`);
  }

  /** Emits turns read newest first, oldest first; the oldest from after its
   * item after when after is not "". */
  private replay(newestFirst: Turn[], after: string): void {
    for (let i = newestFirst.length - 1; i >= 0; i--) {
      const t = newestFirst[i]!;
      if (t.status === 'inProgress') return;
      this.turn(t, i === newestFirst.length - 1 ? after : '');
    }
  }

  /** Emits a turn: its start, its items (those after the item after, when
   * after is not ""), its end. */
  private turn(t: Turn, after: string): void {
    let at = typeof t.startedAt === 'number' && t.startedAt > 0 ? t.startedAt * 1000 : undefined;
    if (after === '')
      this.emit({
        t: EventType.Turn,
        ...(timeOf(at) ? { at: timeOf(at) } : {}),
        state: chat.TurnState.Start,
        ...(t.id ? { item: t.id } : {}),
      });
    let skipping = after !== '';
    const spawns = new Map<string, Obj>();
    for (const it of (Array.isArray(t.items) ? t.items : []) as ThreadItem[]) {
      if (!isObj(it) || typeof it.id !== 'string' || it.id === '') continue;
      if (skipping) {
        skipping = it.id !== after;
        continue;
      }
      at = itemTime(it, at);
      if (it.type === ItemType.UserMessage) {
        this.emit({ t: EventType.User, ...(timeOf(at) ? { at: timeOf(at) } : {}), item: it.id, content: userContent(it.content) });
        continue;
      }
      if (it.type === ItemType.SubAgent) {
        if (it.kind === SubAgent.Started) {
          const u = subAgentCall(it, Tool.Completed);
          spawns.set(it.agentThreadId, u);
          this.emit(updateEvent(it.id, '', false, u, at));
        } else if (it.kind === SubAgent.Stopped) {
          const s = spawns.get(it.agentThreadId);
          if (s) {
            const u = cancelledCall(s);
            this.emit(updateEvent(u.toolCallId as string, '', false, u, at));
          }
        }
        continue;
      }
      for (const ev of this.m.itemEvents(it, true, '', at) ?? []) this.emit(ev);
    }
    const end = typeof t.completedAt === 'number' && t.completedAt > 0 ? t.completedAt * 1000 : at;
    this.emit(turnEnd(t, null, end));
  }
}

function hasItem(t: Turn, id: string): boolean {
  return (Array.isArray(t.items) ? t.items : []).some((it) => isObj(it) && it.id === id);
}
