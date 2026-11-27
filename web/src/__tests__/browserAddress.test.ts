// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://127.0.0.1:5173/"}
//
// The browser plugin's address rules: where a page of a machine's port is
// framed from (never the UI's own host name), and what the address field
// takes: never the hub's own address (the UI is on 127.0.0.1:5173 here).

import { describe, expect, it } from 'vitest';
import { isOwnAddress } from '../lib/webUrl';
import { canFrame, forwardedSrc, hostPort, loopbackSrc, meantUrl, otherHost, parseAddress } from '../plugins/browser/api';

describe('the address rule', () => {
  it('frames from the loopback name the UI is not on, and uses localhost in desktop webviews', () => {
    expect(otherHost('127.0.0.1')).toBe('localhost');
    expect(otherHost('localhost')).toBe('127.0.0.1');
    expect(otherHost('LocalHost')).toBe('127.0.0.1');
    // Any other host in a browser: no forwards.
    for (const h of ['app.localhost', 'example.com', '192.168.1.5', '[::1]', '0.0.0.0', '']) expect(otherHost(h)).toBeUndefined();
    // In the desktop app (<webview> in persist:browser), localhost is always used.
    expect(otherHost('app.localhost', true)).toBe('localhost');
    expect(otherHost('localhost', true)).toBe('localhost');
    expect(forwardedSrc('http://localhost:3000/docs', 41000, 'app.localhost', true)).toBe('http://localhost:41000/docs');
    expect(loopbackSrc('http://127.0.0.1:8080/x', 'app.localhost', true)).toBe('http://localhost:8080/x');
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
    expect(parseAddress('0.0.0.0:5174')).toEqual(page('http://localhost:5174/', true, 5174));
    expect(parseAddress('localhost')).toEqual(page('http://localhost/', true, 80));
  });

  it('gives a host without a scheme http for loopback and https for any other', () => {
    expect(parseAddress('example.com/docs')).toEqual(page('https://example.com/docs', false, 443));
    expect(parseAddress('example.com:8443')).toEqual(page('https://example.com:8443/', false, 8443));
    expect(parseAddress('http://example.com')).toEqual(page('http://example.com/', false, 80));
    expect(parseAddress('https://localhost:3000/x')).toEqual(page('https://localhost:3000/x', true, 3000));
    expect(parseAddress('http://127.0.0.1:3000/x')).toEqual(page('http://localhost:3000/x', true, 3000));
  });

  it('takes a name below localhost as a machine’s loopback, and as written for this computer', () => {
    // Browsers resolve it to the loopback of their own computer: a webview
    // of the desktop app loads it as it is.
    expect(parseAddress('app.localhost:3000/x')).toEqual(page('http://app.localhost:3000/x', false, 3000));
    expect(parseAddress('http://A.Localhost:8080/')).toEqual(page('http://a.localhost:8080/', false, 8080));
    // A remote machine's is that machine's port.
    expect(parseAddress('app.localhost:3000/x', true)).toEqual(page('http://localhost:3000/x', true, 3000));
    expect(parseAddress('https://app.localhost/', true)).toEqual(page('https://localhost/', true, 443));
    expect(parseAddress('app.localhost:5173', true)).toEqual(page('http://localhost:5173/', true, 5173));
    // A name that only ends so is another host.
    expect(parseAddress('notlocalhost:3000', true)).toEqual(page('https://notlocalhost:3000/', false, 3000));
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

  it('refuses the hub’s own address, under any name of the loopback and either scheme', () => {
    for (const s of [
      '5173',
      'localhost:5173',
      '127.0.0.1:5173/api/m/x/hc/stop',
      'http://127.0.0.1:5173/',
      'http://localhost:5173/x',
      'https://localhost:5173/',
      'http://[::1]:5173',
      '[::1]:5173',
      '0.0.0.0:5173',
      'http://127.0.0.2:5173/',
      'http://127.1:5173/',
      'http://2130706433:5173/',
      'http://app.localhost:5173/',
      'http://[::ffff:127.0.0.1]:5173/',
      'HTTP://LOCALHOST:5173',
    ]) {
      expect(parseAddress(s), s).toEqual({ kind: 'refused', own: true });
      expect(canFrame(s), s).toBe(false);
    }
    // Another port is another program's, and another host another computer.
    expect(parseAddress('5174')).toEqual(page('http://localhost:5174/', true, 5174));
    expect(parseAddress('localhost:517')).toEqual(page('http://localhost:517/', true, 517));
    expect(parseAddress('http://example.com:5173/')).toEqual(page('http://example.com:5173/', false, 5173));
    expect(parseAddress('http://192.168.1.5:5173/')).toEqual(page('http://192.168.1.5:5173/', false, 5173));
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

describe('a machine’s own loopback with the hub’s port number', () => {
  // The page is http://127.0.0.1:5173 here: the hub's address in these tests.
  it('is no page of this computer, and is one of a remote machine', () => {
    for (const input of ['5173', 'localhost:5173', 'http://127.0.0.1:5173/x', '0.0.0.0:5173']) {
      expect(parseAddress(input).kind, input).toBe('refused');
      expect(parseAddress(input, true), input).toMatchObject({ kind: 'page', loopback: true, port: 5173 });
    }
    expect(canFrame('http://localhost:5173/')).toBe(false);
    expect(canFrame('http://localhost:5173/', true)).toBe(true);
  });

  it('stays refused under the page’s own origin when the page is not on loopback', () => {
    const own = { origin: 'https://ide.example.com', hostname: 'ide.example.com', port: '', protocol: 'https:' };
    expect(isOwnAddress(new URL('https://ide.example.com/api/x'), own)).toBe(true);
    expect(isOwnAddress(new URL('http://localhost:443/'), own)).toBe(false);
  });

  it('matches only the desktop app’s intercepted .localhost host, not other loopback port-443 services', () => {
    const desktop = { origin: 'https://app.localhost', hostname: 'app.localhost', port: '', protocol: 'https:' };
    for (const own of ['https://app.localhost/', 'http://app.localhost/', 'https://app.localhost:8443/api/x']) {
      expect(isOwnAddress(new URL(own), desktop, true), own).toBe(true);
    }
    for (const other of [
      'https://localhost/',
      'https://127.0.0.1/',
      'http://localhost:443/',
      'http://localhost:3000/',
      'https://other.localhost/',
    ]) {
      expect(isOwnAddress(new URL(other), desktop, true), other).toBe(false);
    }
  });
});
