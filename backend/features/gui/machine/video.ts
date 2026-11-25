// Video encoding of program windows (the Go agent's guivideo.go). The hub
// brings an encoder built on ffmpeg (scripts/build-ffmpeg.sh,
// scripts/encoder) and pushes it to ~/<data>/video/<digest prefix>/encoder,
// shared by instances; the machine runs it only when its SHA-256 is the
// digest the hub sent. A machine build that carries its own encoder puts
// that one there when the hub has none for the machine. Builds not used
// for VERSION_RETENTION_MS are removed. Without one, or when it cannot
// encode, windows are sent as pictures. The GUI helper runs the encoders
// of windows; the node only probes once which kinds work.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { posix } from 'node:path';
import { createGunzip } from 'node:zlib';
import { DATA_DIR_NAME } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { STAGING_RETENTION_MS, VERSION_RETENTION_MS } from './display.ts';

/** Bounds what an install may write. */
export const MAX_BINARY = 256 << 20;
/** The kinds the encoder can make, in the order they are probed: avc1
 * (H.264 through NVENC, else VA-API on Intel and AMD GPUs) and vp8
 * (libvpx, on the CPU). */
export const KINDS = ['avc1', 'vp8'];
/** Starting an encoder (GPU initialization), and a frame's round trip. */
const START_MS = 15_000;
const FRAME_MS = 3_000;

export const validDigest = (d: string) => /^[0-9a-f]{64}$/.test(d);

export class Video {
  private bin = '';
  private kinds: string[] | null = null;
  private probing: Promise<string[]> | null = null;

  private readonly home: string;
  private readonly environ: () => Record<string, string>;
  private readonly logger: Logger;
  /** The encoder this machine build carries (gzip-compressed). */
  private readonly carried?: () => Promise<{ gz: Uint8Array; digest: string } | null>;

  constructor(
    home: string,
    environ: () => Record<string, string>,
    logger: Logger,
    carried?: () => Promise<{ gz: Uint8Array; digest: string } | null>,
  ) {
    this.home = home;
    this.environ = environ;
    this.logger = logger;
    this.carried = carried;
  }

  root = () => posix.join(this.home, DATA_DIR_NAME, 'video');
  dir = (digest: string) => posix.join(this.root(), digest.slice(0, 16));

  /** The encoder with digest when it is installed, hashed once per agent. */
  async ready(digest: string): Promise<string> {
    if (!validDigest(digest)) return '';
    const dir = this.dir(digest);
    const bin = posix.join(dir, 'encoder');
    if (this.bin !== bin) {
      try {
        const st = await lstat(bin);
        if (!st.isFile()) return '';
        const b = await readFile(bin);
        if (b.length > MAX_BINARY || createHash('sha256').update(b).digest('hex') !== digest) return '';
      } catch {
        return '';
      }
      this.bin = bin;
      this.kinds = null;
    }
    const now = new Date();
    await utimes(dir, now, now).catch(() => {}); // in use
    return bin;
  }

  /** Writes the gzip-compressed encoder read from chunks, checks its digest
   * and moves it into place. */
  async install(digest: string, chunks: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<void> {
    if (!validDigest(digest)) throw new Error('gui: bad encoder digest');
    if (await this.ready(digest)) {
      for await (const _ of chunks) {
        // drained
      }
      return;
    }
    const root = this.root();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const tmp = await mkdtemp(posix.join(root, '.fetch-'));
    try {
      const f = await open(posix.join(tmp, 'encoder'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o700);
      const h = createHash('sha256');
      let n = 0;
      try {
        const gunzip = createGunzip();
        const feed = (async () => {
          for await (const c of chunks) if (!gunzip.write(c)) await new Promise((r) => gunzip.once('drain', r));
          gunzip.end();
        })();
        feed.catch((e) => gunzip.destroy(e));
        for await (const c of gunzip as AsyncIterable<Buffer>) {
          n += c.length;
          if (n > MAX_BINARY) throw new Error('gui: encoder too large');
          h.update(c);
          await f.write(c);
        }
        await feed;
      } finally {
        await f.close();
      }
      const got = h.digest('hex');
      if (got !== digest) throw new Error(`gui: encoder sha256 ${got} does not match expected ${digest}`);
      const dir = this.dir(digest);
      await rm(dir, { recursive: true, force: true }); // a damaged copy
      await rename(tmp, dir);
      await this.prune(dir);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    if (!(await this.ready(digest))) throw new Error('gui: installed encoder is not usable');
  }

  /** The digest of the encoder this machine build carries, put in place;
   * '' without one. */
  async installCarried(): Promise<string> {
    const c = await this.carried?.();
    if (!c) return '';
    await this.install(c.digest, [Buffer.from(c.gz)]);
    return c.digest;
  }

  /** Removes other builds unused for VERSION_RETENTION_MS, and installs
   * that did not finish. */
  async prune(keep = '', now = Date.now(), stagingOnly = false): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.root());
    } catch {
      return;
    }
    for (const name of names) {
      const p = posix.join(this.root(), name);
      if (p === keep || (this.bin && posix.dirname(this.bin) === p)) continue;
      const st = await stat(p).catch(() => null);
      if (!st) continue;
      const limit = name.startsWith('.fetch-') ? STAGING_RETENTION_MS : stagingOnly ? Infinity : VERSION_RETENTION_MS;
      if (now - st.mtimeMs > limit) await rm(p, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The stream kinds bin makes on this machine, probed once per agent by
   * encoding a small frame. */
  kindsOf(bin: string): Promise<string[]> {
    if (this.bin === bin && this.kinds) return Promise.resolve(this.kinds);
    // Probing takes seconds (GPU initialization); windows are sent as
    // pictures meanwhile.
    this.probing ??= (async () => {
      const out: string[] = [];
      for (const k of KINDS) {
        const err = await this.probe(bin, k);
        if (!err) out.push(k);
        else this.logger(`gui: video ${k} unavailable: ${err}`);
      }
      if (this.bin === bin) this.kinds = out;
      return out;
    })().finally(() => (this.probing = null));
    return this.probing;
  }

  /** The encoder and the kinds it makes once installed and probed. */
  tools(): { bin: string; kinds: string[] } {
    return this.kinds ? { bin: this.bin, kinds: this.kinds } : { bin: '', kinds: [] };
  }

  /** Starts the encoder for kind and encodes one 256×144 frame: '' when it
   * works, else why not. */
  private async probe(bin: string, kind: string): Promise<string> {
    const w = 256;
    const h = 144;
    const child = spawn(bin, ['-w', String(w), '-h', String(h), '-kinds', kind], {
      env: this.environ(),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', (b: Buffer) => {
      if (stderr.length < 4096) stderr += b.toString('utf8');
    });
    child.stdin!.on('error', () => {});
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
    };
    const exited = new Promise<void>((r) => child.once('close', () => r()));
    child.once('error', () => {});
    const r = new Reader(child.stdout!);
    const timed = <T>(p: Promise<T>, ms: number) =>
      new Promise<T>((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout')), ms);
        p.then(
          (v) => (clearTimeout(t), res(v)),
          (e) => (clearTimeout(t), rej(e)),
        );
      });
    try {
      const line = await timed(r.line(256), START_MS);
      const f = line.trim().split(/\s+/);
      if (f[0] !== 'ok' || f.length < 2) return `encoder: ${line.replace(/^error\s*/, '').trim()} ${stderr.trim()}`.trim();
      const hdr = Buffer.alloc(4);
      child.stdin!.write(hdr);
      child.stdin!.write(Buffer.alloc(w * h * 4));
      const ph = await timed(r.exactly(8), FRAME_MS);
      const n = ph.readUInt32LE(0);
      if (n === 0 || n > 64 << 20) return `encoder: packet of ${n} bytes`;
      await timed(r.exactly(n), FRAME_MS);
      return '';
    } catch (e) {
      return `encoder: ${(e as Error).message} ${stderr.trim()}`.trim();
    } finally {
      child.stdin!.end();
      const t = setTimeout(kill, 2000);
      await exited;
      clearTimeout(t);
    }
  }
}
