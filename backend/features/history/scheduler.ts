// The terminal history's scheduler: it asks each connected machine that
// keeps snapshots (history.capture for it, with the feature on) for a
// capture every history.interval seconds, one at a time per machine, and
// asks a machine that no longer keeps them for a clear until one succeeds:
// when the setting or the feature was turned off, and when it is first
// seen not keeping them (it may hold snapshots from before: the setting
// was turned off while the hub was down, or in the settings file). A
// failed clear is asked again later, waiting twice as long after each
// failure up to clearRetryMaxMs, and at once when the machine connects
// again. Nothing is asked of a machine while the hub is read-only.
import type { HistoryCaptureParams } from '#shared/proto/agentproto/index.ts';
import type { Logger } from '#shared/lib/log.ts';
import { retryDelay } from '#shared/lib/wait.ts';
import type { Audit } from '#kernel/audit.ts';
import type { Change, Settings } from '#kernel/config/settings/index.ts';
import { Fail } from '#kernel/fail.ts';
import { LIMITS } from './settings.ts';

export interface Timing {
  /** Bound one capture and one clear of a machine. */
  captureMs: number;
  clearMs: number;
  /** The wait before a failed clear is asked again; it doubles with each
   * failure up to clearRetryMaxMs. */
  clearRetryMs: number;
  clearRetryMaxMs: number;
}

export const TIMING: Timing = {
  captureMs: 30_000,
  clearMs: 45_000,
  clearRetryMs: 30_000,
  clearRetryMaxMs: 3_600_000,
};

/** The machines' side as the scheduler uses it. */
export interface Calls {
  capture(m: string, p: HistoryCaptureParams, signal: AbortSignal): Promise<unknown>;
  clear(m: string, signal: AbortSignal): Promise<{ removed: number }>;
}

export interface SchedulerOptions {
  calls: Calls;
  /** The machines connected now. */
  ready: () => string[];
  /** Wakes the scheduler when a machine becomes ready or stops being ready. */
  onReadyChange?: (wake: (machine: string, ready: boolean) => void) => () => void;
  settings: Settings;
  /** Whether the feature is on (for any client), and the setting that
   * switches it. */
  enabled: () => boolean;
  switchKey: string;
  readOnly: () => boolean;
  audit: Audit;
  logger: Logger;
  now?: () => number;
  timing?: Partial<Timing>;
}

/** A machine's history settings. */
interface MachineSettings {
  everyMs: number;
  params: HistoryCaptureParams;
}

/** A clear of a machine that is due or failed so far. */
interface PendingClear {
  /** The scheduler saw the machine keep snapshots before (the user turned
   * them off): the clear is audited also when it removed nothing. */
  turnedOff: boolean;
  /** Failures so far: the next one waits longer (clearWait). */
  failures: number;
}

/** The wait after a clear's failures-th failure. */
export function clearWait(failures: number, t: Pick<Timing, 'clearRetryMs' | 'clearRetryMaxMs'> = TIMING): number {
  let d = t.clearRetryMs;
  for (let i = 1; i < failures && d < t.clearRetryMaxMs; i++) d *= 2;
  return Math.min(d, t.clearRetryMaxMs);
}

export class Scheduler {
  private readonly o: SchedulerOptions;
  private readonly t: Timing;
  private readonly now: () => number;
  /** The machines with a capture or a clear running. */
  private readonly busy = new Set<string>();
  /** When a machine's next capture (or a failed clear's retry) is due. */
  private readonly next = new Map<string, number>();
  /** Per machine whether it keeps snapshots, as last seen. */
  private readonly on = new Map<string, boolean>();
  /** The machines whose snapshots are to go. */
  private readonly clearing = new Map<string, PendingClear>();
  /** The machines connected at the last step. */
  private connected = new Set<string>();
  /** The code a machine's last capture failed with, logged when it changes. */
  private readonly failed = new Map<string, string>();
  /** What step started and has not ended. */
  private readonly tasks = new Set<Promise<void>>();
  private wake?: () => void;

  constructor(o: SchedulerOptions) {
    this.o = o;
    this.t = { ...TIMING, ...o.timing };
    this.now = o.now ?? Date.now;
  }

  /** Runs until signal ends; what it started ends with it. */
  async run(signal: AbortSignal): Promise<void> {
    const off = this.o.settings.onChange((c) => this.settingsChanged(c));
    const unwatch = this.o.onReadyChange?.((m, ready) => {
      if (ready === this.connected.has(m)) return;
      if (!ready) this.connected.delete(m);
      this.wake?.();
    });
    try {
      while (!signal.aborted) {
        const due = this.step(signal);
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            this.wake = undefined;
            resolve();
          };
          const timer = due === undefined ? undefined : setTimeout(done, Math.max(0, due - this.now()));
          signal.addEventListener('abort', done, { once: true });
          this.wake = done;
          if (signal.aborted) done();
        });
      }
    } finally {
      off();
      unwatch?.();
      await this.idle();
    }
  }

  /** Resolves when what step started has ended. */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all(this.tasks);
  }

  /** Drops what the scheduler knows of a machine that was removed. */
  forget(m: string): void {
    for (const s of [this.next, this.on, this.clearing, this.failed]) s.delete(m);
    this.connected.delete(m);
    this.wake?.();
  }

  private settingsOf(m: string): MachineSettings {
    const st = this.o.settings;
    const int = (key: string, [lo, hi]: readonly [number, number]) => {
      const v = Math.trunc(st.number(key, m));
      return Math.max(lo, Math.min(v, hi));
    };
    return {
      everyMs: int('history.interval', LIMITS.interval) * 1000,
      params: {
        lines: int('history.lines', LIMITS.lines),
        maxTerminals: int('history.maxTerminals', LIMITS.maxTerminals),
        maxTotalBytes: int('history.maxTotalMB', LIMITS.maxTotalMB) * 2 ** 20,
        days: int('history.days', LIMITS.days),
      },
    };
  }

  /** Whether machine m keeps snapshots: history.capture with the feature
   * on. The feature turned off counts as the setting turned off: its
   * machines' snapshots go too. */
  private keeps(m: string): boolean {
    return this.o.enabled() && this.o.settings.bool('history.capture', m);
  }

  /** Notes whether machine m keeps snapshots. Its snapshots are to be
   * cleared when it was seen keeping them and no longer does, and when it
   * is seen the first time not keeping them; a clear of a machine without
   * any changes nothing. */
  private observe(m: string, on: boolean): void {
    const prev = this.on.get(m);
    if (prev === true && !on) {
      this.clearing.set(m, { failures: 0, ...this.clearing.get(m), turnedOff: true });
      this.next.delete(m);
    } else if (prev === undefined && !on && !this.clearing.has(m)) {
      this.clearing.set(m, { turnedOff: false, failures: 0 });
    }
    this.on.set(m, on);
  }

  /** Notes history.capture or the feature turned off for the machines the
   * scheduler has seen, at once: also when it is turned on again before
   * the next tick, the snapshots taken so far go. */
  settingsChanged(changes: Change[]): void {
    if (!changes.some((c) => c.key === 'history.capture' || c.key === this.o.switchKey)) return;
    for (const m of [...this.on.keys()]) this.observe(m, this.keeps(m));
    this.wake?.();
  }

  /** Starts what is due: per connected machine, a clear of a machine whose
   * snapshots are to go, else a capture when its interval passed since its
   * last one ended; one at a time per machine. A machine that connected
   * again is asked for its pending clear at once. */
  step(signal: AbortSignal): number | undefined {
    const ms = this.o.ready();
    const readOnly = this.o.readOnly();
    const now = this.now();
    const connected = new Set<string>();
    let due: number | undefined;
    for (const m of ms) {
      connected.add(m);
      const keeps = this.keeps(m);
      this.observe(m, keeps);
      const clearing = this.clearing.has(m);
      if (clearing && !this.connected.has(m) && !this.busy.has(m)) this.next.delete(m);
      if (readOnly || this.busy.has(m) || (!clearing && !keeps)) continue;
      const next = this.next.get(m);
      if (next !== undefined && now < next) {
        due = due === undefined ? next : Math.min(due, next);
        continue;
      }
      if (clearing) this.track(m, this.clear(signal, m));
      else this.track(m, this.capture(signal, m, this.settingsOf(m)));
    }
    this.connected = connected;
    return due;
  }

  private track(m: string, run: (done: () => void) => Promise<void>): void {
    this.busy.add(m);
    const p: Promise<void> = run(() => this.busy.delete(m)).finally(() => {
      this.tasks.delete(p);
      this.wake?.();
    });
    this.tasks.add(p);
  }

  /** The code of a failure ("" for none). */
  private codeOf(err: unknown, deadline: AbortSignal): string {
    if (err === undefined) return '';
    if (deadline.aborted) return 'timeout';
    return err instanceof Fail ? err.code : 'failed';
  }

  /** Asks machine m for a capture. Captures are not audited: they change
   * only the machine's own snapshots, which the setting asked for. */
  private capture(signal: AbortSignal, m: string, s: MachineSettings) {
    return async (done: () => void) => {
      const deadline = AbortSignal.timeout(this.t.captureMs);
      let err: unknown;
      try {
        await this.o.calls.capture(m, s.params, AbortSignal.any([signal, deadline]));
      } catch (e) {
        err = e ?? new Error('failed');
      }
      const code = this.codeOf(err, deadline);
      done();
      if (!this.clearing.has(m)) this.next.set(m, this.now() + s.everyMs);
      const changed = (this.failed.get(m) ?? '') !== code;
      if (code) this.failed.set(m, code);
      else this.failed.delete(m);
      if (changed && code && code !== 'offline') this.o.logger(`history: capture on ${m}: ${(err as Error)?.message ?? code}`);
    };
  }

  /** Asks machine m to remove its snapshots because it no longer keeps
   * them; audited as history.clear when it is done, if the user turned them
   * off or it removed some, before the machine is free for its next
   * capture. */
  private clear(signal: AbortSignal, m: string) {
    return async (done: () => void) => {
      const deadline = AbortSignal.timeout(this.t.clearMs);
      let err: unknown;
      let removed = 0;
      try {
        removed = (await this.o.calls.clear(m, AbortSignal.any([signal, deadline]))).removed;
      } catch (e) {
        err = e ?? new Error('failed');
      }
      const pc = this.clearing.get(m) ?? { turnedOff: false, failures: 0 };
      const code = this.codeOf(err, deadline);
      if (!err && (pc.turnedOff || removed > 0) && !signal.aborted)
        this.o.audit.log(null, 'history.clear', { plugin: 'history', machine: m, reason: 'capture_off', removed });
      if (err && code !== 'offline' && !signal.aborted) this.o.logger(`history: clear on ${m}: ${code}`);
      done();
      if (!err) {
        this.clearing.delete(m);
        this.next.delete(m);
        return;
      }
      pc.failures++;
      this.clearing.set(m, pc);
      this.next.set(m, this.now() + retryDelay(clearWait(pc.failures, this.t)));
    };
  }
}
