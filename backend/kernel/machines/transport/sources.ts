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
//     honours them, and the desktop app starts its core with
//     NODE_USE_ENV_PROXY=1, with which Node's does).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { machineAsset, type TSBuild } from './builds.ts';
import { DeployCode, Unsupported } from './errors.ts';

/** Bounds an executable and its asset (they are about 110 and 45 MB). */
const MAX_EXECUTABLE = 512 << 20;
/** How long a cached executable is kept after its last use. */
export const CACHE_RETENTION_MS = 14 * 24 * 60 * 60_000;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export interface MachineSources {
  /** The operator's directory, searched first. */
  dir?: string;
  /** The core host's cache of executables. */
  cacheDir: string;
  /** The core's own copy of its platform's asset, when b is of it. */
  own?: () => Promise<Uint8Array | null>;
  signal?: AbortSignal;
  now?: () => number;
}

/** The executable of b gzip-compressed, when what was found is it. */
function checked(b: Pick<TSBuild, 'digest' | 'gzDigest'>, data: Buffer, compressed: boolean): Buffer {
  if (compressed && sha256(data) !== b.gzDigest) throw new Error(`sha256 ${sha256(data)} is not the build's asset ${b.gzDigest}`);
  const exe = compressed ? gunzipSync(data, { maxOutputLength: MAX_EXECUTABLE }) : data;
  const d = sha256(exe);
  if (d !== b.digest) throw new Error(`sha256 ${d} is not the build's ${b.digest}`);
  return compressed ? data : gzipSync(exe, { level: 6 });
}

function readBounded(path: string): Buffer {
  if (statSync(path).size > MAX_EXECUTABLE) throw new Error('too large');
  return readFileSync(path);
}

/** The cache's file of b: <asset>-<digest>.gz. */
const cacheFile = (cacheDir: string, b: Pick<TSBuild, 'key' | 'digest'>) =>
  join(cacheDir, `${machineAsset(b.key)}-${b.digest.slice(0, 16)}.gz`);

/** Applies the cache's retention: what was not used for CACHE_RETENTION_MS
 * goes. */
export function pruneCache(cacheDir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const f of names) {
    const p = join(cacheDir, f);
    try {
      if (now - statSync(p).mtimeMs > CACHE_RETENTION_MS) rmSync(p, { force: true });
    } catch {
      // gone
    }
  }
}

/** How long a download may take in all. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Downloads url, at most MAX_EXECUTABLE bytes within DOWNLOAD_TIMEOUT_MS.
 * The proxy is the environment's. */
export async function download(url: string, signal?: AbortSignal): Promise<Buffer> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const part of res.body) {
    n += part.length;
    if (n > MAX_EXECUTABLE) throw new Error(`${url}: larger than ${MAX_EXECUTABLE} bytes`);
    parts.push(part);
  }
  return Buffer.concat(parts);
}

/** b's executable gzip-compressed from the first source that has it (the
 * download is cached); Unsupported build_unavailable, saying what was
 * tried, when none does. */
export async function resolveMachine(b: Pick<TSBuild, 'key' | 'digest' | 'gzDigest' | 'url'>, o: MachineSources): Promise<Buffer> {
  const reasons: string[] = [];
  const asset = machineAsset(b.key);
  if (o.dir)
    for (const [name, compressed] of [
      [`${asset}.gz`, true],
      [asset, false],
    ] as const) {
      const p = join(o.dir, name);
      let data: Buffer;
      try {
        data = readBounded(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') reasons.push(`${p}: ${(e as Error).message}`);
        continue;
      }
      try {
        return checked(b, data, compressed);
      } catch (e) {
        reasons.push(`${p} refused: ${(e as Error).message}`);
      }
    }
  const now = (o.now ?? Date.now)();
  pruneCache(o.cacheDir, now);
  const file = cacheFile(o.cacheDir, b);
  try {
    const gz = checked(b, readBounded(file), true);
    // Used: kept another CACHE_RETENTION_MS.
    utimesSync(file, new Date(now), new Date(now));
    return gz;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      reasons.push(`${file} refused: ${(e as Error).message}`);
      rmSync(file, { force: true });
    }
  }
  const own = await o.own?.();
  if (own)
    try {
      return checked(b, Buffer.from(own), true);
    } catch (e) {
      reasons.push(`the core's own copy refused: ${(e as Error).message}`);
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
    gz = checked(b, await download(b.url, o.signal), true);
  } catch (e) {
    if (o.signal?.aborted) throw e;
    reasons.push(`the download failed: ${(e as Error).message}`);
    throw new Unsupported(
      DeployCode.BuildUnavailable,
      `no machine build for ${b.key} (${reasons.join('; ')}); put ${asset}.gz of the release into the core's --agent-dir, or let the core or the machine reach ${b.url}`,
    );
  }
  mkdirSync(o.cacheDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, gz, { mode: 0o600 });
  renameSync(tmp, file);
  return gz;
}
