// What a terminal's pane shows above everything its terminal core paints:
// output saved of the terminal before its program was replaced (the
// terminal history plugin, plugins/history), replayed into each new
// emulator of the pane before the first byte of its stream (vt/pane.ts), at
// the grid it was painted at, so that it is in the same scrollback as the
// live terminal's history, above it. Kept in the page's memory only, by
// machine and terminal address. A
// pane learns of a prelude that appears, changes or goes through onPrelude
// and attaches again to show it.

/** The most bytes a prelude holds: a snapshot of one terminal
 * (agentproto.HistoryMaxBytes). */
export const PRELUDE_MAX_BYTES = 2 * 1024 * 1024;

/** The most characters of a prelude's note. */
const NOTE_MAX = 400;

/** The largest grid a prelude is written at: one said to be larger (or
 * smaller than a pane's least) is written at the pane's own grid. */
export const PRELUDE_MAX_COLS = 1000;
export const PRELUDE_MAX_ROWS = 500;

/** A terminal's grid in cells. */
export interface Grid {
  cols: number;
  rows: number;
}

export interface Prelude {
  /** Output as a terminal's first paint has it: history lines with their
   * styles, then the screen (and the alternate screen when a program had
   * it). */
  bytes: Uint8Array;
  /** A line the pane writes dim below the screen the bytes leave: what
   * they are. Plain text. */
  note?: string;
  /** The grid the output was painted at, when known: the pane writes it
   * into an emulator of that size, since the paint pushes its history into
   * the scrollback by as many rows as that grid has. */
  cols?: number;
  rows?: number;
}

const preludes = new Map<string, Prelude>();
const listeners = new Map<string, Set<() => void>>();

const keyOf = (m: string, terminal: string) => `${m}\n${terminal}`;

/** The note as one line of plain text: no control characters, bounded. */
function plainLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, NOTE_MAX);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const within = (v: unknown, min: number, max: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

/** A grid a pane can be given: whole numbers within a pane's least (2 by
 * 1) and PRELUDE_MAX_COLS by PRELUDE_MAX_ROWS; undefined otherwise. */
function gridOf(g: Grid | undefined): Grid | undefined {
  return g && within(g.cols, 2, PRELUDE_MAX_COLS) && within(g.rows, 1, PRELUDE_MAX_ROWS) ? { cols: g.cols, rows: g.rows } : undefined;
}

/** Sets what terminal of machine m shows above its output, or removes it
 * (bytes undefined or empty), with the grid the output was painted at (one
 * out of bounds is dropped). Bytes beyond PRELUDE_MAX_BYTES are refused:
 * the prelude is removed, and false returned. The panes of the terminal
 * are told when it changed; the same bytes, note and grid again change
 * nothing. */
export function setPrelude(m: string, terminal: string, bytes: Uint8Array | undefined, note?: string, grid?: Grid): boolean {
  const key = keyOf(m, terminal);
  const was = preludes.get(key);
  const ok = !bytes || bytes.length <= PRELUDE_MAX_BYTES;
  let next: Prelude | undefined;
  if (bytes?.length && ok) {
    const line = note === undefined ? undefined : plainLine(note);
    const g = gridOf(grid);
    if (was && sameBytes(was.bytes, bytes) && was.note === line && was.cols === g?.cols && was.rows === g?.rows) return true;
    next = { bytes, ...(line === undefined ? {} : { note: line }), ...g };
  }
  if (!next && !was) return ok;
  if (next) preludes.set(key, next);
  else preludes.delete(key);
  for (const fn of [...(listeners.get(key) ?? [])]) fn();
  return ok;
}

/** What terminal of machine m shows above its output, if anything. */
export function preludeOf(m: string, terminal: string): Prelude | undefined {
  return preludes.get(keyOf(m, terminal));
}

/** Calls fn whenever the prelude of terminal of machine m appears,
 * changes or goes. Returns what stops it. */
export function onPrelude(m: string, terminal: string, fn: () => void): () => void {
  const key = keyOf(m, terminal);
  const set = listeners.get(key) ?? new Set();
  listeners.set(key, set.add(fn));
  return () => {
    set.delete(fn);
    if (!set.size && listeners.get(key) === set) listeners.delete(key);
  };
}
