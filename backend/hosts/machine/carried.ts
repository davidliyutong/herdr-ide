// What the machine build carries for its own platform besides herdr-core
// (backend/scripts/build.ts): the GUI helper and the GPU
// selection library as files beside the payload archive, the video
// encoder inside it. Null in a run from the sources or a build without
// them.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const platform = () => `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;

/** A file embedded beside the payload archive: its bytes (gunzipped when
 * gz) and their SHA-256, read once. */
function embeddedFile(name: string, gz: boolean): () => Promise<{ bytes: Uint8Array; digest: string } | null> {
  let p: Promise<{ bytes: Uint8Array; digest: string } | null> | null = null;
  return () =>
    (p ??= (async () => {
      if (!Bun.isStandaloneExecutable) return null;
      const f = Bun.embeddedFiles.find((b) => (b as File).name === name) as File | undefined;
      if (!f) return null;
      const raw = Buffer.from(await f.bytes());
      if (!raw.length) return null;
      const bytes = gz ? gunzipSync(raw) : raw;
      return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
    })());
}

/** The GUI helper (scripts/gui-helper). */
export const carriedGUIHelper = embeddedFile('gui-helper.gz', true);

/** The GPU selection library (scripts/gpupick/bin). */
export const carriedGPUPick = embeddedFile('gpupick.so', false);

let encoder: Promise<{ gz: Uint8Array; digest: string } | null> | null = null;

/** The video encoder of this platform in the payload archive. */
export function carriedEncoder(): Promise<{ gz: Uint8Array; digest: string } | null> {
  return (encoder ??= (async () => {
    if (!Bun.isStandaloneExecutable) return null;
    const blob = Bun.embeddedFiles.find((f) => (f as File).name?.startsWith('payload'));
    if (!blob) return null;
    const path = `encoder/encoder-${platform()}.gz`;
    const f = (await new Bun.Archive(blob).files(path)).get(path);
    if (!f) return null;
    const gz = await f.bytes();
    return { gz, digest: createHash('sha256').update(gunzipSync(gz)).digest('hex') };
  })());
}
