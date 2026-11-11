// Uploads of files pasted or dropped into panes, for the uploads panel in
// the status bar (components/Transfers.tsx): each file's progress and speed,
// cancelling, and the history of finished uploads, which this browser keeps
// (the last HISTORY_MAX, in localStorage; names and paths, no contents).
//
// The files of one paste or drop are queued together and sent one after the
// other. A cancelled upload aborts its request; the core then closes its
// stream to the agent, which removes the temporary file it was writing, so
// nothing of it is left on the machine. Once the whole body is sent the
// agent is finishing the file, and it can no longer be cancelled.

import { create } from 'zustand';
import { storage } from './brand';
import { t } from './i18n';
import { shellQuote, UploadCancelled, UploadDisconnected, uploadFile, uploadName } from './lib/files';
import { useStore } from './state/store';

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

export const HISTORY_MAX = 50;
/** The span the speed is measured over, and how often progress is shown. */
export const SPEED_WINDOW_MS = 3000;
const SHOW_EVERY_MS = 250;
const KEY = 'uploads';
const FINISHED = new Set<TransferStatus>(['done', 'failed', 'cancelled']);

/** Finished uploads in this browser's storage; undefined when it has none
 * or cannot be read. */
function storedHistory(): Transfer[] | undefined {
  const raw = storage.get(KEY);
  if (raw === null) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x) => x && typeof x.id === 'string' && typeof x.m === 'string' && typeof x.name === 'string' && FINISHED.has(x.status))
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

interface TransfersState {
  /** Waiting, uploading and finishing, in the order they go. */
  active: Transfer[];
  /** Finished, newest first. */
  history: Transfer[];
  panel: boolean;
  setPanel(open: boolean): void;
}

export const useTransfers = create<TransfersState>((set) => ({
  active: [],
  history: storedHistory() ?? [],
  panel: false,
  // Opening shows what other tabs of this browser finished meanwhile.
  setPanel: (panel) => set(panel ? (s) => ({ panel, history: storedHistory() ?? s.history }) : { panel }),
}));

function setHistory(fn: (h: Transfer[]) => Transfer[]) {
  const history = fn(storedHistory() ?? useTransfers.getState().history).slice(0, HISTORY_MAX);
  storage.set(KEY, JSON.stringify(history));
  useTransfers.setState({ history });
}

/** What a running or waiting upload needs besides its entry. */
interface Live {
  ctl: AbortController;
  /** [time, bytes sent] over the last SPEED_WINDOW_MS. */
  samples: Array<[number, number]>;
  shown: number;
}
const live = new Map<string, Live>();
let seq = 0;

const find = (id: string) => useTransfers.getState().active.find((x) => x.id === id);

function patch(id: string, p: Partial<Transfer>) {
  useTransfers.setState((s) => ({ active: s.active.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
}

function progress(id: string, sent: number) {
  const l = live.get(id);
  if (!l) return;
  const now = Date.now();
  l.samples.push([now, sent]);
  // Keep the last sample at or before the window's start.
  while (l.samples.length > 2 && now - l.samples[1][0] >= SPEED_WINDOW_MS) l.samples.shift();
  if (now - l.shown < SHOW_EVERY_MS) return;
  l.shown = now;
  const [t0, s0] = l.samples[0];
  patch(id, { sent, speed: now > t0 ? ((sent - s0) * 1000) / (now - t0) : 0 });
}

/** Moves an upload to the history. */
function end(id: string, p: Pick<Transfer, 'status'> & Partial<Transfer>) {
  const x = find(id);
  live.delete(id);
  if (!x) return;
  const ended = Date.now();
  const done = p.status === 'done';
  const entry: Transfer = {
    ...x,
    ...p,
    ended,
    sent: done ? x.size : x.sent,
    speed: done && x.started !== undefined && ended > x.started ? (x.size * 1000) / (ended - x.started) : 0,
  };
  useTransfers.setState((s) => ({ active: s.active.filter((a) => a.id !== id) }));
  setHistory((h) => [entry, ...h.filter((e) => e.id !== id)]);
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
  for (const x of items) live.set(x.id, { ctl: new AbortController(), samples: [], shown: -Infinity });
  useTransfers.setState((s) => ({ active: [...s.active, ...items] }));
  return items.map((x) => x.id);
}

const message = (e: unknown) =>
  e instanceof UploadDisconnected ? t('transfers.disconnected') : e instanceof Error ? e.message : String(e);

/** Uploads a queued file and returns its path on the machine: into its
 * directory, else (not writable, gone) the upload directory. Undefined when
 * it was cancelled or failed; failures are shown as toasts. */
export async function runUpload(id: string, file: File): Promise<string | undefined> {
  const x = find(id);
  const l = live.get(id);
  if (!x || !l) return undefined; // cancelled while waiting
  const attempt = async (dir?: string) => {
    l.samples = [[Date.now(), 0]];
    l.shown = -Infinity;
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
        useStore.getState().toast(t('app.uploadDirFailed', { dir: x.dir, error: message(e).split(': ').pop()! }));
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
    useStore.getState().toast(t('app.uploadFailed', { error: message(e) }));
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

export function forgetUpload(id: string) {
  setHistory((h) => h.filter((e) => e.id !== id));
}

export function clearUploadHistory() {
  setHistory(() => []);
}

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
