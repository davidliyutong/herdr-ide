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
  /** page → shell, answered: which system prompt proves the user is there
   * ('touchid', 'hello' or null). */
  verifyAvailable: 'desktop:verify-available',
  /** page → shell, answered: a nonce (a string) to prove; the proof's MAC
   * or null. */
  verifyProve: 'desktop:verify-prove',
  /** page → shell, answered: what the app's processes use now
   * (ProcessUsage[] of web/src/shell.ts), for the settings' Performance page. */
  metrics: 'desktop:metrics',
  /** shell → page: the address a page in a browser pane's webview opened in
   * a window of its own (a URL string); the page shows it in a new tab. */
  browserOpen: 'desktop:browser-open',
  /** shell → page (macOS): whether the main window is in native full screen,
   * where macOS hides the traffic lights from the window chrome. */
  fullScreen: 'desktop:full-screen',
  /** page → shell (macOS): asks the shell to send the current full-screen state. */
  fullScreenQuery: 'desktop:full-screen-query',
} as const;
