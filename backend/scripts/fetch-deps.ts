// Fetches and verifies the pinned native submodule releases (deps.ts) into
// dist/deps/ and web/src/vt/:
//   - vt:         web/src/vt/{ghostty-vt.wasm,LICENSE}
//   - encoder:    dist/deps/encoder/encoder-linux-{amd64,arm64}.gz
//                 dist/deps/licenses/encoder/*
//   - gpupick:    dist/deps/gpupick/gpupick-linux-{amd64,arm64}.so + gpupick.sha256
//   - gui-helper: dist/deps/gui-helper/gui-helper-linux-{amd64,arm64} + gui-helper.sha256
//                 dist/deps/licenses/gui-helper/THIRD-PARTY-NOTICES
//
//   bun backend/scripts/fetch-deps.ts [--only vt,encoder,gpupick,gui-helper]
//   bun backend/scripts/fetch-deps.ts --check
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
  ALL_SUBMODULES,
  ENCODER_LICENSES,
  MAX_DEP_ARCHIVE,
  MAX_DEP_BINARY,
  MAX_DEP_LICENSE,
  depUrlOf,
  type SubmoduleKind,
  type SubmoduleRelease,
} from './deps.ts';
import { extract, verify } from './fetch-hc.ts';
import type { Artifact } from './hcdist.ts';

const REPO = join(import.meta.dir, '..', '..');
export const DEPS_DIR = join(REPO, 'dist', 'deps');
const CACHE_DIR = join(DEPS_DIR, 'cache');

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function writeAtomic(path: string, data: Uint8Array, mode = 0o644): void {
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

async function fetchDepArchive(rel: SubmoduleRelease, a: Artifact, cacheDir = CACHE_DIR): Promise<Buffer> {
  const path = join(cacheDir, `${rel.repo}-v${rel.version}-${a.name}`);
  if (existsSync(path)) {
    const b = readFileSync(path);
    if (sha256(b) === a.sha256) return b;
  }
  const url = depUrlOf(rel, a);
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000), redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > MAX_DEP_ARCHIVE) throw new Error(`GET ${url}: more than ${MAX_DEP_ARCHIVE} bytes`);
    chunks.push(c);
  }
  const b = Buffer.concat(chunks);
  verify(a, b);
  writeAtomic(path, b);
  return b;
}

interface Stamp {
  pins: Record<string, string>;
  files: Record<string, string>;
}

function pinMap(
  kinds: readonly SubmoduleKind[],
  submodules: Record<SubmoduleKind, SubmoduleRelease> = ALL_SUBMODULES,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of kinds) {
    const rel = submodules[k];
    for (const [plat, a] of Object.entries(rel.artifacts)) out[`${k}:${plat}`] = `${rel.version}:${a.sha256}`;
  }
  return out;
}

function stampValid(
  stampPath: string,
  kinds: readonly SubmoduleKind[],
  repoRoot: string,
  submodules: Record<SubmoduleKind, SubmoduleRelease> = ALL_SUBMODULES,
): boolean {
  if (!existsSync(stampPath)) return false;
  try {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as Stamp;
    const wantPins = pinMap(kinds, submodules);
    for (const [k, v] of Object.entries(wantPins)) if (stamp.pins?.[k] !== v) return false;
    for (const [relPath, wantHash] of Object.entries(stamp.files ?? {})) {
      const full = join(repoRoot, relPath);
      if (!existsSync(full) || sha256(readFileSync(full)) !== wantHash) return false;
    }
    return Object.keys(stamp.files ?? {}).length > 0;
  } catch {
    return false;
  }
}

export async function stageDeps(
  kinds: readonly SubmoduleKind[] = ['vt', 'encoder', 'gpupick', 'gui-helper'],
  opts: { repoRoot?: string; quiet?: boolean; submodules?: Record<SubmoduleKind, SubmoduleRelease> } = {},
): Promise<void> {
  const root = opts.repoRoot ?? REPO;
  const submodules = opts.submodules ?? ALL_SUBMODULES;
  const vt = submodules.vt;
  const encoder = submodules.encoder;
  const gpupick = submodules.gpupick;
  const guiHelper = submodules['gui-helper'];
  const depsDir = join(root, 'dist', 'deps');
  const cacheDir = join(depsDir, 'cache');
  const vtDir = join(root, 'web', 'src', 'vt');
  const stampPath = join(depsDir, `.staged-${kinds.slice().sort().join('_')}.json`);

  if (stampValid(stampPath, kinds, root, submodules)) return;

  const recordedFiles: Record<string, string> = {};
  const record = (absPath: string, data: Uint8Array, mode = 0o644) => {
    writeAtomic(absPath, data, mode);
    const rel = absPath.slice(root.length + 1).replaceAll('\\', '/');
    recordedFiles[rel] = sha256(data);
  };

  for (const kind of kinds) {
    if (kind === 'vt') {
      const a = vt.artifacts.wasm!;
      const archive = await fetchDepArchive(vt, a, cacheDir);
      const wasm = await extract(a, archive, 'ghostty-vt.wasm', MAX_DEP_BINARY);
      const lic = await extract(a, archive, 'LICENSE', MAX_DEP_LICENSE);
      record(join(vtDir, 'ghostty-vt.wasm'), wasm);
      record(join(vtDir, 'LICENSE'), lic);
      if (!opts.quiet) console.log(`    ${vt.repo} ${vt.version} (verified, ${Math.floor(wasm.length / 1000)} kB wasm)`);
    } else if (kind === 'encoder') {
      for (const [i, arch] of (['amd64', 'arm64'] as const).entries()) {
        const key = `linux-${arch}`;
        const a = encoder.artifacts[key]!;
        const archive = await fetchDepArchive(encoder, a, cacheDir);
        const bin = await extract(a, archive, 'encoder', MAX_DEP_BINARY);
        const gz = gzipSync(bin, { level: 9 });
        record(join(depsDir, 'encoder', `encoder-${key}.gz`), gz);
        if (i === 0) {
          for (const name of ENCODER_LICENSES) {
            const text = await extract(a, archive, name, MAX_DEP_LICENSE);
            record(join(depsDir, 'licenses', 'encoder', name), text);
          }
        }
        if (!opts.quiet) console.log(`    ${encoder.repo} ${encoder.version} ${key} (verified, ${Math.floor(gz.length / 1000)} kB gz)`);
      }
    } else if (kind === 'gpupick') {
      const lines: string[] = [];
      for (const arch of ['amd64', 'arm64'] as const) {
        const key = `linux-${arch}`;
        const a = gpupick.artifacts[key]!;
        const archive = await fetchDepArchive(gpupick, a, cacheDir);
        const so = await extract(a, archive, 'gpupick.so', MAX_DEP_BINARY);
        const fileName = `gpupick-linux-${arch}.so`;
        record(join(depsDir, 'gpupick', fileName), so);
        lines.push(`${sha256(so)}  ${fileName}`);
      }
      record(join(depsDir, 'gpupick', 'gpupick.sha256'), Buffer.from(lines.join('\n') + '\n', 'utf8'));
      if (!opts.quiet) console.log(`    ${gpupick.repo} ${gpupick.version} linux-{amd64,arm64} (verified)`);
    } else if (kind === 'gui-helper') {
      const lines: string[] = [];
      for (const [i, arch] of (['amd64', 'arm64'] as const).entries()) {
        const key = `linux-${arch}`;
        const a = guiHelper.artifacts[key]!;
        const archive = await fetchDepArchive(guiHelper, a, cacheDir);
        const bin = await extract(a, archive, 'gui-helper', MAX_DEP_BINARY);
        const fileName = `gui-helper-linux-${arch}`;
        record(join(depsDir, 'gui-helper', fileName), bin, 0o755);
        lines.push(`${sha256(bin)}  ${fileName}`);
        if (i === 0) {
          const notices = await extract(a, archive, 'THIRD-PARTY-NOTICES', MAX_DEP_LICENSE);
          record(join(depsDir, 'licenses', 'gui-helper', 'THIRD-PARTY-NOTICES'), notices);
        }
      }
      record(join(depsDir, 'gui-helper', 'gui-helper.sha256'), Buffer.from(lines.join('\n') + '\n', 'utf8'));
      if (!opts.quiet) console.log(`    ${guiHelper.repo} ${guiHelper.version} linux-{amd64,arm64} (verified)`);
    }
  }

  writeAtomic(
    stampPath,
    Buffer.from(JSON.stringify({ pins: pinMap(kinds, submodules), files: recordedFiles } satisfies Stamp, null, 2) + '\n'),
  );
}

/** Verifies pinned manifest definitions and ensures the staged vt Wasm,
 * gpupick libraries and GUI helpers (fetched by `make deps`) match their
 * pinned submodule archives. */
export async function checkDeps(opts: { repoRoot?: string; submodules?: Record<SubmoduleKind, SubmoduleRelease> } = {}): Promise<void> {
  const root = opts.repoRoot ?? REPO;
  const submodules = opts.submodules ?? ALL_SUBMODULES;
  const vt = submodules.vt;
  const gpupick = submodules.gpupick;
  const guiHelper = submodules['gui-helper'];
  const depsDir = join(root, 'dist', 'deps');
  const cacheDir = join(depsDir, 'cache');
  const vtDir = join(root, 'web', 'src', 'vt');

  const hex64 = /^[0-9a-f]{64}$/;
  for (const [kind, rel] of Object.entries(submodules)) {
    if (!rel.version) throw new Error(`deps.ts: ${kind} has no version`);
    for (const [plat, a] of Object.entries(rel.artifacts)) {
      if (!hex64.test(a.sha256)) throw new Error(`deps.ts: ${kind} ${plat} has invalid sha256 "${a.sha256}"`);
    }
  }

  const requireFile = (fullPath: string, label: string): Buffer => {
    if (!existsSync(fullPath)) {
      throw new Error(`${label} is missing; run 'make deps' or 'bun backend/scripts/fetch-deps.ts'`);
    }
    return readFileSync(fullPath);
  };

  const wasmBuf = requireFile(join(vtDir, 'ghostty-vt.wasm'), 'web/src/vt/ghostty-vt.wasm');
  const licBuf = requireFile(join(vtDir, 'LICENSE'), 'web/src/vt/LICENSE');
  const vtArt = vt.artifacts.wasm!;
  const vtArchive = await fetchDepArchive(vt, vtArt, cacheDir);
  const wantWasm = await extract(vtArt, vtArchive, 'ghostty-vt.wasm', MAX_DEP_BINARY);
  const wantLic = await extract(vtArt, vtArchive, 'LICENSE', MAX_DEP_LICENSE);
  if (sha256(wasmBuf) !== sha256(wantWasm) || sha256(licBuf) !== sha256(wantLic)) {
    throw new Error(`web/src/vt/ghostty-vt.wasm does not match pinned ${vt.repo} v${vt.version}; run 'make deps'`);
  }

  const gpuLines: string[] = [];
  for (const arch of ['amd64', 'arm64'] as const) {
    const key = `linux-${arch}`;
    const fileName = `gpupick-linux-${arch}.so`;
    const actual = requireFile(join(depsDir, 'gpupick', fileName), `dist/deps/gpupick/${fileName}`);
    const a = gpupick.artifacts[key]!;
    const archive = await fetchDepArchive(gpupick, a, cacheDir);
    const want = await extract(a, archive, 'gpupick.so', MAX_DEP_BINARY);
    const wantDigest = sha256(want);
    if (sha256(actual) !== wantDigest) {
      throw new Error(`dist/deps/gpupick/${fileName} does not match pinned ${gpupick.repo} v${gpupick.version}; run 'make deps'`);
    }
    gpuLines.push(`${wantDigest}  ${fileName}`);
  }
  const gpuList = requireFile(join(depsDir, 'gpupick', 'gpupick.sha256'), 'dist/deps/gpupick/gpupick.sha256').toString('utf8');
  if (gpuList !== gpuLines.join('\n') + '\n') {
    throw new Error(`dist/deps/gpupick/gpupick.sha256 does not match pinned ${gpupick.repo} v${gpupick.version}; run 'make deps'`);
  }

  const guiLines: string[] = [];
  for (const [i, arch] of (['amd64', 'arm64'] as const).entries()) {
    const key = `linux-${arch}`;
    const fileName = `gui-helper-linux-${arch}`;
    const actual = requireFile(join(depsDir, 'gui-helper', fileName), `dist/deps/gui-helper/${fileName}`);
    const a = guiHelper.artifacts[key]!;
    const archive = await fetchDepArchive(guiHelper, a, cacheDir);
    const want = await extract(a, archive, 'gui-helper', MAX_DEP_BINARY);
    const wantDigest = sha256(want);
    if (sha256(actual) !== wantDigest) {
      throw new Error(`dist/deps/gui-helper/${fileName} does not match pinned ${guiHelper.repo} v${guiHelper.version}; run 'make deps'`);
    }
    guiLines.push(`${wantDigest}  ${fileName}`);
    if (i === 0) {
      const actualNotices = requireFile(
        join(depsDir, 'licenses', 'gui-helper', 'THIRD-PARTY-NOTICES'),
        'dist/deps/licenses/gui-helper/THIRD-PARTY-NOTICES',
      );
      const wantNotices = await extract(a, archive, 'THIRD-PARTY-NOTICES', MAX_DEP_LICENSE);
      if (sha256(actualNotices) !== sha256(wantNotices)) {
        throw new Error(
          `dist/deps/licenses/gui-helper/THIRD-PARTY-NOTICES does not match pinned ${guiHelper.repo} v${guiHelper.version}; run 'make deps'`,
        );
      }
    }
  }
  const guiList = requireFile(join(depsDir, 'gui-helper', 'gui-helper.sha256'), 'dist/deps/gui-helper/gui-helper.sha256').toString('utf8');
  if (guiList !== guiLines.join('\n') + '\n') {
    throw new Error(
      `dist/deps/gui-helper/gui-helper.sha256 does not match pinned ${guiHelper.repo} v${guiHelper.version}; run 'make deps'`,
    );
  }
}

if (import.meta.main) {
  const { values: o } = parseArgs({
    options: {
      only: { type: 'string', default: '' },
      check: { type: 'boolean', default: false },
    },
  });
  try {
    if (o.check) {
      await checkDeps();
    } else {
      const kinds = o.only
        ? (o.only
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean) as SubmoduleKind[])
        : (['vt', 'encoder', 'gpupick', 'gui-helper'] as const);
      for (const k of kinds) {
        if (!(k in ALL_SUBMODULES)) throw new Error(`unknown submodule "${k}" (expected vt, encoder, gpupick, gui-helper)`);
      }
      await stageDeps(kinds);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
