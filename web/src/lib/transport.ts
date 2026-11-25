// Channels to the hub that served the page: a WebSocket in a browser; in
// the desktop app, whose hub runs in process and does not listen, a
// channel its shell opens to the hub (DesktopChannels), with the same
// interface. Requests need nothing of this: the app's shell answers its
// origin's fetches itself.
import type { DesktopChannels } from '../shell';
import { installPortSocket, type PortSocketClass } from './portSocket';

const desktopChannels = (globalThis as { desktopChannels?: DesktopChannels }).desktopChannels;

/** Whether the page's requests and channels go through the desktop app's
 * shell rather than the network. */
export const viaDesktop = !!desktopChannels;

let PortSocket: PortSocketClass | undefined;

/** The ws(s) URL of path (with its query) on the page's own host. */
export function wsURL(path: string): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}

/** Opens a channel to the hub at path (with its query). */
export function openChannel(path: string): WebSocket {
  if (desktopChannels) {
    PortSocket ??= installPortSocket(false);
    if (PortSocket) return new PortSocket(wsURL(path));
  }
  return new WebSocket(wsURL(path));
}
