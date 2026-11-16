// Closing with a way back: a pane or tab closed with Close Pane or Close Tab
// leaves at once, without asking, and its terminals end UNDO_MS later
// (TermModel.closeLater). Until then Undo Close (pane.undoClose, cmd+z in
// the desktop app on macOS) puts the newest of them back as it was, with
// its terminals' programs still running; tabs closed together (a selection
// of them) come back together. Records live in the page; the terminals'
// end does not depend on it.
import * as L from './term/layout';

/** How long a closed pane can be brought back. */
export let UNDO_MS = 5000;

export interface ClosedRecord extends L.Closed {
  m: string;
  /** The terminals closed, which end at the deadline. */
  terminals: string[];
  /** When they end (Date.now()). */
  deadline: number;
  /** Records of one closing (several tabs) share it and come back together. */
  group: number;
}

let records: ClosedRecord[] = [];
let groups = 0;

/** A group for records of one closing. */
export const closingGroup = () => ++groups;

/** Records that panes of a tab are closed, before they go; returns the
 * record, undefined when the panes are not in the layout. */
export function rememberClosed(
  m: string,
  layout: L.Layout,
  keys: string[],
  now = Date.now(),
  group = closingGroup(),
): ClosedRecord | undefined {
  const at = keys.map((k) => L.locate(layout, k)).find((x) => x !== null);
  if (!at) return undefined;
  const ws = layout.workspaces[at.workspace];
  const tab = ws.tabs[at.tab];
  const closed = L.tabPanes(tab).filter((k) => keys.includes(k));
  if (!closed.length) return undefined;
  const terminals = L.tabTerminals(tab).filter((k) => keys.includes(k));
  const record = { m, ws: ws.id, index: at.tab, tab, closed, terminals, deadline: now + UNDO_MS, group };
  records = [...records.filter((r) => r.deadline > now), record];
  return record;
}

/** Takes the records of the newest closing that can still be undone, in
 * the order they were made; none when there is nothing to undo. */
export function takeClosed(now = Date.now()): ClosedRecord[] {
  records = records.filter((r) => r.deadline > now);
  const last = records[records.length - 1];
  if (!last) return [];
  const taken = records.filter((r) => r.group === last.group);
  records = records.filter((r) => r.group !== last.group);
  return taken;
}

export function hasClosed(now = Date.now()): boolean {
  return records.some((r) => r.deadline > now);
}

/** Forgets every record (tests), and sets the time to undo. */
export function resetClosed(undoMs = 5000) {
  records = [];
  UNDO_MS = undoMs;
}
