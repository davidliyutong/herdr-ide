// The application menu, built from the keybindings in effect. An item of a
// command has the command's name (command.<id>, as the command palette, the
// keyboard shortcuts and tooltips name it) and shows the first single-stroke
// key the keybindings give it; chords have none, the page matches them.
// Menus and Electron's own items are titled with desktop.menu.*. The page
// tells the shell which commands cannot run now (menuState), and their
// items are disabled.
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

export type Role =
  | 'about'
  | 'hide'
  | 'hideOthers'
  | 'unhide'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'minimize'
  | 'zoom'
  | 'front'
  | 'togglefullscreen';

/** An item: a command of the keybindings, one Electron implements, or a
 * separator. */
export type Item = { command: string } | { title: Title; role: Role } | '-';

/** A menu; the Window menu is macOS's (it lists the windows). */
export type Menu = { title: Title | 'app'; items: Item[]; role?: 'windowMenu' };

/** The titles of Electron's items whose role names them otherwise. */
const roleTitles: Partial<Record<Role, Title>> = { zoom: 'zoomWindow' };

/** The menus on macOS: the application's (titled with its name), then the
 * others. */
export const menus: Menu[] = [
  {
    title: 'app',
    items: [
      { title: 'about', role: 'about' },
      '-',
      { command: 'app.settings' },
      { command: 'app.keyboardShortcuts' },
      '-',
      { title: 'hide', role: 'hide' },
      { title: 'hideOthers', role: 'hideOthers' },
      { title: 'unhide', role: 'unhide' },
      '-',
      { title: 'quit', role: 'quit' },
    ],
  },
  {
    title: 'shell',
    items: [
      { command: 'tab.new' },
      { command: 'pane.splitRight' },
      { command: 'pane.splitDown' },
      '-',
      { command: 'workspace.new' },
      { command: 'workspace.rename' },
      { command: 'workspace.close' },
      '-',
      { command: 'tab.rename' },
      { command: 'pane.close' },
      { command: 'tab.close' },
      '-',
      { command: 'app.addMachine' },
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
      { command: 'find.open' },
      { command: 'find.next' },
      { command: 'find.previous' },
    ],
  },
  {
    title: 'view',
    items: [
      { command: 'app.commandPalette' },
      { command: 'workspace.switch' },
      { command: 'app.agentAttention' },
      '-',
      { command: 'view.toggleSidebar' },
      { command: 'view.toggleCode' },
      { command: 'pane.zoom' },
      '-',
      { command: 'tab.next' },
      { command: 'tab.previous' },
      { command: 'workspace.next' },
      { command: 'workspace.previous' },
      '-',
      { command: 'pane.focusNext' },
      { command: 'pane.focusPrevious' },
      { command: 'pane.focusLeft' },
      { command: 'pane.focusRight' },
      { command: 'pane.focusUp' },
      { command: 'pane.focusDown' },
      '-',
      { title: 'togglefullscreen', role: 'togglefullscreen' },
    ],
  },
  {
    title: 'window',
    role: 'windowMenu',
    items: [{ title: 'minimize', role: 'minimize' }, { title: 'zoomWindow', role: 'zoom' }, '-', { title: 'front', role: 'front' }],
  },
];

/** The menus of a platform: macOS's, or on Windows and Linux File first
 * and Help last. */
export function menusFor(p: Platform): Menu[] {
  if (p === 'darwin') return menus;
  const file: Menu = {
    title: 'file',
    items: [
      { command: 'app.settings' },
      { command: 'app.keyboardShortcuts' },
      '-',
      { title: p === 'win32' ? 'exit' : 'quit', role: 'quit' },
    ],
  };
  // Zoom and Bring All to Front are macOS's.
  const window: Menu = { title: 'window', items: [{ title: 'minimize', role: 'minimize' }] };
  return [file, ...menus.slice(1, 4), window, { title: 'help', items: [{ title: 'about', role: 'about' }] }];
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

/** The commands of the menu's items. */
export function menuCommands(): string[] {
  return [...new Set(menus.flatMap((m) => m.items.flatMap((it) => (it !== '-' && 'command' in it ? [it.command] : []))))];
}

/** A page's list of commands that cannot run, as the shell takes it: at
 * most 200 command ids, of which those of the menu's items count; undefined
 * for anything else. */
export function parseDisabled(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value) || value.length > 200) return undefined;
  if (!value.every((v) => typeof v === 'string' && /^[a-z]+\.[A-Za-z0-9]+$/.test(v))) return undefined;
  const known = new Set(menuCommands());
  return new Set((value as string[]).filter((v) => known.has(v)));
}

/** The menu's template of a platform for the bindings in effect: titles
 * from text (with the application's name for {app}), commands run through
 * run, the disabled commands' items disabled. */
export function menuTemplate(
  bindings: readonly Binding[],
  appName: string,
  text: (key: MessageKey, vars?: Record<string, string>) => string,
  run: (command: string) => MenuItemConstructorOptions['click'],
  platform: Platform,
  disabled: ReadonlySet<string> = new Set(),
): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const item = (it: Item): MenuItemConstructorOptions => {
    if (it === '-') return { type: 'separator' };
    if ('role' in it)
      return {
        role: it.role,
        label: text(`desktop.menu.${roleTitles[it.role] ?? it.title}`, { app: appName }),
        ...(!mac && { registerAccelerator: false }),
      };
    const key = bindings.map((b) => (b.command === it.command ? accelerator(b.key) : undefined)).find(Boolean);
    return {
      id: it.command,
      label: text(`command.${it.command}` as MessageKey),
      click: run(it.command),
      enabled: !disabled.has(it.command),
      ...(key && { accelerator: key.accelerator, registerAccelerator: mac && key.cmd }),
    };
  };
  return menusFor(platform).map(({ title, items, role }) => ({
    label: title === 'app' ? appName : text(`desktop.menu.${title}`),
    ...(mac && role && { role }),
    submenu: items.map(item),
  }));
}
