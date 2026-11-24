// Builds the core's executable: hosts/bun/main.ts compiled by Bun with the
// payloads (kernel/payloads.ts) embedded as one tar archive.
//
//   bun scripts/build.ts --out FILE [--target bun-linux-x64-baseline]
//     [--version V] [--web DIR] [--agents DIR] [--hc DIR] [--ext DIR]
//
// --agents holds machine builds <bin>-<os>-<arch> (gzip-compressed here
// unless they end in .gz), --hc hc-<os>-<arch>.gz, --ext <bridge>.vsix.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const { values: o } = parseArgs({
  options: {
    out: { type: 'string' },
    target: { type: 'string', default: '' },
    version: { type: 'string', default: 'dev' },
    web: { type: 'string', default: '' },
    agents: { type: 'string', default: '' },
    hc: { type: 'string', default: '' },
    ext: { type: 'string', default: '' },
  },
});
if (!o.out) throw new Error('--out is required');

const entries: Record<string, Uint8Array> = {};
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  );
if (o.web) for (const f of walk(o.web)) if (!f.endsWith('.gitkeep')) entries[`web/${relative(o.web, f)}`] = readFileSync(f);
if (o.agents)
  for (const name of readdirSync(o.agents)) {
    const b = readFileSync(join(o.agents, name));
    entries[`agents/${name.endsWith('.gz') ? name : name + '.gz'}`] = name.endsWith('.gz') ? b : gzipSync(b);
  }
if (o.hc) for (const name of readdirSync(o.hc)) if (name.endsWith('.gz')) entries[`hc/${name}`] = readFileSync(join(o.hc, name));
if (o.ext) for (const name of readdirSync(o.ext)) if (name.endsWith('.vsix')) entries[`ext/${name}`] = readFileSync(join(o.ext, name));

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
