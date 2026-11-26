// The command line's payloads (kernel/payloads.ts): a tar archive embedded
// in the executable at build time (`bun build --compile … payload.tar`,
// found among Bun.embeddedFiles), laid out as payloads() reads it; the
// development flags --agent-dir, --ext-dir and --web-dir come first. A
// development run from the sources (`make dev-hub`) has no archive and
// reads what scripts/build.sh staged in the repository's dist/payload.
import { openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirFiles, layered, payloads, type Files, type Payloads } from '#kernel/payloads.ts';

/** Characters with special meaning to Bun.Archive's glob matcher (including
 * negation and extglob operators), or path traversal/control characters: none
 * appears in built UI or payload paths. */
const UNSAFE_ARCHIVE_PATH = /[*?[\]{}!()\\\0]/;

function safeArchivePath(path: string): boolean {
  if (!path || UNSAFE_ARCHIVE_PATH.test(path)) return false;
  return !path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/** Lazy archive reader: reads each requested path once from the embedded tar
 * archive without unpacking the entire UI (~20+ MB of Monaco, grammars and
 * fonts) before the hub is ready. */
export function archiveFiles(archive: Pick<Bun.Archive, 'files'>, o: { prefix?: string; cache?: boolean } = {}): Files {
  const prefix = o.prefix ?? '';
  const cache = o.cache === true ? new Map<string, Promise<Uint8Array | null>>() : null;
  const read = async (full: string): Promise<Uint8Array | null> => {
    const m = await archive.files(full);
    const f = m.get(full);
    return f ? await f.bytes() : null;
  };
  return {
    get(path) {
      if (!safeArchivePath(path)) return Promise.resolve(null);
      const full = prefix ? `${prefix}${path}` : path;
      if (!cache) return read(full);
      let p = cache.get(full);
      if (!p) {
        p = read(full).then(
          (bytes) => {
            if (bytes === null) cache.delete(full);
            return bytes;
          },
          (err) => {
            cache.delete(full);
            throw err;
          },
        );
        cache.set(full, p);
      }
      return p;
    },
  };
}

/** The embedded archive's files; null when the executable has none (a
 * development run). */
function embedded(): { files: Files; web: Files } | null {
  if (!Bun.isStandaloneExecutable) return null;
  const blob = Bun.embeddedFiles.find((f) => (f as File).name?.startsWith('payload'));
  if (!blob) return null;
  const archive = new Bun.Archive(blob);
  return {
    // Web UI files are read lazily on first request and cached in memory so
    // cold startup does not page in unused chunks (Monaco, grammars, KaTeX).
    web: archiveFiles(archive, { prefix: 'web/', cache: true }),
    // Non-web payloads (encoders, VSIX, release metadata) are read when a
    // machine needs them (kernel/payloads.ts caches parsed metadata & encoders).
    files: archiveFiles(archive),
  };
}

/** The running executable, opened once: on Linux the running image
 * itself, elsewhere the file at its path when the program started (a file
 * put there since, by an upgrade in place, is not it). */
let ownFd: number | undefined;
function ownExecutable(): number {
  ownFd ??= openSync(process.platform === 'linux' ? '/proc/self/exe' : process.execPath, 'r');
  return ownFd;
}

export async function openPayloads(o: {
  agentDir: string;
  extDir: string;
  webDir: string;
  payloadDir?: string;
  /** False in `<slug> desktop`, whose machine builds come from its Stage 1
   * archives directory (--agent-dir) even after macOS signs the app's hub
   * executable. */
  ownDigest?: boolean;
  logger?: (line: string) => void;
}): Promise<Payloads> {
  const e = embedded();
  // --ext-dir holds <bridge>.vsix itself; the archive has it under ext/.
  const ext: Files | null = o.extDir
    ? { get: (p) => (p.startsWith('ext/') ? dirFiles(o.extDir).get(p.slice(4)) : Promise.resolve(null)) }
    : null;
  const override = o.payloadDir ? dirFiles(o.payloadDir) : null;
  const staged = Bun.isStandaloneExecutable ? null : dirFiles(fileURLToPath(new URL('../../../dist/payload/', import.meta.url)));
  const files = layered(ext, override, e?.files ?? staged);
  const web = o.webDir ? dirFiles(o.webDir) : (e?.web ?? null);
  return payloads({
    files,
    web,
    agentDir: o.agentDir || undefined,
    ...(o.logger ? { logger: o.logger } : {}),
    // The running executable is the machine build of its platform.
    ...(Bun.isStandaloneExecutable && o.ownDigest !== false ? { ownFd: ownExecutable() } : {}),
  });
}
