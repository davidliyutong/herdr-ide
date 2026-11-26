import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { SLUG } from '#shared/lib/brand.ts';
import { discard } from '#shared/lib/log.ts';
import { Fail } from '../fail.ts';
import { memoryAudit } from '../testing.ts';
import { Http, jsonBody } from './app.ts';
import { Guard, PROXY_SECRET_HEADER, appCSP, frameSources, hostOnly, type GuardOptions } from './guard.ts';

/** An Http with one route, GET /api/machines, as the Go tests had. */
function testHttp(o: GuardOptions = {}, readOnly = false) {
  const audit = memoryAudit();
  const http = new Http({ guard: new Guard(o), audit: audit.audit, readOnly, logger: discard, machine: () => undefined });
  http.app.get('/api/machines', (c) => c.json([]));
  const request = (
    host: string,
    init: { origin?: string; remote?: string; headers?: Record<string, string>; method?: string; body?: string; path?: string } = {},
  ) => {
    const headers = new Headers(init.headers);
    headers.set('Host', host);
    if (init.origin) headers.set('Origin', init.origin);
    const req = new Request(`http://localhost${init.path ?? '/api/machines'}`, { method: init.method ?? 'GET', headers, body: init.body });
    return Promise.resolve(http.app.fetch(req, { remote: init.remote ?? '192.0.2.1', desktop: false }));
  };
  return { http, audit, request };
}

describe('guard', () => {
  test('Host and Origin', async () => {
    const { request } = testHttp({ allowedOrigins: ['https://ide.example.com', 'http://localhost:5173', 'https://dev.example.com/'] });
    const cases: Array<[string, string, number]> = [
      ['127.0.0.1:7780', '', 200],
      ['localhost:7780', 'http://localhost:7780', 200], // the page the hub served
      ['LocalHost:7780', 'http://localhost:7780', 200],
      ['[::1]:7780', 'http://[::1]:7780', 200],
      ['localhost:8443', 'https://localhost:8443', 200], // behind a TLS proxy on loopback
      // Without a port the scheme tells the port: only the http one is the
      // hub's.
      ['localhost', 'http://localhost', 200],
      ['localhost', 'https://localhost', 403],
      ['[::1]', 'https://[::1]', 403],
      ['[::1]:7780', '', 200],
      ['ide.example.com', 'https://ide.example.com', 200],
      ['dev.example.com', 'http://localhost:5173', 200], // an --allowed-origin on loopback
      ['evil.example.com', '', 403], // DNS rebinding
      ['127.0.0.1:7780', 'https://evil.example', 403], // cross-site
      ['127.0.0.1:7780', 'null', 403],
      ['ide.example.com', 'http://ide.example.com', 403], // scheme must match
      // Another page of the same machine is another site: a development
      // server, a forwarded port, the same port under the other name.
      ['localhost:7780', 'http://localhost:3000', 403],
      ['127.0.0.1:7780', 'http://localhost:7780', 403],
      ['localhost:7780', 'http://127.0.0.1:7780', 403],
      ['localhost:7780', 'http://app.localhost:7780', 403],
      ['localhost:7780', 'ftp://localhost:7780', 403],
      ['ide.example.com', 'http://localhost:7780', 403],
      ['localhost:7780', 'not a url', 403],
    ];
    for (const [host, origin, want] of cases) {
      const res = await request(host, { origin: origin || undefined });
      expect([host, origin, res.status]).toEqual([host, origin, want]);
    }
  });

  // The guard's refusals are plain text naming what is wrong, with the
  // security headers; nothing behind the guard runs.
  test('refusals', async () => {
    const { request } = testHttp();
    let res = await request('evil.example.com');
    expect([res.status, await res.json()]).toEqual([
      403,
      { error: 'host_not_allowed', message: `${SLUG}: host not allowed (add --allowed-origin)` },
    ]);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    res = await request('127.0.0.1:7780', { origin: 'https://evil.example' });
    expect(await res.json()).toMatchObject({ error: 'origin_not_allowed' });
    expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
  });

  test('proxy secret', async () => {
    const secret = '0123456789abcdef-secret';
    const { request, audit } = testHttp({ allowedOrigins: ['https://ide.example.com'], proxySecret: secret });
    const status = async (remote: string, host: string, s = '', extra: Record<string, string> = {}) =>
      (await request(host, { remote, headers: { ...extra, ...(s ? { [PROXY_SECRET_HEADER]: s } : {}) } })).status;
    expect(await status('127.0.0.1:5555', '127.0.0.1:7780')).toBe(200); // a browser on this host
    expect(await status('127.0.0.1', 'localhost:7780')).toBe(200);
    expect(await status('::1', '[::1]:7780')).toBe(200);
    expect(await status('10.0.0.2:5555', 'ide.example.com')).toBe(403);
    expect(await status('10.0.0.2:5555', 'ide.example.com', 'wrong')).toBe(403);
    expect(await status('10.0.0.2:5555', 'ide.example.com', secret)).toBe(200);
    // A proxy on the same host connects from loopback but keeps the public
    // Host, or names the client.
    expect(await status('127.0.0.1:5555', 'ide.example.com')).toBe(403);
    expect(await status('127.0.0.1:5555', '127.0.0.1:7780', '', { 'X-Forwarded-For': '10.0.0.9' })).toBe(403);
    expect(await status('127.0.0.1:5555', '127.0.0.1:7780', secret, { 'X-Forwarded-For': '10.0.0.9' })).toBe(200);
    // In process (no address): not this host's loopback.
    const { http } = testHttp({ proxySecret: secret });
    const req = new Request('http://localhost/api/machines', { headers: { Host: '127.0.0.1:7780' } });
    expect((await http.app.fetch(req, { desktop: true })).status).toBe(403);
    // Refusals for the secret are audited.
    const denied = audit.records().filter((r) => r.event === 'denied.proxy_secret');
    expect(denied.length).toBe(4);
    expect(denied[0]).toMatchObject({ remote: '10.0.0.2:5555', path: '/api/machines' });
  });

  test('hostOnly', () => {
    for (const [i, want] of Object.entries({
      'localhost:7780': 'localhost',
      localhost: 'localhost',
      '[::1]:7780': '::1',
      '[::1]': '::1',
      '::1': '::1',
      'fe80::1': 'fe80::1',
      '127.0.0.1:80': '127.0.0.1',
    }))
      expect([i, hostOnly(i)]).toEqual([i, want]);
  });

  // trustedOrigin vouches for allowed origins and for the hub's own
  // localhost port, asked for from this host under that very Host.
  test('trustedOrigin', () => {
    const g = new Guard({ allowedOrigins: ['https://ide.example.com'] });
    const facts = (host: string, origin: string | null, remote = '127.0.0.1', more: Record<string, string> = {}, method = 'GET') => {
      const headers = new Headers(more);
      if (origin) headers.set('Origin', origin);
      return { method, host, headers, remote };
    };
    expect(g.trustedOrigin(facts('ide.example.com', 'https://IDE.example.com', '10.0.0.1'))).toBe('https://ide.example.com');
    expect(g.trustedOrigin(facts('localhost:7780', 'http://localhost:7780'))).toBe('');
    g.ownLocalhost('7780');
    expect(g.trustedOrigin(facts('localhost:7780', 'http://localhost:7780'))).toBe('http://localhost:7780');
    expect(g.trustedOrigin(facts('localhost:7780', 'http://localhost:7780', '10.0.0.1'))).toBe('');
    expect(g.trustedOrigin(facts('localhost:7781', 'http://localhost:7781'))).toBe('');
    expect(g.trustedOrigin(facts('127.0.0.1:7780', 'http://127.0.0.1:7780'))).toBe('');
    expect(g.trustedOrigin(facts('localhost:7780', 'https://localhost:7780'))).toBe('');
    // A page's own GET carries no Origin: Sec-Fetch-Site vouches for it.
    expect(g.trustedOrigin(facts('localhost:7780', null, '127.0.0.1', { 'Sec-Fetch-Site': 'same-origin' }))).toBe('http://localhost:7780');
    expect(g.trustedOrigin(facts('localhost:7780', null, '127.0.0.1', { 'Sec-Fetch-Site': 'cross-site' }))).toBe('');
    expect(g.trustedOrigin(facts('localhost:7780', null, '127.0.0.1', { 'Sec-Fetch-Site': 'same-origin' }, 'POST'))).toBe('');
    expect(g.trustedOrigin(facts('ide.example.com', null, '10.0.0.1', { 'Sec-Fetch-Site': 'same-origin' }))).toBe(
      'https://ide.example.com',
    );
  });

  // An --allowed-origin that is not an origin is logged and ignored.
  test('invalid allowed origins', () => {
    const logs: string[] = [];
    const g = new Guard({ allowedOrigins: ['not an origin', 'https://ok.example'], logger: (l) => void logs.push(l) });
    expect(logs).toEqual(['ignoring invalid --allowed-origin "not an origin"']);
    expect(g.hostAllowed('ok.example')).toBe(true);
  });
});

describe('CSP', () => {
  // The policy of the UI shell: scripts of its own origin and WebAssembly
  // only, framed by its own pages only.
  test('appCSP', () => {
    for (const host of ['localhost:7780', '127.0.0.1', 'ide.example.com']) {
      for (const desktop of [false, true]) {
        const csp = appCSP(host, desktop);
        expect(csp).toContain("frame-ancestors 'self'");
        expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
        expect(csp).not.toContain("'unsafe-eval'");
        expect(csp).not.toContain("script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'");
        expect(csp).toContain("object-src 'none'");
      }
    }
    expect(appCSP('localhost:7780', false)).toContain("; frame-src 'self' http://127.0.0.1:*; ");
  });

  // The page may frame loopback pages only under the loopback name it is
  // not served from: cookies ignore ports, so a frame under the UI's own
  // name would share the cookies of the UI's host. Any other host frames
  // none, and neither does the desktop app, whose browser panes are
  // webviews.
  test('frames', () => {
    const cases: Array<[string, boolean, string]> = [
      ['localhost:7780', false, "'self' http://127.0.0.1:*"],
      ['localhost', false, "'self' http://127.0.0.1:*"],
      ['LocalHost:7780', false, "'self' http://127.0.0.1:*"],
      ['127.0.0.1:7780', false, "'self' http://localhost:*"],
      ['127.0.0.1', false, "'self' http://localhost:*"],
      // Other names of the loopback, and a reverse proxy's.
      ['[::1]:7780', false, "'self'"],
      ['127.0.0.2:7780', false, "'self'"],
      ['app.localhost:7780', false, "'self'"],
      ['ide.example.com', false, "'self'"],
      // The desktop app's own requests.
      ['127.0.0.1:7780', true, "'self'"],
      ['localhost:7780', true, "'self'"],
    ];
    for (const [host, desktop, want] of cases) {
      const csp = appCSP(host, desktop);
      expect([host, desktop, csp.includes(`; frame-src ${want}; `)]).toEqual([host, desktop, true]);
      // Never the name the page itself is on, nor every loopback page.
      expect(csp).not.toContain('http://localhost:* http://127.0.0.1:*');
      expect(csp).not.toContain(`http://${hostOnly(host).toLowerCase()}:*`);
    }
    expect(frameSources('ide.example.com')).toBe('');
  });
});

describe('answers', () => {
  // A Fail is answered as {error, message} with its status; anything else
  // thrown is a 500 failed; neither is cached.
  test('errors are JSON', async () => {
    const { http, request } = testHttp();
    http.app.get('/fail', () => {
      throw new Fail('nope', 409, 'not now');
    });
    http.app.get('/throw', () => {
      throw new Error('boom');
    });
    let res = await request('localhost', { path: '/fail' });
    expect([res.status, await res.json(), res.headers.get('Cache-Control'), res.headers.get('X-Content-Type-Options')]).toEqual([
      409,
      { error: 'nope', message: 'not now' },
      'no-store',
      'nosniff',
    ]);
    res = await request('localhost', { path: '/throw' });
    expect([res.status, await res.json()]).toEqual([500, { error: 'failed', message: 'boom' }]);
    res = await request('localhost', { path: '/none', method: 'POST' });
    expect([res.status, await res.json()]).toEqual([404, { error: 'not_found', message: 'no route for POST /none' }]);
  });

  // A JSON body is limited, parsed and checked against its schema; what
  // fails is answered with the route's code.
  test('jsonBody', async () => {
    const { http, request } = testHttp();
    http.app.post('/b', jsonBody(z.object({ n: z.number() }), { limit: 16, code: 'invalid' }), (c) => c.json(c.req.valid('json')));
    const post = async (body: string, headers: Record<string, string> = {}) => {
      const res = await request('localhost', { path: '/b', method: 'POST', body, headers });
      return [res.status, ((await res.json()) as { error?: string }).error ?? 'ok'];
    };
    expect(await post('{"n":1}')).toEqual([200, 'ok']);
    expect(await post('{"n":"1"}')).toEqual([400, 'invalid']);
    expect(await post('{')).toEqual([400, 'invalid']);
    expect(await post('')).toEqual([400, 'invalid']);
    expect(await post('{"n":1,"pad":"xxxxxxxxxxxx"}')).toEqual([413, 'too_large']);
    // A Content-Length over the limit is refused before reading.
    expect(await post('{"n":1}', { 'Content-Length': '1000' })).toEqual([413, 'too_large']);
  });

  // Read-only mode refuses writable and mutating routes.
  test('read-only', async () => {
    const { http, request, audit } = testHttp({}, true);
    http.app.post('/w', http.writable, (c) => c.text('w'));
    http.app.post('/m', http.mutating('x.y'), (c) => c.text('m'));
    for (const path of ['/w', '/m']) {
      const res = await request('localhost', { path, method: 'POST' });
      expect([path, res.status, await res.json()]).toEqual([path, 403, { error: 'read_only', message: 'read-only mode' }]);
    }
    expect(audit.lines).toEqual([]);
  });
});
