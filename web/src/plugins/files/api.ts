// The file explorer's requests to the core (internal/plugins/files): the
// changes, the stat it polls and saving an editor's text. Listings and
// file contents come from the core's own routes (lib/files.ts).
import { hasMessage, t } from '../../i18n';

/** The state of a path on a machine. */
export interface Entry {
  path: string;
  exists: boolean;
  is_dir?: boolean;
  size: number;
  /** Unix milliseconds. */
  mtime: number;
  /** Set when the state is not known (busy, timeout, denied, failed):
   * neither there nor gone. */
  error?: string;
}

/** What a change made: the new paths, and the codes of the paths an
 * action on several failed on. */
export interface Result {
  paths?: string[];
  entry?: Entry;
  failed?: Record<string, string>;
}

/** A failure with the code the core or the machine gave. */
export class FilesError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FilesError';
  }
}

/** A save refused because the file changed since the editor loaded it;
 * current is how it is now. */
export class ConflictError extends FilesError {
  constructor(readonly current: Entry) {
    super('conflict', 'file changed');
    this.name = 'ConflictError';
  }
}

/** A failure as the user reads it. */
export function errorText(e: unknown): string {
  if (e instanceof FilesError) {
    // The message names the backup that holds the file's content.
    if (e.code === 'restore_failed') return t('files.error.restore_failed', { path: e.message.replace(/^restore_failed: /, '') });
    const k = `files.error.${e.code}`;
    return hasMessage(k) ? t(k) : e.message || e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

const base = (m: string) => `/api/m/${encodeURIComponent(m)}/p/files`;

async function answer(r: Response): Promise<unknown> {
  let j: { error?: string; message?: string; current?: Entry } = {};
  try {
    j = await r.json();
  } catch {
    /* the status says it */
  }
  if (r.status === 409 && j.error === 'conflict' && j.current) throw new ConflictError(j.current);
  if (!r.ok) throw new FilesError(j.error ?? `http_${r.status}`, j.message ?? r.statusText);
  return j;
}

async function change(m: string, action: string, body: Record<string, unknown>): Promise<Result> {
  const r = await fetch(`${base(m)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await answer(r)) as Result;
}

export const filesApi = {
  mkdir: (m: string, path: string) => change(m, 'mkdir', { path }),
  /** A new empty file; fails when the name is taken. */
  create: (m: string, path: string) => change(m, 'create', { path }),
  /** Renames or moves one path; never replaces anything. */
  rename: (m: string, path: string, to: string) => change(m, 'rename', { path, to }),
  /** Moves paths into dir under their names; taken names fail. */
  move: (m: string, paths: string[], dir: string) => change(m, 'move', { paths, dir }),
  /** Copies paths into dir ("name copy" when the name is taken). */
  copy: (m: string, paths: string[], dir: string) => change(m, 'copy', { paths, dir }),
  trash: (m: string, paths: string[]) => change(m, 'trash', { paths }),
  /** Deletes for good. */
  remove: (m: string, paths: string[]) => change(m, 'remove', { paths }),

  /** The state of paths (at most 200; a POST, as their URL would be too
   * long for proxies, that changes nothing). */
  async stat(m: string, paths: string[]): Promise<Entry[]> {
    const r = await fetch(`${base(m)}/stat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    const j = (await answer(r)) as { entries?: Entry[] };
    return j.entries ?? [];
  },

  /** Saves text into path: the file must be as loaded (mtime and size), or
   * not exist ('new'), unless 'force'. A file changed meanwhile throws
   * ConflictError. */
  async write(m: string, path: string, text: string, expect: { mtime: number; size: number } | 'new' | 'force'): Promise<Result> {
    const q = new URLSearchParams({ path });
    if (expect === 'new') q.set('new', '1');
    else if (expect === 'force') q.set('force', '1');
    else {
      q.set('mtime', String(expect.mtime));
      q.set('size', String(expect.size));
    }
    const r = await fetch(`${base(m)}/write?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new TextEncoder().encode(text),
    });
    return (await answer(r)) as Result;
  },
};
