// code-server releases and VS Code extensions (VSIX) are resolved on the
// hub's host only, then uploaded to machines through their agents, so
// machines never need internet access (docs/features/09). A file comes
// from, in order:
//
//   1. the seed directories prepared for air-gapped installs (fetch-assets);
//   2. the cache of earlier downloads;
//   3. a download from the release or extension URL template, unless
//      offline.
//
// Every file is verified against a SHA-256: the pinned table below for the
// default versions, else a "<file>.sha256" sidecar beside it. A seed that
// mismatches is refused, never replaced; a cached file that mismatches is
// downloaded again. A file with neither is used with a warning, and a
// download of one has its digest recorded as a sidecar (trust on first
// use).
//
// Every seeded or cached file is opened without blocking and used only when
// it is a regular file (openRegular): a FIFO or a device under a seed's or
// the cache's name answers at once instead of holding a thread of the
// hub's file I/O until something writes to it.
import { createHash, randomBytes } from 'node:crypto';
import { constants, type ReadStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SLUG } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { shownURL } from '#shared/lib/urls.ts';
import { retryDelay, waitForResult } from '#shared/lib/wait.ts';
import { DEFAULT_TIMING } from './timing.ts';

/** The code-server release installed on machines. */
export const DEFAULT_VERSION = '4.144.0';
/** The release download ({version}, {asset}, {file}). */
export const DEFAULT_TARBALL_URL = 'https://github.com/coder/code-server/releases/download/v{version}/{file}';
/** The Open VSX download ({publisher}, {name}, {version}, {file}). */
export const DEFAULT_EXTENSION_URL = 'https://open-vsx.org/api/{publisher}/{name}/{version}/file/{file}';

/** A marketplace extension installed into code-server. */
export interface Extension {
  /** publisher.name */
  id: string;
  version: string;
}

export const extensionFile = (e: Extension): string => `${e.id}-${e.version}.vsix`;

/** Installed on every machine. */
export const DEFAULT_EXTENSIONS: readonly Extension[] = [{ id: 'mhutchie.git-graph', version: '1.30.0' }];

/** Known-good digests of the default versions, updated together with
 * DEFAULT_VERSION and DEFAULT_EXTENSIONS (from the GitHub release API's
 * "digest" and a verified Open VSX download). */
export const PINNED: Readonly<Record<string, string>> = {
  'code-server-4.144.0-linux-amd64.tar.gz': '710f749c40a0f3d0ab3be09c0de65314e5c2907cc50646f5fbc0f24c0e8fba2d',
  'code-server-4.144.0-linux-arm64.tar.gz': '4404c784f541bd56a2a8d6e2a9474ed0b4e37bc8502aa3a247898ca933434482',
  'code-server-4.144.0-macos-amd64.tar.gz': 'cb03ed6ce12136f9f9d6f32fd5d780b991d96cf0dd1b3d590c16d73accc665c9',
  'code-server-4.144.0-macos-arm64.tar.gz': 'ebd78e944b9e918c0a1ca4239688c0e7a27096955dbf8ea98c3cad9668bc4fcc',
  'mhutchie.git-graph-1.30.0.vsix': 'a6baa3d5b6231035431d6338286e4de7e25ee214b58edee1c7e2c9423bdb552f',
};

/** The code-server builds machines can get. */
export const ALL_ASSETS: readonly string[] = ['linux-amd64', 'linux-arm64', 'macos-amd64', 'macos-arm64'];

/** The release tarball of an asset ("linux-amd64", "macos-arm64", ...). */
export const tarballFile = (version: string, asset: string): string => `code-server-${version}-${asset}.tar.gz`;

/** The asset of a machine's platform (Go's os and arch names). */
export function platformAsset(os: string, arch: string): string {
  const sys = os === 'linux' ? 'linux' : os === 'darwin' ? 'macos' : '';
  if (!sys) throw new Error(`code-server has no build for ${os}`);
  if (arch !== 'amd64' && arch !== 'arm64') throw new Error(`code-server has no build for ${sys}/${arch}`);
  return `${sys}-${arch}`;
}

/** Offline, a file is neither seeded nor cached. */
export class MissingArtifact extends Error {}

class RetryDownload extends Error {}

/** The user's cache directory as Go's os.UserCacheDir has it. */
export function userCacheDir(): string {
  if (process.platform === 'win32') {
    if (!process.env.LocalAppData) throw new Error('%LocalAppData% is not defined');
    return process.env.LocalAppData;
  }
  const home = process.env.HOME || homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches');
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && xdg.startsWith('/')) return xdg;
  return join(home, '.cache');
}

/** Where downloads are kept: <cache>/<slug>/code-server, shared by
 * instances. */
export const defaultCacheDir = (): string => join(userCacheDir(), SLUG, 'code-server');

const fill = (template: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), template);

/** A file of a seed directory or the cache: neither regular nor missing. */
export class NotRegular extends Error {}

/** The regular file at path, opened for reading without blocking (a FIFO
 * or a device there answers at once rather than waiting for a writer) and
 * without taking a controlling terminal; NotRegular for anything else,
 * ENOENT when there is nothing. */
export async function openRegular(path: string): Promise<FileHandle> {
  const fh = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0));
  try {
    if (!(await fh.stat()).isFile()) throw new NotRegular(`${path} is not a regular file`);
    return fh;
  } catch (e) {
    await fh.close().catch(() => {});
    throw e;
  }
}

/** A stream of the regular file at path (openRegular), closed at its end. */
export async function readRegular(path: string, highWaterMark = 256 << 10): Promise<ReadStream> {
  return (await openRegular(path)).createReadStream({ highWaterMark });
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of await readRegular(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** A sidecar is one line of sha256sum's; anything longer is not one. */
const MAX_SIDECAR = 4096;

const sidecar = (digest: string, file: string) => `${digest}  ${file}\n`;

export interface ArtifactsOptions {
  logger: Logger;
  /** The code-server release (DEFAULT_VERSION). */
  version?: string;
  /** The download templates (mirrors). */
  tarballURL?: string;
  extensionURL?: string;
  /** Searched before the cache. */
  seedDirs?: readonly string[];
  /** Earlier downloads (defaultCacheDir). */
  cacheDir?: string;
  /** Never download. */
  offline?: boolean;
  /** Extensions installed on every machine (DEFAULT_EXTENSIONS). */
  extensions?: readonly Extension[];
  /** Known digests (PINNED). */
  pinned?: Readonly<Record<string, string>>;
  /** Bounds a download. */
  downloadMs?: number;
  fetch?: typeof fetch;
}

export class Artifacts {
  readonly version: string;
  readonly tarballURLTemplate: string;
  readonly extensionURLTemplate: string;
  readonly seedDirs: readonly string[];
  readonly cacheDir: string;
  readonly offline: boolean;
  readonly extensions: readonly Extension[];
  private readonly logger: Logger;
  private readonly pinned: Readonly<Record<string, string>>;
  private readonly downloadMs: number;
  private readonly fetch: typeof fetch;
  /** Each artifact has its own queue so a download cannot block other cache hits. */
  private readonly queues = new Map<string, Promise<string>>();

  constructor(o: ArtifactsOptions) {
    this.logger = o.logger;
    this.version = o.version || DEFAULT_VERSION;
    this.tarballURLTemplate = o.tarballURL || DEFAULT_TARBALL_URL;
    this.extensionURLTemplate = o.extensionURL || DEFAULT_EXTENSION_URL;
    this.seedDirs = o.seedDirs ?? [];
    this.cacheDir = o.cacheDir ?? defaultCacheDir();
    this.offline = o.offline ?? false;
    this.extensions = o.extensions ?? DEFAULT_EXTENSIONS;
    this.pinned = o.pinned ?? PINNED;
    this.downloadMs = o.downloadMs ?? DEFAULT_TIMING.downloadMs;
    this.fetch = o.fetch ?? globalThis.fetch;
  }

  private get dirs(): string[] {
    return [...this.seedDirs, this.cacheDir];
  }

  tarballURL(asset: string): string {
    return fill(this.tarballURLTemplate, { version: this.version, asset, file: tarballFile(this.version, asset) });
  }

  extensionURL(e: Extension): string {
    const dot = e.id.indexOf('.');
    if (dot <= 0 || dot === e.id.length - 1) throw new Error(`bad extension id ${JSON.stringify(e.id)}`);
    return fill(this.extensionURLTemplate, {
      publisher: e.id.slice(0, dot),
      name: e.id.slice(dot + 1),
      version: e.version,
      file: extensionFile(e),
    });
  }

  /** The digest a file must have in dir: pinned, else its sidecar there
   * ("sha256sum" output or a bare digest); "" when unknown. */
  private async expected(dir: string, file: string): Promise<string> {
    const pinned = this.pinned[file];
    if (pinned) return pinned;
    let fh: FileHandle;
    try {
      fh = await openRegular(join(dir, `${file}.sha256`));
    } catch {
      return '';
    }
    try {
      const buf = Buffer.alloc(MAX_SIDECAR + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_SIDECAR) return '';
      return (buf.subarray(0, bytesRead).toString('utf8').trim().split(/\s+/)[0] ?? '').toLowerCase();
    } catch {
      return '';
    } finally {
      await fh.close().catch(() => {});
    }
  }

  /** The digest a file must have, from the pinned table or a sidecar in a
   * seed directory or the cache; "" when unknown. */
  async knownDigest(file: string): Promise<string> {
    for (const dir of this.dirs) {
      const want = await this.expected(dir, file);
      if (want) return want;
    }
    return '';
  }

  /** Records a digest learnt on first use as a sidecar in the cache. */
  async recordDigest(file: string, digest: string): Promise<void> {
    const tmp = join(this.cacheDir, `.digest-${randomBytes(8).toString('hex')}`);
    try {
      await mkdir(this.cacheDir, { recursive: true, mode: 0o755 });
      await writeFile(tmp, sidecar(digest, file), { flag: 'wx', mode: 0o644 });
      await rename(tmp, join(this.cacheDir, `${file}.sha256`));
    } catch {
      // the next download learns it again
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  /** A verified local copy of a release tarball; progress gets the bytes
   * of a download as they arrive (total -1 when unknown). */
  tarball(asset: string, o: { progress?: (done: number, total: number) => void; signal?: AbortSignal } = {}): Promise<string> {
    return this.artifact(tarballFile(this.version, asset), this.tarballURL(asset), o);
  }

  /** A verified local copy of an extension's VSIX. */
  extension(e: Extension, o: { signal?: AbortSignal } = {}): Promise<string> {
    return this.artifact(extensionFile(e), this.extensionURL(e), o);
  }

  private artifact(
    file: string,
    url: string,
    o: { progress?: (done: number, total: number) => void; signal?: AbortSignal },
  ): Promise<string> {
    if (o.signal?.aborted) return Promise.reject(o.signal.reason);
    const previous = this.queues.get(file);
    const run = (previous?.catch(() => {}) ?? Promise.resolve()).then(() => this.resolve(file, url, o));
    this.queues.set(file, run);
    const clear = () => {
      if (this.queues.get(file) === run) this.queues.delete(file);
    };
    void run.then(clear, clear);
    return waitForResult(run, o.signal);
  }

  private async resolve(
    file: string,
    url: string,
    o: { progress?: (done: number, total: number) => void; signal?: AbortSignal },
  ): Promise<string> {
    o.signal?.throwIfAborted();
    for (const dir of this.dirs) {
      const path = join(dir, file);
      try {
        await (await openRegular(path)).close();
      } catch (e) {
        if (e instanceof NotRegular) this.logger(`ignoring ${path}: not a regular file`);
        continue;
      }
      const want = await this.expected(dir, file);
      if (want) {
        const got = await sha256File(path);
        if (got !== want) {
          const err = new Error(`${file}: sha256 ${got} does not match expected ${want}`);
          if (dir === this.cacheDir && !this.offline) {
            this.logger(`discarding corrupt cached ${file}: ${err.message}`);
            await rm(path, { force: true });
            break;
          }
          throw err;
        }
      } else this.logger(`warning: ${path} has no pinned checksum or .sha256 sidecar; using it unverified`);
      return path;
    }
    if (this.offline)
      throw new MissingArtifact(
        `artifact not available offline: put ${file} into ${this.dirs.join(' or ')} (create it with \`fetch-assets\` on a connected machine)`,
      );
    return this.download(file, url, o);
  }

  private async download(
    file: string,
    url: string,
    o: { progress?: (done: number, total: number) => void; signal?: AbortSignal },
  ): Promise<string> {
    await mkdir(this.cacheDir, { recursive: true, mode: 0o755 });
    const signal = AbortSignal.any([AbortSignal.timeout(this.downloadMs), ...(o.signal ? [o.signal] : [])]);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      this.logger(`downloading ${shownURL(url)}`);
      try {
        return await this.downloadOnce(file, url, signal, o.progress);
      } catch (e) {
        signal.throwIfAborted();
        if (!(e instanceof RetryDownload) || attempt >= 2) throw e;
        this.logger(`retrying download: ${e.message}`);
        await delay(retryDelay(250 * 2 ** attempt), undefined, { signal });
      }
    }
  }

  private async downloadOnce(
    file: string,
    url: string,
    signal: AbortSignal,
    progress?: (done: number, total: number) => void,
  ): Promise<string> {
    // The file as it is: a decoded body would not match its digest.
    const res = await this.fetch(url, { signal, redirect: 'follow', headers: { 'Accept-Encoding': 'identity' } }).catch((cause) => {
      throw new RetryDownload(`GET ${shownURL(url)} failed`, { cause });
    });
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => {});
      const message = `GET ${shownURL(url)}: ${res.status} ${res.statusText}`;
      throw res.status === 408 || res.status === 429 || res.status >= 500 ? new RetryDownload(message) : new Error(message);
    }
    const total = Number(res.headers.get('Content-Length') ?? -1);
    const tmp = join(this.cacheDir, `.dl-${randomBytes(6).toString('hex')}`);
    const h = createHash('sha256');
    let f: FileHandle | undefined;
    const reader = res.body.getReader();
    try {
      f = await open(tmp, 'wx', 0o644);
      let done = 0;
      for (;;) {
        const { done: end, value } = await reader.read().catch((cause) => {
          throw new RetryDownload(`GET ${shownURL(url)}: response ended early`, { cause });
        });
        if (end) break;
        signal.throwIfAborted();
        await f.write(value);
        h.update(value);
        done += value.length;
        progress?.(done, Number.isFinite(total) && total >= 0 ? total : -1);
      }
      await f.close();
      if (total >= 0 && done !== total) throw new RetryDownload(`GET ${shownURL(url)}: response had ${done} of ${total} bytes`);
      const got = h.digest('hex');
      const want = await this.expected(this.cacheDir, file);
      signal.throwIfAborted();
      if (want && got !== want) throw new Error(`${file}: downloaded sha256 ${got} does not match expected ${want}`);
      if (!want) this.logger(`warning: no pinned checksum for ${file}; recorded sha256 ${got} (trust on first use)`);
      const path = join(this.cacheDir, file);
      await rename(tmp, path);
      await this.recordDigest(file, got);
      return path;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await f?.close().catch(() => {});
      await rm(tmp, { force: true });
    }
  }

  /** Downloads (or verifies) the releases of assets and the extensions
   * into dir with sidecars, for carrying into an air-gapped network; the
   * names of the files written, also when it fails part way. */
  async fetchAssets(dir: string, assets: readonly string[], signal?: AbortSignal): Promise<{ files: string[]; error?: Error }> {
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const files: string[] = [];
    const copyOut = async (src: string) => {
      const name = basename(src);
      const dst = join(dir, name);
      if (src !== dst) {
        await copyFile(src, `${dst}.tmp`);
        await rename(`${dst}.tmp`, dst);
      }
      files.push(name);
      await writeFile(`${dst}.sha256`, sidecar(await sha256File(dst), name), { mode: 0o644 });
    };
    try {
      for (const a of assets) await copyOut(await this.tarball(a, { signal }));
      for (const e of this.extensions) await copyOut(await this.extension(e, { signal }));
    } catch (e) {
      return { files, error: e as Error };
    }
    return { files };
  }
}
