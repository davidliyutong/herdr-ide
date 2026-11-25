// The app's origin in the app's session: each request to it goes to the
// core (core.ts CoreHost.request), which answers it in process; requests
// to other addresses (VS Code's extension gallery, say) go to the network
// as they would without the handler.
import { APP_HOST } from './origin';

/** Whether url is of the app's origin. */
export function forCore(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.host === APP_HOST;
  } catch {
    return false;
  }
}

/** What the handler uses of a session (Electron's Session). */
export interface HandlingSession {
  protocol: { handle(scheme: string, handler: (req: Request) => Response | Promise<Response>): void };
  fetch(req: Request, init: { bypassCustomProtocolHandlers: boolean }): Promise<Response>;
}

/** Intercepts https in ses: the app's origin goes to core. */
export function serveApp(ses: HandlingSession, core: { request(req: Request): Promise<Response> }): void {
  ses.protocol.handle('https', (req) => (forCore(req.url) ? core.request(req) : ses.fetch(req, { bypassCustomProtocolHandlers: true })));
}
