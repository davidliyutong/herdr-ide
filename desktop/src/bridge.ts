// The page ↔ shell bridge of the main window. web/src/desktop.ts declares the
// same DesktopShell interface for the page.

export const channels = {
  shortcut: 'desktop:shortcut',
  shortcutsChanged: 'desktop:shortcuts-changed',
  recording: 'desktop:shortcut-recording',
  recorded: 'desktop:shortcut-recorded',
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
}
