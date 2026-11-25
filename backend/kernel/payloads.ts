// What the core carries for others: the web UI, the machine builds it
// uploads, the terminal core (herdr-core) and the video encoder it
// installs on machines, the VS Code extension it installs into
// code-server. The host provides them: the command line from the archive
// embedded in its executable (or development directories), the desktop
// app from its resources.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BRIDGE_EXT, CORE_BIN, DATA_DIR_NAME } from '#shared/lib/brand.ts';
import { userHomeDir } from '#shared/host/hostdirs.ts';
import { DeployCode, Unsupported } from './machines/transport/errors.ts';
import {
  bareName,
  MACHINE_TARGETS,
  machineKey,
  type BuildSource,
  type GoBuild,
  type MachineBuild,
  type TSBuild,
} from './machines/transport/builds.ts';
import { ownFile, ownGz, Release, type OwnExecutable } from './machines/transport/release.ts';

/** Files by their path relative to a root ("index.html",
 * "assets/x.js"). */
export interface Files {
  get(path: string): Promise<Uint8Array | null>;
}

export interface Payloads {
  /** The web UI's built files; null when this build has none. */
  readonly web: Files | null;
  /** The machine build for a machine: the Go program for its platform
   * (Go's os/arch names), or, in a core built to deploy the TypeScript
   * machine side, that program for the machine's platform and C library.
   * Which one is a choice of the core's build (backend/scripts/build.ts
   * --machine). */
  machine: BuildSource;
  /** Whether this build deploys the TypeScript machine side (and is it). */
  deploysTS(): Promise<boolean>;
  /** The SHA-256 of the herdr-core a TypeScript build carries for a
   * platform, as the build recorded it (null when it did not). */
  embeddedHC(os: string, arch: string): Promise<string | null>;
  /** herdr-core for a platform, gzip-compressed, and the SHA-256 of the
   * executable, which the agent's install checks. */
  hc(os: string, arch: string): Promise<{ gz: Buffer; digest: string }>;
  /** The video encoder for a platform, as hc. */
  encoder(os: string, arch: string): Promise<{ gz: Buffer; digest: string }>;
  /** The bridge extension (VSIX); null when this build has none. */
  bridgeVSIX(): Promise<Buffer | null>;
}

/** Files below a directory of the file system. */
export function dirFiles(root: string): Files {
  return {
    async get(path) {
      if (path.split('/').some((p) => p === '..' || p === '')) return null;
      try {
        return await readFile(join(root, path));
      } catch {
        return null;
      }
    },
  };
}

/** The first of several sources that has a file. */
export function layered(...sources: Array<Files | null | undefined>): Files {
  const list = sources.filter((s): s is Files => !!s);
  return {
    async get(path) {
      for (const s of list) {
        const b = await s.get(path);
        if (b) return b;
      }
      return null;
    },
  };
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** What a build that deploys the TypeScript machine side records: its
 * version, its release's download URL (none for a build of no release),
 * its own platform (MACHINE_TARGETS; "" for Windows). */
export const RELEASE_PATH = 'machine/release.json';
/** The SHA-256 of the herdr-core executables of the build's machine
 * platforms (os-arch), which its executables carry. */
export const HC_PATH = 'machine/hc.json';
/** The build's SHA256SUMS, when it carries it (scripts/build.sh RELEASE_SUMS). */
export const SUMS_PATH = 'machine/SHA256SUMS';
/** The own platform's executable, gzip-compressed, which the desktop app
 * carries (the command line is its own). */
export const ownExecutablePath = (key: string): string => `machine/${bareName(key)}.gz`;

interface ReleaseInfo {
  version: string;
  release?: string;
  key?: string;
}

/** Payloads laid out as the build writes them: agents/<bin>-<os>-<arch>.gz
 * (the Go machine builds) and hc/hc-<os>-<arch>.gz, or machine/release.json
 * and machine/hc.json (a build that deploys the TypeScript machine side:
 * each machine gets its platform's from the release, release.ts),
 * encoder/encoder-<os>-<arch>.gz, ext/<bridge>.vsix and web/…; agentDir
 * (--agent-dir) holds machine builds searched first: uncompressed Go
 * builds, or the TypeScript builds' archives or executables with their
 * SHA256SUMS (offline sites, development). own is the running executable
 * (the command line's, compiled). Results are cached. */
export function payloads(o: {
  files: Files;
  web?: Files | null;
  agentDir?: string;
  /** The cache of machine executables the core downloaded (default
   * ~/<DATA_DIR_NAME>/cache/machine). */
  machineCache?: string;
  /** Where what a machine build's sources refused is logged. */
  logger?: (line: string) => void;
  /** The running executable, open (a compiled command line). */
  ownFd?: number;
}): Payloads {
  const agents = new Map<string, Promise<GoBuild>>();
  const gzs = new Map<string, Promise<{ gz: Buffer; digest: string }>>();
  const cached = <T>(m: Map<string, Promise<T>>, key: string, f: () => Promise<T>): Promise<T> => {
    let p = m.get(key);
    if (!p) {
      p = f();
      p.catch(() => m.delete(key));
      m.set(key, p);
    }
    return p;
  };
  const gzEntry = (path: string, what: string) =>
    cached(gzs, path, async () => {
      const gz = await o.files.get(path);
      if (!gz) throw new Error(`no ${what} in this build`);
      return { gz: Buffer.from(gz), digest: sha256(gunzipSync(gz)) };
    });
  const json = <T>(path: string) => o.files.get(path).then((b) => (b ? (JSON.parse(Buffer.from(b).toString('utf8')) as T) : null));
  let info: Promise<ReleaseInfo | null> | undefined;
  const releaseInfo = () => (info ??= json<ReleaseInfo>(RELEASE_PATH));
  let hcs: Promise<Record<string, string> | null> | undefined;
  let release: Promise<Release> | undefined;
  const tsRelease = (r: ReleaseInfo) =>
    (release ??= (async () => {
      const key = r.key ?? '';
      let own: OwnExecutable | null = null;
      if (key && o.ownFd !== undefined) own = ownFile(key, o.ownFd);
      else if (key && (await o.files.get(ownExecutablePath(key)))) own = ownGz(key, () => o.files.get(ownExecutablePath(key)));
      const sums = await o.files.get(SUMS_PATH);
      return new Release({
        version: r.version,
        ...(sums ? { sums: Buffer.from(sums).toString('utf8') } : {}),
        ...(r.release ? { url: r.release } : {}),
        ...(o.agentDir ? { dir: o.agentDir } : {}),
        cacheDir: o.machineCache ?? join(userHomeDir(), DATA_DIR_NAME, 'cache', 'machine'),
        own,
        ...(o.logger ? { logger: o.logger } : {}),
      });
    })());
  const goBuild = (os: string, arch: string) =>
    cached(agents, `${os}-${arch}`, async () => {
      const name = `${CORE_BIN}-${os}-${arch}`;
      let bin: Uint8Array | null = o.agentDir ? await dirFiles(o.agentDir).get(name) : null;
      if (!bin) {
        const gz = await o.files.get(`agents/${name}.gz`);
        if (!gz) throw new Error(`agent ${os}-${arch} not bundled in this build`);
        bin = gunzipSync(gz);
      }
      return { kind: 'go' as const, bin: Buffer.from(bin), version: sha256(bin).slice(0, 16) };
    });
  return {
    web: o.web === undefined ? null : o.web,
    async machine(t): Promise<MachineBuild> {
      const r = await releaseInfo();
      if (!r) return goBuild(t.os, t.arch);
      const key = machineKey(t);
      if (!MACHINE_TARGETS[key]) throw new Unsupported(DeployCode.PlatformUnsupported, `no machine build for ${key}`);
      const rel = await tsRelease(r);
      const url = rel.url(`${bareName(key)}.tar.gz`);
      const b: TSBuild = {
        kind: 'ts',
        key,
        ...(url ? { url } : {}),
        digests: (x) => rel.digests(key, x),
        load: (d) => rel.load(key, d),
      };
      return b;
    },
    deploysTS: async () => (await releaseInfo()) !== null,
    async embeddedHC(os, arch) {
      hcs ??= json<Record<string, string>>(HC_PATH);
      return (await hcs)?.[`${os}-${arch}`] ?? null;
    },
    hc: (os, arch) => gzEntry(`hc/hc-${os}-${arch}.gz`, `herdr-core for ${os}-${arch}`),
    encoder: (os, arch) => gzEntry(`encoder/encoder-${os}-${arch}.gz`, `video encoder for ${os}-${arch}`),
    async bridgeVSIX() {
      const b = await o.files.get(`ext/${BRIDGE_EXT}.vsix`);
      return b ? Buffer.from(b) : null;
    },
  };
}
