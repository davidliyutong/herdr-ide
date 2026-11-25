// Builds the core's executable: hosts/bun/main.ts compiled by Bun with the
// payloads (kernel/payloads.ts) embedded as one tar archive.
//
//   bun scripts/build.ts --out FILE [--target bun-linux-x64-baseline]
//     [--version V] [--web DIR] [--machine go|ts] [--agents DIR]
//     [--release-url URL] [--hc DIR] [--ext DIR] [--encoder DIR]
//     [--payload-out DIR]
//
// --machine is the machine build the core deploys: go embeds
// the Go machine builds of --agents, <bin>-<os>-<arch> (gzip-compressed
// here unless they end in .gz), and herdr-core of --hc for every platform.
// ts (the default) makes the executable the machine build of its own platform too (its
// `node` commands): it carries its platform's herdr-core (embedded as
// herdr-core.gz, which its node installs), the SHA-256 of every
// herdr-core of --hc (machine/hc.json, which the core holds the machines'
// builds to), and machine/release.json: its version, its platform and the
// release's download URL (--release-url; none for a build of no release),
// where machines get their platform's build (kernel/machines/transport/
// release.ts). --hc holds hc-<os>-<arch>.gz, --ext <bridge>.vsix,
// --encoder encoder-<os>-<arch>.gz (scripts/build-ffmpeg.sh; a ts build
// carries its own platform's). A ts build for Linux also carries the GUI
// helper of its architecture (gui-helper.gz, from --gui: the committed
// scripts/gui-helper/bin, checked against its gui-helper.sha256) and the
// GPU selection library (gpupick.so, from --gpupick:
// scripts/gpupick/bin). --payload-out also writes the payloads as
// files, laid out as the desktop app carries them.
//
// Every executable is compiled without autoloading a .env or bunfig.toml
// of the directory it runs in, and reproducibly for one output path (what
// it embeds is staged beside it).
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { keyOfTarget } from '../kernel/machines/transport/builds.ts';

const { values: o } = parseArgs({
  options: {
    out: { type: 'string' },
    target: { type: 'string', default: '' },
    version: { type: 'string', default: 'dev' },
    web: { type: 'string', default: '' },
    machine: { type: 'string', default: 'ts' },
    agents: { type: 'string', default: '' },
    'release-url': { type: 'string', default: '' },
    'payload-out': { type: 'string', default: '' },
    hc: { type: 'string', default: '' },
    ext: { type: 'string', default: '' },
    encoder: { type: 'string', default: '' },
    gui: { type: 'string', default: join(import.meta.dir, '..', '..', 'scripts', 'gui-helper', 'bin') },
    gpupick: { type: 'string', default: join(import.meta.dir, '..', '..', 'scripts', 'gpupick', 'bin') },
  },
});
if (!o.out) throw new Error('--out is required');
if (o.machine !== 'go' && o.machine !== 'ts') throw new Error('--machine is go or ts');
if (o['release-url'] && !/^https:\/\/[^\s"'\\]+$/.test(o['release-url'])) throw new Error('--release-url is an https URL');

/** The platform of the executable: of --target, else this host's. */
function ownKey(target: string): string {
  if (target) return keyOfTarget(target);
  if (process.platform === 'win32') return '';
  return `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** A string of the Agent SDK's code (sdk.mjs), in no source of ours. */
const SDK_MARKER = 'CLAUDE_SDK_CAN_USE_TOOL' + '_SHADOWED';
const entries: Record<string, Uint8Array> = {};
/** Files embedded beside the payload archive (Bun.embeddedFiles). */
const extra: Record<string, Uint8Array> = {};
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  );
if (o.web) for (const f of walk(o.web)) entries[`web/${relative(o.web, f)}`] = readFileSync(f);
const key = ownKey(o.target);
// The encoder's platform, os-arch, that this build carries (all for go).
const ownPlatform = key.replace(/-musl$/, '');
if (o.machine === 'ts') {
  entries['machine/release.json'] = Buffer.from(
    JSON.stringify({ version: o.version, key, ...(o['release-url'] ? { release: o['release-url'].replace(/\/$/, '') } : {}) }),
  );
  const hcs: Record<string, string> = {};
  if (o.hc)
    for (const name of readdirSync(o.hc)) {
      const m = /^hc-([a-z0-9]+-[a-z0-9]+)\.gz$/.exec(name);
      if (m) hcs[m[1]] = sha256(gunzipSync(readFileSync(join(o.hc, name))));
    }
  entries['machine/hc.json'] = Buffer.from(JSON.stringify(hcs));
  // Without one (tests), its node installs none and runs the machine's.
  if (key && hcs[ownPlatform]) extra['herdr-core.gz'] = readFileSync(join(o.hc, `hc-${ownPlatform}.gz`));
  else if (key) console.warn(`${o.out}: no herdr-core for ${ownPlatform} (--hc)`);
  if (ownPlatform.startsWith('linux-')) {
    const arch = ownPlatform.slice('linux-'.length);
    // The digests recorded beside each, which make check verifies.
    const recorded = (dir: string, list: string, name: string) => {
      const line = readFileSync(join(dir, list), 'utf8')
        .split('\n')
        .find((l) => l.endsWith(`  ${name}`));
      const b = readFileSync(join(dir, name));
      if (!line || line.split(' ')[0] !== sha256(b)) throw new Error(`${join(dir, name)} is not the one ${list} records`);
      return b;
    };
    extra['gui-helper.gz'] = gzipSync(recorded(o.gui, 'gui-helper.sha256', `gui-helper-linux-${arch}`), { level: 9 });
    extra['gpupick.so'] = recorded(o.gpupick, 'gpupick.sha256', `gpupick-linux-${arch}.so`);
  }
} else {
  if (o.agents)
    for (const name of readdirSync(o.agents)) {
      const b = readFileSync(join(o.agents, name));
      entries[`agents/${name.endsWith('.gz') ? name : name + '.gz'}`] = name.endsWith('.gz') ? b : gzipSync(b);
    }
  if (o.hc) for (const name of readdirSync(o.hc)) if (name.endsWith('.gz')) entries[`hc/${name}`] = readFileSync(join(o.hc, name));
}
if (o.ext) for (const name of readdirSync(o.ext)) if (name.endsWith('.vsix')) entries[`ext/${name}`] = readFileSync(join(o.ext, name));
if (o.encoder)
  for (const name of readdirSync(o.encoder)) {
    const m = /^encoder-([a-z0-9]+-[a-z0-9]+)\.gz$/.exec(name);
    if (m && (o.machine === 'go' || m[1] === ownPlatform)) entries[`encoder/${name}`] = readFileSync(join(o.encoder, name));
  }

if (o['payload-out'])
  for (const [path, b] of Object.entries(entries)) {
    if (path.startsWith('web/')) continue;
    const f = join(o['payload-out'], path);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, b);
  }

// Beside the output, at a path of its own: Bun names the files in the
// executable, which then depends on nothing but the output's path. The
// compile runs in it: Bun leaves a .<hash>.bun-build copy of the
// executable in its working directory, which goes with the stage.
const stage = resolve(`${o.out}.files`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
try {
  const payload = join(stage, 'payload.tar');
  await Bun.Archive.write(payload, entries);
  const files = [payload];
  for (const [name, b] of Object.entries(extra)) {
    writeFileSync(join(stage, name), b);
    files.push(join(stage, name));
  }
  const args = [
    'build',
    '--compile',
    '--minify-syntax',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    '--asset-naming=[name].[ext]',
    `--define=BUILD_VERSION=${JSON.stringify(o.version)}`,
  ];
  if (o.target) args.push(`--target=${o.target}`);
  args.push(join(import.meta.dir, '..', 'hosts', 'bun', 'main.ts'), ...files, '--outfile', resolve(o.out));
  const p = Bun.spawnSync([process.execPath, ...args], { cwd: stage, stdout: 'inherit', stderr: 'inherit' });
  if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
  // Anthropic's Agent SDK is fetched by the machines that use it, never
  // shipped (features/chat/claudesdk.ts): an executable with its code in it
  // is not one to release.
  if (readFileSync(o.out).includes(SDK_MARKER)) {
    rmSync(o.out, { force: true });
    console.error(`${o.out}: it holds @anthropic-ai/claude-agent-sdk's code (a value import of it outside the tests?); removed`);
    process.exit(1);
  }
  console.log(`${o.out}: ${Object.keys(entries).length} payload files`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
