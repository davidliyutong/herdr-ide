// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://127.0.0.1:5173/"}
//
// The browser pane with the UI on 127.0.0.1: the forward is made before the
// page loads (on localhost, the other name), failures say what happened and
// retry, Ports opens and stops, and an address that cannot be framed opens
// outside. A forward is made only for a port the user asked for in this
// page: a view found in the layout uses the forward that exists, or asks.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { t } from '../i18n';
import { useFrames } from '../plugins/browser/frames';
import type { MachineState } from '../lib/machine';
import { forwardGranted } from '../plugins/browser/api';
import { useStore } from '../state/store';
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
const button = (label: string) => [...h!.host.querySelectorAll('button')].find((b) => b.textContent === label);
const requests = (calls: { method: string; url: string }[]) => calls.map((c) => `${c.method} ${c.url}`);
const forwardOf = (port: number, local = port) => ({ m: 'a', port, local, created: '', connections: 0 });

describe('a forwarded page', () => {
  it('makes the forward, then loads the page from the other loopback name on its local port', async () => {
    let answer!: (r: Response) => void;
    const calls = fakeBrowserApi({ forward: () => new Promise<Response>((r) => (answer = r)) });
    h = await mountPane({ url: 'http://localhost:3000/docs', m: 'a', port: 3000 }, { asked: true });
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
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 }, { asked: true });
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
      h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 }, { asked: true });
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
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 }, { asked: true });
    await flush();
    const first = iframe();
    const { reloadPage, frameKey } = await import('../plugins/browser/frames');
    await act(async () => reloadPage(frameKey('a', 'p1')));
    expect(iframe()).not.toBe(first);
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:3000/');
  });
});

describe('a view found in the layout', () => {
  // Any client, and any script of the page, writes the layout: a view of
  // it is not the user asking for a way into the machine.
  it('makes no forward: the pane asks, and makes it when the user says so', async () => {
    const calls = fakeBrowserApi();
    h = await mountPane({ url: 'http://localhost:3000/docs', m: 'a', port: 3000 });
    await flush();
    expect(requests(calls)).toEqual(['GET /api/p/browser/forwards']);
    expect(iframe()).toBeNull();
    expect(h.host.querySelector('[data-testid="browser-ask"]')).not.toBeNull();
    expect(text()).toBe(t('browser.ask', { machine: 'Box', port: 3000 }) + t('browser.askForward'));
    expect(forwardGranted('a', 3000)).toBe(false);
    // Reload and Retry are not the user asking for the forward either.
    const { reloadPage, frameKey } = await import('../plugins/browser/frames');
    await act(async () => reloadPage(frameKey('a', 'p1')));
    await flush();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(iframe()).toBeNull();
    await click(button(t('browser.askForward')));
    await flush();
    expect(forwardGranted('a', 3000)).toBe(true);
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([['/api/m/a/p/browser/forwards', { port: 3000 }]]);
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:3000/docs');
    expect(h.host.querySelector('[data-testid="browser-ask"]')).toBeNull();
  });

  it('uses the forward that exists, without asking', async () => {
    const calls = fakeBrowserApi({
      forwards: () => json({ forwards: [forwardOf(4000), forwardOf(3000, 41000)], available: true }),
      forward: (b) => json(forwardOf(b.port, 41000)),
    });
    h = await mountPane({ url: 'http://localhost:3000/docs', m: 'a', port: 3000 });
    await flush();
    // The list first, then the request that uses the forward.
    expect(requests(calls)).toEqual(['GET /api/p/browser/forwards', 'POST /api/m/a/p/browser/forwards']);
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:41000/docs');
    expect(h.host.querySelector('[data-testid="browser-ask"]')).toBeNull();
    // Using it is not asking for it: once it ended, the pane would ask.
    expect(forwardGranted('a', 3000)).toBe(false);
  });

  it('asks when the list has the port of another machine only, or another port', async () => {
    const calls = fakeBrowserApi({
      forwards: () => json({ forwards: [{ ...forwardOf(3000), m: 'b' }, forwardOf(3001)], available: true }),
    });
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    await flush();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(h.host.querySelector('[data-testid="browser-ask"]')).not.toBeNull();
  });

  it('makes no request for a port of another machine than its layout’s', async () => {
    const calls = fakeBrowserApi({ forwards: () => json({ forwards: [{ ...forwardOf(3000), m: 'b' }], available: true }) });
    h = await mountPane({ url: 'http://localhost:3000/', m: 'b', port: 3000 }, { asked: true });
    await flush();
    expect(calls).toEqual([]);
    expect(iframe()).toBeNull();
    expect(text()).toBe(t('browser.error.other_machine'));
    // Nothing to retry, and nothing to confirm.
    expect(button(t('browser.retry'))).toBeUndefined();
    expect(button(t('browser.askForward'))).toBeUndefined();
    const { reloadPage, frameKey } = await import('../plugins/browser/frames');
    await act(async () => reloadPage(frameKey('a', 'p1')));
    await flush();
    expect(calls).toEqual([]);
  });

  it('says what happened when the list cannot be read, and Retry reads it again', async () => {
    let fail = true;
    const calls = fakeBrowserApi({
      forwards: () => {
        if (fail) throw new TypeError('Failed to fetch');
        return json({ forwards: [forwardOf(3000)], available: true });
      },
    });
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    await flush();
    expect(text()).toContain(t('browser.error.network', { error: 'Failed to fetch' }));
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(iframe()).toBeNull();
    fail = false;
    await click(button(t('browser.retry')));
    await flush();
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:3000/');
  });

  it('does not offer a forward to a client that can use none', async () => {
    const calls = fakeBrowserApi({ forwards: () => json({ forwards: [forwardOf(3000)], available: false }) });
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    await flush();
    expect(text()).toContain(t('browser.error.forward_local_only'));
    expect(button(t('browser.askForward'))).toBeUndefined();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('is kept in use while its forward exists, and asks once the forward ended', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let exists = true;
      const calls = fakeBrowserApi({ forwards: () => json({ forwards: exists ? [forwardOf(3000)] : [], available: true }) });
      h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
      await flush();
      expect(iframe()?.getAttribute('src')).toBe('http://localhost:3000/');
      const posts = () => calls.filter((c) => c.method === 'POST').length;
      expect(posts()).toBe(1);
      // While it exists, the list says so and the forward is used again.
      await act(async () => void vi.advanceTimersByTime(5 * 60_000 + 1));
      await flush();
      expect(posts()).toBe(2);
      expect(iframe()).not.toBeNull();
      // It ended (idle, stopped, the hub restarted): nothing brings it
      // back but the user.
      exists = false;
      await act(async () => void vi.advanceTimersByTime(5 * 60_000 + 1));
      await flush();
      await flush();
      expect(posts()).toBe(2);
      expect(iframe()).toBeNull();
      expect(useFrames.getState().pages).toEqual({});
      expect(h.host.querySelector('[data-testid="browser-ask"]')).not.toBeNull();
      await act(async () => void vi.advanceTimersByTime(15 * 60_000));
      await flush();
      expect(posts()).toBe(2);
      await click(button(t('browser.askForward')));
      await flush();
      expect(posts()).toBe(3);
      expect(iframe()?.getAttribute('src')).toBe('http://localhost:3000/');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the address field', () => {
  it('opens a typed port as the machine’s port, and goes back and forward over what was loaded', async () => {
    fakeBrowserApi();
    h = await mountPane({ url: '' });
    // An empty pane: the field has the keyboard and the start page lists
    // the machine's listening ports.
    expect(h.host.querySelector('.browser-address')?.hasAttribute('data-autofocus')).toBe(true);
    expect(h.host.querySelector('.browser-home [data-testid="browser-listening"]')).not.toBeNull();
    expect(text()).toBe(t('browser.portsListening', { machine: 'Box' }) + t('browser.portsNone'));
    expect(forwardGranted('a', 3000)).toBe(false);
    await typeAddress(h.host, '3000');
    expect(h.view()).toMatchObject({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    // Typed here: the user asked for the port, and its forward is made.
    expect(forwardGranted('a', 3000)).toBe(true);
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

  it('refuses the hub’s own address on this computer', async () => {
    const calls = fakeBrowserApi();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    h = await mountPane({ url: '' });
    // The pane's machine is this computer: its loopback is the hub's own.
    await act(async () => {
      useStore
        .getState()
        .setMachines([{ id: 'a', label: 'Mac', kind: 'local', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
    });
    // The UI is on 127.0.0.1:5173: the same port under any loopback name.
    for (const typed of ['localhost:5173', '5173', 'http://127.0.0.1:5173/api/m/a/hc/stop', 'http://[::1]:5173/']) {
      await typeAddress(h.host, typed);
      expect(h.host.querySelector('.browser-error')?.textContent, typed).toBe(t('browser.refusedOwn'));
      expect(h.view().url, typed).toBe('');
    }
    expect(iframe()).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    h.unmount();
    // A view that names it without a machine's port (the layout is every
    // client's) loads nothing.
    h = await mountPane({ url: 'http://localhost:5173/' });
    await flush();
    expect(text()).toBe(t('browser.refusedOwn'));
    expect(iframe()).toBeNull();
  });

  it('takes the hub’s port number as a remote machine’s own port', async () => {
    const calls = fakeBrowserApi();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    h = await mountPane({ url: '' });
    // Machine a is reached over ssh: its localhost:5173 is another program.
    await typeAddress(h.host, '5173');
    await flush();
    expect(h.host.querySelector('.browser-error')).toBeNull();
    expect(h.view()).toMatchObject({ url: 'http://localhost:5173/', m: 'a', port: 5173 });
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body])).toEqual([['/api/m/a/p/browser/forwards', { port: 5173 }]]);
    // Never opened outside, where the address would be the hub's own.
    expect(open).not.toHaveBeenCalled();
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
    h = await mountPane({ url: 'http://localhost:3000/a', m: 'a', port: 3000 }, { asked: true });
    await flush();
    await click(h.host.querySelector(`[aria-label="${t('browser.openOutside')}"]`));
    expect(open).toHaveBeenCalledWith('http://localhost:41000/a', '_blank', 'noopener');
  });
});

describe('Ports', () => {
  const route = {
    listening: () => json({ ports: [{ port: 5174, process: 'node' }, { port: 8080 }] }),
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
    // A row each: the port and the program, in columns.
    const buttons = [...popover.querySelectorAll<HTMLButtonElement>('button.browser-port')];
    expect(buttons.map((b) => [...b.children].map((c) => c.textContent))).toEqual([
      ['5174', 'node'],
      ['8080', ''],
    ]);
    expect(buttons.map((b) => b.title)).toEqual([t('browser.portsOpen', { port: 5174 }), t('browser.portsOpen', { port: 8080 })]);
    expect(forwardGranted('a', 5174)).toBe(false);
    await click(buttons[0]);
    await flush();
    expect(h.view()).toMatchObject({ url: 'http://localhost:5174/', m: 'a', port: 5174 });
    // Chosen here: the user asked for the port, and its forward is made.
    expect(forwardGranted('a', 5174)).toBe(true);
    expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({ port: 5174 });
    expect(iframe()?.getAttribute('src')).toBe('http://localhost:5174/');
    expect(h.host.querySelector('.browser-popover')).toBeNull();
  });

  it('lists the forwards and stops one', async () => {
    const calls = fakeBrowserApi(route);
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    await flush();
    await click(h.host.querySelector(`[aria-label="${t('browser.ports')}"]`));
    await flush();
    const popover = h.host.querySelector('.browser-popover')!;
    // The machine's port, the machine and the local port when it is another.
    const row = popover.querySelector<HTMLElement>('.browser-forward')!;
    expect([...row.querySelectorAll('span')].map((c) => c.textContent)).toEqual(['3000', 'Box', '→ 41000']);
    expect(row.title).toBe(t('browser.forwardLine', { machine: 'Box', port: 3000, local: 41000 }));
    await click(popover.querySelector(`[aria-label="${t('browser.forwardStop', { machine: 'Box', port: 3000 })}"]`));
    await flush();
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/m/a/p/browser/forwards/3000')).toBe(true);
  });

  it('says what each list holds when it has no row, in a line of it', async () => {
    const open = async () => {
      await click(h!.host.querySelector(`[aria-label="${t('browser.ports')}"]`));
      await flush();
      const popover = h!.host.querySelector('.browser-popover')!;
      return [...popover.querySelectorAll('.browser-ports-note')].map((n) => n.textContent);
    };
    fakeBrowserApi({ listening: () => json({ ports: [] }), forwards: () => json({ forwards: [], available: true }) });
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    await flush();
    expect(await open()).toEqual([t('browser.portsNone'), t('browser.forwardsNone')]);
    h.unmount();
    fakeBrowserApi({
      listening: () => json({ error: 'offline', message: 'x' }, 409),
      forwards: () => json({ forwards: [], available: false }),
    });
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 });
    await flush();
    expect(await open()).toEqual([t('browser.portsFailed'), t('browser.forwardsUnavailable')]);
  });

  it('names a forward’s local port only when it is another than the machine’s', async () => {
    fakeBrowserApi({
      forwards: () => json({ forwards: [{ m: 'a', port: 5174, local: 5174, created: '', connections: 0 }], available: true }),
    });
    h = await mountPane({ url: '' });
    await click(h.host.querySelector(`[aria-label="${t('browser.ports')}"]`));
    await flush();
    const row = h.host.querySelector<HTMLElement>('.browser-forward')!;
    expect([...row.querySelectorAll('span')].map((c) => c.textContent)).toEqual(['5174', 'Box', '']);
  });

  it('takes a stopped forward’s page off at once and asks before making it again', async () => {
    let stopped = false;
    const fw = { m: 'a', port: 3000, local: 3000, created: '', connections: 0 };
    const calls = fakeBrowserApi({
      forwards: () => json({ forwards: stopped ? [] : [fw], available: true }),
      stop: () => {
        stopped = true;
        return json({ ok: true });
      },
    });
    // The user asked for the port in this page: the pane made the forward.
    h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 }, { asked: true });
    await flush();
    expect(Object.keys(useFrames.getState().pages)).toEqual(['a|p1']);
    await click(h.host.querySelector(`[aria-label="${t('browser.ports')}"]`));
    await flush();
    const posts = calls.filter((c) => c.method === 'POST').length;
    await click(h.host.querySelector(`[aria-label="${t('browser.forwardStop', { machine: 'Box', port: 3000 })}"]`));
    await flush();
    // Stopping took the port back and the page off: the pane asks, and
    // nothing made the forward again.
    expect(forwardGranted('a', 3000)).toBe(false);
    expect(useFrames.getState().pages).toEqual({});
    expect(h.host.textContent).toContain(t('browser.ask', { port: 3000, machine: 'Box' }));
    expect(calls.filter((c) => c.method === 'POST').length).toBe(posts);
  });

  it('keeps the forward in use while the pane is mounted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const calls = fakeBrowserApi();
      h = await mountPane({ url: 'http://localhost:3000/', m: 'a', port: 3000 }, { asked: true });
      await act(async () => void (await Promise.resolve()));
      const before = calls.filter((c) => c.method === 'POST').length;
      await act(async () => void vi.advanceTimersByTime(5 * 60_000 + 1));
      // The user asked for the port: the forward is made again if it ended,
      // without a look at the list.
      expect(calls.filter((c) => c.method === 'POST').length).toBe(before + 1);
      expect(calls.filter((c) => c.method === 'GET')).toEqual([]);
      expect(Object.keys(useFrames.getState().pages)).toEqual(['a|p1']);
    } finally {
      vi.useRealTimers();
    }
  });
});
