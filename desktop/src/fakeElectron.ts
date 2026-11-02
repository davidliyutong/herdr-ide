// A stand-in for the parts of Electron the preload uses, for its test: what
// it exposes to the page, what it sends, and files on disk by their path.

export const exposed: Record<string, unknown> = {};
export const sent: Array<{ channel: string; value: unknown }> = [];

/** Files the stand-in treats as on disk, with their paths. */
export const onDisk = new Map<unknown, string>();

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown) {
    exposed[key] = api;
  },
};

export const ipcRenderer = {
  send(channel: string, value?: unknown) {
    sent.push({ channel, value });
  },
  on() {},
  removeListener() {},
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
