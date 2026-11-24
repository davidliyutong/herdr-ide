// The terminal history's settings (section "history"). Each bounds what a
// machine keeps on its own disk, so each can differ per machine; their
// bounds are the machine's hard limits (HistoryLimits), which it enforces
// whatever it is asked.
import { HistoryLimits } from '#shared/proto/agentproto/index.ts';
import { bool, defineModule, int } from '#kernel/config/settings/index.ts';

const section = 'history';

/** The bounds of the number settings. */
export const LIMITS = {
  interval: [10, 600],
  lines: [HistoryLimits.minLines, HistoryLimits.maxLines],
  maxTerminals: [HistoryLimits.minTerminals, HistoryLimits.maxTerminals],
  maxTotalMB: [HistoryLimits.minTotalBytes / 2 ** 20, HistoryLimits.maxTotalBytes / 2 ** 20],
  days: [HistoryLimits.minDays, HistoryLimits.maxDays],
} as const satisfies Record<string, readonly [number, number]>;

const number = (key: keyof typeof LIMITS, def: number, step: number, order: number) =>
  int({ default: def, min: LIMITS[key][0], max: LIMITS[key][1], step, scope: 'machine', section, order });

export const settings = defineModule({
  sections: [{ id: section, order: 71, plugin: 'history' }],
  settings: {
    /** The machine writes snapshots of its terminals' output. Off by
     * default: the output can hold secrets. */
    'history.capture': bool({
      default: false,
      scope: 'machine',
      section,
      order: 10,
      flag: 'history-capture',
      usage:
        "keep snapshots of the terminals' output on each machine's disk (in the agent's data directory there), to show what a terminal held after its terminal core started again; the output can hold secrets such as keys and passwords printed in a terminal; true or false; also per machine in the UI",
    }),
    /** Seconds between two snapshots of a terminal. */
    'history.interval': number('interval', 30, 10, 20),
    /** The most lines a terminal's snapshot keeps. */
    'history.lines': number('lines', 2000, 100, 30),
    /** The most terminals a machine keeps snapshots of. */
    'history.maxTerminals': number('maxTerminals', 32, 1, 40),
    /** The most megabytes the snapshots of a machine take. */
    'history.maxTotalMB': number('maxTotalMB', 64, 1, 50),
    /** The days a snapshot is kept. */
    'history.days': number('days', 7, 1, 60),
  },
});
