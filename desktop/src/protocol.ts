// The app's origin in the app's session: each request to it goes to the
// hub (hub.ts HubHost.request), which answers it in process; requests
// to other addresses (VS Code's extension gallery, say) go to the network
// as they would without the handler.
//
// What Chromium does for a request over the network it does not do for
// one a handler answers: the handler sees no Origin header (Electron also
// removes an "Origin: null") and no Sec-Fetch-* headers, and any page may
// read the answer, CORS or not, a sandboxed frame's or another site's in a
// VS Code window included. Who asked is the request's initiatorOrigin,
// which Electron sets from the frame that made it and the page cannot
// change ("null" for an opaque origin; none for a request the browser
// started itself, such as the window's first load): the hub gets it as
// the request's Origin, and its guard refuses every origin but the app's.
import { APP_HOST } from './origin';

/** Whether url is of the app's origin. */
export function forHub(url: string): boolean {
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

/** A request as Electron hands it to a protocol handler. */
export type InterceptedRequest = Request & { initiatorOrigin?: string };

/** Intercepts https in ses: the app's origin goes to hub, with the origin
 * of the page that made the request. */
export function serveApp(ses: HandlingSession, hub: { request(req: Request, origin: string | undefined): Promise<Response> }): void {
  ses.protocol.handle('https', (req: InterceptedRequest) =>
    forHub(req.url) ? hub.request(req, req.initiatorOrigin) : ses.fetch(req, { bypassCustomProtocolHandlers: true }),
  );
}
