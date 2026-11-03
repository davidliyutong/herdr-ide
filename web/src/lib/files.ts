// File helpers: URLs for previews and uploads into a machine.

import { useStore } from '../state/store';
import { t } from '../i18n';
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

/** Upload into the machine's upload directory, where the server picks a
 * unique file name derived from name, or into the existing directory dir
 * under name, or name-1, name-2… when that is taken. */
export async function uploadFile(m: string, name: string, body: Blob, dir?: string): Promise<RemoteStat> {
  const q = new URLSearchParams({ name });
  if (dir) q.set('dir', dir);
  const r = await fetch(`/api/m/${encodeURIComponent(m)}/upload?${q}`, {
    method: 'POST',
    body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
}

export function shellQuote(p: string): string {
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Uploads a pasted or dropped file into dir on the machine, or its upload
 * directory, and returns its path there. When dir does not take it (not
 * writable, gone), the upload directory does; failures are shown as toasts. */
export async function uploadAs(m: string, f: File, dir?: string): Promise<string | undefined> {
  const ext = f.name.includes('.') ? '' : f.type.startsWith('image/') ? '.' + f.type.slice(6).replace('jpeg', 'jpg') : '';
  const name = (f.name || 'paste') + ext;
  const { toast } = useStore.getState();
  if (dir) {
    try {
      return (await uploadFile(m, name, f, dir)).path;
    } catch (e) {
      // The cause only ("permission denied"): the rest repeats the path.
      toast(t('app.uploadDirFailed', { dir, error: message(e).split(': ').pop()! }));
    }
  }
  try {
    return (await uploadFile(m, name, f)).path;
  } catch (e) {
    toast(t('app.uploadFailed', { error: message(e) }));
  }
}

/** Upload pasted files to the machine's upload directory and return their
 * paths, ready to be pasted into an agent prompt. */
export async function uploadPasted(m: string, files: File[]): Promise<string | undefined> {
  const paths: string[] = [];
  for (const f of files) {
    const p = await uploadAs(m, f);
    if (p) paths.push(shellQuote(p));
  }
  return paths.length ? paths.join(' ') + ' ' : undefined;
}
