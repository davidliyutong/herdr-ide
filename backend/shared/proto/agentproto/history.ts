// The terminal history plugin's actions: snapshots of the terminals'
// output, with their styles, that a machine keeps while the hub asks it to
// capture. A terminal's snapshot has a current generation and at most one
// previous one: the current one of the program that ran before.

export const HistoryAction = {
  Capture: 'capture',
  List: 'list',
  Read: 'read',
  Clear: 'clear',
  /** A terminal that took the place of another gets its newest snapshot as
   * its previous generation; the replaced one's snapshots go. */
  Adopt: 'adopt',
} as const;

export const HistoryGeneration = { Current: 'current', Previous: 'previous' } as const;

/** Hard limits of the snapshots; the machine clamps what the hub asks for. */
export const HistoryLimits = {
  minLines: 100,
  maxLines: 10000,
  minTerminals: 1,
  maxTerminals: 128,
  minTotalBytes: 1 << 20,
  maxTotalBytes: 512 << 20,
  minDays: 1,
  maxDays: 30,
  /** One generation of one terminal. */
  maxBytes: 2 << 20,
  /** HistoryCaptureResult.errors. */
  maxErrors: 32,
} as const;

export interface HistoryCaptureParams {
  lines: number;
  maxTerminals: number;
  maxTotalBytes: number;
  days: number;
}

export interface HistoryCaptureResult {
  captured: number;
  skipped: number;
  failed: number;
  evicted: number;
  removed: number;
  bytes: number;
  /** Another capture of the same data directory was running. */
  busy?: boolean;
  /** Codes of failed terminals by address: too_large, no_paint,
   * incomplete, repainted, probe, attach, limit, write, timeout. */
  errors?: Record<string, string>;
}

export interface HistorySnapshot {
  pid: number;
  /** Milliseconds since the epoch. */
  at: number;
  lines: number;
  bytes: number;
  cols: number;
  rows: number;
}

/** One terminal's snapshots: the current generation's fields (at 0 when it
 * has only a previous one), and the previous one when there is one. */
export interface HistoryEntry extends HistorySnapshot {
  terminal: string;
  /** The terminal core itself restored the screen of the program before. */
  restored?: boolean;
  previous?: HistorySnapshot;
}

export interface HistoryListResult {
  terminals: HistoryEntry[];
  restoreScreen: boolean;
}

export interface HistoryAdoptParams {
  from: string;
  to: string;
}

const historyTerminal = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Whether s can name a terminal's snapshot: a terminal core's address as
 * the web UI takes one (isAddress in web/src/term/layout.ts). It has no
 * dot, so it is no hidden or relative name and never ends with ".prev". */
export const validHistoryTerminal = (s: string): boolean => historyTerminal.test(s);

export const validHistoryGeneration = (s: string): boolean => s === HistoryGeneration.Current || s === HistoryGeneration.Previous;

export const validHistoryAdopt = (p: HistoryAdoptParams): boolean =>
  validHistoryTerminal(p.from) && validHistoryTerminal(p.to) && p.from !== p.to;
