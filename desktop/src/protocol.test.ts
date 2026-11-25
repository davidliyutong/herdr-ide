// The app's origin in the app's session (protocol.ts): its requests go to
// the core, every other https request to the network as it would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_HOST, APP_ORIGIN } from './origin';
import { forHub, serveApp, type HandlingSession } from './protocol';

test("only the app's origin is the core's", () => {
  for (const url of [`${APP_ORIGIN}/`, `${APP_ORIGIN}/api/m/local/files?x=1`, `https://${APP_HOST.toUpperCase()}/x`])
    assert.ok(forHub(url), url);
  for (const url of [`http://${APP_HOST}/`, `https://${APP_HOST}:8443/`, `https://x.${APP_HOST}/`, 'https://example.com/', 'nope'])
    assert.equal(forHub(url), false, url);
});

test("the session's https handler: the app's origin to the core, the rest passed through", async () => {
  let handler: ((req: Request) => Response | Promise<Response>) | undefined;
  const passed: Array<[string, boolean]> = [];
  const ses: HandlingSession = {
    protocol: {
      handle(scheme, h) {
        assert.equal(scheme, 'https');
        handler = h;
      },
    },
    fetch: async (req, init) => {
      passed.push([req.url, init.bypassCustomProtocolHandlers]);
      return new Response('network');
    },
  };
  const toHub: Array<[string, string | undefined]> = [];
  serveApp(ses, {
    request: async (req, origin) => {
      toHub.push([req.url, origin]);
      return new Response('core');
    },
  });
  // Who made the request is the initiator Electron reports.
  const made = (url: string, initiatorOrigin?: string) =>
    Object.assign(new Request(url), initiatorOrigin === undefined ? {} : { initiatorOrigin });
  assert.equal(await (await handler!(made(`${APP_ORIGIN}/index.html`))).text(), 'core');
  for (const o of [APP_ORIGIN, 'null', 'https://example.com', 'http://localhost:3000'])
    assert.equal(await (await handler!(made(`${APP_ORIGIN}/api/config`, o))).text(), 'core');
  assert.equal(await (await handler!(made('https://open-vsx.org/api', APP_ORIGIN))).text(), 'network');
  assert.deepEqual(toHub, [
    [`${APP_ORIGIN}/index.html`, undefined],
    [`${APP_ORIGIN}/api/config`, APP_ORIGIN],
    [`${APP_ORIGIN}/api/config`, 'null'],
    [`${APP_ORIGIN}/api/config`, 'https://example.com'],
    [`${APP_ORIGIN}/api/config`, 'http://localhost:3000'],
  ]);
  assert.deepEqual(passed, [['https://open-vsx.org/api', true]]);
});
