// @vitest-environment jsdom
//
// Which URLs of a terminal's output may be opened (terminal/links.ts
// safeUrl, openLink): absolute http(s) with `//` or mailto, as the browser
// will resolve them, never on the page's own origin (jsdom's
// http://localhost:3000) nor on its port under another name of the
// loopback, which is the same server.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { safeUrl } from '../terminal/links';
import { openLink } from '../terminal/openLink';

describe('safeUrl', () => {
  const cases: [string, boolean][] = [
    ['https://a.example/x', true],
    ['http://a.example', true],
    ['mailto:a@b.example', true],
    ['http://localhost:3001/', true],
    ['http:/api/x', false],
    ['http:x', false],
    ['https:/x', false],
    ['https:x', false],
    ['http://localhost:3000/api/m/x/hc/stop', false],
    ['HTTP://LOCALHOST:3000', false],
    // The page's server under its other names: any loopback host with the
    // page's port, under either scheme.
    ['http://127.0.0.1:3000/api/m/x/hc/stop', false],
    ['http://[::1]:3000/', false],
    ['http://127.0.0.2:3000/', false],
    ['http://127.1:3000/', false],
    ['http://2130706433:3000/', false],
    ['http://app.localhost:3000/', false],
    ['http://[::ffff:127.0.0.1]:3000/', false],
    ['https://localhost:3000/', false],
    ['https://127.0.0.1:3000/', false],
    // Another port is another program, another host another computer.
    ['http://127.0.0.1:3001/', true],
    ['http://127.0.0.1/', true],
    ['http://[::1]:8080/', true],
    ['http://192.168.1.5:3000/', true],
    ['http://a.example:3000/', true],
    ['http://localhost.a.example:3000/', true],
    ['javascript:alert(1)', false],
    ['file:///etc/passwd', false],
    ['//a.example/x', false],
    ['/api/x', false],
    ['', false],
  ];
  it.each(cases)('%j', (url, want) => expect(safeUrl(url)).toBe(want));
});

describe('openLink', () => {
  let open: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    open = vi.spyOn(window, 'open').mockReturnValue(null);
  });
  afterEach(() => open.mockRestore());

  it('opens the URL as the browser will resolve it', () => {
    openLink({ kind: 'url', text: 'HTTPS://A.EXAMPLE' }, { m: 'a' });
    expect(open).toHaveBeenCalledWith('https://a.example/', '_blank', 'noopener,noreferrer');
  });

  it('opens nothing that is relative to the page or on its origin', () => {
    for (const text of [
      'http:/api/x',
      'http:x',
      'https:/x',
      'http://localhost:3000/api/x',
      'http://127.0.0.1:3000/api/x',
      'http://[::1]:3000/api/x',
      'javascript:alert(1)',
    ])
      openLink({ kind: 'url', text }, { m: 'a' });
    expect(open).not.toHaveBeenCalled();
  });
});
