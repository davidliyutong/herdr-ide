// The terminal history feature's actions on a machine, as the machine side
// serves them (features/history/machine, agentproto's History*): snapshots
// of the terminals' output, with their styles, that the machine keeps on
// its own disk while the core asks it to capture. A terminal's snapshot has
// a current generation and at most one previous one: the current one of the
// program that ran before. The machine clamps what it is asked to its hard
// limits (HistoryLimits) and answers fixed wordings with its codes (busy,
// not_found, not_running, io, …).
//
// The results are read as the Go core decoded them into its structs: a
// member that is absent or null is its zero value, members it does not
// know are dropped.
import { z } from 'zod';
import { HistoryAction } from '#shared/proto/agentproto/index.ts';
import { defineProtocol } from '#shared/proto/protocol.ts';

/** How long each action may take: a clear and an adopt wait on the
 * machine for a capture that runs. */
export const CAPTURE_MS = 30_000;
export const LIST_MS = 15_000;
export const READ_MS = 30_000;
export const CLEAR_MS = 45_000;

const zero = <T extends z.ZodType>(t: T, v: z.output<T>) => t.nullish().transform((x) => x ?? v);
const count = zero(z.number(), 0);
const text = zero(z.string(), '');

/** One generation of a terminal's snapshot. */
const snapshot = { pid: count, at: count, lines: count, bytes: count, cols: count, rows: count };

export const captureParams = z.object({ lines: z.int(), maxTerminals: z.int(), maxTotalBytes: z.int(), days: z.int() });

export const captureResult = z.object({
  captured: count,
  skipped: count,
  failed: count,
  evicted: count,
  removed: count,
  bytes: count,
  /** Another capture of the same data directory was running. */
  busy: z.boolean().nullish(),
  /** Codes of failed terminals by address. */
  errors: z.record(z.string(), z.string()).nullish(),
});

/** One terminal's snapshots: the current generation's fields (at 0 when it
 * has only a previous one), and the previous one when there is one. */
export const entry = z.object({
  terminal: text,
  ...snapshot,
  /** The terminal core itself restored the screen of the program before. */
  restored: zero(z.boolean(), false),
  previous: z.object(snapshot).nullish(),
});
export type Entry = z.output<typeof entry>;

export const listResult = z.object({ terminals: zero(z.array(entry), []), restoreScreen: zero(z.boolean(), false) });

/** One generation's bytes, base64 as Go writes a []byte. */
export const data = z.object({
  terminal: text,
  generation: text,
  ...snapshot,
  data: zero(z.base64(), '').transform((s) => Buffer.from(s, 'base64')),
});

export const historyProtocol = defineProtocol('history', {
  [HistoryAction.Capture]: { params: captureParams, result: captureResult, timeoutMs: CAPTURE_MS },
  [HistoryAction.List]: { params: z.object({}), result: listResult, timeoutMs: LIST_MS },
  [HistoryAction.Read]: { params: z.object({ terminal: z.string(), generation: z.string() }), result: data, timeoutMs: READ_MS },
  /** Removes one terminal's snapshots, or all without terminal. */
  [HistoryAction.Clear]: {
    params: z.object({ terminal: z.string().optional() }),
    result: z.object({ removed: count }),
    timeoutMs: CLEAR_MS,
  },
  /** Terminal to, which took the place of terminal from, gets from's newest
   * generation as its previous one unless it has a later one; from's
   * snapshots go. */
  [HistoryAction.Adopt]: {
    params: z.object({ from: z.string(), to: z.string() }),
    result: z.object({ adopted: zero(z.boolean(), false) }),
    timeoutMs: CLEAR_MS,
  },
});
