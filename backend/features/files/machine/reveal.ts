// Reveal in Finder (Reveal in File Manager): the system's file manager
// shows a path, as VS Code's command of that name does. The hub asks only
// for its own machine, and only for a client on its own host
// (backend/features/files): the window opens on the screen of the computer
// the user sits at.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { posix } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';

/** Where xdg-open is looked for: the system's own directories, never the
 * PATH of the environment the hub was started in. */
export const REVEAL_DIRS = ['/usr/bin', '/bin', '/usr/local/bin'];

/** The first regular, executable file named name in dirs, "" for none. */
export function systemProgram(name: string, dirs: string[]): string {
  for (const d of dirs) {
    const p = posix.join(d, name);
    try {
      const fi = statSync(p);
      if (fi.isFile() && (fi.mode & 0o111) !== 0) return p;
    } catch {
      // not there
    }
  }
  return '';
}

/** The program, by its absolute path, and the arguments that show p
 * (absolute and there; dir: a folder) in the file manager of the system
 * os: Finder, with p selected in its folder, on macOS (/usr/bin/open);
 * elsewhere the default file manager with the folder, or the file's folder
 * (xdg-open of the system's directories), named with a trailing slash, so
 * that a folder swapped for a file meanwhile fails rather than opens in
 * that file's program. Null where there is none. p is an argument of its
 * own, never a shell's text, and as an absolute path it never looks like
 * an option. */
export function revealCommand(os: string, p: string, dir: boolean, dirs = REVEAL_DIRS): string[] | null {
  switch (os) {
    case 'darwin':
      return ['/usr/bin/open', '-R', p];
    case 'linux':
    case 'freebsd':
    case 'openbsd':
    case 'netbsd': {
      const prog = systemProgram('xdg-open', dirs);
      if (!prog) return null;
      const folder = dir ? p : posix.dirname(p);
      return [prog, folder.replace(/\/+$/, '') + '/'];
    }
  }
  return null;
}

export interface RevealOptions {
  /** How long the command's answer is waited for: open and xdg-open hand
   * the path to the file manager and exit; one still running then (an
   * xdg-open that runs a file manager itself) is that file manager's
   * window, left to the user. */
  waitMs: number;
  /** The commands waited for at once. */
  max: number;
  command: (os: string, p: string, dir: boolean) => string[] | null;
  os: string;
}

/** Runs reveals: at most o.max waited for at once (a command frees its
 * place when it exits or its wait ends, so a window left open holds none). */
export class Revealer {
  private running = 0;
  private readonly o: RevealOptions;

  constructor(o: RevealOptions) {
    this.o = o;
  }

  get busy(): number {
    return this.running;
  }

  /** Shows abs (which is there; dir: a folder). The command's standard
   * streams are /dev/null: a pipe would be held open by the file manager it
   * starts. It answers once the command exits (its exit status, xdg-open's
   * 1 to 4, says why it failed) or waitMs passed. */
  async reveal(abs: string, dir: boolean, env: Record<string, string>, signal: AbortSignal): Promise<void> {
    const argv = this.o.command(this.o.os, abs, dir);
    if (!argv) throw new Fail('reveal_unavailable', 501, `no file manager on ${this.o.os}`);
    if (this.running >= this.o.max) throw new Fail('busy', 429, `${this.o.max} file managers are being opened`);
    this.running++;
    try {
      const p = spawn(argv[0], argv.slice(1), { env, stdio: 'ignore' });
      const exited = new Promise<number | null>((resolve, reject) => {
        p.once('error', reject);
        p.once('exit', (code, sig) => resolve(sig ? -1 : code));
      });
      exited.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<'waited'>((r) => {
        timer = setTimeout(() => r('waited'), this.o.waitMs);
        signal.addEventListener('abort', () => r('waited'), { once: true });
      });
      let code: number | null | 'waited';
      try {
        code = await Promise.race([exited, waited]);
      } catch (e) {
        const c = (e as NodeJS.ErrnoException).code;
        if (c === 'ENOENT' || c === 'EACCES') throw new Fail('reveal_unavailable', 501, `${argv[0]}: ${(e as Error).message}`);
        throw new Fail('reveal_failed', 500, `${argv[0]}: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      if (code !== 'waited' && code !== 0) throw new Fail('reveal_failed', 500, `${argv[0]}: exit status ${code === -1 ? 'signal' : code}`);
      // A file manager the command left running is the user's; it is reaped
      // when it ends.
      p.unref();
    } finally {
      this.running--;
    }
  }
}
