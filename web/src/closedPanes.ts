// Closing with a way back: a pane or tab closed with Close Pane or Close Tab
// leaves at once, without asking, and its terminals end UNDO_MS later
// (TermModel.closeLater). Until then Undo Close (pane.undoClose, cmd+z in
// the desktop app on macOS) puts the newest of them back as it was, with
// its terminals' programs still running. Records live in the page; the
// terminals' end does not depend on it.
import * as L from './term/layout';

/** How long a closed pane can be brought back. */
export let UNDO_MS = 5000;

export interface ClosedRecord extends L.Closed {
  m: string;
  /** The terminals closed, which end at the deadline. */
  terminals: string[];
  /** When they end (Date.now()). */
  deadline: number;
}

let records: ClosedRecord[] = [];

/** Records that panes of a tab are closed, before they go; returns the
 * record, undefined when the panes are not in the layout. */
export function rememberClosed(m: string, layout: L.Layout, keys: string[], now = Date.now()): ClosedRecord | undefined {
  const at = keys.map((k) => L.locate(layout, k)).find((x) => x !== null);
  if (!at) return undefined;
  const ws = layout.workspaces[at.workspace];
  const tab = ws.tabs[at.tab];
  const closed = L.tabPanes(tab).filter((k) => keys.includes(k));
  if (!closed.length) return undefined;
  const terminals = L.tabTerminals(tab).filter((k) => keys.includes(k));
  const record = { m, ws: ws.id, index: at.tab, tab, closed, terminals, deadline: now + UNDO_MS };
  records = [...records.filter((r) => r.deadline > now), record];
  return record;
}

/** Takes the newest record that can still be undone. */
export function takeClosed(now = Date.now()): ClosedRecord | undefined {
  records = records.filter((r) => r.deadline > now);
  return records.pop();
}

export function hasClosed(now = Date.now()): boolean {
  return records.some((r) => r.deadline > now);
}

/** Forgets every record (tests), and sets the time to undo. */
export function resetClosed(undoMs = 5000) {
  records = [];
  UNDO_MS = undoMs;
}
