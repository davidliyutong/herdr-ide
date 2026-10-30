// In-app context menu: one at a time, opened at the pointer by openMenu and
// rendered by components/ContextMenu.tsx.

import type { ReactNode } from 'react';
import { create } from 'zustand';

export interface MenuItem {
  label: string;
  /** Key binding of the same command, shown on the right. */
  hint?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  run(): void;
}

export type MenuEntry = MenuItem | 'sep';

export interface MenuState {
  x: number;
  y: number;
  entries: MenuEntry[];
  /** Element focused before the menu opened, focused again when the menu
   * closes from the keyboard or runs an item. */
  restore: Element | null;
  seq: number;
}

export const useMenu = create<{ menu?: MenuState }>(() => ({}));

let seq = 0;

export const isItem = (e: MenuEntry | undefined): e is MenuItem => typeof e === 'object';

/** Entries without leading, trailing or repeated separators. */
export function tidy(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) if (isItem(e) || (out.length && out[out.length - 1] !== 'sep')) out.push(e);
  if (out[out.length - 1] === 'sep') out.pop();
  return out;
}

/** Index of the next enabled item from `cur` in direction `step`, wrapping
 * around; -1 when there is none. */
export function stepIndex(entries: MenuEntry[], cur: number, step: 1 | -1): number {
  const n = entries.length;
  for (let k = 1; k <= n; k++) {
    const i = (((cur + step * k) % n) + n) % n;
    const e = entries[i];
    if (isItem(e) && !e.disabled) return i;
  }
  return -1;
}

/** Opens a menu at the pointer instead of the browser's. With no items (for
 * example in read-only mode) the browser's menu shows as usual. */
export function openMenu(ev: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, entries: MenuEntry[]) {
  const list = tidy(entries);
  if (!list.some(isItem)) return;
  ev.preventDefault();
  ev.stopPropagation();
  useMenu.setState({ menu: { x: ev.clientX, y: ev.clientY, entries: list, restore: document.activeElement, seq: ++seq } });
}

/** Closes the menu; `restore` focuses what was focused before it opened. */
export function closeMenu(restore: boolean) {
  const m = useMenu.getState().menu;
  if (!m) return;
  useMenu.setState({ menu: undefined });
  if (restore && m.restore instanceof HTMLElement && m.restore.isConnected) m.restore.focus({ preventScroll: true });
}
