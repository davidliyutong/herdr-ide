// Builds the TypeScript machine executables (hosts/machine/compile.ts), one
// per platform with its herdr-core embedded, into DIR as the release names
// them (<bin>-machine-<key>.gz), and DIR/manifest.json with the SHA-256 of
// each executable and of each .gz, which backend/scripts/build.ts
// --machine ts builds into a core.
//
//   bun scripts/machines.ts --out DIR --version V --hc DIR [--raw] [key...]
//
// --hc holds hc-<os>-<arch>.gz (go run ./scripts/fetch-hc); keys default
// to every platform (builds.ts MACHINE_KEYS); --raw also keeps the
// uncompressed executables.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { MACHINE_KEYS, machineAsset, type Manifest } from '../kernel/machines/transport/builds.ts';
import { compileMachine } from '../hosts/machine/compile.ts';

const { values: o, positionals } = parseArgs({
  options: {
    out: { type: 'string' },
    version: { type: 'string', default: 'dev' },
    hc: { type: 'string', default: '' },
    raw: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});
if (!o.out || !o.hc) throw new Error('--out and --hc are required');
const keys = positionals.length ? positionals : MACHINE_KEYS;
mkdirSync(o.out, { recursive: true });
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const manifest: Manifest = { version: o.version, machines: {} };
for (const key of keys) {
  // herdr-core of the platform: the same static executable for glibc and
  // musl.
  const hcGz = readFileSync(join(o.hc, `hc-${key.replace(/-musl$/, '')}.gz`));
  const exe = join(o.out, machineAsset(key));
  await compileMachine({ key, version: o.version, hcGz, outfile: exe });
  const bin = readFileSync(exe);
  const gz = gzipSync(bin, { level: 9 });
  writeFileSync(`${exe}.gz.tmp`, gz);
  renameSync(`${exe}.gz.tmp`, `${exe}.gz`);
  if (!o.raw) rmSync(exe, { force: true });
  manifest.machines[key] = { sha256: sha256(bin), gz: sha256(gz), size: statSync(`${exe}.gz`).size };
  console.log(`${key}: ${(bin.length / 2 ** 20).toFixed(1)} MiB, ${(gz.length / 2 ** 20).toFixed(1)} MiB compressed`);
}
writeFileSync(join(o.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
