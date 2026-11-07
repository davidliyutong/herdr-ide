// The page ↔ shell bridge of the main window. web/src/desktop.ts declares the
// same DesktopShell interface for the page.

export const channels = {
  shortcut: 'desktop:shortcut',
  shortcutsChanged: 'desktop:shortcuts-changed',
  recording: 'desktop:shortcut-recording',
  recorded: 'desktop:shortcut-recorded',
  theme: 'desktop:theme',
  openFolder: 'desktop:open-folder',
  foldersWanted: 'desktop:folders-wanted',
} as const;

export interface DesktopShell {
  /** Calls fn with the action ("new_tab", "close_tab") of each shortcut
   * pressed; returns a function that stops it. */
  onShortcut(fn: (action: string) => void): () => void;
  /** The shortcut settings changed: the shell reads them again. */
  shortcutsChanged(): void;
  /** Starts or stops recording a key: while it records, the shell takes keys
   * with cmd, ctrl or alt (so no menu or shortcut runs) and reports them. */
  recordShortcut(active: boolean): void;
  /** Calls fn with the spec of each key recorded ("cmd+shift+t"); returns a
   * function that stops it. */
  onRecordedKey(fn: (spec: string) => void): () => void;
  /** The theme setting ("system", "dark" or "light"): the window's title
   * bar and native controls follow it. */
  setTheme(theme: string): void;
  /** Where a file the user dropped on the page (or picked) is on disk; empty
   * for anything else. Browsers keep this from pages; the desktop app uses
   * it for folders dropped to create workspaces. */
  pathForFile(file: File): string;
  /** Calls fn with each folder opened with the app (dropped on its Dock
   * icon), also those opened while it started; returns a function that
   * stops it. */
  onOpenFolder(fn: (path: string) => void): () => void;
}
