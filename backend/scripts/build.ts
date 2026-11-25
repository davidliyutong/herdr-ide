// Builds the core's executable: hosts/bun/main.ts compiled by Bun with the
// payloads (kernel/payloads.ts) embedded as one tar archive.
//
//   bun scripts/build.ts --out FILE [--target bun-linux-x64-baseline]
//     [--version V] [--web DIR] [--machine go|ts] [--agents DIR]
//     [--runtimes DIR] [--hc DIR] [--ext DIR] [--encoder DIR]
//     [--payload-out DIR]
//
// --machine is the machine build the core deploys: go (the default) embeds
// the Go machine builds of --agents, <bin>-<os>-<arch> (gzip-compressed
// here unless they end in .gz); ts embeds the TypeScript machine side, its
// bundle built here (hosts/machine/bundle.ts) with the Bun runtimes of
// --runtimes, bun-<os>-<arch>.gz (scripts/runtimes.ts). --hc holds
// hc-<os>-<arch>.gz, --ext <bridge>.vsix, --encoder encoder-<os>-<arch>.gz
// (scripts/build-ffmpeg.sh). --payload-out also writes the payloads as
// files, laid out as the desktop app carries them.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { checkPinned, keyOfFile } from '../kernel/machines/transport/runtimes.ts';
import { buildBundle } from '../hosts/machine/bundle.ts';

const { values: o } = parseArgs({
  options: {
    out: { type: 'string' },
    target: { type: 'string', default: '' },
    version: { type: 'string', default: 'dev' },
    web: { type: 'string', default: '' },
    machine: { type: 'string', default: 'go' },
    agents: { type: 'string', default: '' },
    runtimes: { type: 'string', default: '' },
    'payload-out': { type: 'string', default: '' },
    hc: { type: 'string', default: '' },
    ext: { type: 'string', default: '' },
    encoder: { type: 'string', default: '' },
  },
});
if (!o.out) throw new Error('--out is required');
if (o.machine !== 'go' && o.machine !== 'ts') throw new Error('--machine is go or ts');
if (o.machine === 'ts' && !o.runtimes) throw new Error('--machine ts needs --runtimes');

const entries: Record<string, Uint8Array> = {};
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  );
if (o.web) for (const f of walk(o.web)) entries[`web/${relative(o.web, f)}`] = readFileSync(f);
if (o.machine === 'ts') {
  // The machine side: its bundle, built for this version, and the runtimes.
  const { js } = await buildBundle(o.version);
  entries['machine/machine.js'] = Buffer.from(js);
  for (const name of readdirSync(o.runtimes)) {
    const key = keyOfFile(name);
    if (!key) continue;
    // Only the pinned executables (kernel/machines/transport/runtimes.ts).
    const gz = readFileSync(join(o.runtimes, name));
    checkPinned(key, createHash('sha256').update(gunzipSync(gz)).digest('hex'));
    entries[`runtime/${name}`] = gz;
  }
} else if (o.agents)
  for (const name of readdirSync(o.agents)) {
    const b = readFileSync(join(o.agents, name));
    entries[`agents/${name.endsWith('.gz') ? name : name + '.gz'}`] = name.endsWith('.gz') ? b : gzipSync(b);
  }
if (o.hc) for (const name of readdirSync(o.hc)) if (name.endsWith('.gz')) entries[`hc/${name}`] = readFileSync(join(o.hc, name));
if (o.ext) for (const name of readdirSync(o.ext)) if (name.endsWith('.vsix')) entries[`ext/${name}`] = readFileSync(join(o.ext, name));
if (o.encoder)
  for (const name of readdirSync(o.encoder))
    if (/^encoder-[a-z0-9]+-[a-z0-9]+\.gz$/.test(name)) entries[`encoder/${name}`] = readFileSync(join(o.encoder, name));

if (o['payload-out'])
  for (const [path, b] of Object.entries(entries)) {
    if (path.startsWith('web/')) continue;
    const f = join(o['payload-out'], path);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, b);
  }

const tmp = mkdtempSync(join(tmpdir(), 'core-build-'));
try {
  const payload = join(tmp, 'payload.tar');
  await Bun.Archive.write(payload, entries);
  const args = [
    'build',
    '--compile',
    '--minify-syntax',
    '--asset-naming=[name].[ext]',
    `--define=BUILD_VERSION=${JSON.stringify(o.version)}`,
  ];
  if (o.target) args.push(`--target=${o.target}`);
  args.push(join(import.meta.dir, '..', 'hosts', 'bun', 'main.ts'), payload, '--outfile', o.out);
  const p = Bun.spawnSync(['bun', ...args], { stdout: 'inherit', stderr: 'inherit' });
  if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
  console.log(`${o.out}: ${Object.keys(entries).length} payload files`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
