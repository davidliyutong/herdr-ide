// Anthropic's Agent SDK (@anthropic-ai/claude-agent-sdk), which the
// TypeScript chat host's Claude Code adapter runs on: Anthropic's own code,
// all rights reserved, so no executable or app of the product carries it.
// A machine gets it when a Claude Code chat needs it: the npm registry's
// tarball of this pinned version, which the machine downloads itself or
// the hub uploads (from an operator's directory, its cache or its own
// download), checked against the pinned integrity before anything of it is
// unpacked, into <data dir>/claude-agent-sdk/<version> (sdkprovision.ts,
// machine/sdkstore.ts; the adapter loads it, machine/claude/load.ts).
//
// The SDK's entry (sdk.mjs) carries what it uses of its dependencies and
// imports Node's own modules only: the one tarball is all it needs, and of
// it the entry, its package.json, and its license and readme beside it.
import { posix } from 'node:path';

/** A package of the npm registry, pinned. */
export interface NpmTarball {
  name: string;
  version: string;
  /** The tarball's name: in the registry's URL, an operator's directory
   * and the hub's cache. */
  file: string;
  /** Subresource Integrity of the tarball, as the registry and the lockfile
   * have it. */
  integrity: string;
  /** The module loaded, and its SHA-256 (hex), checked again before each
   * process loads it. */
  entry: string;
  entrySha256: string;
  /** What is unpacked of it, below its top directory. */
  files: readonly string[];
}

/** The version the adapter is built and tested with (backend/package.json's
 * devDependency, for its types and the tests, is the same). */
export const CLAUDE_SDK: NpmTarball = Object.freeze({
  name: '@anthropic-ai/claude-agent-sdk',
  version: '0.3.322',
  file: 'claude-agent-sdk-0.3.322.tgz',
  integrity: 'sha512-r88ij7R3SPV2j3BtFuavgrbWZNE8SVVS42AOQ1KxlS+QnSwNNnUhmVXV3Es2dniZySBYX8ENebL43ffhiB0azw==',
  entry: 'sdk.mjs',
  entrySha256: '1c70356fe073f6c5423fb7138e2f2f6580a790eb055ad247e5d7927f57b53e8b',
  files: Object.freeze(['package.json', 'sdk.mjs', 'LICENSE.md', 'README.md']),
});

/** The npm registry the hub and the machines download from (--npm-registry
 * names a mirror). */
export const NPM_REGISTRY = 'https://registry.npmjs.org';

/** The tarball's URL in a registry: <registry>/<name>/-/<file>. */
export const tarballURL = (t: NpmTarball, registry = NPM_REGISTRY): string => `${registry.replace(/\/+$/, '')}/${t.name}/-/${t.file}`;

/** Bounds the tarball (0.3.322's is 1.5 MB) and what is unpacked of it. */
export const MAX_SDK_TARBALL = 32 << 20;
export const MAX_SDK_UNPACKED = 64 << 20;

/** The directory of the SDK's versions in a machine's data directory. */
export const SDK_DIR = 'claude-agent-sdk';

/** Where version t of the SDK is unpacked in data directory base. */
export const sdkDir = (base: string, t: NpmTarball = CLAUDE_SDK): string => posix.join(base, SDK_DIR, t.version);

/** The SHA-512 (base64) the integrity t pins; "" for one of another
 * algorithm. */
export function pinnedSha512(t: NpmTarball): string {
  return t.integrity.startsWith('sha512-') ? t.integrity.slice('sha512-'.length) : '';
}

/** Why a tarball of SHA-512 digest (base64) is not t's; "" when it is. */
export function integrityRefusal(t: NpmTarball, digest: string): string {
  const want = pinnedSha512(t);
  if (want === '') return `${t.file}: the pinned integrity is no sha512`;
  return digest === want ? '' : `${t.file}: its sha512 ${digest} is not the pinned ${want}`;
}
