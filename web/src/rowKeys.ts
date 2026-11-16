// The keyboard of the sidebar's and the tab bar's rows: one tab stop per
// list (the row focused last, else the row shown), arrows between rows,
// and the keys of what a row offers (F2 renames, Delete closes or removes,
// the menu key or Shift+F10 opens its menu at the row).

import { isMac } from './keys';

/** Rows of a list carry data-nav (their id). */
export const ROW = '[data-nav]';

/** Makes row the list's tab stop. */
export function rove(list: HTMLElement, row: HTMLElement) {
  for (const el of list.querySelectorAll<HTMLElement>(`${ROW}[tabindex="0"]`)) if (el !== row) el.tabIndex = -1;
  row.tabIndex = 0;
}

/** Gives a list a tab stop when it has none: the preferred row (the one
 * shown), else the first. */
export function ensureTabStop(list: HTMLElement | null, preferred: string) {
  if (!list || list.querySelector(`${ROW}[tabindex="0"]`)) return;
  const row = list.querySelector<HTMLElement>(preferred) ?? list.querySelector<HTMLElement>(ROW);
  if (row) row.tabIndex = 0;
}

/** The menu key, or Shift+F10. */
export const isMenuKey = (e: { key: string; shiftKey: boolean }) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');

/** Delete, or ⌘Backspace on macOS (as Finder). */
export const isDeleteKey = (e: { key: string; metaKey: boolean }, mac = isMac) =>
  e.key === 'Delete' || (mac && e.metaKey && e.key === 'Backspace');

/** Ctrl+Space (as in VS Code's lists; macOS keeps ⌘Space for Spotlight):
 * toggles a row in the selection. */
export const isToggleKey = (e: { key: string; metaKey: boolean; ctrlKey: boolean }) => e.key === ' ' && (e.ctrlKey || e.metaKey);

/** Opens a row's context menu below its start, as a right click there would. */
export function openRowMenu(row: HTMLElement) {
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.bottom }));
}
