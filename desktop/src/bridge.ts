// The page ↔ shell bridge of the main window. web/src/desktop.ts declares the
// same DesktopShell interface for the page.

export const channels = {
  shortcut: 'desktop:shortcut',
  shortcutsChanged: 'desktop:shortcuts-changed',
  recording: 'desktop:shortcut-recording',
} as const;

export interface DesktopShell {
  /** Calls fn with the action ("new_tab", "close_tab") of each shortcut pressed. */
  onShortcut(fn: (action: string) => void): void;
  /** The shortcut settings changed: the shell reads them again. */
  shortcutsChanged(): void;
  /** Pauses the shortcuts while a key is being recorded. */
  recordShortcut(active: boolean): void;
}
