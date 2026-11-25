// Extensions of the instance's code-server: the bridge extension and the
// defaults, each a VSIX the core uploads (or an extension's id), installed
// by code-server's own installer into the instance's extensions directory,
// and the markers by which the cores remember what they installed there.
import { randomBytes } from 'node:crypto';
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { SLUG } from '#shared/lib/brand.ts';
import { dirArgs } from './server.ts';
import type { Layout } from './layout.ts';
import { lastN, run, runError } from './process.ts';

/** Bounds a VSIX the core uploads. */
export const MAX_VSIX = 512 << 20;
/** How long code-server's installer may take. */
export const INSTALL_EXT_MS = 5 * 60_000;

/** Writes a VSIX's chunks to a temporary file (the installer reads it by
 * name), at most MAX_VSIX bytes. */
async function stageVSIX(chunks: AsyncIterable<Buffer>, max: number): Promise<string> {
  const file = posix.join(tmpdir(), `${SLUG}-${randomBytes(6).toString('hex')}.vsix`);
  const fh = await open(file, 'wx', 0o600);
  try {
    let n = 0;
    for await (const b of chunks) {
      n += b.length;
      if (n > max) throw new Error(`the extension is larger than ${max} bytes`);
      await fh.write(b);
    }
    await fh.close();
    return file;
  } catch (e) {
    await fh.close().catch(() => {});
    await rm(file, { force: true });
    throw e;
  }
}

/** Installs a VSIX read from vsix (when given) and the extensions ids with
 * code-server's bin; the installer's output, or an error that ends with
 * it. */
export async function installExtensions(
  l: Layout,
  bin: string,
  o: {
    vsix?: AsyncIterable<Buffer>;
    ids: string[];
    env: Record<string, string>;
    signal: AbortSignal;
    timeoutMs?: number;
    maxVSIX?: number;
  },
): Promise<string> {
  let file = '';
  try {
    if (o.vsix) file = await stageVSIX(o.vsix, o.maxVSIX ?? MAX_VSIX);
    const targets = [...(file ? [file] : []), ...o.ids];
    if (targets.length === 0) throw new Error('nothing to install');
    const args = [...dirArgs(l), ...targets.flatMap((t) => ['--install-extension', t]), '--force'];
    const r = await run(bin, args, { env: o.env, timeoutMs: o.timeoutMs ?? INSTALL_EXT_MS, signal: o.signal });
    const err = runError(r);
    if (err) throw new Error(`${err}: ${lastN(r.out, 600)}`);
    return lastN(r.out, 2000);
  } finally {
    if (file) await rm(file, { force: true });
  }
}

/** The marker file name names in the extensions directory: its last
 * component; null for none ("", ".", ".."). */
function markerPath(l: Layout, name: string): string | null {
  const base = posix.basename(name);
  return base === '' || base === '.' || base === '..' ? null : posix.join(l.ext, base);
}

/** Whether the marker name exists; set creates it first. */
export async function marker(l: Layout, name: string, set: boolean): Promise<boolean> {
  const p = markerPath(l, name);
  if (!p) return false;
  if (set) {
    await mkdir(l.ext, { recursive: true, mode: 0o700 });
    await writeFile(p, '', { mode: 0o644 });
  }
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
