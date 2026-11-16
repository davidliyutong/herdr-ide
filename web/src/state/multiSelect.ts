// Rows selected together in the sidebar and the tab bar, to act on them at
// once: machines, workspaces of one machine, or tabs of one workspace (a
// tab known by its first pane, since tabs have no ids of their own). A
// click with ⌘ (Ctrl elsewhere) adds or removes a row, Shift adds the rows
// from the last one clicked, ⌘/Ctrl+A takes every row of the list and
// Escape clears; a plain click clears the selection and does what it
// always does. The workspace shown and the tab shown start a selection.
// Rows that went away (closed, removed, here or by another client) drop
// out when it is read.

import { create } from 'zustand';
import * as L from '../term/layout';
import { terms } from './terms';
import { useStore } from './store';
import { clickSelection, rangeOf, selectAll, selectRange, selectToggle, type Selection } from '../components/tree/selection';

export type MultiKind = 'machine' | 'workspace' | 'tab';

/** Which list: the machines, a machine's workspaces, or a workspace's tabs. */
export interface MultiScope {
  kind: MultiKind;
  m?: string;
  ws?: string;
}

export interface MultiSelection extends Selection, MultiScope {}

export const useMulti = create<{ sel?: MultiSelection }>(() => ({}));

/** A tab's id in a selection: its first pane. */
export const tabId = (tab: L.Tab) => L.tabPanes(tab)[0] ?? '';

const sameScope = (a: MultiScope, b: MultiScope) => a.kind === b.kind && (a.m ?? '') === (b.m ?? '') && (a.ws ?? '') === (b.ws ?? '');

/** The rows of a list, by id, in their order. */
export function rowIds(scope: MultiScope): string[] {
  if (scope.kind === 'machine') return useStore.getState().order;
  const layout = scope.m ? terms.layout(scope.m) : undefined;
  if (!layout) return [];
  if (scope.kind === 'workspace') return layout.workspaces.map((w) => w.id);
  return layout.workspaces.find((w) => w.id === scope.ws)?.tabs.map(tabId) ?? [];
}

/** The rows selected in a list that are still there, in the list's order;
 * none when the selection is of another list. */
export function selectedIds(scope: MultiScope, sel = useMulti.getState().sel): string[] {
  if (!sel || !sameScope(sel, scope)) return [];
  return rowIds(scope).filter((id) => sel.selection.includes(id));
}

/** Whether a row is one of several selected: its menu, drag and keys act on all of them. */
export function inMulti(scope: MultiScope, id: string, sel = useMulti.getState().sel): boolean {
  const ids = selectedIds(scope, sel);
  return ids.length > 1 && ids.includes(id);
}

/** The rows a menu, drag or key on a row acts on: the selection when the
 * row is one of several selected, else the row alone. */
export function targetIds(scope: MultiScope, id: string): string[] {
  return inMulti(scope, id) ? selectedIds(scope) : [id];
}

export function clearMulti() {
  if (useMulti.getState().sel) useMulti.setState({ sel: undefined });
}

const store = (scope: MultiScope, s: Selection) =>
  useMulti.setState({ sel: { kind: scope.kind, m: scope.m, ws: scope.ws, selection: s.selection, cursor: s.cursor, anchor: s.anchor } });

/** The selection of a list to build on: the current one, else one of the
 * row shown (primary) when there is one. */
function base(scope: MultiScope, primary?: string): Selection {
  const cur = useMulti.getState().sel;
  if (cur && sameScope(cur, scope)) return cur;
  return primary ? { selection: [primary], cursor: primary, anchor: primary } : { selection: [] };
}

/** A click on a row: with ⌘/Ctrl it adds or removes the row, with Shift
 * it adds the rows from the anchor, and true is returned (the click does
 * nothing else); a plain click clears the selection and returns false. */
export function clickRow(
  ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  scope: MultiScope,
  id: string,
  primary?: string,
): boolean {
  const how = clickSelection(ev);
  if (how === 'only') {
    clearMulti();
    return false;
  }
  const b = base(scope, primary);
  store(scope, how === 'toggle' ? selectToggle(b, id) : selectRange(b, rowIds(scope), id));
  return true;
}

/** Every row of a list (⌘/Ctrl+A). */
export function selectAllRows(scope: MultiScope, primary?: string) {
  store(scope, selectAll(base(scope, primary), rowIds(scope)));
}

/** The rows from the anchor to id (Shift with an arrow key), the anchor
 * being the row the keyboard left when none is set. */
export function extendTo(scope: MultiScope, from: string, id: string) {
  const b = base(scope, from);
  const anchor = b.anchor ?? from;
  store(scope, { selection: rangeOf(rowIds(scope), anchor, id), cursor: id, anchor });
}

/** Names as a sentence lists them: the first few, then how many more. */
export function nameList(names: readonly string[], sep: string, more: (n: number) => string, max = 5): string {
  const shown = names.slice(0, max).join(sep);
  return names.length > max ? shown + more(names.length - max) : shown;
}
