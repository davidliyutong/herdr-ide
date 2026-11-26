// The instance's terminal core: herdr-core, an executable the hub uploads
// (the release backend/scripts/hcdist.ts pins, which each executable carries), and one core
// per instance in a session of its own, so it shares neither terminals nor
// state with a herdr-core the user runs. The terminal core belongs to the
// user's account, not to the agent: it and its programs keep running when
// the agent exits, until the stop action, which only an instance's own
// command gives (`node stop --terminal-core`, op hc stop).
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { execa } from 'execa';
import { SLUG } from '#shared/lib/brand.ts';
import { Fail } from '#shared/lib/fail.ts';
import * as hostid from '#shared/host/hostid.ts';
import type { Dirs } from '#shared/host/hostdirs.ts';
import { ChunkReader, HCCode, type HCStatus } from '#shared/proto/agentproto/index.ts';
import { probe } from '#shared/proto/hc/index.ts';
import type { Reader } from '#shared/lib/streamio.ts';
import { cleanEnv } from './env.ts';

const BIN = 'herdr-core';
/** Bounds an uploaded executable (releases are about 8 MB). */
export const MAX_BINARY = 64 << 20;
/** Installs that did not finish are removed after this long. */
const STAGING_RETENTION_MS = 60 * 60_000;
/** How long a herdr-core command may run. */
const RUN_MS = 45_000;

/** The terminal core's session of instance on this host:
 * <slug>[-<instance>]-<hostid.id>. herdr-core keeps a core, its terminals
 * and its state per session name; the host's id keeps the cores of hosts
 * that share the home apart. */
export const hcSession = (instance: string): string => (instance === '' ? `${SLUG}-${hostid.id()}` : `${SLUG}-${instance}-${hostid.id()}`);

/** Whether d is a SHA-256 in lowercase hex. */
export const validDigest = (d: string | undefined): d is string => !!d && /^[0-9a-f]{64}$/.test(d);

/** The terminal core of an instance on this host. */
export class TerminalCore {
  readonly instance: string;
  private readonly dirs: Dirs;
  private hashed: { dev: number; ino: number; size: number; ctimeMs: number; mtimeMs: number; digest: string } | null = null;
  /** Installs, starts and stops run one at a time. */
  private op: Promise<unknown> = Promise.resolve();
  /** A new executable has replaced the running core's and needs a restart. */
  pendingRestart = '';

  /** Gives the herdr-core this build carries (tests give another). */
  private readonly carry?: () => { gz: Buffer; digest: string } | null;

  constructor(instance: string, dirs: Dirs, carry?: () => { gz: Buffer; digest: string } | null) {
    this.instance = instance;
    this.dirs = dirs;
    this.carry = carry;
  }

  /** The executable's directory, per host: one replaced on a shared home
   * would end another host's core, or be of another architecture. */
  get dir(): string {
    return join(this.dirs.host, 'hc');
  }
  get bin(): string {
    return join(this.dir, BIN);
  }
  get session(): string {
    return hcSession(this.instance);
  }
  /** The API socket, in the private run directory. */
  get socket(): string {
    return join(this.dirs.run, 'hc.sock');
  }

  /** The environment of a herdr-core command: the agent's, selecting the
   * instance's session and socket. */
  env(): Record<string, string> {
    return { ...cleanEnv(), HC_SESSION: this.session, HC_SOCKET: this.socket };
  }

  /** The SHA-256 of the installed executable, "" without one. A fresh
   * check reads the file again even when its metadata matches. */
  async digest(fresh = false): Promise<string> {
    const st = await lstat(this.bin).catch(() => null);
    if (!st?.isFile() || (st.mode & 0o100) === 0 || st.size > MAX_BINARY) return '';
    const same = (f: { dev: number; ino: number; size: number; ctimeMs: number; mtimeMs: number }) =>
      f.dev === st.dev && f.ino === st.ino && f.size === st.size && f.ctimeMs === st.ctimeMs && f.mtimeMs === st.mtimeMs;
    const h = this.hashed;
    if (!fresh && h && same(h)) return h.digest;
    const f = await open(this.bin, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch(() => null);
    if (!f) return '';
    try {
      if (!same(await f.stat())) return '';
      const hash = createHash('sha256');
      const buf = Buffer.allocUnsafe(1 << 20);
      let total = 0;
      for (let n; (n = (await f.read(buf, 0, buf.length, null)).bytesRead) > 0;) {
        total += n;
        if (total > MAX_BINARY) return '';
        hash.update(buf.subarray(0, n));
      }
      if (!same(await lstat(this.bin))) return '';
      this.hashed = { dev: st.dev, ino: st.ino, size: st.size, ctimeMs: st.ctimeMs, mtimeMs: st.mtimeMs, digest: hash.digest('hex') };
      return this.hashed.digest;
    } catch {
      return '';
    } finally {
      await f.close().catch(() => {});
    }
  }

  /** The herdr-core this build carries (the compiled machine executable
   * embeds its platform's: a file named herdr-core.gz); null without one. */
  embedded(): Promise<{ gz: Buffer; digest: string } | null> {
    this.carried ??= this.carry ? Promise.resolve(this.carry()) : carriedHC();
    return this.carried;
  }
  private carried: Promise<{ gz: Buffer; digest: string } | null> | undefined;

  /** Whether a core answers on the socket, and its version. */
  async status(signal?: AbortSignal): Promise<HCStatus> {
    const carried = await this.embedded();
    const st: HCStatus = {
      atomic_ensure: true,
      digest: (await this.digest()) || undefined,
      ...(carried ? { embedded: carried.digest } : {}),
      running: false,
      session: this.session,
      socket: this.socket,
    };
    const hello = await this.probe(signal);
    if (hello) {
      st.running = true;
      st.version = hello;
    }
    return st;
  }

  /** The version of the core that answers on the socket within 5 s; null
   * when none does. */
  async probe(signal?: AbortSignal): Promise<string | null> {
    const c = connect(this.socket);
    c.on('error', () => {});
    try {
      const timeout = AbortSignal.timeout(5000);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      await new Promise<void>((res, rej) => {
        c.once('connect', res);
        c.once('error', rej);
        sig.addEventListener('abort', () => rej(new Error('timeout')), { once: true });
      });
      return (await probe(c, sig)).version;
    } catch {
      c.destroy();
      return null;
    }
  }

  /** Runs f after the operations before it. */
  serialized<T>(f: () => Promise<T>): Promise<T> {
    const p = this.op.then(f, f);
    this.op = p.catch(() => {});
    return p;
  }

  /** Writes the gzip-compressed executable read from r's chunks
   * (ChunkWriter), checks its digest and swaps it in whole, as
   * herdr-core's own update does: a running core and its holders keep the
   * executable they started from. */
  async install(digest: string, r: Reader): Promise<void> {
    return this.installGz(digest, new ChunkReader(r));
  }

  /** Installs the herdr-core this build carries, when it is digest. */
  async installEmbedded(digest: string): Promise<void> {
    const e = await this.embedded();
    if (!e) throw new Fail(HCCode.NotInstalled, 400, 'this build carries no herdr-core');
    if (e.digest !== digest) throw new Fail(HCCode.BadDigest, 400, `this build carries herdr-core ${e.digest}, not ${digest}`);
    return this.installGz(digest, [e.gz]);
  }

  /** Writes the gzip-compressed executable of chunks, checked by digest. */
  private async installGz(digest: string, chunks: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<void> {
    if (!validDigest(digest)) throw new Fail(HCCode.BadDigest, 400, 'bad digest');
    if ((await this.digest()) === digest) {
      for await (const _ of chunks) {
        // drained
      }
      return;
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      for (const e of await readdir(this.dir)) {
        if (!e.startsWith('.fetch-')) continue;
        const p = join(this.dir, e);
        if (Date.now() - (await stat(p)).mtimeMs > STAGING_RETENTION_MS) await rm(p, { force: true });
      }
    } catch {
      // nothing to prune
    }
    const tmp = join(this.dir, `.fetch-${process.pid}-${randomUUID()}`);
    try {
      const hash = createHash('sha256');
      let n = 0;
      const check = new Transform({
        transform(b: Buffer, _encoding, cb) {
          n += b.length;
          if (n > MAX_BINARY) return cb(new Error('executable too large'));
          hash.update(b);
          cb(null, b);
        },
      });
      await pipeline(Readable.from(chunks), createGunzip(), check, createWriteStream(tmp, { flags: 'wx', mode: 0o700 }));
      await chmod(tmp, 0o700);
      const got = hash.digest('hex');
      if (got !== digest) throw new Error(`sha256 ${got} does not match expected ${digest}`);
      await rename(tmp, this.bin);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** Runs the installed herdr-core with args for the instance's session. */
  async run(args: string[], signal?: AbortSignal): Promise<void> {
    const r = await execa(this.bin, args, {
      env: this.env(),
      extendEnv: false,
      cwd: this.dirs.home,
      all: true,
      reject: false,
      timeout: RUN_MS,
      cancelSignal: signal,
      forceKillAfterDelay: 5000,
      stdin: 'ignore',
    });
    if (r.exitCode !== 0 || r.failed) {
      const out = (r.all ?? '').toString().trim();
      throw new Error(`${r.shortMessage}: ${out.length > 2000 ? out.slice(0, 2000) + '…' : out}`);
    }
  }

  /** Stops the core when one answers on its socket (`server stop` of the
   * instance's executable, session and socket; `server status` would start
   * one); whether one was stopped. */
  async stopIfRunning(signal?: AbortSignal): Promise<boolean> {
    const answers = await new Promise<boolean>((res) => {
      const c = connect(this.socket);
      const t = setTimeout(() => {
        c.destroy();
        res(false);
      }, 2000);
      c.once('connect', () => {
        clearTimeout(t);
        c.destroy();
        res(true);
      });
      c.once('error', () => {
        clearTimeout(t);
        res(false);
      });
    });
    if (!answers) return false;
    if ((await this.digest()) === '') throw new Error('a terminal core answers but its executable is gone');
    await this.run(['server', 'stop', '--json'], signal);
    return true;
  }

  /** herdr-core relies on the socket's directory for privacy (the run
   * directory is 0700); the socket itself is made private as well. */
  async privateSocket(): Promise<void> {
    try {
      await chmod(this.socket, 0o600);
    } catch {
      // not there
    }
  }
}

/** The herdr-core embedded in this executable (herdr-core.gz,
 * backend/scripts/build.ts): null in a run from the sources or
 * a build without it. */
async function carriedHC(): Promise<{ gz: Buffer; digest: string } | null> {
  if (!Bun.isStandaloneExecutable) return null;
  const f = Bun.embeddedFiles.find((b) => (b as File).name === 'herdr-core.gz') as File | undefined;
  if (!f) return null;
  const gz = Buffer.from(await f.bytes());
  if (!gz.length) return null;
  const hash = createHash('sha256');
  let n = 0;
  await pipeline(Readable.from([gz]), createGunzip(), async (chunks) => {
    for await (const chunk of chunks) {
      n += chunk.length;
      if (n > MAX_BINARY) throw new Error('executable too large');
      hash.update(chunk);
    }
  });
  return { gz, digest: hash.digest('hex') };
}
