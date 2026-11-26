import { describe, expect, test } from 'bun:test';
import { downloadURLRefusal, redactURLs, shownURL } from './urls.ts';

describe('download URLs', () => {
  test('a URL the machines are given holds no credentials: no user information, query or fragment', () => {
    for (const ok of [
      'https://registry.npmjs.org',
      'http://127.0.0.1:4873/npm/',
      'https://[::1]:8443/r',
      'https://github.com/coder/code-server/releases/download/v{version}/{file}',
    ])
      expect([ok, downloadURLRefusal(ok)]).toEqual([ok, '']);
    for (const [bad, why] of [
      ['https://user:token@mirror/npm', 'user information'],
      ['https://token@mirror/npm', 'user information'],
      ['https://:token@mirror/npm', 'user information'],
      ['https://mirror/npm?access_token=x', 'query'],
      ['https://mirror/npm?', 'query'],
      ['https://mirror/npm#y', 'fragment'],
      ['https://mirror/npm#', 'fragment'],
      ['ftp://mirror/npm', 'http or https'],
      ['file:///srv/npm', 'http or https'],
      ['mirror/npm', 'not a URL'],
      ['', 'not a URL'],
    ])
      expect([bad, downloadURLRefusal(bad)]).toEqual([bad, expect.stringContaining(why)]);
  });

  test('a URL shown in a message or a log is its origin and path only', () => {
    expect(shownURL('https://user:token@mirror:8443/npm/x.tgz?sig=abc#frag')).toBe('https://mirror:8443/npm/x.tgz');
    expect(shownURL('http://127.0.0.1:9/a')).toBe('http://127.0.0.1:9/a');
    // A password with a raw "/" is no URL a parser reads: nothing of it.
    expect(shownURL('https://user:pa/ss@host/p')).toBe('https://…');
    expect(shownURL('not a url')).toBe('…');
    const text = redactURLs(
      'download https://u:secret@h:8/a/b.tgz?token=secret2: exit status 22 (see https://x/y#secret3), and http://ok/z.',
    );
    expect(text).toBe('download https://h:8/a/b.tgz: exit status 22 (see https://x/y), and http://ok/z.');
    expect(redactURLs('curl: (22) The requested URL returned error: 404')).toBe('curl: (22) The requested URL returned error: 404');
    expect(redactURLs('"https://a:b@c/d"')).toBe('"https://c/d"');
  });
});
