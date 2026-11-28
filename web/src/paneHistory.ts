// The panes focused, in order, for Go Back and Go Forward (pane.back,
// pane.forward; cmd+[ and cmd+] in the desktop app on macOS), as a browser
// keeps the pages it showed: going back and forward moves along it, and a
// pane focused otherwise after going back drops what lay ahead. A pane is
// one of a machine; going to it shows its machine, workspace and tab.
// Panes closed since are passed over, and so is the pane that has the focus
// already: closing a pane focuses one beside it, which is then both the
// latest place and the one before the closed pane, and a step that went
// "back" to where the user is would look like a key that does nothing.
// A tab closed while shown gives way to the tab of the pane focused last.
// The history lives in the page only.
import * as L from './term/layout';

export interface Spot {
  m: string;
  pane: string;
}

export const MAX_HISTORY = 100;

let spots: Spot[] = [];
let at = -1;
/** The panes focused, the latest first, each once: going back and forward
 * reorders them as any focus does, and nothing ahead is dropped. */
let recent: Spot[] = [];

const same = (a: Spot | undefined, b: Spot) => !!a && a.m === b.m && a.pane === b.pane;

/** Records the pane focused now, unless it is where the history is. */
export function noteFocus(spot: Spot) {
  if (!same(recent[0], spot)) recent = [spot, ...recent.filter((s) => !same(s, spot))].slice(0, MAX_HISTORY);
  if (same(spots[at], spot)) return;
  spots = [...spots.slice(0, at + 1), spot].slice(-MAX_HISTORY);
  at = spots.length - 1;
}

/** The place step away (-1 back, 1 forward), passing over panes that are
 * gone (open says whether one is still open) and the pane the history is
 * at; undefined at an end. */
function target(step: -1 | 1, open: (s: Spot) => boolean): number | undefined {
  for (let i = at + step; i >= 0 && i < spots.length; i += step) if (!same(spots[at], spots[i]) && open(spots[i])) return i;
  return undefined;
}

/** The panes focused, the latest first. */
export function recentSpots(): readonly Spot[] {
  return [...spots].reverse();
}

/** Machine m's panes focused, the latest first (a closed tab gives way to
 * the tab of the first still open, layout.ts showRecentTab). */
export function recentPanes(m: string): string[] {
  return recent.filter((s) => s.m === m).map((s) => s.pane);
}

export function canGo(step: -1 | 1, open: (s: Spot) => boolean): boolean {
  return target(step, open) !== undefined;
}

/** Moves along the history and returns the pane to focus. */
export function go(step: -1 | 1, open: (s: Spot) => boolean): Spot | undefined {
  const i = target(step, open);
  if (i === undefined) return undefined;
  at = i;
  return spots[i];
}

/** Whether a machine's layout holds a pane. */
export const paneOpen = (layout: L.Layout | undefined, pane: string) => !!layout && L.locate(layout, pane) !== null;

/** Forgets the history (tests). */
export function resetHistory() {
  spots = [];
  at = -1;
  recent = [];
}
