// @vitest-environment jsdom
//
// The browser plugin's address rules: where a page of a machine's port is
// framed from (never the UI's own host name), and what the address field
// takes.

import { describe, expect, it } from 'vitest';
import { canFrame, forwardedSrc, hostPort, loopbackSrc, meantUrl, otherHost, parseAddress } from '../plugins/browser/api';

describe('the address rule', () => {
  it('frames from the loopback name the UI is not on', () => {
    expect(otherHost('127.0.0.1')).toBe('localhost');
    expect(otherHost('localhost')).toBe('127.0.0.1');
    expect(otherHost('LocalHost')).toBe('127.0.0.1');
    // Any other host: no forwards.
    for (const h of ['example.com', '192.168.1.5', '[::1]', '0.0.0.0', '']) expect(otherHost(h)).toBeUndefined();
  });

  it('puts a forwarded page on the forward’s local port, over http', () => {
    expect(forwardedSrc('http://localhost:3000/docs?a=1#top', 41000, '127.0.0.1')).toBe('http://localhost:41000/docs?a=1#top');
    expect(forwardedSrc('http://localhost:3000/', 3000, 'localhost')).toBe('http://127.0.0.1:3000/');
    expect(forwardedSrc('http://localhost:3000/', 3000, 'example.com')).toBeUndefined();
  });

  it('moves a loopback page of this computer to the other name, keeping its port and scheme', () => {
    expect(loopbackSrc('http://127.0.0.1:8080/x', '127.0.0.1')).toBe('http://localhost:8080/x');
    expect(loopbackSrc('https://localhost/x', 'localhost')).toBe('https://127.0.0.1/x');
    expect(loopbackSrc('http://localhost:8080/', 'example.com')).toBeUndefined();
  });

  it('maps a real address on a forward back to the machine’s port', () => {
    expect(meantUrl('http://localhost:41000/a/b?c#d', 3000, 41000)).toBe('http://localhost:3000/a/b?c#d');
    expect(meantUrl('http://localhost:5000/', 3000, 41000)).toBeUndefined();
    expect(meantUrl('http://example.com:41000/', 3000, 41000)).toBeUndefined();
  });
});

describe('the address field', () => {
  const page = (url: string, loopback: boolean, port: number) => ({ kind: 'page', url, loopback, port });

  it('takes a bare port, with or without a host', () => {
    expect(parseAddress('3000')).toEqual(page('http://localhost:3000/', true, 3000));
    expect(parseAddress(' localhost:3000 ')).toEqual(page('http://localhost:3000/', true, 3000));
    expect(parseAddress('localhost:3000/docs?x=1')).toEqual(page('http://localhost:3000/docs?x=1', true, 3000));
    expect(parseAddress('127.0.0.1:8080')).toEqual(page('http://localhost:8080/', true, 8080));
    expect(parseAddress('[::1]:9000/a')).toEqual(page('http://localhost:9000/a', true, 9000));
    expect(parseAddress('0.0.0.0:5173')).toEqual(page('http://localhost:5173/', true, 5173));
    expect(parseAddress('localhost')).toEqual(page('http://localhost/', true, 80));
  });

  it('gives a host without a scheme http for loopback and https for any other', () => {
    expect(parseAddress('example.com/docs')).toEqual(page('https://example.com/docs', false, 443));
    expect(parseAddress('example.com:8443')).toEqual(page('https://example.com:8443/', false, 8443));
    expect(parseAddress('http://example.com')).toEqual(page('http://example.com/', false, 80));
    expect(parseAddress('https://localhost:3000/x')).toEqual(page('https://localhost:3000/x', true, 3000));
    expect(parseAddress('http://127.0.0.1:3000/x')).toEqual(page('http://localhost:3000/x', true, 3000));
  });

  it('takes nothing for an empty field and refuses other schemes and ports out of range', () => {
    expect(parseAddress('   ')).toEqual({ kind: 'empty' });
    for (const s of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'about:blank',
      'ftp://example.com',
      'mailto:a@b.c',
      'ws://localhost:1',
      '0',
      '70000',
      'a b',
    ]) {
      expect(parseAddress(s), s).toEqual({ kind: 'refused' });
    }
  });

  it('frames loopback addresses only, in a browser', () => {
    expect(canFrame('http://localhost:3000/')).toBe(true);
    expect(canFrame('https://example.com/')).toBe(false);
    expect(canFrame('javascript:1')).toBe(false);
  });

  it('names a page by its host', () => {
    expect(hostPort('http://localhost:3000/x')).toBe('localhost:3000');
  });
});
