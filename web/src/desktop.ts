// The desktop app's bridge (desktop/src/preload.ts) and its direct shortcuts:
// keys without herdr's prefix, such as Cmd+T, held in core settings. The shell
// intercepts them before the page and calls onShortcut; in a browser there is
// no bridge and none of this is active.

import { actions } from './actions';
import { getKeyConfig, runAction, setDirectShortcuts } from './keymap';
import type { MessageKey } from './i18n';

/** Same interface as desktop/src/bridge.ts. */
export interface DesktopShell {
  onShortcut(fn: (action: string) => void): () => void;
  shortcutsChanged(): void;
  recordShortcut(active: boolean): void;
  onRecordedKey(fn: (spec: string) => void): () => void;
}

export const desktopShell: DesktopShell | undefined = (globalThis as { desktopShell?: DesktopShell }).desktopShell;

/** Action → core setting holding its shortcut. */
export const shortcutSettings: Record<string, string> = {
  new_tab: 'desktop-new-tab-key',
  close_tab: 'desktop-close-tab-key',
};

export function isShortcutSetting(key: string): boolean {
  return Object.values(shortcutSettings).includes(key);
}

/** Direct shortcuts from a /api/settings list ("none" leaves an action without one). */
export function shortcutsFrom(list: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [action, key] of Object.entries(shortcutSettings)) {
    const v = list.find((s) => s.key === key)?.value;
    if (v && v !== 'none') out[action] = v;
  }
  return out;
}

/** Tells the shell and the key hints that the shortcut settings are now list. */
export function shortcutsSaved(list: { key: string; value: string }[]) {
  if (!desktopShell) return;
  setDirectShortcuts(shortcutsFrom(list));
  desktopShell.shortcutsChanged();
}

/** A spec's modifiers and key, independent of the order they are written in. */
function normalize(spec: string): string {
  const parts = spec.toLowerCase().split('+');
  const key = parts.pop();
  return [...parts.sort(), key].join('+');
}

/**
 * Why spec cannot be the shortcut held by setting key: another action's
 * shortcut, or herdr's prefix key, which would stop reaching the page.
 */
export function shortcutConflict(
  key: string,
  spec: string,
  list: { key: string; value: string }[],
  prefix = getKeyConfig().prefix,
): { message: MessageKey; action?: string } | undefined {
  if (!spec || spec === 'none') return;
  const n = normalize(spec);
  for (const [action, k] of Object.entries(shortcutSettings)) {
    if (k === key) continue;
    const v = list.find((s) => s.key === k)?.value;
    if (v && v !== 'none' && normalize(v) === n) return { message: 'settings.shortcut.taken', action };
  }
  if (prefix && normalize(prefix) === n) return { message: 'settings.shortcut.prefix' };
}

/** Whether spec takes Alt/Option without Cmd or Ctrl: such keys also type
 * characters on macOS and are Meta keys in terminals. */
export function altOnly(spec: string): boolean {
  const mods = spec.split('+').slice(0, -1);
  return mods.includes('alt') && !mods.includes('cmd') && !mods.includes('ctrl');
}

/** Runs a shortcut the shell reports. Nothing runs while a dialog is open
 * (settings, confirmations, the palette…): the key belongs to it. Closing a
 * tab by shortcut always asks first, since it ends the programs in its panes
 * and the key is easy to press by habit. */
export function runShortcut(action: string) {
  if (!Object.hasOwn(shortcutSettings, action)) return;
  if (document.querySelector('.modal-backdrop, .palette-backdrop')) return;
  if (action === 'close_tab') {
    const c = actions.currentTab();
    if (c) void actions.closeTab(c.m, c.tab, { confirm: true });
    return;
  }
  runAction(action);
}

/** Runs the shell's shortcuts and loads them for key hints; returns a
 * function that stops it. */
export function initDesktop(): () => void {
  if (!desktopShell) return () => {};
  const off = desktopShell.onShortcut(runShortcut);
  fetch('/api/settings')
    .then((r) => r.json())
    .then((j) => setDirectShortcuts(shortcutsFrom(j.settings ?? [])))
    .catch(() => {});
  return off;
}
