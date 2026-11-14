// @vitest-environment jsdom
//
// Downloads from a machine: the pane menu offers a path under the pointer
// and a chooser of the pane's directory (not for the desktop app's own
// machine), the chooser takes several entries and directories in one
// download, a path that names nothing becomes a note, and only the page with
// the focus downloads what VS Code's explorer asked for. The downloads
// panel follows each download through the core's events.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MenuEntry, MenuItem } from '../contextMenu';

/** Messages the page sent the core. */
const sent = vi.hoisted(() => [] as unknown[]);
const link = vi.hoisted(() => ({ connected: true }));
vi.mock('../lib/conn', () => ({
  conn: {
    api: () => Promise.resolve({}),
    send: (m: unknown) => sent.push(m),
    sendNow: (m: unknown) => sent.push(m),
    setTheme: () => {},
    get connected() {
      return link.connected;
    },
  },
}));

let shell: unknown;
vi.mock('../desktop', () => ({
  get desktopShell() {
    return shell;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let store: typeof import('../state/store');
let menus: typeof import('../menus');
let download: typeof import('../download');
let dialog: typeof import('../dialog');
let Dialogs: typeof import('../components/Dialogs').Dialogs;

/** Links the page clicked to start downloads. */
const clicked: string[] = [];
const fetches: Array<{ url: string; method: string }> = [];
const dirs: Record<string, { name: string; size: number; is_dir: boolean }[]> = {
  '/home/u/proj': [
    { name: 'src', size: 0, is_dir: true },
    { name: 'a.txt', size: 2048, is_dir: false },
    { name: 'b.png', size: 10, is_dir: false },
  ],
  '/home/u/proj/src': [{ name: 'main.go', size: 5, is_dir: false }],
  '/home/u': [{ name: 'proj', size: 0, is_dir: true }],
};

beforeAll(async () => {
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.getAttribute('href') ?? '');
  });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    fetches.push({ url, method: init?.method ?? 'GET' });
    const u = new URL(url, 'http://core');
    if (u.pathname.endsWith('/list')) {
      const path = u.searchParams.get('path')!;
      const entries = dirs[path];
      if (!entries) return Promise.resolve(new Response(JSON.stringify({ error: 'no such directory' }), { status: 404 }));
      return Promise.resolve(new Response(JSON.stringify({ dir: { name: '', path, is_dir: true }, entries })));
    }
    const missing = u.searchParams.getAll('path').some((p) => p.includes('missing'));
    return Promise.resolve(new Response(null, { status: missing ? 404 : 200 }));
  });
  store = await import('../state/store');
  menus = await import('../menus');
  download = await import('../download');
  dialog = await import('../dialog');
  Dialogs = (await import('../components/Dialogs')).Dialogs;
});

let root: Root | undefined;
beforeEach(() => {
  shell = undefined;
  clicked.length = 0;
  fetches.length = 0;
  sent.length = 0;
  link.connected = true;
  store.useStore.setState({
    readOnly: false,
    toasts: [],
    machines: {
      local: { id: 'local', label: 'Mac', kind: 'local', session: 'default', enabled: true, status: 'ready', updated_at: 0 },
      gpu: { id: 'gpu', label: 'gpu', kind: 'ssh', session: 'default', enabled: true, status: 'ready', updated_at: 0 },
    },
  } as never);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  dialog.useDialog.setState({ current: undefined });
});

const labels = (e: MenuEntry[]) => e.map((x) => (x === 'sep' ? '-' : x.label));
const item = (e: MenuEntry[], label: string) => e.find((x): x is MenuItem => x !== 'sep' && x.label === label)!;
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const query = (url: string) => new URL(url, 'http://core').searchParams.getAll('path');

describe('pane menu', () => {
  it('downloads a path under the pointer and chooses from the directory', async () => {
    const entries = menus.surfaceMenu({ ctx: { m: 'gpu', cwd: '/home/u/proj', home: '/home/u' }, link: { kind: 'path', text: 'a.txt' } });
    expect(labels(entries)).toEqual([
      'Copy',
      '-',
      'Preview a.txt',
      'Open a.txt in VS Code',
      'Download a.txt',
      'Copy full path',
      '-',
      'Download files…',
    ]);
    item(entries, 'Download a.txt').run();
    await flush();
    // Checked first, then downloaded with a same-origin link.
    expect(fetches).toEqual([{ url: '/api/m/gpu/download?path=%2Fhome%2Fu%2Fproj%2Fa.txt', method: 'HEAD' }]);
    // The link carries the id the downloads panel follows it by.
    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toMatch(/^\/api\/m\/gpu\/download\?path=%2Fhome%2Fu%2Fproj%2Fa\.txt&dl=[A-Za-z0-9_-]{22}$/);
  });

  it('makes a path that names nothing a note', async () => {
    const entries = menus.surfaceMenu({ ctx: { m: 'gpu', cwd: '/home/u' }, link: { kind: 'path', text: 'missing.txt' } });
    item(entries, 'Download missing.txt').run();
    await flush();
    expect(clicked).toEqual([]);
    expect(store.useStore.getState().toasts.map((x) => x.msg)).toEqual(['Could not download missing.txt: not found']);
  });

  it('has no downloads for the desktop app’s own machine', () => {
    shell = {};
    const local = menus.surfaceMenu({ ctx: { m: 'local', cwd: '/Users/u' }, link: { kind: 'path', text: 'a.txt' } });
    expect(labels(local).filter((l) => l.startsWith('Download'))).toEqual([]);
    const remote = menus.surfaceMenu({ ctx: { m: 'gpu', cwd: '/home/u' } });
    expect(labels(remote)).toEqual(['Copy', '-', 'Download files…']);
    // A browser downloads from every machine, the core's own too.
    shell = undefined;
    expect(labels(menus.surfaceMenu({ ctx: { m: 'local', cwd: '/Users/u' } }))).toContain('Download files…');
  });
});

describe('download chooser', () => {
  const render = async (dir: string) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(Dialogs)));
    let done = false;
    act(() => void dialog.downloadDialog('gpu', dir).then(() => (done = true)));
    await flush();
    return { host, closed: () => done };
  };
  const rows = (host: HTMLElement) => [...host.querySelectorAll('.download-row:not(.download-all)')].map((r) => r.textContent);
  const check = (host: HTMLElement, name: string) =>
    act(() => host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!.click());
  const button = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('.dialog-actions button')].find((b) => b.textContent === label)!;

  it('downloads the checked entries of a directory in one go', async () => {
    const { host, closed } = await render('/home/u/proj');
    expect(host.querySelector('.modal-title')?.textContent).toBe('Download from gpu');
    expect(rows(host)).toEqual(['src', 'a.txt2.0 KB', 'b.png10 B']);
    expect(button(host, 'Download').disabled).toBe(true);
    check(host, 'src');
    check(host, 'a.txt');
    expect(host.querySelector('.dialog-actions')?.textContent).toContain('2 selected');
    act(() => button(host, 'Download').click());
    expect(clicked.map(query)).toEqual([['/home/u/proj/src', '/home/u/proj/a.txt']]);
    await flush();
    expect(closed()).toBe(true);
  });

  it('enters directories, goes up and selects all', async () => {
    const { host } = await render('/home/u/proj');
    act(() => host.querySelector<HTMLButtonElement>('button.download-name')!.click());
    await flush();
    expect(host.querySelector('.download-path')?.textContent).toBe('/home/u/proj/src');
    expect(rows(host)).toEqual(['main.go5 B']);
    act(() => host.querySelector<HTMLButtonElement>('.download-path button')!.click());
    await flush();
    act(() => host.querySelector<HTMLButtonElement>('.download-path button')!.click());
    await flush();
    expect(host.querySelector('.download-path')?.textContent).toBe('/home/u');
    act(() => host.querySelector<HTMLInputElement>('.download-all input')!.click());
    act(() => button(host, 'Download').click());
    expect(clicked.map(query)).toEqual([['/home/u/proj']]);
  });

  it('shows why a directory cannot be listed and closes on Escape', async () => {
    const { host, closed } = await render('/nope');
    expect(host.querySelector('.download-list .error')?.textContent).toBe('Could not list /nope: no such directory');
    act(() => {
      host.querySelector('.modal')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();
    expect(closed()).toBe(true);
    expect(clicked).toEqual([]);
  });
});

describe('VS Code explorer', () => {
  it('downloads on the page with the focus only', () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    download.bridgeDownload('gpu', ['/srv/a', '/srv/b']);
    expect(clicked).toEqual([]);
    focus.mockReturnValue(true);
    download.bridgeDownload('gpu', ['/srv/a', '/srv/b']);
    expect(clicked.map(query)).toEqual([['/srv/a', '/srv/b']]);
    focus.mockRestore();
  });
});

describe('downloads panel', () => {
  let Downloads: typeof import('../components/Downloads');
  const id = (href: string) => new URL(href, 'http://core').searchParams.get('dl')!;
  const active = () => download.useDownloads.getState().active;
  const history = () => download.useDownloads.getState().history;
  beforeAll(async () => {
    Downloads = await import('../components/Downloads');
  });
  beforeEach(() => {
    download.useDownloads.setState({ active: [], history: [], panel: false });
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('follows a file from start to end, with its speed', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000_000);
    download.startDownload('gpu', ['/srv/data.bin']);
    const dl = id(clicked[0]);
    // The core reports it to this page alone.
    expect(sent).toEqual([{ t: 'download.watch', ids: [dl] }]);
    expect(active()).toMatchObject([{ id: dl, m: 'gpu', machine: 'gpu', name: 'data.bin', status: 'starting', sent: 0 }]);
    expect(Downloads.downloadDetail(active()[0])).toBe('Starting…');

    // Other pages' downloads are not this page's business.
    download.downloadEvent({ id: 'someone-else', state: 'running', sent: 5 });
    download.downloadEvent({ id: dl, state: 'running', sent: 0, total: 4000, name: 'data.bin' });
    vi.setSystemTime(1_002_000);
    download.downloadEvent({ id: dl, state: 'running', sent: 2000, total: 4000, name: 'data.bin' });
    expect(active()[0]).toMatchObject({ status: 'downloading', sent: 2000, size: 4000, speed: 1000 });
    expect(Downloads.downloadDetail(active()[0])).toBe('2.0 KB of 3.9 KB · 1000 B/s · 2 s left');

    vi.setSystemTime(1_004_000);
    download.downloadEvent({ id: dl, state: 'done', sent: 4000, total: 4000, name: 'data.bin' });
    expect(active()).toEqual([]);
    expect(history()).toMatchObject([{ id: dl, status: 'done', sent: 4000, size: 4000, speed: 1000 }]);
    expect(Downloads.downloadDetail(history()[0])).toBe('3.9 KB in 4 s · 1000 B/s');
    // Kept by the browser, without the live parts.
    expect(
      JSON.parse(
        localStorage.getItem(
          [...Array(localStorage.length).keys()].map((k) => localStorage.key(k)!).find((k) => k.endsWith('downloads'))!,
        )!,
      ),
    ).toMatchObject([{ id: dl, paths: ['/srv/data.bin'], status: 'done' }]);
  });

  it('shows an archive without a size, and how a download failed', () => {
    download.startDownload('gpu', ['/srv/a', '/srv/b']);
    const dl = id(clicked[0]);
    expect(active()[0].name).toBe('2 items');
    download.downloadEvent({ id: dl, state: 'running', sent: 0, name: 'srv.zip' });
    download.downloadEvent({ id: dl, state: 'running', sent: 2048, name: 'srv.zip' });
    expect(active()[0]).toMatchObject({ name: 'srv.zip', status: 'downloading', sent: 2048 });
    expect(active()[0].size).toBeUndefined();
    expect(Downloads.downloadDetail(active()[0])).toMatch(/^2\.0 KB · .*\/s$/);
    download.downloadEvent({ id: dl, state: 'failed', sent: 2048, error: 'unavailable' });
    expect(history()[0]).toMatchObject({ status: 'failed', error: 'unavailable' });
    expect(Downloads.downloadDetail(history()[0])).toBe('The machine is not connected');
    expect(store.useStore.getState().toasts.at(-1)?.msg).toBe('Could not download srv.zip: The machine is not connected');
  });

  it('cancels through the core, waits for a download the browser holds back, and downloads again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    download.startDownload('gpu', ['/srv/a.txt']);
    const dl = id(clicked[0]);
    download.downloadEvent({ id: dl, state: 'running', sent: 10, total: 100 });
    download.cancelDownload(dl);
    expect(sent.at(-1)).toEqual({ t: 'download.cancel', id: dl });
    download.downloadEvent({ id: dl, state: 'cancelled', sent: 10, total: 100 });
    expect(history()[0]).toMatchObject({ id: dl, status: 'cancelled' });

    // No word from the core: not started yet (the browser holds it back
    // behind other downloads, or blocked it), not a failure; the time
    // while the page is not connected does not count.
    download.startDownload('gpu', ['/srv/b.txt']);
    const b = id(clicked[1]);
    link.connected = false;
    vi.advanceTimersByTime(download.NO_RESPONSE_MS);
    expect(active()).toMatchObject([{ name: 'b.txt', status: 'starting' }]);
    expect(active()[0].waiting).toBeUndefined();
    link.connected = true;
    vi.advanceTimersByTime(download.NO_RESPONSE_MS);
    expect(active()).toMatchObject([{ name: 'b.txt', status: 'starting', waiting: true }]);
    expect(Downloads.downloadDetail(active()[0])).toBe(
      'Not started yet: the browser may be holding it behind other downloads, or blocked it',
    );
    // Once the browser lets it go, it runs like any other.
    download.downloadEvent({ id: b, state: 'running', sent: 1, total: 100 });
    expect(active()[0]).toMatchObject({ status: 'downloading' });
    expect(active()[0].waiting).toBeUndefined();
    // Cancelled while held back, the core answers at once.
    download.startDownload('gpu', ['/srv/c.txt']);
    const c = id(clicked[2]);
    download.cancelDownload(c);
    download.downloadEvent({ id: c, state: 'cancelled', sent: 0 });
    expect(history()[0]).toMatchObject({ id: c, status: 'cancelled' });

    // Downloading again starts a new download of the same paths.
    download.retryDownload(history()[0]);
    expect(clicked.map(query).at(-1)).toEqual(['/srv/c.txt']);
    expect(id(clicked.at(-1)!)).not.toBe(c);
    expect(active()).toHaveLength(2);
  });

  it('asks again after a reconnect, and ends what the core no longer knows', () => {
    download.startDownload('gpu', ['/srv/a.txt']);
    download.startDownload('gpu', ['/srv/b.txt']);
    download.startDownload('gpu', ['/srv/c.txt']);
    const [a, b, c] = clicked.map(id);
    download.downloadEvent({ id: a, state: 'running', sent: 10, total: 100 });
    download.downloadEvent({ id: c, state: 'running', sent: 10, total: 100 });
    sent.length = 0;
    download.resyncDownloads();
    expect(sent).toEqual([{ t: 'download.watch', ids: [a, b, c] }]);
    // The final event was lost while away: the core still knows it.
    download.downloadEvent({ id: a, state: 'done', sent: 100, total: 100 });
    // Not seen yet: still starting.
    download.downloadEvent({ id: b, state: 'unknown' });
    // Seen and forgotten: how it ended is not known.
    download.downloadEvent({ id: c, state: 'unknown' });
    expect(active()).toMatchObject([{ id: b, status: 'starting' }]);
    expect(history()).toMatchObject([
      { id: c, status: 'failed', error: 'lost' },
      { id: a, status: 'done' },
    ]);
    // Cancelling one the core never saw ends it.
    download.cancelDownload(b);
    download.downloadEvent({ id: b, state: 'unknown' });
    expect(active()).toEqual([]);
    expect(history()[0]).toMatchObject({ id: b, status: 'cancelled' });
  });

  it('shows the downloads in the status bar', async () => {
    download.startDownload('gpu', ['/srv/a.txt']);
    download.downloadEvent({ id: id(clicked[0]), state: 'running', sent: 25, total: 100 });
    download.startDownload('gpu', ['/srv/dir']);
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(Downloads.DownloadsTray)));
    // An archive of unknown size leaves out the percentage.
    expect(host.querySelector('.gui-count')?.textContent).toBe('2');
    act(() => host.querySelector<HTMLButtonElement>('.transfers-tray')!.click());
    expect([...host.querySelectorAll('.transfer-name')].map((x) => x.textContent)).toEqual(['a.txt', 'dir']);
    expect(host.querySelectorAll('.transfer-bar.indeterminate')).toHaveLength(1);
    expect(host.querySelector('.transfer-bar:not(.indeterminate) > div')?.getAttribute('style')).toContain('width: 25%');
    act(() => host.querySelectorAll<HTMLButtonElement>('button[aria-label="Cancel download"]')[1].click());
    expect(sent.at(-1)).toEqual({ t: 'download.cancel', id: id(clicked[1]) });
  });
});
