// Downloading files and directories of a machine into the browser
// (docs/features/06-quick-look-and-files.md): from a pane's menu (a path
// under the pointer, or entries chosen in the pane's directory) and from
// VS Code's explorer through the bridge. The core streams one file as
// itself and anything else as a zip the agent makes on the fly.
//
// The browser saves the response like any download. Each one carries an id
// (?dl=) the page tells the core it follows ("download.watch", before the
// download and after every reconnect); the core reports to this page alone
// what it wrote and how it ended ("download" events), so the downloads panel
// (components/Downloads.tsx) shows progress, speed and the result, and can
// cancel it ("download.cancel"). The history of finished downloads is kept
// per browser (the last HISTORY_MAX, in localStorage; names and paths, no
// contents).

import { desktopShell } from './desktop';
import { downloadUrl } from './lib/files';
import { useStore } from './state/store';
import { conn } from './lib/conn';
import { hasMessage, t } from './i18n';
import { Speed, transferList } from './transferList';

/** Whether files of machine m can be downloaded from this page: not the
 * desktop app's own machine, whose files are already on this computer. */
export function canDownload(m: string): boolean {
  return !(desktopShell && useStore.getState().machines[m]?.kind === 'local');
}

export type DownloadStatus = 'starting' | 'downloading' | 'done' | 'failed' | 'cancelled';

export interface Download {
  id: string;
  /** The machine's id, and its name when the download started. */
  m: string;
  machine: string;
  /** The name it is saved under, as the core names it once it knows. */
  name: string;
  paths: string[];
  status: DownloadStatus;
  sent: number;
  /** Total bytes; undefined for an archive, which is made while it
   * downloads. */
  size?: number;
  /** Bytes per second: over the last seconds while downloading, on
   * average once done. */
  speed: number;
  started: number;
  ended?: number;
  /** A failure's code (downloads.error.*). */
  error?: string;
  /** Not started after NO_RESPONSE_MS: the browser holds it back (behind
   * other downloads to the same host) or blocked it. */
  waiting?: boolean;
}

/** An event of the core about a download (internal/server/downloads.go);
 * unknown: the core has not seen the id yet, or no longer knows it. */
export interface DownloadEvent {
  id: string;
  state: 'running' | 'done' | 'failed' | 'cancelled' | 'unknown';
  sent?: number;
  total?: number;
  name?: string;
  error?: string;
}

/** How long a download may go without a word from the core (which reports
 * it as soon as the request arrives) before it shows as not started yet;
 * the time while the page is not connected does not count. */
export const NO_RESPONSE_MS = 30_000;
const FINISHED = new Set<unknown>(['done', 'failed', 'cancelled']);

const list = transferList<Download>(
  'downloads',
  (x) => typeof x.m === 'string' && typeof x.name === 'string' && Array.isArray(x.paths) && FINISHED.has(x.status),
);

/** Starting and downloading downloads, oldest first, and the finished ones. */
export const useDownloads = list.store;

interface Live {
  speed: Speed;
  timer?: ReturnType<typeof setTimeout>;
  /** The user cancelled it. */
  cancelling?: boolean;
}
const live = new Map<string, Live>();

const find = list.find;

/** The message for a failure's code. */
export function downloadError(code?: string): string {
  const key = `downloads.error.${code}`;
  return code && hasMessage(key) ? t(key) : t('transfers.failed');
}

/** Moves a download to the history. */
function end(id: string, p: Pick<Download, 'status'> & Partial<Download>) {
  const x = find(id);
  const l = live.get(id);
  if (l?.timer) clearTimeout(l.timer);
  live.delete(id);
  if (!x) return;
  const ended = Date.now();
  const entry: Download = { ...x, ...p, ended };
  delete entry.waiting;
  entry.speed = entry.status === 'done' && ended > x.started ? (entry.sent * 1000) / (ended - x.started) : 0;
  if (entry.status === 'done') entry.size = entry.sent;
  list.archive(entry);
  if (entry.status === 'failed') useStore.getState().toast(t('download.failed', { name: entry.name, error: downloadError(entry.error) }));
}

/** An id the core accepts (internal/server/downloads.go), random enough
 * that no other page's download has it. */
function newId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Starts the browser's download of paths of machine m and follows it in
 * the downloads panel. A same-origin link keeps the transfer in the
 * browser's own downloads (and the desktop app's save dialog), with no copy
 * in memory. Returns the download's id. */
export function startDownload(m: string, paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const id = newId();
  const now = Date.now();
  const x: Download = {
    id,
    m,
    machine: useStore.getState().machines[m]?.label ?? m,
    name: paths.length === 1 ? paths[0].split('/').pop() || paths[0] : t('downloads.items', { n: paths.length }),
    paths,
    status: 'starting',
    sent: 0,
    speed: 0,
    started: now,
  };
  const l: Live = { speed: new Speed() };
  const wait = () => {
    l.timer = setTimeout(() => {
      l.timer = undefined;
      if (find(id)?.status !== 'starting') return;
      // Disconnected, the page cannot hear the core: it asks again after
      // reconnecting (resyncDownloads). Connected, the request has not
      // arrived: the browser holds it back or blocked it. It stays, and
      // can be cancelled.
      if (conn.connected) list.patch(id, { waiting: true });
      else wait();
    }, NO_RESPONSE_MS);
  };
  wait();
  live.set(id, l);
  list.add([x]);
  // Before the request, so that the core reports it to this page.
  conn.send({ t: 'download.watch', ids: [id] });
  const a = document.createElement('a');
  a.href = `${downloadUrl(m, paths)}&dl=${id}`;
  a.download = '';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return id;
}

/** Applies the core's event about a download this page started; events of
 * other pages' downloads are ignored. */
export function downloadEvent(ev: DownloadEvent) {
  if (!ev || typeof ev.id !== 'string') return;
  const x = find(ev.id);
  const l = live.get(ev.id);
  if (!x || !l) return;
  const p: Partial<Download> = {};
  if (typeof ev.name === 'string' && ev.name) p.name = ev.name;
  if (typeof ev.total === 'number' && ev.total >= 0) p.size = ev.total;
  const sent = typeof ev.sent === 'number' && ev.sent >= 0 ? ev.sent : x.sent;
  if (ev.state === 'unknown') {
    // A cancelled download the core does not know is over; one it reported
    // and has forgotten (it restarted, or the page was away long) ended
    // somehow, as the browser's downloads tell. Before its request arrives,
    // a download is not known yet.
    if (l.cancelling) end(ev.id, { status: 'cancelled' });
    else if (x.status === 'downloading') end(ev.id, { status: 'failed', error: 'lost' });
    return;
  }
  if (ev.state !== 'running') {
    const status = ev.state === 'done' ? 'done' : ev.state === 'cancelled' ? 'cancelled' : 'failed';
    end(ev.id, { ...p, status, sent, error: status === 'failed' ? ev.error || 'interrupted' : undefined });
    return;
  }
  if (l.timer) {
    clearTimeout(l.timer);
    l.timer = undefined;
  }
  const first = x.status === 'starting' || p.name !== undefined || p.size !== undefined;
  const speed = l.speed.add(sent, first);
  if (speed === undefined) return;
  list.patch(ev.id, { ...p, status: 'downloading', waiting: undefined, sent, speed });
}

/** Cancels a download: the core breaks off the response, so the browser's
 * download fails too, and reports it as cancelled, or how it ended before.
 * One whose request has not arrived counts as cancelled at once, and the
 * core refuses that request if it comes. */
export function cancelDownload(id: string) {
  const l = live.get(id);
  if (!find(id) || !l) return;
  l.cancelling = true;
  conn.send({ t: 'download.cancel', id });
}

/** Asks the core again about the downloads in progress, after the page
 * (re)connected: events sent meanwhile were lost. */
export function resyncDownloads() {
  const ids = useDownloads.getState().active.map((x) => x.id);
  if (ids.length) conn.sendNow({ t: 'download.watch', ids });
}

export function cancelAllDownloads() {
  for (const x of useDownloads.getState().active) cancelDownload(x.id);
}

/** Downloads the same paths again. */
export function retryDownload(x: Download) {
  startDownload(x.m, x.paths);
}

export const forgetDownload = list.forget;

export const clearDownloadHistory = list.clear;

/** Received and total bytes of the active downloads; total is undefined
 * while one of them has no size. */
export function downloadsProgress(active: Download[]): { sent: number; size?: number } {
  let sent = 0;
  let size: number | undefined = 0;
  for (const x of active) {
    sent += x.sent;
    size = size === undefined || x.size === undefined ? undefined : size + x.size;
  }
  return { sent, size };
}

/** Downloads a path found in a pane's text, which may name nothing on the
 * machine: it is checked first, so a typo becomes a note instead of a failed
 * download. */
export async function downloadPath(m: string, path: string) {
  const name = path.split('/').pop() || path;
  try {
    const r = await fetch(downloadUrl(m, [path]), { method: 'HEAD' });
    if (!r.ok) throw new Error(r.status === 404 ? 'not found' : r.statusText || `HTTP ${r.status}`);
  } catch (e) {
    useStore.getState().toast(t('download.failed', { name, error: (e as Error).message }));
    return;
  }
  startDownload(m, [path]);
}

/** VS Code's explorer asked for a download (bridge.download). Every page
 * hears it; the one embedding that VS Code has the focus. */
export function bridgeDownload(m: string, paths: string[]) {
  if (!Array.isArray(paths) || !document.hasFocus()) return;
  startDownload(
    m,
    paths.filter((p) => typeof p === 'string'),
  );
}
