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

/** Upload into the machine's upload directory; the server picks a unique
 * file name derived from name. */
export async function uploadFile(m: string, name: string, body: Blob): Promise<RemoteStat> {
  const r = await fetch(`/api/m/${encodeURIComponent(m)}/upload?${new URLSearchParams({ name })}`, {
    method: 'POST',
    body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
}

function shellQuote(p: string): string {
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Upload pasted or dropped files to the machine's upload directory and
 * return their paths, ready to be typed into an agent prompt. */
export async function uploadPasted(m: string, files: File[]): Promise<string | undefined> {
  const paths: string[] = [];
  for (const f of files) {
    const ext = f.name.includes('.') ? '' : f.type.startsWith('image/') ? '.' + f.type.slice(6).replace('jpeg', 'jpg') : '';
    try {
      const st = await uploadFile(m, (f.name || 'paste') + ext, f);
      if (st.path) paths.push(shellQuote(st.path));
    } catch (e) {
      useStore.getState().toast(t('app.uploadFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return paths.length ? paths.join(' ') + ' ' : undefined;
}
