// The machine builds the core deploys: the Go program (one executable per
// platform), or the TypeScript machine side, a bundle that the Bun runtime
// of the machine's platform runs (docs/features/42-typescript-backend.md).
// A machine keeps both under its home, shared by instances:
//
//   ~/<AGENT_DIR>/<version>/<bin>            a Go build, or the launcher
//   ~/<AGENT_DIR>/<version>/machine.js       of a TypeScript build and its
//                                            bundle (version: of the
//                                            bundle and the runtime)
//   ~/<RUNTIME_DIR>/bun-<digest>/bun         a runtime, uploaded once
//
// The launcher runs the runtime with the bundle, so the command lines
// (`node dial`, `node stop`) are the same for both builds.
import { createHash } from 'node:crypto';
import { BUN_VERSION, type Runtime } from './runtimes.ts';
import { NAME } from '#shared/lib/brand.ts';

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

export interface TSBuild {
  kind: 'ts';
  bundle: Buffer;
  /** The SHA-256 of the bundle. */
  bundleDigest: string;
  runtime: Runtime;
  /** Of the bundle and the runtime: a build directory names its runtime. */
  version: string;
}

export type MachineBuild = GoBuild | TSBuild;

/** The machine build for a machine. */
export type BuildSource = (t: MachineTarget, signal?: AbortSignal) => Promise<MachineBuild>;

/** The file name of a TypeScript build's bundle in its directory. */
export const BUNDLE_FILE = 'machine.js';

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export function tsBuild(bundle: Buffer, runtime: Runtime): TSBuild {
  const bundleDigest = sha256(bundle);
  return { kind: 'ts', bundle, bundleDigest, runtime, version: sha256(`${bundleDigest}\0${runtime.digest}`).slice(0, 16) };
}

/** A runtime's directory below RUNTIME_DIR. */
export const runtimeDirName = (digest: string): string => `bun-${digest.slice(0, 16)}`;

/** The build a node of b tells its clients (NodeInfo.build): a digest of
 * the bundle, as the node computes it from the file it runs. */
export const nodeBuild = (b: MachineBuild): string => sha256(b.kind === 'go' ? b.bin : b.bundle).slice(0, 12);

/** The flags the launcher runs the runtime with: no .env file of the
 * working directory is read, no bunfig.toml, nothing installed. */
export const RUNTIME_FLAGS = ['--no-env-file', '--no-install', '--config=/dev/null'];

/** The launcher of b: a POSIX script beside the bundle that runs it with
 * its runtime, found relative to the script. */
export function launcher(b: TSBuild): string {
  return [
    '#!/bin/sh',
    `# ${NAME}'s machine build ${b.version}: Bun ${BUN_VERSION} (${runtimeDirName(b.runtime.digest)}) runs its bundle.`,
    'd=${0%/*}',
    // What would make the runtime run other code or take other flags.
    'unset BUN_OPTIONS BUN_INSPECT BUN_INSPECT_CONNECT_TO BUN_INSPECT_NOTIFY BUN_INSPECT_PRELOAD',
    // A bundle is not transpiled again, so nothing is cached; nor ever.
    'export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0',
    `exec "$d/../../runtime/${runtimeDirName(b.runtime.digest)}/bun" ${RUNTIME_FLAGS.join(' ')} "$d/${BUNDLE_FILE}" "$@"`,
    '',
  ].join('\n');
}
