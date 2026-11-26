// How a capture reads the terminals (docs/features/21-terminal-core.md):
// one connection to the instance's terminal core; per live terminal, the
// screen's text (terminal.read without history lines, which never scrolls
// a program) to see whether anything changed, then an observing attach
// with history lines, which neither the program nor other viewers notice,
// whose first paint is the snapshot.
//
// What this relies on of herdr-core (0.1.21, viewers.rs and wire.rs): every
// paint it sends starts with CAN and begins a DATA frame, so a DATA frame
// that starts with CAN starts a paint, and a first DATA frame that does
// not is the program's output. A first paint above 4 MiB is dropped
// without a word: what arrives then is the program's live output. When the
// terminal is resized before the paint was sent whole, or the reader falls
// more than 4 MiB behind, the core drops what it had not sent and sends a
// new grid and a repaint without history: what was read then is no
// snapshot of the lines asked for.
import { Fail } from '#shared/lib/fail.ts';
import {
  HIDDEN_LABEL,
  HistoryLimits,
  hidden,
  validHistoryTerminal,
  type HistoryCaptureParams,
  type HistoryCaptureResult,
} from '#shared/proto/agentproto/index.ts';
import { HCError, type Conn, type Stream, type Terminal } from '#shared/proto/hc/index.ts';
import { dialHC } from '#machine/hidden.ts';
import type { Memory } from './memory.ts';
import { PAINT_END, endOf, restoredByCore, screenHash, stripTitles } from './paint.ts';
import { BusyError, NewerTablesError, Store, clamp, screenKey, type Meta } from './store.ts';

/** The bounds of a capture's waits. */
export interface Timing {
  /** One capture: shorter than the hub waits for its answer (30 s), so
   * that the result, with the terminals the time did not reach, arrives in
   * time. */
  captureMs: number;
  /** Reading one terminal's screen, and the terminal core's records. */
  probeMs: number;
  /** One attach: its paint is read within it. */
  attachMs: number;
  /** An attach of a quiet terminal whose paint has not begun by then got
   * none (the core dropped it). */
  firstByteMs: number;
  /** How long a capture waits for the snapshots' lease another writer
   * holds: a list or a read that prunes holds it a moment, another
   * agent's capture much longer (busy). */
  lockWaitMs: number;
  /** A clear or an adopt, which waits for a capture that holds the lease. */
  clearMs: number;
  /** How long a capture of one hub stands for the others its node serves:
   * their captures in that time do nothing (busy). */
  shareMs: number;
  /** How long the snapshots of a terminal gone from the terminal core's
   * records are kept after a capture first saw it gone: a page adopts
   * them for the terminal that took its place meanwhile. */
  goneGraceMs: number;
  /** How often a writer that waits for the lease asks again. */
  leaseRetryMs: number;
}

export const TIMING: Timing = {
  captureMs: 25_000,
  probeMs: 5000,
  attachMs: 5000,
  firstByteMs: 2000,
  lockWaitMs: 2000,
  clearMs: 40_000,
  shareMs: 10_000,
  goneGraceMs: 2 * 60_000,
  leaseRetryMs: 50,
};

/** How often a terminal whose paint the core replaced is attached to again
 * within one capture. */
export const REPAINT_TRIES = 3;

/** What a capture works with. */
export interface CaptureEnv {
  base: string;
  hcSocket: string;
  memory: Memory;
  timing: Timing;
  /** The time, in ms since the epoch. */
  now: () => number;
}

/** The instance's terminal core cannot be reached. Its wording is fixed:
 * the error goes to the hub, without the socket's path. */
export const notRunning = () => new Fail('not_running', 503, 'history: the terminal core is not running');

/** A failure to use the snapshots' database as the hub gets it: a code and
 * a fixed wording, never the database's path. */
export function storeError(e: unknown): Fail {
  if (e instanceof BusyError || isAbort(e)) return new Fail('busy', 409, 'history: a capture holds the snapshots');
  if (e instanceof NewerTablesError)
    return new Fail('io', 500, "history: the snapshots' database is of a newer version, which this agent does not change");
  return new Fail('io', 500, "history: the snapshots' database cannot be used");
}

const isAbort = (e: unknown): boolean => e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');

/** The reasons a terminal finished for when its terminal core or its
 * machine ended rather than its program (web/src/restore.ts): its
 * snapshots are what the page shows above the shell that replaces it. */
const CORE_ENDED = new Set(['stopped_by_restart', 'holder_lost', 'server_stop', 'host_shutdown']);

/** Whether a terminal of the terminal core's records gets snapshots: live,
 * running a program, with an address that can name a snapshot (a machine
 * linked to the terminal core has addresses machine/t7), and none of the product's
 * own helpers (agentproto.hidden: the name and the label both); a terminal
 * that only carries the label is one of the user's and is captured. */
export function capturable(t: Terminal): boolean {
  if (hidden(t.name ?? '', (t.labels ?? {})[HIDDEN_LABEL] ?? '')) return false;
  return t.state === 'live' && typeof t.pid === 'number' && t.pid > 0 && validHistoryTerminal(t.address);
}

/** Whether a terminal ended with its program (an exit, a kill): its
 * snapshots go. */
const finishedForGood = (t: Terminal): boolean => t.state === 'finished' && (t.reason == null || !CORE_ENDED.has(t.reason));

/** A capture's parameters clamped to the hard limits. */
export interface Limits {
  lines: number;
  terminals: number;
  total: number;
  days: number;
}

export function limitsOf(p: HistoryCaptureParams): Limits {
  const L = HistoryLimits;
  return {
    lines: clamp(p.lines, L.minLines, L.maxLines),
    terminals: clamp(p.maxTerminals, L.minTerminals, L.maxTerminals),
    total: clamp(p.maxTotalBytes, L.minTotalBytes, L.maxTotalBytes),
    days: clamp(p.days, L.minDays, L.maxDays),
  };
}

const zeros = (): HistoryCaptureResult => ({ captured: 0, skipped: 0, failed: 0, evicted: 0, removed: 0, bytes: 0 });

const within = (signal: AbortSignal, ms: number): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

/** Snapshots the live terminals of the instance's terminal core within p's
 * limits, until signal ends (the terminals it did not reach fail as
 * timeout). */
export async function capture(env: CaptureEnv, p: HistoryCaptureParams, signal: AbortSignal): Promise<HistoryCaptureResult> {
  const lim = limitsOf(p);
  const res = zeros();
  const lock = within(signal, env.timing.lockWaitMs);
  let opened: { store: Store; removed: number };
  try {
    opened = await Store.open(env.base, env.memory, { wait: true, signal: lock, retryMs: env.timing.leaseRetryMs });
  } catch (e) {
    if (!signal.aborted && (e instanceof BusyError || (lock.aborted && isAbort(e)))) return { ...res, busy: true };
    throw storeError(e);
  }
  const s = opened.store;
  try {
    res.removed = opened.removed + s.pruneAge(env.now(), lim.days);
    await run(env, s, lim, res, signal);
    return res;
  } finally {
    res.bytes = s.total();
    s.close();
  }
}

/** A capture once the store is open: what the terminal core's records say
 * no longer belongs goes, the limits apply, then each capturable terminal
 * is captured, those captured longest ago first. */
async function run(env: CaptureEnv, s: Store, lim: Limits, res: HistoryCaptureResult, signal: AbortSignal): Promise<void> {
  let conn: Conn;
  try {
    conn = await dialHC(env.hcSocket, signal);
  } catch {
    throw notRunning();
  }
  try {
    let list: { terminals?: Terminal[] | null };
    try {
      list = await conn.call('terminal.list', { all: true }, { signal: within(signal, env.timing.probeMs) });
    } catch {
      throw notRunning();
    }
    const terminals = list?.terminals ?? [];
    const byAddr = new Map(terminals.map((t) => [t.address, t]));
    const mem = env.memory;
    const now = env.now();
    for (const addr of [...s.terms.keys()]) {
      const t = byAddr.get(addr);
      if (t && finishedForGood(t)) {
        if (s.remove(addr)) res.removed++;
      } else if (t) mem.vanished.forget(addr);
      else {
        // Gone from the records: kept for the grace, in which a page may
        // give them to the terminal that took its place (adopt).
        const since = mem.vanished.get(addr);
        if (since === undefined) mem.vanished.set(addr, now);
        else if (now - since >= env.timing.goneGraceMs && s.remove(addr)) res.removed++;
      }
    }
    mem.vanished.keepOnly(new Set(s.terms.keys()));
    res.evicted += s.fit(lim.terminals, lim.total);
    const todo = terminals.filter(capturable);
    mem.keepOnlyLive(new Set(todo.map((t) => t.address)));
    const lastTried = (addr: string) => {
      const at = s.terms.get(addr)?.newest() ?? 0;
      const tried = mem.tried.get(addr);
      return tried !== undefined && tried > at ? tried : at;
    };
    const order = new Map(todo.map((t) => [t.address, lastTried(t.address)]));
    todo.sort((a, b) => order.get(a.address)! - order.get(b.address)! || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    const c = new Capturer(conn, s, lim, env);
    for (const t of todo) {
      let code = 'timeout';
      let evicted = 0;
      if (!signal.aborted) ({ code, evicted } = await c.one(t, signal));
      res.evicted += evicted;
      if (code === '') res.captured++;
      else if (code === SKIPPED) res.skipped++;
      else {
        res.failed++;
        res.errors ??= {};
        if (Object.keys(res.errors).length < HistoryLimits.maxErrors) res.errors[t.address] = code;
      }
    }
  } finally {
    conn.close();
  }
}

/** Capturer.one's answer for a terminal it left as it was. */
const SKIPPED = 'skipped';

/** Whether err says the terminal is gone, finished, or waits for its new
 * shell (unavailable: a kept terminal that lost its program). */
const gone = (err: unknown): boolean =>
  err instanceof HCError && (err.kind === 'not_found' || err.kind === 'finished' || err.kind === 'unavailable');

/** A terminal's first paint up to its end. */
interface Paint {
  data: Buffer;
  cols: number;
  rows: number;
  lines: number;
}

/** Why a paint was not read: no_paint (none arrived, also with the fewest
 * lines), too_large (above HistoryLimits.maxBytes), incomplete (it did not
 * end within the attach's time), ended (the terminal's program ended),
 * repainted (the core replaced it by one without history), error (the
 * attach failed: err). */
type Why = 'no_paint' | 'too_large' | 'incomplete' | 'ended' | 'repainted' | 'error';

type Grabbed = { ok: true; paint: Paint } | { ok: false; why: Why; paint: Paint; err?: unknown };

/** The terminals of one capture. */
class Capturer {
  private readonly conn: Conn;
  private readonly s: Store;
  private readonly lim: Limits;
  private readonly env: CaptureEnv;
  /** The terminals captured in this capture, which its later terminals do
   * not evict. */
  private readonly written = new Set<string>();

  constructor(conn: Conn, s: Store, lim: Limits, env: CaptureEnv) {
    this.conn = conn;
    this.s = s;
    this.lim = lim;
    this.env = env;
  }

  /** Captures terminal t: "" when it wrote a new current generation,
   * skipped when nothing changed (or the terminal ended meanwhile), else
   * the failure's code. A terminal that fails keeps the generations it
   * had. */
  async one(t: Terminal, signal: AbortSignal): Promise<{ code: string; evicted: number }> {
    const r = await this.try(t, signal);
    if (r.code !== '' && r.code !== SKIPPED) this.env.memory.tried.set(t.address, this.env.now());
    return r;
  }

  private async try(t: Terminal, signal: AbortSignal): Promise<{ code: string; evicted: number }> {
    const addr = t.address;
    const pid = t.pid!;
    const mem = this.env.memory;
    const s = this.s;
    // The program was replaced (a new shell of a kept terminal, also one
    // that is live again after the agent was away): what it held becomes
    // the previous generation before anything else is written.
    const before = s.terms.get(addr);
    if (before?.cur && before.cur.pid !== pid) {
      try {
        s.rotate(addr);
      } catch {
        return { code: 'write', evicted: 0 };
      }
    }
    // Without a lines member: with history lines the terminal core scrolls
    // a full-screen program to read its history. The text is the
    // terminal's last rows lines as plain text: neither the styles nor the
    // grid change it, so the hash covers the grid too.
    let screen: { text?: string };
    try {
      screen = await this.conn.call('terminal.read', { terminal: addr }, { signal: within(signal, this.env.timing.probeMs) });
    } catch (e) {
      if (gone(e)) return { code: SKIPPED, evicted: 0 };
      if (signal.aborted) return { code: 'timeout', evicted: 0 };
      return { code: 'probe', evicted: 0 };
    }
    const hash = screenHash(t.cols, t.rows, screen?.text ?? '');
    const st = s.terms.get(addr);
    if (st?.cur && st.cur.hash === hash) return { code: SKIPPED, evicted: 0 };
    if (!st?.cur && mem.evictions.get(addr) === screenKey(pid, hash)) return { code: SKIPPED, evicted: 0 };
    const key = `${screenKey(pid, hash)}/${this.lim.terminals}/${this.lim.total}`;
    const refused = mem.refusals.get(addr);
    if (refused && refused.key === key) return { code: refused.code, evicted: 0 };
    const refuse = (code: string) => {
      mem.refusals.set(addr, { key, code });
      return code;
    };
    if (!s.room(addr, this.lim.terminals, this.lim.total, this.written)) return { code: refuse('limit'), evicted: 0 };
    const g = await grab(this.conn, t, this.lim.lines, this.env.timing, signal);
    if (!g.ok) {
      if (signal.aborted) return { code: 'timeout', evicted: 0 };
      switch (g.why) {
        case 'ended':
          return { code: SKIPPED, evicted: 0 };
        case 'no_paint':
          return { code: 'no_paint', evicted: 0 };
        case 'too_large':
          return { code: refuse('too_large'), evicted: 0 };
        case 'incomplete':
          return { code: 'incomplete', evicted: 0 };
        case 'repainted':
          return { code: 'repainted', evicted: 0 };
      }
      return { code: gone(g.err) ? SKIPPED : 'attach', evicted: 0 };
    }
    const p = g.paint;
    const data = stripTitles(p.data);
    const room = s.makeRoom(addr, data.length, this.lim.terminals, this.lim.total, this.written);
    if (!room.ok) return { code: refuse('limit'), evicted: room.evicted };
    const cur = s.terms.get(addr)?.cur;
    const restored = (!!cur && cur.pid === pid && cur.restored) || restoredByCore(data);
    const m: Meta = {
      terminal: addr,
      hash,
      days: this.lim.days,
      restored,
      pid,
      at: this.env.now(),
      lines: p.lines,
      bytes: data.length,
      cols: p.cols,
      rows: p.rows,
    };
    try {
      s.write(m, data);
    } catch {
      return { code: 'write', evicted: room.evicted };
    }
    mem.forgetTerminal(addr);
    this.written.add(addr);
    return { code: '', evicted: room.evicted };
  }
}

/** Reads terminal t's first paint with lines of history. One the terminal
 * core dropped or that is too large is asked again with half the lines,
 * down to HistoryLimits.minLines; one the core replaced by a repaint
 * without history is asked again with as many lines, at most
 * REPAINT_TRIES times. What it returns not ok is never a snapshot. */
async function grab(conn: Conn, t: Terminal, lines: number, timing: Timing, signal: AbortSignal): Promise<Grabbed> {
  let cols = t.cols;
  let rows = t.rows;
  let repaints = 0;
  for (;;) {
    const g = await attachOnce(conn, t.address, cols, rows, lines, timing, signal);
    if (g.ok || signal.aborted) return g;
    if (g.why === 'repainted' && repaints < REPAINT_TRIES) {
      repaints++;
      cols = g.paint.cols;
      rows = g.paint.rows;
      continue;
    }
    if ((g.why === 'no_paint' || g.why === 'too_large') && lines > HistoryLimits.minLines) {
      lines = Math.max(HistoryLimits.minLines, Math.floor(lines / 2));
      continue;
    }
    return g;
  }
}

/** Attaches to terminal addr, last seen with a grid of cols × rows, as an
 * observer with lines of history and reads its first paint up to its end
 * (PAINT_END), within timing.attachMs. Credit goes back as the bytes
 * arrive, so a paint larger than the terminal core's window arrives whole.
 * Repainted: the paint's grid is the terminal's newest. */
async function attachOnce(
  conn: Conn,
  addr: string,
  cols: number,
  rows: number,
  lines: number,
  timing: Timing,
  signal: AbortSignal,
): Promise<Grabbed> {
  const limit = within(signal, timing.attachMs);
  const start = performance.now();
  const p: Paint = { data: Buffer.alloc(0), cols, rows, lines };
  const fail = (why: Why, err?: unknown): Grabbed => ({ ok: false, why, paint: p, err });
  let st: Stream;
  let att: { terminal?: Terminal };
  try {
    ({ stream: st, attached: att } = await conn.attach(
      { terminal: addr, cols: Math.max(cols, 1), rows: Math.max(rows, 1), history: lines, observe: true, resize_notifications: true },
      { signal: limit },
    ));
  } catch (e) {
    return fail('error', e);
  }
  try {
    // The reply's record is read after the paint was queued: a grid other
    // than the one listed means a resize that may have replaced the paint
    // before a byte of it was sent.
    const g = att.terminal;
    if (g && g.cols > 0 && g.rows > 0 && (g.cols !== cols || g.rows !== rows)) {
      p.cols = g.cols;
      p.rows = g.rows;
      return fail('repainted');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tail = Buffer.alloc(0);
    let gridSeen = false;
    for (;;) {
      const elapsed = performance.now() - start;
      let wait = timing.attachMs - elapsed;
      if (size === 0 && chunks.length === 0) {
        wait = timing.firstByteMs - elapsed;
        if (wait <= 0) return fail('no_paint');
      }
      let o;
      try {
        o = await st.recv(within(limit, Math.max(wait, 1)));
      } catch (e) {
        if (signal.aborted) return fail('error', e);
        // The attach's time or the wait ran out.
        return fail(chunks.length === 0 ? 'no_paint' : 'incomplete');
      }
      if (o === null) {
        p.data = Buffer.alloc(0);
        return fail('ended');
      }
      if (!('data' in o)) {
        if (o.cols === 0 && o.rows === 0) continue;
        // The grid the paint is drawn for comes first, once; a grid after
        // it, or another one than listed, comes with a repaint without
        // history.
        if (gridSeen || chunks.length > 0 || o.cols !== p.cols || o.rows !== p.rows) {
          p.cols = o.cols;
          p.rows = o.rows;
          return fail('repainted');
        }
        gridSeen = true;
        continue;
      }
      const d = o.data;
      if (d.length === 0) continue; // an empty frame
      st.ack(d.length);
      // The program's output before any paint: the core dropped it; a
      // second paint: the reader fell behind.
      if (chunks.length === 0 && d[0] !== 0x18) return fail('no_paint');
      if (chunks.length > 0 && d[0] === 0x18) return fail('repainted');
      const window = Buffer.concat([tail, d]);
      const at = endOf(window, 0);
      if (at >= 0) {
        const end = size - tail.length + at;
        chunks.push(d);
        p.data = Buffer.concat(chunks).subarray(0, end);
        return { ok: true, paint: p };
      }
      chunks.push(d);
      size += d.length;
      tail = window.subarray(Math.max(0, window.length - PAINT_END.length));
      if (size > HistoryLimits.maxBytes) return fail('too_large');
    }
  } finally {
    st.close();
  }
}

/** Whether addr is a terminal of the terminal core's records. */
export async function recorded(hcSocket: string, addr: string, timing: Timing, signal: AbortSignal): Promise<boolean> {
  let conn: Conn;
  try {
    conn = await dialHC(hcSocket, signal);
  } catch {
    throw notRunning();
  }
  try {
    let list: { terminals?: Terminal[] | null };
    try {
      list = await conn.call('terminal.list', { all: true }, { signal: within(signal, timing.probeMs) });
    } catch {
      throw notRunning();
    }
    return (list?.terminals ?? []).some((t) => t.address === addr);
  } finally {
    conn.close();
  }
}
