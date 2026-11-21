// Where the user had scrolled a terminal whose emulator is gone: a pane
// that is unmounted (shown longer ago than the terminals kept) or attached
// again (its machine was away) starts a new emulator, which the first paint
// fills with the screen and its history, at the end. The place is noted
// before the old emulator goes and found again once the paint is in: a few
// rows of text per terminal instead of an emulator and a stream kept for it.
//
// The place is noted as the text of the first rows shown and how far they
// were from the end. The paint's history is the terminal core's, which may
// be cut at the top where the page's was not, so a row has no number from
// the top to go by; from the end it is where it was, unless the program
// wrote since, which moved it up. So the rows are looked for from that
// place upward, a screen at a time, and the view goes where they are; not
// found (the rows scrolled out of the history, or a pane of another width
// wraps them otherwise), it goes as far from the end as it was. A terminal
// left at the end stays there, and one on the alternate screen has no
// history: what it shows is its program's, which draws it again.

/** A scrollbar's numbers: rows in all, the first row shown, rows shown. */
export interface Bar {
  total: number;
  offset: number;
  len: number;
}

/** A place: the scrollbar when it was noted and the text of the first rows shown. */
export interface Place extends Bar {
  rows: string[];
}

/** A terminal's history as the search reads it. */
export interface View {
  bar(): Bar;
  /** Shows the rows from offset on and returns their text, the first one first. */
  rowsAt(offset: number): string[];
}

/** Terminals remembered at once; the ones noted longest ago go first. */
export const MAX_REMEMBERED = 200;
/** Rows of text a place is known by. */
export const ANCHOR_ROWS = 3;
/** Screens looked through above the place for its rows. */
export const MAX_SCREENS = 200;

const places = new Map<string, Place>();

const key = (m: string, address: string) => `${m}\n${address}`;

/** Notes where a terminal's view is; one at the end is forgotten. */
export function noteScroll(m: string, address: string, place: Place | undefined) {
  const k = key(m, address);
  places.delete(k);
  if (!place || place.offset + place.len >= place.total) return;
  places.set(k, { ...place, rows: place.rows.slice(0, ANCHOR_ROWS) });
  if (places.size > MAX_REMEMBERED) places.delete(places.keys().next().value!);
}

/** The place noted for a terminal, which is then forgotten. */
export function takeScroll(m: string, address: string): Place | undefined {
  const k = key(m, address);
  const place = places.get(k);
  places.delete(k);
  return place;
}

/** The first row to show in a terminal as it is now for the place it was
 * left at: where its rows are, else as far from the end as it was. */
export function findPlace(was: Place, view: View): number {
  const now = view.bar();
  const last = Math.max(0, now.total - now.len);
  const fromEnd = was.total - was.len - was.offset;
  const near = Math.min(last, Math.max(0, last - fromEnd));
  const anchor = was.rows;
  if (!anchor.some((r) => r.trim() !== '')) return near;
  const here = (rows: string[], i: number) => anchor.every((text, k) => rows[i + k] === text);
  const step = Math.max(1, now.len - anchor.length + 1);
  for (let offset = near, screen = 0; screen < MAX_SCREENS; screen++) {
    const rows = view.rowsAt(offset);
    const count = rows.length - anchor.length;
    // At the place itself first; above it, the nearest rows first.
    for (let n = 0; n <= count; n++) {
      const i = screen === 0 ? n : count - n;
      if (here(rows, i)) return Math.min(last, offset + i);
    }
    if (offset === 0) break;
    offset = Math.max(0, offset - step);
  }
  return near;
}

/** Forgets every place (tests). */
export function resetScrollMemory() {
  places.clear();
}
