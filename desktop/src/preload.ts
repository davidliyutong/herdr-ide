// Preload of the main window (sandboxed, context-isolated). It gives the page
// a narrow bridge and nothing else: the commands of the menu items chosen,
// where a file the user dropped is on disk, which folders were opened with
// the app, (from the page) which commands' menu items to disable, how many
// panes have unsaved changes and its answer when the window closes with
// some (the shell asks it), the addresses the browser panes' webviews open as popups, and on macOS three requests without arguments
// for Full Disk Access. verifyUser takes a nonce to the main process, which
// asks the core what it is for and shows that in the system's prompt.
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

const isWebURL = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};

const isHex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

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
  setDisabledCommands(commands) {
    // Strings only; the shell checks them against its menu's commands.
    if (Array.isArray(commands)) ipcRenderer.send(channels.menuState, commands.filter(isString).slice(0, 200));
  },
  setUnsaved(count) {
    if (Number.isInteger(count) && count >= 0) ipcRenderer.send(channels.unsaved, Math.min(count, 10000));
  },
  onCloseRequest: (fn) =>
    listen(
      channels.closeRequest,
      (v): v is undefined => v === undefined,
      () => fn(),
    ),
  answerClose(answer) {
    if (answer === 'asking' || answer === 'close' || answer === 'stay') ipcRenderer.send(channels.closeAnswer, answer);
  },
  browser: { onOpen: (fn) => listen(channels.browserOpen, isWebURL, fn) },
  verifyUser: {
    async available() {
      try {
        const v: unknown = await ipcRenderer.invoke(channels.verifyAvailable);
        return v === 'touchid' || v === 'hello' ? v : null;
      } catch {
        return null;
      }
    },
    async prove(nonce) {
      // Only a string goes on; the main process checks its form.
      if (typeof nonce !== 'string') return null;
      try {
        const v: unknown = await ipcRenderer.invoke(channels.verifyProve, nonce);
        return isHex(v) ? v : null;
      } catch {
        return null;
      }
    },
  },
};

/** The bridge of a system (process.platform): Full Disk Access is macOS's. */
export function desktopShellFor(platform: string): DesktopShell {
  return {
    ...shell,
    ...(platform === 'darwin' && {
      privacy: {
        openFullDiskAccess: () => ipcRenderer.send(channels.openFullDiskAccess),
        revealTerminalCore: () => ipcRenderer.send(channels.revealTerminalCore),
        relaunch: () => ipcRenderer.send(channels.relaunch),
      },
    }),
  };
}

contextBridge.exposeInMainWorld('desktopShell', desktopShellFor(process.platform));
