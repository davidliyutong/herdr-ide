// Preload of the main window (sandboxed, context-isolated). It gives the page
// a narrow bridge and nothing else: the commands of the menu items chosen,
// where a file the user dropped is on disk, which folders were opened with
// the app, (from the page) which commands' menu items to disable, how many
// panes have unsaved changes and its answer when the window closes with
// some (the shell asks it), the addresses the browser panes' webviews open as popups, and on macOS three requests without arguments
// for Full Disk Access. verifyUser takes a nonce to the main process, which
// asks the core what it is for and shows that in the system's prompt.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { DesktopShell, OpenedFolders, ProcessUsage } from '../../web/src/shell';
import { channels } from './bridge';
import { MAC_TITLEBAR_INSET, MAC_TITLEBAR_MIN_HEIGHT, MAC_TITLEBAR_TOP_SPACE } from './titlebar';

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
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

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

/** A process's usage as the page gets it: text cut short and numbers that are amounts. */
function processUsage(v: unknown): ProcessUsage | undefined {
  const o = v as Partial<ProcessUsage> | null;
  if (typeof o !== 'object' || o === null) return undefined;
  const amount = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);
  const text = (s: unknown) => (typeof s === 'string' ? s.slice(0, 64) : '');
  return text(o.type) ? { type: text(o.type), name: text(o.name), cpu: amount(o.cpu), memory: amount(o.memory) } : undefined;
}

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
  async metrics() {
    try {
      const v: unknown = await ipcRenderer.invoke(channels.metrics);
      return Array.isArray(v) ? v.slice(0, 64).flatMap((p) => processUsage(p) ?? []) : [];
    } catch {
      return [];
    }
  },
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

/** The bridge of a system (process.platform): Full Disk Access and the
 * integrated title bar are macOS's. */
export function desktopShellFor(platform: string): DesktopShell {
  return {
    ...shell,
    ...(platform === 'darwin' && {
      privacy: {
        openFullDiskAccess: () => ipcRenderer.send(channels.openFullDiskAccess),
        revealTerminalCore: () => ipcRenderer.send(channels.revealTerminalCore),
        relaunch: () => ipcRenderer.send(channels.relaunch),
      },
      titlebar: {
        kind: 'mac',
        inset: MAC_TITLEBAR_INSET,
        minHeight: MAC_TITLEBAR_MIN_HEIGHT,
        topSpace: MAC_TITLEBAR_TOP_SPACE,
        onFullScreen(fn) {
          const off = listen(channels.fullScreen, isBoolean, fn);
          ipcRenderer.send(channels.fullScreenQuery);
          return off;
        },
      },
    }),
  };
}

contextBridge.exposeInMainWorld('desktopShell', desktopShellFor(process.platform));
