// Full Disk Access on macOS. The page's settings show whether the app's
// processes and the local terminal core have it (GET /api/m/{id}/privacy)
// and ask the shell for what only it can do: open System Settings at that
// list, show the terminal core's executable in Finder (to drag it into the
// list) and quit and open the app again. The page names nothing: the shell
// opens one fixed URL, a path it works out itself, and its own bundle.

import * as nodeFs from 'node:fs';
import { join, resolve } from 'node:path';
import { APP_SLUG } from '../../web/src/brand';
import type { Platform } from './platform';

/** System Settings at Privacy & Security › Full Disk Access. */
export const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

/** The terminal core's executable of an instance on this computer: the
 * agent's ~/.<slug>[-<instance>]/hosts/<host>/hc/herdr-core
 * (backend/shared/lib/brand.ts dataDir, shared/host/hostdirs.ts, machine/hc.ts), of
 * this host's directory: the most recently changed of the instance's
 * hosts' (a renamed Mac has another host directory); '' for none. macOS
 * gives the programs of its terminals what this file was granted. */
export function terminalCoreExecutable(
  home: string,
  instance: string,
  fs: Pick<typeof import('node:fs'), 'readdirSync' | 'statSync'> = nodeFs,
): string {
  const hosts = join(home, `.${APP_SLUG}${instance ? `-${instance}` : ''}`, 'hosts');
  let best = '';
  let at = -1;
  let names: string[];
  try {
    names = fs.readdirSync(hosts);
  } catch {
    return '';
  }
  for (const name of names) {
    const p = join(hosts, name, 'hc', 'herdr-core');
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs > at) [best, at] = [p, st.mtimeMs];
    } catch {
      // no executable of this host
    }
  }
  return best;
}

/** The .app bundle of a packaged app's executable (…/X.app/Contents/MacOS/X),
 * or '' for any other path. */
export function bundleOf(execPath: string): string {
  const bundle = resolve(execPath, '..', '..', '..');
  return bundle.endsWith('.app') && resolve(bundle, 'Contents', 'MacOS') === resolve(execPath, '..') ? bundle : '';
}

/** A helper that waits up to 60 s for the app (pid) to exit and then has
 * Launch Services open its bundle again, as Finder or the Dock would, so the
 * new app is its own responsible process, which a grant needs (Electron's
 * app.relaunch() starts it as a child of the old one). It ends either way. */
export function reopenCommand(pid: number, bundle: string): [string, string[]] {
  const script =
    'i=0; while /bin/kill -0 "$1" 2>/dev/null && [ $i -lt 300 ]; do /bin/sleep 0.2; i=$((i+1)); done; /bin/kill -0 "$1" 2>/dev/null || exec /usr/bin/open -n "$2"';
  return ['/bin/sh', ['-c', script, 'sh', String(pid), bundle]];
}

export interface PrivacyEffects {
  openExternal(url: string): void;
  showItemInFolder(path: string): void;
  exists(path: string): boolean;
  /** Runs a detached helper. */
  spawnDetached(file: string, args: string[]): void;
  /** Electron's own relaunch, for development runs, which keep their
   * instance through it. */
  relaunch(): void;
  quit(): void;
}

export interface PrivacyOptions {
  platform: Platform;
  /** The terminal core's executable (terminalCoreExecutable). */
  executable: string;
  /** The packaged app's bundle; '' unpackaged. */
  bundle: string;
  pid: number;
  /** A development instance: relaunching keeps its instance and arguments. */
  dev: boolean;
  /** Instead of opening anything, the line saying what would be opened
   * (development's <prefix>DESKTOP_NO_OPEN, for smoke tests). */
  log?: (line: string) => void;
}

/** What the shell does for the page's Full Disk Access requests: only on
 * macOS, with nothing taken from the page. */
export function privacyActions(o: PrivacyOptions, effects: PrivacyEffects) {
  const mac = o.platform === 'darwin';
  return {
    openFullDiskAccess() {
      if (!mac) return;
      if (o.log) o.log(`open ${FULL_DISK_ACCESS_URL}`);
      else effects.openExternal(FULL_DISK_ACCESS_URL);
    },
    revealTerminalCore() {
      const exe = o.executable;
      if (!mac || !exe || !effects.exists(exe)) return;
      if (o.log) o.log(`reveal ${exe}`);
      else effects.showItemInFolder(exe);
    },
    relaunch() {
      if (!mac) return;
      if (o.log) return o.log('relaunch');
      if (o.dev || !o.bundle) effects.relaunch();
      else effects.spawnDetached(...reopenCommand(o.pid, o.bundle));
      effects.quit();
    },
  };
}
