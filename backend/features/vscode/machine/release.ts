// code-server's releases on a machine: a tarball the hub uploads or the
// machine downloads lands in a file beside the releases, hashed as it is
// written; only a tarball of the digest the hub knows is unpacked, into a
// directory of its own that becomes the release once its executable is
// there and its Node runs on this machine. Other releases unused for
// RELEASE_RETENTION_MS go (docs/deployment.md#remote-resources).
//
// The download, the upload, the unpacking and the retention are the
// machine side's (#machine/artifacts.ts), which hold the node's thread for
// no file and no program; unpacking code-server 4.144.0 (210 MB, 7204
// entries, 600 MB unpacked) held the thread for at most 2 ms at a time.
import { mkdir, rename, rm, utimes } from 'node:fs/promises';
import { posix } from 'node:path';
import type { Logger } from '#shared/lib/log.ts';
import { download as fetchFile, prune, staged, unpack as unpackTar, type ArtifactRoot, type Staged } from '#machine/artifacts.ts';
import { isExecutable, lastN, run, runError } from './process.ts';
import { releaseDir, type Layout } from './layout.ts';

export { downloadURL, entryMode, receive, refusal, sha256Of, type Staged } from '#machine/artifacts.ts';

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

/** Fetches url with the machine's curl, else wget, into a file beside the
 * releases, bounded in size and in time; signal ends it. */
export function download(
  l: ArtifactRoot,
  url: string,
  o: { env: Record<string, string>; signal: AbortSignal; limits?: Partial<ReleaseLimits> },
): Promise<Staged> {
  const lim = { ...RELEASE_LIMITS, ...o.limits };
  return fetchFile(l, url, { env: o.env, signal: o.signal, max: lim.maxTarball, timeoutMs: lim.downloadMs });
}

/** Unpacks a release's tarball into dest (which exists), its top
 * directory stripped (#machine/artifacts.ts unpack). */
export const unpack = (tarball: string, dest: string, maxUnpacked = RELEASE_LIMITS.maxUnpacked): Promise<void> =>
  unpackTar(tarball, dest, maxUnpacked);

interface InstallOptions {
  expected?: string;
  what?: string;
  env: Record<string, string>;
  logger: Logger;
  limits?: Partial<ReleaseLimits>;
  now?: Date;
  join?: (digest: string, stage: () => Promise<void>) => Promise<void>;
  promote?: (publish: () => Promise<void>) => Promise<void>;
}

/** Installs the staged tarball as release version: checked against expected
 * (the digest the hub knows; none when it knows none) before anything is
 * unpacked, unpacked beside the releases, accepted when it holds
 * bin/code-server and its Node runs here, then put in place of what was
 * there. Other releases unused for long go. The staged file stays the
 * caller's. */
export async function install(l: Layout, version: string, tarball: Staged, o: InstallOptions): Promise<void> {
  const want = (o.expected ?? '').toLowerCase();
  if (want && tarball.digest !== want)
    throw new Error(`${o.what ?? 'the tarball'}: sha256 ${tarball.digest} does not match expected ${want}`);
  const stage = () => installVerified(l, version, tarball, o);
  return o.join ? o.join(tarball.digest, stage) : stage();
}

async function installVerified(l: Layout, version: string, tarball: Staged, o: InstallOptions): Promise<void> {
  const lim = { ...RELEASE_LIMITS, ...o.limits };
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
    const publish = async () => {
      const old = staged(l, 'old');
      let moved = false;
      try {
        await rename(final, old);
        moved = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      try {
        await rename(tmp, final);
      } catch (e) {
        if (moved) await rename(old, final);
        throw e;
      }
      if (moved) await rm(old, { recursive: true, force: true });
      await pruneReleases(l, posix.basename(final), now, o.logger);
    };
    if (o.promote) await o.promote(publish);
    else await publish();
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Removes the releases other than keep unused for RELEASE_RETENTION_MS
 * and what interrupted installs left there for STAGING_RETENTION_MS (both
 * by the entry's own time: a link is removed, never followed). */
export function pruneReleases(l: Layout, keep: string, now: Date, logger: Logger): Promise<void> {
  return prune(l, keep, now, { retentionMs: RELEASE_RETENTION_MS, stagingMs: STAGING_RETENTION_MS, logger, what: 'code-server' });
}
