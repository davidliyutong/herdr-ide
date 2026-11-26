// The coding agents detected in a machine's terminals (op detect, feature
// 25): merged into the terminal records as agent and agent_status, with
// the session the agent runs as (agent_session, agent_session_source;
// feature 35) while the machines resolve sessions. Each change reaches
// the subscribers of the terminal protocol as an "agent" event and /ws as
// an agent message, which notifications and sounds follow. A turn that
// ended (done) counts as seen (idle) once a client has the terminal
// focused, and that outlives the terminal core through a label.
import { setTimeout as delay } from 'node:timers/promises';
import { validSessionId } from '#shared/agents/kinds.ts';
import { retryDelay } from '#shared/lib/wait.ts';
import { Op, readLine, SessionFrom, type DetectEvent } from '#shared/proto/agentproto/index.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { closeStream } from '#kernel/machines/transport/session.ts';
import { otherMachine, isObject, type Rec } from './records.ts';

/** The label that keeps which turn of a terminal's program a client saw
 * end: the record's turn, when the program reports its own status (OSC
 * 7501) and still says done. That report outlives the hub: after the hub
 * or the agent starts again, a new detection reads it as a turn that just
 * ended, and the label tells that it was seen. */
export const SEEN_LABEL = 'seen';

/** What the agents need of the backend they belong to. */
export interface AgentHost {
  /** The machine's id. */
  readonly id: string;
  /** A terminal's record the clients have. */
  record(addr: string): Rec | undefined;
  /** Whether the terminal is hidden (its agent is nobody's to know). */
  isHidden(addr: string): boolean;
  /** Whether a client has a stream of the terminal with the focus. */
  focused(addr: string): boolean;
  /** Sets labels of a terminal in the background. */
  label(addr: string, labels: Record<string, string>): void;
  /** Sends a message to the subscribers of the terminal protocol. */
  broadcast(msg: object): void;
  /** Sends an agent message to /ws. */
  notify(data: object): void;
}

const SOURCES: ReadonlySet<string> = new Set(Object.values(SessionFrom));

/** ev without a session that is not a session id with a known source, for
 * an agent. */
export function checkSession(ev: DetectEvent): DetectEvent {
  const out: DetectEvent = { terminal: ev.terminal, agent: ev.agent, status: ev.status };
  if (ev.agent && validSessionId(ev.session ?? '') && SOURCES.has(ev.session_source ?? '')) {
    out.session = ev.session;
    out.session_source = ev.session_source;
  }
  return out;
}

/** A line of a detect stream as Go read it: members of the wrong type make
 * the line, and the stream, invalid (undefined). */
export function detectEvent(v: unknown): DetectEvent | undefined {
  if (!isObject(v)) return v === null ? { terminal: '', agent: '', status: '' } : undefined;
  const s = (k: string): string | undefined =>
    v[k] === undefined || v[k] === null ? '' : typeof v[k] === 'string' ? (v[k] as string) : undefined;
  const ev = {
    terminal: s('terminal'),
    agent: s('agent'),
    status: s('status'),
    session: s('session'),
    session_source: s('session_source'),
  };
  if (Object.values(ev).some((x) => x === undefined)) return undefined;
  return ev as DetectEvent;
}

/** Whether an agent message of the status makes the pages notify (a
 * sound, the system's notification): a block or a turn's end. */
const notifies = (status: string) => status === 'blocked' || status === 'done';

const same = (a: DetectEvent, b: DetectEvent) =>
  a.terminal === b.terminal &&
  a.agent === b.agent &&
  a.status === b.status &&
  (a.session ?? '') === (b.session ?? '') &&
  (a.session_source ?? '') === (b.session_source ?? '');

/** The agents of one machine's terminals, by address. */
export class Agents {
  private readonly byTerminal = new Map<string, DetectEvent>();
  private readonly host: AgentHost;

  constructor(host: AgentHost) {
    this.host = host;
  }

  get(addr: string): DetectEvent | undefined {
    return this.byTerminal.get(addr);
  }

  get size(): number {
    return this.byTerminal.size;
  }

  /** Forgets every agent, telling nobody (a new connection to the core). */
  reset(): void {
    this.byTerminal.clear();
  }

  /** Forgets a terminal's agent, telling nobody (it became hidden). */
  forget(addr: string): void {
    this.byTerminal.delete(addr);
  }

  /** The agents now, by terminal. */
  entries(): Map<string, DetectEvent> {
    return new Map(this.byTerminal);
  }

  /** Records a terminal's agent, status and session (DetectEvent with no
   * agent: none runs there) and tells the clients. */
  apply(ev: DetectEvent): void {
    this.applyDetected(ev, null);
  }

  /** apply for an event of a detect stream; told holds what the clients
   * were told of the terminals before the stream opened again because the
   * machines' sessions were switched (null otherwise), and is taken for
   * each terminal by its first event. An agent found again by such an
   * event keeps a done the clients saw (idle) and one they were told of,
   * and a block or a turn's end they were told of reaches /ws no second
   * time. The machine changes an agent's session in an event of its own,
   * which carries the status it already reported: such an event changes
   * only the record's session and reaches only the terminal protocol's
   * subscribers, as no news. */
  applyDetected(raw: DetectEvent, told: Map<string, DetectEvent> | null): void {
    const before = told?.get(raw.terminal);
    let again = before !== undefined;
    if (again) {
      told!.delete(raw.terminal);
      again = raw.agent !== '' && before!.agent === raw.agent;
    }
    const ev = checkSession(raw);
    const h = this.host;
    if (h.isHidden(ev.terminal) || otherMachine(ev.terminal)) {
      // What runs in a hidden terminal, or on another machine of the
      // terminal core, is not the clients' to know.
      this.byTerminal.delete(ev.terminal);
      return;
    }
    const prev = this.byTerminal.get(ev.terminal);
    let quiet = false;
    if (!ev.agent) {
      if (!prev) return;
      this.byTerminal.delete(ev.terminal);
    } else if (
      prev &&
      prev.agent === ev.agent &&
      ((prev.session ?? '') !== (ev.session ?? '') || (prev.session_source ?? '') !== (ev.session_source ?? ''))
    ) {
      // The status stays the core's (a done may have been seen since).
      const next: DetectEvent = { ...prev };
      delete next.session;
      delete next.session_source;
      if (ev.session) Object.assign(next, { session: ev.session, session_source: ev.session_source });
      this.byTerminal.set(ev.terminal, next);
      this.merge(ev.terminal);
      h.broadcast(this.message(next));
      return;
    } else {
      // The end of the turn the clients knew of before the switch, seen or
      // not.
      if (again && !prev && ev.status === 'done' && (before!.status === 'idle' || before!.status === 'done')) ev.status = before!.status;
      // Seen: the terminal has a client's focus, or (the first word of a
      // new detection, after the core or the agent started again) the
      // program still reports the turn a client saw before.
      if (ev.status === 'done' && (h.focused(ev.terminal) || (!prev && this.seenBefore(ev.terminal)))) ev.status = 'idle';
      if (prev && same(prev, ev)) return;
      quiet = again && !prev && ev.status === before!.status && notifies(ev.status);
      this.byTerminal.set(ev.terminal, ev);
      this.keepSeen(ev.terminal);
    }
    this.merge(ev.terminal);
    if (quiet) {
      // The record and the terminal protocol's subscribers get the agent
      // back; /ws was told of this state already.
      h.broadcast(this.message(ev));
      return;
    }
    this.notify(ev);
  }

  /** Marks a terminal's ended turn seen (a client focused it): done
   * becomes idle. */
  seen(addr: string): void {
    const ev = this.byTerminal.get(addr);
    if (!ev || ev.status !== 'done') return;
    const next = { ...ev, status: 'idle' };
    this.byTerminal.set(addr, next);
    this.merge(addr);
    this.keepSeen(addr);
    this.notify(next);
  }

  /** The turn whose end terminal addr's program reports (its own status is
   * done); "" when it reports no done. */
  private reportedDone(addr: string): string {
    const t = this.host.record(addr);
    if (t?.reported !== true) return '';
    if (!isObject(t.status) || t.status.state !== 'done') return '';
    const turn = typeof t.turn === 'number' && t.turn > 0 ? t.turn : 0;
    return BigInt(Math.trunc(turn)).toString();
  }

  /** Whether the done terminal addr's program reports is the turn a client
   * saw (SEEN_LABEL). */
  private seenBefore(addr: string): boolean {
    const turn = this.reportedDone(addr);
    const labels = this.host.record(addr)?.labels;
    return turn !== '' && isObject(labels) && labels[SEEN_LABEL] === turn;
  }

  /** Labels terminal addr with the turn its program reports as done while
   * the clients hold that turn seen (its agent idle), so the core still
   * knows after it starts again. The core's own event of the new label
   * follows. */
  keepSeen(addr: string): void {
    const ev = this.byTerminal.get(addr);
    const turn = this.reportedDone(addr);
    if (!ev || ev.status !== 'idle' || turn === '' || this.seenBefore(addr)) return;
    this.host.label(addr, { [SEEN_LABEL]: turn });
  }

  /** Writes a terminal's agent, status and session (absent when not known)
   * into its record. */
  merge(addr: string): void {
    const t = this.host.record(addr);
    if (!t) return;
    const ev = this.byTerminal.get(addr);
    if (ev) Object.assign(t, { agent: ev.agent, agent_status: ev.status });
    else {
      delete t.agent;
      delete t.agent_status;
    }
    if (ev?.session) Object.assign(t, { agent_session: ev.session, agent_session_source: ev.session_source });
    else {
      delete t.agent_session;
      delete t.agent_session_source;
    }
  }

  /** The terminal protocol's event of a terminal's agent: every member is
   * there, null when unknown, so that a client that merges the event into
   * its record loses a session that ended. */
  message(ev: DetectEvent): object {
    const data = {
      agent: null as string | null,
      agent_status: null as string | null,
      agent_session: null as string | null,
      agent_session_source: null as string | null,
    };
    if (ev.agent) {
      data.agent = ev.agent;
      data.agent_status = ev.status;
      if (ev.session) {
        data.agent_session = ev.session;
        data.agent_session_source = ev.session_source ?? '';
      }
    }
    return { t: 'event', m: this.host.id, type: 'agent', terminal: ev.terminal, data };
  }

  /** The agent event of a terminal that has an agent, for a record the
   * core replaced: clients get the agent again right behind. */
  again(addr: string): object | null {
    const ev = this.byTerminal.get(addr);
    return ev ? this.message(ev) : null;
  }

  /** Sends a terminal's agent change to the subscribers and to /ws. */
  private notify(ev: DetectEvent): void {
    const agent = ev.agent || null;
    const status = ev.agent ? ev.status : null;
    this.host.broadcast(this.message(ev));
    const title = this.host.record(ev.terminal)?.title;
    this.host.notify({
      agent,
      agent_status: status,
      display_agent: agent,
      terminal: ev.terminal,
      title: typeof title === 'string' ? title : '',
    });
  }
}

export interface DetectTiming {
  /** The first wait before a failed detect stream is opened again. */
  detectRetryMs: number;
  /** The longest base delay for repeated detect stream failures. */
  detectRetryMaxMs: number;
  /** A connection that lasted this long resets the retry delay. */
  stableMs: number;
  /** How long after a stream opened again because sessions were switched
   * its events are compared with what the clients were told before. */
  redetectGraceMs: number;
}

/** Follows the coding agents in the machine's terminals through its agent
 * (op detect) until signal ends, opening the stream again with backoff
 * when it fails, and at once when the agents plugin is switched. A switch makes the machine detect every
 * agent again: what the clients were told of each terminal before is kept
 * (Agents.applyDetected), so that the agents found again do not notify
 * again of a turn's end, or a block, that they were told of, nor bring back
 * a done that was seen. current() tells whether the agents are still this
 * connection's, so that a late end clears nothing of the next one. */
export async function followAgents(
  m: Machine,
  agents: Agents,
  o: {
    sessions: () => boolean;
    onSessionsChange: (changed: () => void) => () => void;
    signal: AbortSignal;
    current: () => boolean;
    timing: DetectTiming;
  },
): Promise<void> {
  const { signal, timing } = o;
  let told: Map<string, DetectEvent> | null = null;
  let retry = timing.detectRetryMs;
  while (!signal.aborted) {
    const sessions = o.sessions();
    const change = new AbortController();
    const attempt = AbortSignal.any([signal, change.signal]);
    const unsubscribe = o.onSessionsChange(() => {
      if (o.sessions() !== sessions) change.abort();
    });
    try {
      let openedAt: number | undefined;
      try {
        const { conn } = await m.open({ op: Op.Detect, ...(sessions ? { sessions } : {}) }, { signal: attempt });
        openedAt = performance.now();
        const until = Date.now() + timing.redetectGraceMs;
        const end = () => conn.stream.destroy();
        attempt.addEventListener('abort', end, { once: true });
        if (attempt.aborted) end();
        try {
          while (!attempt.aborted) {
            const ev = detectEvent(await readLine<unknown>(conn.reader));
            if (!ev || attempt.aborted) break;
            if (told && Date.now() > until) told = null;
            if (o.current()) agents.applyDetected(ev, told);
          }
        } finally {
          attempt.removeEventListener('abort', end);
          conn.reader.release();
          closeStream(conn.stream);
        }
      } catch {
        // The stream ended or could not open.
      }
      // What the stream said no longer holds: a new one says it again.
      if (!change.signal.aborted) told = null;
      else told ??= new Map();
      if (o.current()) {
        for (const [addr, ev] of agents.entries()) {
          told?.set(addr, ev);
          agents.apply({ terminal: addr, agent: '', status: '' });
        }
      }
      if (change.signal.aborted || (openedAt !== undefined && performance.now() - openedAt >= timing.stableMs)) {
        retry = timing.detectRetryMs;
      }
      if (!attempt.aborted) {
        await delay(retryDelay(retry), undefined, { signal: attempt }).catch(() => {});
        retry = change.signal.aborted ? timing.detectRetryMs : Math.min(retry * 2, timing.detectRetryMaxMs);
      }
    } finally {
      unsubscribe();
    }
  }
}
