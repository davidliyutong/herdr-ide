// Runs the hub-side tests (matching backend/tsconfig.node.json's layout:
// shared/agents, shared/lib, shared/proto, kernel, hosts/common,
// hosts/electron, and all features' non-machine tests). Individual tests
// that require POSIX tools or the machine rig self-skip on Windows via
// `skipIf(process.platform === 'win32')` rather than being filtered here.
//
//   pnpm -C backend test:hub
//   bun scripts/test-hub.ts [bun test args...]
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SKIP_DIRS = new Set(['node_modules', 'testdata', 'machine']);
const SKIP_FILES = new Set(['machine.test.ts', 'integration.test.ts']);

function walkTests(dir: string, skipMachine = false): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'testdata') continue;
    if (skipMachine && SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTests(p, skipMachine));
    else if (e.isFile() && e.name.endsWith('.test.ts') && (!skipMachine || !SKIP_FILES.has(e.name))) out.push(p);
  }
  return out;
}

const files: string[] = [];
for (const sub of ['shared/agents', 'shared/lib', 'shared/proto', 'kernel', 'hosts/common', 'hosts/electron']) {
  for (const f of walkTests(join(ROOT, sub))) files.push(relative(ROOT, f).replaceAll('\\', '/'));
}
for (const f of walkTests(join(ROOT, 'features'), true)) files.push(relative(ROOT, f).replaceAll('\\', '/'));

files.sort();
const proc = Bun.spawnSync([process.execPath, 'test', ...process.argv.slice(2), ...files], {
  cwd: ROOT,
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(proc.exitCode ?? 1);
