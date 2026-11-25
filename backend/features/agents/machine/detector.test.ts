// The detector: agents found in the terminals' records, their statuses
// from the programs' own reports and from the screen, the sessions found
// on the resolver's schedule, and the product's helpers never watched.
import { afterEach, describe, expect, test } from 'bun:test';
import { CHAT_HOST_NAME, HIDDEN_CHAT_HOST, HIDDEN_LABEL, SessionFrom, type DetectEvent } from '#shared/proto/agentproto/index.ts';
import type { AttachParams, Notification, Output, Terminal } from '#shared/proto/hc/index.ts';
import type { Found, Proc } from '#machine/agents/sessions.ts';
import { DETECT_TIMING, Detector, hasSessions, type Clock, type DetectCore, type SessionResolver } from './detector.ts';

const SESS1 = '11111111-1111-4111-8111-111111111111';
const SESS2 = '22222222-2222-4222-8222-222222222222';
const SESS3 = '33333333-3333-4333-8333-333333333333';
const T = DETECT_TIMING;

/** A terminal core that refuses the detector's attaches and reads: the
 * tests follow programs that report their own status. */
const noCore: DetectCore = {
  attach: () => Promise.reject(new Error('no terminal core')),
  call: () => Promise.reject(new Error('no terminal core')),
};

/** The clock of the sessions' schedule: the waits a session follower asks
 * for are recorded (wait), and fire when advance passes them; the screen
 * followers' waits fire too, unrecorded. */
class FakeClock implements Clock {
  t = 1_700_000_000_000;
  private timers: Array<{ at: number; fn: () => void }> = [];
  private asked: number[] = [];
  private listeners: Array<() => void> = [];

  now = () => this.t;

  timer = (ms: number, fn: () => void, what: 'screen' | 'session') => {
    if (what === 'session') {
      this.asked.push(ms);
      for (const l of this.listeners.splice(0)) l();
    }
    if (ms <= 0) {
      let off = false;
      queueMicrotask(() => off || fn());
      return () => (off = true);
    }
    const timer = { at: this.t + ms, fn };
    this.timers.push(timer);
    return () => (this.timers = this.timers.filter((x) => x !== timer));
  };

  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const x of due) x.fn();
  }

  /** The next wait a session follower asked for: it did what it does
   * before waiting. */
  async wait(): Promise<number> {
    const deadline = Date.now() + 5000;
    while (this.asked.length === 0) {
      if (Date.now() > deadline) throw new Error('no session follower waits');
      await new Promise<void>((r) => {
        const t = setTimeout(r, 50);
        this.listeners.push(() => (clearTimeout(t), r()));
      });
    }
    return this.asked.shift()!;
  }

  /** No session follower asks for a wait for a while. */
  async quiet(): Promise<void> {
    await new Promise((r) => setTimeout(r, 100));
    expect(this.asked).toEqual([]);
  }
}

/** Answers sessions and stamps by the process's pid. */
class FakeResolver implements SessionResolver {
  answers = new Map<number, Found>();
  stamps = new Map<number, string>();
  resolves = 0;
  onResolve?: (kind: string, p: Proc) => void | Promise<void>;

  async resolve(kind: string, p: Proc): Promise<Found | null> {
    this.resolves++;
    await this.onResolve?.(kind, p);
    return this.answers.get(p.pid) ?? null;
  }

  async stamp(_kind: string, p: Proc): Promise<string> {
    return this.stamps.get(p.pid) ?? '';
  }

  set(pid: number, f: Found | null, stamp: string): void {
    if (f) this.answers.set(pid, f);
    else this.answers.delete(pid);
    this.stamps.set(pid, stamp);
  }
}

/** Fails the test when anything asks it. */
const failResolver: SessionResolver = {
  resolve: () => {
    throw new Error('a session was resolved');
  },
  stamp: () => {
    throw new Error('a session was stamped');
  },
};

/** Events as they come, in order. */
class Events {
  private items: DetectEvent[] = [];
  private waiters: Array<() => void> = [];

  push = (ev: DetectEvent) => {
    this.items.push(ev);
    for (const w of this.waiters.splice(0)) w();
  };

  async next(): Promise<DetectEvent> {
    const deadline = Date.now() + 5000;
    while (this.items.length === 0) {
      if (Date.now() > deadline) throw new Error('no detect event');
      await new Promise<void>((r) => {
        const t = setTimeout(r, 50);
        this.waiters.push(() => (clearTimeout(t), r()));
      });
    }
    return this.items.shift()!;
  }

  async none(ms = 50): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    expect(this.items).toEqual([]);
  }
}

const stops: AbortController[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s.abort();
});

function detector(o: { resolver?: SessionResolver; clock?: Clock; core?: DetectCore; timing?: Partial<typeof T> } = {}) {
  const stop = new AbortController();
  stops.push(stop);
  const evs = new Events();
  const d = new Detector({
    core: o.core ?? noCore,
    send: evs.push,
    resolver: o.resolver,
    signal: stop.signal,
    clock: o.clock,
    timing: o.timing,
  });
  return { d, evs, stop };
}

/** A live terminal whose foreground is the agent kind (its name), with pid
 * in cwd, reporting its own status idle. */
const agentTerm = (address: string, kind: string, pid: number, cwd: string): Terminal => ({
  address,
  state: 'live',
  argv: null,
  cwd,
  cols: 80,
  rows: 24,
  created_ms: 0,
  labels: null,
  screen: '',
  foreground: { pid, name: kind, argv: [kind], cwd },
  status: { state: 'idle' },
  reported: true,
});

const ev = (type: string, terminal: string, data?: unknown): Notification => ({
  method: 'event',
  seq: 1,
  type,
  terminal,
  machine: '',
  data,
  terminals: null,
});
const statusEvent = (addr: string, state: string) => ev('status', addr, { status: { state } });
const foregroundEvent = (addr: string, pid: number, name: string, cwd: string) => ev('foreground', addr, { pid, name, argv: [name], cwd });

const want = (got: DetectEvent, agent: string, status: string, session = '', source = '') =>
  expect(got).toEqual({ terminal: got.terminal, agent, status, ...(session ? { session, session_source: source } : {}) });

describe('sessions', () => {
  // The session is resolved once the startup grace is over and comes as an
  // event of its own with the status; Claude Code's /clear (a new stamp)
  // brings the new session with the same status; status events carry the
  // session; an agent that leaves clears it, and its follower ends.
  test('their lifecycle', async () => {
    const clk = new FakeClock();
    const r = new FakeResolver();
    r.set(100, { id: SESS1, source: SessionFrom.PID }, 'a');
    const { d, evs } = detector({ resolver: r, clock: clk });
    d.resync([agentTerm('t1', 'claude', 100, '/w')]);
    want(await evs.next(), 'claude', 'idle');
    expect(await clk.wait()).toBe(T.startupGraceMs);
    expect(r.resolves).toBe(0);
    clk.advance(T.startupGraceMs);
    want(await evs.next(), 'claude', 'idle', SESS1, SessionFrom.PID);
    expect(await clk.wait()).toBe(T.claudeStampMs);
    // The same stamp: no resolve, no event.
    clk.advance(T.claudeStampMs);
    expect(await clk.wait()).toBe(T.claudeStampMs);
    expect(r.resolves).toBe(1);
    await evs.none();
    // /clear rewrote the record.
    r.set(100, { id: SESS2, source: SessionFrom.PID }, 'b');
    clk.advance(T.claudeStampMs);
    want(await evs.next(), 'claude', 'idle', SESS2, SessionFrom.PID);
    await clk.wait();
    // A status event keeps the session.
    d.event(statusEvent('t1', 'working'));
    want(await evs.next(), 'claude', 'working', SESS2, SessionFrom.PID);
    await clk.wait(); // the status change woke the follower: a stamp check
    expect(r.resolves).toBe(2);
    // The agent leaves in the middle of its turn: done, then nothing.
    d.event(foregroundEvent('t1', 50, 'zsh', '/w'));
    want(await evs.next(), 'claude', 'done', SESS2, SessionFrom.PID);
    want(await evs.next(), '', '');
    clk.advance(60_000);
    await clk.quiet();
    await evs.none();
  });

  // While nothing is found, resolve runs after 1, 2, 4 and 8 s, then every
  // 30 s, on status changes and when the stamp changes (checked every
  // poll).
  test('the retry schedule', async () => {
    const clk = new FakeClock();
    const r = new FakeResolver();
    r.set(200, null, 'a');
    const { d, evs } = detector({ resolver: r, clock: clk });
    d.resync([agentTerm('t1', 'codex', 200, '/w')]);
    want(await evs.next(), 'codex', 'idle');
    clk.advance(await clk.wait()); // the grace
    let i = 0;
    for (const backoff of [1000, 2000, 4000, 8000]) {
      expect([await clk.wait(), r.resolves]).toEqual([backoff, ++i]);
      clk.advance(backoff);
    }
    // Five tries; then the stamp every 5 s (Codex) and resolve every 30 s.
    for (let n = 0; n < 6; n++) {
      expect([await clk.wait(), r.resolves]).toEqual([T.codexStampMs, 5]);
      clk.advance(T.codexStampMs);
    }
    await clk.wait();
    expect(r.resolves).toBe(6);
    // A status change: the first prompt may have made the session.
    d.event(statusEvent('t1', 'working'));
    want(await evs.next(), 'codex', 'working');
    await clk.wait();
    expect(r.resolves).toBe(7);
    // A new rollout changes the stamp.
    r.set(200, { id: SESS1, source: SessionFrom.Start }, 'b');
    clk.advance(T.codexStampMs);
    want(await evs.next(), 'codex', 'working', SESS1, SessionFrom.Start);
    expect([await clk.wait(), r.resolves]).toEqual([T.codexStampMs, 8]);
  });

  // Another process in the terminal (same kind, same command line) is
  // resolved at once; when nothing is found for it, the session of the
  // process before is not kept.
  test('another process', async () => {
    const clk = new FakeClock();
    const r = new FakeResolver();
    r.set(300, { id: SESS1, source: SessionFrom.Argv }, 'a');
    const { d, evs } = detector({ resolver: r, clock: clk });
    d.resync([agentTerm('t1', 'claude', 300, '/w')]);
    await evs.next();
    clk.advance(await clk.wait());
    want(await evs.next(), 'claude', 'idle', SESS1, SessionFrom.Argv);
    await clk.wait();
    d.event(foregroundEvent('t1', 301, 'claude', '/w'));
    want(await evs.next(), 'claude', 'idle');
    expect(await clk.wait()).toBe(T.sessionRetryMs);
    r.set(301, { id: SESS3, source: SessionFrom.PID }, 'c');
    clk.advance(T.sessionRetryMs);
    want(await evs.next(), 'claude', 'idle', SESS3, SessionFrom.PID);
  });

  // Peers counts the other terminals with an agent of the kind in the same
  // directory, and leaves out the terminal resolved for.
  test('peers', async () => {
    const clk = new FakeClock(); // never advanced: the followers stay in their grace
    const r = new FakeResolver();
    const { d } = detector({ resolver: r, clock: clk });
    const finished = { ...agentTerm('t6', 'claude', 6, '/w'), state: 'finished' };
    d.resync([
      agentTerm('t1', 'claude', 1, '/w'),
      agentTerm('t2', 'claude', 2, '/w/'),
      agentTerm('t3', 'claude', 3, '/x'),
      agentTerm('t4', 'codex', 4, '/w'),
      agentTerm('t5', 'zsh', 5, '/w'),
      finished,
    ]);
    let peers = -1;
    r.onResolve = (kind, p) => void (peers = d.peers(kind, p.cwd));
    const resolveFor = (addr: string, kind: string, cwd: string) =>
      (d as unknown as { resolve(a: string, k: string, p: Proc, s: AbortSignal): Promise<unknown> }).resolve(
        addr,
        kind,
        { pid: 1, argv: [], cwd },
        new AbortController().signal,
      );
    for (const [addr, kind, cwd, n] of [
      ['t1', 'claude', '/w', 1], // t2; not itself
      ['t2', 'claude', '/w', 1],
      ['t9', 'claude', '/w', 2], // a terminal not followed: t1 and t2
      ['t3', 'claude', '/x', 0],
      ['t4', 'codex', '/w', 0],
      ['t5', 'zsh', '/w', 0],
    ] as const) {
      peers = -1;
      await resolveFor(addr, kind, cwd);
      expect([addr, peers]).toEqual([addr, n]);
    }
  });

  // Only agents whose transcripts are read get a session follower.
  test('only for kinds with transcripts', async () => {
    const clk = new FakeClock();
    const { d, evs } = detector({ resolver: failResolver, clock: clk });
    d.resync([agentTerm('t1', 'gemini', 1, '/w')]);
    want(await evs.next(), 'gemini', 'idle');
    await clk.quiet();
    expect([hasSessions('claude'), hasSessions('codex'), hasSessions('gemini'), hasSessions('nope')]).toEqual([true, true, false, false]);
  });

  // Many terminals change their programs, statuses and sessions at once
  // while their sessions are resolved (resolve asking peers): the last
  // event of each terminal is its final state, so no event overtook a
  // later one.
  test('many terminals at once', async () => {
    const terms = 40;
    const sessionOf = (pid: number) => `${pid.toString(16).padStart(8, '0')}-0000-4000-8000-${pid.toString(16).padStart(12, '0')}`;
    const r = new FakeResolver();
    // A fast clock: every wait is a thousandth.
    const fast: Clock = {
      now: () => Date.now(),
      timer: (ms, fn) => {
        const t = setTimeout(fn, ms / 1000);
        return () => clearTimeout(t);
      },
    };
    const last = new Map<string, DetectEvent>();
    const stop = new AbortController();
    stops.push(stop);
    const d = new Detector({ core: noCore, send: (e) => last.set(e.terminal, e), resolver: r, signal: stop.signal, clock: fast });
    r.onResolve = async (kind, p) => {
      d.peers(kind, p.cwd);
      await new Promise((res) => setTimeout(res, Math.random() * 2));
    };
    const setPID = (pid: number) => r.set(pid, { id: sessionOf(pid), source: SessionFrom.PID }, String(pid));
    const list: Terminal[] = [];
    for (let i = 0; i < terms; i++) {
      setPID(1000 + i);
      list.push(agentTerm(`t${i}`, 'claude', 1000 + i, `/w${i % 3}`));
    }
    d.resync(list);
    const finalPID: number[] = [];
    for (let n = 0; n < 1200; n++) {
      const i = Math.floor(Math.random() * terms);
      const addr = `t${i}`;
      switch (n % 5) {
        case 0:
        case 1:
          d.event(statusEvent(addr, ['working', 'idle', 'blocked'][Math.floor(Math.random() * 3)]));
          break;
        case 2: {
          const pid = 5000 + n;
          setPID(pid);
          d.event(foregroundEvent(addr, pid, 'claude', `/w${i % 3}`));
          break;
        }
        case 3:
          d.event(foregroundEvent(addr, 1, 'zsh', '/'));
          d.event(foregroundEvent(addr, 1000 + i, 'claude', `/w${i % 3}`));
          break;
        case 4: // a new stamp of the same session
          r.set(1000 + i, { id: sessionOf(1000 + i), source: SessionFrom.PID }, String(n));
          break;
      }
      if (n % 50 === 0) await new Promise((res) => setTimeout(res, 1));
    }
    // Each terminal ends with a known process and status.
    for (let i = 0; i < terms; i++) {
      const pid = 9000 + i;
      setPID(pid);
      d.event(foregroundEvent(`t${i}`, pid, 'claude', '/w'));
      d.event(statusEvent(`t${i}`, 'working'));
      finalPID[i] = pid;
    }
    const deadline = Date.now() + 10_000;
    for (;;) {
      const bad = Array.from({ length: terms }, (_, i) => last.get(`t${i}`)).find(
        (e, i) => e?.agent !== 'claude' || e.status !== 'working' || e.session !== sessionOf(finalPID[i]),
      );
      if (!bad) break;
      if (Date.now() > deadline) throw new Error(`last event ${JSON.stringify(bad)}`);
      await new Promise((res) => setTimeout(res, 20));
    }
  });
});

// The chat host's terminal (its reserved name and hidden label, both) is
// never watched: whatever runs in its foreground, no event about it
// leaves, from the first snapshot, a creation or a later change, and it
// counts as no peer; a terminal that only carries the label is the user's
// and is followed as any other.
test('the product’s helpers are not watched', async () => {
  const { d, evs } = detector();
  const helper = (addr: string, pid: number): Terminal => ({
    ...agentTerm(addr, 'claude', pid, '/w'),
    name: CHAT_HOST_NAME,
    labels: { [HIDDEN_LABEL]: HIDDEN_CHAT_HOST },
  });
  const labeled = { ...agentTerm('t2', 'claude', 2, '/w'), labels: { [HIDDEN_LABEL]: HIDDEN_CHAT_HOST } };
  d.resync([helper('t1', 1), labeled]);
  const first = await evs.next();
  expect([first.terminal, first.agent]).toEqual(['t2', 'claude']);
  await evs.none();
  d.event(ev('created', 't3', helper('t3', 3)));
  d.event(foregroundEvent('t1', 10, 'codex', '/w'));
  d.event(statusEvent('t1', 'working'));
  d.event(foregroundEvent('t3', 11, 'claude', '/w'));
  d.event(ev('finished', 't3'));
  d.event(ev('removed', 't3'));
  await evs.none();
  expect(d.peers('claude', '/w')).toBe(1);
  d.event({ ...ev('', ''), method: 'missed', terminals: [helper('t1', 1), labeled, helper('t4', 4)] });
  await evs.none();
});

test('an agent replacing another, finished, lost, removed and missed', async () => {
  const { d, evs } = detector();
  d.resync([agentTerm('t1', 'claude', 1, '/w')]);
  want(await evs.next(), 'claude', 'idle');
  // Another agent takes the foreground: no event without agent between.
  d.event(foregroundEvent('t1', 2, 'codex', '/w'));
  want(await evs.next(), 'codex', 'idle');
  d.event(ev('lost', 't1'));
  want(await evs.next(), '', '');
  d.event(foregroundEvent('t1', 3, 'claude', '/w'));
  want(await evs.next(), 'claude', 'idle');
  d.event(statusEvent('t1', 'working'));
  want(await evs.next(), 'claude', 'working');
  d.event(ev('finished', 't1'));
  want(await evs.next(), 'claude', 'done');
  want(await evs.next(), '', '');
  d.event(ev('restarted', 't1', agentTerm('t1', 'claude', 4, '/w')));
  want(await evs.next(), 'claude', 'idle');
  // A missed: the snapshot is the whole state; a terminal not in it goes.
  d.event({ ...ev('', ''), method: 'missed', terminals: [agentTerm('t2', 'kimi', 5, '/w')] });
  const a = await evs.next();
  const b = await evs.next();
  expect([a, b]).toEqual([
    { terminal: 't1', agent: '', status: '' },
    { terminal: 't2', agent: 'kimi', status: 'idle' },
  ]);
  d.event(ev('removed', 't2'));
  want(await evs.next(), '', '');
  // Events of an added machine's terminals are not this terminal core's.
  d.event({ ...foregroundEvent('t9', 9, 'claude', '/w'), machine: 'far' });
  await evs.none();
});

// A terminal core in memory: an observing attach whose output says when
// the screen changed, and terminal.read of the screen now.
class ScreenCore implements DetectCore {
  screen = '';
  readonly reads: unknown[] = [];
  readonly attaches: AttachParams[] = [];
  private outputs: Array<(o: Output | null) => void> = [];
  private pending: Output[] = [];

  async attach(p: AttachParams) {
    this.attaches.push(p);
    return {
      stream: {
        recv: () =>
          new Promise<Output | null>((resolve) => (this.pending.length ? resolve(this.pending.shift()!) : this.outputs.push(resolve))),
        ack: () => {},
        close: () => {},
      },
    };
  }

  async call<R>(method: string, params?: unknown): Promise<R> {
    if (method !== 'terminal.read') throw new Error(`no ${method}`);
    this.reads.push(params);
    return { text: this.screen } as R;
  }

  /** The program draws s. */
  draw(s: string): void {
    this.screen = s;
    const o = { data: Buffer.from(s) };
    const w = this.outputs.shift();
    if (w) w(o);
    else this.pending.push(o);
  }
}

// A program that reports nothing: its screen read after its output, never
// during the startup grace, never with history lines; working, blocked,
// then done once idle is confirmed.
test('the screen', async () => {
  const core = new ScreenCore();
  const timing = { startupGraceMs: 60, pollMs: 20, idleRecheckMs: 10, idleCapMs: 70 };
  const { d, evs } = detector({ core, timing });
  const t = { ...agentTerm('t1', 'claude', 1, '/w'), status: null, reported: false };
  d.resync([t]);
  want(await evs.next(), 'claude', 'unknown');
  core.draw('✻ Thinking… (3s · esc to interrupt)\n');
  want(await evs.next(), 'claude', 'working');
  expect(core.reads.length).toBeGreaterThan(0);
  core.draw(' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n');
  want(await evs.next(), 'claude', 'blocked');
  core.draw('⏺ Done.\n───\n❯ \n───\n');
  want(await evs.next(), 'claude', 'done');
  for (const p of core.reads) expect(p).toEqual({ terminal: 't1' });
  expect(core.attaches).toEqual([{ terminal: 't1', cols: 80, rows: 24, observe: true }]);
  // The program reports its own status: the screen no longer counts (a
  // read that began before is the last).
  d.event(statusEvent('t1', 'working'));
  want(await evs.next(), 'claude', 'working');
  await new Promise((r) => setTimeout(r, 60));
  const reads = core.reads.length;
  core.draw('⏺ Done.\n───\n❯ \n───\n');
  await evs.none(150);
  expect(core.reads.length).toBe(reads);
});
