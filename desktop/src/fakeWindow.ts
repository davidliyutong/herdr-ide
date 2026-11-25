// The window a preload's tests run it in, imported before it: a top frame
// of the app's origin, at /, whose messages to itself are
// recorded.
import { APP_ORIGIN } from './origin';

/** What the preload posted to the window: message, target origin, ports. */
export const posted: unknown[][] = [];

const g = globalThis as Record<string, unknown>;
g.location = { origin: APP_ORIGIN, pathname: '/' };
// The document's origin (self.origin), which the preload decides by.
g.self = globalThis;
g.origin = APP_ORIGIN;
g.window = globalThis;
g.top = globalThis;
g.postMessage = (...args: unknown[]) => posted.push(args);
