// Closing with a way back: a pane, tab or workspace closed with Close
// Pane, Close Tab or Close Workspace leaves at once, without asking, and
// its terminals end UNDO_MS later (TermModel.closeLater). Until then Undo
// Close (pane.undoClose, cmd+z in the desktop app on macOS) puts the
// newest of them back as it was, with its terminals' programs still
// running; tabs or workspaces closed together (a selection of them) come
// back together. Records live in the page; the terminals' end does not
// depend on it.
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

/** A workspace closed: it comes back first, at its place, and its tabs'
 * records (of its group) after it. */
export interface ClosedWorkspace {
  m: string;
  /** The workspace as it was (its tabs come back by their records). */
  workspace: L.Workspace;
  /** Its place among the machine's workspaces, and theirs then. */
  index: number;
  known: string[];
  deadline: number;
  group: number;
}

let records: ClosedRecord[] = [];
let spaces: ClosedWorkspace[] = [];
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

/** Records that a workspace is closed, before it goes, with a record per
 * tab (its panes all closed); returns the tabs' records, whose terminals
 * end at the deadline, or undefined when it is not in the layout. */
export function rememberWorkspace(
  m: string,
  layout: L.Layout,
  id: string,
  now = Date.now(),
  group = closingGroup(),
): ClosedRecord[] | undefined {
  const index = layout.workspaces.findIndex((w) => w.id === id);
  if (index < 0) return undefined;
  const workspace = layout.workspaces[index];
  const known = layout.workspaces.map((w) => w.id);
  spaces = [...spaces.filter((r) => r.deadline > now), { m, workspace, index, known, deadline: now + UNDO_MS, group }];
  return workspace.tabs.flatMap((tab) => rememberClosed(m, layout, L.tabPanes(tab), now, group) ?? []);
}

/** Takes the records of the newest closing that can still be undone, in
 * the order they were made; none when there is nothing to undo. */
export function takeClosed(now = Date.now()): { tabs: ClosedRecord[]; workspaces: ClosedWorkspace[] } {
  records = records.filter((r) => r.deadline > now);
  spaces = spaces.filter((r) => r.deadline > now);
  const last = Math.max(0, ...records.map((r) => r.group), ...spaces.map((r) => r.group));
  const tabs = records.filter((r) => r.group === last);
  const workspaces = spaces.filter((r) => r.group === last);
  records = records.filter((r) => r.group !== last);
  spaces = spaces.filter((r) => r.group !== last);
  return { tabs, workspaces };
}

export function hasClosed(now = Date.now()): boolean {
  return records.some((r) => r.deadline > now) || spaces.some((r) => r.deadline > now);
}

/** Forgets every record (tests), and sets the time to undo. */
export function resetClosed(undoMs = 5000) {
  records = [];
  spaces = [];
  UNDO_MS = undoMs;
}
