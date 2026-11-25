import { expect, test } from 'bun:test';
import { proxyEnv, useEnvProxy } from './proxy.ts';

test("the proxy settings: the user's, lower case first, loopback never proxied", () => {
  expect(proxyEnv({})).toEqual({});
  expect(proxyEnv({ NO_PROXY: 'corp' })).toEqual({});
  expect(proxyEnv({ HTTPS_PROXY: 'http://p:3128', https_proxy: 'http://lower:3128', NO_PROXY: 'corp, .internal' })).toEqual({
    HTTPS_PROXY: 'http://lower:3128',
    NO_PROXY: 'corp,.internal,localhost,.localhost,127.0.0.1,::1',
  });
  expect(proxyEnv({ http_proxy: 'http://p:3128', no_proxy: 'localhost' })).toEqual({
    HTTP_PROXY: 'http://p:3128',
    NO_PROXY: 'localhost,.localhost,127.0.0.1,::1',
  });
});

test('Bun sets nothing: its fetch reads the environment itself', () => {
  expect(useEnvProxy({ HTTPS_PROXY: 'http://127.0.0.1:9' })).toBe(false);
});
