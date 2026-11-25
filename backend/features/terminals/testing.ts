// Helpers of the terminals feature's tests, never used by the product: a
// terminal core in memory (FakeHC) that answers the calls the tests make,
// echoes a stream's input as output and records what it receives; an
// agent (AgentSim) that serves the ops the backend uses (hc, hc-api,
// detect, privacy) with it; a client of /api/v1/term over a channel pair;
// and a core with machine x that runs them.
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { Reader } from '#shared/lib/streamio.ts';
import { ChunkReader, Op, writeLine, type Header, type HCStatus, type PrivacyStatus, type Reply } from '#shared/proto/agentproto/index.ts';
import { encodeFrame, Kind, readFrame } from '#shared/proto/hc/wire.ts';
import { pairDuplex } from '#shared/proto/yamux.ts';
import { channelPair, type Channel } from '#kernel/channel.ts';
import type { Machines } from '#kernel/machines/manager.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { agentDialer, running, sshSpec, testHub, testMachines, waitFor, type TestHub } from '#kernel/testing.ts';
import type { Backend } from './backend.ts';
import { terminalsFeature, type TerminalsFeature, type TerminalsOptions } from './hub.ts';
import type { Timing } from './timing.ts';

/** Durations short enough for tests. */
export const FAST: Partial<Timing> = {
  backoffMinMs: 20,
  backoffMaxMs: 100,
  detectRetryMs: 50,
  detectPollMs: 20,
};

/** A call the fake core got: its method, params as sent, the raw request. */
export interface FakeCall {
  method: string;
  params: unknown;
  raw: string;
}

type Answer = { result: unknown } | { error: { kind: string; message: string; hint?: string } };

const notFound = (t: string): Answer => ({ error: { kind: 'not_found', message: `no terminal ${JSON.stringify(t)}` } });

/** A live terminal's record as terminal.get answers it in the protocol's
 * tests: of the address asked for, its shell at its prompt. */
export const liveRecord = (addr: string) => ({
  address: addr,
  state: 'live',
  pid: 42,
  cols: 80,
  rows: 24,
  argv: [],
  cwd: '/',
  created_ms: 1,
  labels: {},
  screen: 'exact',
  foreground: { pid: 42, name: 'zsh', argv: ['zsh'], cwd: '/' },
});

/** A terminal core in memory. Unless snap is set, a subscription gets
 * terminal t1 and then a status event of it. terminal.get answers recs, or
 * with anyTerminal any terminal but t404 (liveRecord); terminal.attach
 * answers the record of attachedRecs, else recs, else with anyTerminal a
 * t1 of 100x30, then a first paint ("paint"); an observer gets a resize
 * first, and an attach with history 1 the program's end after it. */
export class FakeHC {
  hello: Record<string, unknown> = { generation: 1, version: '9.9.9', framed: true, core: { id: 'c0ffee', name: 'box' } };
  snap: unknown[] | null = null;
  recs = new Map<string, unknown>();
  attachedRecs = new Map<string, unknown>();
  anyTerminal = true;
  list: unknown = { terminals: [], hidden_finished: 0 };
  /** The calls it got, events.subscribe and the hello aside. */
  readonly calls: FakeCall[] = [];
  /** "kind:payload" (latin1) of the frames it got on streams. */
  readonly frames: string[] = [];
  /** The channels the client closed. */
  readonly closed: number[] = [];
  private readonly subs: Array<(line: string) => void> = [];
  private readonly conns = new Set<Duplex>();

  /** Serves one connection. */
  serve(rw: Duplex): void {
    this.conns.add(rw);
    rw.on('close', () => this.conns.delete(rw));
    rw.on('error', () => {});
    void this.run(rw).catch(() => rw.destroy());
  }

  private async run(rw: Duplex): Promise<void> {
    const r = new Reader(rw);
    const line = await r.line(1 << 20);
    const framed = JSON.parse(line).params?.framed === true;
    rw.write(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ...this.hello, framed } }) + '\n');
    if (!framed) return void rw.end();
    let next = 1;
    const write = (...frames: Buffer[]) => {
      if (!rw.destroyed) rw.write(Buffer.concat(frames));
    };
    for (let f = await readFrame(r); f; f = await readFrame(r)) {
      if (f.channel !== 0) {
        this.frames.push(`${f.kind}:${f.payload.toString('latin1')}`);
        if (f.kind === Kind.Close) this.closed.push(f.channel);
        // Input comes back as output.
        if (f.kind === Kind.Data) write(encodeFrame(f.channel, Kind.Data, Buffer.concat([Buffer.from('echo:'), f.payload])));
        continue;
      }
      const raw = f.payload.toString('utf8');
      const req = JSON.parse(raw) as { id: number; method: string; params: unknown };
      const reply = (a: Answer) =>
        encodeFrame(
          0,
          Kind.Data,
          Buffer.from(
            JSON.stringify(
              'result' in a
                ? { jsonrpc: '2.0', id: req.id, result: a.result }
                : {
                    jsonrpc: '2.0',
                    id: req.id,
                    error: { code: -32000, message: a.error.message, data: { kind: a.error.kind, hint: a.error.hint } },
                  },
            ),
          ),
        );
      if (req.method !== 'events.subscribe') this.calls.push({ method: req.method, params: req.params, raw });
      const p = (req.params ?? {}) as Record<string, unknown>;
      const terminal = typeof p.terminal === 'string' ? p.terminal : '';
      switch (req.method) {
        case 'events.subscribe': {
          const ch = ++next;
          this.subs.push((l) => write(encodeFrame(ch, Kind.Data, Buffer.from(l + '\n'))));
          if (this.snap) {
            write(reply({ result: { channel: ch, seq: 1, terminals: this.snap } }));
            break;
          }
          write(
            reply({ result: { channel: ch, seq: 1, terminals: [{ address: 't1', state: 'live', cols: 80, rows: 24, future_field: 7 }] } }),
            encodeFrame(
              ch,
              Kind.Data,
              Buffer.from(
                JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'event',
                  params: { seq: 2, type: 'status', terminal: 't1', data: { status: { state: 'working' }, records: {}, reported: true } },
                }) + '\n',
              ),
            ),
          );
          break;
        }
        case 'terminal.attach': {
          const rec =
            this.attachedRecs.get(terminal) ??
            this.recs.get(terminal) ??
            (this.anyTerminal && terminal !== 't404' ? { address: 't1', cols: 100, rows: 30 } : undefined);
          if (!rec) {
            write(reply(notFound(terminal)));
            break;
          }
          const ch = ++next;
          const out = [reply({ result: { channel: ch, automatic_input: true, resize_notifications: true, terminal: rec } })];
          if (p.observe === true) out.push(encodeFrame(ch, Kind.Resize, Buffer.from([100, 0, 30, 0])));
          out.push(encodeFrame(ch, Kind.Data, Buffer.from('paint')));
          if (p.history === 1) out.push(encodeFrame(ch, Kind.Close, Buffer.from('{"reason":"exited","exit_code":0,"signal":null}')));
          write(...out);
          break;
        }
        case 'terminal.get': {
          const rec = this.recs.get(terminal) ?? (this.anyTerminal && terminal !== 't404' ? liveRecord(terminal) : undefined);
          write(reply(rec ? { result: rec } : notFound(terminal)));
          break;
        }
        case 'terminal.list':
          write(reply({ result: this.list }));
          break;
        case 'terminal.run':
          write(reply({ result: { address: 't2' } }));
          break;
        case 'terminal.kill':
          write(reply({ error: { kind: 'not_found', message: 'no terminal t9', hint: 'h' } }));
          break;
        case 'terminal.label':
          write(reply({ result: {} }));
          break;
        default:
          write(reply({ result: { method: req.method } }));
      }
    }
  }

  /** Sends a notification (a JSON-RPC line) on every subscription. */
  notify(line: string): void {
    for (const send of this.subs) send(line);
  }

  /** Sends an event about a terminal on every subscription. */
  event(type: string, terminal: string, data: unknown): void {
    this.notify(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { seq: 9, type, terminal, data } }));
  }

  /** Closes its connections, as a core that stopped. */
  drop(): void {
    for (const c of this.conns) c.destroy();
    this.conns.clear();
    this.subs.length = 0;
  }

  /** Whether a call (as "method params") or a stream frame has want. */
  seen(want: string): boolean {
    return this.frames.some((f) => f.includes(want)) || this.calls.some((c) => `${c.method} ${JSON.stringify(c.params)}`.includes(want));
  }

  /** Whether a call after the first n has want in "method params". */
  gotSince(n: number, want: string): boolean {
    return this.calls.slice(n).some((c) => `${c.method} ${JSON.stringify(c.params)}`.includes(want));
  }

  waitFor(want: string): Promise<void> {
    return waitFor(`the core got ${JSON.stringify(want)}`, () => this.seen(want));
  }

  /** The number of streams the client closed. */
  get closes(): number {
    return this.closed.length;
  }
}

/** A detect stream the core opened. */
export interface DetectStream {
  sessions: boolean;
  send(ev: object): void;
  closed: boolean;
}

/** The agent of machine x: its terminal core (core, while running), the
 * executable installed (digest), detection and privacy. */
export class AgentSim {
  digest = 'd1';
  /** The herdr-core the machine build carries (the TypeScript build's). */
  embedded = '';
  running = true;
  version = '9.9.9';
  core: FakeHC | null = new FakeHC();
  privacy: PrivacyStatus = { files: 'unknown', terminals: 'unknown', hc: '/home/u/.veldr/hc/herdr-core' };
  /** The lines a detect stream starts with, for its header. */
  onDetect: (h: Header) => object[] = () => [];
  readonly detects: DetectStream[] = [];
  readonly actions: string[] = [];

  status(): HCStatus {
    return {
      ...(this.digest ? { digest: this.digest } : {}),
      ...(this.embedded ? { embedded: this.embedded } : {}),
      running: this.running,
      version: this.version,
      session: 'veldr-test',
      socket: '/run/u/hc.sock',
    };
  }

  async serve(h: Header, conn: AgentStream): Promise<void> {
    const once = async (rep: Reply) => {
      await writeLine(conn.stream, rep).catch(() => {});
      conn.reader.release();
      closeStream(conn.stream);
    };
    switch (h.op) {
      case Op.HC: {
        this.actions.push(h.action ?? '');
        switch (h.action) {
          case 'status':
            return once({ ok: true, hc: this.status() });
          case 'install': {
            await writeLine(conn.stream, { ok: true });
            const parts: Buffer[] = [];
            for await (const b of new ChunkReader(conn.reader)) parts.push(b);
            const digest = createHash('sha256')
              .update(gunzipSync(Buffer.concat(parts)))
              .digest('hex');
            if (digest !== h.digest) return once({ ok: false, error: 'bad digest', code: 'bad_digest' });
            this.digest = digest;
            return once({ ok: true, hc: this.status() });
          }
          case 'install-embedded':
            if (!this.embedded || h.digest !== this.embedded) return once({ ok: false, error: 'bad digest', code: 'bad_digest' });
            this.digest = this.embedded;
            return once({ ok: true, hc: this.status() });
          case 'start':
          case 'restart':
            if (!this.digest) return once({ ok: false, error: 'not installed', code: 'not_installed' });
            this.running = true;
            if (h.action === 'restart') this.core?.drop();
            return once({ ok: true, hc: this.status() });
          case 'stop':
            this.running = false;
            this.core?.drop();
            return once({ ok: true, hc: this.status() });
        }
        return once({ ok: false, error: 'unknown action' });
      }
      case Op.HCAPI: {
        if (!this.running || !this.core) return once({ ok: false, error: 'not running' });
        await writeLine(conn.stream, { ok: true });
        const rest = conn.reader.release();
        this.core.serve(rest === conn.stream ? conn.stream : pairDuplex(rest, conn.stream));
        return;
      }
      case Op.Detect: {
        await writeLine(conn.stream, { ok: true });
        const d: DetectStream = {
          sessions: h.sessions === true,
          closed: false,
          send: (ev) => void writeLine(conn.stream, ev).catch(() => {}),
        };
        const end = () => (d.closed = true);
        conn.stream.on('close', end).on('end', end).on('error', end);
        conn.reader.release().resume();
        this.detects.push(d);
        for (const ev of this.onDetect(h)) d.send(ev);
        return;
      }
      case Op.Privacy:
        return once({ ok: true, privacy: this.privacy });
    }
    return once({ ok: false, error: 'unsupported op' });
  }

  /** The detect streams still open. */
  openDetects(): DetectStream[] {
    return this.detects.filter((d) => !d.closed);
  }
}

/** A message of the protocol as the tests read it: a JSON object, or a
 * binary frame as {bin: stream, kind, data} (data in latin1). */
export type Msg = Record<string, unknown>;

/** A client of /api/v1/term over a channel pair. */
export class TestClient {
  private readonly q: Msg[] = [];
  private wake: (() => void) | null = null;
  ended = false;
  private ch!: Channel;

  static async open(tc: TestHub): Promise<TestClient> {
    const c = new TestClient();
    const { a, b } = channelPair();
    const res = await tc.request('GET', '/api/v1/term', {
      upgrade: (open) => {
        b.adopt(open);
        return new Response(null);
      },
    });
    if (res.status !== 200) throw new Error(`upgrade: ${res.status} ${await res.text()}`);
    a.adopt((ch) => {
      c.ch = ch;
      return {
        message: (d) => {
          if (typeof d === 'string') c.q.push(JSON.parse(d));
          else {
            const f = Buffer.from(d);
            c.q.push({ bin: f.readUInt32LE(0), kind: f[4], data: f.subarray(5).toString('latin1') });
          }
          c.wake?.();
        },
        close: () => {
          c.ended = true;
          c.wake?.();
        },
      };
    });
    return c;
  }

  send(v: unknown): void {
    this.ch.send(JSON.stringify(v));
  }

  sendRaw(text: string): void {
    this.ch.send(text);
  }

  /** A binary frame of stream s. */
  bin(s: number, kind: number, payload: string): void {
    const b = Buffer.alloc(5 + Buffer.byteLength(payload, 'latin1'));
    b.writeUInt32LE(s, 0);
    b[4] = kind;
    b.write(payload, 5, 'latin1');
    this.ch.send(b);
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
      if (this.ended) throw new Error('the channel closed');
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

  /** Skips messages until one of type t ("bin" for a binary frame). */
  async until(t: string, timeoutMs = 5000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = await this.next(Math.max(deadline - Date.now(), 1));
      if (m.t === t || (t === 'bin' && m.bin !== undefined)) return m;
    }
  }

  /** Whether a message is queued. */
  get pending(): number {
    return this.q.length;
  }

  /** Subscribes to machine and waits until its backend is ready. */
  async ready(machine = 'x'): Promise<void> {
    this.send({ t: 'sub', m: machine });
    for (;;) {
      const m = await this.until('backend');
      if (m.state === 'ready') return;
      if (m.state === 'error') throw new Error(`backend: ${JSON.stringify(m)}`);
    }
  }

  /** Sends a call and returns its reply. */
  async call(rid: number, method: string, params?: unknown, machine = 'x'): Promise<Msg> {
    this.send({ t: 'call', rid, m: machine, method, ...(params === undefined ? {} : { params }) });
    const m = await this.until('res');
    if (m.rid !== rid) throw new Error(`reply to ${rid}: ${JSON.stringify(m)}`);
    return m;
  }

  /** The next agent event's data of terminal t. */
  async agentData(t = 't1'): Promise<Record<string, unknown>> {
    for (;;) {
      const m = await this.until('event');
      if (m.type === 'agent' && m.terminal === t) return m.data as Record<string, unknown>;
    }
  }
}

/** The kind of a reply's error, "" for none. */
export const errKind = (m: Msg): string => (m.error as { kind?: string } | undefined)?.kind ?? '';

export interface RigOptions {
  readOnly?: boolean;
  /** The booleans of the settings. */
  settings?: Record<string, boolean>;
  /** The ssh session the agent reports. */
  ssh?: string;
  options?: TerminalsOptions;
  /** Prepares the agent before the machine connects. */
  sim?: (s: AgentSim) => void;
}

export interface Rig {
  tc: TestHub;
  feature: TerminalsFeature;
  sim: AgentSim;
  machines: Machines;
  /** The /ws agent messages of the machines. */
  ws: object[];
  client(): Promise<TestClient>;
  backend(): Backend;
  stop(): Promise<void>;
}

/** A core with ssh machine x, whose agent is an AgentSim, running. */
export async function rig(o: RigOptions = {}): Promise<Rig> {
  const sim = new AgentSim();
  o.sim?.(sim);
  const dial = agentDialer({ ssh: o.ssh, serve: (h, conn) => sim.serve(h, conn) });
  const machines = testMachines([sshSpec('x')], { dial });
  const feature = terminalsFeature({ ...o.options, timing: { ...FAST, ...o.options?.timing } });
  const tc = testHub({
    features: [feature],
    machines,
    readOnly: o.readOnly,
    settings: o.settings ?? { 'terminal.sshEnv': true, 'plugins.agents.enabled': true },
  });
  const ws: object[] = [];
  machines.subscribe({ agent: (ev) => void ws.push(ev.data as object) });
  const stop = running(tc.core);
  const clients: TestClient[] = [];
  await waitFor('machine x', () => machines.get('x')!.ready);
  return {
    tc,
    feature,
    sim,
    machines,
    ws,
    async client() {
      const c = await TestClient.open(tc);
      clients.push(c);
      return c;
    },
    backend: () => feature.existing('x')!,
    async stop() {
      for (const c of clients) if (!c.ended) c.close();
      await stop();
    },
  };
}
