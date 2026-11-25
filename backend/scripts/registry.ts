// Writes spec/generated/registry.json and the settings and commands tables
// of docs/reference.md from the features serve composes
// (kernel/config/registry.ts says what they hold); run by `make tokens`,
// and with --check by scripts/check.sh.
//
//   bun scripts/registry.ts            writes the files (pnpm registry)
//   bun scripts/registry.ts --check    writes nothing; fails if one is stale
import { parseArgs } from 'node:util';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { registryInput, updateRegistry } from '#kernel/config/registry.ts';
import { describedFeatures } from '#hosts/bun/serve.ts';

const { values: f } = parseArgs({
  options: { check: { type: 'boolean', default: false }, root: { type: 'string', default: REPO_ROOT } },
});
const stale = updateRegistry(f.root, registryInput(describedFeatures()), f.check);
if (f.check && stale.length > 0) {
  for (const s of stale) console.error(`registry: stale: ${s} (run \`make tokens\`)`);
  process.exit(1);
}
