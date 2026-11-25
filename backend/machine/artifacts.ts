// What a feature fetches onto a machine (code-server's releases, the chat
// host's Agent SDK): a file the core uploads or the machine downloads
// lands beside the feature's directory of versions (root), hashed as it is
// written, and a tarball is unpacked only once the feature checked it
// against the digest it trusts. Versions unused for long go, and what an
// interrupted install left goes sooner.
//
// Nothing here holds the node's thread: files are written and read with
// fs/promises in chunks, a tarball is gunzipped by zlib's stream (its work
// in the runtime's pool) and unpacked by node-tar, which parses the headers
// on the thread a block at a time and writes with asynchronous calls; curl
// and wget are processes of their own, run with the user's configuration
// files ignored (curl -q, wget's --no-config).
//
// Unpacking refuses the whole archive on an absolute path, a ".." in a path,
// a link (symbolic or hard) whose target leaves the directory, or an entry
// that is not a directory, a regular file or a link; node-tar's strict mode
// refuses besides what it would otherwise skip or rewrite (an entry through
// a link, a path too deep). Modes keep the owner's bits and the read and
// execute bits of others (no setuid, setgid, sticky or write bits for
// others), and files belong to the user.
import { createHash, randomBytes, type BinaryToTextEncoding } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { posix } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract, type ReadEntry } from 'tar';
import { Fail } from '#shared/lib/fail.ts';
import type { Logger } from '#shared/lib/log.ts';
import { lastN, lookPath, run, runError } from './programs.ts';

/** Where a feature keeps its versions: what is fetched or unpacked is
 * staged beside them. */
export interface ArtifactRoot {
  readonly root: string;
}

/** A staged file's or directory's name beside the versions. */
export const STAGED = /^\.(upload|download|install|old)-/;

/** A new name beside the versions for what is staged there. */
export const staged = (l: ArtifactRoot, kind: 'upload' | 'download' | 'install' | 'old'): string =>
  posix.join(l.root, `.${kind}-${process.pid}-${randomBytes(6).toString('hex')}`);

/** A file staged beside the versions, with its SHA-256 (hex). */
export interface Staged {
  file: string;
  digest: string;
}

/** Writes chunks to a new file beside the versions, hashing them; at most
 * max bytes. */
export async function receive(l: ArtifactRoot, chunks: AsyncIterable<Buffer>, max: number): Promise<Staged> {
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

/** The digest of a file in algorithm (sha256, sha512) and encoding, read in
 * chunks. */
export async function digestOf(file: string, algorithm = 'sha256', encoding: BinaryToTextEncoding = 'hex'): Promise<string> {
  const hash = createHash(algorithm);
  for await (const b of createReadStream(file, { highWaterMark: 256 << 10 })) hash.update(b as Buffer);
  return hash.digest(encoding);
}

/** The SHA-256 of a file, read in chunks. */
export const sha256Of = (file: string): Promise<string> => digestOf(file);

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

/** Whether wget takes --no-config (GNU wget 1.15 and later says so in its
 * help); asked once per program. */
const noConfig = new Map<string, Promise<boolean>>();
function wgetNoConfig(wget: string, env: Record<string, string>): Promise<boolean> {
  let p = noConfig.get(wget);
  if (!p) {
    p = run(wget, ['--help'], { env, timeoutMs: 5000 }).then((r) => r.out.includes('--no-config'));
    noConfig.set(wget, p);
  }
  return p;
}

/** Fetches url with the machine's curl, else wget (their proxy variables
 * and certificate authorities apply, the user's configuration files of
 * either do not), into a file beside the versions, at most max bytes within
 * timeoutMs; signal ends it. */
export async function download(
  l: ArtifactRoot,
  url: string,
  o: { env: Record<string, string>; signal: AbortSignal; max: number; timeoutMs: number },
): Promise<Staged> {
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
        if (st.size > o.max) {
          tooLarge = true;
          ac.abort();
        }
      },
      () => {},
    );
  }, 1000);
  try {
    // curl -q first: no .curlrc; wget: an empty WGETRC, and GNU wget's
    // --no-config where it has it (BusyBox's has neither file nor flag).
    const args = curl
      ? ['-q', '-fsSL', '--retry', '2', '--proto', '=http,https', '--proto-redir', '=http,https', '-o', file, u.href]
      : [...((await wgetNoConfig(wget!, o.env)) ? ['--no-config'] : []), '-q', '-O', file, u.href];
    const env = curl ? o.env : { ...o.env, WGETRC: '/dev/null' };
    const r = await run(curl ?? wget!, args, { env, timeoutMs: o.timeoutMs, signal: ac.signal });
    if (tooLarge) throw new Error(`download ${u.href}: larger than ${o.max} bytes`);
    const err = runError(r);
    if (err) throw new Error(`download ${u.href}: ${err} ${lastN(r.out, 400)}`.trim());
    const st = await lstat(file);
    if (st.size > o.max) throw new Error(`download ${u.href}: larger than ${o.max} bytes`);
    return { file, digest: await sha256Of(file) };
  } catch (e) {
    await rm(file, { force: true });
    throw e;
  } finally {
    clearInterval(watch);
    o.signal.removeEventListener('abort', stop);
  }
}

/** Why an entry of a tarball refuses the archive, "" when it may be
 * unpacked. name is its path in the archive, whose first component (the
 * archive's own directory) is stripped. */
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

/** Unpacks a gzipped tarball into dest (which exists), its top directory
 * stripped; throws when an entry refuses it (refusal) or it unpacks to more
 * than maxUnpacked bytes. With keep, only the entries whose path below the
 * top directory it takes are written (every entry is still checked). */
export async function unpack(tarball: string, dest: string, maxUnpacked: number, keep?: (rel: string) => boolean): Promise<void> {
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
      if (keep && !keep(path.split('/').slice(1).join('/'))) return false;
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

/** Removes the entries of l's directory other than keep unused for
 * retentionMs and what interrupted installs left there for stagingMs (both
 * by the entry's own time: a link is removed, never followed). */
export async function prune(
  l: ArtifactRoot,
  keep: string,
  now: Date,
  o: { retentionMs: number; stagingMs: number; logger: Logger; what: string },
): Promise<void> {
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
      if (age < (STAGED.test(name) ? o.stagingMs : o.retentionMs)) continue;
      await rm(p, { recursive: true, force: true });
    } catch (e) {
      o.logger(`${o.what}: prune ${name}: ${(e as Error).message}`);
    }
  }
}
