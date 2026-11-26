// The app's origin, where its windows' pages are: https, so that they are
// a secure context and code-server's resources and CacheStorage work as on
// a site; under .localhost, which names this computer only. The app's
// session intercepts it (protocol.ts): no request to it leaves the app,
// and nothing listens for it.
import { APP_SLUG } from '../../web/src/brand';

export const APP_HOST = `${APP_SLUG}.localhost`;
export const APP_ORIGIN = `https://${APP_HOST}`;
