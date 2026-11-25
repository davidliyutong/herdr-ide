// Builds the core's executable: hosts/bun/main.ts compiled by Bun with the
// payloads (kernel/payloads.ts) embedded as one tar archive.
//
//   bun scripts/build.ts --out FILE [--target bun-linux-x64-baseline]
//     [--version V] [--web DIR] [--machine go|ts] [--agents DIR]
//     [--machines DIR] [--release-url URL] [--hc DIR] [--ext DIR]
//     [--encoder DIR] [--payload-out DIR]
//
// --machine is the machine build the core deploys: go (the default) embeds
// the Go machine builds of --agents, <bin>-<os>-<arch> (gzip-compressed
// here unless they end in .gz), and herdr-core of --hc for every platform;
// ts embeds the manifest of --machines (scripts/machines.ts: the digests of
// every platform's TypeScript machine executable) with the release's
// download URL (--release-url; none for a build of no release) and the
// core's own platform's executable only, no herdr-core (each executable
// carries its platform's), none for a Windows core. --hc holds
// hc-<os>-<arch>.gz, --ext <bridge>.vsix, --encoder
// encoder-<os>-<arch>.gz (scripts/build-ffmpeg.sh). --payload-out also
// writes the payloads as files, laid out as the desktop app carries them.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { machineAsset, type Manifest } from '../kernel/machines/transport/builds.ts';

const { values: o } = parseArgs({
  options: {
    out: { type: 'string' },
    target: { type: 'string', default: '' },
    version: { type: 'string', default: 'dev' },
    web: { type: 'string', default: '' },
    machine: { type: 'string', default: 'go' },
    agents: { type: 'string', default: '' },
    machines: { type: 'string', default: '' },
    'release-url': { type: 'string', default: '' },
    'payload-out': { type: 'string', default: '' },
    hc: { type: 'string', default: '' },
    ext: { type: 'string', default: '' },
    encoder: { type: 'string', default: '' },
  },
});
if (!o.out) throw new Error('--out is required');
if (o.machine !== 'go' && o.machine !== 'ts') throw new Error('--machine is go or ts');
if (o.machine === 'ts' && !o.machines) throw new Error('--machine ts needs --machines');

const entries: Record<string, Uint8Array> = {};
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  );
if (o.web) for (const f of walk(o.web)) entries[`web/${relative(o.web, f)}`] = readFileSync(f);
if (o.machine === 'ts') {
  // The digests of every platform's machine executable, with where the
  // release serves them, and this core's own platform's executable.
  const manifest = JSON.parse(readFileSync(join(o.machines, 'manifest.json'), 'utf8')) as Manifest;
  if (o['release-url']) manifest.release = o['release-url'];
  if (manifest.version !== o.version) throw new Error(`--machines are of version ${manifest.version}, not ${o.version}`);
  entries['machine/manifest.json'] = Buffer.from(JSON.stringify(manifest));
  const own = ownKey(o.target);
  if (own) {
    if (!manifest.machines[own]) throw new Error(`--machines has no executable for ${own}`);
    entries[`machine/${machineAsset(own)}.gz`] = readFileSync(join(o.machines, `${machineAsset(own)}.gz`));
  }
} else if (o.agents)
  for (const name of readdirSync(o.agents)) {
    const b = readFileSync(join(o.agents, name));
    entries[`agents/${name.endsWith('.gz') ? name : name + '.gz'}`] = name.endsWith('.gz') ? b : gzipSync(b);
  }
// A TypeScript machine executable carries its platform's herdr-core.
if (o.hc && o.machine === 'go')
  for (const name of readdirSync(o.hc)) if (name.endsWith('.gz')) entries[`hc/${name}`] = readFileSync(join(o.hc, name));
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

/** The machine platform of a core's Bun target (this host's without one);
 * "" for Windows, where no machine side runs. */
function ownKey(target: string): string {
  if (!target) {
    if (process.platform === 'win32') return '';
    return `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
  }
  const m = /^bun-(linux|darwin|windows)-(x64|arm64)/.exec(target);
  if (!m || m[1] === 'windows') return '';
  return `${m[1]}-${m[2] === 'x64' ? 'amd64' : 'arm64'}`;
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
