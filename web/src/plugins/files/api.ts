// The file explorer's requests to the hub (backend/features/files): the
// changes, the stat it polls and saving an editor's text. Listings and
// file contents come from the hub's own routes (lib/files.ts).
import { t } from '../../i18n';
import { sendBody, type UploadOptions } from '../../lib/files';
import { answer, failureCode, jsonInit, makeErrorText, PluginError, type AnswerBody } from '../../lib/pluginApi';

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

/** One file or directory returned by GET /api/m/{id}/p/files/find. */
export interface FindMatch {
  path: string;
  rel: string;
  name: string;
  is_dir?: boolean;
}

export interface FindResult {
  matches: FindMatch[];
  truncated?: boolean;
}

export interface FindParams {
  dir: string;
  query: string;
  match?: 'fuzzy' | 'name';
  regex?: boolean;
  hidden?: boolean;
  exclude?: readonly string[];
  limit?: number;
}

/** A failure with the code the hub or the machine gave. */
export class FilesError extends PluginError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'FilesError';
  }

  /** The failure as the user reads it (the uploads panel asks). */
  userText(): string {
    return errorText(this);
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
export const errorText = makeErrorText(FilesError, 'files.error', {
  // The message is the cause's code; also distinguish legacy agents' EROFS
  // (code 'read_only' with OS message) from hub read-only mode.
  special: (e) => {
    if (e.code === 'partial_write')
      return t(e.message.endsWith('no_space') ? 'files.error.partial_write.no_space' : 'files.error.partial_write');
    if (e.code === 'read_only' && e.message && e.message !== 'read-only mode') return t('files.error.read_only_fs');
    return undefined;
  },
});

const base = (m: string) => `/api/m/${encodeURIComponent(m)}/p/files`;

/** A failed answer's error; a 409 that says how the file is now is a
 * save's conflict. */
function failure(r: Response, j: AnswerBody): Error {
  if (r.status === 409 && j.error === 'conflict' && j.current) return new ConflictError(j.current as Entry);
  return new FilesError(failureCode(r, j), j.message ?? r.statusText);
}

const post = async <T>(m: string, action: string, body: Record<string, unknown>): Promise<T> =>
  answer<T>(await fetch(`${base(m)}/${action}`, jsonInit('POST', body)), failure);

const change = (m: string, action: string, body: Record<string, unknown>) => post<Result>(m, action, body);

export const filesApi = {
  /** A new folder; a taken name fails, or with unique becomes name-1… */
  mkdir: (m: string, path: string, o: { unique?: boolean } = {}) => change(m, 'mkdir', o.unique ? { path, unique: true } : { path }),
  /** Folders with the folders leading to them; those there are kept. */
  mkdirs: (m: string, paths: string[]) => change(m, 'mkdirs', { paths }),
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
    return (await post<{ entries?: Entry[] }>(m, 'stat', { paths })).entries ?? [];
  },

  /** Bounded recursive file/directory search below dir. */
  async find(m: string, p: FindParams, signal?: AbortSignal): Promise<FindResult> {
    const q = new URLSearchParams({ dir: p.dir });
    if (p.query) q.set('query', p.query);
    if (p.match) q.set('match', p.match);
    if (p.regex) q.set('regex', '1');
    if (p.hidden !== undefined) q.set('hidden', p.hidden ? '1' : '0');
    if (p.limit !== undefined) q.set('limit', String(p.limit));
    if (p.exclude !== undefined) {
      if (p.exclude.length === 0) q.append('exclude', '');
      else for (const pat of p.exclude) q.append('exclude', pat);
    }
    const r = await fetch(`${base(m)}/find?${q}`, { cache: 'no-store', signal });
    const data = await answer<FindResult>(r, failure);
    return { matches: Array.isArray(data.matches) ? data.matches : [], truncated: data.truncated };
  },

  /** Shows path in the file manager of the hub's own computer (Finder on
   * macOS): only for its own machine, from a page on that computer. */
  reveal: (m: string, path: string) => change(m, 'reveal', { path }),

  /** Whether reveal is offered to this page for machine m's paths. */
  async revealAvailable(m: string): Promise<boolean> {
    const r = await fetch(`${base(m)}/reveal`, { cache: 'no-store' });
    return !!(await answer<{ available?: boolean }>(r, failure)).available;
  },

  /** Uploads a file from this computer into path: under a free name
   * (name-1.ext… when taken), or over the file there with replace, as a
   * save writes it. Resolves with where it landed; progress and
   * cancelling as lib/files' uploads. */
  async upload(m: string, path: string, file: Blob, o: UploadOptions & { replace?: boolean } = {}): Promise<string> {
    const q = new URLSearchParams({ path });
    if (o.replace) q.set('replace', '1');
    const r = (await sendBody(`${base(m)}/upload?${q}`, file, {
      ...o,
      failure: (status, j) => new FilesError(j.error === 'too_large' ? 'upload_too_large' : (j.error ?? `http_${status}`), j.message ?? ''),
    })) as Result;
    return r.paths?.[0] ?? path;
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
    return answer<Result>(r, failure);
  },
};
