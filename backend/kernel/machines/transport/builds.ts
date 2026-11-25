// The machine builds the core deploys: the Go program, or the TypeScript
// machine side compiled by Bun into one executable per platform (the
// runtime, the machine side and its platform's herdr-core in one file;
// hosts/machine/compile.ts). A machine keeps either under its home, shared
// by instances:
//
//   ~/<AGENT_DIR>/<version>/<bin>      the executable, version a digest of it
//
// so the command lines (`node dial`, `node stop`) are the same for both.
// A core that deploys the TypeScript side knows every platform's executable
// of its build by its SHA-256 (a manifest built into the core) and carries
// only its own platform's; a machine gets its build from the release, from
// the core's directory or cache, or from the core's own copy (sources.ts).
import { createHash } from 'node:crypto';
import { CORE_BIN } from '#shared/lib/brand.ts';

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

/** The TypeScript machine executable of a platform. */
export interface TSBuild {
  kind: 'ts';
  /** The platform (MACHINE_KEYS). */
  key: string;
  /** The SHA-256 of the executable. */
  digest: string;
  /** The SHA-256 of its release asset, the executable gzip-compressed. */
  gzDigest: string;
  /** A digest of the executable: its directory on machines. */
  version: string;
  /** Where the release serves it; absent for a build of no release. */
  url?: string;
  /** The executable gzip-compressed, from the core's sources, checked;
   * fails with Unsupported build_unavailable. Only for a machine that
   * cannot get it itself. */
  load(signal?: AbortSignal): Promise<Buffer>;
}

export type MachineBuild = GoBuild | TSBuild;

/** The machine build for a machine. */
export type BuildSource = (t: MachineTarget, signal?: AbortSignal) => Promise<MachineBuild>;

/** The platforms of the TypeScript machine executables and Bun's compile
 * target of each: x64 Linux as baseline builds (processors without AVX2),
 * musl's for Alpine. */
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

/** The name of a platform's executable in a release (with .gz) and in a
 * directory of builds: <bin>-machine-<key>. */
export const machineAsset = (key: string): string => `${CORE_BIN}-machine-${key}`;

/** The digests of the machine executables of a core's build, built into
 * the core (backend/scripts/machines.ts writes it, build.ts embeds it). */
export interface Manifest {
  /** The build's version. */
  version: string;
  /** The release's download URL of the assets (…/releases/download/<tag>);
   * absent for a build of no release (development, the end-to-end tests). */
  release?: string;
  machines: Record<string, { sha256: string; gz: string; size: number }>;
}

/** The TS build of key in manifest. */
export function tsBuild(m: Manifest, key: string, load: TSBuild['load']): TSBuild | null {
  const e = m.machines[key];
  if (!e) return null;
  return {
    kind: 'ts',
    key,
    digest: e.sha256,
    gzDigest: e.gz,
    version: e.sha256.slice(0, 16),
    ...(m.release ? { url: `${m.release.replace(/\/$/, '')}/${machineAsset(key)}.gz` } : {}),
    load,
  };
}

/** The build a node of b tells its clients (NodeInfo.build): the start of
 * the digest of its executable, as the node computes it from the file. */
export const nodeBuild = (b: MachineBuild): string =>
  b.kind === 'ts' ? b.digest.slice(0, 12) : createHash('sha256').update(b.bin).digest('hex').slice(0, 12);
