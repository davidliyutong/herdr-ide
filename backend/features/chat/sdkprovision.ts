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
// sdk_unavailable, saying what each source said.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import type { Logger } from '#shared/lib/log.ts';
import { ChunkWriter, readLine } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { call, open } from '#kernel/agent.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { download, pruneCache } from '#kernel/machines/transport/release.ts';
import { CLAUDE_SDK, MAX_SDK_TARBALL, NPM_REGISTRY, integrityRefusal, tarballURL, type NpmTarball } from './claudesdk.ts';
import { chatProtocol } from './protocol.ts';

export interface SdkProvisionOptions {
  /** The operator's directories of artifacts (--seed-dir), searched first. */
  seedDirs?: readonly string[];
  /** The core's cache of the tarballs it got. */
  cacheDir: string;
  /** Never download: neither the core nor the machines (--offline). */
  offline?: boolean;
  /** The npm registry (--npm-registry). */
  registry?: string;
  logger: Logger;
  /** The pinned tarball (tests pin their own). */
  pin?: NpmTarball;
  /** Bounds the core's download, the machine's (its action's answer), and
   * the upload with its install. */
  downloadMs?: number;
  machineMs?: number;
  uploadMs?: number;
  /** The clock (tests move it). */
  now?: () => number;
}

/** How long a machine's word that it has the SDK holds on the same agent
 * session: asked again after that, it keeps its copy in use (the machine's
 * retention counts from the last use) or installs it again if it went. */
export const SDK_RECHECK_MS = 60 * 60_000;

/** The core's refusal of a Claude Code chat the machine cannot run. */
export const sdkUnavailable = (message: string): Fail => new Fail(chat.Code.SdkUnavailable, 503, message);

const sha512 = (b: Uint8Array): string => createHash('sha512').update(b).digest('base64');

/** At most max bytes of a file. */
async function readBounded(p: string, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const b of createReadStream(p, { highWaterMark: 256 << 10 }) as AsyncIterable<Buffer>) {
    n += b.length;
    if (n > max) throw new Error(`larger than ${max} bytes`);
    parts.push(b);
  }
  return Buffer.concat(parts, n);
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** What a machine's chat host needs of the SDK, as this core got it there. */
interface MachineState {
  /** The agent session the SDK was found installed on (or found needless
   * on: a Go build's); null until then. */
  session: object | null;
  /** When it was. */
  at: number;
  lock: Promise<void>;
}

/** The SDK on the machines, as this core got it there. */
export class SdkProvision {
  readonly pin: NpmTarball;
  readonly url: string;
  private readonly o: SdkProvisionOptions;
  private readonly states = new Map<string, MachineState>();
  /** The core's tarball, loaded once for every machine that waits for it;
   * a failure is tried again. */
  private load: Promise<Buffer> | null = null;

  constructor(o: SdkProvisionOptions) {
    this.o = o;
    this.pin = o.pin ?? CLAUDE_SDK;
    this.url = tarballURL(this.pin, o.registry || NPM_REGISTRY);
  }

  private state(id: string): MachineState {
    let s = this.states.get(id);
    if (!s) this.states.set(id, (s = { session: null, at: 0, lock: Promise.resolve() }));
    return s;
  }

  /** Drops what is kept of a removed machine. */
  forget(id: string): void {
    this.states.delete(id);
  }

  /** Makes sure machine m's chat host can load the SDK, unless it did on
   * the machine's current agent session within SDK_RECHECK_MS; callers
   * wait for each other. Fails with sdk_unavailable and what each source
   * said. */
  async ensure(m: Machine, signal: AbortSignal): Promise<void> {
    const s = this.state(m.id);
    const before = s.lock;
    let release!: () => void;
    s.lock = new Promise((r) => (release = r));
    await before;
    try {
      const now = this.o.now ?? Date.now;
      const sess = m.connected ? m.live() : null;
      if (sess && s.session === sess && now() - s.at < SDK_RECHECK_MS) return;
      await this.install(m, signal);
      s.session = sess;
      s.at = now();
    } finally {
      release();
    }
  }

  private async install(m: Machine, signal: AbortSignal): Promise<void> {
    const reasons: string[] = [];
    let res: { installed: boolean; error?: string };
    try {
      res = await call(m, chatProtocol, 'sdk', this.o.offline ? {} : { url: this.url }, { signal, timeoutMs: this.o.machineMs });
    } catch (e) {
      signal.throwIfAborted();
      // A machine build without the action (the Go build's chat host needs
      // no SDK).
      if (e instanceof Fail && e.code === 'bad_params' && /unknown action/.test(e.message)) return;
      throw e;
    }
    if (res.installed) return;
    reasons.push(
      this.o.offline
        ? 'the core is offline: the machine did not download it'
        : `the machine could not download it: ${res.error ?? 'no reason'}`,
    );
    let tarball: Buffer;
    try {
      tarball = await this.tarball(reasons, signal);
    } catch (e) {
      signal.throwIfAborted();
      reasons.push((e as Error).message);
      throw this.refusal(m, reasons);
    }
    try {
      await this.upload(m, tarball, signal);
    } catch (e) {
      signal.throwIfAborted();
      reasons.push(`the core's upload failed: ${(e as Error).message}`);
      throw this.refusal(m, reasons);
    }
  }

  private refusal(m: Machine, reasons: string[]): Fail {
    const why = `${this.pin.name} ${this.pin.version} could not be installed on ${m.label}: ${reasons.join('; ')}`;
    this.o.logger(`chat: ${why}`);
    return sdkUnavailable(`${why}; let the machine or this core reach ${this.url}, or put ${this.pin.file} into a --seed-dir of this core`);
  }

  /** The tarball as the core has it: from a seed directory, its cache or
   * its own download, checked against the pinned integrity. */
  tarball(reasons: string[] = [], signal?: AbortSignal): Promise<Buffer> {
    if (!this.load) {
      // Shared: no one machine's signal ends it.
      const p = this.resolve(reasons);
      this.load = p;
      p.catch(() => {
        if (this.load === p) this.load = null;
      });
    }
    const p = this.load;
    if (!signal) return p;
    return Promise.race([
      p,
      new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(signal.reason as Error), { once: true })),
    ]);
  }

  private async resolve(reasons: string[]): Promise<Buffer> {
    const t = this.pin;
    const check = (b: Buffer) => {
      const why = integrityRefusal(t, sha512(b));
      if (why) throw new Error(why);
      return b;
    };
    for (const dir of this.o.seedDirs ?? []) {
      const p = join(dir, t.file);
      if (!(await exists(p))) continue;
      try {
        return check(await readBounded(p, MAX_SDK_TARBALL));
      } catch (e) {
        reasons.push(`the seed directory's ${t.file} was refused: ${(e as Error).message}`);
        this.o.logger(`chat: ${p} refused: ${(e as Error).message}`);
      }
    }
    await pruneCache(this.o.cacheDir);
    const cached = join(this.o.cacheDir, t.file);
    if (await exists(cached))
      try {
        const b = check(await readBounded(cached, MAX_SDK_TARBALL));
        const now = new Date();
        await utimes(cached, now, now).catch(() => {});
        return b;
      } catch (e) {
        this.o.logger(`chat: ${cached} refused: ${(e as Error).message}`);
        await rm(cached, { force: true });
      }
    if (this.o.offline) throw new Error(`the core is offline and has no ${t.file} in a --seed-dir or its cache`);
    let b: Buffer;
    try {
      b = check((await download(this.url, MAX_SDK_TARBALL, this.o.downloadMs ?? 5 * 60_000)).bytes);
    } catch (e) {
      throw new Error(`the core could not download ${this.url}: ${(e as Error).message}`);
    }
    await mkdir(this.o.cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(`${cached}.${process.pid}`, b, { mode: 0o600 });
    await rename(`${cached}.${process.pid}`, cached);
    return b;
  }

  /** Sends the tarball to m's chat feature, which installs it. */
  private async upload(m: Machine, tarball: Buffer, signal: AbortSignal): Promise<void> {
    const { conn } = await open(m, chatProtocol, 'sdkUpload', {}, { signal });
    try {
      const cw = new ChunkWriter(conn.stream);
      await cw.write(tarball);
      await cw.finish();
      const timer = setTimeout(() => conn.stream.destroy(new Error('no answer in time')), this.o.uploadMs ?? 5 * 60_000);
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
