// gpupick (scripts/gpupick; docs/features/14-gui-windows.md, "GPUs"): the
// library that, preloaded into a terminal's programs, leaves a program
// started with CUDA_VISIBLE_DEVICES only the GPUs that names, so the chosen
// one is its first. The machine build carries it for its architecture
// (scripts/gpupick/bin, built against glibc 2.17) and writes it below
// the data directory (shared by instances) when the core asks, after
// checking that the dynamic loader takes it: a home directory mounted
// noexec, or a C library it was not built for, would make every program of
// a terminal complain.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { DATA_DIR_NAME } from '#shared/lib/brand.ts';
import { STAGING_RETENTION_MS, VERSION_RETENTION_MS } from './display.ts';
import { lastN, run } from './run.ts';

export class Pick {
  private ok = '';
  private installing: Promise<void> | null = null;

  private readonly home: string;
  private readonly environ: () => Record<string, string>;
  /** The library this build carries, null without one. */
  private readonly carried: () => Promise<{ bytes: Uint8Array; digest: string } | null>;

  constructor(home: string, environ: () => Record<string, string>, carried: () => Promise<{ bytes: Uint8Array; digest: string } | null>) {
    this.home = home;
    this.environ = environ;
    this.carried = carried;
  }

  root = () => posix.join(this.home, DATA_DIR_NAME, 'gpupick');

  private async file(): Promise<{ path: string; lib: { bytes: Uint8Array; digest: string } } | null> {
    const lib = await this.carried();
    if (!lib) return null;
    return { path: posix.join(this.root(), lib.digest.slice(0, 16), 'gpupick.so'), lib };
  }

  /** The library when it is installed as this build has it, hashed once
   * per agent; '' otherwise. */
  async path(): Promise<string> {
    const f = await this.file();
    if (!f) return '';
    if (this.ok !== f.path) {
      try {
        const st = await lstat(f.path);
        if (!st.isFile()) return '';
        if (
          createHash('sha256')
            .update(await readFile(f.path))
            .digest('hex') !== f.lib.digest
        )
          return '';
      } catch {
        return '';
      }
      this.ok = f.path;
    }
    const now = new Date();
    await utimes(posix.dirname(f.path), now, now).catch(() => {}); // in use
    return f.path;
  }

  /** Writes the library unless it is there and checks the loader takes it. */
  install(): Promise<void> {
    this.installing ??= this.doInstall().finally(() => (this.installing = null));
    return this.installing;
  }

  private async doInstall(): Promise<void> {
    const f = await this.file();
    if (!f) throw new Error(`gui: no GPU selection library for ${process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`);
    if (await this.path()) return;
    const root = this.root();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const tmp = await mkdtemp(posix.join(root, '.fetch-'));
    try {
      const staged = posix.join(tmp, 'gpupick.so');
      await writeFile(staged, f.lib.bytes, { mode: 0o600 });
      const r = await run(['/bin/sh', '-c', ':'], { env: { ...this.environ(), LD_PRELOAD: staged }, timeoutMs: 10_000 });
      if (r.code !== 0 || r.out.trim() !== '')
        throw new Error(`gui: the GPU selection library cannot be preloaded: exit status ${r.code} ${lastN(r.out, 300)}`.trim());
      const dir = posix.dirname(f.path);
      try {
        await rename(tmp, dir);
      } catch {
        if (await this.path()) return;
        await rm(dir, { recursive: true, force: true }); // a damaged copy
        try {
          await rename(tmp, dir);
        } catch (e) {
          if (await this.path()) return;
          throw e;
        }
      }
      await this.prune(dir);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    if (!(await this.path())) throw new Error('gui: the installed GPU selection library is not usable');
  }

  /** Removes the libraries of other builds unused for VERSION_RETENTION_MS,
   * and installs that did not finish. */
  async prune(keep = '', now = Date.now(), stagingOnly = false): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.root());
    } catch {
      return;
    }
    for (const name of names) {
      const p = posix.join(this.root(), name);
      if (p === keep) continue;
      const st = await stat(p).catch(() => null);
      if (!st) continue;
      const limit = name.startsWith('.fetch-') ? STAGING_RETENTION_MS : stagingOnly ? Infinity : VERSION_RETENTION_MS;
      if (now - st.mtimeMs > limit) await rm(p, { recursive: true, force: true }).catch(() => {});
    }
  }
}
