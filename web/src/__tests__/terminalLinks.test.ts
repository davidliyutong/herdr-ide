// @vitest-environment jsdom
//
// Which URLs of a terminal's output may be opened (terminal/links.ts
// safeUrl, openLink): absolute http(s) with `//` or mailto, as the browser
// will resolve them, never on the page's own origin (jsdom's
// http://localhost:3000).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { openLink, safeUrl } from '../terminal/links';

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
    expect(open).toHaveBeenCalledWith('https://a.example/', '_blank', 'noopener');
  });

  it('opens nothing that is relative to the page or on its origin', () => {
    for (const text of ['http:/api/x', 'http:x', 'https:/x', 'http://localhost:3000/api/x', 'javascript:alert(1)'])
      openLink({ kind: 'url', text }, { m: 'a' });
    expect(open).not.toHaveBeenCalled();
  });
});
