// Lays out a namespace's directories on a host. The data directory
// (~/.<slug>[-<instance>]) is on the user's home, which several hosts may
// share (NFS); what belongs to one host is kept apart:
//
//   - run, host-local and private: sockets, locks, pid files, the display's
//     files. In /run/user/<uid> (tmpfs, one per host) where the system has
//     it, else <data>/run-<hostid.id>. Long paths use a short private
//     directory directly under /tmp.
//   - host, <data>/hosts/<hostid.key>: this host's persistent files that
//     must not be shared (executables replaced while another host runs
//     them, code-server's state, logs).
//
// Everything else in the data directory may be shared: files named per
// host (databases), or by content (agent builds).
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as brand from '#shared/lib/brand.ts';
import * as hostid from './hostid.ts';

/** A namespace's directories on this host. */
export interface Dirs {
  /** The user's home directory. */
  home: string;
  /** The namespace's data directory, ~/<brand.dataDir(instance)>. */
  base: string;
  /** base/hosts/<hostid.key>, this host's persistent files. */
  host: string;
  /** This host's private runtime directory of base (runDir). */
  run: string;
}

/** The directory of the data directory holding the hosts' directories. */
export const HOSTS_DIR = 'hosts';
/** The usable address bytes, with space for the terminating NUL. */
export const UNIX_PATH_BYTES = process.platform === 'darwin' ? 103 : 107;
/** The longest final socket name in the runtime directory is bridge.sock. */
const SOCKET_NAME_BYTES = 11;

/** The directories of instance, without creating them. */
export function dirsFor(instance: string): Dirs {
  if (!brand.validInstance(instance)) throw new Error(`invalid instance name ${JSON.stringify(instance)}`);
  return dirsOf(join(userHomeDir(), brand.dataDir(instance)));
}

/** The user's home directory as Go's os.UserHomeDir has it: $HOME
 * (%USERPROFILE% on Windows), an error when it is not set. */
export function userHomeDir(): string {
  const [name, home] = process.platform === 'win32' ? ['%USERPROFILE%', process.env.USERPROFILE] : ['$HOME', process.env.HOME];
  if (!home) throw new Error(`${name} is not defined`);
  return home;
}

/** The directories of the data directory base (whose parent is the home),
 * without creating them. */
export function dirsOf(base: string): Dirs {
  return { home: dirname(base), base, host: join(base, HOSTS_DIR, hostid.key()), run: runDir(base) };
}

/** Creates d's directories, private to the user (0700), also when they
 * existed with looser permissions: the run directory holds sockets with no
 * other authentication. */
export function makeDirs(d: Dirs): void {
  for (const p of [d.base, d.host]) {
    mkdirSync(p, { recursive: true, mode: 0o700 });
    try {
      chmodSync(p, 0o700);
    } catch {
      // as Go's: the directory is there
    }
  }
  makeRun(d.run);
}

/** Creates the runtime directory dir, a directory of the user's alone with
 * mode 0700, and refuses one that is a link or another user's. */
export function makeRun(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fi = lstatSync(dir);
  if (!fi.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (!ownDir(fi)) throw new Error(`${dir} is another user's`);
  if ((fi.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/** The runtime directory of the data directory base on this host: in the
 * user's runtime directory (userRuntime) a directory named after base and
 * a hash of its real path, so a namespace of another home (tests set HOME)
 * never meets it; else base/run-<hostid.id>. Every process of a namespace
 * finds the same: it depends on neither the environment nor the host's
 * name. */
export function runDir(base: string): string {
  const dir = userRuntime();
  const run = dir === null ? join(base, 'run-' + hostid.id()) : join(dir, runName(base));
  if (process.platform === 'win32' || Buffer.byteLength(run) + 1 + SOCKET_NAME_BYTES <= UNIX_PATH_BYTES) return run;
  return join('/tmp', `.${brand.SLUG}-${process.getuid!()}-${hostid.id()}-${baseHash(base).slice(0, 20)}`);
}

/** The name of base's directory in the user's runtime directory: base's
 * name without its dot and 8 hex digits of the SHA-256 of base with its
 * parent's links resolved (the parent, the home, exists before base
 * does). */
function runName(base: string): string {
  const name = basename(base);
  return (name.startsWith('.') ? name.slice(1) : name) + '-' + baseHash(base).slice(0, 8);
}

function baseHash(base: string): string {
  let real = base;
  try {
    real = join(realpathSync(dirname(base)), basename(base));
  } catch {
    // base as it is
  }
  return createHash('sha256').update(real).digest('hex');
}

/** Holds the users' runtime directories (systemd-logind's, elogind's):
 * tmpfs, one per host, removed when the user's last session ends unless
 * lingering, as the user's services are. */
let userRuntimeRoot = '/run/user';

/** Replaces the root of the users' runtime directories (tests); returns
 * the one before. */
export function setUserRuntimeRoot(root: string): string {
  const was = userRuntimeRoot;
  userRuntimeRoot = root;
  return was;
}

/** /run/user/<uid> when it is a directory of the user's with mode 0700;
 * null for none (always on Windows, where the agent does not run). The
 * directory is looked at rather than XDG_RUNTIME_DIR, which processes
 * started otherwise than by a login may lack. */
function userRuntime(): string | null {
  if (process.platform === 'win32') return null;
  const dir = userRuntimeRoot + '/' + process.getuid!();
  try {
    const fi = lstatSync(dir);
    if (!fi.isDirectory() || (fi.mode & 0o077) !== 0 || !ownDir(fi)) return null;
  } catch {
    return null;
  }
  return dir;
}

/** Whether fi is the user's (always on Windows). */
function ownDir(fi: Stats): boolean {
  return process.platform === 'win32' || fi.uid === process.getuid!();
}
