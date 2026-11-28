import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'desktop-tests-'));
// The tests, built and run from one list: none is built without running.
const tests = [
  'closeGuard',
  'detached',
  'hub',
  'hubBridge',
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
  'startup',
  'titlebar',
  'unlockStore',
  'verify',
  'windowsHello',
];
// One group at a time: pnpm test -- hub runs the files whose name holds hub.
const filter = process.argv.slice(2);
const selected = filter.length ? tests.filter((name) => filter.some((f) => name.includes(f))) : tests;
try {
  await build({
    entryPoints: selected.map((name) => `src/${name}.test.ts`),
    outdir: dir,
    bundle: true,
    // The preload's test runs it against a stand-in for Electron.
    alias: { electron: './src/fakeElectron.ts' },
    platform: 'node',
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
  });
  const result = spawnSync(process.execPath, ['--test', ...selected.map((name) => join(dir, `${name}.test.cjs`))], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
