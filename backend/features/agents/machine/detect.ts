// Op detect (docs/features/25-agent-detection.md): one connection to the
// instance's terminal core with an event subscription, its notifications
// fed to a Detector, which writes a DetectEvent line per change to the
// hub until the hub closes the stream (it sends nothing after its
// header), the terminal core stops sending (it sends a heartbeat every 15
// s) or the agent ends. With Header.sessions the detector also finds each
// agent's session (#machine/agents/sessions.ts); without it no session
// file is read. Nothing is started and nothing is written to disk.
import type { Writable } from 'node:stream';
import { write } from '#shared/lib/streamio.ts';
import { writeLine, type DetectEvent, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import type { Conn as HCConn, Events, Subscribed } from '#shared/proto/hc/index.ts';
import { Resolver } from '#machine/agents/sessions.ts';
import type { ActionContext, OpHandler } from '#machine/feature.ts';
import { dialHC } from '#machine/hidden.ts';
import type { Conn } from '#machine/stream.ts';
import { Detector, type Clock, type DetectTiming, type SessionResolver } from './detector.ts';

export interface DetectOptions {
  timing?: Partial<DetectTiming>;
  clock?: Clock;
  /** How long the terminal core may stay silent (it sends a heartbeat
   * every 15 s). */
  silenceMs?: number;
  /** Events written and not yet taken by the hub, past which the stream
   * ends (the hub opens it again). */
  maxQueued?: number;
  /** The session resolver of a stream opened with sessions (tests). */
  newResolver?: (home: string, peers: (kind: string, cwd: string) => number) => SessionResolver;
  /** Connects to the terminal core (tests). */
  dial?: (socket: string, signal: AbortSignal) => Promise<HCConn>;
}

const SILENCE_MS = 45_000;
const MAX_QUEUED = 10_000;

/** The events of one stream, written in the order they were made, many
 * lines at once while the hub reads slower than they come. */
class Outbox {
  private queue: DetectEvent[] = [];
  private writing = false;
  private readonly stream: Writable;
  private readonly max: number;
  private readonly fail: () => void;

  constructor(stream: Writable, max: number, fail: () => void) {
    this.stream = stream;
    this.max = max;
    this.fail = fail;
  }

  push(ev: DetectEvent): void {
    if (this.queue.length >= this.max) return this.fail();
    this.queue.push(ev);
    if (!this.writing) void this.flush();
  }

  private async flush(): Promise<void> {
    this.writing = true;
    try {
      while (this.queue.length > 0) {
        const lines = this.queue.splice(0).map((ev) => JSON.stringify(ev) + '\n');
        await write(this.stream, lines.join(''));
      }
    } catch {
      this.fail();
    } finally {
      this.writing = false;
    }
  }
}

/** Serves op detect. */
export function serveDetect(o: DetectOptions = {}): OpHandler {
  const silence = o.silenceMs ?? SILENCE_MS;
  const newResolver = o.newResolver ?? ((home, peers) => new Resolver({ home, peers }));
  const dial = o.dial ?? dialHC;
  return async (conn: Conn, h: Header, ctx: ActionContext) => {
    const ended = new AbortController();
    const signal = AbortSignal.any([ctx.signal, ended.signal]);
    const refuse = (e: unknown) =>
      writeLine(conn.stream, { ok: false, error: `terminal core: ${e instanceof Error ? e.message : String(e)}` } satisfies Reply);
    let hc: HCConn;
    try {
      hc = await dial(ctx.hcSocket, signal);
    } catch (e) {
      await refuse(e);
      return;
    }
    let sub: { events: Events; subscribed: Subscribed };
    try {
      sub = await hc.subscribe({}, { signal });
    } catch (e) {
      hc.close();
      await refuse(e);
      return;
    }
    const end = () => ended.abort();
    const out = new Outbox(conn.stream, o.maxQueued ?? MAX_QUEUED, end);
    const d = new Detector({ core: hc, send: (ev) => out.push(ev), signal, clock: o.clock, timing: o.timing });
    let watchdog: ReturnType<typeof setInterval> | undefined;
    try {
      await writeLine(conn.stream, { ok: true } satisfies Reply);
      // The hub sends nothing more: the stream ends when it closes it.
      void (async () => {
        try {
          while ((await conn.reader.chunk()) !== null);
        } catch {
          // closed
        }
        end();
      })();
      if (h.sessions) d.resolver = newResolver(ctx.home, (kind, cwd) => d.peers(kind, cwd));
      d.resync(sub.subscribed.terminals ?? []);
      let heard = Date.now();
      watchdog = setInterval(() => Date.now() - heard > silence && end(), Math.max(silence / 3, 10));
      for (;;) {
        const n = await sub.events.recv(signal);
        heard = Date.now();
        d.event(n);
      }
    } catch {
      // the stream, the subscription or the agent ended
    } finally {
      clearInterval(watchdog);
      end();
      d.stopAll();
      sub.events.close();
      hc.close();
    }
  };
}
