// Where the core takes a TypeScript machine executable from when a machine
// cannot get it itself (it has neither curl nor wget, may not reach the
// release, or what it got was not the build): the first of these that has
// it, checked against the digests built into the core before it is cached
// or uploaded (resolveMachine):
//
//   - the directory the operator names (--agent-dir): the release's asset
//     (<bin>-machine-<key>.gz) or the executable (<bin>-machine-<key>);
//   - the core host's cache (~/<DATA_DIR_NAME>/cache/machine), kept 14
//     days after its last use;
//   - the core's own copy, for its own platform (the local machine works
//     offline);
//   - a download of the release's asset over HTTPS, through the proxy of
//     the environment (HTTPS_PROXY, HTTP_PROXY, NO_PROXY: Bun's fetch
//     honours them, Node's in the desktop app's core once
//     shared/lib/proxy.ts set it).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createGunzip, gzip } from 'node:zlib';
import { machineAsset, type TSBuild } from './builds.ts';
import { DeployCode, Unsupported } from './errors.ts';

/** Bounds an executable (they are about 110 MB). */
const MAX_EXECUTABLE = 512 << 20;
/** How long a cached executable is kept after its last use. */
export const CACHE_RETENTION_MS = 14 * 24 * 60 * 60_000;
/** How long a download may take in all. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

const gzipAsync = promisify(gzip);

type Build = Pick<TSBuild, 'key' | 'digest' | 'gzDigest' | 'gzSize' | 'url'>;

export interface MachineSources {
  /** The operator's directory, searched first. */
  dir?: string;
  /** The core host's cache of executables. */
  cacheDir: string;
  /** The core's own copy of its platform's asset, when b is of it. */
  own?: () => Promise<Uint8Array | null>;
  signal?: AbortSignal;
  now?: () => number;
  /** Where the paths of what was refused are logged (the error the
   * machine's state carries names no path of the core's host). */
  logger?: (line: string) => void;
}

/** The bytes of chunks, at most max, and their SHA-256, hashed as they
 * come (nothing large is hashed in one go on the event loop). */
async function collect(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  max: number,
  what: string,
): Promise<{ bytes: Buffer; digest: string }> {
  const h = createHash('sha256');
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of chunks) {
    n += c.length;
    if (n > max) throw new Error(`${what} is larger than ${max} bytes`);
    h.update(c);
    parts.push(c);
  }
  return { bytes: Buffer.concat(parts, n), digest: h.digest('hex') };
}

/** b's asset (gzip) when data is it: its digest and its executable's,
 * decompressed in zlib's threads and hashed as it comes. */
async function checkAsset(b: Build, data: { bytes: Buffer; digest: string }): Promise<Buffer> {
  if (data.digest !== b.gzDigest) throw new Error(`sha256 ${data.digest} is not the build's asset ${b.gzDigest}`);
  const exe = createHash('sha256');
  let n = 0;
  for await (const c of Readable.from([data.bytes]).pipe(createGunzip()) as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > MAX_EXECUTABLE) throw new Error(`the executable is larger than ${MAX_EXECUTABLE} bytes`);
    exe.update(c);
  }
  const d = exe.digest('hex');
  if (d !== b.digest) throw new Error(`sha256 ${d} is not the build's ${b.digest}`);
  return data.bytes;
}

/** The chunks of a buffer, so that it is hashed piecewise. */
function* pieces(b: Uint8Array, size = 1 << 20): Generator<Uint8Array> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}

/** A file's bytes and digest, read and hashed piecewise. */
const readFileChecked = (path: string, max: number) => collect(createReadStream(path), max, path);

/** The cache's file of b: <asset>-<digest>.gz. */
const cacheFile = (cacheDir: string, b: Pick<TSBuild, 'key' | 'digest'>) =>
  join(cacheDir, `${machineAsset(b.key)}-${b.digest.slice(0, 16)}.gz`);

/** Applies the cache's retention: what was not used for CACHE_RETENTION_MS
 * goes. */
export async function pruneCache(cacheDir: string, now = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return;
  }
  for (const f of names) {
    const p = join(cacheDir, f);
    try {
      if (now - (await stat(p)).mtimeMs > CACHE_RETENTION_MS) await rm(p, { force: true });
    } catch {
      // gone
    }
  }
}

/** Downloads url, at most max bytes within DOWNLOAD_TIMEOUT_MS, hashing
 * it as it comes. The proxy is the environment's (shared/lib/proxy.ts). */
export async function download(url: string, max: number, signal?: AbortSignal): Promise<{ bytes: Buffer; digest: string }> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body.cancel().catch(() => {});
    throw new Error(`${url} is larger than ${max} bytes`);
  }
  return collect(res.body as unknown as AsyncIterable<Uint8Array>, max, url);
}

/** b's executable gzip-compressed from the first source that has it (the
 * download is cached); Unsupported build_unavailable, saying what was
 * tried, when none does. */
export async function resolveMachine(b: Build, o: MachineSources): Promise<Buffer> {
  const reasons: string[] = [];
  const asset = machineAsset(b.key);
  /** What a source said: the reason without the core host's paths, the
   * paths logged. */
  const refused = (label: string, path: string, e: unknown) => {
    const message = (e as Error).message;
    reasons.push(`${label}: ${path ? message.replaceAll(path, label) : message}`);
    o.logger?.(`machine build ${b.key}: ${path || label} refused: ${message}`);
  };
  if (o.dir)
    for (const [name, compressed] of [
      [`${asset}.gz`, true],
      [asset, false],
    ] as const) {
      const p = join(o.dir, name);
      try {
        await stat(p);
      } catch {
        continue;
      }
      try {
        if (compressed) return await checkAsset(b, await readFileChecked(p, b.gzSize));
        const raw = await readFileChecked(p, MAX_EXECUTABLE);
        if (raw.digest !== b.digest) throw new Error(`sha256 ${raw.digest} is not the build's ${b.digest}`);
        return await gzipAsync(raw.bytes, { level: 6 });
      } catch (e) {
        refused(`--agent-dir's ${name}`, p, e);
      }
    }
  const now = (o.now ?? Date.now)();
  await pruneCache(o.cacheDir, now);
  const file = cacheFile(o.cacheDir, b);
  let cached = true;
  try {
    await stat(file);
  } catch {
    cached = false;
  }
  if (cached)
    try {
      const gz = await checkAsset(b, await readFileChecked(file, b.gzSize));
      // Used: kept another CACHE_RETENTION_MS.
      await utimes(file, new Date(now), new Date(now));
      return gz;
    } catch (e) {
      refused("the cache's copy", file, e);
      await rm(file, { force: true });
    }
  const own = await o.own?.();
  if (own)
    try {
      return await checkAsset(b, await collect(pieces(own), b.gzSize, 'the own copy'));
    } catch (e) {
      refused("the core's own copy", '', e);
    }
  if (!b.url) {
    reasons.push('this build has no release to download it from');
    throw new Unsupported(
      DeployCode.BuildUnavailable,
      `no machine build for ${b.key} (${reasons.join('; ')}); put ${asset}.gz into the core's --agent-dir`,
    );
  }
  let gz: Buffer;
  try {
    gz = await checkAsset(b, await download(b.url, b.gzSize, o.signal));
  } catch (e) {
    if (o.signal?.aborted) throw e;
    reasons.push(`the download failed: ${(e as Error).message}`);
    o.logger?.(`machine build ${b.key}: the download from ${b.url} failed: ${(e as Error).message}`);
    throw new Unsupported(
      DeployCode.BuildUnavailable,
      `no machine build for ${b.key} (${reasons.join('; ')}); put ${asset}.gz of the release into the core's --agent-dir, or let the core or the machine reach ${b.url}`,
    );
  }
  await mkdir(o.cacheDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}`;
  await writeFile(tmp, gz, { mode: 0o600 });
  await rename(tmp, file);
  return gz;
}
