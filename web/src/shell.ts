// The desktop app's bridge (desktop/src/preload.ts), present only in its
// main window; in a browser there is none. Kept without imports so any
// module can ask early whether it runs in the desktop app.

/** Same interface as desktop/src/bridge.ts. */
export interface DesktopShell {
  /** Calls fn with the command of each direct shortcut the shell took. */
  onShortcut(fn: (command: string) => void): () => void;
  /** The keybindings changed: the shell reads them again. */
  shortcutsChanged(): void;
  recordShortcut(active: boolean): void;
  onRecordedKey(fn: (stroke: string) => void): () => void;
  setTheme(theme: string): void;
  pathForFile(file: File): string;
  onOpenFolder(fn: (path: string) => void): () => void;
}

export const desktopShell: DesktopShell | undefined = (globalThis as { desktopShell?: DesktopShell }).desktopShell;
