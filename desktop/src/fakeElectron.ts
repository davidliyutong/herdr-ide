// A stand-in for the parts of Electron the preload uses, for its test: what
// it exposes to the page, what it sends and receives, and files on disk by
// their path.

export const exposed: Record<string, unknown> = {};
export const sent: Array<{ channel: string; value: unknown }> = [];

/** Files the stand-in treats as on disk, with their paths. */
export const onDisk = new Map<unknown, string>();

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown) {
    exposed[key] = api;
  },
};

type Listener = (event: unknown, value: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

/** Delivers value on channel as the main process would. */
export function receive(channel: string, value: unknown) {
  for (const l of listeners.get(channel) ?? []) l({}, value);
}

export const ipcRenderer = {
  send(channel: string, value?: unknown) {
    sent.push({ channel, value });
  },
  on(channel: string, listener: Listener) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(listener);
  },
  removeListener(channel: string, listener: Listener) {
    listeners.get(channel)?.delete(listener);
  },
};

export const webUtils = {
  getPathForFile(file: unknown): string {
    // Electron throws for objects that are not a File, and returns '' for a
    // File made in JavaScript.
    if (!(file instanceof File)) throw new TypeError('not a File');
    return onDisk.get(file) ?? '';
  },
};

export type IpcRendererEvent = unknown;
