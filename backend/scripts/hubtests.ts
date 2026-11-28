// The hub-side tests: those `pnpm -C backend test:hub` runs, also on
// Windows (backend/tsconfig.node.json's layout: shared/agents, shared/lib,
// shared/proto, kernel, hosts/common, hosts/desktop, and every feature's
// tests but its machine side's). Paths relative to the backend, with `/`.
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'testdata', 'machine']);
const SKIP_FILES = new Set(['machine.test.ts', 'integration.test.ts']);

function walkTests(dir: string, skipMachine: boolean): string[] {
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

/** The hub-side test files below root (the backend), sorted. */
export function hubTestFiles(root: string): string[] {
  const files: string[] = [];
  for (const sub of ['shared/agents', 'shared/lib', 'shared/proto', 'kernel', 'hosts/common', 'hosts/desktop']) {
    for (const f of walkTests(join(root, sub), false)) files.push(relative(root, f).replaceAll('\\', '/'));
  }
  for (const f of walkTests(join(root, 'features'), true)) files.push(relative(root, f).replaceAll('\\', '/'));
  return files.sort();
}
