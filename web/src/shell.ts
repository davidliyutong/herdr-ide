// The desktop app's bridge (desktop/src/preload.ts), present only in its
// main window; in a browser there is none. Kept without imports so any
// module can ask early whether it runs in the desktop app. The preload
// implements this interface.

/** Folders opened with the app (dropped on its Dock icon) in one request,
 * and how many other items came with them. */
export interface OpenedFolders {
  folders: string[];
  skipped: number;
}

export interface DesktopShell {
  /** Calls fn with the command ("tab.new", "pane.close") of each menu item
   * chosen, by a click or by its key when the page left the key to the
   * menu; returns a function that stops it. */
  onCommand(fn: (command: string) => void): () => void;
  /** Where a file the user dropped on the page (or picked) is on disk; empty
   * for anything else. Browsers keep this from pages; the desktop app uses
   * it for folders dropped to create workspaces. */
  pathForFile(file: File): string;
  /** Calls fn with the folders opened with the app (dropped on its Dock
   * icon), also those opened while it started; returns a function that
   * stops it. */
  onOpenFolders(fn: (opened: OpenedFolders) => void): () => void;
  /** Tells the shell which commands cannot run now (no terminal, a dialog
   * open, read-only…): their menu items are disabled. */
  setDisabledCommands(commands: string[]): void;
}

export const desktopShell: DesktopShell | undefined = (globalThis as { desktopShell?: DesktopShell }).desktopShell;
