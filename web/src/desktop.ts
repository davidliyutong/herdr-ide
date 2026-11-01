// The desktop app's bridge (desktop/src/preload.ts) and its direct shortcuts:
// keys without herdr's prefix, such as Cmd+T, held in core settings. The shell
// intercepts them before the page and calls onShortcut; in a browser there is
// no bridge and none of this is active.

import { runAction, setDirectShortcuts } from './keymap';

/** Same interface as desktop/src/bridge.ts. */
export interface DesktopShell {
  onShortcut(fn: (action: string) => void): void;
  shortcutsChanged(): void;
  recordShortcut(active: boolean): void;
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

/** Runs the shell's shortcuts and loads them for key hints. */
export function initDesktop() {
  if (!desktopShell) return;
  desktopShell.onShortcut((action) => {
    if (Object.hasOwn(shortcutSettings, action)) runAction(action);
  });
  fetch('/api/settings')
    .then((r) => r.json())
    .then((j) => setDirectShortcuts(shortcutsFrom(j.settings ?? [])))
    .catch(() => {});
}

const codeKeys: Record<string, string> = {
  Tab: 'tab',
  Space: 'space',
  Enter: 'enter',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Minus: 'minus',
  Equal: 'equal',
  Comma: 'comma',
  Period: 'period',
  Slash: 'slash',
  Backslash: 'backslash',
  Semicolon: 'semicolon',
  Quote: 'quote',
  Backquote: 'backtick',
  BracketLeft: 'bracketleft',
  BracketRight: 'bracketright',
};

/**
 * The spec of a recorded key-down, e.g. "cmd+shift+t"; undefined while only
 * modifiers are held or without cmd, ctrl or alt (such a key types text).
 */
export function specOf(ev: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | undefined {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(ev.code)) key = ev.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(ev.code)) key = ev.code.slice(5);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(ev.code)) key = ev.code.toLowerCase();
  else key = codeKeys[ev.code];
  if (!key || !(ev.metaKey || ev.ctrlKey || ev.altKey)) return;
  const mods = [ev.metaKey && 'cmd', ev.ctrlKey && 'ctrl', ev.altKey && 'alt', ev.shiftKey && 'shift'].filter(Boolean);
  return [...mods, key].join('+');
}
