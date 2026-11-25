// The machine builds the core deploys: the Go program, or, in a core built
// to deploy it (backend/scripts/build.ts --machine ts), the TypeScript
// machine side, which is the core's own program: one executable per
// platform holds the core, the machine side and that platform's herdr-core.
// A release publishes each platform's as an archive
// (<bin>-<platform>.tar.gz, the executable at <bin>-<platform>/<bin>) and
// their SHA-256 in SHA256SUMS (release.ts). A machine keeps either build
// under its home, shared by instances:
//
//   ~/<AGENT_DIR>/<version>/<bin>      the executable, version a digest of it
//
// so the command lines (`node dial`, `node stop`) are the same for both.
import { createHash } from 'node:crypto';
import { CORE_BIN } from '#shared/lib/brand.ts';
import type { OpenStream } from './tunnel.ts';

/** A machine as the probe found it. */
export interface MachineTarget {
  os: string;
  arch: string;
  /** Linux's C library. */
  libc?: 'glibc' | 'musl';
}

export interface GoBuild {
  kind: 'go';
  bin: Buffer;
  /** Content-derived, so that a rebuilt one is uploaded again. */
  version: string;
}

/** The digests of a TypeScript build for a platform. */
export interface TSDigests {
  /** The SHA-256 of the executable. */
  exe: string;
  /** The SHA-256 of the release's archive, when the manifest has it: then
   * a machine can download it. */
  archive?: string;
  /** Where the digests came from, for the logs. */
  source: string;
}

/** What the core uploads: the release's archive, or the executable
 * gzip-compressed (the core's own). */
export interface TSPayload {
  kind: 'archive' | 'gz';
  bytes: Buffer;
}

/** A TypeScript build for a machine's platform. */
export interface TSBuild {
  kind: 'ts';
  /** The platform (MACHINE_KEYS). */
  key: string;
  /** The release's archive of the platform; absent for a build of no
   * release (development, the end-to-end tests). */
  url?: string;
  /** The digests, from the release's manifest, which the core verified
   * itself (or from the core's own executable); tunnel opens a stream
   * through the machine for a core that cannot reach the release, over
   * which the core speaks its own TLS. Fails with Unsupported
   * build_unavailable. */
  digests(o?: { signal?: AbortSignal; tunnel?: OpenStream }): Promise<TSDigests>;
  /** What the core uploads when the machine cannot download it, checked
   * against d; fails with Unsupported build_unavailable. */
  load(d: TSDigests, signal?: AbortSignal): Promise<TSPayload>;
}

export type MachineBuild = GoBuild | TSBuild;

/** The machine build for a machine. */
export type BuildSource = (t: MachineTarget, signal?: AbortSignal) => Promise<MachineBuild>;

/** The platforms of the TypeScript executables and Bun's compile target of
 * each: x64 Linux as baseline builds (processors without AVX2), musl's for
 * Alpine. */
export const MACHINE_TARGETS: Readonly<Record<string, string>> = {
  'linux-amd64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'linux-amd64-musl': 'bun-linux-x64-musl-baseline',
  'linux-arm64-musl': 'bun-linux-arm64-musl',
  'darwin-amd64': 'bun-darwin-x64',
  'darwin-arm64': 'bun-darwin-arm64',
};

export const MACHINE_KEYS = Object.keys(MACHINE_TARGETS);

/** The platform key of a machine: <os>-<arch>[-musl]. */
export const machineKey = (t: MachineTarget): string => `${t.os}-${t.arch}${t.os === 'linux' && t.libc === 'musl' ? '-musl' : ''}`;

/** The platform key of a Bun compile target ("" for Windows or none). */
export function keyOfTarget(target: string): string {
  return Object.entries(MACHINE_TARGETS).find(([, t]) => t === target || t === `${target}-baseline`)?.[0] ?? '';
}

/** A platform's release archive, and the executable in it. */
export const archiveName = (key: string): string => `${CORE_BIN}-${key}.tar.gz`;
export const archiveMember = (key: string): string => `${CORE_BIN}-${key}/${CORE_BIN}`;
/** A platform's executable in a directory of builds (--agent-dir). */
export const bareName = (key: string): string => `${CORE_BIN}-${key}`;

/** The directory of a TypeScript build on a machine. */
export const tsVersion = (exe: string): string => exe.slice(0, 16);

/** The build a node of b tells its clients (NodeInfo.build): the start of
 * the digest of its executable, as the node computes it from the file. */
export const nodeBuild = (b: GoBuild | { exe: string }): string =>
  'exe' in b ? b.exe.slice(0, 12) : createHash('sha256').update(b.bin).digest('hex').slice(0, 12);
