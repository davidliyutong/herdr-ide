// What differs between macOS, Windows and Linux in the shell, as functions
// of process.platform so that every platform's rules run in the tests.

import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DOMAIN } from '../../web/src/brand';
import type { OpenedFolders } from '../../web/src/shell';

export type Platform = 'darwin' | 'win32' | 'linux';

/** The app id: macOS's bundle identifier, Windows's AppUserModelID (which
 * its notifications need) and the Linux desktop entry's name: the product's
 * domain reversed (veldr.app → app.veldr) and "desktop"; the same in
 * electron-builder.cjs, and helper/build.mjs's below it. */
export const APP_ID = `${reverseDomain(APP_DOMAIN)}.desktop`;

/** A domain's labels in reverse order, as reverse-DNS identifiers have it. */
export function reverseDomain(domain: string): string {
  return domain.split('.').reverse().join('.');
}

/** The keybindings' platform: macOS, Windows or Linux (web/src/keybindings.ts
 * picks the same). */
export function keyPlatform(p: Platform): 'mac' | 'windows' | 'linux' {
  return p === 'darwin' ? 'mac' : p === 'win32' ? 'windows' : 'linux';
}

/** Where the core's payloads are: in the app's resources (payload/ as
 * scripts/build.sh stages it: machine builds, herdr-core, the video
 * encoders, the VS Code extension; web/ the web UI), or in the repository
 * for unpackaged development (dist/payload, web/dist). */
export function coreResources(resources: string | undefined, repo: string): { payload: string; web: string } {
  if (resources) return { payload: join(resources, 'payload'), web: join(resources, 'web') };
  return { payload: join(repo, 'dist', 'payload'), web: join(repo, 'web', 'dist') };
}

/** Whether closing the main window quits: everywhere but macOS, where the
 * app stays in the Dock (with its core) until it is quit. */
export function quitsWithLastWindow(p: Platform): boolean {
  return p !== 'darwin';
}

/** The folders a command line names (a file manager's Open With on Linux
 * passes them, as paths or file: URLs, to a first or a second launch), and
 * how many other items it names. skip is how many arguments lead the
 * command line (the executable, and the app's directory when Electron runs
 * it unpackaged); switches (-…) are Chromium's or Electron's. */
export function foldersOf(argv: readonly string[], skip: number, cwd: string, isDirectory = directory): OpenedFolders {
  const out: OpenedFolders = { folders: [], skipped: 0 };
  for (const arg of argv.slice(skip)) {
    if (!arg || arg.startsWith('-')) continue;
    let path = arg;
    if (arg.startsWith('file:')) {
      try {
        path = fileURLToPath(arg);
      } catch {
        out.skipped++;
        continue;
      }
    }
    path = isAbsolute(path) ? path : resolve(cwd, path);
    if (isDirectory(path)) out.folders.push(path);
    else out.skipped++;
  }
  return out;
}

function directory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
