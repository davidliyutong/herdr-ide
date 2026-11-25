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
import { BUNDLE_FILE, tsBuild, type BuildSource, type GoBuild, type MachineBuild } from './machines/transport/builds.ts';
import { EMBEDDED_RUNTIMES, cachedRuntime, runtimeFile, runtimeKey, runtimeOf, type Runtime } from './machines/transport/runtimes.ts';

/** Files by their path relative to a root ("index.html",
 * "assets/x.js"). */
export interface Files {
  get(path: string): Promise<Uint8Array | null>;
}

export interface Payloads {
  /** The web UI's built files; null when this build has none. */
  readonly web: Files | null;
  /** The machine build for a machine: the Go program for its platform
   * (Go's os/arch names), or, in a core that embeds the TypeScript machine
   * side, its bundle and the Bun runtime of the machine's platform and C
   * library. Which one is a choice of the core's build
   * (backend/scripts/build.ts --machine). */
  machine: BuildSource;
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

/** The bundle of the TypeScript machine side in a payload. */
export const BUNDLE_PATH = `machine/${BUNDLE_FILE}`;

/** Payloads laid out as the build writes them: agents/<bin>-<os>-<arch>.gz
 * (the Go machine builds) or machine/machine.js and
 * runtime/bun-<os>-<arch>.gz (the TypeScript machine side and the Bun
 * runtimes it embeds), hc/hc-<os>-<arch>.gz,
 * encoder/encoder-<os>-<arch>.gz, ext/<bridge>.vsix and web/…; agentDir
 * (--agent-dir) holds uncompressed Go machine builds searched first
 * (development); runtimeCache keeps the runtimes fetched when a machine
 * needs one the core does not embed (musl's). Results are cached. */
export function payloads(o: { files: Files; web?: Files | null; agentDir?: string; runtimeCache?: string }): Payloads {
  const agents = new Map<string, Promise<GoBuild>>();
  const gzs = new Map<string, Promise<{ gz: Buffer; digest: string }>>();
  const runtimes = new Map<string, Promise<Runtime>>();
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
  let bundle: Promise<Buffer | null> | undefined;
  const tsBundle = () => {
    bundle ??= o.files.get(BUNDLE_PATH).then((b) => (b ? Buffer.from(b) : null));
    return bundle;
  };
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
  const runtime = (key: string, signal?: AbortSignal) =>
    cached(runtimes, key, async () => {
      // The build's own (a build may carry more than EMBEDDED_RUNTIMES:
      // the end-to-end tests' carries musl's for Docker's Alpine).
      const gz = await o.files.get(runtimeFile(key));
      if (gz) return runtimeOf(Buffer.from(gz));
      if ((EMBEDDED_RUNTIMES as readonly string[]).includes(key)) throw new Error(`no Bun runtime for ${key} in this build`);
      return cachedRuntime(key, o.runtimeCache ?? join(userHomeDir(), DATA_DIR_NAME, 'cache'), signal);
    });
  return {
    web: o.web === undefined ? null : o.web,
    async machine(t, signal): Promise<MachineBuild> {
      const js = await tsBundle();
      if (!js) return goBuild(t.os, t.arch);
      return tsBuild(js, await runtime(runtimeKey(t.os, t.arch, t.libc), signal));
    },
    hc: (os, arch) => gzEntry(`hc/hc-${os}-${arch}.gz`, `herdr-core for ${os}-${arch}`),
    encoder: (os, arch) => gzEntry(`encoder/encoder-${os}-${arch}.gz`, `video encoder for ${os}-${arch}`),
    async bridgeVSIX() {
      const b = await o.files.get(`ext/${BRIDGE_EXT}.vsix`);
      return b ? Buffer.from(b) : null;
    },
  };
}
