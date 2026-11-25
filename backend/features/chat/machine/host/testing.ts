// What the host's tests share: a host that serves in the test's process
// with a fake adapter, whose sessions the test drives, and clients of its
// socket.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Reader, write } from '#shared/lib/streamio.ts';
import { Notice, noticeMethod } from '#shared/proto/agentproto/index.ts';
import type { ChatSpec } from '#shared/agents/kinds.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import type {
  Adapter,
  HistoryParams,
  PermissionAnswer,
  PromptParams,
  QuestionAnswer,
  Session,
  SessionsParams,
  Sink,
  StartParams,
} from '../adapter.ts';
import { OPTION_ALLOW_ONCE, OPTION_REJECT_ONCE } from '../adapter.ts';
import type { AgentProcess } from '../agentproc.ts';
import { HOST_TIMING, serveHost, type Host, type HostOptions } from './host.ts';

/** How long a test waits for something that must happen. */
export const PATIENCE = 10_000;

/** A queue of values a test takes one at a time. */
export class Queue<T> {
  private items: T[] = [];
  private waiters: Array<(v: T) => void> = [];

  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.items.push(v);
  }

  async next(what = 'a value', ms = PATIENCE): Promise<T> {
    if (this.items.length > 0) return this.items.shift()!;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== take);
        reject(new Error(`no ${what} within ${ms} ms`));
      }, ms);
      const take = (v: T) => {
        clearTimeout(t);
        resolve(v);
      };
      this.waiters.push(take);
    });
  }

  /** Whether one waits now. */
  get size(): number {
    return this.items.length;
  }

  drain(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}

/** Waits until ok holds. */
export async function eventually(what: string, ok: () => boolean | Promise<boolean>, ms = PATIENCE): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await ok()) return;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(10);
  }
}

/** The fake agent's kind, and its adapter's name. */
export const FAKE_KIND = 'fake';

/** The kinds a test host knows: fake, run by the fake adapter (its
 * program /bin/sh, which the PATH has); nochat, a kind without one;
 * missing, whose program is nowhere; noadapter, whose adapter the host was
 * not given. */
export function fakeSpecs(id: string): ChatSpec | undefined {
  switch (id) {
    case FAKE_KIND:
      return { adapter: 'fake' as ChatSpec['adapter'], argv: ['/bin/sh', '--fake'], env: { FAKE_SPEC_VAR: 'spec' } };
    case 'missing':
      return { adapter: 'fake' as ChatSpec['adapter'], argv: ['no-such-agent-program-x'] };
    case 'noadapter':
      return { adapter: 'none' as ChatSpec['adapter'], argv: ['/bin/sh'] };
  }
  return undefined;
}

export const agentChunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

/** A session of the fake adapter: what the host asks of it is recorded,
 * what it reports the test makes it report. */
export class FakeSession implements Session {
  readonly a: FakeAdapter;
  readonly p: StartParams;
  readonly sink: Sink;
  readonly calls = new Queue<string>();
  readonly prompts: PromptParams[] = [];
  readonly done: Promise<chat.ChatError | undefined>;
  private ended!: (e: chat.ChatError | undefined) => void;
  private isEnded = false;
  turn = false;
  closing = false;
  proc: AgentProcess | null = null;
  id: string;

  constructor(a: FakeAdapter, p: StartParams, sink: Sink) {
    this.a = a;
    this.p = p;
    this.sink = sink;
    this.id = p.resume || p.sessionId;
    this.done = new Promise((r) => (this.ended = r));
  }

  get pid(): number {
    return this.a.pid ? (this.proc?.pid ?? 0) : 0;
  }

  /** Ends the session with err. */
  end(err?: chat.ChatError): void {
    if (this.isEnded) return;
    this.isEnded = true;
    this.ended(err);
  }

  /** Ends the session as an agent that exited would. */
  crash(): void {
    this.end({ code: chat.Code.Ended, message: 'the agent exited (exit status 3)', stderr: 'boom' });
  }

  async expect(want: string): Promise<void> {
    const got = await this.calls.next(`the call ${want}`);
    if (got !== want) throw new Error(`the session's call ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }

  /** Follows the adapters' rule of a prompt's user event: it queues a
   * prompt while its turn runs, and tells the user event of a prompt the
   * host did not record that starts a turn. */
  async prompt(p: PromptParams): Promise<void> {
    const inTurn = this.turn;
    this.turn = true;
    this.prompts.push(p);
    const text = (p.content.find((b) => (b as { type?: string }).type === 'text') as { text?: string } | undefined)?.text ?? '';
    this.calls.push(`prompt:${text}`);
    if (this.a.promptErr) {
      this.turn = inTurn;
      throw new chat.ChatProtoError(this.a.promptErr);
    }
    if (inTurn) {
      this.sink.event({
        t: chat.EventType.Queued,
        message: p.message,
        clientId: p.clientId,
        content: p.content,
        state: chat.QueuedState.Waiting,
      });
      return;
    }
    if (!p.recorded) this.sink.event({ t: chat.EventType.User, content: p.content, clientId: p.clientId });
    this.sink.event({ t: chat.EventType.Turn, state: chat.TurnState.Start });
  }

  async cancel(): Promise<void> {
    this.calls.push('cancel');
    this.endTurn('cancelled');
  }

  async cancelQueued(message: string): Promise<void> {
    this.calls.push(`cancel_queued:${message}`);
  }

  async setConfig(id: string, value: string): Promise<void> {
    this.calls.push(`set_config:${id}=${value}`);
    if (this.a.setConfigErr) throw new chat.ChatProtoError(this.a.setConfigErr);
  }

  async compact(): Promise<void> {
    this.calls.push('compact');
    if (this.a.compactGate) await this.a.compactGate;
  }

  async close(signal: AbortSignal): Promise<void> {
    this.calls.push('close');
    this.closing = true;
    if (this.a.closeDelay) await Bun.sleep(this.a.closeDelay);
    if (!this.proc) return this.end();
    this.proc.closeInput();
    await Promise.race([this.proc.exited, Bun.sleep(this.a.closeWait), new Promise((r) => signal.addEventListener('abort', r))]);
    if (!this.proc.gone) this.proc.signal('SIGTERM');
    await Promise.race([this.done, new Promise((r) => signal.addEventListener('abort', r))]);
  }

  endTurn(reason: string): void {
    this.turn = false;
    this.sink.event({ t: chat.EventType.Turn, state: chat.TurnState.End, stopReason: reason });
  }

  /** Stores a message of the agent under an item. */
  say(item: string, text: string): void {
    this.sink.event({ t: chat.EventType.Update, item, update: agentChunk(text) });
  }

  /** Sends a live increment of an item. */
  stream(item: string, text: string): void {
    this.sink.event({ t: chat.EventType.Update, item, live: true, update: agentChunk(text) });
  }

  /** Asks a permission; the answer comes on the promise. */
  permission(kind = chat.PermissionKind.Command, signal = new AbortController().signal): Promise<PermissionAnswer | chat.ChatError> {
    return this.sink
      .permission(
        {
          kind,
          toolCall: { toolCallId: 't1', title: 'run ls', kind: 'execute' },
          options: [
            { optionId: OPTION_ALLOW_ONCE, name: 'Allow', kind: chat.OptionKind.AllowOnce },
            { optionId: OPTION_REJECT_ONCE, name: 'Reject', kind: chat.OptionKind.RejectOnce },
          ],
          parent: '',
        },
        signal,
      )
      .catch((e: chat.ChatProtoError) => e.error);
  }

  /** Asks a question; the answer comes on the promise. */
  question(signal = new AbortController().signal): Promise<QuestionAnswer | chat.ChatError> {
    return this.sink
      .question(
        {
          questions: [
            { id: 'color', question: 'Which color?', options: [{ label: 'red' }, { label: 'blue' }] },
            { id: '', question: 'Why?', allowOther: true },
          ],
          parent: '',
        },
        signal,
      )
      .catch((e: chat.ChatProtoError) => e.error);
  }
}

/** An adapter whose sessions the test drives. With proc, each session runs
 * a program (sh reading its input) in a process group of its own. */
export class FakeAdapter implements Adapter {
  proc = false;
  /** The program of a session's process. */
  procScript = 'cat > /dev/null';
  /** The sessions tell their process. */
  pid = false;
  closeWait = 2000;
  closeDelay = 0;
  starts: StartParams[] = [];
  readonly started = new Queue<FakeSession>();
  startErr: chat.ChatError | null = null;
  /** Holds start up until it settles. */
  startGate: Promise<void> | null = null;
  promptErr: chat.ChatError | null = null;
  setConfigErr: chat.ChatError | null = null;
  /** A session started in a folder not trusted tells so. */
  untrusted = false;
  /** The sessions another process runs (inTerminal). */
  running = new Set<string>();
  caps: chat.Capabilities = {
    images: true,
    compact: true,
    queue: true,
    plan: false,
    questions: false,
    effort: false,
    model: true,
    cancelQueued: false,
  };
  config: chat.ConfigOption[] = [
    {
      id: 'model',
      name: 'Model',
      category: chat.Category.Model,
      type: chat.CONFIG_SELECT,
      currentValue: 'small',
      options: [
        { value: 'small', name: 'Small' },
        { value: 'large', name: 'Large' },
      ],
    },
  ];
  list: chat.Session[] = [];
  past: chat.Event[] = [];
  historyErr: chat.ChatError | null = null;
  historyGate: Promise<void> | null = null;
  histories: HistoryParams[] = [];
  sessionsP: SessionsParams[] = [];
  /** Held, the listings and the compactions wait for it. */
  sessionsGate: Promise<void> | null = null;
  compactGate: Promise<void> | null = null;

  async start(p: StartParams, sink: Sink, signal: AbortSignal): Promise<Session> {
    this.starts.push(p);
    if (this.startGate) {
      await Promise.race([
        this.startGate,
        new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true })),
      ]);
    }
    if (this.startErr) throw new chat.ChatProtoError(this.startErr);
    const s = new FakeSession(this, p, sink);
    if (this.proc) {
      s.proc = await p.procs.spawn(['/bin/sh', '-c', this.procScript], { cwd: p.cwd, env: p.env });
      void s.proc.exited.then(() => s.end(s.closing ? undefined : { code: chat.Code.Ended, message: 'the agent exited' }));
    }
    if (this.untrusted && !p.trusted)
      sink.event({ t: chat.EventType.Notice, method: noticeMethod(Notice.UntrustedFolder), params: { cwd: p.cwd } });
    const caps = { ...this.caps };
    const config = structuredClone(this.config);
    sink.update((c) => {
      c.capabilities = caps;
      c.config = config;
      c.agentVersion = 'fake 1';
    });
    this.started.push(s);
    return s;
  }

  async sessions(p: SessionsParams): Promise<{ sessions: chat.Session[]; next: string }> {
    this.sessionsP.push(p);
    if (this.sessionsGate) await this.sessionsGate;
    return { sessions: this.list.map((s) => ({ ...s })), next: 'next-page' };
  }

  async history(p: HistoryParams, emit: (ev: chat.Event) => void, signal: AbortSignal): Promise<void> {
    this.histories.push(p);
    if (this.historyGate)
      await Promise.race([
        this.historyGate,
        new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true })),
      ]);
    if (this.historyErr) throw new chat.ChatProtoError(this.historyErr);
    let after = p.after !== '';
    for (const ev of this.past) {
      if (after) {
        after = ev.item !== p.after;
        continue;
      }
      emit(ev);
    }
  }

  async inTerminal(p: HistoryParams): Promise<chat.ChatError | null> {
    return this.running.has(p.sessionId) ? { code: chat.Code.InTerminal, message: 'runs in a terminal' } : null;
  }

  session(): Promise<FakeSession> {
    return this.started.next('session started');
  }
}

/** A connection to a host: lines out and in. */
export class Client {
  readonly sock: Duplex;
  readonly reader: Reader;
  hello: chat.Hello | null = null;

  private constructor(sock: Duplex) {
    this.sock = sock;
    this.reader = new Reader(sock);
  }

  static async dial(path: string): Promise<Client> {
    const sock = connect(path);
    sock.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    return Client.fromStream(sock);
  }

  /** A client on a stream that carries a host's lines, its hello first. */
  static async fromStream(sock: Duplex): Promise<Client> {
    sock.on('error', () => {});
    const c = new Client(sock);
    c.hello = (await c.next()) as unknown as chat.Hello;
    return c;
  }

  async send(v: unknown): Promise<void> {
    await write(this.sock, typeof v === 'string' ? v : chat.line(v));
  }

  /** The next line as JSON. */
  async next(ms = PATIENCE): Promise<Record<string, unknown>> {
    const t = setTimeout(() => this.sock.destroy(new Error('no line in time')), ms);
    try {
      return JSON.parse((await chat.readLine(this.reader)).toString('utf8'));
    } finally {
      clearTimeout(t);
    }
  }

  /** Whether the host closed the connection (the next read ends). */
  async closed(ms = PATIENCE): Promise<boolean> {
    const t = setTimeout(() => this.sock.destroy(), ms);
    try {
      for (;;) {
        const b = await this.reader.chunk();
        if (b === null) return true;
      }
    } catch {
      return true;
    } finally {
      clearTimeout(t);
    }
  }

  close(): void {
    this.sock.destroy();
  }
}

/** An attached connection: the events of a chat, and its commands. */
export class Attached {
  readonly c: Client;
  readonly head: chat.Response;
  private n = 0;
  /** The acks that came while events were read. */
  private readonly acks = new Map<string, chat.Event>();
  /** The events that came while acks were read. */
  private readonly early: chat.Event[] = [];

  constructor(c: Client, head: chat.Response) {
    this.c = c;
    this.head = head;
  }

  /** The next event that is no ack. */
  async event(ms = PATIENCE): Promise<chat.Event> {
    if (this.early.length > 0) return this.early.shift()!;
    for (;;) {
      const ev = (await this.c.next(ms)) as unknown as chat.Event;
      if (ev.t === chat.EventType.Ack) {
        this.acks.set(ev.id ?? '', ev);
        continue;
      }
      return ev;
    }
  }

  /** The next stored event of type t, passing over the others. */
  async until(pred: (ev: chat.Event) => boolean, what = 'an event'): Promise<chat.Event> {
    const deadline = Date.now() + PATIENCE;
    for (;;) {
      const ev = await this.event(Math.max(deadline - Date.now(), 1)).catch(() => {
        throw new Error(`no ${what}`);
      });
      if (pred(ev)) return ev;
    }
  }

  /** Sends a command and waits for its ack: its error, undefined for OK. */
  async command(cmd: Omit<Partial<chat.Command>, 'op'> & { op: string }): Promise<chat.ChatError | undefined> {
    const id = cmd.id ?? `c${++this.n}`;
    await this.c.send({ ...cmd, id });
    return (await this.ack(id)).error;
  }

  /** Sends a command without waiting for its ack. */
  async send(cmd: Omit<Partial<chat.Command>, 'op'> & { op: string }): Promise<string> {
    const id = cmd.id ?? `c${++this.n}`;
    await this.c.send({ ...cmd, id });
    return id;
  }

  async ack(id: string): Promise<chat.Event> {
    for (;;) {
      const a = this.acks.get(id);
      if (a) {
        this.acks.delete(id);
        return a;
      }
      const ev = (await this.c.next()) as unknown as chat.Event;
      if (ev.t === chat.EventType.Ack) this.acks.set(ev.id ?? '', ev);
      else this.early.push(ev);
    }
  }

  close(): void {
    this.c.close();
  }
}

export const text = (s: string) => [{ type: 'text', text: s }];

/** A host that serves in the test's process. */
export class TestHost {
  host!: Host;
  readonly fake = new FakeAdapter();
  readonly run: string;
  readonly base: string;
  readonly sock: string;
  readonly cwd: string;
  readonly home: string;
  readonly log: string[] = [];
  o: HostOptions;
  private ac = new AbortController();
  finished: Promise<unknown> = Promise.resolve();

  constructor(change?: (h: TestHost) => void) {
    // A short path: a socket's must fit 104 bytes on macOS.
    this.run = mkdtempSync('/tmp/ch');
    this.home = mkdtempSync(join(tmpdir(), 'chathost-home-'));
    this.base = join(this.home, 'base');
    this.cwd = join(this.home, 'work');
    mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    this.sock = join(this.run, chat.SOCKET_NAME);
    const settings = chat.defaultHostSettings();
    this.o = {
      base: this.base,
      run: this.run,
      logger: (l) => this.log.push(l),
      adapters: { fake: this.fake },
      spec: fakeSpecs,
      client: { name: 'test', version: 'test' },
      timing: { ...HOST_TIMING, idleExit: 3600_000, minute: 3600_000, enforceEvery: 3600_000, infoDelay: 20, closeGrace: 5000 },
      settings,
      environ: async () => ({ PATH: '/usr/bin:/bin', HOME: this.home }),
      hostEnv: { PATH: '/usr/bin:/bin', HOME: this.home, SHELL: '/bin/sh' },
      onHost: (h) => (this.host = h),
    };
    change?.(this);
  }

  /** Serves, and waits until the host says hello. */
  async serve(): Promise<void> {
    this.ac = new AbortController();
    this.host = undefined as unknown as Host;
    this.finished = serveHost({ ...this.o, signal: this.ac.signal }).catch((e) => e);
    await eventually('the host serves', async () => {
      if (!this.host) return false;
      try {
        const c = await Client.dial(this.sock);
        c.close();
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Stops the host and waits until it ended; what serveHost settled
   * with. */
  async stop(): Promise<unknown> {
    this.ac.abort();
    return this.finished;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.serve();
  }

  /** Sends one request and reads the answer. */
  async request(req: chat.Request | Record<string, unknown>): Promise<chat.Response> {
    const c = await Client.dial(this.sock);
    try {
      await c.send(req);
      return (await c.next()) as chat.Response;
    } finally {
      c.close();
    }
  }

  /** Makes a chat of the fake kind in the test's directory; its session. */
  async newChat(req: Partial<chat.Request> = {}): Promise<{ chat: chat.Chat; s: FakeSession }> {
    const res = await this.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: this.cwd, ...req });
    if (!res.ok) throw new Error(`new: ${JSON.stringify(res.error)}`);
    const s = await this.fake.session();
    return { chat: res.chat!, s };
  }

  /** Attaches to a chat from a sequence number. */
  async attach(id: string, from = 0, more: Record<string, unknown> = {}): Promise<Attached> {
    const c = await Client.dial(this.sock);
    await c.send({ op: chat.Op.Attach, chat: id, from, ...more });
    const head = (await c.next()) as chat.Response;
    if (!head.ok) {
      c.close();
      throw new Error(`attach: ${JSON.stringify(head.error)}`);
    }
    return new Attached(c, head);
  }

  /** The chat as the host has it. */
  chat(id: string) {
    return this.host.chats.get(id)!;
  }

  cleanup(): void {
    rmSync(this.run, { recursive: true, force: true });
    rmSync(this.home, { recursive: true, force: true });
  }
}

/** A host for one test: served, stopped and removed after it. */
export async function startHost(change?: (h: TestHost) => void): Promise<TestHost> {
  const h = new TestHost(change);
  await h.serve();
  return h;
}
