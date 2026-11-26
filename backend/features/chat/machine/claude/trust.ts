// Whether Claude Code itself trusts a folder: whether the user accepted its
// trust dialog for the folder or one above it, as its global configuration
// records (the projects of ~/.claude.json, hasTrustDialogAccepted). The
// file is only read, asynchronously and at most MAX_GLOBAL_CONFIG bytes of
// it; one that cannot be read trusts nothing.
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import type { Logger } from '#shared/lib/log.ts';
import { readMax } from '#machine/agents/files.ts';

/** The most of Claude Code's global configuration read: a larger one trusts
 * no folder. */
export const MAX_GLOBAL_CONFIG = 32 << 20;

const FILE_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;

const isFile = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

/** The file of Claude Code's global configuration for a program started
 * with env: in CLAUDE_CONFIG_DIR when it names a folder, else in the home
 * directory, a legacy .config.json in Claude Code's own folder first when
 * there is one; "" without a home. */
export async function globalConfig(env: Record<string, string>): Promise<string> {
  let home = env.HOME ?? '';
  if (!posix.isAbsolute(home)) home = process.env.HOME ?? '';
  let base = home;
  let own = posix.join(home, '.claude');
  const dir = env.CLAUDE_CONFIG_DIR ?? '';
  if (posix.isAbsolute(dir)) {
    base = dir;
    own = dir;
  } else if (!posix.isAbsolute(home)) return '';
  const legacy = posix.join(own, '.config.json');
  if (await isFile(legacy)) return legacy;
  return posix.join(base, '.claude.json');
}

/** Whether Claude Code, started with env, trusts dir: the folder, by its
 * name or without links, or a folder above it. */
export async function trustedByClaude(env: Record<string, string>, dir: string, log: Logger): Promise<boolean> {
  const file = await globalConfig(env);
  if (file === '') return false;
  let b: Buffer;
  try {
    const fh = await open(file, FILE_FLAGS);
    try {
      const st = await fh.stat();
      if (!st.isFile()) {
        log(`claude: ${file} is no file; the folder is not trusted`);
        return false;
      }
      if (st.size > MAX_GLOBAL_CONFIG) {
        log(`claude: ${file} has more than ${MAX_GLOBAL_CONFIG} bytes, not read; the folder is not trusted`);
        return false;
      }
      b = await readMax(fh, MAX_GLOBAL_CONFIG);
    } finally {
      await fh.close().catch(() => {});
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EISDIR') log(`claude: ${file} is no file; the folder is not trusted`);
    else if (code !== 'ENOENT') log(`claude: ${file} not read (${(e as Error).message}); the folder is not trusted`);
    return false;
  }
  let projects: Record<string, unknown>;
  try {
    const c = JSON.parse(b.toString('utf8')) as unknown;
    const p = typeof c === 'object' && c !== null ? (c as { projects?: unknown }).projects : undefined;
    projects = typeof p === 'object' && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch (e) {
    log(`claude: ${file} is no configuration (${(e as Error).message}); the folder is not trusted`);
    return false;
  }
  const dirs = [posix.normalize(dir).replace(/(.)\/+$/, '$1')];
  try {
    const real = await realpath(dir);
    if (real !== dirs[0]) dirs.push(real);
  } catch {
    // the name given
  }
  for (let d of dirs) {
    for (;;) {
      const p = Object.hasOwn(projects, d) ? projects[d] : undefined;
      if (typeof p === 'object' && p !== null && (p as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true) return true;
      const up = posix.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return false;
}
