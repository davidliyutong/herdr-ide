// One agent's state in one terminal, and which status to report: working,
// blocked, idle, done (a turn that ended: working or blocked became idle)
// or unknown (just started, or a screen the manifest knows nothing
// about). Timing and states as herdr's (src/pane/agent_detection.rs).
import { evaluate, State, type Input, type Manifest } from './manifest.ts';

export interface TrackerTiming {
  /** After an agent appears its screen is still the shell's or its
   * splash: it is not read for this long. */
  startupGraceMs: number;
  /** A change from working to idle without visible idle chrome is held
   * until idleConfirmations more reads (idleRecheckMs apart) agree, or for
   * at most idleCapMs: a spinner between two frames reads as idle. */
  idleRecheckMs: number;
  idleConfirmations: number;
  idleCapMs: number;
  /** How often a terminal with new output is read. */
  pollMs: number;
}

export const TRACKER_TIMING: TrackerTiming = {
  startupGraceMs: 3000,
  idleRecheckMs: 100,
  idleConfirmations: 3,
  idleCapMs: 700,
  pollMs: 300,
};

/** A status and whether it changed. */
export type Change = [status: string, changed: boolean];

export class Tracker {
  private readonly manifest: Manifest | undefined;
  private readonly timing: TrackerTiming;
  /** The last state accepted (idle, working, blocked, unknown). */
  private state: string = State.Unknown;
  /** What was reported. */
  private reportedStatus: string = State.Unknown;
  private readonly graceUntil: number;
  /** When a working → idle change was first seen; null for none. */
  private pendingSince: number | null = null;
  private confirmed = 0;
  /** The program reports its own status (OSC 7501), which takes
   * precedence over the screen. */
  private reported = false;

  /** Starts following an agent that appeared at now (ms); m is its
   * manifest, undefined when there is none (its status stays unknown
   * unless the program reports one). */
  constructor(m: Manifest | undefined, now: number, timing: TrackerTiming = TRACKER_TIMING) {
    this.manifest = m;
    this.timing = timing;
    this.graceUntil = now + timing.startupGraceMs;
  }

  /** The status last reported. */
  status(): string {
    return this.reportedStatus;
  }

  /** A working → idle change waits for confirmation: the screen is read
   * again after idleRecheckMs without new output. */
  pending(): boolean {
    return this.pendingSince !== null;
  }

  /** How long the startup grace lasts from now. */
  graceLeft(now: number): number {
    return Math.max(this.graceUntil - now, 0);
  }

  /** The program's own status is in effect. */
  selfReported(): boolean {
    return this.reported;
  }

  private accept(state: string): Change {
    const prev = this.state;
    this.state = state;
    let status = state;
    if (state === State.Idle && (prev === State.Working || prev === State.Blocked)) status = State.Done;
    else if (state === State.Idle && this.reportedStatus === State.Done) status = State.Done; // still the turn that ended
    if (status === this.reportedStatus) return [status, false];
    this.reportedStatus = status;
    return [status, true];
  }

  /** Applies the status the program reported itself through herdr-core
   * (OSC 7501: idle, working, blocked, done or error; "" when it cleared
   * it). While one is in effect the screen is not read; it changes at
   * once, without the confirmation the screen needs. */
  report(state: string): Change {
    this.pendingSince = null;
    this.confirmed = 0;
    switch (state) {
      case '':
        this.reported = false;
        return [this.reportedStatus, false];
      case State.Done:
        this.reported = true;
        if (this.state === State.Idle && this.reportedStatus === State.Done) return [this.reportedStatus, false];
        // The program says its turn ended.
        this.state = State.Working;
        return this.accept(State.Idle);
      case 'error':
        this.reported = true;
        return this.accept(State.Blocked);
      case State.Idle:
      case State.Working:
      case State.Blocked:
        this.reported = true;
        return this.accept(state);
    }
    this.reported = true;
    return this.accept(State.Unknown);
  }

  /** Evaluates a read of the screen at now (ms). */
  observe(now: number, input: Input): Change {
    if (this.reported || !this.manifest || now < this.graceUntil) return [this.reportedStatus, false];
    const r = evaluate(this.manifest, input);
    if (r.skip) {
      this.pendingSince = null;
      this.confirmed = 0;
      return [this.reportedStatus, false];
    }
    if (this.state === State.Working && r.state === State.Idle && !r.visibleIdle && !r.visibleBlocker) {
      if (this.pendingSince === null) {
        this.pendingSince = now;
        this.confirmed = 0;
        return [this.reportedStatus, false];
      }
      if (now - this.pendingSince < this.timing.idleCapMs && ++this.confirmed < this.timing.idleConfirmations)
        return [this.reportedStatus, false];
    }
    this.pendingSince = null;
    this.confirmed = 0;
    return this.accept(r.state);
  }

  /** What to report when the agent leaves the terminal's foreground: a
   * turn it was in the middle of ended (done), else nothing. */
  exit(): Change {
    if (this.state === State.Working || this.state === State.Blocked) return this.accept(State.Idle);
    return [this.reportedStatus, false];
  }
}
