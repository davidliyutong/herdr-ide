import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'desktop-tests-'));
try {
  await build({
    entryPoints: ['src/core.test.ts', 'src/policy.test.ts'],
    outdir: dir,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
  });
  const result = spawnSync(process.execPath, ['--test', join(dir, 'core.test.cjs'), join(dir, 'policy.test.cjs')], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
