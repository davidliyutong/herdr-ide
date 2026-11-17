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
  /** macOS only: Full Disk Access, which the user grants in System Settings. */
  privacy?: DesktopPrivacy;
  /** Tells the shell how many panes have unsaved changes: while any has,
   * closing the main window or quitting asks the page (onCloseRequest). */
  setUnsaved(count: number): void;
  /** Calls fn when the main window is about to close while panes have
   * unsaved changes; the page answers with answerClose. Returns a function
   * that stops it. */
  onCloseRequest(fn: () => void): () => void;
  /** The page's answer: it shows the question (at once), the window may
   * close, or it stays. */
  answerClose(answer: 'asking' | 'close' | 'stay'): void;
  /** The system's own prompt (Touch ID, Windows Hello) that stands in for
   * the vault's passphrase. */
  verifyUser?: DesktopVerifyUser;
}

export interface DesktopVerifyUser {
  /** Which prompt the app has, if any. */
  available(): Promise<'touchid' | 'hello' | null>;
  /** Prompts the user for the nonce's purpose; the proof's MAC (hex), or
   * null when the user did not confirm. */
  prove(nonce: string): Promise<string | null>;
}

/** What the shell does for Full Disk Access; nothing is passed. */
export interface DesktopPrivacy {
  /** Opens System Settings at Privacy & Security › Full Disk Access. */
  openFullDiskAccess(): void;
  /** Shows the local terminal core's executable (herdr-core) in Finder, to
   * drag it into that list: the programs of terminals have its access. */
  revealTerminalCore(): void;
  /** Quits the app and opens it again, as macOS applies a grant to the
   * app's processes started afterwards. */
  relaunch(): void;
}

export const desktopShell: DesktopShell | undefined = (globalThis as { desktopShell?: DesktopShell }).desktopShell;
