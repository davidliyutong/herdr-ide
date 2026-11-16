// The keyboard of the sidebar's and the tab bar's rows: one tab stop per
// list (the row focused last, else the row shown), arrows between rows,
// and the keys of what a row offers (F2 renames, Delete closes or removes,
// the menu key or Shift+F10 opens its menu at the row).

import { isMac } from './keys';

/** Rows of a list carry data-nav (their id). */
export const ROW = '[data-nav]';

/** A press with the mouse leaves the keyboard where it was (the terminal
 * shown next takes it, as before rows could be focused); only the keyboard
 * puts it on a row. A name being edited in the row keeps its presses. */
export function keepFocus(e: React.MouseEvent) {
  if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
}

/** Makes row the list's tab stop: the keyboard was there last. */
export function rove(list: HTMLElement, row: HTMLElement) {
  for (const el of list.querySelectorAll<HTMLElement>(`${ROW}[tabindex="0"]`)) if (el !== row) el.tabIndex = -1;
  row.tabIndex = 0;
  delete row.dataset.autoStop;
}

/** Gives a list its tab stop while the keyboard has not chosen one (or the
 * row it chose went away): the preferred row (the one shown, which may
 * change), else the first. */
export function ensureTabStop(list: HTMLElement | null, preferred: string) {
  if (!list) return;
  const stop = list.querySelector<HTMLElement>(`${ROW}[tabindex="0"]`);
  const row = list.querySelector<HTMLElement>(preferred) ?? list.querySelector<HTMLElement>(ROW);
  if ((stop && stop.dataset.autoStop === undefined) || !row || stop === row) return;
  if (stop) {
    stop.tabIndex = -1;
    delete stop.dataset.autoStop;
  }
  row.tabIndex = 0;
  row.dataset.autoStop = '';
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
