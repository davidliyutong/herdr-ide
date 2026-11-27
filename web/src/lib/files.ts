// File helpers: URLs for previews and uploads into a machine.
import { viaDesktop } from './transport';

export function fileUrl(m: string, path: string, download = false): string {
  const q = new URLSearchParams({ path });
  if (download) q.set('download', '1');
  return `/api/m/${encodeURIComponent(m)}/file?${q}`;
}

/** URL saving paths of machine m: one file as itself, a directory or
 * several paths as one zip archive. */
export function downloadUrl(m: string, paths: string[]): string {
  const q = new URLSearchParams();
  for (const p of paths) q.append('path', p);
  return `/api/m/${encodeURIComponent(m)}/download?${q}`;
}

export interface RemoteStat {
  name: string;
  path?: string;
  size: number;
  mode: number;
  mtime: number;
  is_dir: boolean;
}

export async function listDir(m: string, path: string, signal?: AbortSignal): Promise<{ dir: RemoteStat; entries: RemoteStat[] }> {
  const r = await fetch(`/api/m/${encodeURIComponent(m)}/list?${new URLSearchParams({ path })}`, signal ? { signal } : undefined);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
}

/** An upload ended by its signal. */
export class UploadCancelled extends Error {
  constructor() {
    super('upload cancelled');
    this.name = 'UploadCancelled';
  }
}

/** An upload that lost its connection to the server. */
export class UploadDisconnected extends Error {
  constructor() {
    super('connection lost');
    this.name = 'UploadDisconnected';
  }
}

export interface UploadOptions {
  /** Bytes of the body sent so far. */
  onProgress?(sent: number): void;
  /** The whole body is sent; the server is writing the file. */
  onSent?(): void;
  /** Aborts the request; the agent then removes what it wrote. */
  signal?: AbortSignal;
}

/** Upload into the machine's upload directory, where the server picks a
 * unique file name derived from name, or into the existing directory dir
 * under name, or name-1, name-2… when that is taken. */
export function uploadFile(m: string, name: string, body: Blob, dir?: string, opts: UploadOptions = {}): Promise<RemoteStat> {
  const q = new URLSearchParams({ name });
  if (dir) q.set('dir', dir);
  return sendBody(`/api/m/${encodeURIComponent(m)}/upload?${q}`, body, opts) as Promise<RemoteStat>;
}

type SendOptions = UploadOptions & { failure?(status: number, answer: { error?: string; message?: string }): Error };

/** The error of a failed answer. */
function failed(status: number, statusText: string, j: { error?: string; message?: string }, opts: SendOptions): Error {
  if (opts.failure) return opts.failure(status, j);
  return new Error(j.error ?? (statusText || `HTTP ${status}`));
}

/** POSTs body to url with the progress and cancelling of uploadFile, and
 * resolves with the JSON answer. A failure rejects with failure(status,
 * answer), by default an Error with the answer's error. In a browser it is
 * an XMLHttpRequest: only it reports how much of a request body is sent.
 * The desktop app's shell gets an XMLHttpRequest's body whole, without
 * progress, so there it is a fetch with the body streamed: what the shell
 * pulled of it is what was sent. */
export function sendBody(url: string, body: Blob, opts: SendOptions = {}): Promise<unknown> {
  if (opts.signal?.aborted) return Promise.reject(new UploadCancelled());
  return viaDesktop ? streamBody(url, body, opts) : xhrBody(url, body, opts);
}

function xhrBody(url: string, body: Blob, opts: SendOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const done = () => opts.signal?.removeEventListener('abort', abort);
    xhr.open('POST', url);
    // Upload listeners must be set before send().
    xhr.upload.onprogress = (e) => opts.onProgress?.(e.loaded);
    xhr.upload.onload = () => opts.onSent?.();
    xhr.onload = () => {
      done();
      let j: { error?: string; message?: string } = {};
      try {
        j = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON: the status says it */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(j);
      else reject(failed(xhr.status, xhr.statusText, j, opts));
    };
    xhr.onerror = () => {
      done();
      reject(new UploadDisconnected());
    };
    xhr.onabort = () => {
      done();
      reject(new UploadCancelled());
    };
    opts.signal?.addEventListener('abort', abort);
    xhr.send(body);
  });
}

async function streamBody(url: string, body: Blob, opts: SendOptions): Promise<unknown> {
  const reader = body.stream().getReader();
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        const { done, value } = await reader.read();
        if (done) {
          c.close();
          opts.onSent?.();
          return;
        }
        sent += value.byteLength;
        c.enqueue(value);
        opts.onProgress?.(sent);
      },
      cancel: (why) => reader.cancel(why),
    },
    { highWaterMark: 0 },
  );
  let res: Response;
  try {
    // duplex: a streamed body (not in the DOM types yet).
    res = await fetch(url, { method: 'POST', body: stream, signal: opts.signal, duplex: 'half' } as RequestInit);
  } catch {
    throw opts.signal?.aborted ? new UploadCancelled() : new UploadDisconnected();
  }
  let j: { error?: string; message?: string } = {};
  try {
    j = await res.json();
  } catch {
    if (opts.signal?.aborted) throw new UploadCancelled();
    /* not JSON: the status says it */
  }
  if (res.ok) return j;
  throw failed(res.status, res.statusText, j, opts);
}

/** The name a pasted or dropped file is uploaded under: clipboard images
 * may have no name or extension. */
export function uploadName(f: File): string {
  const ext = f.name.includes('.') ? '' : f.type.startsWith('image/') ? '.' + f.type.slice(6).replace('jpeg', 'jpg') : '';
  return (f.name || 'paste') + ext;
}

export function shellQuote(p: string): string {
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
