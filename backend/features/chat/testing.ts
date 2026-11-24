// Helpers of the chat feature's tests, never used by the product: a chat
// host in memory (FakeChatHost) that the machines' fake agents give the
// core with the open action, as the machine side does, and that records
// what it gets; a page's WebSocket over a channel pair whose page can stop
// taking messages; and a core with machines gpu (connected) and box
// (disabled) that runs them.
import { discard } from '#shared/lib/log.ts';
import { write, type Reader } from '#shared/lib/streamio.ts';
import { Op, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import type { Stream } from '#shared/proto/yamux.ts';
import { channelPair, type Channel, type ChannelHandlers, type Message } from '#kernel/channel.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { toggles } from '#kernel/config/toggles.ts';
import { createCore, type Core } from '#kernel/core.ts';
import { Guard } from '#kernel/http/guard.ts';
import type { Machines } from '#kernel/machines/manager.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { agentDialer, memoryAudit, running, sshSpec, testMachines, waitFor } from '#kernel/testing.ts';
import { chatFeature, type ChatFeature } from './core.ts';
import type { ChatHub } from './hub.ts';
import { NOT_RUNNING } from './protocol.ts';
import { settings as chatSettings } from './settings.ts';
import type { Limits, Timing } from './timing.ts';

/** Durations short enough for tests. */
export const FAST: Partial<Timing> = { tickMs: 5, retryMs: 10, againMs: 10 };

/** One connection to the fake host. */
export class HostSide {
  readonly stream: Stream;
  readonly reader: Reader;

  constructor(conn: AgentStream) {
    this.stream = conn.stream;
    this.reader = conn.reader;
  }

  /** Writes v as a line; a write that does not go through within ms ends
   * the connection, as the host drops a subscriber that falls behind. */
  async write(v: unknown, ms = 10_000): Promise<boolean> {
    if (this.stream.destroyed) return false;
    const timer = setTimeout(() => this.stream.destroy(), ms);
    try {
      await write(this.stream, chat.line(v));
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A machine's chat host in memory: chatproto over the agent's streams. */
export class FakeChatHost {
  /** A host serves (an open without start gets not_running otherwise);
   * proto and pid are what its hello states. */
  running = true;
  proto = chat.PROTO;
  pid = 1;
  /** An event that a connection does not take within it ends that
   * connection; 0 waits 10 s. */
  dropAfterMs = 0;
  /** Fails every open with that code. */
  openErr = '';
  /** The start flags of the opens; every request; every command. */
  readonly opens: boolean[] = [];
  readonly requests: chat.Request[] = [];
  readonly commands: chat.Command[] = [];
  readonly chats = new Map<string, chat.Chat>();
  states: chat.ChatState[] = [];
  readonly agents = new Map<string, boolean>();
  sessions: chat.Session[] = [];
  trusted: chat.TrustedFolder[] = [];
  hostStatus: chat.HostStatus | undefined;
  /** Refuses the requests of an op; answers the commands of an op with an
   * error; holdAcks keeps every ack until released. */
  readonly reqErr = new Map<string, chat.ChatError>();
  readonly ackErr = new Map<string, chat.ChatError>();
  holdAcks = false;
  readonly held: Array<() => void> = [];
  readonly watchers = new Set<HostSide>();
  readonly attached = new Map<HostSide, string>();
  readonly conns = new Set<HostSide>();

  /** Serves a stream the core opened on a machine (the agent's part). */
  async serve(h: Header, conn: AgentStream): Promise<void> {
    const reply = async (r: Reply) => {
      await writeLine(conn.stream, r).catch(() => {});
      conn.reader.release().resume();
      closeStream(conn.stream);
    };
    if (h.op !== Op.Plugin || h.plugin !== 'chat' || h.action !== 'open') return reply({ ok: false, error: 'unsupported op' });
    const start = (h.params as { start?: boolean } | undefined)?.start !== false;
    this.opens.push(start);
    if (this.openErr) return reply({ ok: false, code: this.openErr, error: 'refused' });
    if (!this.running && !start) return reply({ ok: false, code: NOT_RUNNING, error: 'no chat host' });
    this.running = true;
    await writeLine(conn.stream, { ok: true } satisfies Reply);
    const c = new HostSide(conn);
    this.conns.add(c);
    try {
      await this.session(c);
    } catch {
      // the connection ended
    } finally {
      this.conns.delete(c);
      this.watchers.delete(c);
      this.attached.delete(c);
      if (!conn.stream.destroyed) {
        conn.reader.release().resume();
        closeStream(conn.stream);
      }
    }
  }

  private async session(c: HostSide): Promise<void> {
    if (!(await c.write({ host: { proto: this.proto, version: 'test', pid: this.pid } }))) return;
    const req = JSON.parse((await chat.readLine(c.reader)).toString('utf8')) as chat.Request;
    this.requests.push(req);
    const refused = this.reqErr.get(req.op);
    if (refused) return void (await c.write({ error: refused }));
    switch (req.op) {
      case chat.Op.Agents: {
        const agents = (req.kinds ?? []).map((k) => ({ kind: k, available: this.agents.get(k) ?? false }));
        agents.push({ kind: 'notakind', available: true });
        return void (await c.write({ ok: true, agents }));
      }
      case chat.Op.Chats:
        return void (await c.write({ ok: true, chats: [...this.chats.values()] }));
      case chat.Op.Sessions:
        return void (await c.write({ ok: true, sessions: this.sessions, nextCursor: 'next' }));
      case chat.Op.New: {
        const ch = testChat({ id: chat.newChatID(), kind: req.kind ?? '', cwd: req.cwd ?? '', state: chat.State.Starting });
        this.chats.set(ch.id, ch);
        return void (await c.write({ ok: true, chat: ch }));
      }
      case chat.Op.Trusted:
        return void (await c.write({ ok: true, trusted: [...this.trusted] }));
      case chat.Op.HostStatus:
        return void (await c.write({
          ok: true,
          hostStatus: this.hostStatus ?? {
            proto: this.proto,
            version: 'test',
            pid: this.pid,
            startedAt: '2026-01-01T00:00:00Z',
            conns: 1,
            watchers: 0,
            liveAgents: 0,
            totalChats: this.chats.size,
            totalBytes: 0,
            ending: 0,
            settings: chat.defaultHostSettings(),
            sessions: [],
          },
        }));
      case chat.Op.Shutdown:
        this.running = false;
        return void (await c.write({ ok: true }));
      case chat.Op.Watch:
        // Listed and answered at once: a change comes after the states.
        this.watchers.add(c);
        if (!(await c.write({ ok: true, states: [...this.states] }))) return;
        while ((await c.reader.chunk()) !== null);
        return;
      case chat.Op.Attach: {
        const ch = this.chats.get(req.chat ?? '');
        if (!ch) return void (await c.write({ error: { code: chat.Code.UnknownChat, message: 'no such chat' } }));
        if (!(await c.write({ ok: true, chat: ch, first: 1 }))) return;
        this.attached.set(c, req.chat!);
        for (;;) {
          const cmd = JSON.parse((await chat.readLine(c.reader)).toString('utf8')) as chat.Command;
          this.commands.push(cmd);
          const e = this.ackErr.get(cmd.op);
          const ack = () => void c.write({ t: chat.EventType.Ack, id: cmd.id, ...(e ? { error: e } : {}) });
          if (this.holdAcks) this.held.push(ack);
          else ack();
        }
      }
    }
    await c.write({ ok: true });
  }

  /** Writes an event to every connection attached to chat; one that does
   * not take it within dropAfterMs is ended. */
  async emit(id: string, ev: chat.Event): Promise<void> {
    const to = [...this.attached].filter(([, c]) => c === id).map(([s]) => s);
    await Promise.all(to.map((s) => s.write(ev, this.dropAfterMs || 10_000)));
  }

  /** How many connections are attached to chat. */
  attachedTo(id: string): number {
    return [...this.attached.values()].filter((c) => c === id).length;
  }

  /** Sets a chat's state and tells the watchers. */
  change(st: chat.ChatState): void {
    const i = this.states.findIndex((s) => s.id === st.id);
    if (st.state === chat.State.Deleted) {
      if (i >= 0) this.states.splice(i, 1);
    } else if (i >= 0) this.states[i] = st;
    else this.states.push(st);
    for (const c of this.watchers) void c.write(st);
  }

  /** Ends every connection: the host ended. running says whether another
   * serves. */
  end(running: boolean): void {
    this.running = running;
    for (const c of this.conns) c.stream.destroy();
  }

  /** The ops of the requests so far, from the n-th on. */
  ops(from = 0): string[] {
    return this.requests.slice(from).map((r) => r.op);
  }

  count(op: string): number {
    return this.requests.filter((r) => r.op === op).length;
  }
}

/** A chat as the host states it, with what it does not say. */
export function testChat(c: Partial<chat.Chat> & { id: string }): chat.Chat {
  return {
    kind: 'codex',
    title: '',
    cwd: '/w',
    sessionId: '',
    state: chat.State.Idle,
    status: chat.Status.Idle,
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    seq: 0,
    seen: 0,
    capabilities: {
      images: false,
      compact: false,
      queue: false,
      plan: false,
      questions: false,
      effort: false,
      model: false,
      cancelQueued: false,
    },
    ...c,
  } as chat.Chat;
}

/** A chat state of claude in /w. */
export function chatState(status: string, state: string, seq: number): chat.ChatState {
  return {
    id: chat.newChatID(),
    kind: 'claude',
    title: 't',
    cwd: '/w',
    state,
    status,
    updated: '2026-01-01T00:00:00Z',
    seq,
    sessionId: '',
  };
}

/** A message of the page as the tests read it. */
export type Msg = Record<string, unknown>;

/** The code of a message's error, undefined for none. */
export const errCode = (m: Msg): unknown => (m.error as { code?: unknown } | undefined)?.code;

/** A page's WebSocket over a channel pair. While paused the page takes
 * nothing: what the core sends stays buffered in the channel. */
export class TestPage {
  private readonly q: Msg[] = [];
  private wake: (() => void) | null = null;
  ended = false;
  closeCode = 0;
  private ch!: Channel;
  private core!: ChannelHandlers;
  private held: Message[] = [];
  private heldBytes = 0;
  private paused = false;
  private toPage!: Channel;

  static async open(r: Rig): Promise<TestPage> {
    const p = new TestPage();
    const { a, b } = channelPair();
    const res = await r.request('GET', '/api/p/chat/ws', {
      upgrade: (open) => {
        p.toPage = b;
        const side: Channel = {
          send: (d) => {
            if (!p.paused) return b.send(d);
            p.held.push(d);
            p.heldBytes += typeof d === 'string' ? Buffer.byteLength(d) : d.length;
          },
          get buffered() {
            return p.heldBytes;
          },
          close: (code, reason) => b.close(code, reason),
        };
        b.adopt(() => (p.core = open(side)));
        return new Response(null);
      },
    });
    if (res.status !== 200) throw new Error(`upgrade: ${res.status} ${await res.text()}`);
    a.adopt((ch) => {
      p.ch = ch;
      return {
        message: (d) => {
          p.q.push(JSON.parse(d as string));
          p.wake?.();
        },
        close: (code) => {
          p.ended = true;
          p.closeCode = code;
          p.wake?.();
        },
      };
    });
    return p;
  }

  /** Stops or starts taking messages. */
  pause(on: boolean): void {
    this.paused = on;
    if (on) return;
    const held = this.held;
    this.held = [];
    this.heldBytes = 0;
    for (const d of held) this.toPage.send(d);
    this.core.drain?.();
  }

  send(v: unknown): void {
    this.ch.send(JSON.stringify(v));
  }

  sendRaw(text: string): void {
    this.ch.send(text);
  }

  close(): void {
    this.ch.close();
  }

  /** The next message. */
  async next(timeoutMs = 5000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = this.q.shift();
      if (m) return m;
      if (this.ended) throw new Error(`the channel closed (${this.closeCode})`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('no message in time');
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.wake = () => {
          clearTimeout(t);
          this.wake = null;
          r();
        };
      });
    }
  }

  /** The next message, which must be of type t. */
  async expect(t: string): Promise<Msg> {
    const m = await this.next();
    if (m.t !== t) throw new Error(`got ${JSON.stringify(m)}, not ${t}`);
    return m;
  }

  /** Waits until the channel closed. */
  async closed(timeoutMs = 5000): Promise<number> {
    await waitFor('the channel to close', () => this.ended, timeoutMs);
    return this.closeCode;
  }

  get pending(): number {
    return this.q.length;
  }
}

export interface RigOptions {
  readOnly?: boolean;
  timing?: Partial<Timing>;
  limits?: Partial<Limits>;
  /** This core's build (the chat host's is "test"). */
  version?: string;
  /** Prepares the host before the machines connect. */
  host?: (h: FakeChatHost) => void;
}

export interface Rig {
  core: Core;
  host: FakeChatHost;
  hub: ChatHub;
  machines: Machines;
  settings: Settings;
  audit: ReturnType<typeof memoryAudit>;
  /** The states messages and the agent events the pages got. */
  broadcasts: Array<{ m: string; data: Record<string, unknown> }>;
  notes: Array<Record<string, unknown>>;
  /** Moves the clock ahead. */
  advance(ms: number): void;
  request(
    method: string,
    path: string,
    o?: { body?: string; origin?: string; upgrade?: Parameters<Core['fetch']>[1]['upgrade'] },
  ): Promise<Response>;
  /** Calls a route: its status and its answer. */
  call(method: string, path: string, body?: string): Promise<[number, Record<string, unknown>]>;
  page(): Promise<TestPage>;
  /** Runs the watches until stop. */
  start(): void;
  /** Connects or disconnects a machine. */
  setEnabled(m: string, on: boolean): Promise<void>;
  /** The last audit record. */
  lastAudit(): Record<string, unknown> | undefined;
  stop(): Promise<void>;
}

/** A core with ssh machines gpu (connected) and box (disabled) whose
 * agents give FakeChatHost as their chat host, running the machines but
 * not the watches (start). */
export async function rig(o: RigOptions = {}): Promise<Rig> {
  const host = new FakeChatHost();
  o.host?.(host);
  const dial = agentDialer({ serve: (h, conn) => host.serve(h, conn) });
  const machines = testMachines([sshSpec('gpu'), sshSpec('box', 'box', 'box', false)], { dial });
  let offset = 0;
  const feature: ChatFeature = chatFeature({
    timing: { ...FAST, ...o.timing },
    limits: o.limits,
    now: () => Date.now() + offset,
    version: () => o.version ?? 'test',
  });
  const store = new Settings('', { modules: [chatSettings, toggles([feature])] });
  const audit = memoryAudit();
  const core = createCore({
    guard: new Guard(),
    audit: audit.audit,
    readOnly: o.readOnly ?? false,
    logger: discard,
    machines,
    settings: store,
    features: [feature],
  });
  const broadcasts: Rig['broadcasts'] = [];
  const notes: Rig['notes'] = [];
  machines.subscribe({ agent: (ev) => void notes.push({ ...(ev.data as Record<string, unknown>), m: ev.m }) });
  // What the pages get on /ws.
  core.pages.connect(
    {
      send: (d) => {
        const msg = JSON.parse(d as string) as Msg;
        if (msg.t === 'plugin' && msg.plugin === 'chat') broadcasts.push({ m: msg.m as string, data: msg.data as Record<string, unknown> });
      },
      buffered: 0,
      close: () => {},
    },
    { client: 'browser', readOnly: false, who: {} },
  );
  const stopMachines = running(machines);
  await waitFor('machine gpu', () => machines.get('gpu')!.ready);
  const hub = feature.hub()!;
  const stops: Array<() => Promise<void>> = [];
  const pages: TestPage[] = [];
  const request: Rig['request'] = (method, path, r = {}) => {
    const headers = new Headers({ Host: '127.0.0.1:7780' });
    if (r.origin) headers.set('Origin', r.origin);
    return core.fetch(new Request(`http://127.0.0.1:7780${path}`, { method, headers, body: r.body }), {
      remote: '127.0.0.1',
      desktop: false,
      upgrade: r.upgrade,
    });
  };
  const r: Rig = {
    core,
    host,
    hub,
    machines,
    settings: store,
    audit,
    broadcasts,
    notes,
    advance: (ms) => void (offset += ms),
    request,
    async call(method, path, body) {
      const res = await request(method, path, { body });
      return [res.status, (await res.json()) as Record<string, unknown>];
    },
    async page() {
      const p = await TestPage.open(r);
      pages.push(p);
      return p;
    },
    start() {
      stops.push(running(hub));
    },
    async setEnabled(m, on) {
      machines.setEnabled(m, on);
      if (on) await waitFor(`machine ${m}`, () => machines.get(m)!.ready);
      else await waitFor(`machine ${m} to disconnect`, () => !machines.get(m)!.connected);
    },
    lastAudit: () => audit.records().at(-1),
    async stop() {
      for (const p of pages) if (!p.ended) p.close();
      for (const s of stops) await s();
      hub.closePages('');
      await stopMachines();
      for (const c of host.conns) c.stream.destroy();
    },
  };
  return r;
}
