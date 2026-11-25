import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'desktop-tests-'));
// The tests, built and run from one list: none is built without running.
const tests = [
  'closeGuard',
  'core',
  'coreBridge',
  'enclave',
  'folders',
  'follow',
  'frames',
  'keychain',
  'menu',
  'notifications',
  'platform',
  'policy',
  'preload',
  'privacy',
  'protocol',
  'relay',
  'titlebar',
  'unlockStore',
  'verify',
  'windowsHello',
];
try {
  await build({
    entryPoints: tests.map((name) => `src/${name}.test.ts`),
    outdir: dir,
    bundle: true,
    // The preload's test runs it against a stand-in for Electron.
    alias: { electron: './src/fakeElectron.ts' },
    platform: 'node',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
  });
  const result = spawnSync(process.execPath, ['--test', ...tests.map((name) => join(dir, `${name}.test.cjs`))], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
