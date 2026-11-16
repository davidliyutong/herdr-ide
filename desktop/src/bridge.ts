// The channels between the shell and its main window's page; the page's side
// is DesktopShell in web/src/shell.ts, which the preload implements.

export const channels = {
  /** shell → page: the command of a menu item chosen. */
  command: 'desktop:command',
  /** shell → page: folders opened with the app (OpenedFolders). */
  openFolders: 'desktop:open-folders',
  /** page → shell: whether the page takes opened folders. */
  foldersWanted: 'desktop:folders-wanted',
  /** page → shell: the commands that cannot run now, whose menu items are
   * disabled. */
  menuState: 'desktop:menu-state',
  /** page → shell (macOS): open System Settings at Full Disk Access. */
  openFullDiskAccess: 'desktop:open-full-disk-access',
  /** page → shell (macOS): show the local terminal core's executable in
   * Finder. */
  revealTerminalCore: 'desktop:reveal-terminal-core',
  /** page → shell (macOS): quit and open the app again. */
  relaunch: 'desktop:relaunch',
  /** page → shell: how many panes have unsaved changes (an integer). */
  unsaved: 'desktop:unsaved',
  /** shell → page: the main window is closing while panes have unsaved
   * changes; the page asks the user. */
  closeRequest: 'desktop:close-request',
  /** page → shell: the answer (closeGuard.ts CloseAnswer). */
  closeAnswer: 'desktop:close-answer',
} as const;
