// Which coding agents run in the terminal core's terminals and what they
// do (op detect, docs/features/25-agent-detection.md), for as long as the
// core keeps the stream open. The detector follows the terminals' records
// (detect.ts feeds it the terminal core's events) and, for each terminal
// whose foreground program is an agent, attaches as an observer (output
// says when to read the screen again) and reads the screen
// (terminal.read, never with history lines, which would scroll a program
// on the alternate screen for every viewer). With a session resolver it
// also finds the session each agent uses: once the agent's startup grace
// is over, again 1, 2, 4 and 8 s later while nothing is found, then on
// every status change, whenever the files the resolver reads change (its
// stamp, checked every 2 s for Claude Code, whose /clear rewrites its
// record, 5 s for Codex) and every 30 s.
//
// Every event of an agent carries the session last found, so an event
// changes either the status or the session, and the core tells a new
// session from news that way. Events leave in the order they were made.
import { byId, validSessionId } from '#shared/agents/kinds.ts';
import { HIDDEN_LABEL, hidden, type DetectEvent } from '#shared/proto/agentproto/index.ts';
import type { AttachParams, Foreground, Notification, Output, Status, Terminal } from '#shared/proto/hc/index.ts';
import { NO_SESSION, clean, type Found, type Proc } from '#machine/agents/sessions.ts';
import { identify } from './detect/identify.ts';
import { manifestFor } from './detect/manifests.ts';
import { TRACKER_TIMING, Tracker, type TrackerTiming } from './detect/tracker.ts';

/** What the detector asks of the terminal core (an hc Conn). */
export interface DetectCore {
  attach(p: AttachParams, o: { signal?: AbortSignal }): Promise<{ stream: ObservedStream }>;
  call<T = unknown>(method: string, params?: unknown, o?: { signal?: AbortSignal }): Promise<T>;
}

export interface ObservedStream {
  recv(signal?: AbortSignal): Promise<Output | null>;
  ack(n: number): void;
  close(): void;
}

/** Finds the sessions of agents (#machine/agents/sessions.ts Resolver). */
export interface SessionResolver {
  resolve(kind: string, p: Proc, signal: AbortSignal): Promise<Found | null>;
  stamp(kind: string, p: Proc, last: Found): Promise<string>;
}

/** The clock of the trackers and of the sessions' schedule (tests give a
 * fake one). */
export interface Clock {
  now(): number;
  /** Calls fn after ms; the function it returns cancels. what names the
   * wait (screen, session), for tests. */
  timer(ms: number, fn: () => void, what: 'screen' | 'session'): () => void;
}

export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  timer: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export interface DetectTiming extends TrackerTiming {
  /** One read of a screen. */
  readMs: number;
  /** The wait after the first resolve that finds nothing; it doubles for
   * each of sessionRetries tries. */
  sessionRetryMs: number;
  sessionRetries: number;
  /** After those tries, an agent without a session is resolved again this
   * often (besides status and stamp changes). */
  sessionRecheckMs: number;
  /** One resolve. */
  resolveMs: number;
  /** How often the stamp of an agent's session is checked. */
  claudeStampMs: number;
  codexStampMs: number;
}

export const DETECT_TIMING: DetectTiming = {
  ...TRACKER_TIMING,
  readMs: 10_000,
  sessionRetryMs: 1000,
  sessionRetries: 4,
  sessionRecheckMs: 30_000,
  resolveMs: 10_000,
  claudeStampMs: 2000,
  codexStampMs: 5000,
};

/** Whether the detector finds the sessions of kind's agents: those whose
 * transcripts are read. */
export const hasSessions = (kind: string): boolean => !!byId(kind)?.transcript;

/** A terminal as last known, with the agent in it. */
interface Watched {
  rec: Terminal;
  agent: string;
  tracker: Tracker | null;
  stop: AbortController | null;
  /** Output chunks the observing attach saw. */
  output: number;
  /** The session last found; every event of the agent carries it. */
  session: Found;
  /** Tells the agent's session follower that its status or its process
   * changed. */
  wake: Wake | null;
}

/** A wake-up that is remembered once when nobody waits for it. */
class Wake {
  private pending = false;
  private waiter: (() => void) | null = null;

  poke(): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    } else this.pending = true;
  }

  /** Calls fn at the next poke (or now, for one remembered); the function
   * it returns cancels. */
  on(fn: () => void): () => void {
    if (this.pending) {
      this.pending = false;
      fn();
      return () => {};
    }
    this.waiter = fn;
    return () => {
      if (this.waiter === fn) this.waiter = null;
    };
  }
}

/** Whether the detector looks for an agent in the terminal of record r: a
 * live terminal's foreground process, unless the terminal is one of the
 * product's own helpers (the chat host's: its reserved name and hidden
 * label both, never the label alone), of which nothing reaches the core.
 * Every walk over the terminals asks it. */
export function watchable(r: Terminal): boolean {
  return r.state === 'live' && !!r.foreground && !hidden(r.name ?? '', (r.labels ?? {})[HIDDEN_LABEL] ?? '');
}

const sameProc = (a: { pid: number; argv: readonly string[] | null } | null, b: { pid: number; argv: readonly string[] | null } | null) => {
  if (!a || !b) return a === b;
  const x = a.argv ?? [];
  const y = b.argv ?? [];
  return a.pid === b.pid && x.length === y.length && x.every((v, i) => v === y[i]);
};

/** The state a terminal's program reported itself (OSC 7501); "" for
 * none. */
const stateOf = (r: Terminal): string => (typeof r.status?.state === 'string' ? r.status.state : '');

/** Makes r a copy of t. */
function replace(r: Terminal, t: Terminal): void {
  for (const k of Object.keys(r)) delete r[k];
  Object.assign(r, structuredClone(t));
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A foreground of an event's data, as Go decoded it: null when it is none. */
function foregroundOf(v: unknown): Foreground | null {
  if (!isObj(v) || typeof v.pid !== 'number') return null;
  return {
    pid: v.pid,
    name: typeof v.name === 'string' ? v.name : '',
    argv: Array.isArray(v.argv) ? v.argv.filter((a): a is string => typeof a === 'string') : null,
    cwd: typeof v.cwd === 'string' ? v.cwd : '',
  };
}

export interface DetectorOptions {
  core: DetectCore;
  /** Writes one event to the core, in order. */
  send(ev: DetectEvent): void;
  /** Finds the agents' sessions; none for a stream opened without
   * sessions, and then no session file is read. */
  resolver?: SessionResolver;
  /** Ends every follower. */
  signal: AbortSignal;
  clock?: Clock;
  timing?: Partial<DetectTiming>;
}

/** Follows the terminals of one terminal core. */
export class Detector {
  private readonly core: DetectCore;
  private readonly send: (ev: DetectEvent) => void;
  resolver: SessionResolver | undefined;
  private readonly signal: AbortSignal;
  private readonly clock: Clock;
  private readonly timing: DetectTiming;
  private readonly terms = new Map<string, Watched>();
  /** One resolve runs at a time; resolving is the terminal it runs for,
   * which peers leaves out. */
  private resolving = '';
  private resolveQueue: Promise<unknown> = Promise.resolve();

  constructor(o: DetectorOptions) {
    this.core = o.core;
    this.send = o.send;
    this.resolver = o.resolver;
    this.signal = o.signal;
    this.clock = o.clock ?? REAL_CLOCK;
    this.timing = { ...DETECT_TIMING, ...o.timing };
    this.signal.addEventListener('abort', () => this.stopAll(), { once: true });
  }

  /** Takes the terminal core's terminals as they are now (a subscription's
   * snapshot, a "missed"). */
  resync(list: readonly Terminal[]): void {
    const seen = new Set(list.map((t) => t.address));
    for (const addr of [...this.terms.keys()]) if (!seen.has(addr)) this.remove(addr);
    for (const t of list) this.update(t.address, (r) => replace(r, t));
  }

  /** Applies one notification of the terminal core's subscription. */
  event(n: Notification): void {
    if (n.method === 'missed') {
      this.resync(n.terminals ?? []);
      return;
    }
    if (n.method !== 'event' || n.terminal === '' || n.machine !== '') return;
    const data = isObj(n.data) ? n.data : {};
    switch (n.type) {
      case 'created':
      case 'restarted':
        if (isObj(n.data)) {
          const t = n.data as unknown as Terminal;
          this.update(n.terminal, (r) => replace(r, t));
        }
        break;
      case 'removed':
        this.remove(n.terminal);
        break;
      case 'foreground':
        this.update(n.terminal, (r) => (r.foreground = foregroundOf(n.data)));
        break;
      case 'finished':
        this.update(n.terminal, (r) => {
          r.state = 'finished';
          r.foreground = null;
          r.status = null;
        });
        break;
      case 'lost':
        this.update(n.terminal, (r) => (r.foreground = null));
        break;
      case 'status':
        this.update(n.terminal, (r) => (r.status = isObj(data.status) ? (data.status as unknown as Status) : null));
        break;
      case 'title':
        this.update(n.terminal, (r) => (r.title = typeof data.title === 'string' ? data.title : ''));
        break;
      case 'size':
        this.update(n.terminal, (r) => {
          r.cols = typeof data.cols === 'number' ? data.cols : 0;
          r.rows = typeof data.rows === 'number' ? data.rows : 0;
        });
        break;
    }
  }

  /** Ends every follower. */
  stopAll(): void {
    for (const w of this.terms.values()) w.stop?.abort();
  }

  /** How many other terminals than the one resolved for run an agent of
   * kind in directory cwd (the resolver's peers). */
  peers(kind: string, cwd: string): number {
    let n = 0;
    for (const [addr, w] of this.terms) {
      if (addr === this.resolving || w.agent !== kind || !watchable(w.rec)) continue;
      const c = w.rec.foreground!.cwd;
      if (c !== '' && cwd !== '' && clean(c) === clean(cwd)) n++;
    }
    return n;
  }

  private eventOf(addr: string, w: Watched, status: string): DetectEvent {
    const ev: DetectEvent = { terminal: addr, agent: w.agent, status };
    if (w.session.id) {
      ev.session = w.session.id;
      ev.session_source = w.session.source;
    }
    return ev;
  }

  private remove(addr: string): void {
    const w = this.terms.get(addr);
    this.terms.delete(addr);
    if (w && w.agent) this.leave(addr, w, true);
  }

  /** Stops following w's agent: a turn it was in ended (done), then, with
   * clear, the terminal has no agent (an event without agent, status and
   * session). */
  private leave(addr: string, w: Watched, clear: boolean): void {
    const [status, changed] = w.tracker!.exit();
    if (changed) this.send(this.eventOf(addr, w, status));
    w.stop?.abort();
    w.agent = '';
    w.tracker = null;
    w.stop = null;
    w.wake = null;
    w.session = NO_SESSION;
    if (clear) this.send({ terminal: addr, agent: '', status: '' });
  }

  /** Changes terminal addr's record and follows what that changes: the
   * agent in its foreground, the status its program reports. */
  private update(addr: string, change: (r: Terminal) => void): void {
    let w = this.terms.get(addr);
    if (!w) {
      w = { rec: { address: addr } as Terminal, agent: '', tracker: null, stop: null, output: 0, session: NO_SESSION, wake: null };
      this.terms.set(addr, w);
    }
    const before = w.rec.foreground ?? null;
    change(w.rec);
    w.rec.address = addr;
    const fg = w.rec.foreground ?? null;
    const agent = watchable(w.rec) ? identify(fg!.name, fg!.argv) : '';
    if (agent !== w.agent) {
      // An agent that replaces another needs no event without agent
      // between them.
      if (w.agent) this.leave(addr, w, agent === '');
      if (agent) this.start(addr, w, agent);
      return;
    }
    if (!agent) return;
    const state = stateOf(w.rec);
    if (state !== '' || w.tracker!.selfReported()) {
      const [status, changed] = w.tracker!.report(state);
      if (changed) {
        this.send(this.eventOf(addr, w, status));
        w.wake?.poke();
      }
    }
    if (!sameProc(before, fg)) w.wake?.poke();
  }

  private start(addr: string, w: Watched, agent: string): void {
    const stop = new AbortController();
    if (this.signal.aborted) stop.abort();
    const tracker = new Tracker(manifestFor(agent), this.clock.now(), this.timing);
    w.agent = agent;
    w.tracker = tracker;
    w.stop = stop;
    if (w.rec.status) tracker.report(stateOf(w.rec));
    this.send(this.eventOf(addr, w, tracker.status()));
    void this.follow(addr, w, tracker, stop.signal);
    if (this.resolver && hasSessions(agent)) {
      w.wake = new Wake();
      void this.followSession(addr, w, tracker, w.wake, stop.signal);
    }
  }

  /** Waits ms on the detector's clock, or until signal ends or wake is
   * poked: which of them came first. */
  private sleep(ms: number, what: 'screen' | 'session', signal: AbortSignal, wake?: Wake): Promise<'time' | 'wake' | 'abort'> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve('abort');
      let settled = false;
      const cleanup: Array<() => void> = [];
      const done = (why: 'time' | 'wake' | 'abort') => {
        if (settled) return;
        settled = true;
        for (const c of cleanup) c();
        resolve(why);
      };
      const keep = (off: () => void) => (settled ? off() : cleanup.push(off));
      const onAbort = () => done('abort');
      signal.addEventListener('abort', onAbort, { once: true });
      cleanup.push(() => signal.removeEventListener('abort', onAbort));
      // A poke made while nobody waited wins over the time.
      if (wake) keep(wake.on(() => done('wake')));
      if (!settled) keep(this.clock.timer(ms, () => done('time'), what));
    });
  }

  /** Reads the screen of terminal addr while tracker's agent runs there:
   * every pollMs when output arrived since the last read, every
   * idleRecheckMs while an idle reading waits for confirmation, never
   * during the startup grace or while the program reports its own
   * status. */
  private async follow(addr: string, w: Watched, tracker: Tracker, signal: AbortSignal): Promise<void> {
    const cols = Math.max(w.rec.cols ?? 0, 1);
    const rows = Math.max(w.rec.rows ?? 0, 1);
    let always = false;
    try {
      const { stream } = await this.core.attach({ terminal: addr, cols, rows, observe: true }, { signal });
      void (async () => {
        try {
          for (;;) {
            const o = await stream.recv(signal);
            if (o === null) return;
            if ('data' in o && o.data.length > 0) {
              stream.ack(o.data.length);
              w.output++;
            }
          }
        } catch {
          // ended
        } finally {
          stream.close();
        }
      })();
    } catch {
      // No activity to go by: read on every poll.
      always = true;
    }
    let read = -1; // read once the grace is over
    for (;;) {
      const now = this.clock.now();
      let wait = tracker.pending() ? this.timing.idleRecheckMs : this.timing.pollMs;
      const left = tracker.graceLeft(now);
      if (left > 0) wait = left;
      const pending = tracker.pending();
      const self = tracker.selfReported();
      if ((await this.sleep(wait, 'screen', signal)) === 'abort') return;
      if (self) continue;
      const out = w.output;
      if (out === read && !pending && !always) continue;
      read = out;
      let text: string;
      try {
        const sig = AbortSignal.any([signal, AbortSignal.timeout(this.timing.readMs)]);
        const res = await this.core.call<{ text?: unknown }>('terminal.read', { terminal: addr }, { signal: sig });
        text = typeof res?.text === 'string' ? res.text : '';
      } catch {
        if (signal.aborted) return;
        continue;
      }
      if (w.tracker !== tracker) return; // another agent took over meanwhile
      const [status, changed] = tracker.observe(this.clock.now(), { screen: text, title: w.rec.title ?? '' });
      if (changed) {
        this.send(this.eventOf(addr, w, status));
        w.wake?.poke();
      }
    }
  }

  /** The foreground process of w's terminal; null once tracker's agent
   * left it. */
  private procOf(w: Watched, tracker: Tracker): Proc | null {
    if (w.tracker !== tracker || !watchable(w.rec)) return null;
    const fg = w.rec.foreground!;
    return { pid: fg.pid, argv: [...(fg.argv ?? [])], cwd: fg.cwd };
  }

  /** Finds and follows the session of w's agent in terminal addr while
   * tracker is the agent's (until signal ends, which the agent's leaving
   * and the end of the stream do). */
  private async followSession(addr: string, w: Watched, tracker: Tracker, wake: Wake, signal: AbortSignal): Promise<void> {
    const kind = w.agent;
    if ((await this.sleep(tracker.graceLeft(this.clock.now()), 'session', signal)) === 'abort') return;
    const t = this.timing;
    const poll = byId(kind)?.transcript === 'codex' ? t.codexStampMs : t.claudeStampMs;
    let last: Found = NO_SESSION; // the session of proc, as last found
    let proc: Proc | null = null; // the process resolve last ran for
    let stamp = ''; // the stamp taken before that resolve
    let fails = 0; // resolves in a row that found nothing
    let due = 0; // when, while nothing is found, resolve runs again
    let force = true;
    const retryDelay = (n: number) => (n >= 1 && n <= t.sessionRetries ? t.sessionRetryMs * 2 ** (n - 1) : t.sessionRecheckMs);
    for (;;) {
      const p = this.procOf(w, tracker);
      if (!p) return;
      if (!sameProc(p, proc)) {
        // Another process: its tries start over.
        force = true;
        fails = 0;
      } else if (last.id === '' && this.clock.now() >= due) force = true;
      // The stamp is taken before resolve reads: a change while it reads
      // shows in the next stamp.
      let s = '';
      try {
        s = await this.resolver!.stamp(kind, p, last);
      } catch {
        // as no stamp
      }
      if (signal.aborted) return;
      if (s !== stamp) force = true;
      if (force) {
        stamp = s;
        let found = await this.resolve(addr, kind, p, signal);
        if (signal.aborted) return;
        if (found) fails = 0;
        else {
          fails++;
          due = this.clock.now() + retryDelay(fails);
          // The same process keeps the session it was found to have (its
          // record may be being rewritten).
          found = sameProc(p, proc) ? last : NO_SESSION;
        }
        proc = p;
        last = found;
        if (!this.setSession(addr, w, tracker, found)) return;
        force = false;
      }
      let wait = poll;
      if (last.id === '') {
        const left = Math.max(due - this.clock.now(), 0);
        wait = fails <= t.sessionRetries ? left : Math.min(wait, left);
      }
      const why = await this.sleep(wait, 'session', signal, wake);
      if (why === 'abort') return;
      // While nothing is found, a status change may come with the session
      // (Codex makes it at the first prompt); otherwise the process and
      // the stamp are checked.
      if (why === 'wake') force = last.id === '';
    }
  }

  /** Records the session found for tracker's agent in terminal addr and,
   * when it changed, sends the agent's event with its status; false once
   * the agent left. */
  private setSession(addr: string, w: Watched, tracker: Tracker, found: Found): boolean {
    if (w.tracker !== tracker) return false;
    if (w.session.id !== found.id || w.session.source !== found.source) {
      w.session = found;
      this.send(this.eventOf(addr, w, tracker.status()));
    }
    return true;
  }

  /** Resolves the session of the agent of kind in terminal addr, one at a
   * time and within resolveMs. A session that is not a session id with a
   * source counts as none. */
  private resolve(addr: string, kind: string, p: Proc, signal: AbortSignal): Promise<Found | null> {
    const run = async (): Promise<Found | null> => {
      if (signal.aborted) return null;
      this.resolving = addr;
      try {
        const f = await this.resolver!.resolve(kind, p, AbortSignal.any([signal, AbortSignal.timeout(this.timing.resolveMs)]));
        return f && validSessionId(f.id) && f.source ? f : null;
      } catch {
        return null;
      } finally {
        this.resolving = '';
      }
    };
    const next = this.resolveQueue.then(run, run);
    this.resolveQueue = next.catch(() => {});
    return next;
  }
}
