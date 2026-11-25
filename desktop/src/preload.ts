// Preload of the main window (sandboxed, context-isolated), in each of its
// frames. Every frame of the app's origin gets its channels to the core
// (frames.ts); the top frame's page also gets a narrow bridge and nothing
// else: the commands of the menu items chosen,
// where a file the user dropped is on disk, which folders were opened with
// the app, (from the page) which commands' menu items to disable, how many
// panes have unsaved changes and its answer when the window closes with
// some (the shell asks it), the addresses the browser panes' webviews open as popups, and on macOS three requests without arguments
// for Full Disk Access. verifyUser takes a nonce to the main process, which
// asks the core what it is for and shows that in the system's prompt; for
// the vault's unlock key it answers a relay sealed for the core, which the
// page only passes on.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { DesktopEnroll, DesktopShell, DesktopUnlock, NotificationTarget, OpenedFolders, ProcessUsage } from '../../web/src/shell';
import { channels } from './bridge';
import { setUpFrame } from './frames';
import { parseNotificationOptions, parseNotificationTarget, sanitizeTag } from './notifications';
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
/** A relay: base64url without padding, at most 8 KiB. */
const isRelay = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8192 && /^[A-Za-z0-9_-]+$/.test(v);
/** An unlock entry's id: 16 bytes in base64url. */
const isEntryId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v);

/** An object with exactly these members. */
function shaped(v: unknown, keys: string[]): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const got = Object.keys(v);
  return got.length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}

/** The main process's answer on channel for a string nonce; undefined for
 * anything else or a failure. */
async function ask(channel: string, nonce: unknown): Promise<unknown> {
  // Only a string goes on; the main process checks its form.
  if (typeof nonce !== 'string') return undefined;
  try {
    return await ipcRenderer.invoke(channel, nonce);
  } catch {
    return undefined;
  }
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
  notifications: {
    async supported() {
      try {
        return (await ipcRenderer.invoke(channels.notifySupported)) === true;
      } catch {
        return false;
      }
    },
    async show(opts) {
      const valid = parseNotificationOptions(opts);
      if (!valid) return false;
      try {
        return (await ipcRenderer.invoke(channels.notifyShow, valid)) === true;
      } catch {
        return false;
      }
    },
    close(tag) {
      const valid = sanitizeTag(tag);
      if (valid) ipcRenderer.send(channels.notifyClose, valid);
    },
    onClick(fn) {
      const off = listen(
        channels.notifyClick,
        (v): v is NotificationTarget => parseNotificationTarget(v) !== undefined,
        (t) => {
          const clean = parseNotificationTarget(t);
          if (clean) fn(clean);
        },
      );
      ipcRenderer.send(channels.notifyClickWanted, true);
      return () => {
        off();
        ipcRenderer.send(channels.notifyClickWanted, false);
      };
    },
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
      const v = await ask(channels.verifyProve, nonce);
      return isHex(v) ? v : null;
    },
    async canUnlock() {
      try {
        return (await ipcRenderer.invoke(channels.verifyCanUnlock)) === true;
      } catch {
        return false;
      }
    },
    async unlock(nonce): Promise<DesktopUnlock | 'none' | null> {
      const v = await ask(channels.verifyUnlock, nonce);
      if (v === 'none') return 'none';
      return shaped(v, ['id', 'relay']) && isEntryId(v.id) && isRelay(v.relay) ? { id: v.id, relay: v.relay } : null;
    },
    async enroll(nonce): Promise<DesktopEnroll | null> {
      const v = await ask(channels.verifyEnroll, nonce);
      return shaped(v, ['mac', 'relay']) && isHex(v.mac) && isRelay(v.relay) ? { mac: v.mac, relay: v.relay } : null;
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

// The shell's bridge is the main window's page's, not its frames' (VS
// Code's among them).
if (setUpFrame({ origin: location.origin, pathname: location.pathname }) && window.top === window)
  contextBridge.exposeInMainWorld('desktopShell', desktopShellFor(process.platform));
