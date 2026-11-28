// Rows of the file explorer dragged inside the page (plugins/files): the
// drag carries their machine and paths (PATHS_TYPE). The tree moves or
// copies them; a terminal of the same machine pastes them shell-quoted, as
// it pastes files dropped from outside (drop.ts), and a chat of it attaches
// them as files, as its file picker does. Panes of another machine refuse
// them: the paths are not there.

import { APP_SLUG } from './brand';
import { shellQuote } from './lib/files';

/** The drag type of the file explorer's rows: JSON DraggedPaths. */
export const PATHS_TYPE = `application/x-${APP_SLUG}-files`;

/** Paths of a machine dragged from the file explorer; dirs: those of them
 * that are folders. */
export interface DraggedPaths {
  m: string;
  paths: string[];
  dirs?: string[];
}

/** The explorer's drag under way on this page. Its data can be read only
 * at the drop; while it is dragged over a target, this says whose paths
 * they are. */
let dragging: DraggedPaths | undefined;

/** Puts the explorer's rows into a drag (at dragstart). */
export function startPathsDrag(dt: DataTransfer, d: DraggedPaths) {
  dt.setData(PATHS_TYPE, JSON.stringify(d));
  dragging = d;
}

/** The explorer's drag ended (dragend), dropped or not. */
export function endPathsDrag() {
  dragging = undefined;
}

/** Whether a drag carries the explorer's rows. */
export function carriesPaths(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes(PATHS_TYPE);
}

/** Whether a target of machine m takes the explorer's rows of a drag over
 * it: rows of its own machine. A drag from another window of the page,
 * whose machine is not known before the drop, is taken and checked then
 * (draggedPaths). */
export function takesPaths(dt: DataTransfer | null, m: string): boolean {
  return carriesPaths(dt) && (!dragging || dragging.m === m);
}

/** The explorer's rows dropped on a target of machine m, when they are of
 * that machine (absolute paths only); undefined otherwise. Read during the
 * drop. */
export function draggedPaths(dt: DataTransfer | null, m: string): DraggedPaths | undefined {
  const raw = dt?.getData(PATHS_TYPE);
  if (!raw) return undefined;
  let d: Partial<DraggedPaths>;
  try {
    d = JSON.parse(raw) as Partial<DraggedPaths>;
  } catch {
    return undefined;
  }
  if (d.m !== m || !Array.isArray(d.paths)) return undefined;
  const abs = (p: unknown): p is string => typeof p === 'string' && p.startsWith('/');
  const paths = d.paths.filter(abs);
  if (!paths.length) return undefined;
  const dirs = Array.isArray(d.dirs) ? d.dirs.filter((p) => abs(p) && paths.includes(p)) : [];
  return { m, paths, dirs };
}

/** The text a terminal of machine m pastes for the explorer's rows dropped
 * on it: their paths, shell-quoted, as for files dropped from outside. */
export function draggedPathsText(dt: DataTransfer | null, m: string): string | undefined {
  const d = draggedPaths(dt, m);
  return d && d.paths.map(shellQuote).join(' ') + ' ';
}
