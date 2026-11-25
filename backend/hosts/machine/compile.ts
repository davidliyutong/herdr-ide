// The machine executable of a platform: hosts/machine/main.ts compiled by
// Bun with that platform's runtime (`bun build --compile`) and its
// herdr-core embedded (herdr-core.gz, which the node installs from its own
// copy). Compiled without autoloading .env and bunfig.toml: nothing in the
// directory a node starts in changes what it runs. Before it is compiled,
// the bundle is checked to carry the machine side only (bundle.ts).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MACHINE_TARGETS } from '#kernel/machines/transport/builds.ts';
import { buildBundle } from './bundle.ts';

/** The flags every machine executable is compiled with. */
export const COMPILE_FLAGS = [
  '--compile',
  '--minify-syntax',
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig',
  '--asset-naming=[name].[ext]',
];

/** Compiles the machine executable of key (MACHINE_TARGETS; omitted: this
 * host's, with the bun running this) into outfile, with hcGz (that
 * platform's herdr-core, gzip-compressed) embedded when given. */
export async function compileMachine(o: { key?: string; version: string; hcGz?: Uint8Array; outfile: string }): Promise<void> {
  await buildBundle(o.version);
  const target = o.key ? MACHINE_TARGETS[o.key] : undefined;
  if (o.key && !target) throw new Error(`no machine platform ${o.key}`);
  // Beside the output, at a path of its own: Bun names the file in the
  // executable, which then depends on nothing but the output's path
  // (reproducible builds).
  const tmp = `${o.outfile}.files`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const files = [join(import.meta.dir, 'main.ts')];
    if (o.hcGz) {
      const hc = join(tmp, 'herdr-core.gz');
      writeFileSync(hc, o.hcGz);
      files.push(hc);
    }
    const args = [
      'build',
      ...COMPILE_FLAGS,
      `--define=BUILD_VERSION=${JSON.stringify(o.version)}`,
      ...(target ? [`--target=${target}`] : []),
      ...files,
      '--outfile',
      o.outfile,
    ];
    const p = Bun.spawnSync([process.execPath, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0) throw new Error(`bun build --compile ${o.key ?? ''}: ${p.stderr.toString()}${p.stdout.toString()}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
