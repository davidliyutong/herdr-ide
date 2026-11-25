// The app's origin in the app's session (protocol.ts): its requests go to
// the core, every other https request to the network as it would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_HOST, APP_ORIGIN } from './origin';
import { forCore, serveApp, type HandlingSession } from './protocol';

test("only the app's origin is the core's", () => {
  for (const url of [`${APP_ORIGIN}/`, `${APP_ORIGIN}/api/m/local/files?x=1`, `https://${APP_HOST.toUpperCase()}/x`])
    assert.ok(forCore(url), url);
  for (const url of [`http://${APP_HOST}/`, `https://${APP_HOST}:8443/`, `https://x.${APP_HOST}/`, 'https://example.com/', 'nope'])
    assert.equal(forCore(url), false, url);
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
  const toCore: string[] = [];
  serveApp(ses, {
    request: async (req) => {
      toCore.push(req.url);
      return new Response('core');
    },
  });
  assert.equal(await (await handler!(new Request(`${APP_ORIGIN}/index.html`))).text(), 'core');
  assert.equal(await (await handler!(new Request('https://open-vsx.org/api'))).text(), 'network');
  assert.deepEqual(toCore, [`${APP_ORIGIN}/index.html`]);
  assert.deepEqual(passed, [['https://open-vsx.org/api', true]]);
});
