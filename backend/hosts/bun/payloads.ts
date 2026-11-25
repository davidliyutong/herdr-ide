// The command line's payloads (kernel/payloads.ts): a tar archive embedded
// in the executable at build time (`bun build --compile … payload.tar`,
// found among Bun.embeddedFiles), laid out as payloads() reads it; the
// development flags --agent-dir, --ext-dir and --web-dir come first. A
// development run from the sources (`make dev-core`) has no archive and
// reads what scripts/build.sh staged in the repository's dist/payload.
import { fileURLToPath } from 'node:url';
import { dirFiles, layered, payloads, type Files, type Payloads } from '#kernel/payloads.ts';

/** The embedded archive's files; null when the executable has none (a
 * development run). */
async function embedded(): Promise<{ files: Files; web: Files } | null> {
  if (!Bun.isStandaloneExecutable) return null;
  const blob = Bun.embeddedFiles.find((f) => (f as File).name?.startsWith('payload'));
  if (!blob) return null;
  const archive = new Bun.Archive(blob);
  // The UI's files are served all the time: kept in memory (a few MB). The
  // rest (machine builds, herdr-core) is read when a machine needs it.
  const web = new Map<string, Uint8Array>();
  for (const [path, file] of await archive.files('web/**')) web.set(path.slice('web/'.length), await file.bytes());
  return {
    web: { get: async (p) => web.get(p) ?? null },
    files: {
      async get(path) {
        const m = await archive.files(path);
        const f = m.get(path);
        return f ? await f.bytes() : null;
      },
    },
  };
}

export async function openPayloads(o: {
  agentDir: string;
  extDir: string;
  webDir: string;
  logger?: (line: string) => void;
}): Promise<Payloads> {
  const e = await embedded();
  // --ext-dir holds <bridge>.vsix itself; the archive has it under ext/.
  const ext: Files | null = o.extDir
    ? { get: (p) => (p.startsWith('ext/') ? dirFiles(o.extDir).get(p.slice(4)) : Promise.resolve(null)) }
    : null;
  const staged = Bun.isStandaloneExecutable ? null : dirFiles(fileURLToPath(new URL('../../../dist/payload/', import.meta.url)));
  const files = layered(ext, e?.files ?? staged);
  const web = o.webDir ? dirFiles(o.webDir) : (e?.web ?? null);
  return payloads({ files, web, agentDir: o.agentDir || undefined, ...(o.logger ? { logger: o.logger } : {}) });
}
