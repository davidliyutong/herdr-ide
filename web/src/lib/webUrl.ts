// Which addresses a text of another origin (a document, a program's output)
// may make the page open. Both Markdown links and terminal links pass here.

import { desktopShell } from '../shell';

// Browsers drop tabs, newlines and other controls from a URL before reading
// it (`java\nscript:` is `javascript:`), so the text is read cleaned the
// same way.
const dropped = /[\p{Cc}\p{Cf}\s]/gu;

/** Whether a URL's host name is one of a computer's own loopback, as the
 * hub's guard reads a Host: `localhost` and the names below it, an address
 * of 127.0.0.0/8, `[::1]`, and such an IPv4 address written as an IPv6 one
 * (`[::ffff:7f00:1]`). */
export function isLoopbackName(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(h) ||
    h === '[::1]' ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h)
  );
}

/** The port a URL leads to: its own, else its scheme's. */
const portOf = (u: { port: string; protocol: string }): string => u.port || (u.protocol === 'https:' ? '443' : '80');

/** Where a page is: `location`'s fields that tell. */
export type PageAddress = Pick<Location, 'origin' | 'hostname' | 'port' | 'protocol'>;

/** Whether u leads to the server of the page itself: the page's origin,
 * or, in the desktop app (which intercepts https://<slug>.localhost and
 * listens on no TCP port), that exact host under any scheme and port
 * (matching desktop/src/policy.ts leadsToHub); or, with a browser page on
 * a loopback host, any loopback host with the page's port under either
 * scheme. The CLI hub answers under every name of its computer's loopback
 * (`127.0.0.1` for a page on `localhost`, and the reverse), so the other
 * name is the UI's own routes again, only as another origin. A page on any
 * other host knows nothing of the kind: its `localhost` is the viewer's
 * computer. */
export function isOwnAddress(u: URL, page: PageAddress | undefined = globalThis.location, desktop: boolean = !!desktopShell): boolean {
  if (!page) return false;
  if (u.origin === page.origin) return true;
  if (desktop && page.hostname.toLowerCase().endsWith('.localhost')) {
    return u.hostname.toLowerCase() === page.hostname.toLowerCase();
  }
  return isLoopbackName(page.hostname) && isLoopbackName(u.hostname) && portOf(u) === portOf(page);
}

/** The URL as the browser will resolve it, when it is an absolute `http://`
 * or `https://` URL, or a `mailto:` one; undefined for the rest. `http:/x`
 * and `http:x` are relative references in a browser (they resolve against
 * the page), so only a scheme followed by `//` counts. A URL that leads to
 * the page's own server is refused too (isOwnAddress): a text must not lead
 * to the UI's own routes (`/api/...`), whatever way it spells them or names
 * their host. */
export function safeWebUrl(href: string): string | undefined {
  const clean = href.replace(dropped, '');
  const mail = /^mailto:/i.test(clean);
  if (!mail && !/^https?:\/\//i.test(clean)) return undefined;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  if (mail ? u.protocol !== 'mailto:' : (u.protocol !== 'http:' && u.protocol !== 'https:') || isOwnAddress(u)) return undefined;
  return u.href;
}
