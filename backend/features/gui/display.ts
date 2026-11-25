// The hub's record of one machine's display: its phase, the agent's
// status, the attach stream and its windows, and the bookkeeping that
// prepares the display once per connection of the machine.
import type { GUIStatus, GUIWindow } from '#shared/proto/agentproto/index.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import type { Session } from '#kernel/machines/transport/session.ts';
import { Router, type RouterDeps } from './router.ts';
import type { PhaseName, StateSource } from './state.ts';
import type { AttachStream } from './stream.ts';

/** The machine's agent session now; null without one. */
export const sessionOf = (m: Machine): Session | null => (m.connected ? m.live() : null);

export class Display implements StateSource {
  machine: Machine;
  phase: PhaseName = '';
  err = '';
  status: GUIStatus | null = null;
  /** The machine's terminal core was reachable at the last change seen
   * while the display was attached. */
  up = false;
  /** A preparation runs; again: a forced one arrived meanwhile. */
  ensuring = false;
  again = false;
  /** The session the last preparation ran for, whatever its outcome;
   * state changes of that session do not prepare again. */
  prepared: Session | null = null;
  /** Failed preparations and short-lived attachments in a row, for the
   * retry backoff. */
  failures = 0;
  /** The machine was removed: a preparation still running for it
   * publishes nothing. */
  gone = false;
  /** The attachment and the session it is on. */
  sess: Session | null = null;
  stream: AttachStream | null = null;
  /** The next attempt after a failure. */
  retry: ReturnType<typeof setTimeout> | undefined;
  /** The terminals whose shell got the export command, with the display. */
  readonly typed = new Map<string, string>();
  readonly router: Router;

  constructor(machine: Machine, deps: Omit<RouterDeps, 'send'>) {
    this.machine = machine;
    this.router = new Router({ ...deps, send: (c) => this.stream?.send(c) });
  }

  get id(): string {
    return this.machine.id;
  }

  get viewOnly(): boolean {
    return this.router.viewOnly;
  }

  get windows(): Iterable<GUIWindow> {
    return this.router.windows.values();
  }

  /** Decides whether to prepare the display for sess now; true marks a
   * preparation as running. force also retries after a preparation that
   * did not end attached for sess. */
  claim(sess: Session | null, force: boolean): boolean {
    if (!sess || (this.stream && this.sess === sess)) return false;
    if (this.ensuring) {
      this.again ||= force;
      return false;
    }
    if (!force && this.prepared === sess) return false;
    if (this.prepared !== sess) this.failures = 0;
    this.ensuring = true;
    return true;
  }

  /** Records that a preparation for sess ended, and returns the session to
   * prepare again for, if any: when a forced ensure came in meanwhile, or
   * the machine reconnected (cur). */
  finish(sess: Session, cur: Session | null): Session | null {
    this.prepared = sess;
    const again = cur !== null && (this.again || cur !== sess) && !(this.stream && this.sess === cur);
    if (cur !== sess) this.failures = 0;
    this.again = false;
    this.ensuring = again;
    return again ? cur : null;
  }

  /** Ends the attachment, if any, and forgets its windows. The display
   * keeps running on the machine until idle, and its programs keep their
   * windows. */
  detach(): void {
    this.stream?.close();
    this.stream = null;
    this.router.detached();
  }

  /** Ends what runs for the display: the attachment and the timers. */
  dispose(): void {
    this.detach();
    clearTimeout(this.retry);
    this.retry = undefined;
    this.router.dispose();
  }
}
