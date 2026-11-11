// @vitest-environment jsdom
//
// Uploads of pasted and dropped files and the uploads panel: progress and
// speed while a file goes, cancelling a running or waiting upload, falling
// back to the upload directory, and the history this browser keeps.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FakeXhr } from './fakeXhr';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));
vi.stubGlobal('XMLHttpRequest', FakeXhr);

import { useStore } from '../state/store';
import { cancelAllUploads, cancelUpload, clearUploadHistory, forgetUpload, HISTORY_MAX, uploadFiles, useTransfers } from '../transfers';
import { detail, duration, TransfersTray } from '../components/Transfers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = (name: string, size: number) => new File([new Uint8Array(size)], name);
const active = () => useTransfers.getState().active;
const history = () => useTransfers.getState().history;
const stored = () => JSON.parse(localStorage.getItem('herdr-ide.uploads') ?? 'null');
const toasts = () => useStore.getState().toasts.map((t) => t.msg);
const ok = (path: string): [number, unknown] => [200, { name: path.split('/').pop(), size: 1, path }];

beforeEach(() => {
  FakeXhr.reset();
  localStorage.clear();
  useTransfers.setState({ active: [], history: [], panel: false });
  useStore.setState({
    toasts: [],
    machines: {
      ws2: { id: 'ws2', label: 'gpu box', kind: 'ssh', session: 'default', enabled: true, status: 'ready', info: { home: '/home/u' } },
    },
  } as never);
});
afterEach(() => vi.useRealTimers());

describe('an upload', () => {
  it('shows its progress and speed; a cancelled one stops and the next goes on', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 0 });
    const done = uploadFiles('ws2', [file('big.bin', 10_000_000), file('notes.txt', 10)], '/home/u/proj');
    expect(FakeXhr.requests.map((r) => r.url)).toEqual(['/api/m/ws2/upload?name=big.bin&dir=%2Fhome%2Fu%2Fproj']);
    expect(active().map((x) => [x.name, x.status, x.machine])).toEqual([
      ['big.bin', 'uploading', 'gpu box'],
      ['notes.txt', 'queued', 'gpu box'],
    ]);

    const big = FakeXhr.requests[0];
    vi.setSystemTime(1000);
    big.progress(2_000_000);
    vi.setSystemTime(2000);
    big.progress(4_000_000);
    expect(active()[0]).toMatchObject({ sent: 4_000_000, speed: 2_000_000 });
    expect(detail(active()[0])).toBe('3.8 MB of 9.5 MB · 1.9 MB/s · 3 s left');
    // The speed is measured over the last seconds only.
    vi.setSystemTime(10_000);
    big.progress(4_500_000);
    vi.setSystemTime(11_000);
    big.progress(5_500_000);
    expect(active()[0].speed).toBeCloseTo(1_500_000 / 9, 0);

    cancelUpload(active()[0].id);
    expect(big.aborted).toBe(true);
    await vi.waitFor(() => expect(FakeXhr.requests).toHaveLength(2));
    const notes = FakeXhr.requests[1];
    notes.sent();
    expect(active()).toMatchObject([{ name: 'notes.txt', status: 'finishing' }]);
    // The agent is writing the file now: too late to cancel.
    cancelUpload(active()[0].id);
    expect(notes.aborted).toBe(false);
    // (waitFor moved the fake clock along.)
    vi.setSystemTime(active()[0].started! + 1000);
    notes.respond(...ok('/home/u/proj/notes.txt'));

    expect(await done).toEqual([undefined, '/home/u/proj/notes.txt']);
    expect(active()).toEqual([]);
    expect(history().map((x) => [x.name, x.status, x.path])).toEqual([
      ['notes.txt', 'done', '/home/u/proj/notes.txt'],
      ['big.bin', 'cancelled', undefined],
    ]);
    expect(detail(history()[0])).toBe('10 B in 1 s · 10 B/s');
    expect(stored()).toHaveLength(2);
    expect(toasts()).toEqual([]);
  });

  it('cancelled while waiting is never sent', async () => {
    const done = uploadFiles('ws2', [file('a.png', 1), file('b.png', 1), file('c.png', 1)]);
    cancelUpload(active()[1].id);
    expect(history()).toMatchObject([{ name: 'b.png', status: 'cancelled' }]);
    FakeXhr.requests[0].respond(...ok('/up/a.png'));
    await vi.waitFor(() => expect(FakeXhr.requests).toHaveLength(2));
    FakeXhr.requests[1].respond(...ok('/up/c.png'));
    expect(await done).toEqual(['/up/a.png', undefined, '/up/c.png']);
    expect(FakeXhr.requests.map((r) => new URL(r.url, 'http://x').searchParams.get('name'))).toEqual(['a.png', 'c.png']);
  });

  it('goes to the upload directory when the directory refuses it; a lost connection fails it', async () => {
    const done = uploadFiles('ws2', [file('a.png', 1)], '/readonly');
    FakeXhr.requests[0].respond(502, { error: 'agent fs.write: open /readonly/.tmp: permission denied' });
    await vi.waitFor(() => expect(FakeXhr.requests).toHaveLength(2));
    expect(FakeXhr.requests[1].url).toBe('/api/m/ws2/upload?name=a.png');
    expect(active()[0].dir).toBeUndefined();
    FakeXhr.requests[1].fail();
    expect(await done).toEqual([undefined]);
    expect(FakeXhr.requests).toHaveLength(2);
    expect(history()).toMatchObject([{ status: 'failed', error: 'connection to the server lost' }]);
    expect(toasts()).toEqual([
      'Could not save into /readonly (permission denied); uploading to the upload folder instead.',
      'Upload failed: connection to the server lost',
    ]);
  });
});

describe('durations', () => {
  it('read as seconds, minutes and hours', () => {
    expect([400, 1000, 59_400, 61_000, 3_725_000].map(duration)).toEqual(['under 1 s', '1 s', '59 s', '1 min 1 s', '1 h 2 min']);
  });
});

describe('the upload history', () => {
  it(`keeps the last ${HISTORY_MAX} in this browser`, async () => {
    FakeXhr.reply = (url) => ok('/up/' + new URL(url, 'http://x').searchParams.get('name'));
    await uploadFiles(
      'ws2',
      Array.from({ length: HISTORY_MAX + 5 }, (_, k) => file(`f${k}.txt`, 1)),
    );
    expect(history()).toHaveLength(HISTORY_MAX);
    expect(history()[0].name).toBe(`f${HISTORY_MAX + 4}.txt`);
    expect(stored()).toHaveLength(HISTORY_MAX);

    // Another tab of this browser finished one meanwhile: opening shows it.
    localStorage.setItem('herdr-ide.uploads', JSON.stringify([{ ...history()[0], id: 'other', name: 'there.txt' }, { bogus: true }]));
    useTransfers.getState().setPanel(true);
    expect(history().map((x) => x.name)).toEqual(['there.txt']);

    forgetUpload('other');
    expect(history()).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it('can be cleared', () => {
    useTransfers.setState({
      history: [{ id: 'x', m: 'ws2', machine: 'gpu box', name: 'x', size: 1, sent: 1, speed: 0, status: 'done', ended: 1 }],
    });
    clearUploadHistory();
    expect(history()).toEqual([]);
    expect(stored()).toEqual([]);
  });
});

describe('the uploads panel', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(TransfersTray)));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const button = () => host.querySelector<HTMLButtonElement>('button.transfers-tray');
  const rows = () => Array.from(host.querySelectorAll('.transfer')).map((r) => r.textContent);
  const click = (label: string) => act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());

  it('lists running and finished uploads, which can be cancelled, previewed and forgotten', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 0 });
    expect(button()).toBeNull();
    let done!: Promise<unknown>;
    await act(async () => {
      done = uploadFiles('ws2', [file('a.bin', 100), file('b.bin', 100)], '/home/u/proj');
    });
    FakeXhr.requests[0].progress(50);
    await act(async () => {});
    expect(button()!.textContent).toBe('2 · 25%');
    await act(async () => button()!.click());
    expect(rows()).toEqual(['a.bin' + 'gpu box · ~/proj' + '50 B of 100 B · 0 B/s', 'b.bin' + 'gpu box · ~/proj' + 'Waiting']);
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    expect(host.querySelector('.transfers-head')?.textContent).toContain('Cancel all');

    await click('Cancel upload');
    expect(FakeXhr.requests[0].aborted).toBe(true);
    await vi.waitFor(() => expect(FakeXhr.requests).toHaveLength(2));
    vi.setSystemTime(active()[0].started! + 1000);
    await act(async () => FakeXhr.requests[1].respond(...ok('/home/u/proj/b.bin')));
    await act(async () => void (await done));
    expect(button()!.textContent).toBe('');
    expect(rows()[0]).toMatch(/^b\.bingpu box · ~\/proj\/b\.bin100 B in 1 s · 100 B\/s/);
    expect(rows()[1]).toMatch(/^a\.bingpu box · ~\/projCancelled/);

    await click('Preview');
    expect(useStore.getState().dock).toEqual({ kind: 'preview', m: 'ws2', path: '/home/u/proj/b.bin' });
    expect(useTransfers.getState().panel).toBe(false);

    await act(async () => button()!.click());
    await act(async () => host.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove from the list"]')[1].click());
    expect(history().map((x) => x.name)).toEqual(['b.bin']);
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Clear history')!
        .click(),
    );
    expect(rows()).toEqual([]);
    expect(host.querySelector('.transfers-empty')?.textContent).toBe('No uploads.');
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(button()).toBeNull();
  });

  it('cancels every running and waiting upload at once', async () => {
    let done!: Promise<unknown>;
    await act(async () => {
      done = uploadFiles('ws2', [file('a', 1), file('b', 1), file('c', 1)]);
    });
    await act(async () => cancelAllUploads());
    expect(await done).toEqual([undefined, undefined, undefined]);
    expect(FakeXhr.requests).toHaveLength(1);
    expect(history().map((x) => x.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });
});
