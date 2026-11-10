// File helpers: URLs for previews and uploads into a machine.

export function fileUrl(m: string, path: string, download = false): string {
  const q = new URLSearchParams({ path });
  if (download) q.set('download', '1');
  return `/api/m/${encodeURIComponent(m)}/file?${q}`;
}

export interface RemoteStat {
  name: string;
  path?: string;
  size: number;
  mode: number;
  mtime: number;
  is_dir: boolean;
}

export async function listDir(m: string, path: string): Promise<{ dir: RemoteStat; entries: RemoteStat[] }> {
  const r = await fetch(`/api/m/${encodeURIComponent(m)}/list?${new URLSearchParams({ path })}`);
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
 * under name, or name-1, name-2… when that is taken. XMLHttpRequest, not
 * fetch: only it reports how much of a request body is sent. */
export function uploadFile(m: string, name: string, body: Blob, dir?: string, opts: UploadOptions = {}): Promise<RemoteStat> {
  const q = new URLSearchParams({ name });
  if (dir) q.set('dir', dir);
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new UploadCancelled());
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const done = () => opts.signal?.removeEventListener('abort', abort);
    xhr.open('POST', `/api/m/${encodeURIComponent(m)}/upload?${q}`);
    // Upload listeners must be set before send().
    xhr.upload.onprogress = (e) => opts.onProgress?.(e.loaded);
    xhr.upload.onload = () => opts.onSent?.();
    xhr.onload = () => {
      done();
      let j: { error?: string } = {};
      try {
        j = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON: the status says it */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(j as RemoteStat);
      else reject(new Error(j.error ?? (xhr.statusText || `HTTP ${xhr.status}`)));
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
