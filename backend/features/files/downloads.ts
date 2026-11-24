// Downloads a page started with an id (GET /api/m/:id/download?dl=…), for
// its downloads panel (docs/features/06-quick-look-and-files.md): the
// browser saves the answer itself, and the core tells the page how much of
// it went out and how it ended, and cancels it on request. Events are
// {t: "download", id, state: running|done|failed|cancelled|unknown, sent,
// total?, name?, error?}, sent only to the page that follows the id: it
// says so (download.watch) before it starts the download and again after
// a reconnect, and is answered with the download's state at once. How a
// download ended is kept for keepMs, so that a page that missed it (its
// request came first, or its connection dropped) still learns it;
// "unknown" answers an id the core has not seen or no longer knows.
import type { Page } from '#kernel/pages.ts';
import type { Ending, Transfer } from './body.ts';

/** The form of an id the page makes (random, URL-safe). */
export const DOWNLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Codes of failed downloads, translated by the page. */
export const DownloadCode = {
  /** The path or the machine does not exist. */
  NotFound: 'not_found',
  /** The machine is not connected. */
  Unavailable: 'unavailable',
  /** The paths were refused. */
  Invalid: 'invalid',
  /** The transfer broke off. */
  Interrupted: 'interrupted',
  /** The file is shorter than the range asked for. */
  Changed: 'changed',
} as const;

export type DownloadState = 'running' | 'done' | 'failed' | 'cancelled' | 'unknown';

export interface DownloadEvent {
  t: 'download';
  id: string;
  state: DownloadState;
  sent?: number;
  total?: number;
  name?: string;
  error?: string;
}

export interface DownloadsOptions {
  /** How often a running download's progress is sent (250 ms). */
  everyMs?: number;
  /** How long a download's end, and a page's interest in an id that never
   * came, are kept (10 min). */
  keepMs?: number;
  /** Bounds the ends kept (256), the ids followed (1024) and the ids of one
   * download.watch (256). */
  maxEnded?: number;
  maxWatched?: number;
  maxWatchIds?: number;
  now?: () => number;
}

interface Ended {
  ev: DownloadEvent;
  at: number;
  /** Cancelled before its request came, which is then refused. */
  early?: boolean;
}

/** A download in progress: the transfer of its answer. */
export class Download implements Transfer {
  readonly id: string;
  readonly request: AbortSignal;
  /** Aborted by a cancel from the panel, and once the download ended. */
  readonly cancelled: AbortSignal;
  /** The request's, also ended by the panel: what the download asks of
   * the machine stops with it. */
  readonly signal: AbortSignal;
  private readonly stop = new AbortController();
  private readonly hub: Downloads;
  private byUser = false;
  private sentBytes = 0;
  private total = -1;
  private name = '';
  private code = '';
  private last = 0;
  private over = false;

  constructor(hub: Downloads, id: string, request: AbortSignal) {
    this.hub = hub;
    this.id = id;
    this.request = request;
    this.cancelled = this.stop.signal;
    this.signal = AbortSignal.any([request, this.stop.signal]);
  }

  /** The name it is saved under and its size, -1 when not known in advance
   * (an archive). */
  describe(name: string, total: number): void {
    this.name = name;
    this.total = total;
    this.hub.publish(this, 'running');
  }

  /** Records why it failed (the first reason counts); once the browser or
   * the panel cancelled it, errors are that cancel's. */
  fail(code: string): void {
    if (this.signal.aborted || this.code) return;
    this.code = code;
  }

  sent(n: number): void {
    this.sentBytes += n;
    if (this.hub.now() - this.last >= this.hub.everyMs) this.hub.publish(this, 'running');
  }

  /** Breaks it off for the page (download.cancel). */
  cancel(): void {
    this.byUser = true;
    this.stop.abort();
  }

  /** It ended: sends how, keeps that for a page that asks later and stops
   * following it. */
  ended(how: Ending): void {
    if (this.over) return;
    this.over = true;
    this.stop.abort();
    let state: DownloadState = 'done';
    const gone = how === 'gone' || this.request.aborted;
    if (this.byUser || (how !== 'complete' && !this.code && gone)) state = 'cancelled';
    else if (this.code) state = 'failed';
    else if (how !== 'complete') {
      state = 'failed';
      this.code = DownloadCode.Interrupted;
    }
    this.hub.finished(this, this.event(state));
  }

  /** Its event in state. */
  event(state: DownloadState): DownloadEvent {
    const ev: DownloadEvent = { t: 'download', id: this.id, state, sent: this.sentBytes };
    if (this.total >= 0) ev.total = this.total;
    if (this.name) ev.name = this.name;
    if (state === 'failed' && this.code) ev.error = this.code;
    this.last = this.hub.now();
    return ev;
  }
}

/** The downloads pages follow. */
export class Downloads {
  readonly everyMs: number;
  readonly now: () => number;
  private readonly keepMs: number;
  private readonly maxEnded: number;
  private readonly maxWatched: number;
  private readonly maxWatchIds: number;
  private readonly running = new Map<string, Download>();
  private readonly ended = new Map<string, Ended>();
  /** The page following each id. */
  private readonly watchers = new Map<string, { page: Page; since: number }>();

  constructor(o: DownloadsOptions = {}) {
    this.everyMs = o.everyMs ?? 250;
    this.keepMs = o.keepMs ?? 10 * 60_000;
    this.maxEnded = o.maxEnded ?? 256;
    this.maxWatched = o.maxWatched ?? 1024;
    this.maxWatchIds = o.maxWatchIds ?? 256;
    this.now = o.now ?? Date.now;
  }

  /** Follows the download of a request with the page's id dl: undefined for
   * a request that is not followed (not a GET, no valid id, an id in use);
   * 'refused' when the page cancelled the download before its request came
   * (the browser held it back), which is then refused. Every download in
   * progress is followed (it goes with its request). */
  track(dl: string | undefined, method: string, request: AbortSignal): Download | 'refused' | undefined {
    if (method !== 'GET' || !dl || !DOWNLOAD_ID.test(dl)) return undefined;
    if (this.ended.get(dl)?.early) return 'refused';
    if (this.running.has(dl)) return undefined;
    const d = new Download(this, dl, request);
    this.running.set(dl, d);
    this.publish(d, 'running');
    return d;
  }

  /** Sends d's progress to the page following it. */
  publish(d: Download, state: DownloadState): void {
    const w = this.watchers.get(d.id);
    if (w) w.page.send(d.event(state));
  }

  /** Records how d ended and tells the page following it, which stops. */
  finished(d: Download, ev: DownloadEvent): void {
    this.running.delete(d.id);
    this.keep(d.id, { ev, at: this.now() });
    const w = this.watchers.get(d.id);
    if (w) {
      this.watchers.delete(d.id);
      w.page.send(ev);
    }
  }

  private keep(id: string, e: Ended): void {
    this.prune();
    if (this.ended.size >= this.maxEnded) {
      // The oldest end: the first of the map's order, which is by time.
      const oldest = this.ended.keys().next().value;
      if (oldest !== undefined) this.ended.delete(oldest);
    }
    this.ended.delete(id);
    this.ended.set(id, e);
  }

  /** Forgets the ends, and the interest in ids that never came, older than
   * keepMs. */
  private prune(): void {
    const now = this.now();
    for (const [id, e] of this.ended) if (now - e.at > this.keepMs) this.ended.delete(id);
    for (const [id, w] of this.watchers) if (!this.running.has(id) && now - w.since > this.keepMs) this.watchers.delete(id);
  }

  /** What the core knows of download id: its progress, how it ended, or
   * that it does not know it. */
  private stateOf(id: string): DownloadEvent {
    const d = this.running.get(id);
    if (d) return d.event('running');
    return this.ended.get(id)?.ev ?? { t: 'download', id, state: 'unknown' };
  }

  /** Makes page the one following the downloads ids (download.watch) and
   * sends it what the core knows of each. */
  watch(page: Page, ids: readonly string[]): void {
    this.prune();
    for (const id of ids.slice(0, this.maxWatchIds)) {
      if (!DOWNLOAD_ID.test(id)) continue;
      const ev = this.stateOf(id);
      if ((ev.state === 'running' || ev.state === 'unknown') && (this.watchers.has(id) || this.watchers.size < this.maxWatched))
        this.watchers.set(id, { page, since: this.now() });
      page.send(ev);
    }
  }

  /** Stops download id for page (download.cancel): the browser's download
   * fails, and the agent's stream closes; page follows the id from then on
   * and hears how it ended. One the core has not seen counts as cancelled
   * at once, and its request is refused if it comes after all. Whether a
   * cancel was recorded (for the audit log). */
  cancel(page: Page, id: string): boolean {
    if (!DOWNLOAD_ID.test(id)) return false;
    const d = this.running.get(id);
    if (d) {
      this.watchers.set(id, { page, since: this.now() });
      d.cancel();
      return true;
    }
    let recorded = false;
    if (!this.ended.has(id)) {
      this.keep(id, { ev: { t: 'download', id, state: 'cancelled', sent: 0 }, at: this.now(), early: true });
      this.watchers.delete(id);
      recorded = true;
    }
    page.send(this.ended.get(id)!.ev);
    return recorded;
  }

  /** Drops the ids page followed (it went away). */
  forget(page: Page): void {
    for (const [id, w] of this.watchers) if (w.page === page) this.watchers.delete(id);
  }

  /** How many downloads are followed, and ids watched (for tests). */
  get sizes(): { running: number; watched: number; ended: number } {
    return { running: this.running.size, watched: this.watchers.size, ended: this.ended.size };
  }
}
