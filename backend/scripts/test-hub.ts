// Runs the hub-side tests (matching backend/tsconfig.node.json's layout:
// shared/agents, shared/lib, shared/proto, kernel, hosts/common,
// hosts/electron, and all features' non-machine tests). Individual tests
// that require POSIX tools or the machine rig self-skip on Windows via
// `skipIf(process.platform === 'win32')` rather than being filtered here.
//
//   pnpm -C backend test:hub
//   bun scripts/test-hub.ts [bun test args...]
import { join } from 'node:path';
import { hubTestFiles } from './hubtests.ts';

const ROOT = join(import.meta.dir, '..');
const files = hubTestFiles(ROOT);
const proc = Bun.spawnSync([process.execPath, 'test', ...process.argv.slice(2), ...files], {
  cwd: ROOT,
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(proc.exitCode ?? 1);
