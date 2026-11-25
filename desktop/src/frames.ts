// What each frame of the app's origin gets, in every window of the app
// (the main window's preload and the other windows', frames.ts's entry
// framePreload.ts): the channels to the core (desktopChannels), which
// stand in for WebSockets since the core does not listen, and in VS
// Code's frames a WebSocket that opens one for the page's own host
// (web/src/lib/portSocket.ts). A frame of another origin gets nothing.
// Each channel's MessagePort comes from the main process, which checks the
// frame's origin and hands the other end to the core; the preload passes
// it on to the page as a window message of the page's own origin.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { installPortSocket } from '../../web/src/lib/portSocket';
import { CHANNEL_PORT, type DesktopChannels } from '../../web/src/shell';
import { channels } from './bridge';
import { APP_ORIGIN } from './origin';

/** VS Code's frames: below /m/<machine>/code. */
export const isCodeFrame = (path: string): boolean => /^\/m\/[^/]+\/code(?:\/|$)/.test(path);

/** A channel's id: random, so that the page's other scripts cannot take
 * another's port. */
const channelId = () => crypto.randomUUID().replaceAll('-', '');

export const desktopChannels: DesktopChannels = {
  open(path, protocols) {
    const id = channelId();
    const list = Array.isArray(protocols) ? protocols.slice(0, 16).map(String) : [];
    ipcRenderer.send(channels.openChannel, id, String(path), list);
    return id;
  },
};

/** Sets up a frame at where; false (and nothing) for another origin.
 * where.origin is the document's origin (self.origin), not its URL's: a
 * sandboxed document at a URL of the app's is of an opaque origin. */
export function setUpFrame(where: { origin: string; pathname: string }): boolean {
  if (where.origin !== APP_ORIGIN) return false;
  contextBridge.exposeInMainWorld('desktopChannels', desktopChannels);
  ipcRenderer.on(channels.channelPort, (event: IpcRendererEvent, id: unknown) => {
    const port = (event as { ports?: MessagePort[] }).ports?.[0];
    if (typeof id === 'string' && port) window.postMessage({ [CHANNEL_PORT]: id }, where.origin, [port]);
  });
  if (isCodeFrame(where.pathname)) contextBridge.executeInMainWorld({ func: installPortSocket, args: [true] });
  return true;
}
