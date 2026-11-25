// The alerts the hub fires after a poll, once for every page: a window
// that reached a threshold, one whose pace runs it out before its reset,
// one that started over after reaching the first threshold. Each fires at
// most once per period of its window, recorded with the history (so a
// restart does not repeat it); a record re-arms only when the window
// really starts over, which absorbs use hovering around a threshold, reset
// times that drift by seconds, rolling windows and machines answering in
// turn. The snapshot carries what fired in the last hour; each browser
// shows an alert once.
import { pace, windowIDs, type AlertRecord, type History, type Kept, type WindowView } from './history.ts';
import type { Window } from './protocol.ts';

/** Resets this close are one period's, in seconds. */
const SAME_PERIOD = 10 * 60;
/** How many points below a threshold a window without a known reset must
 * fall before it is armed again, and how far the use of a window that
 * started over before its reset must fall. */
const HYSTERESIS = 10;
/** How long a fired alert stays in the snapshot, in seconds. */
export const ALERT_KEEP = 3600;
/** The period of a window that says neither its reset nor its length. */
const UNKNOWN_PERIOD = 7 * 86_400;
/** A record goes this long after its period. */
const ALERT_FORGET = 86_400;

export type AlertKind = 'threshold' | 'reset' | 'pace';

/** A notification the pages show once; window is as it was then. */
export interface Alert {
  id: string;
  kind: AlertKind;
  key: string;
  provider: string;
  email?: string;
  window: WindowView;
  threshold?: number;
  at: number;
}

/** usage.thresholds as numbers, ascending. */
export function thresholds(list: readonly string[]): number[] {
  const out = new Set<number>();
  for (const s of list) {
    const n = /^[+-]?\d+$/.test(s) ? Number(s) : NaN;
    if (n >= 1 && n <= 100) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Keys that tell an account's windows apart for their alerts, whatever
 * other windows it has at a poll: kind, label and length, and the place
 * among windows that share all three. */
export function alertKeys(ws: readonly Window[]): string[] {
  const seen = new Map<string, number>();
  return ws.map((w) => {
    const k = `${w.kind}|${w.label ?? ''}|${w.windowSec ?? 0}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n > 0 ? `${k}#${n}` : k;
  });
}

/** When the period w is in ends: its reset, else its length (or
 * UNKNOWN_PERIOD) from now. */
const periodEnd = (w: Window, now: number) => ((w.resetsAt ?? 0) > 0 ? w.resetsAt! : now + ((w.windowSec ?? 0) || UNKNOWN_PERIOD));

/** w is in a later period than the one rec fired in: that period ended,
 * and w resets well after it. */
const laterPeriod = (rec: AlertRecord, w: Window, now: number) => now >= rec.end && (!w.resetsAt || w.resetsAt > rec.end + SAME_PERIOD);

/** w, read after old, is a new period: it resets well after old did, and
 * old's reset has passed or its use fell HYSTERESIS points. */
function startedOver(old: Window, w: Window, now: number): boolean {
  if (!old.resetsAt || (w.resetsAt ?? 0) <= old.resetsAt + SAME_PERIOD || w.usedPct >= old.usedPct) return false;
  return old.resetsAt <= now || w.usedPct <= old.usedPct - HYSTERESIS;
}

/** The alerts of the accounts read in this poll (read), whose windows
 * before it were prev, at now (Unix seconds); history's records are
 * updated. */
export function fireAlerts(
  accounts: ReadonlyMap<string, Kept>,
  read: ReadonlySet<string>,
  prev: ReadonlyMap<string, Window[]>,
  history: History,
  ths: readonly number[],
  now: number,
): Alert[] {
  const recs = history.alerts;
  const out: Alert[] = [];
  for (const k of [...read].sort()) {
    const a = accounts.get(k);
    if (!a || a.account.status !== 'ok') continue;
    const ws = a.account.windows ?? [];
    const ids = windowIDs(ws);
    const aks = alertKeys(ws);
    const before = new Map<string, Window>();
    const old = prev.get(k) ?? [];
    alertKeys(old).forEach((pk, i) => before.set(pk, old[i]!));
    ws.forEach((w, i) => {
      if (w.resetsAt && w.resetsAt <= now) return; // past its reset: the numbers are of the period before
      const wk = `${k}|${aks[i]}`;
      const fire = (kind: AlertKind, th = 0) => {
        const p = pace(w, history.first(k, ids[i]!, w, now), now);
        const id = `${wk}|${kind}${th > 0 ? `|${th}` : ''}`;
        out.push({
          id: `${id}@${now}`,
          kind,
          key: k,
          provider: a.account.provider,
          email: a.account.email,
          window: { ...w, id: ids[i]!, pace: p },
          threshold: th || undefined,
          at: now,
        });
      };
      // A window that started over: a new period for its alerts.
      const was = before.get(aks[i]!);
      if (was && startedOver(was, w, now)) {
        for (const th of ths) recs.delete(`${wk}|threshold|${th}`);
        recs.delete(`${wk}|pace`);
        if (ths.length > 0 && was.usedPct >= ths[0]!) {
          const rec = recs.get(`${wk}|reset`);
          if (!rec || w.resetsAt! > rec.end + SAME_PERIOD) {
            recs.set(`${wk}|reset`, { end: w.resetsAt! });
            fire('reset');
          }
        }
      }
      const end = periodEnd(w, now);
      for (const th of ths) {
        const rk = `${wk}|threshold|${th}`;
        let rec = recs.get(rk);
        // Without a reset to go by, below the threshold by the hysteresis
        // arms it again.
        if (rec && !w.resetsAt && w.usedPct <= th - HYSTERESIS) {
          recs.delete(rk);
          rec = undefined;
        }
        if (w.usedPct >= th && (!rec || laterPeriod(rec, w, now))) {
          recs.set(rk, { end });
          fire('threshold', th);
        }
      }
      if (pace(w, history.first(k, ids[i]!, w, now), now)?.beforeReset && w.usedPct < 100) {
        const rec = recs.get(`${wk}|pace`);
        if (!rec || laterPeriod(rec, w, now)) {
          recs.set(`${wk}|pace`, { end });
          fire('pace');
        }
      }
    });
  }
  for (const [k, r] of recs) if (now - r.end > ALERT_FORGET) recs.delete(k);
  return out;
}
