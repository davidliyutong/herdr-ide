// What a terminal showed before its program was replaced by a new shell
// (the terminal core started again: a reboot, a stop), shown above the new
// shell in the same scrollback (state/preludes.ts, vt/pane.ts), while the
// plugin is on and history.capture is on for the terminal's machine.
//
// For each such machine the follower reads the list of its snapshots
// (…/p/history) once the machine's terminals are known and again after a
// terminal got a new program (its pid changed: the core restarted it) or a
// terminal came that was not there (one taking another's place): the
// first read soon, the next ones at least LIST_GAP_MS apart, none while
// the page is hidden. For each terminal leaf of the machine's layout it
// chooses the snapshot of what that terminal showed before
// (chooseSnapshot), reads its bytes once (…/p/history/read) and gives
// them, with a note of when they were saved and the grid they were painted
// at, as the terminal's prelude. A prelude goes when its snapshot leaves
// the list, its leaf leaves the layout, or the setting or the plugin is
// turned off; it stays while the machine's terminals or layout are not
// known (the machine, or the connection to the hub, is coming back) until
// the list read once they are says otherwise. While a choice waits for the
// machine to capture a terminal's new program (awaitsCapture), the list is
// read again one capture interval later, at most CAPTURE_WAITS times. A
// list or a read that failed for the machine or the network is tried
// again after a back-off (RETRY_MIN_MS, doubling up to RETRY_MAX_MS).
//
// A leaf whose terminal took the place of another (restore.ts, `before`)
// shows that one's snapshot, and the page moves it to the leaf's own
// terminal (adoptHistory, once, not from a read-only page): the machine
// removes the snapshots of terminals that are gone, and keeps it as the
// terminal's previous generation, which the leaf then shows.
import { useEffect } from 'react';
import { locale, t } from '../../i18n';
import { builtinDefaults, useSettings, type SettingState } from '../../settings';
import { setPrelude } from '../../state/preludes';
import { useStore } from '../../state/store';
import { useTerms } from '../../state/terms';
import * as L from '../../term/layout';
import { isLive, type TerminalRecord } from '../../term/protocol';
import {
  adoptHistory,
  HistoryError,
  listHistory,
  readHistory,
  type Generation,
  type HistoryEntry,
  type HistoryList,
  type HistorySnapshot,
} from './api';

/** The setting that has a machine keep snapshots. */
export const CAPTURE = 'history.capture';
/** Lists of a machine's snapshots are read at least this far apart. */
export const LIST_GAP_MS = 5000;
/** A list asked for waits this long for the changes that come with the
 * one that asked (a core that started again restarts every terminal). */
export const LIST_SETTLE_MS = 250;
/** The setting of the seconds between a machine's captures. */
export const INTERVAL = 'history.interval';
/** How often the list is read again for a choice that waits for a capture. */
export const CAPTURE_WAITS = 3;
/** A failed list, read or adoption is tried again this long after its
 * first failure, twice as long after each next one, at most RETRY_MAX_MS. */
export const RETRY_MIN_MS = 2000;
export const RETRY_MAX_MS = 60_000;
/** Maximum concurrent snapshot reads / adoptions per machine so a restart
 * with many terminals does not burst-fetch every snapshot simultaneously. */
export const MAX_CONCURRENT_READS = 4;
export const MAX_CONCURRENT_ADOPTIONS = 4;

/** How long the nth failure in a row waits before the next try. */
export const retryAfter = (failures: number): number => Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, failures - 1));

/** The seconds between machine m's captures (history.interval). */
export function intervalOf(m: string, values: Record<string, SettingState> = useSettings.getState().values): number {
  const s = values[INTERVAL];
  const v = s?.machines?.[m] ?? s?.value ?? builtinDefaults[INTERVAL];
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 10), 600) : 30;
}

/** Whether machine m keeps snapshots: its own value of history.capture,
 * else the user's. */
export function captureOn(m: string, values: Record<string, SettingState> = useSettings.getState().values): boolean {
  const s = values[CAPTURE];
  const v = s?.machines?.[m] ?? s?.value ?? builtinDefaults[CAPTURE];
  return v === true;
}

/** A snapshot to show above a terminal: of the terminal itself or of the
 * one it replaced, and which generation. */
export interface Choice {
  terminal: string;
  generation: Generation;
  snapshot: HistorySnapshot;
}

/** A snapshot by its program and time. */
export interface SnapshotId {
  pid: number;
  at: number;
}

/** Which snapshot holds what a terminal's leaf showed before, if any:
 *
 * - its own terminal's newest generation of another program than the one
 *   running, when the core gave it a new one: the previous generation, or
 *   the current one while the machine has not yet captured the new program
 *   (it makes the current one previous then); but none where the terminal
 *   core showed the old screen above the new shell itself. The terminal's
 *   record does not tell (the core clears a kept terminal's reason when it
 *   is live again), its snapshots do: once the machine captured the new
 *   program, its current generation says whether the core's line was there
 *   (`restored`); until then, the core's restore_screen is the best guess
 *   (it restores nothing after a power loss), and the next capture decides:
 *   the prelude comes or goes with the pane's next attach. Neither counts
 *   for `adopted`, a snapshot the page moved to the terminal from the one
 *   it took the place of (adoptHistory): the core never shows another
 *   terminal's screen;
 * - else, for a leaf whose terminal took the place of another (`before`),
 *   that one's current generation, or its previous one when it has none.
 *   The core never shows another terminal's screen, so restore_screen
 *   does not matter here. */
export function chooseSnapshot(
  leaf: L.TerminalLeaf,
  record: TerminalRecord | undefined,
  entries: ReadonlyMap<string, HistoryEntry>,
  restoreScreen: boolean,
  adopted?: SnapshotId,
): Choice | undefined {
  const own = ownBefore(leaf, record, entries);
  if (own) {
    const snapshot = own.generation === 'current' ? own.entry : own.entry.previous!;
    const moved = !!adopted && snapshot.pid === adopted.pid && snapshot.at === adopted.at;
    if (!moved && (own.captured ? own.entry.restored === true : restoreScreen)) return undefined;
    return { terminal: leaf.terminal, generation: own.generation, snapshot };
  }
  const before = leaf.before;
  if (!L.isAddress(before) || before === leaf.terminal) return undefined;
  const e = entries.get(before);
  if (e && e.at > 0) return { terminal: before, generation: 'current', snapshot: e };
  if (e?.previous) return { terminal: before, generation: 'previous', snapshot: e.previous };
  return undefined;
}

/** A leaf's own terminal's generation of another program than the one
 * running, and whether the machine captured the running one already. */
function ownBefore(
  leaf: L.TerminalLeaf,
  record: TerminalRecord | undefined,
  entries: ReadonlyMap<string, HistoryEntry>,
): { entry: HistoryEntry; generation: Generation; captured: boolean } | undefined {
  const entry = entries.get(leaf.terminal);
  const pid = record && isLive(record) && typeof record.pid === 'number' ? record.pid : undefined;
  if (!entry || pid === undefined) return undefined;
  const generation: Generation | undefined =
    entry.at > 0 && entry.pid !== pid ? 'current' : entry.previous && entry.previous.pid !== pid ? 'previous' : undefined;
  return generation && { entry, generation, captured: entry.at > 0 && entry.pid === pid };
}

/** Whether a leaf's choice of its own terminal's snapshot waits for the
 * machine to capture the program running (chooseSnapshot). */
export function awaitsCapture(
  leaf: L.TerminalLeaf,
  record: TerminalRecord | undefined,
  entries: ReadonlyMap<string, HistoryEntry>,
): boolean {
  const own = ownBefore(leaf, record, entries);
  return own !== undefined && !own.captured;
}

/** When a snapshot was taken, as the user's locale writes a time. */
export function savedAt(at: number): string {
  return new Date(at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The line below a snapshot shown above a terminal. */
export const noteOf = (at: number): string => t('history.note', { time: savedAt(at) });

/** The page's move of a replaced terminal's newest snapshot to the leaf's
 * terminal that took its place: from which terminal; whether it is on its
 * way or done (moved, or nothing to move, or refused); the failures in a
 * row of the machine or the network, and the try that waits; and the
 * snapshot moved. */
interface Adoption {
  from: string;
  busy: boolean;
  done: boolean;
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
  moved?: SnapshotId;
}

/** A snapshot's bytes and the grid they were painted at (0 when unknown). */
interface Saved {
  bytes: Uint8Array;
  cols: number;
  rows: number;
}

interface Watched {
  /** Whether the machine's backend was ready on the last sync. */
  wasReady: boolean;
  /** The cached list predates a disconnect/reconnect: keep shown preludes
   * until the fresh post-reconnect list arrives. */
  staleList: boolean;
  list?: HistoryList;
  /** The pids of the live terminals last seen. */
  pids: Map<string, number>;
  /** When the last list was asked for (Date.now()). */
  listedAt: number;
  /** A list is wanted. */
  due: boolean;
  listing: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Lists that failed in a row, and the next try. */
  listFailures: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  /** The list asked for again for choices that wait for a capture, and how
   * often so far since the programs last changed. */
  waitTimer?: ReturnType<typeof setTimeout>;
  waits: number;
  /** The snapshot each leaf's terminal shows, by its address. */
  shown: Map<string, string>;
  /** Snapshots' bytes while a leaf wants them; reads on their way; reads
   * that failed since the last list, with the failures in a row of the
   * machine or the network and the next try. */
  bytes: Map<string, Saved>;
  reading: Set<string>;
  failed: Set<string>;
  readFailures: Map<string, number>;
  readRetries: Map<string, ReturnType<typeof setTimeout>>;
  /** Adoptions by the address of the terminal that took the place. */
  adoptions: Map<string, Adoption>;
}

const watched = new Map<string, Watched>();
let starts = 0;
let stopFollowing: (() => void) | undefined;

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
const backendReady = (m: string) => useTerms.getState().machines[m]?.backend?.phase === 'ready';

/** Codes of failures a later try may not have: the machine away or busy,
 * the network, a reply not understood, the hub's own failure. */
const TRANSIENT: ReadonlySet<string> = new Set(['network', 'offline', 'busy', 'timeout', 'transport', 'bad_reply', 'failed']);

/** Whether a failure is the machine's or the network's for the moment,
 * not a refusal (the page asked wrongly, it is read-only, the machine has
 * no such snapshot, too large). */
function transient(e: unknown): boolean {
  if (!(e instanceof HistoryError)) return true;
  return TRANSIENT.has(e.code) || /^http_(5\d\d|408|429)$/.test(e.code);
}

function livePids(terminals: Record<string, TerminalRecord>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of Object.values(terminals)) if (isLive(r) && typeof r.pid === 'number') out.set(r.address, r.pid);
  return out;
}

/** Whether a live terminal has another program than before, or is new. */
function newPrograms(was: Map<string, number>, now: Map<string, number>): boolean {
  for (const [address, pid] of now) if (was.get(address) !== pid) return true;
  return false;
}

function terminalLeaves(layout: L.Layout): L.TerminalLeaf[] {
  return layout.workspaces.flatMap((ws) => ws.tabs.flatMap((tab) => L.leavesOf(tab.root).filter(L.isTerminalLeaf)));
}

/** A snapshot's identity: its terminal, program and time, whichever
 * generation the machine keeps it as now; one the page moved to another
 * terminal keeps the one of the terminal it came from, whose bytes it has. */
function snapshotKey(w: Watched, c: Choice): string {
  const a = w.adoptions.get(c.terminal);
  const from = a?.moved && a.moved.pid === c.snapshot.pid && a.moved.at === c.snapshot.at ? a.from : c.terminal;
  return `${from}\n${c.snapshot.pid}\n${c.snapshot.at}`;
}

/** Asks for machine m's list: soon, and LIST_GAP_MS after the last one;
 * while the page is hidden, once it is shown. */
function askList(m: string, w: Watched) {
  w.due = true;
  if (w.timer !== undefined || w.listing || hidden() || !backendReady(m)) return;
  const wait = Math.max(LIST_SETTLE_MS, w.listedAt + LIST_GAP_MS - Date.now());
  w.timer = setTimeout(() => {
    w.timer = undefined;
    void readList(m, w);
  }, wait);
}

async function readList(m: string, w: Watched) {
  if (watched.get(m) !== w || !w.due || w.listing) return;
  if (hidden() || !backendReady(m)) return;
  w.due = false;
  w.listing = true;
  w.listedAt = Date.now();
  let ok = false;
  try {
    const list = await listHistory(m);
    if (watched.get(m) !== w) return;
    w.list = list;
    w.staleList = false;
    w.failed.clear();
    ok = true;
  } catch {
    // The machine is away or refused: what was listed stays, and the list
    // is tried again after a while.
  } finally {
    w.listing = false;
  }
  if (watched.get(m) !== w) return;
  if (ok) w.listFailures = 0;
  else if (backendReady(m)) retryList(m, w);
  apply(m, w);
  if (w.due) askList(m, w);
}

/** Tries a failed list again after its back-off. */
function retryList(m: string, w: Watched) {
  w.listFailures++;
  clearTimeout(w.retryTimer);
  w.retryTimer = setTimeout(() => {
    w.retryTimer = undefined;
    if (watched.get(m) !== w) return;
    w.due = true;
    void readList(m, w);
  }, retryAfter(w.listFailures));
}

function show(m: string, w: Watched, address: string, key: string, c: Choice) {
  const saved = w.bytes.get(key);
  if (!saved) return;
  // The grid the read said, else the list's.
  const grid = saved.cols && saved.rows ? saved : c.snapshot;
  setPrelude(m, address, saved.bytes, noteOf(c.snapshot.at), { cols: grid.cols, rows: grid.rows });
  w.shown.set(address, key);
}

function hide(m: string, w: Watched, address: string) {
  if (!w.shown.delete(address)) return;
  setPrelude(m, address, undefined);
}

/** Reads a snapshot's bytes once. One the machine has moved, removed or
 * refused since it was listed counts as failed until the next list; one
 * that failed for the machine or the network is tried again after its
 * back-off. */
function read(m: string, w: Watched, c: Choice, key: string) {
  if (w.reading.has(key)) return;
  w.reading.add(key);
  readHistory(m, c.terminal, c.generation)
    .then(
      (r) => {
        if (watched.get(m) !== w) return;
        w.readFailures.delete(key);
        if (r.pid === c.snapshot.pid && r.at === c.snapshot.at) w.bytes.set(key, { bytes: r.bytes, cols: r.cols, rows: r.rows });
        else {
          w.failed.add(key);
          askList(m, w);
        }
      },
      (e) => {
        if (watched.get(m) !== w) return;
        w.failed.add(key);
        if (!transient(e)) {
          if (e instanceof HistoryError && e.code === 'not_found') askList(m, w);
          return;
        }
        const n = (w.readFailures.get(key) ?? 0) + 1;
        w.readFailures.set(key, n);
        clearTimeout(w.readRetries.get(key));
        w.readRetries.set(
          key,
          setTimeout(() => {
            w.readRetries.delete(key);
            if (watched.get(m) !== w) return;
            w.failed.delete(key);
            apply(m, w);
          }, retryAfter(n)),
        );
      },
    )
    .finally(() => {
      w.reading.delete(key);
      if (watched.get(m) === w) apply(m, w);
    });
}

/** Moves the newest snapshot of the terminal a leaf's terminal took the
 * place of (`before`, listed) to the leaf's terminal, once it is live: once
 * done or refused, not again; after a failure of the machine or the
 * network, again after its back-off. The list is read again once it is
 * done; until then the leaf shows the snapshot where it is. */
function adopt(m: string, w: Watched, leaf: L.TerminalLeaf, record: TerminalRecord, entries: ReadonlyMap<string, HistoryEntry>) {
  const from = leaf.before;
  if (!L.isAddress(from) || from === leaf.terminal || !isLive(record) || useStore.getState().readOnly) return;
  const e = entries.get(from);
  const newest: SnapshotId | undefined = e && e.at > 0 ? { pid: e.pid, at: e.at } : e?.previous;
  if (!newest) return;
  const was = w.adoptions.get(leaf.terminal);
  if (was?.from === from && (was.busy || was.done || was.timer !== undefined)) return;
  const a: Adoption = { from, busy: true, done: false, failures: was?.from === from ? was.failures : 0 };
  w.adoptions.set(leaf.terminal, a);
  adoptHistory(m, from, leaf.terminal).then(
    (moved) => {
      a.busy = false;
      a.done = true;
      if (moved) a.moved = { pid: newest.pid, at: newest.at };
      if (watched.get(m) === w) {
        askList(m, w);
        apply(m, w);
      }
    },
    (err) => {
      a.busy = false;
      if (!transient(err)) {
        a.done = true;
        if (watched.get(m) === w) apply(m, w);
        return;
      }
      a.failures++;
      a.timer = setTimeout(() => {
        a.timer = undefined;
        if (watched.get(m) === w) apply(m, w);
      }, retryAfter(a.failures));
      if (watched.get(m) === w) apply(m, w);
    },
  );
}

/** Gives each terminal leaf of machine m the prelude its snapshot makes,
 * and takes it from those that have none any more. Without the list or the
 * layout nothing is decided, and a leaf whose terminal has no record (the
 * machine's terminals are not known again yet) keeps what it shows. */
function apply(m: string, w: Watched) {
  const mt = useTerms.getState().machines[m];
  if (!w.list || w.staleList || !mt?.layout || mt.backend?.phase !== 'ready') return;
  const entries = new Map(w.list.terminals.map((e) => [e.terminal, e]));
  const want = new Map<string, Choice>();
  const keep = new Set<string>();
  const leaves: Array<[L.TerminalLeaf, TerminalRecord]> = [];
  let waiting = false;
  for (const leaf of terminalLeaves(mt.layout)) {
    const record = mt.terminals[leaf.terminal];
    if (!record) {
      if (w.shown.has(leaf.terminal)) keep.add(leaf.terminal);
      continue;
    }
    leaves.push([leaf, record]);
    const c = chooseSnapshot(leaf, record, entries, w.list.restoreScreen, w.adoptions.get(leaf.terminal)?.moved);
    if (c) want.set(leaf.terminal, c);
    waiting ||= awaitsCapture(leaf, record, entries);
  }
  awaitCapture(m, w, waiting);
  for (const address of [...w.shown.keys()]) if (!want.has(address) && !keep.has(address)) hide(m, w, address);
  for (const [address, c] of want) {
    const key = snapshotKey(w, c);
    if (w.shown.get(address) === key) continue;
    if (w.bytes.has(key)) show(m, w, address, key, c);
    else if (w.failed.has(key)) hide(m, w, address);
    else if (w.reading.size < MAX_CONCURRENT_READS) read(m, w, c, key);
  }
  // A snapshot is moved once what the leaf shows was read (or failed):
  // the machine removes the files of the one it moves from.
  let adopting = 0;
  for (const a of w.adoptions.values()) if (a.busy) adopting++;
  for (const [leaf, record] of leaves) {
    if (adopting >= MAX_CONCURRENT_ADOPTIONS) break;
    const c = want.get(leaf.terminal);
    const key = c && snapshotKey(w, c);
    if (key === undefined || w.shown.get(leaf.terminal) === key || w.failed.has(key)) {
      const wasBusy = w.adoptions.get(leaf.terminal)?.busy === true;
      adopt(m, w, leaf, record, entries);
      if (!wasBusy && w.adoptions.get(leaf.terminal)?.busy) adopting++;
    }
  }
  // Bytes no leaf wants go, with the tries of their reads.
  const keys = new Set([...want.values()].map((c) => snapshotKey(w, c)));
  for (const address of keep) keys.add(w.shown.get(address)!);
  for (const key of [...w.bytes.keys()]) if (!keys.has(key)) w.bytes.delete(key);
  for (const [key, timer] of [...w.readRetries]) {
    if (keys.has(key)) continue;
    clearTimeout(timer);
    w.readRetries.delete(key);
    w.readFailures.delete(key);
    w.failed.delete(key);
  }
}

/** While a choice waits for the machine to capture a terminal's program,
 * asks for the list again one capture interval (and a list's gap) later,
 * at most CAPTURE_WAITS times. */
function awaitCapture(m: string, w: Watched, waiting: boolean) {
  if (!waiting) {
    clearTimeout(w.waitTimer);
    w.waitTimer = undefined;
    return;
  }
  if (w.waitTimer !== undefined || w.waits >= CAPTURE_WAITS) return;
  w.waits++;
  w.waitTimer = setTimeout(
    () => {
      w.waitTimer = undefined;
      if (watched.get(m) === w) askList(m, w);
    },
    intervalOf(m) * 1000 + LIST_GAP_MS,
  );
}

/** Pauses timers and retries while a machine's backend is not ready (offline,
 * rebooting, disabled), keeping shown preludes and cached bytes intact. */
function pause(w: Watched) {
  clearTimeout(w.timer);
  w.timer = undefined;
  clearTimeout(w.retryTimer);
  w.retryTimer = undefined;
  clearTimeout(w.waitTimer);
  w.waitTimer = undefined;
  for (const timer of w.readRetries.values()) clearTimeout(timer);
  w.readRetries.clear();
  for (const a of w.adoptions.values()) {
    clearTimeout(a.timer);
    a.timer = undefined;
  }
}

/** Stops following machine m: its preludes go. */
function forget(m: string) {
  const w = watched.get(m);
  if (!w) return;
  watched.delete(m);
  pause(w);
  for (const address of [...w.shown.keys()]) setPrelude(m, address, undefined);
}

/** Follows the machines' terminals and settings. */
function sync() {
  const machines = useTerms.getState().machines;
  const values = useSettings.getState().values;
  for (const m of [...watched.keys()]) if (!machines[m] || !captureOn(m, values)) forget(m);
  for (const [m, mt] of Object.entries(machines)) {
    if (!captureOn(m, values)) continue;
    const ready = mt.backend?.phase === 'ready';
    let w = watched.get(m);
    if (!ready) {
      // A machine whose terminals are not there (offline, rebooting or
      // disabled) pauses its polling and keeps what it shows.
      if (w && w.wasReady) {
        w.wasReady = false;
        pause(w);
      }
      continue;
    }
    const pids = livePids(mt.terminals);
    if (!w) {
      w = {
        wasReady: true,
        staleList: false,
        pids,
        listedAt: 0,
        due: false,
        listing: false,
        listFailures: 0,
        waits: 0,
        shown: new Map(),
        bytes: new Map(),
        reading: new Set(),
        failed: new Set(),
        readFailures: new Map(),
        readRetries: new Map(),
        adoptions: new Map(),
      };
      watched.set(m, w);
      askList(m, w);
    } else if (!w.wasReady) {
      // Returned from offline/reboot/disable: clear back-off and mark any
      // pre-disconnect list stale until refreshed.
      w.wasReady = true;
      w.staleList = w.list !== undefined;
      w.listFailures = 0;
      w.waits = 0;
      w.listedAt = 0;
      w.failed.clear();
      w.readFailures.clear();
      for (const a of w.adoptions.values()) a.failures = 0;
      clearTimeout(w.retryTimer);
      w.retryTimer = undefined;
      clearTimeout(w.waitTimer);
      w.waitTimer = undefined;
      askList(m, w);
    } else if (newPrograms(w.pids, pids)) {
      w.waits = 0;
      askList(m, w);
    }
    w.pids = pids;
    apply(m, w);
  }
}

function visibility() {
  if (hidden()) return;
  for (const [m, w] of watched) if (w.due) askList(m, w);
}

/** Starts following (the plugin is on); returns what stops it, which
 * takes every prelude it gave away. Started again while it runs, it is
 * counted: it stops once each start was stopped. */
export function startHistory(): () => void {
  if (starts++ === 0) {
    const offTerms = useTerms.subscribe((s, prev) => s.machines !== prev.machines && sync());
    const offSettings = useSettings.subscribe((s, prev) => s.values !== prev.values && sync());
    document.addEventListener('visibilitychange', visibility);
    stopFollowing = () => {
      offTerms();
      offSettings();
      document.removeEventListener('visibilitychange', visibility);
      for (const m of [...watched.keys()]) forget(m);
    };
    sync();
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--starts === 0) {
      stopFollowing?.();
      stopFollowing = undefined;
    }
  };
}

/** The snapshots of machine m were removed: the preludes made of them go
 * now, and the list is read again. */
export function historyCleared(m: string) {
  const w = watched.get(m);
  if (!w) return;
  w.list = { terminals: [], restoreScreen: w.list?.restoreScreen ?? false };
  w.bytes.clear();
  apply(m, w);
  askList(m, w);
}

/** What follows the snapshots while the plugin is on: mounted with its
 * status bar items, it draws nothing. */
export function HistoryFollower() {
  useEffect(() => startHistory(), []);
  return null;
}
