// Where code-server's files are on a machine, as the Go machine build has
// them (a node of either build takes over from the other, code-server and
// its pid file included). Releases are shared by every instance of the home
// (~/.<slug>/code-server/<version>-<os>-<arch>: a home several hosts share
// may be reached from other systems); the process, its socket, its settings
// and extensions are the instance's.
import { posix } from 'node:path';
import { DATA_DIR_NAME } from '#shared/lib/brand.ts';
import { BRIDGE_SOCKET, CODE_SOCKET } from '../protocol.ts';

export interface Layout {
  /** The releases' directory, shared by the instances of the home. */
  readonly root: string;
  /** The suffix of a release's directory: this system and architecture,
   * named as Go names them (linux, darwin; amd64, arm64). */
  readonly platform: string;
  /** code-server's socket, 0600 in the instance's 0700 run directory. */
  readonly socket: string;
  /** Who started the running code-server (Owner). */
  readonly pidFile: string;
  /** The bridge extension's socket, which the agent tunnels to a core. */
  readonly bridge: string;
  /** VS Code's settings and state (--user-data-dir), this host's. */
  readonly data: string;
  /** Its extensions (--extensions-dir) and the markers of what the cores
   * installed there. */
  readonly ext: string;
  /** code-server's output, overwritten at each start. */
  readonly log: string;
}

/** The platform as Go names it. */
export function goPlatform(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch === 'x64' ? 'amd64' : arch}`;
}

export function layoutOf(env: { home: string; run: string; host: string }, platform = goPlatform()): Layout {
  return {
    root: posix.join(env.home, DATA_DIR_NAME, 'code-server'),
    platform,
    socket: posix.join(env.run, CODE_SOCKET),
    pidFile: posix.join(env.run, 'cs.pid'),
    bridge: posix.join(env.run, BRIDGE_SOCKET),
    data: posix.join(env.host, 'cs-data'),
    ext: posix.join(env.host, 'cs-ext'),
    log: posix.join(env.host, 'code-server.log'),
  };
}

/** The directory of release version on this platform. */
export const releaseDir = (l: Layout, version: string): string => posix.join(l.root, `${version}-${l.platform}`);

/** The executable of release version. */
export const releaseBin = (l: Layout, version: string): string => posix.join(releaseDir(l, version), 'bin', 'code-server');

/** Whether v can name a release's directory: not empty, no separator, no
 * "..". */
export const validVersion = (v: string | undefined): v is string => !!v && !/[/\\]/.test(v) && !v.includes('..') && !v.includes('\0');
