// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://127.0.0.1:5173/"}
//
// The browser pane with the UI on 127.0.0.1: the forward is made before the
// page loads (on localhost, the other name), failures say what happened and
// retry, Ports opens and stops, and an address that cannot be framed opens
// outside.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { t } from '../i18n';
import { useFrames } from '../plugins/browser/frames';
import { click, fakeBrowserApi, flush, json, mountPane, typeAddress, type Harness } from './browserHarness';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

let h: Harness | undefined;
afterEach(() => {
  h?.unmount();
  h = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const iframe = () => document.querySelector<HTMLIFrameElement>('.browser-layer iframe');
const text = () => h!.host.querySelector('.browser-slot')?.textContent ?? '';

describe('a forwarded page', () => {
  it('makes the forward, then loads the page from the other loopback name on its local port', async () => {
    let answer!: (r: Response) => void;
    const calls = fakeBrowserApi({ forward: () => new Promise<Response>((r) => (answer = r)) });
    h = await mountPane({ url: 'http://localhost:3000/docs', m: 'a', port: 3000 });
    // Nothing loads before the forward is there.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/m/a/p/browser/forwards']);
    expect(calls[0].body).toEqual({ port: 3000 });
    expect(iframe()).toBeNull();
    expect(text()).toBe(t('browser.starting', { machine: 'Box', port: 3000 }));
    await act(async () => answer(json({ m: 'a', port: 3000, local: 41000, created: '', connections: 0 })));
    await flush();
    // The UI is on 127.0.0.1, the page on localhost.
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:41000/docs');
    expect(iframe()?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads');
    expect(iframe()?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe()?.getAttribute('allow')).toBe('clipboard-write');
    // The chip names the machine and both ports, with the notice.
    expect(h.host.querySelector('.browser-chip')?.textContent).toBe(t('browser.chipLocal', { machine: 'Box', port: 3000, local: 41000 }));
    expect(h.host.querySelector('.browser-note')?.textContent).toBe(t('browser.portNotice', { local: 41000, port: 3000 }));
    expect(h.host.querySelector<HTMLInputElement>('.browser-address')!.value).toBe('http://localhost:3000/docs');
  });

  it('shows the machine and port alone when the local port is the same', async () => {
    fakeBrowserApi();
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    await flush();
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:3000/');
    expect(h.host.querySelector('.browser-chip')?.textContent).toBe(t('browser.chip', { machine: 'Box', port: 3000 }));
    expect(h.host.querySelector('.browser-note')).toBeNull();
  });

  const failures: Array<[string, () => Response | Promise<Response>, string]> = [
    ['forward_local_only', () => json({ error: 'forward_local_only', message: 'x' }, 403), t('browser.error.forward_local_only')],
    ['offline', () => json({ error: 'offline', message: 'x' }, 409), t('browser.error.offline', { machine: 'Box' })],
    ['too_many', () => json({ error: 'too_many', message: 'x' }, 400), t('browser.error.too_many')],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch')), t('browser.error.network', { error: 'Failed to fetch' })],
  ];
  for (const [name, answer, message] of failures) {
    it(`says what happened on ${name}, and Retry tries again`, async () => {
      let fail = true;
      const calls = fakeBrowserApi({
        forward: (b) => (fail ? answer() : json({ m: 'a', port: b.port, local: b.port, created: '', connections: 0 })),
      });
      h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
      await flush();
      expect(text()).toContain(message);
      expect(iframe()).toBeNull();
      fail = false;
      const retry = [...h.host.querySelectorAll('button')].find((b) => b.textContent === t('browser.retry'));
      await click(retry);
      await flush();
      expect(calls.filter((c) => c.method === 'POST').length).toBe(2);
      expect(iframe()?.getAttribute('src')).toBe('http://localhost:3000/');
    });
  }

  it('is reloaded by the command, which makes a new element', async () => {
    fakeBrowserApi();
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    await flush();
    const first = iframe();
    const { reloadPage, frameKey } = await import('../plugins/browser/frames');
    await act(async () => reloadPage(frameKey('a', 'p1')));
    expect(iframe()).not.toBe(first);
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:3000/');
  });
});

describe('the address field', () => {
  it('opens a typed port as the machine’s port, and goes back and forward over what was loaded', async () => {
    fakeBrowserApi();
    h = await mountPane({ url: '' });
    // An empty pane: the field has the keyboard and the start page is there.
    expect(h.host.querySelector('.browser-address')?.hasAttribute('data-autofocus')).toBe(true);
    expect(text()).toContain(t('browser.start'));
    await typeAddress(h.host, '3000');
    expect(h.view()).toMatchObject({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:3000/');
    await typeAddress(h.host, 'localhost:4000/x');
    expect(h.view()).toMatchObject({ url: 'http://localhost:4000/x', m: 'a', port: 4000 });
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:4000/x');
    const [back, forward] = h.host.querySelectorAll<HTMLButtonElement>('.browser-bar > button');
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(true);
    await click(back);
    await flush();
    expect(h.view()).toMatchObject({ url: 'http://localhost:3000/', port: 3000 });
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:3000/');
    expect(h.host.querySelector<HTMLInputElement>('.browser-address')!.value).toBe('http://localhost:3000/');
    expect(forward.disabled).toBe(false);
    await click(forward);
    await flush();
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:4000/x');
  });

  it('refuses other schemes and says so', async () => {
    fakeBrowserApi();
    h = await mountPane({ url: '' });
    await typeAddress(h.host, 'javascript:alert(1)');
    expect(h.host.querySelector('.browser-error')?.textContent).toBe(t('browser.refused'));
    expect(h.view().url).toBe('');
    expect(iframe()).toBeNull();
  });

  it('opens an address that cannot be framed outside, and the pane says so', async () => {
    fakeBrowserApi();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    h = await mountPane({ url: '' });
    await typeAddress(h.host, 'example.com/docs');
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener');
    expect(h.view()).toMatchObject({ url: 'https://example.com/docs' });
    expect(iframe()).toBeNull();
    expect(text()).toContain(t('browser.outside'));
    // Open It opens it again, from a click.
    await click([...h.host.querySelectorAll('button')].find((b) => b.textContent === t('browser.outsideOpen')));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('opens the real address outside, from the toolbar', async () => {
    fakeBrowserApi({ forward: (b) => json({ m: 'a', port: b.port, local: 41000, created: '', connections: 0 }) });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    h = await mountPane({ url: 'http://localhost:3000/a', m: 'a', port: 3000 });
    await flush();
    await click(h.host.querySelector(`[aria-label="${t('browser.openOutside')}"]`));
    expect(open).toHaveBeenCalledWith('http://localhost:41000/a', '_blank', 'noopener');
  });
});

describe('Ports', () => {
  const route = {
    listening: () => json({ ports: [{ port: 5173, process: 'node' }, { port: 8080 }] }),
    forwards: () => json({ forwards: [{ m: 'a', port: 3000, local: 41000, created: '', connections: 0 }], available: true }),
  };

  it('lists the machine’s listening ports, which open as its ports', async () => {
    const calls = fakeBrowserApi(route);
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    await flush();
    await click(h.host.querySelector(`[aria-label="${t('browser.ports')}"]`));
    await flush();
    expect(calls.some((c) => c.method === 'GET' && c.url === '/api/m/a/p/browser/listening')).toBe(true);
    const popover = h.host.querySelector('.browser-popover')!;
    const buttons = [...popover.querySelectorAll<HTMLButtonElement>('.browser-port')];
    expect(buttons.map((b) => b.textContent)).toEqual(['5173node', '8080']);
    await click(buttons[0]);
    await flush();
    expect(h.view()).toMatchObject({ url: 'http://localhost:5173/', m: 'a', port: 5173 });
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:5173/');
    expect(h.host.querySelector('.browser-popover')).toBeNull();
  });

  it('lists the forwards and stops one', async () => {
    const calls = fakeBrowserApi(route);
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    await flush();
    await click(h.host.querySelector(`[aria-label="${t('browser.ports')}"]`));
    await flush();
    const popover = h.host.querySelector('.browser-popover')!;
    expect(popover.textContent).toContain(t('browser.forwardLine', { machine: 'Box', port: 3000, local: 41000 }));
    await click(popover.querySelector(`[aria-label="${t('browser.forwardStop', { machine: 'Box', port: 3000 })}"]`));
    await flush();
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/m/a/p/browser/forwards/3000')).toBe(true);
  });

  it('keeps the forward in use while the pane is mounted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const calls = fakeBrowserApi();
      h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
      await act(async () => void (await Promise.resolve()));
      const before = calls.filter((c) => c.method === 'POST').length;
      await act(async () => void vi.advanceTimersByTime(5 * 60_000 + 1));
      expect(calls.filter((c) => c.method === 'POST').length).toBe(before + 1);
      expect(Object.keys(useFrames.getState().pages)).toEqual(['a|p1']);
    } finally {
      vi.useRealTimers();
    }
  });
});
