// Where the user of a terminal is: the directory the explorer, the Git
// panel, the status bar, links and new terminals take for it. The terminal
// core's record has the directory of the foreground program, which is the
// shell's while it waits at its prompt, and any program's while that runs:
// one that walks a tree (tar, find, rsync, a build) changes its directory
// many times a second, and what follows it would jump with it. So the
// place is the directory of a shell (or of a program the user moves
// around in) as it changes, and of another program only once it has stayed
// where it was first seen: started as `cd project && agent`, it gives the
// place after SETTLE_MS; one that moves before that is never followed, nor
// is a move a program makes later. While such a program runs the place
// stays where the shell was.

import type { TerminalRecord } from './protocol';

/** How long a program that is no shell stays in the directory it was first
 * seen in before that is the terminal's place (the core looks at the
 * foreground program twice a second). */
export const SETTLE_MS = 1500;

/** Shells a terminal waits at the prompt in. */
export const SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ash',
  'ksh',
  'mksh',
  'yash',
  'csh',
  'tcsh',
  'nu',
  'xonsh',
  'elvish',
  'osh',
  'pwsh',
  'powershell',
  'cmd',
]);

/** Programs the user changes directory in besides shells: file managers
 * of the terminal. */
const NAVIGATORS: ReadonlySet<string> = new Set(['ranger', 'yazi', 'lf', 'nnn', 'mc', 'vifm', 'broot', 'xplr', 'joshuto']);

/** A process's name as programs are known: without the dash of a login
 * shell, a directory or .exe. */
export const procName = (n: string) =>
  n
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .split('/')
    .pop() ?? n;

/** Whether the directory of the program named is followed as it changes. */
export function follows(name: string): boolean {
  const n = procName(name).toLowerCase();
  return SHELLS.has(n) || NAVIGATORS.has(n);
}

export interface Place {
  dir?: string;
  /** The foreground program the place was last worked out for. */
  pid?: number;
  /** Where a program that is not followed was first seen, and when: the
   * place once it stayed there (settled). */
  seen?: { cwd: string; at: number };
  /** That program moved before it settled: it is not followed. */
  roams?: boolean;
}

/** The place after a terminal's record changed. */
export function nextPlace(prev: Place | undefined, t: TerminalRecord, now: number): Place {
  const start = typeof t.cwd === 'string' && t.cwd ? t.cwd : undefined;
  const fg = t.foreground as { pid?: unknown; name?: unknown; cwd?: unknown } | null | undefined;
  const cwd = typeof fg?.cwd === 'string' && fg.cwd ? fg.cwd : undefined;
  const pid = typeof fg?.pid === 'number' ? fg.pid : undefined;
  // No foreground program, or one the core cannot read (another user's, as
  // under sudo): where the user was.
  if (!cwd) return { dir: prev?.dir ?? start };
  if (typeof fg?.name === 'string' && follows(fg.name)) return { dir: cwd, pid };
  // Nothing known yet (the page was opened while it ran): where it is.
  if (prev?.dir === undefined) return { dir: cwd, pid };
  if (pid !== undefined && prev.pid === pid) {
    if (prev.roams || !prev.seen || prev.seen.cwd === cwd) return prev;
    return { dir: prev.dir, pid, roams: true };
  }
  if (cwd === prev.dir) return { dir: cwd, pid };
  return { dir: prev.dir, pid, seen: { cwd, at: now } };
}

/** The place once a program stayed where it was first seen; p itself
 * while there is nothing to settle. */
export function settled(p: Place, now: number): Place {
  return p.seen && now - p.seen.at >= SETTLE_MS ? { dir: p.seen.cwd, pid: p.pid } : p;
}
