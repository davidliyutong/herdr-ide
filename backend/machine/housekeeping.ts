// Bounds the disk the agent uses on a machine (AGENTS.md rule 6,
// docs/deployment.md#remote-resources): old uploads go, other hosts'
// directories unused for long go, and this agent's build, its runtime and
// this host's directories are touched, so that other cores' and hosts'
// cleanups keep them (an upload removes builds and runtimes unused for 14
// days, transport/ssh.ts).
import { readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { posix } from 'node:path';
import { DATA_DIR_NAME } from '#shared/lib/brand.ts';
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
/** How often a running agent applies its rules: a node runs for weeks. */
export const HOUSEKEEP_MS = DAY;

const touch = (p: string, now: Date) => {
  try {
    utimesSync(p, now, now);
  } catch {
    // not there
  }
};

/** The directories this build runs from, which housekeeping touches: the
 * build's directory under the agents' directory (<home>/<AGENT_DIR>/<v>)
 * and the runtime's (<home>/<DATA_DIR>/runtime/<digest>), when it runs
 * from them. */
export function ownDirs(bundle = Bun.main, runtime = process.execPath): string[] {
  const out: string[] = [];
  const build = posix.dirname(bundle);
  if (posix.basename(posix.dirname(build)) === 'agent') out.push(build);
  const rt = posix.dirname(runtime);
  if (posix.basename(posix.dirname(rt)) === 'runtime') out.push(rt);
  return out;
}

/** Applies the retention rules once. */
export function housekeepOnce(base: string, host: string, logger: Logger, now = new Date(), own = ownDirs()): void {
  for (const d of own) touch(d, now);
  touch(host, now);
  // The Xvfb packages' host directory (the default instance's).
  const xvfb = posix.join(posix.dirname(base), DATA_DIR_NAME, HOSTS_DIR, posix.basename(host));
  if (xvfb !== host) touch(xvfb, now);
  pruneOlder(posix.join(base, 'uploads'), now.getTime() - UPLOAD_RETENTION_MS, logger);
  pruneOlder(posix.join(host, 'cs-data', 'logs'), now.getTime() - UPLOAD_RETENTION_MS, logger);
  pruneHosts(posix.join(base, HOSTS_DIR), posix.basename(host), now, logger);
}

/** Other hosts' directories in dir; mine is this host's. */
export function pruneHosts(dir: string, mine: string, now: Date, logger: Logger): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === mine) continue;
    const p = posix.join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const age = now.getTime() - st.mtimeMs;
    if (age < HOST_RETENTION_MS) continue;
    if (age >= HOST_EXE_RETENTION_MS) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch (e) {
        logger(`prune host ${name}: ${(e as Error).message}`);
      }
      continue;
    }
    let files: string[] = [];
    try {
      files = readdirSync(p);
    } catch {
      // unreadable
    }
    for (const f of files) {
      if (f === 'hc') continue;
      try {
        rmSync(posix.join(p, f), { recursive: true, force: true });
      } catch (e) {
        logger(`prune host ${name}: ${(e as Error).message}`);
      }
    }
    // Removing changed the directory's time: keep its age.
    try {
      utimesSync(p, st.atime, st.mtime);
    } catch {
      // gone
    }
  }
}

/** Removes the direct children of dir not modified since cutoff (ms). */
export function pruneOlder(dir: string, cutoff: number, logger: Logger): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = posix.join(dir, name);
    try {
      if (statSync(p).mtimeMs > cutoff) continue;
      rmSync(p, { recursive: true, force: true });
    } catch (e) {
      logger(`prune ${name}: ${(e as Error).message}`);
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
    housekeepOnce(o.base, o.host, o.logger, now);
    for (const f of o.extra ?? [])
      try {
        await f(now);
      } catch (e) {
        o.logger(`housekeeping: ${(e as Error).message}`);
      }
    await new Promise<void>((r) => {
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
