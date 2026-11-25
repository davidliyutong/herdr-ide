// The core's part in getting Anthropic's Agent SDK to the machines whose
// chat hosts run Claude Code's chats (claudesdk.ts): before a request that
// starts such a chat, the machine side's action sdk says whether the pinned
// version is installed and, unless the core is offline, has the machine
// download it itself from the npm registry (curl or wget, checked against
// the pinned integrity). A machine that cannot gets it from the core
// (sdkUpload), as VS Code's releases and the machine builds come: first of
// the operator's directories (--seed-dir), the core's cache, and the core's
// own download from the registry (through the proxy of its environment),
// each checked against the pinned integrity before it is used, cached or
// sent. Nothing of it is part of the core.
//
// A machine of the Go build answers that it has no such action: its chat
// host speaks Claude Code's protocol itself, and nothing is installed. A
// machine whose chat host could not get the SDK is refused with
// sdk_unavailable, saying what each source said (a URL by its origin and
// path only); that failure holds for a while on the same agent session for
// the asks of a page's subscriptions, while a new chat asks again. Each
// install is audited (chat.sdk_install): the machine, where its copy came
// from, whether it was installed.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, utimes, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import type { Logger } from '#shared/lib/log.ts';
import { redactURLs, shownURL, downloadURLRefusal } from '#shared/lib/urls.ts';
import { ChunkWriter, readLine } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import type { AuditFields } from '#kernel/audit.ts';
import { call, open as openStream } from '#kernel/agent.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { download, pruneCache } from '#kernel/machines/transport/release.ts';
import { auditText } from './audit.ts';
import { CLAUDE_SDK, MAX_SDK_TARBALL, NPM_REGISTRY, integrityRefusal, tarballURL, type NpmTarball } from './claudesdk.ts';
import { chatProtocol } from './protocol.ts';

export interface SdkProvisionOptions {
  /** The operator's directories of artifacts (--seed-dir), searched first. */
  seedDirs?: readonly string[];
  /** The core's cache of the tarballs it got. */
  cacheDir: string;
  /** Never download: neither the core nor the machines (--offline). */
  offline?: boolean;
  /** The npm registry (--npm-registry): http or https, without user
   * information, query or fragment (serve refuses another). */
  registry?: string;
  logger: Logger;
  /** The pinned tarball (tests pin their own). */
  pin?: NpmTarball;
  /** Bounds the core's download, the machine's (its action's answer), and
   * the upload with its install. */
  downloadMs?: number;
  machineMs?: number;
  uploadMs?: number;
  /** Bounds the core's load of its tarball, which the machines that need it
   * share: one that has not settled by then is dropped, and the next ask
   * loads it anew. By default the download's bound and a minute. */
  loadMs?: number;
  /** The clock (tests move it). */
  now?: () => number;
}

/** How long a machine's word that it has the SDK holds on the same agent
 * session: asked again after that, it keeps its copy in use (the machine's
 * retention counts from the last use) or installs it again if it went. */
export const SDK_RECHECK_MS = 60 * 60_000;

/** How long a machine's failure to get the SDK holds on the same agent
 * session for the asks of a page's subscriptions, which would otherwise run
 * every source again each time a page shows the chat; a new chat (the
 * user's own request) asks again. */
export const SDK_FAILURE_MS = 5 * 60_000;

/** The audit record of an install. */
export const SDK_AUDIT_EVENT = 'chat.sdk_install';

/** Where a machine's copy came from: its own download, or the core's upload
 * of an operator's copy, its cache or its own download; none when nothing
 * was tried (offline, with no copy). */
export type SdkSource = 'machine' | 'seed' | 'cache' | 'download' | 'none';

/** What an ask of the core may say of its caller. */
export interface EnsureOptions {
  /** Asks again although the machine failed lately (a new chat). */
  retry?: boolean;
  /** Writes an audit record of the caller's (the install). */
  audit?: (event: string, fields: AuditFields) => void;
}

/** The core's refusal of a Claude Code chat the machine cannot run. */
export const sdkUnavailable = (message: string): Fail => new Fail(chat.Code.SdkUnavailable, 503, message);

const sha512 = (b: Uint8Array): string => createHash('sha512').update(b).digest('base64');

const DOWNLOAD_MS = 5 * 60_000;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whether an abort's reason is a bound's rather than the caller's leaving. */
const isTimeout = (reason: unknown): boolean => (reason as { name?: unknown } | null)?.name === 'TimeoutError';

/** The bytes of the regular file at p, at most max; null when there is none.
 * The file is opened without blocking (a FIFO or a device there answers at
 * once rather than waiting for a writer) and read only when it is a regular
 * file. */
export async function readRegular(p: string, max: number): Promise<Buffer | null> {
  let fh: FileHandle;
  try {
    fh = await open(p, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > max) throw new Error(`larger than ${max} bytes`);
    const parts: Buffer[] = [];
    let n = 0;
    for (;;) {
      const b = Buffer.allocUnsafe(256 << 10);
      const { bytesRead } = await fh.read(b, 0, b.length, null);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n > max) throw new Error(`larger than ${max} bytes`);
      parts.push(b.subarray(0, bytesRead));
    }
    return Buffer.concat(parts, n);
  } finally {
    await fh.close().catch(() => {});
  }
}

/** The core's tarball and where it came from. */
interface HubTarball {
  bytes: Buffer;
  source: Exclude<SdkSource, 'machine' | 'none'>;
}

/** Why the core has no tarball, with the last source it tried. */
class NoTarball extends Error {
  readonly source: SdkSource;
  constructor(message: string, source: SdkSource) {
    super(message);
    this.source = source;
  }
}

/** What a machine's chat host needs of the SDK, as this core got it there. */
interface MachineState {
  /** The agent session the SDK was found installed on (or found needless
   * on: a Go build's); null until then. */
  session: object | null;
  /** When it was. */
  at: number;
  /** The last failure to get it there, on which agent session and when. */
  failure: { session: object | null; at: number; error: unknown } | null;
  lock: Promise<void>;
}

/** The SDK on the machines, as this core got it there. */
export class SdkProvision {
  readonly pin: NpmTarball;
  readonly url: string;
  private readonly o: SdkProvisionOptions;
  private readonly states = new Map<string, MachineState>();
  /** The core's tarball, loaded once for every machine that waits for it;
   * a failure is tried again, and a load that does not settle within
   * loadMs is dropped. */
  private load: Promise<HubTarball> | null = null;

  constructor(o: SdkProvisionOptions) {
    this.o = o;
    this.pin = o.pin ?? CLAUDE_SDK;
    const registry = o.registry || NPM_REGISTRY;
    const why = downloadURLRefusal(registry);
    if (why) throw new Error(`the npm registry ${shownURL(registry)}: ${why}`);
    this.url = tarballURL(this.pin, registry);
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  private state(id: string): MachineState {
    let s = this.states.get(id);
    if (!s) this.states.set(id, (s = { session: null, at: 0, failure: null, lock: Promise.resolve() }));
    return s;
  }

  /** Drops what is kept of a removed machine. */
  forget(id: string): void {
    this.states.delete(id);
  }

  /** Makes sure machine m's chat host can load the SDK, unless it did on
   * the machine's current agent session within SDK_RECHECK_MS; callers
   * wait for each other. Fails with sdk_unavailable and what each source
   * said; without retry, a failure on the same agent session within
   * SDK_FAILURE_MS fails again without asking. */
  async ensure(m: Machine, signal: AbortSignal, o: EnsureOptions = {}): Promise<void> {
    const s = this.state(m.id);
    const before = s.lock;
    let release!: () => void;
    s.lock = new Promise((r) => (release = r));
    await before;
    try {
      const sess = m.connected ? m.live() : null;
      if (sess && s.session === sess && this.now - s.at < SDK_RECHECK_MS) return;
      const f = s.failure;
      if (!o.retry && f && sess && f.session === sess && this.now - f.at < SDK_FAILURE_MS) throw f.error;
      try {
        await this.install(m, signal, o.audit);
      } catch (e) {
        // A caller that left is no failure of the machine's; its bound is.
        if (!signal.aborted || isTimeout(signal.reason)) s.failure = { session: sess, at: this.now, error: e };
        throw e;
      }
      s.session = sess;
      s.at = this.now;
      s.failure = null;
    } finally {
      release();
    }
  }

  private async install(m: Machine, signal: AbortSignal, record?: (event: string, fields: AuditFields) => void): Promise<void> {
    const reasons: string[] = [];
    let source: SdkSource = this.o.offline ? 'none' : 'machine';
    const audit = (ok: boolean, error?: string) =>
      record?.(SDK_AUDIT_EVENT, {
        plugin: 'chat',
        machine: m.id,
        source,
        ok,
        ...(error === undefined ? {} : { error: auditText(redactURLs(error)) }),
      });
    let res: { installed: boolean; fetched?: boolean; error?: string };
    try {
      res = await call(m, chatProtocol, 'sdk', this.o.offline ? {} : { url: this.url }, { signal, timeoutMs: this.o.machineMs });
    } catch (e) {
      // A machine build without the action (the Go build's chat host needs
      // no SDK).
      if (e instanceof Fail && e.code === 'bad_params' && /unknown action/.test(e.message)) return;
      // The machine's own download, when it was asked for one, ended so.
      if (!this.o.offline) audit(false, messageOf(e));
      signal.throwIfAborted();
      throw e;
    }
    if (res.installed) {
      if (res.fetched) audit(true);
      return;
    }
    reasons.push(
      this.o.offline
        ? 'the core is offline: the machine did not download it'
        : `the machine could not download it: ${redactURLs(res.error ?? 'no reason')}`,
    );
    let tarball: HubTarball;
    try {
      tarball = await this.tarball(reasons, signal);
    } catch (e) {
      if (e instanceof NoTarball && e.source !== 'none') source = e.source;
      if (signal.aborted) {
        audit(false, messageOf(signal.reason));
        signal.throwIfAborted();
      }
      reasons.push(redactURLs(messageOf(e)));
      const refusal = this.refusal(m, reasons);
      audit(false, refusal.message);
      throw refusal;
    }
    source = tarball.source;
    try {
      await this.upload(m, tarball.bytes, signal);
    } catch (e) {
      if (signal.aborted) {
        audit(false, messageOf(signal.reason));
        signal.throwIfAborted();
      }
      reasons.push(`the core's upload failed: ${redactURLs(messageOf(e))}`);
      const refusal = this.refusal(m, reasons);
      audit(false, refusal.message);
      throw refusal;
    }
    audit(true);
  }

  private refusal(m: Machine, reasons: string[]): Fail {
    const why = `${this.pin.name} ${this.pin.version} could not be installed on ${m.label}: ${reasons.join('; ')}`;
    this.o.logger(`chat: ${why}`);
    return sdkUnavailable(
      `${why}; let the machine or this core reach ${shownURL(this.url)}, or put ${this.pin.file} into a --seed-dir of this core`,
    );
  }

  /** The tarball as the core has it: from a seed directory, its cache or
   * its own download, checked against the pinned integrity. */
  tarball(reasons: string[] = [], signal?: AbortSignal): Promise<HubTarball> {
    if (!this.load) {
      // Shared: no one machine's signal ends it, its own bound does.
      const p = this.resolve(reasons);
      const ms = this.o.loadMs ?? (this.o.downloadMs ?? DOWNLOAD_MS) + 60_000;
      const bounded = new Promise<HubTarball>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new NoTarball(`the core's own copy was not ready within ${Math.round(ms / 1000)} s`, 'none')),
          ms,
        );
        p.then(resolve, reject).finally(() => clearTimeout(timer));
      });
      this.load = bounded;
      bounded.catch(() => {
        if (this.load === bounded) this.load = null;
      });
    }
    const p = this.load;
    if (!signal) return p;
    return Promise.race([
      p,
      new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(signal.reason as Error), { once: true })),
    ]);
  }

  private async resolve(reasons: string[]): Promise<HubTarball> {
    const t = this.pin;
    const check = (b: Buffer) => {
      const why = integrityRefusal(t, sha512(b));
      if (why) throw new Error(why);
      return b;
    };
    let tried: SdkSource = 'none';
    for (const dir of this.o.seedDirs ?? []) {
      const p = join(dir, t.file);
      try {
        const b = await readRegular(p, MAX_SDK_TARBALL);
        if (!b) continue;
        tried = 'seed';
        return { bytes: check(b), source: 'seed' };
      } catch (e) {
        tried = 'seed';
        reasons.push(`the seed directory's ${t.file} was refused: ${messageOf(e)}`);
        this.o.logger(`chat: ${p} refused: ${messageOf(e)}`);
      }
    }
    await pruneCache(this.o.cacheDir);
    const cached = join(this.o.cacheDir, t.file);
    try {
      const b = await readRegular(cached, MAX_SDK_TARBALL);
      if (b) {
        tried = 'cache';
        check(b);
        const now = new Date();
        await utimes(cached, now, now).catch(() => {});
        return { bytes: b, source: 'cache' };
      }
    } catch (e) {
      tried = 'cache';
      this.o.logger(`chat: ${cached} refused: ${messageOf(e)}`);
      await rm(cached, { force: true });
    }
    if (this.o.offline) throw new NoTarball(`the core is offline and has no ${t.file} in a --seed-dir or its cache`, tried);
    let b: Buffer;
    try {
      b = check((await download(this.url, MAX_SDK_TARBALL, this.o.downloadMs ?? DOWNLOAD_MS)).bytes);
    } catch (e) {
      throw new NoTarball(`the core could not download ${shownURL(this.url)}: ${redactURLs(messageOf(e))}`, 'download');
    }
    await mkdir(this.o.cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(`${cached}.${process.pid}`, b, { mode: 0o600 });
    await rename(`${cached}.${process.pid}`, cached);
    return { bytes: b, source: 'download' };
  }

  /** Sends the tarball to m's chat feature, which installs it. */
  private async upload(m: Machine, tarball: Buffer, signal: AbortSignal): Promise<void> {
    const { conn } = await openStream(m, chatProtocol, 'sdkUpload', {}, { signal });
    try {
      const cw = new ChunkWriter(conn.stream);
      await cw.write(tarball);
      await cw.finish();
      const timer = setTimeout(() => conn.stream.destroy(new Error('no answer in time')), this.o.uploadMs ?? DOWNLOAD_MS);
      let rep: { ok?: boolean; error?: string };
      try {
        rep = await readLine<{ ok?: boolean; error?: string }>(conn.reader);
      } finally {
        clearTimeout(timer);
      }
      if (!rep.ok) throw new Error(rep.error ?? 'the machine refused it');
    } finally {
      conn.reader.release();
      closeStream(conn.stream);
    }
  }
}
