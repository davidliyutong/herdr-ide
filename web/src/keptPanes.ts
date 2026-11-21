// The terminals shown last stay mounted while another tab, workspace or
// machine is shown: hidden, still attached, their emulators taking the
// output. Coming back to one shows it at once, where the user had scrolled
// it, instead of attaching again and painting the screen and its history
// from the end. How many are kept is the setting performance.keptTerminals
// (each holds a stream and an emulator with its scrollback, not a canvas:
// a hidden terminal gives up what it draws with); one shown longer ago
// attaches again when it is shown.
import type * as L from './term/layout';

export interface KeptPane {
  m: string;
  /** The terminal's address. */
  pane: string;
  /** Where it was shown, as fractions of the tab, so that it keeps its size. */
  rect: L.Rect;
}

let recent: KeptPane[] = [];

const same = (a: KeptPane, b: KeptPane) => a.m === b.m && a.pane === b.pane;

/** Notes the terminals shown now and returns the ones to keep hidden: the
 * latest shown before that are still open (open says whether one is), at
 * most limit of them. */
export function keepPanes(shown: readonly KeptPane[], limit: number, open: (k: KeptPane) => boolean): KeptPane[] {
  const hidden = recent.filter((k) => !shown.some((s) => same(s, k)) && open(k)).slice(0, Math.max(0, limit));
  recent = [...shown, ...hidden];
  return hidden;
}

/** Forgets the kept terminals: their view is gone (and in tests). */
export function resetKeptPanes() {
  recent = [];
}
