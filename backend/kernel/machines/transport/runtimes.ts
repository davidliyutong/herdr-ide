// The Bun runtimes the TypeScript machine build runs on
// (docs/features/42-typescript-backend.md, "The machine side"): Bun's
// release archives, pinned by their SHA-256. The core embeds the runtimes
// of linux x64 (baseline), linux arm64, darwin x64 and darwin arm64
// (backend/scripts/runtimes.ts fetches them at build time); a musl
// machine's is fetched by the core when one needs it, checked against the
// same pins, and cached in the core's host's data directory.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import yauzl from 'yauzl';

/** The Bun release of the runtimes. */
export const BUN_VERSION = '1.4.5';

/** A runtime's archive of the release, the SHA-256 of that archive and the
 * SHA-256 of the executable in it (bun: what a payload or the cache
 * carries is checked against it). */
export interface RuntimeArchive {
  name: string;
  sha256: string;
  bun: string;
}

/** The runtimes by platform: "<os>/<arch>" (Go's names), "linux-musl/<arch>"
 * for musl's C library. */
export const RUNTIMES: Readonly<Record<string, RuntimeArchive>> = {
  'linux/amd64': {
    name: 'bun-linux-x64-baseline',
    sha256: 'dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463',
    bun: 'f05d28a3862f4b84395c7fa32480b835dd47482e80b7e7a49a115227f0c06083',
  },
  'linux/arm64': {
    name: 'bun-linux-aarch64',
    sha256: '18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84',
    bun: '04778f1f42399a69d086853e9c7af4acf574b2f21a43d0dc673853d8b84a2923',
  },
  'darwin/amd64': {
    name: 'bun-darwin-x64',
    sha256: 'a4972e778cce4b6a194d7d289f326aa61576d71d80b7a53e9da2f3739566e5fd',
    bun: '88f97645b270aef20f9f9442f1658461cab3e7128e658af4615144e3396f084a',
  },
  'darwin/arm64': {
    name: 'bun-darwin-aarch64',
    sha256: 'b5d6bc2e13caf14e57c89661e89efd073ff16165b41bfe43882616410609cd10',
    bun: 'e2984124f1514e1e6bbda20adedbf07a02c443c6a5828853a15c7c7abf78e19f',
  },
  'linux-musl/amd64': {
    name: 'bun-linux-x64-musl-baseline',
    sha256: '96fb94108eed872ff623ed39007d6b5699a83a5d0086fcfba84921c18145e3e6',
    bun: 'cf5d285ddbe256785a5121a3c113191a6b577504976374c7cfd5aedca609b720',
  },
  'linux-musl/arm64': {
    name: 'bun-linux-aarch64-musl',
    sha256: 'd655765d3a0c0fdf707e27c7aa1a4f2c84f1bbc1f759db7e6e3d3c5be414396c',
    bun: '9c48986093073afec8b76a3e285303598dd2462f52748aecb65e4d94866e1ea3',
  },
};

/** The pinned digests of the executables, by key (what payloads check). */
export const RUNTIME_PINS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(RUNTIMES).map(([k, a]) => [k, a.bun]));

/** The key of a payload's runtime file name (bun-<os>-<arch>.gz), null
 * for another name. */
export function keyOfFile(name: string): string | null {
  const m = /^bun-(linux-musl|linux|darwin)-([a-z0-9]+)\.gz$/.exec(name);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Checks a runtime against the pin of key. */
export function checkPinned(key: string, digest: string, pins: Readonly<Record<string, string>> = RUNTIME_PINS): void {
  const want = pins[key];
  if (!want) throw new Error(`no pinned Bun runtime for ${key}`);
  if (digest !== want) throw new Error(`the Bun runtime for ${key} has sha256 ${digest}, not the pinned ${want}`);
}

/** The platforms whose runtime the core embeds. */
export const EMBEDDED_RUNTIMES = ['linux/amd64', 'linux/arm64', 'darwin/amd64', 'darwin/arm64'] as const;

/** The key of RUNTIMES for a machine. */
export const runtimeKey = (os: string, arch: string, libc?: string): string =>
  os === 'linux' && libc === 'musl' ? `linux-musl/${arch}` : `${os}/${arch}`;

/** The file a payload carries a runtime in: runtime/bun-<os>-<arch>.gz
 * (os linux-musl for musl). */
export const runtimeFile = (key: string): string => `runtime/bun-${key.replace('/', '-')}.gz`;

export const archiveURL = (a: RuntimeArchive): string =>
  `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${a.name}.zip`;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Bounds a runtime's executable (releases are about 100 MB). */
const MAX_RUNTIME = 512 << 20;

/** The executable <name>/bun of a release archive, after checking the
 * archive's digest. */
export async function extractBun(zip: Buffer, a: RuntimeArchive): Promise<Buffer> {
  const got = sha256(zip);
  if (got !== a.sha256) throw new Error(`${a.name}.zip: sha256 ${got} does not match the pinned ${a.sha256}`);
  const z = await new Promise<yauzl.ZipFile>((res, rej) => yauzl.fromBuffer(zip, { lazyEntries: true }, (e, f) => (e ? rej(e) : res(f!))));
  return new Promise((resolve, reject) => {
    z.on('error', reject);
    z.on('end', () => reject(new Error(`${a.name}.zip has no ${a.name}/bun`)));
    z.on('entry', (e: yauzl.Entry) => {
      if (e.fileName !== `${a.name}/bun`) return z.readEntry();
      if (e.uncompressedSize > MAX_RUNTIME) return reject(new Error(`${a.name}/bun: too large`));
      z.openReadStream(e, (err, s) => {
        if (err) return reject(err);
        const parts: Buffer[] = [];
        s!.on('data', (d: Buffer) => parts.push(d)).on('error', reject);
        s!.on('end', () => {
          z.close();
          const bun = Buffer.concat(parts);
          const d = sha256(bun);
          if (d !== a.bun) reject(new Error(`${a.name}/bun: sha256 ${d} does not match the pinned ${a.bun}`));
          else resolve(bun);
        });
      });
    });
    z.readEntry();
  });
}

/** Downloads the archive of key's runtime and returns its executable. */
export async function downloadRuntime(key: string, signal?: AbortSignal): Promise<Buffer> {
  const a = RUNTIMES[key];
  if (!a) throw new Error(`no Bun runtime for ${key}`);
  const res = await fetch(archiveURL(a), { signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`${archiveURL(a)}: ${res.status}`);
  return extractBun(Buffer.from(await res.arrayBuffer()), a);
}

/** A runtime as payloads carry it: gzip-compressed, and the SHA-256 of the
 * executable. */
export interface Runtime {
  gz: Buffer;
  digest: string;
}

export function runtimeOf(gz: Buffer): Runtime {
  return { gz, digest: sha256(gunzipSync(gz)) };
}

/** key's runtime from the cache directory when it is the pinned one, else
 * downloaded, checked and kept there (as <name>-<BUN_VERSION>.gz; the files
 * of other versions, and one that is not the pinned runtime, go). */
export async function cachedRuntime(
  key: string,
  cacheDir: string,
  o: {
    signal?: AbortSignal;
    /** Fetches the executable (tests give their own). */
    download?: (key: string, signal?: AbortSignal) => Promise<Buffer>;
    pins?: Readonly<Record<string, string>>;
  } = {},
): Promise<Runtime> {
  const a = RUNTIMES[key];
  if (!a) throw new Error(`no Bun runtime for ${key}`);
  const pin = (o.pins ?? RUNTIME_PINS)[key];
  const file = join(cacheDir, `${a.name}-${BUN_VERSION}.gz`);
  try {
    const rt = runtimeOf(readFileSync(file));
    if (rt.digest === pin) return rt;
    rmSync(file, { force: true });
  } catch {
    // not cached yet, or not a gzip file
  }
  const bun = await (o.download ?? downloadRuntime)(key, o.signal);
  if (sha256(bun) !== pin) throw new Error(`the downloaded Bun runtime for ${key} is not the pinned one`);
  const gz = gzipSync(bun, { level: 6 });
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(cacheDir))
    if (f.startsWith('bun-') && !f.endsWith(`-${BUN_VERSION}.gz`)) rmSync(join(cacheDir, f), { force: true });
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, gz, { mode: 0o600 });
  renameSync(tmp, file);
  return { gz, digest: pin };
}
