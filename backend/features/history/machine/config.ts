// restore_screen of the user's herdr-core configuration: herdr-core then
// shows a kept terminal's last screen above the new shell itself, after a
// stop of the terminal core but not after the machine lost its power. The
// answer is advisory: a page uses it only until a capture of the new
// shell tells (the generation's restored).
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { posix } from 'node:path';
import { trimSpace as goTrim } from '#shared/host/hostid.ts';

/** Bounds the configuration file as read here. */
export const MAX_CONFIG = 64 << 10;

/** The user's herdr-core configuration file as herdr-core finds it with
 * the environment the agent starts it with:
 * $XDG_CONFIG_HOME/herdr-core/config.toml, else ~/.config/herdr-core/. */
export function configPath(home: string, environ: Record<string, string>): string {
  let dir = environ.XDG_CONFIG_HOME ?? '';
  if (!posix.isAbsolute(dir)) {
    if (!posix.isAbsolute(home)) return '';
    dir = posix.join(home, '.config');
  }
  return posix.join(dir, 'herdr-core', 'config.toml');
}

/** Whether the user's configuration has restore_screen = true. The file is
 * the user's own, shared with their other herdr-core sessions: it is only
 * read, as a regular file of at most MAX_CONFIG bytes, never written. A
 * link is followed: the user's dotfiles may link it, and herdr-core reads
 * it so. */
export async function restoreScreen(home: string, environ: Record<string, string>): Promise<boolean> {
  const p = configPath(home, environ);
  if (p === '') return false;
  const b = await readSmallFile(p, MAX_CONFIG);
  return b ? parseRestoreScreen(b) : false;
}

/** A regular file of at most max bytes; null for anything else. It does
 * not wait on a special file: opened O_NONBLOCK, a FIFO answers at once
 * and is then refused. */
async function readSmallFile(p: string, max: number): Promise<Buffer | null> {
  const f = await open(p, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!f) return null;
  try {
    const st = await f.stat();
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r; n <= max && (r = (await f.read(buf, n, buf.length - n, null)).bytesRead) > 0;) n += r;
    return n > max ? null : buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    await f.close().catch(() => {});
  }
}

/** Reads restore_screen from a TOML file with what herdr-core's flat
 * configuration needs of TOML: a top-level key (bare or quoted) set to
 * true or false, with comments, after an optional byte order mark. The
 * keys after a table's header are not top-level. A file that is not
 * UTF-8, has the key twice or a value that is not a boolean counts as
 * false: herdr-core cannot load such a file at all and then restores
 * nothing. A line parser cannot tell a key inside a multi-line string
 * from a valid one, so the answer may be true where herdr-core loads
 * nothing; it is advisory. */
export function parseRestoreScreen(raw: Buffer): boolean {
  let b = raw;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return false;
  }
  let found = false;
  let on = false;
  for (const raw of text.split('\n')) {
    const line = goTrim(raw);
    if (line === '' || line[0] === '#') continue;
    if (line[0] === '[') break;
    const eq = line.indexOf('=');
    if (eq < 0) continue; // a line of a value that spans lines
    let key = goTrim(line.slice(0, eq));
    let val = line.slice(eq + 1);
    if (key.length >= 2 && (key[0] === '"' || key[0] === "'") && key[key.length - 1] === key[0]) key = key.slice(1, -1);
    if (key !== 'restore_screen') continue;
    const hash = val.indexOf('#');
    if (hash >= 0) val = val.slice(0, hash);
    if (found) return false;
    found = true;
    switch (goTrim(val)) {
      case 'true':
        on = true;
        break;
      case 'false':
        on = false;
        break;
      default:
        return false;
    }
  }
  return on;
}
