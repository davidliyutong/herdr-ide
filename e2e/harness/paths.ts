// Where the binaries under test are: scripts/e2e.sh builds them into
// dist/e2e (E2E_DIR overrides). It builds every core twice: one deploying
// the Go machine build (the product's default) and one the TypeScript
// machine side (docs/features/42-typescript-backend.md); E2E_MACHINE=ts
// runs the suite against the second, whose machines' nodes run the
// TypeScript side (a matrix dimension).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = process.env.E2E_DIR ? resolve(process.env.E2E_DIR) : join(repoRoot, 'dist', 'e2e');

/** The product's slug (internal/brand), as scripts read it. */
const slug = /^\s*Slug = "(.*)"$/m.exec(readFileSync(join(repoRoot, 'internal', 'brand', 'brand.go'), 'utf8'))?.[1] ?? '';

/** The machine build the cores under test deploy: go or ts. */
const machine = process.env.E2E_MACHINE === 'ts' ? 'ts' : 'go';
if (process.env.E2E_MACHINE && process.env.E2E_MACHINE !== machine)
  throw new Error(`E2E_MACHINE is go or ts, not ${process.env.E2E_MACHINE}`);
const ts = machine === 'ts';

export const paths = {
  slug,
  /** The machine build of the run (E2E_MACHINE). */
  machine,
  /** The core, built with the web UI and the host's herdr-core embedded. */
  core: join(dir, ts ? 'core-ts' : 'core'),
  /** The same core built again as another, newer build: it takes the
   * nodes over from the first. */
  coreNewer: join(dir, ts ? 'core-ts-newer' : 'core-newer'),
  /** A newer core of the other machine build: its node takes over from
   * this run's (tests/nodes.spec.ts), Go from TypeScript and the other way
   * round. */
  otherNewer: join(dir, ts ? 'core-newer' : 'core-ts-newer'),
  /** The version of the newer build, which its nodes report
   * (scripts/e2e.sh). */
  newerVersion: 'dev-e2e-newer',
  /** A directory with the fake coding agents (kimi: e2e/fakeacp; codex:
   * e2e/fakecodex). */
  fakeBin: join(dir, 'fakebin'),
  /** The machine builds the core uploads to SSH machines (--agent-dir):
   * the Go builds, or the TypeScript builds of the core's version with their
   * SHA256SUMS (agentsOf: those of each core). */
  agents: join(dir, ts ? 'machines' : 'agents'),
  /** The machine build directory of a core: the TypeScript builds are of
   * a version, the newer core's its own. */
  agentsOf: (exe: string): string =>
    exe === join(dir, 'core-ts')
      ? join(dir, 'machines')
      : exe === join(dir, 'core-ts-newer')
        ? join(dir, 'machines-newer')
        : join(dir, 'agents'),
  /** The machine build an SSH machine of Docker's architecture gets: the Go
   * build, or the TypeScript build for musl (the image is Alpine). */
  sshMachineBuild: (arch: string): string =>
    ts ? join(dir, 'machines', `${slug}-linux-${arch}-musl`) : join(dir, 'agents', `${slug}-linux-${arch}`),
  /** What the core embeds, staged as the desktop app carries it in its
   * resources (harness/desktop.ts). */
  payload: join(dir, ts ? 'payload-ts' : 'payload'),
  /** The fake agent built for an SSH machine's Linux. */
  linuxFake: (arch: string) => join(dir, `linux-${arch}`, 'kimi'),
  /** The X program of the program window tests (e2e/xclient), for an SSH
   * machine's Linux. */
  linuxXClient: (arch: string) => join(dir, `linux-${arch}`, 'e2e-xclient'),
};

export function checkBuilt() {
  for (const p of [paths.core, join(paths.fakeBin, 'kimi'), join(paths.fakeBin, 'codex')]) {
    if (!existsSync(p)) throw new Error(`${p} is missing: run make e2e (scripts/e2e.sh builds it)`);
  }
}
