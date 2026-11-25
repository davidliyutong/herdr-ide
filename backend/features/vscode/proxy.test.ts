// The proxy to code-server: what crosses it (cookies, headers, the port
// proxy), requests and WebSockets through a fake agent's stream to a fake
// code-server, and what makes code-server idle.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { SLUG } from '#shared/lib/brand.ts';
import { sleep, waitFor } from '#kernel/testing.ts';
import { DESKTOP_COOKIE, keepSetCookie, stripDesktopCookie } from './cookies.ts';
import { belowCode, portProxyPath, requestHeaders, responseHeaders } from './proxy.ts';
import { vscodeHub, type VSCodeHub } from './testdata/hub.ts';
import { Activity } from './work.ts';

const PROXY_SECRET = 'X-veldr-Proxy-Secret';

describe('the desktop app cookie', () => {
  // The desktop app's token stays in the core: the cookie that carries it
  // is removed from requests forwarded to code-server, the others kept.
  test('is not forwarded', () => {
    expect(DESKTOP_COOKIE).toBe(`${SLUG}-desktop`);
    expect(stripDesktopCookie(`a=1; ${DESKTOP_COOKIE}=secret; b=2`)).toBe('a=1; b=2');
    // Two Cookie lines the runtime joined.
    expect(stripDesktopCookie(`a=1; ${DESKTOP_COOKIE}=secret; b=2, ${DESKTOP_COOKIE}=again`)).toBe('a=1; b=2');
    expect(stripDesktopCookie(`${DESKTOP_COOKIE}=again, a=1`)).toBe('a=1');
    expect(stripDesktopCookie(`${DESKTOP_COOKIE}=secret`)).toBeNull();
    expect(stripDesktopCookie(` ${DESKTOP_COOKIE} =secret;;`)).toBeNull();
    expect(stripDesktopCookie(null)).toBeNull();
    // A cookie whose name only begins like it stays.
    expect(stripDesktopCookie(`${DESKTOP_COOKIE}-x=1`)).toBe(`${DESKTOP_COOKIE}-x=1`);
  });

  test('is not set by code-server', () => {
    expect(keepSetCookie('vscode-tkn=1; Path=/')).toBe(true);
    expect(keepSetCookie(`${DESKTOP_COOKIE}=planted; Path=/; HttpOnly`)).toBe(false);
    expect(keepSetCookie(` ${DESKTOP_COOKIE} =again`)).toBe(false);
    expect(keepSetCookie(`${DESKTOP_COOKIE}-x=kept`)).toBe(true);
  });
});

test('request headers', () => {
  const headers = new Headers({
    Cookie: `${DESKTOP_COOKIE}=${'t'.repeat(64)}; vscode-tkn=1`,
    [PROXY_SECRET]: 's',
    'X-Forwarded-For': '6.6.6.6',
    'X-Forwarded-Host': 'evil',
    Connection: 'keep-alive, X-Hop',
    'X-Hop': '1',
    'Keep-Alive': '5',
    Origin: 'http://127.0.0.1:7781',
    'Accept-Encoding': 'gzip, br',
    'Sec-WebSocket-Key': 'k',
  });
  const h = requestHeaders({ headers, host: '127.0.0.1:7781', remote: '127.0.0.1', scheme: 'http' });
  expect(h).toEqual({
    host: '127.0.0.1:7781',
    cookie: 'vscode-tkn=1',
    origin: 'http://127.0.0.1:7781',
    'accept-encoding': 'gzip, br',
    'sec-websocket-key': 'k',
    'x-forwarded-for': '127.0.0.1',
    'x-forwarded-host': '127.0.0.1:7781',
    'x-forwarded-proto': 'http',
  });
  // In process (the desktop app's windows, whose answers Chromium does not
  // decode): identity; a WebSocket's own headers are the relay's.
  const d = requestHeaders({ headers, host: 'veldr.localhost', scheme: 'https' }, { websocket: true });
  expect(d['accept-encoding']).toBe('identity');
  expect(d['x-forwarded-for']).toBeUndefined();
  expect(d['x-forwarded-proto']).toBe('https');
  expect(d['sec-websocket-key']).toBeUndefined();
});

// Nor does code-server's answer reach past VS Code's switch: it may not
// widen a service worker's scope (to the UI's pages) nor set the desktop
// app's cookie; its other cookies stay.
test('response headers', () => {
  const h = responseHeaders([
    'Service-Worker-Allowed',
    '/',
    'Set-Cookie',
    'vscode-tkn=1; Path=/',
    'Set-Cookie',
    `${DESKTOP_COOKIE}=planted; Path=/; HttpOnly`,
    'Set-Cookie',
    ` ${DESKTOP_COOKIE} =again`,
    'Set-Cookie',
    `${DESKTOP_COOKIE}-x=kept`,
    'Connection',
    'close, X-Hop',
    'X-Hop',
    '1',
    'Transfer-Encoding',
    'chunked',
    'X-Frame-Options',
    'DENY',
    'Content-Type',
    'text/html',
  ]);
  expect(h.has('Service-Worker-Allowed')).toBe(false);
  expect(h.getSetCookie()).toEqual(['vscode-tkn=1; Path=/', `${DESKTOP_COOKIE}-x=kept`]);
  expect(h.get('X-Frame-Options')).toBe('SAMEORIGIN');
  expect([h.has('Connection'), h.has('X-Hop'), h.has('Transfer-Encoding')]).toEqual([false, false, false]);
  expect(h.get('Content-Type')).toBe('text/html');
});

test('paths', () => {
  for (const p of ['/proxy/5173/', '/proxy/5173', '/PROXY/5173/x', '/absproxy/8888/', '/proxy', '/AbsProxy'])
    expect([p, portProxyPath(p)]).toEqual([p, true]);
  for (const p of ['/proxyish/', '/static/proxy/1', '/', '/absproxyx']) expect([p, portProxyPath(p)]).toEqual([p, false]);
  expect(belowCode('/m/local/code/static/x.js')).toBe('/static/x.js');
  expect(belowCode('/m/local/code/')).toBe('/');
  expect(belowCode('/m/local/code')).toBe('/');
  expect(belowCode('/m/a%2Fb/code/x%20y')).toBe('/x%20y');
  expect(belowCode('/m/local/gui/1')).toBeNull();
});

test('idle tracking', () => {
  let now = 0;
  const a = new Activity(() => now);
  a.touch('m1', 1); // an open VS Code connection
  now = 3600_000;
  expect(a.idleAmong(['m1'], 60_000)).toEqual([]);
  a.touch('m1', -1);
  a.setLast('m1', 0);
  expect(a.idleAmong(['m1'], 60_000)).toEqual(['m1']);
  // A machine without traffic yet gets a grace period.
  expect(a.idleAmong(['m2'], 60_000)).toEqual([]);
  now += 61_000;
  expect(a.idleAmong(['m2'], 60_000)).toEqual(['m2']);
});

/** Waits until code-server is ready on the core's local machine. */
async function ready(vc: VSCodeHub, machine = 'local'): Promise<void> {
  const res = await vc.request('POST', `/api/m/${machine}/code/start`);
  expect(res.status).toBe(202);
  for (let i = 0; i < 400; i++) {
    const s = (await (await vc.request('GET', `/api/m/${machine}/code/status`)).json()) as { ready: boolean; error?: string };
    if (s.ready) return;
    if (s.error) throw new Error(s.error);
    await sleep(5);
  }
  throw new Error('not ready');
}

describe('through a core', () => {
  let vc: VSCodeHub;
  beforeAll(async () => {
    vc = await vscodeHub();
  });
  afterAll(() => vc.stop());
  afterEach(() => void (vc.cs.requests.length = 0));

  // code-server's port proxy would serve any local service of a machine
  // with our origin; it is refused before the machine is even looked up.
  test('the port proxy is refused', async () => {
    for (const path of [
      '/m/nope/code/proxy/5173/',
      '/m/nope/code/proxy/5173',
      '/m/nope/code/PROXY/5173/x',
      '/m/nope/code/absproxy/8888/',
      '/m/nope/code/%70roxy/5173/',
      '/m/nope/code/proxy',
      '/m/nope/code/proxy%2F5173',
      '/m/local/code/proxy/5173/',
    ]) {
      const res = await vc.request('GET', path);
      expect([path, res.status, ((await res.json()) as { error: string }).error]).toEqual([path, 403, 'port_proxy_disabled']);
    }
    expect(vc.audit.records().filter((r) => r.event === 'denied.port_proxy').length).toBe(8);
    // Other code-server paths still reach the machine lookup.
    for (const path of ['/m/nope/code/proxyish/', '/m/nope/code/static/proxy/1']) {
      const res = await vc.request('GET', path);
      expect([path, res.status, ((await res.json()) as { error: string }).error]).toEqual([path, 404, 'unknown']);
    }
    expect(vc.cs.requests).toEqual([]);
  });

  test('the loading page, then code-server', async () => {
    const redirect = await vc.request('GET', '/m/local/code?folder=/srv');
    expect([redirect.status, redirect.headers.get('Location')]).toEqual([302, '/m/local/code/?folder=/srv']);
    const page = await vc.request('GET', '/m/local/code/?folder=/srv');
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain('"/api/m/local/code"');
    expect(vc.audit.records().find((r) => r.event === 'code_server.open')).toMatchObject({
      machine: 'local',
      folder: '/srv',
      client: 'browser',
    });
    // Other requests wait for it.
    const early = await vc.request('GET', '/m/local/code/static/x.js');
    if (early.status !== 200) expect([early.status, ((await early.json()) as { error: string }).error]).toEqual([503, 'starting']);
    await ready(vc);
    const res = await vc.request('GET', '/m/local/code/echo?x=1', {
      headers: { Cookie: `${DESKTOP_COOKIE}=tok; vscode-tkn=1`, [PROXY_SECRET]: 'secret', Origin: 'http://127.0.0.1:7780' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    const got = (await res.json()) as { path: string; headers: Record<string, string> };
    expect(got.path).toBe('/echo?x=1');
    expect(got.headers).toMatchObject({
      host: '127.0.0.1:7780',
      cookie: 'vscode-tkn=1',
      origin: 'http://127.0.0.1:7780',
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': '127.0.0.1:7780',
      'x-forwarded-proto': 'http',
    });
    expect(got.headers['x-veldr-proxy-secret']).toBeUndefined();
  });

  test('answers and bodies', async () => {
    await ready(vc);
    const cookies = await vc.request('GET', '/m/local/code/cookie');
    expect(cookies.headers.getSetCookie()).toEqual(['vscode-tkn=1; Path=/', `${DESKTOP_COOKIE}-x=kept`]);
    expect([cookies.headers.has('Service-Worker-Allowed'), cookies.headers.get('X-Frame-Options')]).toEqual([false, 'SAMEORIGIN']);
    expect(await cookies.text()).toBe('cookies');
    const post = await vc.request('POST', '/m/local/code/echo', { body: 'x'.repeat(3 << 20), headers: { 'Content-Type': 'text/plain' } });
    expect(((await post.json()) as { body: string }).body.length).toBe(3 << 20);
    const big = await vc.request('GET', '/m/local/code/big?n=' + (40 << 20));
    expect((await big.arrayBuffer()).byteLength).toBe(40 << 20);
    const nothing = await vc.request('GET', '/m/local/code/nothing');
    expect([nothing.status, await nothing.text()]).toEqual([304, '']);
    const head = await vc.request('HEAD', '/m/local/code/big?n=10');
    expect([head.status, await head.text()]).toEqual([200, '']);
  });

  // Connections to code-server are kept between requests.
  test('a pool of connections', async () => {
    await ready(vc);
    const before = vc.agents[0].headers.filter((h) => h.op === 'dial-unix').length;
    for (let i = 0; i < 5; i++) expect(await (await vc.request('GET', '/m/local/code/x')).text()).toBe('ok');
    const after = vc.agents[0].headers.filter((h) => h.op === 'dial-unix').length;
    expect(after - before).toBeLessThanOrEqual(1);
    await Promise.all(Array.from({ length: 8 }, () => vc.request('GET', '/m/local/code/x').then((r) => r.text())));
  });

  test('a WebSocket', async () => {
    await ready(vc);
    const ws = await vc.websocket('/m/local/code/stable?reconnectionToken=1', {
      headers: { Origin: 'http://127.0.0.1:7780', Cookie: `${DESKTOP_COOKIE}=t; a=1` },
    });
    expect(ws.res.status).toBe(200);
    const upgrade = vc.cs.requests.find((r) => r.path === '/stable?reconnectionToken=1')!;
    expect(upgrade.headers).toMatchObject({ host: '127.0.0.1:7780', origin: 'http://127.0.0.1:7780', cookie: 'a=1' });
    ws.ch!.send('hello');
    ws.ch!.send(new Uint8Array([1, 2, 3]));
    await waitFor('echoes', () => ws.got.length === 2);
    expect(ws.got[0]).toBe('hello');
    expect([...(ws.got[1] as Uint8Array)]).toEqual([1, 2, 3]);
    // code-server's close reaches the browser.
    ws.ch!.send('close');
    await waitFor('closed', () => ws.closed() !== null);
    expect(ws.closed()).toEqual({ code: 4001, reason: 'asked' });
    // The browser's close reaches code-server.
    const ws2 = await vc.websocket('/m/local/code/stable');
    await waitFor('open', () => vc.cs.sockets.size === 1);
    ws2.ch!.close(1000, 'bye');
    await waitFor('code-server closed', () => vc.cs.sockets.size === 0);
    // A refusal is an upgrade that fails.
    const refused = await vc.websocket('/m/local/code/refuse');
    expect([refused.res.status, ((await refused.res.json()) as { error: string }).error]).toEqual([403, 'refused']);
  });

  test('code-server unreachable', async () => {
    await ready(vc);
    const socket = vc.agent.socket;
    vc.agent.socket = '';
    try {
      // A request that finds no code-server: 502, and the next one prepares
      // it again.
      vc.hub.machines.get('local');
      let res: Response;
      do res = await vc.request('GET', '/m/local/code/x');
      while (res.status === 200);
      expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([502, 'code_server_unavailable']);
      const s = (await (await vc.request('GET', '/api/m/local/code/status')).json()) as { ready: boolean };
      expect(s.ready).toBe(false);
    } finally {
      vc.agent.socket = socket;
    }
  });
});
