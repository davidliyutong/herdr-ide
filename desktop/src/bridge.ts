// The channels between the shell and its main window's page; the page's side
// is DesktopShell in web/src/shell.ts, which the preload implements.

export const channels = {
  /** shell → page: the command of a menu item chosen. */
  command: 'desktop:command',
  /** shell → page: folders opened with the app (OpenedFolders). */
  openFolders: 'desktop:open-folders',
  /** page → shell: whether the page takes opened folders. */
  foldersWanted: 'desktop:folders-wanted',
} as const;
