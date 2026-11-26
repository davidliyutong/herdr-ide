// Bounds the disk the agent uses on a machine (AGENTS.md rule 6,
// docs/deployment.md#remote-resources): old uploads go, other hosts'
// directories unused for long go, installs that did not finish go, and
// this agent's build and this host's directories are touched,
// so that other hubs' and hosts' cleanups keep them (an upload removes
// builds unused for 14 days, transport/ssh.ts). Every call is
// asynchronous: the node's thread never waits for the file system. A link
// is never followed: what it names is not this data directory's.
import * as fsp from 'node:fs/promises';
import { posix } from 'node:path';
import { AGENT_DIR, DATA_DIR_NAME } from '#shared/lib/brand.ts';
import { buildFile } from './self.ts';
import { HOSTS_DIR } from '#shared/host/hostdirs.ts';
import type { Logger } from '#shared/lib/log.ts';

const DAY = 24 * 60 * 60_000;
/** Uploads are kept this long. */
export const UPLOAD_RETENTION_MS = 7 * DAY;
/** Other hosts' directories lose their files after this long unused,
 * except the terminal core's executable, which a core that ran all along
 * may still run from (removing it on NFS would end that core); the whole
 * directory goes after HOST_EXE_RETENTION_MS. */
export const HOST_RETENTION_MS = 30 * DAY;
export const HOST_EXE_RETENTION_MS = 180 * DAY;
/** A build's file an install left behind (the hub's upload, the machine's
 * download or the local install was interrupted) goes after this long. */
export const STAGING_RETENTION_MS = 60 * 60_000;
/** How often a running agent applies its rules: a node runs for weeks. */
export const HOUSEKEEP_MS = DAY;

/** The temporary files of an install: the ssh script's .upload.<pid> (the
 * executable) with its .in (the download or the upload, up to 256 MiB) and
 * .rc (wget's empty configuration), the local install's
 * <name>.upload.<pid>. */
const STAGED = /^\.upload\.\d+(\.in|\.rc)?$|\.upload\.\d+$/;

const touch = async (p: string, now: Date) => {
  try {
    await fsp.utimes(p, now, now);
  } catch {
    // not there
  }
};

/** The directory this build runs from, which housekeeping touches: the
 * build's directory under the agents' directory (<home>/<AGENT_DIR>/<v>),
 * when it runs from one. */
export function ownDirs(file = buildFile()): string[] {
  const build = posix.dirname(file);
  return posix.basename(posix.dirname(build)) === 'agent' ? [build] : [];
}

/** The entries of dir, none when it cannot be read. */
async function entries(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/** Applies the retention rules once. */
export async function housekeepOnce(base: string, host: string, logger: Logger, now = new Date(), own = ownDirs()): Promise<void> {
  for (const d of own) await touch(d, now);
  await touch(host, now);
  // The Xvfb packages' host directory (the default instance's).
  const home = posix.dirname(base);
  const xvfb = posix.join(home, DATA_DIR_NAME, HOSTS_DIR, posix.basename(host));
  if (xvfb !== host) await touch(xvfb, now);
  await pruneOlder(posix.join(base, 'uploads'), now.getTime() - UPLOAD_RETENTION_MS, logger);
  await pruneOlder(posix.join(host, 'cs-data', 'logs'), now.getTime() - UPLOAD_RETENTION_MS, logger);
  await pruneHosts(posix.join(base, HOSTS_DIR), posix.basename(host), now, logger);
  await pruneStaged([posix.join(home, AGENT_DIR)], now.getTime() - STAGING_RETENTION_MS, logger);
}

/** Other hosts' directories in dir; mine is this host's. An entry that is
 * not a directory itself (a link to one) is left alone. */
export async function pruneHosts(dir: string, mine: string, now: Date, logger: Logger): Promise<void> {
  for (const name of await entries(dir)) {
    if (name === mine) continue;
    const p = posix.join(dir, name);
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const age = now.getTime() - st.mtimeMs;
    if (age < HOST_RETENTION_MS) continue;
    if (age >= HOST_EXE_RETENTION_MS) {
      try {
        await fsp.rm(p, { recursive: true, force: true });
      } catch (e) {
        logger(`prune host ${name}: ${(e as Error).message}`);
      }
      continue;
    }
    for (const f of await entries(p)) {
      if (f === 'hc') continue;
      try {
        await fsp.rm(posix.join(p, f), { recursive: true, force: true });
      } catch (e) {
        logger(`prune host ${name}: ${(e as Error).message}`);
      }
    }
    // Removing changed the directory's time: keep its age.
    try {
      await fsp.utimes(p, st.atime, st.mtime);
    } catch {
      // gone
    }
  }
}

/** Removes the direct children of dir not modified since cutoff (ms), by
 * their own time (a link's, not its target's). */
export async function pruneOlder(dir: string, cutoff: number, logger: Logger): Promise<void> {
  for (const name of await entries(dir)) {
    const p = posix.join(dir, name);
    try {
      if ((await fsp.lstat(p)).mtimeMs > cutoff) continue;
      await fsp.rm(p, { recursive: true, force: true });
    } catch (e) {
      logger(`prune ${name}: ${(e as Error).message}`);
    }
  }
}

/** Removes what interrupted installs left in the builds' and runtimes'
 * directories (dirs: their parents) before cutoff (ms). */
export async function pruneStaged(dirs: string[], cutoff: number, logger: Logger): Promise<void> {
  for (const parent of dirs)
    for (const d of await entries(parent)) {
      const dir = posix.join(parent, d);
      for (const name of await entries(dir)) {
        if (!STAGED.test(name)) continue;
        const p = posix.join(dir, name);
        try {
          const st = await fsp.lstat(p);
          if (!st.isFile() || st.mtimeMs > cutoff) continue;
          await fsp.rm(p, { force: true });
        } catch (e) {
          logger(`prune ${name}: ${(e as Error).message}`);
        }
      }
    }
}

/** Runs housekeeping now and every everyMs until signal ends, with the
 * features' own rules. */
export async function housekeep(o: {
  base: string;
  host: string;
  logger: Logger;
  signal: AbortSignal;
  everyMs?: number;
  extra?: Array<(now: Date) => void | Promise<void>>;
}): Promise<void> {
  while (!o.signal.aborted) {
    const now = new Date();
    await housekeepOnce(o.base, o.host, o.logger, now);
    for (const f of o.extra ?? [])
      try {
        await f(now);
      } catch (e) {
        o.logger(`housekeeping: ${(e as Error).message}`);
      }
    await new Promise<void>((r) => {
      // Ended while the rules ran: no wait.
      if (o.signal.aborted) return r();
      const t = setTimeout(done, o.everyMs ?? HOUSEKEEP_MS);
      function done() {
        clearTimeout(t);
        o.signal.removeEventListener('abort', done);
        r();
      }
      o.signal.addEventListener('abort', done, { once: true });
    });
  }
}
