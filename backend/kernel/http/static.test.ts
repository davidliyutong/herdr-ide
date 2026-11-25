// The web UI's files and the app shell (static.ts), behind the hub's
// guards.
import { describe, expect, test } from 'bun:test';
import { SLUG } from '#shared/lib/brand.ts';
import type { Files } from '../payloads.ts';
import { testHub } from '../testing.ts';
import { appCSP } from './guard.ts';
import { cleanPath, serveUI } from './static.ts';

const files = (m: Record<string, string>): Files => ({
  get: async (p) => (p in m ? new TextEncoder().encode(m[p]) : null),
});
const UI = files({ 'index.html': '<!doctype html>shell', 'assets/app-1.js': 'js', 'icon.svg': '<svg/>' });

function hub(f: Files | null) {
  const t = testHub({ features: [] });
  serveUI(t.hub.http.app, f);
  return t;
}

describe('serveUI', () => {
  test('the shell and its files, with the policy and their caching', async () => {
    const t = hub(UI);
    const index = await t.request('GET', '/');
    expect(await index.text()).toBe('<!doctype html>shell');
    expect(index.headers.get('Content-Type')).toStartWith('text/html');
    expect(index.headers.get('Cache-Control')).toBe('no-cache');
    expect(index.headers.get('Content-Security-Policy')).toBe(appCSP('127.0.0.1:7780', false));

    const asset = await t.request('GET', '/assets/app-1.js');
    expect(await asset.text()).toBe('js');
    expect(asset.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('Content-Security-Policy')).not.toBeNull();
  });

  test('a client-side route gets the shell; an API path no route took does not', async () => {
    const t = hub(UI);
    const route = await t.request('GET', '/m/local/some/view');
    expect([route.status, await route.text(), route.headers.get('Cache-Control')]).toEqual([200, '<!doctype html>shell', 'no-cache']);
    const api = await t.request('GET', '/api/nothing');
    expect([api.status, ((await api.json()) as { error: string }).error]).toEqual([404, 'not_found']);
    // Dot segments cannot reach above the root, or around /api.
    expect(cleanPath('/a/../../x')).toBe('x');
    expect((await t.request('GET', '/x/../api/nothing')).status).toBe(404);
  });

  test("the desktop app's windows frame nothing but the UI's own", async () => {
    const t = hub(UI);
    const res = await t.request('GET', '/', { host: 'localhost:7780', desktop: true });
    expect(res.headers.get('Content-Security-Policy')).toBe(appCSP('localhost:7780', true));
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-src 'self';");
    // A browser's may frame the other loopback name's pages.
    const browser = await t.request('GET', '/', { host: 'localhost:7780' });
    expect(browser.headers.get('Content-Security-Policy')).toContain("frame-src 'self' http://127.0.0.1:*;");
  });

  test('HEAD has the length and no body', async () => {
    const res = await hub(UI).request('HEAD', '/icon.svg');
    expect([res.status, res.headers.get('Content-Length'), await res.text()]).toEqual([200, '6', '']);
  });

  test('a hub without the UI says so', async () => {
    const res = await hub(null).request('GET', '/');
    expect(await res.text()).toBe(`${SLUG}: the web UI is not built into this binary; run scripts/build.sh\n`);
  });

  test('every answer carries the security headers', async () => {
    const res = await hub(UI).request('GET', '/');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });
});
