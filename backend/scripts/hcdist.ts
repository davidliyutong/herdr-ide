// The upstream herdr-core release the build embeds for machines
// (docs/features/21-terminal-core.md, "Delivery"): its version and the
// SHA-256 of the archive of each platform, as the release published them.
// Downloads are verified at build time only (fetch-hc.ts); each executable
// of the TypeScript build then carries its platform's.

export const VERSION = '0.1.21';

/** The archive members the build uses; they sit at the archive's root. */
export const EXECUTABLE = 'herdr-core';
export const LICENSE = 'LICENSE';
export const NOTICES = 'THIRD-PARTY-NOTICES';

/** Bounds the executable (releases are about 8 MB); the machine side
 * accepts uploads up to the same size. */
export const MAX_EXECUTABLE = 64 << 20;
/** Bounds a license or notices file (upstream's notices are about 1 MB). */
export const MAX_NOTICE = 16 << 20;

/** A release archive. Names use upstream's OS and architecture
 * vocabulary, not the build's. */
export interface Artifact {
  name: string;
  sha256: string;
}

const ARTIFACTS: Readonly<Record<string, Artifact>> = {
  'linux/amd64': { name: 'herdr-core-linux-x86_64.tar.gz', sha256: '78424755c10a40dde38a0bdb55c20ac19706e9ae05ed68fc2acf1fcff0d941c1' },
  'linux/arm64': { name: 'herdr-core-linux-aarch64.tar.gz', sha256: 'e844a2bfab48a226097679d076bc83042fe57fccef5387ef802e5b24e78b529a' },
  'darwin/amd64': { name: 'herdr-core-macos-x86_64.tar.gz', sha256: 'e377e1d342cddce0346da5b2f3c281b9701e4731c00024c7c5028265e77a217f' },
  'darwin/arm64': { name: 'herdr-core-macos-aarch64.tar.gz', sha256: '1ab38dd9270f63a8f794d6d60e8702eb0d1c85a72bda85d735e5eea43f05ffed' },
};

/** The platforms the release has (os/arch). */
export const PLATFORMS = Object.keys(ARTIFACTS);

/** The archive of a platform (os/arch). */
export function forPlatform(platform: string): Artifact {
  const a = ARTIFACTS[platform];
  if (!a) throw new Error(`unsupported herdr-core platform "${platform}" (linux/darwin on amd64/arm64)`);
  return a;
}

/** Where the release publishes an archive. */
export const urlOf = (a: Artifact): string => `https://releases.herdr.dev/core/${VERSION}/${a.name}`;
