// Preload of the main window (sandboxed, context-isolated). It gives the page
// a narrow bridge for direct shortcuts and nothing else: the page learns which
// action a shortcut runs, reports that the shortcut settings changed, and
// pauses the shortcuts while the settings dialog records a new key.
import { contextBridge, ipcRenderer } from 'electron';
import { channels, type DesktopShell } from './bridge';

const shell: DesktopShell = {
  onShortcut(fn) {
    ipcRenderer.on(channels.shortcut, (_event, action: unknown) => {
      if (typeof action === 'string') fn(action);
    });
  },
  shortcutsChanged() {
    ipcRenderer.send(channels.shortcutsChanged);
  },
  recordShortcut(active) {
    ipcRenderer.send(channels.recording, !!active);
  },
};

contextBridge.exposeInMainWorld('desktopShell', shell);
