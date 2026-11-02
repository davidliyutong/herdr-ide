// Preload of the main window (sandboxed, context-isolated). It gives the page
// a narrow bridge for direct shortcuts and the theme, and nothing else: the
// page learns which action a shortcut runs, reports that the shortcut settings
// changed, records a new key through the shell while the settings dialog asks
// for one, and reports its theme setting for the native title bar.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { channels, type DesktopShell } from './bridge';

/** Listens on channel for string payloads; returns a function that stops it. */
function listen(channel: string, fn: (value: string) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: unknown) => {
    if (typeof value === 'string') fn(value);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const shell: DesktopShell = {
  onShortcut: (fn) => listen(channels.shortcut, fn),
  shortcutsChanged() {
    ipcRenderer.send(channels.shortcutsChanged);
  },
  recordShortcut(active) {
    ipcRenderer.send(channels.recording, !!active);
  },
  onRecordedKey: (fn) => listen(channels.recorded, fn),
  setTheme(theme) {
    ipcRenderer.send(channels.theme, theme);
  },
};

contextBridge.exposeInMainWorld('desktopShell', shell);
