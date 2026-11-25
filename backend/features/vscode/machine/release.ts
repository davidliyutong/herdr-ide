// code-server's releases on a machine: a tarball the core uploads or the
// machine downloads lands in a file beside the releases, hashed as it is
// written; only a tarball of the digest the core knows is unpacked, into a
// directory of its own that becomes the release once its executable is
// there and its Node runs on this machine. Other releases unused for
// RELEASE_RETENTION_MS go (docs/deployment.md#remote-resources).
//
// Nothing here holds the node's thread: the file is written and read with
// fs/promises in chunks, the tarball is gunzipped by zlib's stream (its
// work in the runtime's pool) and unpacked by node-tar, which parses the
// headers on the thread a block at a time and writes with asynchronous
// calls; curl, wget and the release's Node are processes of their own.
// Unpacking code-server 4.144.0 (210 MB, 7204 entries, 600 MB unpacked)
// held the thread for at most 2 ms at a time.
//
// Unpacking refuses the whole archive on an absolute path, a ".." in a path,
// a link (symbolic or hard) whose target leaves the release's directory, or
// an entry that is not a directory, a regular file or a link; node-tar's
// strict mode refuses besides what it would otherwise skip or rewrite (an
// entry through a link, a path too deep). Modes keep the owner's bits and
// the read and execute bits of others (no setuid, setgid, sticky or
// write bits for others), and files belong to the user.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, utimes } from 'node:fs/promises';
import { posix } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract, type ReadEntry } from 'tar';
import { Fail } from '#shared/lib/fail.ts';
import type { Logger } from '#shared/lib/log.ts';
import { isExecutable, lastN, lookPath, run, runError } from './process.ts';
import { releaseDir, type Layout } from './layout.ts';

const DAY = 24 * 60 * 60_000;
/** Releases unused this long go (a start touches its release, and so does
 * housekeeping while it runs). */
export const RELEASE_RETENTION_MS = 14 * DAY;
/** What an interrupted install left beside the releases goes after this
 * long: an upload, a download, a directory being unpacked. */
export const STAGING_RETENTION_MS = DAY;

/** Bounds a tarball (code-server's are about 200 MB) and what it unpacks
 * to (about 600 MB). */
export interface ReleaseLimits {
  maxTarball: number;
  maxUnpacked: number;
  /** How long a download may take, the whole of it. */
  downloadMs: number;
  /** How long the release's Node may take to say its version. */
  nodeCheckMs: number;
}

export const RELEASE_LIMITS: ReleaseLimits = {
  maxTarball: 1 << 30,
  maxUnpacked: 4 * (1 << 30),
  downloadMs: 20 * 60_000,
  nodeCheckMs: 20_000,
};

/** A staged file's or directory's name beside the releases. */
const STAGED = /^\.(upload|download|install|old)-/;
const staged = (l: Layout, kind: 'upload' | 'download' | 'install' | 'old') =>
  posix.join(l.root, `.${kind}-${process.pid}-${randomBytes(6).toString('hex')}`);

/** A tarball staged beside the releases, with its SHA-256. */
export interface Staged {
  file: string;
  digest: string;
}

/** Writes chunks to a new file beside the releases, hashing them; at most
 * max bytes. */
export async function receive(l: Layout, chunks: AsyncIterable<Buffer>, max: number): Promise<Staged> {
  await mkdir(l.root, { recursive: true, mode: 0o755 });
  const file = staged(l, 'upload');
  const fh = await open(file, 'wx', 0o600);
  try {
    const hash = createHash('sha256');
    let n = 0;
    for await (const b of chunks) {
      n += b.length;
      if (n > max) throw new Error(`the tarball is larger than ${max} bytes`);
      hash.update(b);
      await fh.write(b);
    }
    await fh.close();
    return { file, digest: hash.digest('hex') };
  } catch (e) {
    await fh.close().catch(() => {});
    await rm(file, { force: true });
    throw e;
  }
}

/** The SHA-256 of a file, read in chunks. */
export async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const b of createReadStream(file, { highWaterMark: 256 << 10 })) hash.update(b as Buffer);
  return hash.digest('hex');
}

/** Checks that url is one a machine may fetch: http or https, with a host. */
export function downloadURL(url: string | undefined): URL {
  let u: URL;
  try {
    u = new URL(url ?? '');
  } catch {
    throw new Fail('bad_params', 400, `bad download URL ${JSON.stringify(url ?? '')}`);
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hostname === '')
    throw new Fail('bad_params', 400, `bad download URL ${JSON.stringify(url)}`);
  return u;
}

/** Fetches url with the machine's curl, else wget (so its proxy and CA
 * settings apply), into a file beside the releases, bounded in size and in
 * time; signal ends it. */
export async function download(
  l: Layout,
  url: string,
  o: { env: Record<string, string>; signal: AbortSignal; limits?: Partial<ReleaseLimits> },
): Promise<Staged> {
  const lim = { ...RELEASE_LIMITS, ...o.limits };
  const u = downloadURL(url);
  const curl = await lookPath('curl', o.env.PATH);
  const wget = curl ? null : await lookPath('wget', o.env.PATH);
  if (!curl && !wget) throw new Error('neither curl nor wget is available on the machine');
  await mkdir(l.root, { recursive: true, mode: 0o755 });
  const file = staged(l, 'download');
  await (await open(file, 'wx', 0o600)).close();
  const ac = new AbortController();
  const stop = () => ac.abort();
  o.signal.addEventListener('abort', stop, { once: true });
  // The tool knows no bound for what it writes (curl's --max-filesize trusts
  // the length the server announces): its file is watched.
  let tooLarge = false;
  const watch = setInterval(() => {
    void lstat(file).then(
      (st) => {
        if (st.size > lim.maxTarball) {
          tooLarge = true;
          ac.abort();
        }
      },
      () => {},
    );
  }, 1000);
  try {
    const args = curl
      ? ['-fsSL', '--retry', '2', '--proto', '=http,https', '--proto-redir', '=http,https', '-o', file, u.href]
      : ['-q', '-O', file, u.href];
    const r = await run(curl ?? wget!, args, { env: o.env, timeoutMs: lim.downloadMs, signal: ac.signal });
    if (tooLarge) throw new Error(`download ${u.href}: larger than ${lim.maxTarball} bytes`);
    const err = runError(r);
    if (err) throw new Error(`download ${u.href}: ${err} ${lastN(r.out, 400)}`.trim());
    return { file, digest: await sha256Of(file) };
  } catch (e) {
    await rm(file, { force: true });
    throw e;
  } finally {
    clearInterval(watch);
    o.signal.removeEventListener('abort', stop);
  }
}

/** Why an entry of a release's tarball refuses the archive, "" when it may
 * be unpacked. name is its path in the archive, whose first component (the
 * release's own directory) is stripped. */
export function refusal(name: string, type: string, linkpath = ''): string {
  if (name.startsWith('/')) return `${name}: an absolute path`;
  const parts = name.split('/');
  if (parts.includes('..')) return `${name}: a path with ".."`;
  const rel = parts.slice(1).join('/');
  switch (type) {
    case 'Directory':
    case 'File':
    case 'OldFile':
    case 'ContiguousFile':
      return '';
    case 'SymbolicLink': {
      if (linkpath.startsWith('/')) return `${name}: a link to an absolute path`;
      const target = posix.normalize(posix.join(posix.dirname(rel), linkpath));
      if (target === '..' || target.startsWith('../')) return `${name}: a link leaving the release`;
      return '';
    }
    case 'Link':
      // A hard link names its target from the archive's root.
      if (linkpath.startsWith('/') || linkpath.split('/').includes('..')) return `${name}: a link leaving the release`;
      return '';
  }
  return `${name}: an entry of type ${type}`;
}

/** The mode an entry is written with: the owner's bits (and the owner may
 * always read and write it), others' read and execute bits. */
export const entryMode = (mode: number, dir: boolean): number => (mode & 0o755) | (dir ? 0o700 : 0o600);

/** Unpacks a release's tarball into dest (which exists), its top
 * directory stripped; throws when an entry refuses it (refusal) or it
 * unpacks to more than maxUnpacked bytes. */
export async function unpack(tarball: string, dest: string, maxUnpacked = RELEASE_LIMITS.maxUnpacked): Promise<void> {
  let refused: Error | null = null;
  let n = 0;
  const x = extract({
    cwd: dest,
    strip: 1,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    noMtime: true,
    filter: (path: string, entry: unknown) => {
      if (refused) return false;
      const e = entry as ReadEntry;
      const why = refusal(path, e.type, e.linkpath ?? '');
      if (why) {
        refused = new Error(`the tarball has ${why}`);
        x.abort(refused);
        return false;
      }
      if (typeof e.mode === 'number') e.mode = entryMode(e.mode, e.type === 'Directory');
      return true;
    },
  });
  const count = new Transform({
    transform(b: Buffer, _enc, cb) {
      n += b.length;
      if (n > maxUnpacked) cb(new Error(`the tarball unpacks to more than ${maxUnpacked} bytes`));
      else cb(null, b);
    },
  });
  try {
    await pipeline(createReadStream(tarball, { highWaterMark: 256 << 10 }), createGunzip(), count, x);
  } catch (e) {
    throw refused ?? e;
  }
  if (refused) throw refused;
}

/** Installs the staged tarball as release version: checked against expected
 * (the digest the core knows; none when it knows none) before anything is
 * unpacked, unpacked beside the releases, accepted when it holds
 * bin/code-server and its Node runs here, then put in place of what was
 * there. Other releases unused for long go. The staged file stays the
 * caller's. */
export async function install(
  l: Layout,
  version: string,
  tarball: Staged,
  o: { expected?: string; what?: string; env: Record<string, string>; logger: Logger; limits?: Partial<ReleaseLimits>; now?: Date },
): Promise<void> {
  const lim = { ...RELEASE_LIMITS, ...o.limits };
  const want = (o.expected ?? '').toLowerCase();
  if (want && tarball.digest !== want)
    throw new Error(`${o.what ?? 'the tarball'}: sha256 ${tarball.digest} does not match expected ${want}`);
  const tmp = staged(l, 'install');
  await mkdir(tmp, { mode: 0o755 });
  try {
    await unpack(tarball.file, tmp, lim.maxUnpacked);
    if (!(await isExecutable(posix.join(tmp, 'bin', 'code-server')))) throw new Error('tarball does not contain bin/code-server');
    // The bundled Node must run here (an old glibc is the usual failure).
    const r = await run(posix.join(tmp, 'lib', 'node'), ['--version'], { env: o.env, timeoutMs: lim.nodeCheckMs, cwd: tmp });
    const err = runError(r);
    if (err) throw new Error(`code-server's node cannot run on this machine (glibc too old?): ${err} ${lastN(r.out, 400)}`.trim());
    const now = o.now ?? new Date();
    await utimes(tmp, now, now);
    const final = releaseDir(l, version);
    const old = staged(l, 'old');
    let moved = false;
    try {
      await rename(final, old);
      moved = true;
    } catch {
      // none there
    }
    await rename(tmp, final);
    if (moved) await rm(old, { recursive: true, force: true });
    await pruneReleases(l, posix.basename(final), now, o.logger);
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Removes the releases other than keep unused for RELEASE_RETENTION_MS
 * and what interrupted installs left there for STAGING_RETENTION_MS (both
 * by the entry's own time: a link is removed, never followed). */
export async function pruneReleases(l: Layout, keep: string, now: Date, logger: Logger): Promise<void> {
  let names: string[];
  try {
    names = await readdir(l.root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keep) continue;
    const p = posix.join(l.root, name);
    try {
      const age = now.getTime() - (await lstat(p)).mtimeMs;
      if (age < (STAGED.test(name) ? STAGING_RETENTION_MS : RELEASE_RETENTION_MS)) continue;
      await rm(p, { recursive: true, force: true });
    } catch (e) {
      logger(`code-server: prune ${name}: ${(e as Error).message}`);
    }
  }
}
