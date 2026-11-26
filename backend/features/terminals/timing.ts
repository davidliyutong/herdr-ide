// The durations of the terminals feature, which tests shorten.
import type { DetectTiming } from './agents.ts';

export interface Timing extends DetectTiming {
  /** How long a backend's connection stays without subscribers. */
  idleMs: number;
  /** The first wait after a backend failed; it doubles up to backoffMaxMs. */
  backoffMinMs: number;
  backoffMaxMs: number;
  /** Bounds bringing a machine's terminal core up (status, install, start). */
  ensureMs: number;
  /** Bounds connecting to it and subscribing to its events. */
  dialMs: number;
  /** The core sends a heartbeat every 15 s without events: silence this
   * long is a lost connection. */
  silenceMs: number;
  /** Bounds a client's call. */
  callMs: number;
  /** Bounds a client's attach. */
  attachMs: number;
  /** Bounds the label that keeps a seen turn. */
  labelMs: number;
  /** Bounds the status and privacy routes. */
  statusMs: number;
  /** Bounds starting, stopping or restarting the core from the UI. */
  actionMs: number;
}

export const DEFAULT_TIMING: Timing = {
  idleMs: 10_000,
  backoffMinMs: 1000,
  backoffMaxMs: 16_000,
  stableMs: 30_000,
  ensureMs: 120_000,
  dialMs: 30_000,
  silenceMs: 45_000,
  callMs: 60_000,
  attachMs: 30_000,
  labelMs: 10_000,
  statusMs: 30_000,
  actionMs: 180_000,
  detectRetryMs: 5000,
  detectRetryMaxMs: 60_000,
  redetectGraceMs: 10_000,
};
