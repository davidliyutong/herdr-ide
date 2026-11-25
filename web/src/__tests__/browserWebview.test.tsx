// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://127.0.0.1:5173/"}
//
// The desktop app's browser pane (a <webview>) when its page does not load:
// a name that did not resolve says so and offers the system's browser,
// whose network may reach it; other failures say what happened.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';

const shell = vi.hoisted(() => ({ current: { browser: { onOpen: () => () => {} } } as undefined | { browser?: object } }));
vi.mock('../shell', () => ({
  get desktopShell() {
    return shell.current;
  },
}));
vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { t } from '../i18n';
import { click, fakeBrowserApi, flush, mountPane, type Harness } from './browserHarness';

let h: Harness | undefined;
afterEach(() => {
  h?.unmount();
  h = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const webview = () => document.querySelector<HTMLElement>('.browser-layer webview');
const failed = () => h!.host.querySelector<HTMLElement>('.browser-failed');
const fire = (name: string, fields: Record<string, unknown>) =>
  act(async () => void webview()!.dispatchEvent(Object.assign(new Event(name), fields)));

describe('a page of the webview that does not load', () => {
  it('says that the name did not resolve, and opens the address in the system’s browser', async () => {
    fakeBrowserApi();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    h = await mountPane({ url: 'https://intranet.example/docs' });
    await flush();
    expect(webview()?.getAttribute('src')).toBe('https://intranet.example/docs');
    expect(webview()?.getAttribute('partition')).toBe('persist:browser');
    expect(failed()).toBeNull();
    await fire('did-fail-load', {
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      validatedURL: 'https://intranet.example/docs',
      isMainFrame: true,
    });
    expect(failed()?.querySelector('span')?.textContent).toBe(t('browser.notResolved', { host: 'intranet.example' }));
    const button = failed()!.querySelector('button')!;
    expect(button.textContent).toBe(t('browser.openSystem'));
    expect(button.title).toBe('https://intranet.example/docs');
    await click(button);
    expect(open).toHaveBeenCalledWith('https://intranet.example/docs', '_blank', 'noopener');
    // A load that works takes the note away.
    await fire('did-navigate', { url: 'https://intranet.example/docs' });
    expect(failed()).toBeNull();
  });

  it('takes the resolver’s own errors for the name not resolving', async () => {
    fakeBrowserApi();
    h = await mountPane({ url: 'https://a.example/' });
    await flush();
    await fire('did-fail-load', { errorCode: -137, errorDescription: 'ERR_NAME_RESOLUTION_FAILED', validatedURL: 'https://a.example/' });
    expect(failed()?.textContent).toContain(t('browser.notResolved', { host: 'a.example' }));
    await fire('did-fail-load', { errorCode: -803, errorDescription: 'ERR_DNS_TIMED_OUT', validatedURL: 'https://b.example/' });
    expect(failed()?.textContent).toContain(t('browser.notResolved', { host: 'b.example' }));
  });

  it('says what happened otherwise, and offers the system’s browser only for a name of another computer', async () => {
    fakeBrowserApi();
    h = await mountPane({ url: 'https://a.example/' });
    await flush();
    await fire('did-fail-load', { errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', validatedURL: 'https://a.example/' });
    expect(failed()?.querySelector('span')?.textContent).toBe(t('browser.loadFailed', { error: 'ERR_CONNECTION_REFUSED' }));
    expect(failed()?.querySelector('button')).toBeNull();
    await fire('did-fail-load', { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'http://app.localhost:3000/' });
    expect(failed()?.textContent).toBe(t('browser.notResolved', { host: 'app.localhost' }));
    expect(failed()?.querySelector('button')).toBeNull();
    h.unmount();
    // A forwarded page fails the same way in any browser of this computer.
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 }, { asked: true });
    await flush();
    expect(webview()?.getAttribute('src')).toBe('http://localhost:3000/');
    await fire('did-fail-load', { errorCode: -324, errorDescription: 'ERR_EMPTY_RESPONSE', validatedURL: 'http://localhost:3000/' });
    expect(failed()?.textContent).toBe(t('browser.loadFailed', { error: 'ERR_EMPTY_RESPONSE' }));
    expect(failed()?.querySelector('button')).toBeNull();
  });

  it('offers nothing outside for an address a text may not open, and ignores frames and cancelled loads', async () => {
    fakeBrowserApi();
    h = await mountPane({ url: 'https://a.example/' });
    await flush();
    await fire('did-fail-load', { errorCode: -3, errorDescription: 'ERR_ABORTED', validatedURL: 'https://a.example/' });
    await fire('did-fail-load', {
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      validatedURL: 'https://ads.example/',
      isMainFrame: false,
    });
    expect(failed()).toBeNull();
    // The hub's own address (the UI is on 127.0.0.1:5173), under another name.
    await fire('did-fail-load', {
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      validatedURL: 'http://localhost:5173/api/x',
    });
    expect(failed()?.textContent).toBe(t('browser.loadFailed', { error: 'ERR_NAME_NOT_RESOLVED' }));
    expect(failed()?.querySelector('button')).toBeNull();
  });
});
