// The application menu, titled with the web UI's desktop.menu.* strings and
// built from the keybindings in effect. An item of a command shows the first
// single-stroke key the keybindings give it; chords have none, the page
// matches them.
//
// On macOS the application's menu (About, Settings, Hide, Quit) comes
// first; on Windows and Linux a File menu holds Settings and Quit (Exit on
// Windows) and Help holds About.
//
// The page sees a key before the menu and cancels the keys it runs
// (web/src/keymap.ts), so a key runs once: on macOS the menu gets only keys
// the page leaves, while a text field, VS Code or another window has the
// keyboard. macOS offers keys without Cmd to a menu before the page, so the
// menu only shows those and leaves them to the page. On Windows and Linux
// the menu registers no key at all, only shows them: every key goes to the
// page and its terminals (Ctrl+C, Ctrl+M, Ctrl+Q are programs' keys there),
// and Chromium's text fields edit with Ctrl keys by themselves.
//
// Edit's Undo, Redo, Cut, Copy, Paste and Select All are the standard
// roles: text fields in Chromium on macOS edit with Cmd keys only through
// the menu.

import type { MenuItemConstructorOptions } from 'electron';
import type { MessageKey } from '../../web/src/i18n/en';
import { acceleratorKey, parseKeys, shiftedChar, type Stroke } from '../../web/src/keys';
import type { Platform } from './platform';

export interface Binding {
  key: string;
  command: string;
  when: string;
}

/** A title: desktop.menu.<title> in the web UI's strings. */
export type Title = { [K in MessageKey]: K extends `desktop.menu.${infer T}` ? T : never }[MessageKey];

export type Role = 'about' | 'hide' | 'quit' | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'minimize';

/** An item: a command of the keybindings, one Electron implements, or a
 * separator. */
export type Item = { title: Title; command: string } | { title: Title; role: Role } | '-';

export type Menu = { title: Title | 'app'; items: Item[] };

/** The menus on macOS: the application's (titled with its name), then the
 * others. */
export const menus: Menu[] = [
  {
    title: 'app',
    items: [
      { title: 'about', role: 'about' },
      '-',
      { title: 'settings', command: 'app.settings' },
      { title: 'keyboardShortcuts', command: 'app.keyboardShortcuts' },
      '-',
      { title: 'hide', role: 'hide' },
      { title: 'quit', role: 'quit' },
    ],
  },
  {
    title: 'shell',
    items: [
      { title: 'newTerminal', command: 'tab.new' },
      { title: 'splitRight', command: 'pane.splitRight' },
      { title: 'splitDown', command: 'pane.splitDown' },
      '-',
      { title: 'newWorkspace', command: 'workspace.new' },
      { title: 'renameWorkspace', command: 'workspace.rename' },
      { title: 'closeWorkspace', command: 'workspace.close' },
      '-',
      { title: 'renameTab', command: 'tab.rename' },
      { title: 'closeTerminal', command: 'pane.close' },
      { title: 'closeTab', command: 'tab.close' },
    ],
  },
  {
    title: 'edit',
    items: [
      { title: 'undo', role: 'undo' },
      { title: 'redo', role: 'redo' },
      '-',
      { title: 'cut', role: 'cut' },
      { title: 'copy', role: 'copy' },
      { title: 'paste', role: 'paste' },
      { title: 'selectAll', role: 'selectAll' },
      '-',
      { title: 'find', command: 'find.open' },
      { title: 'findNext', command: 'find.next' },
      { title: 'findPrevious', command: 'find.previous' },
    ],
  },
  {
    title: 'view',
    items: [
      { title: 'commandPalette', command: 'app.commandPalette' },
      { title: 'switchWorkspace', command: 'workspace.switch' },
      '-',
      { title: 'toggleSidebar', command: 'view.toggleSidebar' },
      { title: 'toggleCode', command: 'view.toggleCode' },
      { title: 'zoom', command: 'pane.zoom' },
      '-',
      { title: 'nextTab', command: 'tab.next' },
      { title: 'previousTab', command: 'tab.previous' },
      { title: 'nextWorkspace', command: 'workspace.next' },
      { title: 'previousWorkspace', command: 'workspace.previous' },
      '-',
      { title: 'nextPane', command: 'pane.focusNext' },
      { title: 'previousPane', command: 'pane.focusPrevious' },
      { title: 'focusLeft', command: 'pane.focusLeft' },
      { title: 'focusRight', command: 'pane.focusRight' },
      { title: 'focusUp', command: 'pane.focusUp' },
      { title: 'focusDown', command: 'pane.focusDown' },
    ],
  },
  { title: 'window', items: [{ title: 'minimize', role: 'minimize' }] },
];

/** The menus of a platform: macOS's, or on Windows and Linux File first
 * and Help last. */
export function menusFor(p: Platform): Menu[] {
  if (p === 'darwin') return menus;
  const file: Menu = {
    title: 'file',
    items: [
      { title: 'settings', command: 'app.settings' },
      { title: 'keyboardShortcuts', command: 'app.keyboardShortcuts' },
      '-',
      { title: p === 'win32' ? 'exit' : 'quit', role: 'quit' },
    ],
  };
  return [file, ...menus.slice(1), { title: 'help', items: [{ title: 'about', role: 'about' }] }];
}

/** The Electron accelerator of a single stroke and whether it holds Cmd
 * ("Super+T", "Super+}" for cmd+shift+bracketright, as macOS menus name a
 * shifted key); undefined for chords and invalid keys. */
export function accelerator(key: string): { accelerator: string; cmd: boolean } | undefined {
  let seq: Stroke[];
  try {
    seq = parseKeys(key);
  } catch {
    return;
  }
  if (seq.length !== 1) return;
  const s = seq[0];
  const shifted = s.shift ? shiftedChar(s.key) : undefined;
  const name = shifted === '+' ? 'Plus' : (shifted ?? acceleratorKey(s.key));
  const mods = [s.cmd && 'Super', s.ctrl && 'Control', s.alt && 'Alt', s.shift && !shifted && 'Shift'].filter(Boolean);
  return { accelerator: [...mods, name].join('+'), cmd: s.cmd };
}

/** The menu's template of a platform for the bindings in effect: titles
 * from text (with the application's name for {app}), commands run through
 * run. */
export function menuTemplate(
  bindings: readonly Binding[],
  appName: string,
  text: (key: MessageKey, vars?: Record<string, string>) => string,
  run: (command: string) => MenuItemConstructorOptions['click'],
  platform: Platform,
): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const item = (it: Item): MenuItemConstructorOptions => {
    if (it === '-') return { type: 'separator' };
    const label = text(`desktop.menu.${it.title}`, { app: appName });
    if ('role' in it) return { role: it.role, label, ...(!mac && { registerAccelerator: false }) };
    const key = bindings.map((b) => (b.command === it.command ? accelerator(b.key) : undefined)).find(Boolean);
    return {
      id: it.command,
      label,
      click: run(it.command),
      ...(key && { accelerator: key.accelerator, registerAccelerator: mac && key.cmd }),
    };
  };
  return menusFor(platform).map(({ title, items }) => ({
    label: title === 'app' ? appName : text(`desktop.menu.${title}`),
    submenu: items.map(item),
  }));
}
