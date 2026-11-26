// The AI usage feature's settings (its page in Settings › Plugins, laid out
// by web/src/plugins/usage/SettingsPage.tsx): how often to read, the status
// bar and alerts, the spend's prices, then one group per provider with its
// switch and its own options. The user's prices are parsed here too: the
// spend's scans and a session's read send them to the machines.
import { bool, defineModule, enumOf, int, stringList, type Setting } from '#kernel/config/settings/index.ts';

/** The providers, in the order the UIs list them. OpenCode has spend only. */
export const PROVIDERS = ['claude', 'codex', 'grok', 'antigravity', 'kimi', 'deepseek', 'opencode'] as const;

/** How often the scheduler reads: never by itself, every n minutes, or
 * adaptive (the cadences of usage.refreshOpen, refreshWorking, refreshIdle). */
export const REFRESH_MODES = ['manual', '1', '2', '5', '15', '30', '60', 'adaptive'] as const;

const section = 'usage';

/** A price of the user's, in USD per million tokens (Go's usage.Tier as
 * the machines read it): for prompts of any length, cache writes at the
 * input price unless given. */
export interface Tier {
  inputMax: null;
  input: number;
  cached: number;
  output: number;
  cacheWrite?: number;
}

/** The most prices of the user's. */
export const MAX_PRICES = 50;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Reads usage.prices: one model per line, "<model> <input> <cached>
 * <output> [<cache write>]", the model a prefix of the names it prices.
 * Throws with why a list is refused. */
export function parsePrices(lines: readonly string[]): Record<string, Tier> {
  if (lines.length > MAX_PRICES) throw new Error(`at most ${MAX_PRICES} prices`);
  const out: Record<string, Tier> = {};
  for (const l of lines) {
    const f = l.split(/[\s\u0085]+/).filter(Boolean);
    if (f.length === 0) continue;
    if (f.length < 4 || f.length > 5 || !MODEL.test(f[0]!))
      throw new Error(`${JSON.stringify(l)}: a price is: model input cached output [cache write], in USD per million tokens`);
    const n = f.slice(1).map(Number);
    if (!f.slice(1).every((x) => NUMBER.test(x)) || !n.every((v) => v >= 0 && v <= 10000))
      throw new Error(`${JSON.stringify(l)}: prices are numbers from 0 to 10000`);
    if (Object.hasOwn(out, f[0]!)) throw new Error(`a model has two prices: ${f[0]}`);
    out[f[0]!] = { inputMax: null, input: n[0]!, cached: n[1]!, output: n[2]!, ...(n.length === 4 ? { cacheWrite: n[3]! } : {}) };
  }
  return out;
}

function validPrices(lines: string[]): string | undefined {
  try {
    parsePrices(lines);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

function validThresholds(list: string[]): string | undefined {
  if (list.length > 8) return 'at most 8 thresholds';
  if (!list.every((s) => /^[+-]?\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 100))
    return 'thresholds are whole percentages from 1 to 100';
  return undefined;
}

export const settings = defineModule({
  sections: [{ id: section, order: 68, plugin: 'usage' }],
  settings: {
    'usage.refresh': enumOf(REFRESH_MODES, { default: 'adaptive', section, group: 'usageRefresh', order: 10 }),
    /** The adaptive cadences, in minutes: while a panel is open, while a
     * coding agent works, otherwise. */
    'usage.refreshOpen': int({ default: 5, min: 1, max: 60, section, group: 'usageRefresh', order: 11 }),
    'usage.refreshWorking': int({ default: 10, min: 1, max: 120, section, group: 'usageRefresh', order: 12 }),
    'usage.refreshIdle': int({ default: 30, min: 5, max: 240, section, group: 'usageRefresh', order: 13 }),
    /** Read by the pages: how old the spend may get while the panel is
     * open, and the status bar item. */
    'usage.costRefresh': int({ default: 15, min: 1, max: 1440, section, group: 'usageRefresh', order: 15 }),
    'usage.statusBar': bool({ default: true, section, group: 'usageAlerts', order: 18 }),
    'usage.alerts': bool({ default: true, section, group: 'usageAlerts', order: 19 }),
    'usage.thresholds': stringList({
      default: ['80', '95'],
      options: ['50', '80', '90', '95'],
      section,
      group: 'usageAlerts',
      order: 20,
      check: validThresholds,
    }),
    /** The user's prices, for models the price table does not know yet or
     * prices it has wrong (parsePrices). */
    'usage.prices': stringList({ default: [], section, group: 'usageSpend', order: 22, check: validPrices }),
    // One group per provider: its switch, then its own options.
    ...Object.fromEntries(
      PROVIDERS.flatMap((p, i): [string, Setting][] => {
        const group = 'usage' + p[0]!.toUpperCase() + p.slice(1);
        const order = 30 + 4 * i;
        const own: [string, Setting][] = [[`usage.providers.${p}`, bool({ default: true, section, group, order })]];
        if (p === 'claude') own.push(['usage.claudeKeychain', bool({ default: true, section, group, order: order + 1 })]);
        if (p === 'codex') own.push(['usage.codexHomes', stringList({ default: [], section, group, order: order + 1 })]);
        if (p === 'kimi') own.push(['usage.kimiRefresh', bool({ default: true, section, group, order: order + 1 })]);
        return own;
      }),
    ),
  },
});
