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
import { BRIDGE_EXT, CORE_BIN } from '#shared/lib/brand.ts';

/** Files by their path relative to a root ("index.html",
 * "assets/x.js"). */
export interface Files {
  get(path: string): Promise<Uint8Array | null>;
}

export interface Payloads {
  /** The web UI's built files; null when this build has none. */
  readonly web: Files | null;
  /** The machine build for a platform (Go's os/arch names) and a
   * content-derived version, so that a rebuilt one is uploaded again. */
  agent(os: string, arch: string): Promise<{ bin: Buffer; version: string }>;
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

/** Payloads laid out as the build writes them: agents/<bin>-<os>-<arch>.gz,
 * hc/hc-<os>-<arch>.gz, encoder/encoder-<os>-<arch>.gz,
 * ext/<bridge>.vsix and web/…; agentDir (--agent-dir) holds uncompressed
 * machine builds searched first (development). Results are cached. */
export function payloads(o: { files: Files; web?: Files | null; agentDir?: string }): Payloads {
  const agents = new Map<string, Promise<{ bin: Buffer; version: string }>>();
  const gzs = new Map<string, Promise<{ gz: Buffer; digest: string }>>();
  const gzEntry = (path: string, what: string) => {
    let p = gzs.get(path);
    if (!p) {
      p = (async () => {
        const gz = await o.files.get(path);
        if (!gz) throw new Error(`no ${what} in this build`);
        return { gz: Buffer.from(gz), digest: sha256(gunzipSync(gz)) };
      })();
      p.catch(() => gzs.delete(path));
      gzs.set(path, p);
    }
    return p;
  };
  return {
    web: o.web === undefined ? null : o.web,
    agent(os, arch) {
      const key = `${os}-${arch}`;
      let p = agents.get(key);
      if (!p) {
        p = (async () => {
          const name = `${CORE_BIN}-${key}`;
          let bin: Uint8Array | null = o.agentDir ? await dirFiles(o.agentDir).get(name) : null;
          if (!bin) {
            const gz = await o.files.get(`agents/${name}.gz`);
            if (!gz) throw new Error(`agent ${key} not bundled in this build`);
            bin = gunzipSync(gz);
          }
          return { bin: Buffer.from(bin), version: sha256(bin).slice(0, 16) };
        })();
        p.catch(() => agents.delete(key));
        agents.set(key, p);
      }
      return p;
    },
    hc: (os, arch) => gzEntry(`hc/hc-${os}-${arch}.gz`, `herdr-core for ${os}-${arch}`),
    encoder: (os, arch) => gzEntry(`encoder/encoder-${os}-${arch}.gz`, `video encoder for ${os}-${arch}`),
    async bridgeVSIX() {
      const b = await o.files.get(`ext/${BRIDGE_EXT}.vsix`);
      return b ? Buffer.from(b) : null;
    },
  };
}
