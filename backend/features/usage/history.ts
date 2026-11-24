// The windows' use over time, per account and window: a point when the use
// changed or POINT_EVERY passed, kept HISTORY_KEEP. A window's pace
// compares its use with the share of its time gone and projects when it
// runs out at the rate since its period's first point. The history also
// keeps the alerts fired in each window's current period (alerts.ts);
// store.ts keeps both in the core's database.
import type { Account, Window } from './protocol.ts';

const DAY = 86_400;
/** How long a point is kept, in seconds. */
export const HISTORY_KEEP = 30 * DAY;
/** The least time between two points of a window whose use did not
 * change, in seconds. */
const POINT_EVERY = 15 * 60;

/** [Unix seconds, used %]. */
export type Point = [number, number];

/** What is kept of an alert that fired: the end of its period (Unix
 * seconds). */
export interface AlertRecord {
  end: number;
}

/** A window's pace: the share of its time gone (use above it runs ahead of
 * an even pace), when it runs out at the current rate (Unix seconds;
 * absent: it does not, or the rate is unknown), and whether that is before
 * it starts over. */
export interface Pace {
  expectedPct: number;
  exhaustsAt?: number;
  beforeReset?: boolean;
}

/** A window as the pages see it: id tells an account's windows apart. */
export type WindowView = Window & { id: string; pace?: Pace };

/** An account as the scheduler keeps it: the best answer's account (with
 * its raw windows), the machines it was seen on, when its numbers were
 * current (0: never) and when a machine last reported it (Unix seconds),
 * the machines whose answer was not ok, and until when a provider asked
 * not to be asked again (ms). */
export interface Kept {
  key: string;
  account: Account;
  machines: string[];
  fetchedAt: number;
  seenAt: number;
  issues?: Issue[];
  notBefore: number;
}

/** A machine whose answer for an account was not ok. */
export interface Issue {
  machine: string;
  status: string;
  code?: string;
}

/** The ids of an account's windows: kind|label, and after another | the
 * window's length when two windows share kind and label (Kimi's limits
 * have no labels), and their place when that is shared too. */
export function windowIDs(ws: readonly Window[]): string[] {
  const ids = ws.map((w) => `${w.kind}|${w.label ?? ''}`);
  const count = new Map<string, number>();
  for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
  ws.forEach((w, i) => {
    if (count.get(ids[i]!)! > 1) ids[i] += `|${w.windowSec ?? 0}`;
  });
  const seen = new Map<string, number>();
  return ids.map((id) => {
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return n > 0 ? `${id}#${n}` : id;
  });
}

/** w's pace at now (Unix seconds), at the rate since from, the first point
 * of its history in this period (else since the period began); undefined
 * without a reset and a length, or outside its period. */
export function pace(w: Window, from: Point | undefined, now: number): Pace | undefined {
  const resets = w.resetsAt ?? 0;
  const len = w.windowSec ?? 0;
  if (resets <= 0 || len <= 0) return undefined;
  const start = resets - len;
  if (now < start || now > resets) return undefined;
  const pc: Pace = { expectedPct: ((now - start) / len) * 100 };
  if (w.usedPct >= 100) return { ...pc, exhaustsAt: now, beforeReset: true };
  let [t0, u0] = [start, 0];
  if (from && from[0] >= start && now - Math.trunc(from[0]) >= 600 && from[1] <= w.usedPct) [t0, u0] = from;
  const dt = now - t0;
  if (dt <= 0 || w.usedPct <= u0) return pc;
  const exhaustsAt = now + Math.trunc((100 - w.usedPct) / ((w.usedPct - u0) / dt));
  return { ...pc, exhaustsAt: exhaustsAt || undefined, beforeReset: exhaustsAt < resets || undefined };
}

export class History {
  /** account key → window id → points. */
  windows = new Map<string, Map<string, Point[]>>();
  /** account key|kind|label|length|alert → the period it fired in. */
  alerts = new Map<string, AlertRecord>();
  /** What the core's database keeps was read into it (or it is kept in
   * memory only): until then a save would remove what it did not read. */
  loaded = false;

  /** Adds a point for each window of the accounts read in this poll (read)
   * with current numbers, and drops old points. Numbers kept from an
   * earlier poll add none: they were not read again. */
  record(accounts: ReadonlyMap<string, Kept>, read: ReadonlySet<string>, now: number): void {
    for (const [k, a] of accounts) {
      if (!read.has(k) || a.account.status !== 'ok') continue;
      let ws = this.windows.get(k);
      if (!ws) this.windows.set(k, (ws = new Map()));
      const list = a.account.windows ?? [];
      windowIDs(list).forEach((id, i) => {
        const pts = ws.get(id) ?? [];
        const last = pts.at(-1);
        if (last && last[1] === list[i]!.usedPct && now - last[0] < POINT_EVERY) return;
        ws.set(id, [...pts, [now, list[i]!.usedPct]]);
      });
    }
    this.prune(now);
  }

  /** Drops points older than HISTORY_KEEP, and accounts left without. */
  prune(now: number): void {
    const cut = now - HISTORY_KEEP;
    for (const [k, ws] of this.windows) {
      for (const [id, pts] of ws) {
        const kept = pts.filter((p) => p[0] >= cut);
        if (kept.length === 0) ws.delete(id);
        else if (kept.length < pts.length) ws.set(id, kept);
      }
      if (ws.size === 0) this.windows.delete(k);
    }
  }

  /** Adds what stored, read back from the core's database, has that this
   * history (recorded since the core started) has not: each window's
   * points before its first, and the alerts not fired since. */
  merge(stored: History): void {
    for (const [k, ws] of stored.windows) {
      let mine = this.windows.get(k);
      if (!mine) this.windows.set(k, (mine = new Map()));
      for (const [id, pts] of ws) {
        const cur = mine.get(id);
        mine.set(id, cur?.length ? [...pts.filter((p) => p[0] < cur[0]![0]), ...cur] : pts);
      }
    }
    for (const [k, r] of stored.alerts) if (!this.alerts.has(k)) this.alerts.set(k, r);
  }

  /** The first point of window w (id) of account key in its current
   * period (the last 7 days when its length is unknown). */
  first(key: string, id: string, w: Window, now: number): Point | undefined {
    const from = (w.resetsAt ?? 0) > 0 && (w.windowSec ?? 0) > 0 ? w.resetsAt! - w.windowSec! : now - 7 * DAY;
    return this.windows
      .get(key)
      ?.get(id)
      ?.find((p) => p[0] >= from);
  }
}
