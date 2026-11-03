import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'desktop-tests-'));
try {
  await build({
    entryPoints: ['src/core.test.ts', 'src/policy.test.ts', 'src/preload.test.ts', 'src/shortcuts.test.ts'],
    outdir: dir,
    bundle: true,
    // The preload's test runs it against a stand-in for Electron.
    alias: { electron: './src/fakeElectron.ts' },
    platform: 'node',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
  });
  const result = spawnSync(
    process.execPath,
    ['--test', ...['core', 'policy', 'preload', 'shortcuts'].map((name) => join(dir, `${name}.test.cjs`))],
    { stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
