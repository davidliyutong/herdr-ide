// What differs between macOS, Windows and Linux in the shell, as functions
// of process.platform so that every platform's rules run in the tests.

import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DOMAIN, APP_SLUG } from '../../web/src/brand';
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

/** Where the Stage 1 compiled Bun hub executable and the bundled Stage 1
 * machine archives (all platforms + SHA256SUMS) live: inside the packaged
 * app's bundle (Contents/Helpers/<slug> on macOS so Hardened Runtime signs
 * it, resources/bin/<slug>[.exe] on Linux and Windows, and
 * resources/machines/), or in dist/ for unpackaged development. */
export function hubResources(
  resources: string | undefined,
  repo: string,
  platform: Platform = process.platform as Platform,
  arch: string = process.arch,
): { hub: string; machines: string } {
  if (resources) {
    const hub =
      platform === 'darwin'
        ? join(resources, '..', 'Helpers', APP_SLUG)
        : join(resources, 'bin', platform === 'win32' ? `${APP_SLUG}.exe` : APP_SLUG);
    return { hub, machines: join(resources, 'machines') };
  }
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'x64' ? 'amd64' : arch;
  const ext = platform === 'win32' ? '.exe' : '';
  return {
    hub: join(repo, 'dist', `${APP_SLUG}-${os}-${cpu}${ext}`),
    machines: join(repo, 'dist', 'release'),
  };
}

/** Whether closing the main window quits: everywhere but macOS, where the
 * app stays in the Dock (with its hub) until it is quit. */
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
