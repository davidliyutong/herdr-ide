// Where the binaries under test are: scripts/e2e.sh builds them into
// dist/e2e (E2E_DIR overrides): the core of this host (the executable that
// is the core and its platform's machine side,
// docs/features/42-typescript-backend.md), the machine builds of the other
// platforms the tests reach, the same again as a newer version, and the
// fake programs (e2e/fakes).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = process.env.E2E_DIR ? resolve(process.env.E2E_DIR) : join(repoRoot, 'dist', 'e2e');

/** The product's slug (backend/shared/lib/brand.ts), as scripts read it. */
const slug = /^export const SLUG = '(.*)';$/m.exec(readFileSync(join(repoRoot, 'backend', 'shared', 'lib', 'brand.ts'), 'utf8'))?.[1] ?? '';

export const paths = {
  slug,
  /** The core, built with the web UI and the host's herdr-core embedded. */
  core: join(dir, 'core'),
  /** The same core built again as another, newer build: it takes the
   * nodes over from the first. */
  coreNewer: join(dir, 'core-newer'),
  /** The version of the newer build, which its nodes report
   * (scripts/e2e.sh). */
  newerVersion: 'dev-e2e-newer',
  /** A directory with the fake coding agents (kimi: e2e/fakes/acp.ts;
   * codex: e2e/fakes/codex.ts). */
  fakeBin: join(dir, 'fakebin'),
  /** The machine builds the core uploads to SSH machines (--agent-dir):
   * those of the core's version with their SHA256SUMS (agentsOf: those of
   * each core). */
  agents: join(dir, 'machines'),
  /** The machine build directory of a core: the builds are of a version,
   * the newer core's its own. */
  agentsOf: (exe: string): string => (exe === join(dir, 'core-newer') ? join(dir, 'machines-newer') : join(dir, 'machines')),
  /** The machine build an SSH machine of Docker's architecture gets: the
   * build for musl (the image is Alpine). */
  sshMachineBuild: (arch: string): string => join(dir, 'machines', `${slug}-linux-${arch}-musl`),
  /** What the core embeds, staged as the desktop app carries it in its
   * resources (harness/desktop.ts). */
  payload: join(dir, 'payload'),
  /** The fake agent built for an SSH machine's Linux. */
  linuxFake: (arch: string) => join(dir, `linux-${arch}`, 'kimi'),
  /** The X program of the program window tests (e2e/fakes/xclient.ts), for
   * an SSH machine's Linux. */
  linuxXClient: (arch: string) => join(dir, `linux-${arch}`, 'e2e-xclient'),
};

export function checkBuilt() {
  for (const p of [paths.core, join(paths.fakeBin, 'kimi'), join(paths.fakeBin, 'codex')]) {
    if (!existsSync(p)) throw new Error(`${p} is missing: run make e2e (scripts/e2e.sh builds it)`);
  }
}
