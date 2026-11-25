// Anthropic's Agent SDK on a machine (../claudesdk.ts): the pinned tarball,
// downloaded by the machine (curl or wget, from the URL the hub names) or
// uploaded by the hub, lands in a file beside the versions
// (<data dir>/claude-agent-sdk), which is checked against the pinned
// integrity before anything of it is unpacked; of it only the entry, its
// package.json, license and readme are unpacked, into a directory of their
// own that becomes the version once the entry's SHA-256 is the pinned one
// too. A version unused for SDK_RETENTION_MS goes (housekeeping; a load by
// the chat host and a hub's look both count as a use), and what an
// interrupted install left goes after a day. Everything goes through
// #machine/artifacts.ts: no file or program holds the node's thread.
import { mkdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { posix } from 'node:path';
import type { Logger } from '#shared/lib/log.ts';
import { digestOf, download, prune, receive, staged, unpack, type ArtifactRoot, type Staged } from '#machine/artifacts.ts';
import { CLAUDE_SDK, MAX_SDK_TARBALL, MAX_SDK_UNPACKED, SDK_DIR, integrityRefusal, sdkDir, type NpmTarball } from '../claudesdk.ts';

const DAY = 24 * 60 * 60_000;
/** A version of the SDK unused this long goes. */
export const SDK_RETENTION_MS = 14 * DAY;
/** What an interrupted install left goes after this long. */
export const SDK_STAGING_MS = DAY;

export interface SdkStoreOptions {
  /** The instance's data directory. */
  base: string;
  logger: Logger;
  /** The pinned tarball (tests pin their own). */
  pin?: NpmTarball;
  /** Bounds a download, the whole of it. */
  downloadMs?: number;
}

/** Whether the entry of t in dir is the pinned one. */
export async function entryOk(dir: string, t: NpmTarball): Promise<boolean> {
  try {
    const p = posix.join(dir, t.entry);
    if (!(await stat(p)).isFile()) return false;
    return (await digestOf(p)) === t.entrySha256;
  } catch {
    return false;
  }
}

/** The SDK's versions in a machine's data directory. */
export class SdkStore {
  readonly pin: NpmTarball;
  /** The directory of the versions (ArtifactRoot), and the pinned one's. */
  readonly root: ArtifactRoot;
  readonly dir: string;
  private readonly logger: Logger;
  private readonly downloadMs: number;
  /** One install at a time: two hubs that ask at once install it once. */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(o: SdkStoreOptions) {
    this.pin = o.pin ?? CLAUDE_SDK;
    this.root = { root: posix.join(o.base, SDK_DIR) };
    this.dir = sdkDir(o.base, this.pin);
    this.logger = o.logger;
    this.downloadMs = o.downloadMs ?? 5 * 60_000;
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => {});
    return run;
  }

  /** Whether the pinned version is there whole; one that is counts as used
   * now. */
  async installed(now = new Date()): Promise<boolean> {
    if (!(await entryOk(this.dir, this.pin))) return false;
    await utimes(this.dir, now, now).catch(() => {});
    return true;
  }

  /** Has the machine download the tarball from url and installs it; a
   * version there already is kept. Whether it was downloaded. */
  fetch(url: string, o: { env: Record<string, string>; signal: AbortSignal }): Promise<boolean> {
    return this.locked(async () => {
      if (await this.installed()) return false;
      const s = await download(this.root, url, { env: o.env, signal: o.signal, max: MAX_SDK_TARBALL, timeoutMs: this.downloadMs });
      try {
        await this.install(s);
      } finally {
        await rm(s.file, { force: true });
      }
      return true;
    });
  }

  /** Installs the tarball the hub sends in chunks. */
  receive(chunks: AsyncIterable<Buffer>): Promise<void> {
    return this.locked(async () => {
      const s = await receive(this.root, chunks, MAX_SDK_TARBALL);
      try {
        await this.install(s);
      } finally {
        await rm(s.file, { force: true });
      }
    });
  }

  /** Checks the staged tarball against the pinned integrity, unpacks what
   * is needed of it beside the versions, and puts it in place of what was
   * there once its entry is the pinned one. */
  private async install(s: Staged, now = new Date()): Promise<void> {
    const why = integrityRefusal(this.pin, await digestOf(s.file, 'sha512', 'base64'));
    if (why) throw new Error(why);
    const tmp = staged(this.root, 'install');
    await mkdir(tmp, { mode: 0o755 });
    try {
      const keep = new Set(this.pin.files);
      await unpack(s.file, tmp, MAX_SDK_UNPACKED, (rel) => keep.has(rel));
      if (!(await entryOk(tmp, this.pin))) throw new Error(`${this.pin.file}: its ${this.pin.entry} is not the pinned one`);
      await utimes(tmp, now, now);
      const old = staged(this.root, 'old');
      let moved = false;
      try {
        await rename(this.dir, old);
        moved = true;
      } catch {
        // none there
      }
      await rename(tmp, this.dir);
      if (moved) await rm(old, { recursive: true, force: true });
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
    this.logger(`chat: installed ${this.pin.name} ${this.pin.version}`);
    await this.prune(now, this.pin.version);
  }

  /** Removes the versions unused for SDK_RETENTION_MS (all but keep) and
   * what interrupted installs left. */
  prune(now: Date, keep = ''): Promise<void> {
    return prune(this.root, keep, now, {
      retentionMs: SDK_RETENTION_MS,
      stagingMs: SDK_STAGING_MS,
      logger: this.logger,
      what: 'chat: the Agent SDK',
    });
  }
}
