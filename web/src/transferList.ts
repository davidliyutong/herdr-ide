// What the uploads and downloads panels share (transfers.ts, download.ts):
// the list of active transfers and of finished ones, which this browser
// keeps (the last HISTORY_MAX under a key in localStorage; names and paths,
// no contents), and a transfer's speed over the last seconds.

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { storage } from './brand';

export const HISTORY_MAX = 50;
/** The span the speed is measured over. */
export const SPEED_WINDOW_MS = 3000;
/** How often progress is shown. */
const SHOW_EVERY_MS = 250;

export interface ListState<T> {
  /** Running and waiting, in the order they started. */
  active: T[];
  /** Finished, newest first. */
  history: T[];
  panel: boolean;
  setPanel(open: boolean): void;
}

export interface TransferList<T extends { id: string }> {
  store: UseBoundStore<StoreApi<ListState<T>>>;
  find(id: string): T | undefined;
  add(items: T[]): void;
  patch(id: string, p: Partial<T>): void;
  /** Moves the active entry of entry.id to the history as entry. */
  archive(entry: T): void;
  forget(id: string): void;
  clear(): void;
}

/** A list whose history is kept under key; stored entries that fail valid
 * (an older or damaged history) are dropped. */
export function transferList<T extends { id: string }>(key: string, valid: (x: Record<string, unknown>) => boolean): TransferList<T> {
  /** The history in this browser's storage; undefined when it has none. */
  const stored = (): T[] | undefined => {
    const raw = storage.get(key);
    if (raw === null) return undefined;
    try {
      const v: unknown = JSON.parse(raw);
      if (!Array.isArray(v)) return [];
      return v.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && valid(x)).slice(0, HISTORY_MAX);
    } catch {
      return [];
    }
  };
  const store = create<ListState<T>>((set) => ({
    active: [],
    history: stored() ?? [],
    panel: false,
    // Opening shows what other tabs of this browser finished meanwhile.
    setPanel: (panel) => set(panel ? (s) => ({ panel, history: stored() ?? s.history }) : { panel }),
  }));
  const setHistory = (fn: (h: T[]) => T[]) => {
    const history = fn(stored() ?? store.getState().history).slice(0, HISTORY_MAX);
    storage.set(key, JSON.stringify(history));
    store.setState({ history });
  };
  return {
    store,
    find: (id) => store.getState().active.find((x) => x.id === id),
    add: (items) => store.setState((s) => ({ active: [...s.active, ...items] })),
    patch: (id, p) => store.setState((s) => ({ active: s.active.map((x) => (x.id === id ? { ...x, ...p } : x)) })),
    archive: (entry) => {
      store.setState((s) => ({ active: s.active.filter((a) => a.id !== entry.id) }));
      setHistory((h) => [entry, ...h.filter((e) => e.id !== entry.id)]);
    },
    forget: (id) => setHistory((h) => h.filter((e) => e.id !== id)),
    clear: () => setHistory(() => []),
  };
}

/** A transfer's speed over the last SPEED_WINDOW_MS, from the bytes done
 * so far. */
export class Speed {
  /** [time, bytes] over the window: the last sample at or before its start
   * and those after. */
  private samples: Array<[number, number]>;
  private shown = -Infinity;

  constructor(sent = 0) {
    this.samples = [[Date.now(), sent]];
  }

  /** Records the bytes done; returns the speed in bytes per second when it
   * is time to show it (always with now), else undefined. */
  add(sent: number, now = false): number | undefined {
    const t = Date.now();
    this.samples.push([t, sent]);
    while (this.samples.length > 2 && t - this.samples[1][0] >= SPEED_WINDOW_MS) this.samples.shift();
    if (!now && t - this.shown < SHOW_EVERY_MS) return undefined;
    this.shown = t;
    const [t0, s0] = this.samples[0];
    return t > t0 ? ((sent - s0) * 1000) / (t - t0) : 0;
  }
}
