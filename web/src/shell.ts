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
  /** macOS only: integrated window title bar geometry and full-screen state so
   * the UI reserves space for the traffic lights in its top header row. */
  titlebar?: DesktopTitlebar;
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
  /** The browser panes' webviews (plugins/browser): present when the shell
   * lets the page show any web address in an Electron <webview>. */
  browser?: DesktopBrowser;
  /** What the app's own processes use now, for the settings' Performance
   * page: Electron's count of each (the window's page, the GPU process, the
   * shell itself, helpers); the core is not among them. */
  metrics?(): Promise<ProcessUsage[]>;
}

/** One process of the desktop app. */
export interface ProcessUsage {
  /** Electron's kind of process: "Browser" (the shell), "Tab" (a page),
   * "GPU", "Utility"… */
  type: string;
  /** A helper's name, when it has one. */
  name: string;
  /** Share of one processor since the last asking, in percent. */
  cpu: number;
  /** Memory in use, in bytes. */
  memory: number;
}

export interface DesktopBrowser {
  /** Calls fn with the address a page in a webview opened in a window of
   * its own (a popup); the page shows it in a new browser tab. Returns a
   * function that stops it. */
  onOpen(fn: (url: string) => void): () => void;
}

/** What the shell answers for a locked vault's unlock: the core's unlock
 * entry it used and the relay, sealed for the core with the key of this
 * launch, which the page only passes on. */
export interface DesktopUnlock {
  id: string;
  relay: string;
}

/** What the shell answers when an authenticator is added: the proof's MAC
 * (hex) and the relay that carries this install's unlock key to the core. */
export interface DesktopEnroll {
  mac: string;
  relay: string;
}

export interface DesktopVerifyUser {
  /** Which prompt the app has, if any. */
  available(): Promise<'touchid' | 'hello' | null>;
  /** Whether this install can keep a key that unlocks the vault (the
   * Secure Enclave with Touch ID, a Windows Hello key). */
  canUnlock(): Promise<boolean>;
  /** Prompts the user for the nonce's purpose; the proof's MAC (hex), or
   * null when the user did not confirm. */
  prove(nonce: string): Promise<string | null>;
  /** For a `session` nonce of a locked vault: prompts, and answers what the
   * page sends the core to unlock (POST session {unlock}); 'none', without
   * a prompt, when this install has no unlock entry (its keys were lost, or
   * the entries are other installs'); null when the user did not confirm. */
  unlock(nonce: string): Promise<DesktopUnlock | 'none' | null>;
  /** For a `register` nonce: prompts, makes this install's unlock key, and
   * answers the MAC and the relay; null when the user did not confirm or
   * the key could not be made. */
  enroll(nonce: string): Promise<DesktopEnroll | null>;
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

/** Integrated window title bar metadata (macOS). */
export interface DesktopTitlebar {
  /** Which platform's integrated chrome the window uses. */
  kind: 'mac';
  /** Unzoomed window points to reserve on the left for the traffic lights. */
  inset: number;
  /** Minimum header row height in unzoomed window points. */
  minHeight: number;
  /** Extra top breathing space in unzoomed window points. */
  topSpace: number;
  /** Calls fn when the window enters or leaves native full screen (and once
   * with the current state on subscribe); returns a function that stops it. */
  onFullScreen(fn: (fullScreen: boolean) => void): () => void;
}

export const desktopShell: DesktopShell | undefined = (globalThis as { desktopShell?: DesktopShell }).desktopShell;
