// Where the binaries under test are: scripts/e2e.sh builds them into
// dist/e2e (E2E_DIR overrides).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = process.env.E2E_DIR ? resolve(process.env.E2E_DIR) : join(repoRoot, 'dist', 'e2e');

/** The product's slug (internal/brand), as scripts read it. */
const slug = /^\s*Slug = "(.*)"$/m.exec(readFileSync(join(repoRoot, 'internal', 'brand', 'brand.go'), 'utf8'))?.[1] ?? '';

export const paths = {
  slug,
  /** The core, built with the web UI and the host's herdr-core embedded. */
  core: join(dir, 'core'),
  /** A directory with the fake coding agents (kimi: e2e/fakeacp). */
  fakeBin: join(dir, 'fakebin'),
  /** The machine builds the core uploads to SSH machines (--agent-dir). */
  agents: join(dir, 'agents'),
  /** The fake agent built for an SSH machine's Linux. */
  linuxFake: (arch: string) => join(dir, `linux-${arch}`, 'kimi'),
  /** The X program of the program window tests (e2e/xclient), for an SSH
   * machine's Linux. */
  linuxXClient: (arch: string) => join(dir, `linux-${arch}`, 'e2e-xclient'),
};

export function checkBuilt() {
  for (const p of [paths.core, join(paths.fakeBin, 'kimi')]) {
    if (!existsSync(p)) throw new Error(`${p} is missing: run make e2e (scripts/e2e.sh builds it)`);
  }
}
