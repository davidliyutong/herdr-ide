// The commands keys can run, with their default keys per platform. Labels
// are not here: the UIs translate command.<id> and command.section.<id>.

/** Where a binding applies: in the main window outside dialogs (terminal;
 * in a VS Code pane too, for the keys VS Code leaves), there except while a
 * terminal has the keyboard (editor: editors, VS Code panes, pane headers
 * and the application's own controls; the key goes to the terminal's
 * program), only while a VS Code pane has the keyboard (vscode), while a
 * dialog of the application is open (dialog), or everywhere (always). */
export const WHENS = ['terminal', 'editor', 'vscode', 'dialog', 'always'] as const;
export type When = (typeof WHENS)[number];

/** Platforms the default bindings differ by: the desktop app on macOS,
 * Windows and Linux, and browsers on each. Browsers keep Cmd+T, Cmd+W and
 * similar keys for themselves, so most direct shortcuts exist only in the
 * desktop app. */
export const PLATFORMS = ['mac', 'windows', 'linux', 'mac-browser', 'windows-browser', 'linux-browser'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Groups commands on the keyboard shortcuts page. */
export interface Section {
  id: string;
  order: number;
}

/** A command's default key, on platforms (empty: all). */
export interface Default {
  key: string;
  platforms: readonly Platform[];
}

/** Something a key can run. */
export interface Command {
  id: string;
  section: string;
  when: When;
  defaults: readonly Default[];
}

/** The keyboard page's sections, in order. */
export const SECTIONS: readonly Section[] = [
  { id: 'app', order: 10 },
  { id: 'workspace', order: 20 },
  { id: 'tab', order: 30 },
  { id: 'pane', order: 40 },
  { id: 'view', order: 50 },
  { id: 'find', order: 60 },
  { id: 'code', order: 70 },
];

const macApp: Platform[] = ['mac'];
const winApp: Platform[] = ['windows'];
const linuxApp: Platform[] = ['linux'];
const winLinuxApp: Platform[] = ['windows', 'linux'];
const macBrowser: Platform[] = ['mac-browser'];
const macAll: Platform[] = ['mac', 'mac-browser'];
const winLinuxAll: Platform[] = ['windows', 'windows-browser', 'linux', 'linux-browser'];

const on = (platforms: readonly Platform[], key: string): Default => ({ key, platforms });

const cmd = (id: string, section: string, ...defaults: Default[]): Command => ({ id, section, when: 'terminal', defaults });

/** A command that does not run while a terminal has the keyboard. */
const editor = (id: string, section: string, ...defaults: Default[]): Command => ({ id, section, when: 'editor', defaults });

/** A command that also runs while a dialog has the keyboard. */
const always = (id: string, section: string, ...defaults: Default[]): Command => ({ id, section, when: 'always', defaults });

/** Every command, with the desktop app's direct shortcuts as defaults: on
 * macOS the Cmd keys of Terminal.app, iTerm, Chrome and VS Code (Cmd+T,
 * Cmd+1…9, Cmd+Option+arrows, Cmd+Shift+Enter…); on Windows and Linux
 * Ctrl+Shift keys (as terminal emulators use, since Ctrl+W and Ctrl+T are
 * keys of shells), Ctrl+Tab and Alt with a digit (as GNOME Terminal,
 * Konsole and Windows Terminal switch tabs), platform-native splits and
 * workspace switches (Alt+Shift++/Alt+Shift+- on Windows Terminal;
 * Ctrl+Shift+D/O and Ctrl+Alt+Up/Down on Linux), Alt+Left/Right for pane
 * history navigation, and Ctrl with +, - or 0 for the zoom. Ctrl+B escapes
 * focus from the active editor or VS Code pane to its pane header on every
 * platform (and returns focus when already there), but is left to the
 * program of a terminal that has the keyboard; no other default is a
 * chord, Ctrl or Alt with a letter alone, or a function key. Browsers get
 * only keys they leave to pages: find, the command palette on macOS (Cmd+K;
 * Cmd+Shift+P opens a private window in Firefox, as Ctrl+Shift+P does
 * elsewhere, where no key is left for it and the status bar opens it), the
 * keyboard shortcuts and Ctrl+B focus escape. A command without a key runs
 * from the menus, the command palette or its button, and the user can bind
 * any key or chord to it. */
export const COMMANDS: readonly Command[] = [
  cmd('app.commandPalette', 'app', on(macApp, 'cmd+shift+p'), on(winLinuxApp, 'ctrl+shift+p'), on(macBrowser, 'cmd+k')),
  cmd('app.keyboardShortcuts', 'app', on(macAll, 'cmd+slash'), on(winLinuxAll, 'ctrl+shift+slash')),
  cmd('app.settings', 'app', on(macApp, 'cmd+comma'), on(winLinuxApp, 'ctrl+comma')),
  cmd('app.agentAttention', 'app', on(macApp, 'cmd+shift+a'), on(winLinuxApp, 'ctrl+shift+a')),
  cmd('app.addMachine', 'app'),
  // The desktop app on macOS: System Settings at Full Disk Access.
  cmd('app.fullDiskAccess', 'app'),

  cmd('workspace.switch', 'workspace', on(macApp, 'cmd+p'), on(winLinuxApp, 'ctrl+shift+k')),
  cmd('workspace.next', 'workspace', on(macApp, 'cmd+ctrl+down'), on(winApp, 'ctrl+shift+pagedown'), on(linuxApp, 'ctrl+alt+down')),
  cmd('workspace.previous', 'workspace', on(macApp, 'cmd+ctrl+up'), on(winApp, 'ctrl+shift+pageup'), on(linuxApp, 'ctrl+alt+up')),
  cmd('workspace.new', 'workspace', on(macApp, 'cmd+n'), on(winLinuxApp, 'ctrl+shift+n')),
  cmd('workspace.edit', 'workspace'),
  cmd('workspace.mute', 'workspace'),
  cmd('workspace.unmute', 'workspace'),
  cmd('workspace.close', 'workspace'),
  // Every other workspace of the machine, asking once as Close Workspace
  // does.
  cmd('workspace.closeOthers', 'workspace'),

  // Browsers' keys on every system: ctrl+t is then no shell's (readline's
  // transpose, fzf's file search) in the desktop app on Windows and Linux.
  cmd('tab.new', 'tab', on(macApp, 'cmd+t'), on(winLinuxApp, 'ctrl+t')),
  cmd('tab.rename', 'tab'),
  cmd(
    'tab.next',
    'tab',
    on(macApp, 'cmd+shift+bracketright'),
    on(macApp, 'ctrl+tab'),
    on(winApp, 'ctrl+tab'),
    on(linuxApp, 'ctrl+tab'),
    on(linuxApp, 'ctrl+pagedown'),
  ),
  cmd(
    'tab.previous',
    'tab',
    on(macApp, 'cmd+shift+bracketleft'),
    on(macApp, 'ctrl+shift+tab'),
    on(winApp, 'ctrl+shift+tab'),
    on(linuxApp, 'ctrl+shift+tab'),
    on(linuxApp, 'ctrl+pageup'),
  ),
  // Cmd+1…8 select a tab and Cmd+9 the last one, as in browsers.
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => cmd(`tab.select${i}`, 'tab', on(macApp, `cmd+${i}`), on(winLinuxApp, `alt+${i}`))),
  cmd('tab.close', 'tab', on(macApp, 'cmd+shift+w'), on(winLinuxApp, 'ctrl+shift+w')),
  // As browsers offer them; at once, with one Undo, as Close Tab.
  cmd('tab.closeOthers', 'tab'),
  cmd('tab.closeRight', 'tab'),
  // Pinned tabs stay first and Close Others and Close to the Right leave
  // them; as VS Code and browsers offer, without a key.
  cmd('tab.pin', 'tab'),
  cmd('tab.unpin', 'tab'),
  cmd('tab.mute', 'tab'),
  cmd('tab.unmute', 'tab'),
  // The browser plugin: a new tab with an empty browser pane on the focused
  // machine, and the focused browser pane's page again.
  cmd('browser.open', 'tab'),
  cmd('browser.reload', 'tab'),
  // The chat plugin: a new tab with a chat with an agent on the focused
  // machine, in the focused pane's directory (a menu of the agents when the
  // machine has more than one). No default: the agents' own keys stay
  // theirs.
  cmd('chat.new', 'tab'),

  cmd('pane.splitRight', 'pane', on(macApp, 'cmd+d'), on(winApp, 'alt+shift+equal'), on(linuxApp, 'ctrl+shift+d')),
  cmd('pane.splitDown', 'pane', on(macApp, 'cmd+shift+d'), on(winApp, 'alt+shift+minus'), on(linuxApp, 'ctrl+shift+o')),
  cmd('pane.close', 'pane', on(macApp, 'cmd+w')),
  cmd('pane.zoom', 'pane', on(macApp, 'cmd+shift+enter'), on(winLinuxApp, 'ctrl+shift+enter')),
  // Switches focus between the active pane (an editor, a VS Code pane) and
  // its header so app shortcuts run without the editor's interception. Not
  // in a terminal, whose programs (tmux) get ctrl+b.
  editor('pane.leave', 'pane', { key: 'ctrl+b', platforms: [] }),
  // Renames the focused terminal's pane in its header. No default: F2 and
  // the like belong to the programs in the terminals.
  cmd('pane.rename', 'pane'),
  // The focused pane's menu (its header's), at its header: every command of
  // the pane from the keyboard.
  cmd('pane.actions', 'pane'),
  cmd('pane.focusLeft', 'pane', on(macApp, 'cmd+alt+left'), on(winLinuxApp, 'alt+shift+left')),
  cmd('pane.focusDown', 'pane', on(macApp, 'cmd+alt+down'), on(winLinuxApp, 'alt+shift+down')),
  cmd('pane.focusUp', 'pane', on(macApp, 'cmd+alt+up'), on(winLinuxApp, 'alt+shift+up')),
  cmd('pane.focusRight', 'pane', on(macApp, 'cmd+alt+right'), on(winLinuxApp, 'alt+shift+right')),
  cmd('pane.focusNext', 'pane'),
  cmd('pane.focusPrevious', 'pane'),
  // Back and forward through the panes focused, with the keys of Safari,
  // Finder and Xcode on macOS and Explorer/VS Code elsewhere.
  cmd('pane.back', 'pane', on(macApp, 'cmd+bracketleft'), on(winLinuxApp, 'alt+left')),
  cmd('pane.forward', 'pane', on(macApp, 'cmd+bracketright'), on(winLinuxApp, 'alt+right')),
  // Brings back what Close Pane or Close Tab closed in the last seconds,
  // with browsers' key for reopening a closed tab.
  cmd('pane.undoClose', 'pane', on(macApp, 'cmd+shift+t'), on(winLinuxApp, 'ctrl+shift+t')),

  cmd('view.toggleSidebar', 'view', on(macApp, 'cmd+b'), on(winLinuxApp, 'ctrl+shift+b')),
  // The right sidebar: the plugins' panels (web/src/plugins), with VS
  // Code's key for its secondary sidebar.
  cmd('view.togglePanel', 'view', on(macApp, 'cmd+alt+b'), on(winLinuxApp, 'alt+shift+b')),
  // The right sidebar's next or previous tool in the rail's order (also
  // Cmd/Alt held with a vertical swipe, web/src/panelSwipe.ts); no keys.
  cmd('view.panel.next', 'view'),
  cmd('view.panel.previous', 'view'),
  // The file explorer's panel, with VS Code's key for its explorer.
  cmd('view.panel.files', 'view', on(macApp, 'cmd+shift+e'), on(winLinuxApp, 'ctrl+shift+e')),
  // The desktop app's zoom (the window.zoom setting), with the keys
  // browsers zoom pages with, which they keep for themselves; also in
  // dialogs and VS Code, as the window's zoom is. Ctrl+= is Zoom In too, as
  // it is in terminal emulators and browsers on Windows and Linux.
  always(
    'view.zoomIn',
    'view',
    on(macApp, 'cmd+shift+equal'),
    on(macApp, 'cmd+equal'),
    on(winLinuxApp, 'ctrl+shift+equal'),
    on(winLinuxApp, 'ctrl+equal'),
  ),
  always('view.zoomOut', 'view', on(macApp, 'cmd+minus'), on(winLinuxApp, 'ctrl+minus')),
  always('view.zoomReset', 'view', on(macApp, 'cmd+0'), on(winLinuxApp, 'ctrl+0')),
  // The variable vault's panel (plugin vault).
  cmd('view.panel.vault', 'view'),
  // The AI usage plugin's panel (web/src/plugins/usage).
  cmd('view.panel.usage', 'view'),
  // The Git plugin's panel, with VS Code's key for its Source Control.
  cmd('view.panel.git', 'view', on(macApp, 'ctrl+shift+g'), on(winLinuxApp, 'ctrl+shift+g')),
  // The System Monitor & Task Manager plugin's panel (web/src/plugins/monitor).
  cmd('view.panel.monitor', 'view'),
  // The Project Search plugin's panel (web/src/plugins/search); as VS
  // Code's search view. Other systems keep Ctrl+Shift+F for Find.
  cmd('view.panel.search', 'view', on(macApp, 'cmd+shift+f')),

  cmd('find.open', 'find', on(macAll, 'cmd+f'), on(winLinuxAll, 'ctrl+shift+f')),
  cmd('find.next', 'find', on(macApp, 'cmd+g')),
  cmd('find.previous', 'find', on(macApp, 'cmd+shift+g')),

  // Inside VS Code its own cmd+j (its panel) runs instead; on a VS Code
  // pane whose header has the keyboard (the bridge extension's ctrl+b) it
  // shows the pane focused before it.
  cmd('code.open', 'code', on(macApp, 'cmd+j'), on(winLinuxApp, 'ctrl+shift+j')),
  cmd('code.diff', 'code'),
  cmd('code.gitGraph', 'code'),
  // The Git plugin's graph pane.
  cmd('git.graph', 'code'),
];
