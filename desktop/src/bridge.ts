// The channels between the shell and its main window's page; the page's side
// is DesktopShell in web/src/shell.ts, which the preload implements. The
// last two are every app frame's (frames.ts).

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
  /** page → shell, answered: whether this install can keep a key that
   * unlocks the vault (a boolean). */
  verifyCanUnlock: 'desktop:verify-can-unlock',
  /** page → shell, answered: a session nonce (a string) of a locked vault;
   * {id, relay} of this install's unlock entry, 'none' when this install
   * has none, or null. */
  verifyUnlock: 'desktop:verify-unlock',
  /** page → shell, answered: a register nonce (a string); {mac, relay}
   * with this install's new unlock key, or null. */
  verifyEnroll: 'desktop:verify-enroll',
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
  /** page → shell, answered: whether native OS notifications are supported. */
  notifySupported: 'desktop:notify-supported',
  /** page → shell, answered: shows a native OS notification; returns boolean. */
  notifyShow: 'desktop:notify-show',
  /** page → shell: closes an active native notification by tag. */
  notifyClose: 'desktop:notify-close',
  /** page → shell: sets the OS app/dock badge count (non-negative integer, 0 clears). */
  notifyBadge: 'desktop:notify-badge',
  /** shell → page: target of a clicked native notification (NotificationTarget). */
  notifyClick: 'desktop:notify-click',
  /** page → shell: whether the page takes notification click events. */
  notifyClickWanted: 'desktop:notify-click-wanted',
  /** frame → shell, any frame of the app's origin: a channel to the hub
   * (id, path, WebSocket subprotocols; frames.ts). */
  openChannel: 'desktop:open-channel',
  /** shell → frame: the channel's id, with its MessagePort. */
  channelPort: 'desktop:channel-port',
} as const;
