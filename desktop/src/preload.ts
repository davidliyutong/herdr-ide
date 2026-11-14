// Preload of the main window (sandboxed, context-isolated). It gives the page
// a narrow bridge and nothing else: the commands of the menu items chosen,
// where a file the user dropped is on disk, and which folders were opened
// with the app.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { DesktopShell, OpenedFolders } from '../../web/src/shell';
import { channels } from './bridge';

/** Listens on channel for payloads that pass valid; returns a function that
 * stops it. */
function listen<T>(channel: string, valid: (value: unknown) => value is T, fn: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: unknown) => {
    if (valid(value)) fn(value);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const isString = (v: unknown): v is string => typeof v === 'string';

function isOpened(v: unknown): v is OpenedFolders {
  const o = v as OpenedFolders | null;
  return (
    typeof o === 'object' &&
    o !== null &&
    Array.isArray(o.folders) &&
    o.folders.every(isString) &&
    Number.isInteger(o.skipped) &&
    o.skipped >= 0
  );
}

const shell: DesktopShell = {
  onCommand: (fn) => listen(channels.command, isString, fn),
  pathForFile(file) {
    // Only a File backed by a file on disk has a path; anything else throws.
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  onOpenFolders(fn) {
    const off = listen(channels.openFolders, isOpened, fn);
    ipcRenderer.send(channels.foldersWanted, true);
    return () => {
      off();
      ipcRenderer.send(channels.foldersWanted, false);
    };
  },
};

contextBridge.exposeInMainWorld('desktopShell', shell);
