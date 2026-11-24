// The guards every request passes (SECURITY.md). The core has no login of
// its own: it trusts whoever reaches it, so it listens on loopback behind an
// authenticating reverse proxy, and these limit the damage of a
// misconfiguration and of hostile web pages:
//
//   - Host/Origin allowlist (DNS rebinding, cross-site WebSocket hijacking);
//   - the proxy's secret header on requests not from this host's loopback;
//   - read-only mode (app.ts);
//   - CSP and framing headers on our pages;
//   - the audit log of security-relevant actions (../audit.ts).
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { NAME } from '#shared/lib/brand.ts';

/** Carries the shared secret from the reverse proxy. */
export const PROXY_SECRET_HEADER = `X-${NAME}-Proxy-Secret`;

/** The host part of a Host header or host:port, without brackets. */
export function hostOnly(hostport: string): string {
  const m = /^\[([^\]]*)\](?::\d*)?$/.exec(hostport);
  if (m) return m[1];
  const i = hostport.lastIndexOf(':');
  // One colon: host:port; more: a bare IPv6 address.
  if (i >= 0 && hostport.indexOf(':') === i) return hostport.slice(0, i);
  return hostport;
}

const hasPort = (hostport: string) => (hostport.startsWith('[') ? /\]:/.test(hostport) : hostport.split(':').length === 2);

function isLoopbackIP(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ip.startsWith('127.');
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '0:0:0:0:0:0:0:1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    return !!mapped && mapped[1].startsWith('127.');
  }
  return false;
}

/** localhost, a name under .localhost, or a loopback address. */
export function isLoopbackHost(h: string): boolean {
  h = h.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || isLoopbackIP(h);
}

/** A connection's remote address is a loopback one. */
export const isLoopbackAddr = (remote: string | undefined): boolean => !!remote && isLoopbackIP(hostOnly(remote));

/** The parts of a request the guards look at. */
export interface RequestFacts {
  method: string;
  /** The Host header. */
  host: string;
  headers: Headers;
  /** The connection's remote address; undefined in process (the desktop
   * app's windows). */
  remote?: string;
}

/** The request comes from a program of the core's own host that talks to
 * the loopback address directly: a loopback peer, a loopback Host, and no
 * proxy in between (a proxy on the same host keeps the public Host or adds
 * X-Forwarded-For). */
export function sameHost(r: RequestFacts): boolean {
  return isLoopbackAddr(r.remote) && isLoopbackHost(hostOnly(r.host)) && !r.headers.get('X-Forwarded-For');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const parseOrigin = (o: string): URL | null => {
  try {
    const u = new URL(o);
    return u.host ? u : null;
  } catch {
    return null;
  }
};

/** scheme://host[:port] in lower case, as browsers write an origin. */
const originKey = (u: URL) => `${u.protocol}//${u.host}`.toLowerCase();

export interface GuardOptions {
  /** Extra browser origins (scheme://host[:port]) allowed to use the API:
   * the reverse proxy's public origin, the desktop app's. */
  allowedOrigins?: readonly string[];
  /** When set, the reverse proxy sends it in PROXY_SECRET_HEADER on
   * requests that do not come from this host's loopback. */
  proxySecret?: string;
  /** Logs an --allowed-origin that is not an origin. */
  logger?: (line: string) => void;
}

/** The Host/Origin rules of one core. */
export class Guard {
  private readonly origins = new Set<string>();
  private readonly hosts = new Set<string>();
  private readonly secret: string;
  /** The port the core holds on both loopback addresses (ownLocalhost). */
  private localhostPort = '';

  constructor(o: GuardOptions = {}) {
    this.secret = o.proxySecret ?? '';
    for (const raw of o.allowedOrigins ?? []) {
      const u = parseOrigin(raw.replace(/\/+$/, ''));
      if (!u) {
        o.logger?.(`ignoring invalid --allowed-origin ${JSON.stringify(raw)}`);
        continue;
      }
      this.origins.add(originKey(u));
      this.hosts.add(u.hostname.replace(/^\[|\]$/g, '').toLowerCase());
    }
  }

  /** Tells the guard that the core listens on port on both loopback
   * addresses (127.0.0.1 and ::1), so that http://localhost:<port> leads to
   * it whichever a browser tries (trustedOrigin). */
  ownLocalhost(port: string): void {
    this.localhostPort = port;
  }

  /** The request carries the proxy secret, or needs none: a browser on
   * this host talking to the loopback address directly. */
  proxySecretOK(r: RequestFacts): boolean {
    if (!this.secret || sameHost(r)) return true;
    return safeEqual(r.headers.get(PROXY_SECRET_HEADER) ?? '', this.secret);
  }

  /** The Host is a loopback name or an allowed origin's. */
  hostAllowed(host: string): boolean {
    const h = hostOnly(host).toLowerCase();
    return isLoopbackHost(h) || this.hosts.has(h);
  }

  /** Whether a request for host (its Host header) may carry origin: an
   * allowed origin, or the request's own origin on loopback, which is the
   * page the core served. Another page of the same machine (a development
   * server, a forwarded port, any program on another loopback port) is
   * another site: its scripts open WebSockets with their own Origin, and
   * the core has no login to stop them. The scheme of a loopback origin is
   * not compared: the core serves no TLS, so behind a proxy on loopback
   * that does, the page's is https and the request's is not. Without a
   * port in the Host the scheme tells http://localhost (port 80) from
   * https://localhost (443), so there the origin must be the http one; a
   * TLS proxy on the default port names its origin with --allowed-origin. */
  originAllowed(origin: string, host: string): boolean {
    if (origin === 'null') return false;
    const u = parseOrigin(origin);
    if (!u) return false;
    if (this.origins.has(originKey(u))) return true;
    if (!isLoopbackHost(u.hostname.replace(/^\[|\]$/g, '')) || u.host.toLowerCase() !== host.toLowerCase()) return false;
    if (!hasPort(host)) return u.protocol === 'http:';
    return u.protocol === 'http:' || u.protocol === 'https:';
  }

  /** The request's Origin when no other program can serve a page of that
   * origin: an allowed origin, which the operator names, or the core's own
   * under the name localhost: its port, held on both loopback addresses,
   * asked for under that very Host from this host. "" otherwise. What a
   * browser binds to an origin (a WebAuthn credential) is taken only for
   * such an origin.
   *
   * A browser sends no Origin with a page's own GETs: there the page says
   * that the request is its own (Sec-Fetch-Site: same-origin) and the
   * origin is the request's Host, under the scheme that makes it one the
   * core vouches for. */
  trustedOrigin(r: RequestFacts): string {
    const origin = r.headers.get('Origin');
    if (!origin) {
      if ((r.method !== 'GET' && r.method !== 'HEAD') || r.headers.get('Sec-Fetch-Site') !== 'same-origin') return '';
      for (const scheme of ['http', 'https']) {
        const got = this.trustedOriginOf(r, `${scheme}://${r.host}`);
        if (got) return got;
      }
      return '';
    }
    return this.trustedOriginOf(r, origin);
  }

  private trustedOriginOf(r: RequestFacts, origin: string): string {
    const u = parseOrigin(origin);
    if (!u) return '';
    const norm = originKey(u);
    if (this.origins.has(norm)) return norm;
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (
      this.localhostPort &&
      u.protocol === 'http:' &&
      u.hostname.toLowerCase() === 'localhost' &&
      port === this.localhostPort &&
      u.host.toLowerCase() === r.host.toLowerCase() &&
      sameHost(r)
    )
      return norm;
    return '';
  }

  /** Why the guard refuses a request, or null when it passes. */
  check(r: RequestFacts): 'proxy_secret' | 'host' | 'origin' | null {
    if (!this.proxySecretOK(r)) return 'proxy_secret';
    if (!this.hostAllowed(r.host)) return 'host';
    const origin = r.headers.get('Origin');
    // Same-origin GETs of static assets never carry a foreign Origin;
    // anything that does is refused.
    if (origin && !this.originAllowed(origin, r.host)) return 'origin';
    return null;
  }
}

/** Headers of every answer. Same-origin requests keep their Origin (a POST
 * under no-referrer would carry "Origin: null", which the guard refuses);
 * other sites get no referrer. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** What a page served under host may frame beside itself: the http pages
 * of the other loopback name than its own, under any port. Cookies ignore
 * ports, so a frame under the UI's own name would share the cookies of the
 * UI's host: the policy names the other name only, as the page does when
 * it loads one (otherHost in web/src/plugins/browser/api.ts). Any other
 * host (a reverse proxy's name, [::1]) frames no loopback page: its
 * localhost is not known to be the core's. */
export function frameSources(host: string): string {
  switch (hostOnly(host).toLowerCase()) {
    case 'localhost':
      return ' http://127.0.0.1:*';
    case '127.0.0.1':
      return ' http://localhost:*';
  }
  return '';
}

/** The policy of the UI shell. 'unsafe-inline' styles are needed by React
 * inline styles; scripts come only from our origin. 'wasm-unsafe-eval'
 * lets the page compile WebAssembly (the terminal emulator); it does not
 * allow eval or inline scripts. Frames are the UI's own (VS Code's
 * windows) and, for the browser pane in a browser, frameSources; the
 * desktop app shows its browser panes in webviews, which this policy does
 * not govern. */
export function appCSP(host: string, desktop: boolean): string {
  const frames = "'self'" + (desktop ? '' : frameSources(host));
  return (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; " +
    `frame-src ${frames}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'`
  );
}
