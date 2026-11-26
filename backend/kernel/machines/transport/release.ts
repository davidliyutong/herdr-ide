// What a hub that deploys the TypeScript machine side knows of its
// release: the manifest (SHA256SUMS), which names the SHA-256 of each
// platform's archive (<bin>-<platform>.tar.gz) and of the executable in it
// (<bin>-<platform>/<bin>), and where the archives come from when a
// machine cannot download one itself.
//
// The manifest, first of:
//   - the operator's directory (--agent-dir/SHA256SUMS: offline sites);
//   - the hub host's cache (a manifest the hub fetched, per version);
//   - the release, fetched by the hub over its own HTTPS (Bun's or Node's
//     fetch, which verify the certificate; the proxy of the environment,
//     shared/lib/proxy.ts), then cached;
//   - when that fetch found the release unreachable (no name, no route, a
//     refused connection, no answer in time), the release fetched by the
//     hub again, through the machine (tunnel: an ssh stdio forward), its
//     TLS still the hub's own, end to end (tunnel.ts), then cached.
// A fetch that reached something (a certificate the hub does not trust,
// an HTTP answer, a manifest it refuses) ends there: the machine is not
// asked, whose own download of the manifest could not be told from one an
// attacker on its path gave it. There is no manifest the hub did not
// verify itself.
// A manifest is this build's only when it names this hub's own executable
// (its platform's line) by its digest: one of another release is refused.
// A hub without an executable of its own (the desktop app on Windows)
// cannot tell, and says so in its log.
//
// What the hub uploads, first of: the operator's directory (the archive,
// or the executable as <bin>-<platform>), the cache, the hub's own
// executable for a machine of its platform, a download of the archive from
// the release (then cached). Each is checked against the manifest's digest
// (the own executable is the running one) before it is used or cached.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createGunzip, gzip } from 'node:zlib';
import { waitForResult } from '#shared/lib/wait.ts';
import { archiveMember, archiveName, bareName, type TSDigests, type TSPayload } from './builds.ts';
import { DeployCode, Unsupported } from './errors.ts';
import { tunnelGet, type OpenStream } from './tunnel.ts';

/** Bounds an archive and an executable (they are about 55 and 120 MB). */
export const MAX_ARCHIVE = 256 << 20;
export const MAX_EXECUTABLE = 512 << 20;
/** Bounds the manifest. */
export const MAX_SUMS = 1 << 20;
/** The manifest's name in a release and in --agent-dir. */
export const SUMS = 'SHA256SUMS';
/** How long a cached archive or manifest is kept after its last use. */
export const CACHE_RETENTION_MS = 14 * 24 * 60 * 60_000;
/** How long a failed fetch of the manifest keeps the hub from trying
 * again. */
const FETCH_RETRY_MS = 10 * 60_000;
/** How long the hub's downloads may take in all (the manifest is small:
 * a release that does not answer within this is unreachable). */
const SUMS_TIMEOUT_MS = 15_000;
const ARCHIVE_TIMEOUT_MS = 10 * 60_000;

const gzipAsync = promisify(gzip);
const HEX64 = /^[0-9a-f]{64}$/;

/** The lines of a manifest: name to SHA-256 (sha256sum's format, text or
 * binary mode); other lines are ignored. Two lines that name a file with
 * different digests make it no manifest. */
export function parseSums(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split('\n')) {
    const r = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trimEnd());
    if (!r) continue;
    const d = r[1].toLowerCase();
    if (m.has(r[2]) && m.get(r[2]) !== d) throw new Error(`${SUMS} names ${r[2]} twice, with different digests`);
    m.set(r[2], d);
  }
  return m;
}

/** A failed fetch's message, with its cause's. */
const errorText = (e: unknown): string => {
  const x = e as { message?: string; cause?: { message?: string; code?: unknown } };
  const cause = x?.cause?.message ?? (typeof x?.cause?.code === 'string' ? x.cause.code : '');
  return [x?.message ?? String(e), cause].filter(Boolean).join(': ');
};

/** The codes of a fetch that reached nothing (Bun puts them on the error,
 * Node on its cause). */
const UNREACHABLE = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ConnectionRefused',
  'FailedToOpenSocket',
]);

/** Whether a failed fetch found its host unreachable: no name, no route, a
 * refused connection, or no answer in time. A certificate error, an HTTP
 * answer or anything else is not. */
export function unreachable(e: unknown): boolean {
  const x = e as {
    name?: string;
    code?: unknown;
    cause?: { code?: unknown; errors?: { code?: unknown }[] };
    errors?: { code?: unknown }[];
  } | null;
  if (x?.name === 'TimeoutError') return true;
  const codes = [x?.code, x?.cause?.code, ...(x?.errors ?? []).map((y) => y?.code), ...(x?.cause?.errors ?? []).map((y) => y?.code)];
  return codes.some((c) => typeof c === 'string' && UNREACHABLE.has(c));
}

/** The hub's own executable, for a machine of its platform (and to tell
 * its release's manifest from another). */
export interface OwnExecutable {
  key: string;
  /** Its SHA-256. */
  digest(): Promise<string>;
  /** It gzip-compressed. */
  gz(): Promise<Buffer>;
}

/** The own executable as an open file (the command line's, compiled):
 * the running program, opened when it started (/proc/self/exe on Linux),
 * so a file put at its path since (an upgrade in place) is not taken for
 * it. Read through the descriptor from its start each time. */
export function ownFile(key: string, fd: number): OwnExecutable {
  const stream = () => createReadStream('', { fd, start: 0, autoClose: false });
  let d: Promise<string> | undefined;
  return {
    key,
    digest: () => (d ??= hashOwnFile(stream())),
    gz: async () => {
      const r = await collect(stream(), MAX_EXECUTABLE, 'the own executable');
      if (r.digest !== (await (d ??= Promise.resolve(r.digest)))) throw new Error('the own executable changed');
      return gzipAsync(r.bytes, { level: 6 });
    },
  };
}

async function hashOwnFile(chunks: AsyncIterable<Buffer>): Promise<string> {
  const h = createHash('sha256');
  let n = 0;
  for await (const chunk of chunks) {
    n += chunk.length;
    if (n > MAX_EXECUTABLE) throw new Error(`the own executable is larger than ${MAX_EXECUTABLE} bytes`);
    h.update(chunk);
  }
  return h.digest('hex');
}

/** The own executable gzip-compressed (the desktop app carries it so). */
export function ownGz(key: string, read: () => Promise<Uint8Array | null>): OwnExecutable | null {
  let d: Promise<string> | undefined;
  const gz = async () => {
    const b = await read();
    if (!b) throw new Error(`no executable for ${key} in this build`);
    return Buffer.from(b);
  };
  return { key, digest: () => (d ??= gz().then((b) => gunzipDigest(b))), gz };
}

/** The bytes of chunks, at most max, and their SHA-256, hashed as they come
 * (nothing large is hashed in one go on the event loop). */
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

/** The chunks of a buffer, so that it is hashed piecewise. */
function* pieces(b: Uint8Array, size = 1 << 20): Generator<Uint8Array> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}

/** The SHA-256 of gzip data decompressed (in zlib's threads), at most
 * MAX_EXECUTABLE bytes. */
async function gunzipDigest(gz: Buffer): Promise<string> {
  const h = createHash('sha256');
  let n = 0;
  for await (const c of Readable.from(pieces(gz)).pipe(createGunzip()) as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > MAX_EXECUTABLE) throw new Error(`the executable is larger than ${MAX_EXECUTABLE} bytes`);
    h.update(c);
  }
  return h.digest('hex');
}

/** Downloads url, at most max bytes within timeoutMs, hashing it as it
 * comes. The proxy is the environment's (shared/lib/proxy.ts). */
export async function download(
  url: string,
  max: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; digest: string }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'follow' });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${url}: ${res.status}`);
  }
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body.cancel().catch(() => {});
    throw new Error(`${url} is larger than ${max} bytes`);
  }
  return collect(res.body as unknown as AsyncIterable<Uint8Array>, max, url);
}

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

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** A manifest and where it came from. */
export interface Manifest {
  sums: Map<string, string>;
  source: string;
}

interface Discovery {
  m: Manifest | null;
  reasons: string[];
}

export interface ReleaseOptions {
  /** The hub's version (the cache's key). */
  version: string;
  /** The release's download URL (…/releases/download/<tag>); absent for a
   * build of no release. */
  url?: string;
  /** The operator's directory (--agent-dir). */
  dir?: string;
  /** The build's own SHA256SUMS, carried by a desktop app built from a
   * release's executables without its URL (scripts/build.sh RELEASE_SUMS). */
  sums?: string;
  /** The hub host's cache of manifests and archives. */
  cacheDir: string;
  own?: OwnExecutable | null;
  /** Certificate authorities the fetch through a machine trusts in place of
   * the default ones (tests). */
  tunnelCA?: string | Buffer;
  /** Where what was refused is logged with its paths (the errors the
   * machines' states carry name none of the hub's host). */
  logger?: (line: string) => void;
  now?: () => number;
}

/** A hub's release: its manifest and the archives of every platform. */
export class Release {
  private verified?: Manifest;
  private direct?: Promise<Discovery & { viaTunnel: boolean }>;
  private forwarded?: { tunnel: OpenStream; result: Promise<Discovery> };
  private unreachableAt = -Infinity;
  private readonly loads = new Map<string, Promise<TSPayload>>();
  private ownChecked = false;
  private readonly o: ReleaseOptions;
  constructor(o: ReleaseOptions) {
    this.o = o;
  }

  private log(line: string) {
    this.o.logger?.(line);
  }
  private now() {
    return (this.o.now ?? Date.now)();
  }
  private cacheSums() {
    return join(this.o.cacheDir, `${SUMS}-${this.o.version.replace(/[^A-Za-z0-9._-]/g, '_')}`);
  }

  /** The URL of a file of the release. */
  url(name: string): string | undefined {
    return this.o.url ? `${this.o.url.replace(/\/$/, '')}/${name}` : undefined;
  }

  /** Refuses a manifest of another build: its line of this hub's own
   * executable must be that executable's digest. */
  private async ofThisBuild(sums: Map<string, string>, source: string): Promise<void> {
    const own = this.o.own;
    if (!own) {
      if (!this.ownChecked) this.log(`${SUMS} from ${source}: this hub has no executable of its own to check its version against`);
      this.ownChecked = true;
      return;
    }
    const line = sums.get(archiveMember(own.key));
    const mine = await own.digest();
    if (line !== mine)
      throw new Error(`${SUMS} of another build: it names ${archiveMember(own.key)} ${line ?? 'not at all'}, this hub is ${mine}`);
  }

  private async parse(text: string, source: string, label: string, reasons: string[]): Promise<Manifest | null> {
    try {
      const sums = parseSums(text);
      await this.ofThisBuild(sums, label);
      return { sums, source };
    } catch (e) {
      reasons.push(`${label}: ${(e as Error).message}`);
      this.log(`${source}: refused: ${(e as Error).message}`);
      return null;
    }
  }

  private async keep(file: string, content: string | Buffer): Promise<void> {
    await mkdir(this.o.cacheDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
      await rename(tmp, file);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** Checks sources available to the hub itself. A tunnel is allowed
   * only when the release is unreachable. */
  private async find(reasons: string[]): Promise<Manifest | null | 'tunnel'> {
    if (this.o.sums) {
      const m = await this.parse(this.o.sums, `this build's ${SUMS}`, `this build's ${SUMS}`, reasons);
      if (m) return m;
    }
    if (this.o.dir) {
      const p = join(this.o.dir, SUMS);
      if (await exists(p)) {
        const m = await this.parse(
          (await collect(createReadStream(p), MAX_SUMS, p)).bytes.toString('utf8'),
          p,
          `--agent-dir's ${SUMS}`,
          reasons,
        );
        if (m) return m;
      }
    }
    const cached = this.cacheSums();
    if (await exists(cached)) {
      const m = await this.parse(
        (await collect(createReadStream(cached), MAX_SUMS, cached)).bytes.toString('utf8'),
        cached,
        `the cache's ${SUMS}`,
        reasons,
      );
      if (m) {
        await utimes(cached, new Date(this.now()), new Date(this.now())).catch(() => {});
        return m;
      }
      await rm(cached, { force: true });
    }
    const url = this.url(SUMS);
    if (!url) {
      reasons.push('this build has no release to download it from');
      return null;
    }
    // The hub's own fetch, not again for a while once the release was
    // unreachable.
    if (this.now() - this.unreachableAt >= FETCH_RETRY_MS) {
      try {
        const text = (await download(url, MAX_SUMS, SUMS_TIMEOUT_MS)).bytes.toString('utf8');
        const m = await this.parse(text, url, `the release's ${SUMS}`, reasons);
        if (m) await this.keep(cached, text);
        return m;
      } catch (e) {
        const why = errorText(e);
        this.log(`the hub could not download ${url}: ${why}`);
        if (!unreachable(e)) {
          // It reached something that is not the release as the hub
          // trusts it: the machine is not asked instead.
          reasons.push(`the hub could not download ${url}: ${why}`);
          return null;
        }
        this.unreachableAt = this.now();
        reasons.push(`the hub cannot reach ${url} (${why})`);
      }
    } else reasons.push(`the hub could not reach ${url} lately`);
    return 'tunnel';
  }

  private async findForwarded(tunnel: OpenStream): Promise<Discovery> {
    const url = this.url(SUMS)!;
    const reasons: string[] = [];
    try {
      const text = (
        await tunnelGet(url, tunnel, {
          max: MAX_SUMS,
          timeoutMs: 60_000,
          ...(this.o.tunnelCA ? { ca: this.o.tunnelCA } : {}),
        })
      ).toString('utf8');
      const m = await this.parse(text, `${url} (through the machine)`, `the release's ${SUMS} through the machine`, reasons);
      if (m) await this.keep(this.cacheSums(), text);
      return { m, reasons };
    } catch (e) {
      const why = errorText(e);
      reasons.push(`the hub could not download ${url} through the machine either: ${why}`);
      this.log(
        `the hub could not download ${url} through the machine (ssh -W; a machine whose sshd forbids forwarding, AllowTcpForwarding no, cannot carry it: give the hub a route to the release, or --agent-dir with the release's files): ${why}`,
      );
      return { m: null, reasons };
    }
  }

  /** The manifest, or null with the reasons; a found one is kept. */
  async manifest(signal?: AbortSignal, tunnel?: OpenStream): Promise<Discovery> {
    signal?.throwIfAborted();
    if (this.verified) return { m: this.verified, reasons: [] };
    const reasons: string[] = [];
    this.direct ??= this.find(reasons)
      .then((r) => {
        if (r && r !== 'tunnel') this.verified = r;
        return { m: this.verified ?? null, reasons, viaTunnel: r === 'tunnel' };
      })
      .finally(() => (this.direct = undefined));
    const direct = await waitForResult(this.direct, signal);
    if (direct.m || !direct.viaTunnel || !tunnel) return direct;
    while (!this.verified) {
      signal?.throwIfAborted();
      const shared: NonNullable<Release['forwarded']> = (this.forwarded ??= {
        tunnel,
        result: this.findForwarded(tunnel)
          .then((r) => {
            if (r.m) this.verified = r.m;
            return r;
          })
          .finally(() => (this.forwarded = undefined)),
      });
      const r = await waitForResult(shared.result, signal);
      if (r.m || shared.tunnel === tunnel) return { m: r.m, reasons: [...direct.reasons, ...r.reasons] };
    }
    return { m: this.verified, reasons: [] };
  }

  /** The digests of key's build. */
  async digests(key: string, o: { signal?: AbortSignal; tunnel?: OpenStream } = {}): Promise<TSDigests> {
    const { m, reasons } = await this.manifest(o.signal, o.tunnel);
    if (m) {
      const exe = m.sums.get(archiveMember(key));
      const archive = m.sums.get(archiveName(key));
      if (exe && HEX64.test(exe)) return { exe, ...(archive && HEX64.test(archive) ? { archive } : {}), source: m.source };
      reasons.push(`${SUMS} has no executable for ${key}`);
    }
    if (this.o.own && this.o.own.key === key) return { exe: await this.o.own.digest(), source: "this hub's own executable" };
    throw new Unsupported(
      DeployCode.BuildUnavailable,
      `no machine build for ${key}: ${reasons.join('; ')}; put the release's ${SUMS} and ${archiveName(key)} into the hub's --agent-dir`,
    );
  }

  /** What the hub uploads for key's build of digests d (one load per
   * build at a time, shared by the machines that wait for it). */
  load(key: string, d: TSDigests): Promise<TSPayload> {
    const id = `${key}:${d.exe}:${d.archive ?? ''}`;
    let p = this.loads.get(id);
    if (!p) {
      // Shared: no one machine's signal ends it.
      p = this.resolve(key, d).finally(() => this.loads.delete(id));
      this.loads.set(id, p);
    }
    return p;
  }

  private async resolve(key: string, d: TSDigests, signal?: AbortSignal): Promise<TSPayload> {
    const reasons: string[] = [];
    const refused = (label: string, path: string, e: unknown) => {
      const message = (e as Error).message;
      reasons.push(`${label}: ${path ? message.replaceAll(path, label) : message}`);
      this.log(`machine build ${key}: ${path || label} refused: ${message}`);
    };
    const archiveOK = (r: { digest: string }) => {
      if (!d.archive) throw new Error(`${SUMS} names no ${archiveName(key)}`);
      if (r.digest !== d.archive) throw new Error(`sha256 ${r.digest} is not the release's ${d.archive}`);
    };
    if (this.o.dir) {
      const a = join(this.o.dir, archiveName(key));
      if (await exists(a))
        try {
          const r = await collect(createReadStream(a), MAX_ARCHIVE, a);
          archiveOK(r);
          return { kind: 'archive', bytes: r.bytes };
        } catch (e) {
          refused(`--agent-dir's ${archiveName(key)}`, a, e);
        }
      const x = join(this.o.dir, bareName(key));
      if (await exists(x))
        try {
          const r = await collect(createReadStream(x), MAX_EXECUTABLE, x);
          if (r.digest !== d.exe) throw new Error(`sha256 ${r.digest} is not the build's ${d.exe}`);
          return { kind: 'gz', bytes: await gzipAsync(r.bytes, { level: 6 }) };
        } catch (e) {
          refused(`--agent-dir's ${bareName(key)}`, x, e);
        }
    }
    const now = this.now();
    await pruneCache(this.o.cacheDir, now);
    const file = join(this.o.cacheDir, `${bareName(key)}-${d.exe.slice(0, 16)}.tar.gz`);
    if (d.archive && (await exists(file)))
      try {
        const r = await collect(createReadStream(file), MAX_ARCHIVE, file);
        archiveOK(r);
        await utimes(file, new Date(now), new Date(now));
        return { kind: 'archive', bytes: r.bytes };
      } catch (e) {
        refused(`the cache's ${archiveName(key)}`, file, e);
        await rm(file, { force: true });
      }
    const own = this.o.own;
    if (own && own.key === key)
      try {
        const mine = await own.digest();
        if (mine !== d.exe) throw new Error(`sha256 ${mine} is not the build's ${d.exe}`);
        return { kind: 'gz', bytes: await own.gz() };
      } catch (e) {
        refused("the hub's own executable", '', e);
      }
    const url = this.url(archiveName(key));
    if (!url || !d.archive) {
      reasons.push(url ? `${SUMS} names no ${archiveName(key)}` : 'this build has no release to download it from');
      throw new Unsupported(
        DeployCode.BuildUnavailable,
        `no machine build for ${key} (${reasons.join('; ')}); put ${archiveName(key)} of the release into the hub's --agent-dir`,
      );
    }
    let r: { bytes: Buffer; digest: string };
    try {
      r = await download(url, MAX_ARCHIVE, ARCHIVE_TIMEOUT_MS, signal);
      archiveOK(r);
    } catch (e) {
      if (signal?.aborted) throw e;
      reasons.push(`the download failed: ${(e as Error).message}`);
      this.log(`machine build ${key}: the download from ${url} failed: ${(e as Error).message}`);
      throw new Unsupported(
        DeployCode.BuildUnavailable,
        `no machine build for ${key} (${reasons.join('; ')}); put ${archiveName(key)} of the release into the hub's --agent-dir, or let the hub or the machine reach ${url}`,
      );
    }
    await this.keep(file, r.bytes);
    return { kind: 'archive', bytes: r.bytes };
  }
}
