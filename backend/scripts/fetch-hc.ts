// Fetches the pinned upstream herdr-core (hcdist.ts) of the platforms
// given and writes each executable, gzip-compressed, where the hub's
// build takes it (--out, default dist/payload/hc: hc-<os>-<arch>.gz), and
// the release's license and notices into dist/hc/licenses (which
// scripts/package.sh puts in each archive). Archives are cached in dist/hc
// and checked against their pinned SHA-256 before anything is read from
// them. The downloaded executables are never run.
//
//   bun backend/scripts/fetch-hc.ts [--out DIR] linux/amd64 darwin/arm64 …
//   bun backend/scripts/fetch-hc.ts --exe FILE OS/ARCH
//   bun backend/scripts/fetch-hc.ts --version
//
// --exe writes one platform's verified executable to FILE instead, as is
// (mode 0755; for the integration tests' HC_TEST_BIN), and stages nothing.
// --version prints the pinned version.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Parser, type ReadEntry } from 'tar';
import { EXECUTABLE, LICENSE, MAX_EXECUTABLE, MAX_NOTICE, NOTICES, VERSION, forPlatform, urlOf, type Artifact } from './hcdist.ts';

const REPO = join(import.meta.dir, '..', '..');
const CACHE_DIR = join(REPO, 'dist', 'hc');
const LICENSE_DIR = join(CACHE_DIR, 'licenses');
/** Bounds a download (release archives are about 8 MB). */
const MAX_ARCHIVE = 128 << 20;
/** Bounds what an archive unpacks to. */
const MAX_TARBALL = 512 << 20;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Throws unless b has the archive's pinned digest. */
export function verify(a: Artifact, b: Uint8Array): void {
  const got = sha256(b);
  if (got !== a.sha256) throw new Error(`${a.name}: sha256 ${got} does not match the pinned ${a.sha256}`);
}

/** The member name at the root of the archive gz, which must have the
 * pinned digest: one regular file of at most limit bytes. A link, a
 * directory, a second entry of that name, an empty or a larger file
 * fails, and nothing is written to disk. */
export async function extract(a: Artifact, gz: Uint8Array, name: string, limit: number): Promise<Buffer> {
  verify(a, gz);
  const tarball = gunzipSync(gz, { maxOutputLength: MAX_TARBALL });
  return new Promise((resolve, reject) => {
    let refused: Error | null = null;
    let seen = false;
    let body: Buffer | null = null;
    const refuse = (why: string) => (refused ??= new Error(`${a.name}: ${why}`));
    const p = new Parser({
      strict: true,
      onReadEntry(e: ReadEntry) {
        const path = e.path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
        if (path !== name) return e.resume();
        if (seen) refuse(`more than one ${name}`);
        seen = true;
        if (e.type !== 'File' && e.type !== 'OldFile' && e.type !== 'ContiguousFile') {
          refuse(`${name} is not a regular file`);
          return e.resume();
        }
        if ((e.size ?? 0) > limit) {
          refuse(`${name} is larger than ${limit} bytes`);
          return e.resume();
        }
        const chunks: Buffer[] = [];
        e.on('data', (c: Buffer) => chunks.push(c));
        e.on('end', () => {
          if (!refused) body = Buffer.concat(chunks);
        });
      },
    });
    p.on('error', (e: Error) => refuse(e.message));
    p.on('end', () => {
      if (refused) return reject(refused);
      if (!seen || !body) return reject(new Error(`${a.name}: no ${name} at its root`));
      if (body.length === 0) return reject(new Error(`${a.name}: ${name} is empty`));
      resolve(body);
    });
    p.end(tarball);
  });
}

/** Replaces path with data through a temporary file beside it. */
function writeFile(path: string, data: Uint8Array, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The archive of a, downloaded into the cache unless a verified copy is
 * there. */
async function fetchArchive(a: Artifact): Promise<Buffer> {
  const path = join(CACHE_DIR, a.name);
  if (existsSync(path)) {
    const b = readFileSync(path);
    if (sha256(b) === a.sha256) return b;
  }
  const url = urlOf(a);
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > MAX_ARCHIVE) throw new Error(`GET ${url}: more than ${MAX_ARCHIVE} bytes`);
    chunks.push(c);
  }
  const b = Buffer.concat(chunks);
  verify(a, b);
  writeFile(path, b);
  return b;
}

/** Writes the verified executable of one platform to path (mode 0755). */
async function writeExecutable(path: string, platforms: string[]): Promise<void> {
  if (platforms.length !== 1) throw new Error('usage: bun backend/scripts/fetch-hc.ts --exe FILE OS/ARCH');
  const a = forPlatform(platforms[0]!);
  const bin = await extract(a, await fetchArchive(a), EXECUTABLE, MAX_EXECUTABLE);
  writeFile(path, bin, 0o755);
  console.log(`    herdr-core ${VERSION} ${platforms[0]} (verified) in ${path}`);
}

/** Stages the executables of platforms, gzip-compressed, in dir, and the
 * release's license and notices in dist/hc/licenses. */
async function stage(dir: string, platforms: string[]): Promise<void> {
  if (platforms.length === 0) throw new Error('usage: bun backend/scripts/fetch-hc.ts [--out DIR] OS/ARCH ...');
  for (const p of platforms) forPlatform(p);
  for (const [i, p] of platforms.entries()) {
    const a = forPlatform(p);
    const archive = await fetchArchive(a);
    const bin = await extract(a, archive, EXECUTABLE, MAX_EXECUTABLE);
    // No name or time in the header: the same executable always embeds as
    // the same bytes.
    const gz = gzipSync(bin, { level: 9 });
    writeFile(join(dir, `hc-${p.replace('/', '-')}.gz`), gz);
    // The license and notices are the same in every archive of a release.
    if (i === 0) for (const name of [LICENSE, NOTICES]) writeFile(join(LICENSE_DIR, name), await extract(a, archive, name, MAX_NOTICE));
    console.log(`    herdr-core ${VERSION} ${p} (verified, ${Math.floor(gz.length / 1000)} kB compressed)`);
  }
}

if (import.meta.main) {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'dist/payload/hc' },
      exe: { type: 'string' },
      version: { type: 'boolean' },
    },
  });
  try {
    if (o.version) console.log(VERSION);
    else if (o.exe) await writeExecutable(o.exe, positionals);
    else await stage(o.out!, positionals);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
