// Uploads of files pasted or dropped into panes, for the uploads panel in
// the status bar (components/Transfers.tsx): each file's progress and speed,
// cancelling, and the history of finished uploads, which this browser keeps
// (the last HISTORY_MAX, in localStorage; names and paths, no contents).
//
// The files of one paste or drop are queued together and sent one after the
// other. A cancelled upload aborts its request; the hub then closes its
// stream to the agent, which removes the temporary file it was writing, so
// nothing of it is left on the machine. Once the whole body is sent the
// agent is finishing the file, and it can no longer be cancelled.

import { t } from './i18n';
import { shellQuote, UploadCancelled, UploadDisconnected, uploadFile, uploadName, type UploadOptions } from './lib/files';
import { useStore } from './state/store';
import { Speed, transferList } from './transferList';

export { HISTORY_MAX, SPEED_WINDOW_MS } from './transferList';

export type TransferStatus = 'queued' | 'uploading' | 'finishing' | 'done' | 'failed' | 'cancelled';

export interface Transfer {
  id: string;
  /** The machine's id, and its name when the upload started. */
  m: string;
  machine: string;
  name: string;
  size: number;
  /** The directory asked for; undefined for the machine's upload directory,
   * also after the directory refused the file. */
  dir?: string;
  status: TransferStatus;
  sent: number;
  /** Bytes per second: over the last seconds while uploading, on average
   * once done. */
  speed: number;
  started?: number;
  ended?: number;
  /** Where the file is on the machine, once done. */
  path?: string;
  error?: string;
}

const FINISHED = new Set<unknown>(['done', 'failed', 'cancelled']);

const list = transferList<Transfer>('uploads', (x) => typeof x.m === 'string' && typeof x.name === 'string' && FINISHED.has(x.status));

/** Waiting, uploading and finishing uploads in the order they go, and the
 * finished ones. */
export const useTransfers = list.store;

/** What a running or waiting upload needs besides its entry. */
interface Live {
  ctl: AbortController;
  speed?: Speed;
}
const live = new Map<string, Live>();
let seq = 0;

const find = list.find;
const patch = list.patch;

function progress(id: string, sent: number) {
  const speed = live.get(id)?.speed?.add(sent);
  if (speed !== undefined) patch(id, { sent, speed });
}

/** Moves an upload to the history. */
function end(id: string, p: Pick<Transfer, 'status'> & Partial<Transfer>) {
  const x = find(id);
  live.delete(id);
  if (!x) return;
  const ended = Date.now();
  const done = p.status === 'done';
  list.archive({
    ...x,
    ...p,
    ended,
    sent: done ? x.size : x.sent,
    speed: done && x.started !== undefined && ended > x.started ? (x.size * 1000) / (ended - x.started) : 0,
  });
}

/** Queues uploads of files to machine m, into the existing directory dir or
 * the machine's upload directory. */
export function queueUploads(m: string, files: File[], dir?: string): string[] {
  const machine = useStore.getState().machines[m]?.label ?? m;
  const items = files.map((f): Transfer => ({
    id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
    m,
    machine,
    name: uploadName(f),
    size: f.size,
    dir,
    status: 'queued',
    sent: 0,
    speed: 0,
  }));
  for (const x of items) live.set(x.id, { ctl: new AbortController() });
  list.add(items);
  return items.map((x) => x.id);
}

/** A failure as the user reads it; errors that know their text (the file
 * explorer's codes) give it with userText. */
const message = (e: unknown) =>
  e instanceof UploadDisconnected
    ? t('transfers.disconnected')
    : e && typeof (e as { userText?: unknown }).userText === 'function'
      ? (e as { userText(): string }).userText()
      : e instanceof Error
        ? e.message
        : String(e);

/** Uploads a queued file and returns its path on the machine: into its
 * directory, else (not writable, gone) the upload directory. Undefined when
 * it was cancelled or failed; failures are shown as toasts. */
export async function runUpload(id: string, file: File): Promise<string | undefined> {
  const x = find(id);
  const l = live.get(id);
  if (!x || !l) return undefined; // cancelled while waiting
  const attempt = async (dir?: string) => {
    l.speed = new Speed();
    patch(id, { status: 'uploading', dir, sent: 0, speed: 0 });
    const st = await uploadFile(x.m, x.name, file, dir, {
      signal: l.ctl.signal,
      onProgress: (n) => progress(id, n),
      onSent: () => patch(id, { status: 'finishing', sent: x.size }),
    });
    return st.path;
  };
  const into = async () => {
    if (x.dir) {
      try {
        return await attempt(x.dir);
      } catch (e) {
        if (e instanceof UploadCancelled || e instanceof UploadDisconnected) throw e;
        // The cause only ("permission denied"): the rest repeats the path.
        useStore
          .getState()
          .toast(t('app.uploadDirFailed', { dir: x.dir, error: message(e).split(': ').pop()! }), undefined, undefined, 'error');
      }
    }
    return attempt(undefined);
  };
  patch(id, { started: Date.now() });
  try {
    const path = await into();
    end(id, { status: 'done', path });
    return path;
  } catch (e) {
    if (e instanceof UploadCancelled) {
      end(id, { status: 'cancelled' });
      return undefined;
    }
    end(id, { status: 'failed', error: message(e) });
    useStore.getState().toast(t('app.uploadFailed', { error: message(e) }), undefined, undefined, 'error');
  }
}

/** Uploads files to machine m one after the other (see queueUploads); the
 * paths of those that arrived, in order, undefined for the others. */
export async function uploadFiles(m: string, files: File[], dir?: string): Promise<Array<string | undefined>> {
  const ids = queueUploads(m, files, dir);
  const out: Array<string | undefined> = [];
  for (let k = 0; k < files.length; k++) out.push(await runUpload(ids[k], files[k]));
  return out;
}

/** An upload into a place chosen on the machine (the file explorer's
 * folders): a file, or a folder whose files go one after the other and
 * show as one upload. */
export interface PlacedUpload {
  /** The file's or the folder's name. */
  name: string;
  /** The folder it goes into. */
  dir: string;
  files: File[];
  /** Sends files[k]; resolves with where it landed. */
  send(k: number, opts: UploadOptions): Promise<string>;
  /** Where a folder is once its files arrived (else the last file's path). */
  path?: string;
}

/** Uploads items to machine m one after the other, each shown as one
 * upload with the progress of its files together; a folder goes on after
 * a file that failed and fails once its files went, saying how many; a
 * cancelled one stops (what arrived stays). Where each item is, undefined
 * for those cancelled or failed. */
export async function uploadPlaced(m: string, items: PlacedUpload[]): Promise<Array<string | undefined>> {
  const machine = useStore.getState().machines[m]?.label ?? m;
  const entries = items.map((it): Transfer => ({
    id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
    m,
    machine,
    name: it.name,
    size: it.files.reduce((n, f) => n + f.size, 0),
    dir: it.dir,
    status: 'queued',
    sent: 0,
    speed: 0,
  }));
  for (const x of entries) live.set(x.id, { ctl: new AbortController() });
  list.add(entries);
  const out: Array<string | undefined> = [];
  for (let k = 0; k < items.length; k++) out.push(await runPlaced(entries[k].id, items[k]));
  return out;
}

async function runPlaced(id: string, it: PlacedUpload): Promise<string | undefined> {
  const x = find(id);
  const l = live.get(id);
  if (!x || !l) return undefined; // cancelled while waiting
  l.speed = new Speed();
  patch(id, { status: 'uploading', started: Date.now() });
  let done = 0;
  let last: string | undefined;
  const failed: Array<[string, unknown]> = [];
  for (let k = 0; k < it.files.length; k++) {
    const f = it.files[k];
    const base = done;
    try {
      last = await it.send(k, {
        signal: l.ctl.signal,
        onProgress: (n) => progress(id, base + n),
        onSent: () => (k === it.files.length - 1 ? patch(id, { status: 'finishing', sent: x.size }) : progress(id, base + f.size)),
      });
    } catch (e) {
      if (e instanceof UploadCancelled) {
        end(id, { status: 'cancelled' });
        return undefined;
      }
      if (e instanceof UploadDisconnected) {
        failed.push([f.name, e]);
        break;
      }
      failed.push([f.name, e]);
    }
    done += f.size;
  }
  if (failed.length) {
    const [name, e] = failed[0];
    const error =
      it.files.length > 1 ? t('transfers.someFailed', { n: failed.length, total: it.files.length, name, error: message(e) }) : message(e);
    end(id, { status: 'failed', error });
    useStore.getState().toast(t('app.uploadFailed', { error }), undefined, undefined, 'error');
    return undefined;
  }
  const path = it.path ?? last;
  end(id, { status: 'done', path });
  return path;
}

/** Uploads pasted files to the machine's upload directory and returns their
 * paths, ready to be pasted into an agent prompt. */
export async function uploadPasted(m: string, files: File[]): Promise<string | undefined> {
  const paths = (await uploadFiles(m, files)).filter((p): p is string => !!p);
  return paths.length ? paths.map(shellQuote).join(' ') + ' ' : undefined;
}

/** Whether an upload can still be cancelled: not once the agent is
 * finishing the file. */
export const cancellable = (x: Transfer) => x.status === 'queued' || x.status === 'uploading';

/** Cancels an upload: a waiting one never starts, a running one stops. */
export function cancelUpload(id: string) {
  const x = find(id);
  if (!x || !cancellable(x)) return;
  live.get(id)?.ctl.abort();
  // A running upload ends when its request does (runUpload).
  if (x.status === 'queued') end(id, { status: 'cancelled' });
}

export function cancelAllUploads() {
  for (const x of useTransfers.getState().active) cancelUpload(x.id);
}

export const forgetUpload = list.forget;

export const clearUploadHistory = list.clear;

/** Sent and total bytes of the active uploads. */
export function activeProgress(active: Transfer[]): { sent: number; size: number } {
  let sent = 0;
  let size = 0;
  for (const x of active) {
    sent += x.sent;
    size += x.size;
  }
  return { sent, size };
}
